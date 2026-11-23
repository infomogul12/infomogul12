import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker from '../src/worker.js';
import { makeD1 } from './d1shim.js';
import { hashPassword } from '../src/logic.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PEPPER = 'p'.repeat(40);

function setup() {
  const DB = makeD1(path.join(root, 'migrations/0001_init.sql'));
  const env = {
    DB, VOTE_PEPPER: PEPPER, SESSION_HOURS: '8',
    ASSETS: {
      async fetch(req) {
        const p = new URL(req.url).pathname;
        try { return new Response(readFileSync(path.join(root, 'public', p)), { headers: { 'Content-Type': p.endsWith('.html') ? 'text/html' : 'application/octet-stream' } }); }
        catch { return new Response('nf', { status: 404 }); }
      },
    },
  };
  return env;
}
class Client {
  constructor(env, ip = '1.1.1.1') { this.env = env; this.cookie = ''; this.ip = ip; }
  async call(method, url, body, extra = {}) {
    const headers = { 'CF-Connecting-IP': this.ip, 'X-Requested-With': 'fetch', ...extra };
    if (this.cookie) headers.Cookie = this.cookie;
    let b;
    if (body instanceof Uint8Array) b = body;
    else if (body !== undefined) { b = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await worker.fetch(new Request('https://vote.example' + url, { method, headers, body: b }), this.env);
    const sc = res.headers.get('Set-Cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
}
async function addAdmin(env, name, role, pw = 'long-enough-password') {
  await env.DB.prepare('INSERT INTO admin_user (username, password_hash, role) VALUES (?,?,?)').bind(name, await hashPassword(pw), role).run();
}
const csv = readFileSync(path.join(root, 'public/static/sample.csv'));

async function prepareElection(env) {
  const chair = new Client(env);
  await addAdmin(env, 'chair1', 'chair');
  assert.equal((await chair.call('POST', '/api/admin/login', { username: 'chair1', password: 'long-enough-password' })).status, 200);
  const eid = (await chair.call('POST', '/api/admin/elections', { title: '시험 선거', base_date: '2026-11-22' })).data.id;
  const imp = await chair.call('POST', `/api/admin/elections/${eid}/people/import?name=sample.csv`, new Uint8Array(csv));
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.equal(imp.data.imported, 27);
  assert.equal((await chair.call('POST', `/api/admin/elections/${eid}/people/member-ok`, { value: true })).status, 200);
  const lock = await chair.call('POST', `/api/admin/elections/${eid}/roll/lock`);
  assert.equal(lock.status, 200, JSON.stringify(lock.data));
  const people = (await chair.call('GET', `/api/admin/elections/${eid}/people`)).data;
  const rid = (await chair.call('POST', `/api/admin/elections/${eid}/races`, { name: '안수집사', rule: 'half' })).data.id;
  const eligible = people.filter((p) => p.in_roll);
  const cands = [];
  for (const p of eligible.slice(0, 2)) {
    const r = await chair.call('POST', `/api/admin/elections/${eid}/races/${rid}/candidates`, { person_id: p.id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    cands.push(r.data.id);
  }
  return { chair, eid, rid, cands, eligible };
}

test('화면 파일과 보안 헤더', async () => {
  const env = setup();
  const c = new Client(env);
  const r = await c.call('GET', '/admin');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Security-Policy'), /default-src 'self'/);
  assert.equal((await c.call('GET', '/v')).status, 200);
  assert.equal((await c.call('GET', '/static/admin.js')).status, 200);
  assert.equal((await c.call('GET', '/static/../secret')).status, 404);
  assert.equal((await c.call('GET', '/api/admin/me')).status, 401);
  const noHdr = await worker.fetch(new Request('https://x/api/admin/login', { method: 'POST', body: '{}' }), env);
  assert.equal(noHdr.status, 403);
});

test('온라인 투표 전체 흐름과 중복 제출 방지', async () => {
  const env = setup();
  const { chair, eid, cands, eligible } = await prepareElection(env);
  assert.equal((await chair.call('POST', `/api/admin/elections/${eid}/start`)).status, 200);
  const tokens = [];
  for (const p of eligible.slice(0, 5)) {
    const r = await chair.call('POST', `/api/admin/elections/${eid}/tickets`, { person_id: p.id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    tokens.push(r.data.token);
  }
  const voter = new Client(env, '2.2.2.2');
  const look = await voter.call('POST', '/api/vote/lookup', { token: tokens[0] });
  assert.equal(look.status, 200);
  assert.equal(look.data.races[0].candidates.length, 2);
  const choices = { [cands[0]]: 'Y', [cands[1]]: 'N' };
  // 같은 QR로 8번 동시에 제출 -> 성공은 정확히 1번
  const results = await Promise.all(Array.from({ length: 8 }, () => voter.call('POST', '/api/vote/submit', { token: tokens[0], choices })));
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM ballot').get().n, 1);
  assert.equal(env.DB.raw.prepare("SELECT count(*) AS n FROM ticket WHERE status='used'").get().n, 1);
  // 불완전한 선택은 거절, QR은 그대로 사용 가능
  assert.equal((await voter.call('POST', '/api/vote/submit', { token: tokens[1], choices: { [cands[0]]: 'Y' } })).status, 400);
  // 재발급하면 기존 QR 무효
  const re = await chair.call('POST', `/api/admin/elections/${eid}/tickets/reissue`, { person_id: eligible[1].id });
  assert.equal(re.status, 200);
  assert.equal((await voter.call('POST', '/api/vote/submit', { token: tokens[1], choices })).status, 409);
  assert.equal((await voter.call('POST', '/api/vote/submit', { token: re.data.token, choices: { [cands[0]]: 'N', [cands[1]]: 'N' } })).status, 200);
  assert.equal((await voter.call('POST', '/api/vote/lookup', { token: 'zzzz-zzzz-zzzz-zzzz' })).status, 404);
  // 종료 전에는 결과 못 봄
  assert.equal((await chair.call('GET', `/api/admin/elections/${eid}/results`)).status, 409);
  const close = await chair.call('POST', `/api/admin/elections/${eid}/close`);
  assert.equal(close.status, 200);
  assert.equal(close.data.ballots, 2);
  assert.equal(close.data.revoked_unused, 3);
  assert.equal((await voter.call('POST', '/api/vote/submit', { token: tokens[2], choices })).status, 409);
  const res = (await chair.call('GET', `/api/admin/elections/${eid}/results`)).data;
  assert.equal(res.ballots, 2);
  assert.equal(res.consistent, true);
  const [a, b] = res.races[0].candidates;
  assert.deepEqual([a.yes, a.no, b.yes, b.no], [1, 1, 0, 2]);
  assert.equal(res.races[0].need, 2);
  assert.equal(a.passed, false);
  // 투표함에는 개인 정보와 연결되는 열이 없다
  const cols = env.DB.raw.prepare("SELECT group_concat(name) AS c FROM pragma_table_info('ballot')").get().c;
  assert.equal(cols, 'id,election_id');
});

test('오프라인 투표와 통합 결과', async () => {
  const env = setup();
  const { chair, eid, cands, eligible } = await prepareElection(env);
  await chair.call('POST', `/api/admin/elections/${eid}/start`);
  const t = await chair.call('POST', `/api/admin/elections/${eid}/tickets`, { person_id: eligible[0].id });
  const voter = new Client(env, '3.3.3.3');
  await voter.call('POST', '/api/vote/submit', { token: t.data.token, choices: { [cands[0]]: 'Y', [cands[1]]: 'Y' } });
  // QR을 받은 사람을 오프라인으로 바꾸면 그 QR은 무효
  const t2 = await chair.call('POST', `/api/admin/elections/${eid}/tickets`, { person_id: eligible[1].id });
  assert.equal((await chair.call('POST', `/api/admin/elections/${eid}/offline`, { person_id: eligible[1].id })).status, 200);
  assert.equal((await voter.call('POST', '/api/vote/submit', { token: t2.data.token, choices: { [cands[0]]: 'N', [cands[1]]: 'N' } })).status, 409);
  assert.equal((await chair.call('POST', `/api/admin/elections/${eid}/offline`, { person_id: eligible[2].id })).status, 200);
  assert.equal((await chair.call('POST', `/api/admin/elections/${eid}/offline`, { person_id: eligible[2].id })).status, 409);   // 중복
  assert.equal((await chair.call('POST', `/api/admin/elections/${eid}/offline`, { person_id: eligible[0].id })).status, 409);   // 이미 온라인 투표
  assert.equal((await chair.call('POST', `/api/admin/elections/${eid}/tickets`, { person_id: eligible[2].id })).status, 409);   // 오프라인 확인자에게 QR 발급 불가
  assert.equal((await chair.call('DELETE', `/api/admin/elections/${eid}/offline/${eligible[2].id}`)).status, 200);              // 취소
  assert.equal((await chair.call('POST', `/api/admin/elections/${eid}/offline`, { person_id: eligible[2].id })).status, 200);
  // 종료 전 결과 입력 불가
  const body = { ballots: 2, invalid: 0, counts: { [cands[0]]: { yes: 1, no: 1 }, [cands[1]]: { yes: 0, no: 2 } } };
  assert.equal((await chair.call('PUT', `/api/admin/elections/${eid}/offline-results`, body)).status, 409);
  await chair.call('POST', `/api/admin/elections/${eid}/close`);
  assert.equal((await chair.call('PUT', `/api/admin/elections/${eid}/offline-results`, { ...body, ballots: 3 })).status, 400);   // 확인 인원(2명)보다 많음
  assert.equal((await chair.call('PUT', `/api/admin/elections/${eid}/offline-results`, { ...body, counts: { [cands[0]]: { yes: 2, no: 1 }, [cands[1]]: { yes: 0, no: 2 } } })).status, 400);
  let res = (await chair.call('GET', `/api/admin/elections/${eid}/results`)).data;
  assert.equal(res.offline_pending, true);
  assert.equal((await chair.call('PUT', `/api/admin/elections/${eid}/offline-results`, body)).status, 200);
  res = (await chair.call('GET', `/api/admin/elections/${eid}/results`)).data;
  assert.equal(res.ballots, 3);
  assert.equal(res.offline_pending, false);
  const [a, b] = res.races[0].candidates;
  assert.deepEqual([a.yes, a.no, b.yes, b.no], [2, 1, 1, 2]);
  assert.equal(a.passed, true);
  // 결과에는 온라인/오프라인으로 나눈 후보별 값이 없다
  assert.deepEqual(Object.keys(a).sort(), ['candidate_id', 'name', 'no', 'passed', 'photo_url', 'role', 'yes']);
  assert.equal((await chair.call('GET', `/api/admin/elections/${eid}/audit`)).data.length > 5, true);
});

test('권한과 로그인 제한', async () => {
  const env = setup();
  const { eid } = await prepareElection(env);
  await addAdmin(env, 'desk1', 'desk');
  const desk = new Client(env, '4.4.4.4');
  assert.equal((await desk.call('POST', '/api/admin/login', { username: 'desk1', password: 'long-enough-password' })).status, 200);
  assert.equal((await desk.call('GET', `/api/admin/elections/${eid}/results`)).status, 403);
  assert.equal((await desk.call('GET', `/api/admin/elections/${eid}/desk`)).status, 200);
  const bot = new Client(env, '5.5.5.5');
  for (let i = 0; i < 10; i++) assert.equal((await bot.call('POST', '/api/admin/login', { username: 'chair1', password: 'wrong' + i })).status, 401);
  assert.equal((await bot.call('POST', '/api/admin/login', { username: 'chair1', password: 'long-enough-password' })).status, 429);
});

test('사진은 후보로 등록된 교인만 볼 수 있다', async () => {
  const env = setup();
  const { chair, eid, eligible } = await prepareElection(env);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const other = eligible[5];
  assert.equal((await chair.call('PUT', `/api/admin/elections/${eid}/people/${other.id}/photo`, jpg)).status, 200);
  assert.equal((await chair.call('GET', `/api/photo/${other.id}`)).status, 404);
  assert.equal((await chair.call('PUT', `/api/admin/elections/${eid}/people/${eligible[0].id}/photo`, new Uint8Array([1, 2, 3, 4]))).status, 400);
  assert.equal((await chair.call('PUT', `/api/admin/elections/${eid}/people/${eligible[0].id}/photo`, jpg)).status, 200);
  const r = await worker.fetch(new Request(`https://x/api/photo/${eligible[0].id}`), env);
  assert.equal(r.status, 200);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [...jpg]);
});

test('엑셀(.xlsx) 교적부 불러오기', async () => {
  const env = setup();
  const chair = new Client(env);
  await addAdmin(env, 'chair1', 'chair');
  await chair.call('POST', '/api/admin/login', { username: 'chair1', password: 'long-enough-password' });
  const eid = (await chair.call('POST', '/api/admin/elections', { title: '엑셀', base_date: '2026-11-22' })).data.id;
  const r = await chair.call('POST', `/api/admin/elections/${eid}/people/import?name=t.xlsx`, new Uint8Array(readFileSync(path.join(root, 'test/sample.xlsx'))));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.imported, 2);
  assert.equal(r.data.excluded.length, 1);
  const people = (await chair.call('GET', `/api/admin/elections/${eid}/people`)).data;
  assert.equal(people.find((p) => p.name === '김정수').member_ok, true);
  assert.equal(people.find((p) => p.name === '김정수').birth, '1962-03-14');
});

test('비밀번호 변경', async () => {
  const env = setup();
  await addAdmin(env, 'chair1', 'chair', 'old-password-123');
  const a = new Client(env, '6.6.6.6'), other = new Client(env, '7.7.7.7');
  await a.call('POST', '/api/admin/login', { username: 'chair1', password: 'old-password-123' });
  await other.call('POST', '/api/admin/login', { username: 'chair1', password: 'old-password-123' });
  const change = (cur, next) => a.call('POST', '/api/admin/password', { current: cur, next });
  assert.equal((await change('wrong', 'brand-new-password-1')).status, 400);          // 현재 비밀번호 틀림
  assert.equal((await change('old-password-123', 'short')).status, 400);              // 12자 미만
  assert.equal((await change('old-password-123', 'old-password-123')).status, 400);   // 같은 비밀번호
  assert.equal((await change('old-password-123', 'xxchair1xxxxxxxx')).status, 400);   // 아이디 포함
  assert.equal((await new Client(env).call('POST', '/api/admin/password', { current: 'a', next: 'b' })).status, 401);
  assert.equal((await change('old-password-123', 'brand-new-password-1')).status, 200);
  assert.equal((await a.call('GET', '/api/admin/me')).status, 200);                    // 바꾼 브라우저는 유지
  assert.equal((await other.call('GET', '/api/admin/me')).status, 401);                // 다른 로그인은 끊김
  const fresh = new Client(env, '8.8.8.8');
  assert.equal((await fresh.call('POST', '/api/admin/login', { username: 'chair1', password: 'old-password-123' })).status, 401);
  assert.equal((await fresh.call('POST', '/api/admin/login', { username: 'chair1', password: 'brand-new-password-1' })).status, 200);
  // 현재 비밀번호를 5번 틀리면 잠시 막힌다
  for (let i = 0; i < 5; i++) await change('wrong' + i, 'brand-new-password-2');
  assert.equal((await change('brand-new-password-1', 'brand-new-password-2')).status, 429);
});

test('선거 삭제', async () => {
  const env = setup();
  const { chair, eid, cands, eligible } = await prepareElection(env);
  await chair.call('POST', `/api/admin/elections/${eid}/start`);
  const t = await chair.call('POST', `/api/admin/elections/${eid}/tickets`, { person_id: eligible[0].id });
  await new Client(env, '9.9.9.9').call('POST', '/api/vote/submit', { token: t.data.token, choices: { [cands[0]]: 'Y', [cands[1]]: 'N' } });
  await chair.call('POST', `/api/admin/elections/${eid}/offline`, { person_id: eligible[1].id });
  const del = (title) => chair.call('DELETE', `/api/admin/elections/${eid}`, { confirm_title: title });
  assert.equal((await del('시험 선거')).status, 409);            // 진행 중에는 삭제 불가
  await chair.call('POST', `/api/admin/elections/${eid}/close`);
  assert.equal((await del('다른 이름')).status, 400);            // 이름이 다르면 거절
  const desk = new Client(env, '4.4.4.4');
  await addAdmin(env, 'desk1', 'desk');
  await desk.call('POST', '/api/admin/login', { username: 'desk1', password: 'long-enough-password' });
  assert.equal((await desk.call('DELETE', `/api/admin/elections/${eid}`, { confirm_title: '시험 선거' })).status, 403);
  assert.equal((await del('시험 선거')).status, 200);
  const count = (tbl) => env.DB.raw.prepare(`SELECT count(*) AS n FROM ${tbl}`).get().n;
  for (const tbl of ['election', 'person', 'roll', 'race', 'candidate', 'ticket', 'ballot', 'ballot_item', 'offline_voter', 'offline_tally', 'offline_count', 'person_photo']) {
    assert.equal(count(tbl), 0, tbl);
  }
  const rows = env.DB.raw.prepare('SELECT action, election_id, detail FROM audit_log').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'election.delete');
  assert.equal(rows[0].election_id, null);
  assert.equal(JSON.parse(rows[0].detail).ballots, 1);
  assert.equal((await chair.call('GET', '/api/admin/elections')).data.length, 0);
  assert.equal((await del('시험 선거')).status, 404);
});
