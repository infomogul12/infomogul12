// 교회 선출투표 서버 (Cloudflare Worker + D1). 화면 파일은 public/ 에서 함께 제공한다.
import {
  RULES, needVotes, isPassed, checkOfflineCounts, ageOn, ineligibleReason, newToken, tokenHash, sha256Hex,
  verifyPassword, hashPassword, randomBytes, randomHex, b64url, detectImageMime, toBase64, fromBase64, toDate, parseUpload,
} from './logic.js';

const MAX_BODY = 6 * 1024 * 1024;
const MAX_PHOTO = 500 * 1024;
const CHUNK = 300;   // D1 문장 하나에 넣는 행 수(문장 크기 제한 때문)
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; this.msg = msg; }
}
const bad = (msg) => new HttpError(400, msg);

const iso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const hourIso = () => iso().slice(0, 13) + ':00:00Z';
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

// =====================================================================
// DB 도우미
// =====================================================================
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const all = async (env, sql, ...args) => (await stmt(env, sql, ...args).all()).results;
const one = async (env, sql, ...args) => (await stmt(env, sql, ...args).all()).results[0] ?? null;
const run = (env, sql, ...args) => stmt(env, sql, ...args).run();
const changes = (r) => r?.meta?.changes ?? 0;
const batch = (env, stmts) => env.DB.batch(stmts);
const isUnique = (e) => /UNIQUE|constraint/i.test(String(e?.message ?? e));

function auditStmt(env, adminId, eid, action, detail) {
  return stmt(env, 'INSERT INTO audit_log (at, admin_id, election_id, action, detail) VALUES (?,?,?,?,?)',
    iso(), adminId, eid, action, JSON.stringify(detail ?? {}));
}
const audit = (env, adminId, eid, action, detail) => auditStmt(env, adminId, eid, action, detail).run();

// 실패 횟수 제한: Worker는 여러 곳에서 동시에 실행되므로 DB에 기록한다.
async function rateCheck(env, bucket, key, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const r = await one(env, 'SELECT count(*) AS n FROM rate_hit WHERE bucket = ? AND key = ? AND at > ?', bucket, key, now - windowSec);
  if (r.n >= max) throw new HttpError(429, '시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.');
}
async function rateFail(env, bucket, key) {
  const now = Math.floor(Date.now() / 1000);
  await run(env, 'INSERT INTO rate_hit (bucket, key, at) VALUES (?,?,?)', bucket, key, now);
  if (Math.random() < 0.05) await run(env, 'DELETE FROM rate_hit WHERE at < ?', now - 3600);
}
const rateClear = (env, bucket, key) => run(env, 'DELETE FROM rate_hit WHERE bucket = ? AND key = ?', bucket, key);

// =====================================================================
// 요청 도우미
// =====================================================================
function intField(d, key, label) {
  const v = d?.[key];
  if (!Number.isInteger(v)) throw bad(`${label}이(가) 올바르지 않습니다.`);
  return v;
}
function strField(d, key, lo, hi, label) {
  const v = d?.[key];
  if (typeof v !== 'string' || v.trim().length < lo || v.trim().length > hi) throw bad(`${label}을(를) ${lo}~${hi}자로 입력하세요.`);
  return v.trim();
}
function dateField(d, key, label) {
  const v = toDate(d?.[key]);
  if (!v) throw bad(`${label}을(를) 날짜(예: 2026-11-22)로 입력하세요.`);
  return v;
}
function parseJson(c) {
  if (!c.raw.length) return {};
  try {
    const d = JSON.parse(new TextDecoder().decode(c.raw));
    if (d === null || typeof d !== 'object' || Array.isArray(d)) throw 0;
    return d;
  } catch { throw bad('요청 형식이 올바르지 않습니다.'); }
}
const cookieOf = (req, name) => {
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};

async function currentAdmin(c) {
  const token = cookieOf(c.req, 'session');
  if (!token) throw new HttpError(401, '로그인이 필요합니다.');
  const row = await one(c.env,
    'SELECT u.id, u.username, u.role, s.expires_at FROM admin_session s JOIN admin_user u ON u.id = s.admin_id ' +
    'WHERE s.token_hash = ? AND u.active = 1', await sha256Hex(token));
  if (!row || row.expires_at < iso()) throw new HttpError(401, '세션이 만료되었습니다. 다시 로그인하세요.');
  return { id: row.id, username: row.username, role: row.role };
}

// =====================================================================
// 공통 조회
// =====================================================================
async function getElection(env, eid) {
  const el = await one(env, 'SELECT * FROM election WHERE id = ?', eid);
  if (!el) throw new HttpError(404, '선거를 찾을 수 없습니다.');
  return el;
}
const needSetup = (el) => { if (el.phase !== 'setup') throw new HttpError(409, '투표가 시작된 뒤에는 수정할 수 없습니다.'); };
const needUnlocked = (el) => { if (el.roster_locked) throw new HttpError(409, '선거인명부가 확정되어 있습니다. 확정을 취소한 뒤 수정하세요.'); };
const photoUrl = (pid, has) => (has ? `/api/photo/${pid}` : null);

async function racesWithCandidates(env, eid) {
  const races = (await all(env, 'SELECT id, name, rule FROM race WHERE election_id = ? ORDER BY sort_order, id', eid))
    .map((r) => ({ ...r, candidates: [] }));
  const byId = new Map(races.map((r) => [r.id, r]));
  const rows = await all(env,
    'SELECT c.id, c.race_id, p.id AS person_id, p.name, p.role, ' +
    'EXISTS(SELECT 1 FROM person_photo ph WHERE ph.person_id = p.id) AS has_photo ' +
    'FROM candidate c JOIN race r ON r.id = c.race_id JOIN person p ON p.id = c.person_id ' +
    'WHERE r.election_id = ? ORDER BY c.id', eid);
  for (const row of rows) {
    byId.get(row.race_id).candidates.push({
      id: row.id, person_id: row.person_id, name: row.name, role: row.role, photo_url: photoUrl(row.person_id, !!row.has_photo),
    });
  }
  return races;
}

const countOf = async (env, sql, ...args) => (await one(env, sql, ...args)).n;

// =====================================================================
// 관리자 API
// =====================================================================
const routes = [];
const route = (method, pattern, role, fn) => {
  const rx = new RegExp('^' + pattern.replace(/\{(\w+)\}/g, '(?<$1>\\d+)') + '$');
  routes.push({ method, rx, role, fn });
};

route('POST', '/api/admin/login', null, async (c) => {
  await rateCheck(c.env, 'login', c.ip, 10, 600);
  const d = parseJson(c);
  const username = String(d.username ?? '').slice(0, 64), password = String(d.password ?? '').slice(0, 200);
  const row = await one(c.env, 'SELECT id, password_hash, role FROM admin_user WHERE username = ? AND active = 1', username);
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    await rateFail(c.env, 'login', c.ip);
    throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
  }
  await rateClear(c.env, 'login', c.ip);
  const hours = Number(c.env.SESSION_HOURS) || 8;
  const token = b64url(randomBytes(32));
  const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  await batch(c.env, [
    stmt(c.env, 'DELETE FROM admin_session WHERE expires_at < ?', iso()),
    stmt(c.env, 'INSERT INTO admin_session (token_hash, admin_id, expires_at) VALUES (?,?,?)', await sha256Hex(token), row.id, expires),
  ]);
  let cookie = `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${hours * 3600}`;
  if (c.url.protocol === 'https:') cookie += '; Secure';
  return json({ role: row.role }, 200, { 'Set-Cookie': cookie });
});

route('POST', '/api/admin/logout', 'staff', async (c) => {
  await run(c.env, 'DELETE FROM admin_session WHERE token_hash = ?', await sha256Hex(cookieOf(c.req, 'session') || ''));
  return json({ ok: true }, 200, { 'Set-Cookie': 'session=; Path=/; Max-Age=0' });
});

route('GET', '/api/admin/me', 'staff', async (c) => json(c.admin));

route('POST', '/api/admin/password', 'staff', async (c) => {
  // 내 비밀번호 변경. 현재 비밀번호를 확인하고, 바꾼 뒤에는 이 브라우저를 뺀 다른 로그인은 모두 끊는다.
  await rateCheck(c.env, 'pw', String(c.admin.id), 5, 600);
  const d = parseJson(c);
  const cur = String(d.current ?? '').slice(0, 200), next = String(d.next ?? '');
  const row = await one(c.env, 'SELECT password_hash FROM admin_user WHERE id = ?', c.admin.id);
  if (!row || !(await verifyPassword(cur, row.password_hash))) {
    await rateFail(c.env, 'pw', String(c.admin.id));
    throw bad('현재 비밀번호가 올바르지 않습니다.');
  }
  if (next.length < 12) throw bad('새 비밀번호는 12자 이상이어야 합니다.');
  if (new TextEncoder().encode(next).length > 200) throw bad('새 비밀번호가 너무 깁니다.');
  if (next === cur) throw bad('새 비밀번호가 현재 비밀번호와 같습니다.');
  if (next.toLowerCase().includes(c.admin.username.toLowerCase())) throw bad('새 비밀번호에 아이디를 포함하지 마세요.');
  const keep = await sha256Hex(cookieOf(c.req, 'session') || '');
  await batch(c.env, [
    stmt(c.env, 'UPDATE admin_user SET password_hash = ? WHERE id = ?', await hashPassword(next), c.admin.id),
    stmt(c.env, 'DELETE FROM admin_session WHERE admin_id = ? AND token_hash <> ?', c.admin.id, keep),
    auditStmt(c.env, c.admin.id, null, 'admin.password', {}),
  ]);
  await rateClear(c.env, 'pw', String(c.admin.id));
  return json({ ok: true });
});

route('GET', '/api/admin/elections', 'staff', async (c) =>
  json(await all(c.env, 'SELECT id, title, base_date, phase, roster_locked FROM election WHERE hidden = 0 ORDER BY id DESC')));

route('GET', '/api/admin/elections/hidden', 'chair', async (c) =>
  json(await all(c.env, 'SELECT id, title, base_date, phase FROM election WHERE hidden = 1 ORDER BY id DESC')));

route('POST', '/api/admin/elections/{eid}/hide', 'chair', async (c) => {
  // 종료된 선거를 목록에서만 숨긴다. 데이터는 그대로이고 언제든 복구할 수 있다.
  const { eid } = c.params;
  const el = await getElection(c.env, eid);
  if (el.phase !== 'closed') throw new HttpError(409, '종료된 선거만 숨길 수 있습니다.');
  await run(c.env, "UPDATE election SET hidden = 1 WHERE id = ? AND phase = 'closed'", eid);
  await audit(c.env, c.admin.id, eid, 'election.hide', {});
  return json({ ok: true });
});

route('POST', '/api/admin/elections/{eid}/unhide', 'chair', async (c) => {
  const { eid } = c.params;
  await getElection(c.env, eid);
  await run(c.env, 'UPDATE election SET hidden = 0 WHERE id = ?', eid);
  await audit(c.env, c.admin.id, eid, 'election.unhide', {});
  return json({ ok: true });
});

const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = new Uint32Array(1); crypto.getRandomValues(j);
    const k = j[0] % (i + 1);
    [arr[i], arr[k]] = [arr[k], arr[i]];
  }
  return arr;
};

route('GET', '/api/admin/elections/{eid}/backup', 'chair', async (c) => {
  // 종료된 선거의 자료를 JSON 파일로 내려받는다. strip_time=1이면 모든 시각 정보를 뺀다.
  // 투표 내용(ballots)은 항상 무작위 순서로 섞고 ID를 빼며, 참여자 목록은 이름순이라 서로 연결할 단서가 없다.
  const { eid } = c.params, el = await getElection(c.env, eid);
  if (el.phase !== 'closed') throw new HttpError(409, '종료된 선거만 백업할 수 있습니다.');
  const strip = ['1', 'true'].includes(c.url.searchParams.get('strip_time') || '');
  const people = await all(c.env,
    'SELECT p.id, p.role, p.name, p.birth, p.reg_date, p.member_ok, ' +
    'EXISTS(SELECT 1 FROM roll r WHERE r.election_id = p.election_id AND r.person_id = p.id) AS in_roll ' +
    'FROM person p WHERE p.election_id = ? ORDER BY p.name, p.birth', eid);
  const pkey = new Map(people.map((p, i) => [p.id, 'p' + (i + 1)]));
  const races = await all(c.env, 'SELECT id, name, rule FROM race WHERE election_id = ? ORDER BY sort_order, id', eid);
  const cands = await all(c.env,
    'SELECT c.id, c.race_id, c.person_id FROM candidate c JOIN race r ON r.id = c.race_id WHERE r.election_id = ? ORDER BY r.sort_order, r.id, c.id', eid);
  const ckey = new Map(cands.map((x, i) => [x.id, 'c' + (i + 1)]));
  const used = new Map((await all(c.env, "SELECT person_id, issued_at, used_at FROM ticket WHERE election_id = ? AND status = 'used'", eid)).map((t) => [t.person_id, t]));
  const off = new Map((await all(c.env, 'SELECT person_id, checked_at FROM offline_voter WHERE election_id = ?', eid)).map((t) => [t.person_id, t]));
  const items = await all(c.env, 'SELECT ballot_id, candidate_id, choice FROM ballot_item WHERE ballot_id IN (SELECT id FROM ballot WHERE election_id = ?)', eid);
  const byBallot = new Map();
  for (const it of items) {
    if (!byBallot.has(it.ballot_id)) byBallot.set(it.ballot_id, {});
    byBallot.get(it.ballot_id)[ckey.get(it.candidate_id)] = it.choice;
  }
  const tally = await one(c.env, 'SELECT ballots, invalid, entered_at FROM offline_tally WHERE election_id = ?', eid);
  const counts = await all(c.env, 'SELECT candidate_id, yes, no FROM offline_count WHERE election_id = ?', eid);
  const res = await buildResults(c.env, eid);

  const out = {
    format: 'church-vote-backup-1',
    election: { title: el.title, base_date: el.base_date, phase: el.phase },
    time_removed: strip,
    note: '이 파일에는 교인의 이름·생년월일이 들어 있습니다. 안전한 곳에 보관하세요. 후보 사진과 관리자 비밀번호는 포함되지 않습니다.',
    people: people.map((p) => ({ key: pkey.get(p.id), role: p.role, name: p.name, birth: p.birth, reg_date: p.reg_date, member_ok: !!p.member_ok, in_roll: !!p.in_roll })),
    races: races.map((r) => ({
      name: r.name, rule: r.rule,
      candidates: cands.filter((x) => x.race_id === r.id).map((x) => ({ key: ckey.get(x.id), person: pkey.get(x.person_id) })),
    })),
    participation: people.filter((p) => p.in_roll).map((p) => {
      const u = used.get(p.id), o = off.get(p.id);
      const row = { person: pkey.get(p.id), status: u ? 'online' : o ? 'offline' : 'none' };
      if (!strip) { if (u) { row.issued_at = u.issued_at; row.used_at = u.used_at; } if (o) row.checked_at = o.checked_at; }
      return row;
    }),
    online_ballots: shuffle([...byBallot.values()]),
    offline: tally ? {
      ballots: tally.ballots, invalid: tally.invalid, ...(strip ? {} : { entered_at: tally.entered_at }),
      counts: Object.fromEntries(counts.map((x) => [ckey.get(x.candidate_id), { yes: x.yes, no: x.no }])),
    } : null,
    results: {
      ballots: res.ballots, offline_pending: res.offline_pending,
      races: res.races.map((r) => ({
        name: r.name, rule: r.rule, need: r.need,
        candidates: r.candidates.map((x) => ({ key: ckey.get(x.candidate_id), name: x.name, yes: x.yes, no: x.no, passed: x.passed })),
      })),
    },
  };
  if (!strip) {
    out.generated_at = iso();
    out.audit = (await all(c.env,
      'SELECT a.at, u.username, a.action, a.detail FROM audit_log a LEFT JOIN admin_user u ON u.id = a.admin_id WHERE a.election_id = ? ORDER BY a.id', eid))
      .map((r) => ({ at: r.at, username: r.username, action: r.action, detail: JSON.parse(r.detail) }));
  }
  await audit(c.env, c.admin.id, eid, 'election.backup', { time_removed: strip });
  return new Response(JSON.stringify(out, null, 1), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="election-${eid}-backup${strip ? '-notime' : ''}.json"`,
    },
  });
});

// 선거 하나의 모든 자료를 지우는 문장 모음(삭제와 복원 실패 시 되돌리기에서 함께 쓴다). 진행 중인 선거에는 적용되지 않는다.
function wipeStmts(env, eid) {
  const guard = "election_id = ?1 AND (SELECT phase FROM election WHERE id = ?1) IN ('setup','closed')";
  return [
    stmt(env, `DELETE FROM ballot WHERE ${guard}`, eid),
    stmt(env, `DELETE FROM offline_count WHERE ${guard}`, eid),
    stmt(env, `DELETE FROM offline_tally WHERE ${guard}`, eid),
    stmt(env, `DELETE FROM offline_voter WHERE ${guard}`, eid),
    stmt(env, `DELETE FROM ticket WHERE ${guard}`, eid),
    stmt(env, `DELETE FROM roll WHERE ${guard}`, eid),
    stmt(env, `DELETE FROM audit_log WHERE ${guard}`, eid),
    stmt(env, "DELETE FROM election WHERE id = ?1 AND phase IN ('setup','closed')", eid),
  ];
}

const chunked = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const TS_RX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

route('POST', '/api/admin/elections/restore', 'chair', async (c) => {
  // 백업 파일(JSON)로 새 선거를 만든다. 원래 선거는 건드리지 않고, 복원된 선거는 '종료' 상태의 열람용이다.
  // 먼저 파일 전체를 검사하고(구조, 인원 수, 후보별 가/부 합계가 파일의 개표 결과와 같은지), 저장한 뒤에도 같은 합계를 다시 확인한다.
  const d = parseJson(c), b = d.backup;
  const fail = (m) => bad('백업 파일이 올바르지 않습니다: ' + m);
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const str = (v, lo, hi, what) => { if (typeof v !== 'string' || v.trim().length < lo || v.trim().length > hi) throw fail(what); return v.trim(); };
  if (!isObj(b) || b.format !== 'church-vote-backup-1') throw fail('이 프로그램에서 만든 백업 파일이 아닙니다.');
  if (!isObj(b.election) || b.election.phase !== 'closed') throw fail('종료된 선거의 백업이 아닙니다.');
  const srcTitle = str(b.election.title, 1, 100, '선거 이름');
  const baseDate = toDate(b.election.base_date);
  if (!baseDate) throw fail('선거일');
  const title = typeof d.title === 'string' && d.title.trim() ? strField(d, 'title', 1, 100, '선거 이름') : `${srcTitle.slice(0, 90)} (복원)`;

  // 교인
  if (!Array.isArray(b.people) || b.people.length === 0 || b.people.length > 20000) throw fail('교인 목록');
  const people = new Map(), seen = new Set();
  for (const p of b.people) {
    if (!isObj(p)) throw fail('교인 목록');
    const key = str(p.key, 1, 20, '교인 번호'), name = str(p.name, 1, 50, '교인 이름'), role = str(p.role, 1, 30, '직분');
    const birth = toDate(p.birth), reg = toDate(p.reg_date);
    if (!birth || !reg || people.has(key) || seen.has(name + '|' + birth)) throw fail(`교인 정보(${name})`);
    seen.add(name + '|' + birth);
    people.set(key, { key, name, role, birth, reg, ok: p.member_ok ? 1 : 0, inRoll: !!p.in_roll });
  }
  // 투표 항목과 후보
  if (!Array.isArray(b.races) || b.races.length === 0 || b.races.length > 100) throw fail('투표 항목');
  const races = [], cands = new Map();   // cands: 후보 key → {ri, person, race}
  b.races.forEach((r, ri) => {
    if (!isObj(r) || (r.rule !== 'half' && r.rule !== 'twothirds') || !Array.isArray(r.candidates) || r.candidates.length === 0) throw fail('투표 항목');
    const own = new Set();
    for (const x of r.candidates) {
      const p = isObj(x) ? people.get(x.person) : null;
      if (!p || typeof x.key !== 'string' || cands.has(x.key) || own.has(x.person)) throw fail('후보');
      own.add(x.person);
      cands.set(x.key, { key: x.key, ri, person: p });
    }
    races.push({ name: str(r.name, 1, 100, '투표 항목 이름'), rule: r.rule });
  });
  // 참여 현황
  const part = new Map();
  for (const x of Array.isArray(b.participation) ? b.participation : []) {
    const p = isObj(x) ? people.get(x.person) : null;
    if (!p || !p.inRoll || part.has(x.person) || !['online', 'offline', 'none'].includes(x.status)) throw fail('참여 현황');
    part.set(x.person, x);
  }
  const rows = [...part.values()];
  const onlineRows = rows.filter((x) => x.status === 'online'), offlineRows = rows.filter((x) => x.status === 'offline');
  // 온라인 투표함
  const ballots = Array.isArray(b.online_ballots) ? b.online_ballots : null;
  if (!ballots || ballots.length !== onlineRows.length) throw fail('온라인 투표 수와 투표 완료 인원이 다릅니다.');
  const yesN = new Map([...cands.keys()].map((k) => [k, 0])), noN = new Map(yesN);
  for (const bl of ballots) {
    const ks = isObj(bl) ? Object.keys(bl) : [];
    if (ks.length !== cands.size || !ks.every((k) => cands.has(k) && (bl[k] === 'Y' || bl[k] === 'N'))) throw fail('투표 내용');
    for (const k of ks) (bl[k] === 'Y' ? yesN : noN).set(k, (bl[k] === 'Y' ? yesN : noN).get(k) + 1);
  }
  // 오프라인 결과
  let off = null;
  const offYes = new Map(), offNo = new Map();
  if (b.offline !== null && b.offline !== undefined) {
    const o = b.offline;
    if (!isObj(o) || !Number.isInteger(o.ballots) || !Number.isInteger(o.invalid) || !isObj(o.counts)) throw fail('오프라인 결과');
    const counts = {}, names = {};
    for (const [k, cd] of cands) names[k] = cd.person.name;
    for (const [k, v] of Object.entries(o.counts)) {
      if (!cands.has(k) || !isObj(v) || !Number.isInteger(v.yes) || !Number.isInteger(v.no)) throw fail('오프라인 결과');
      counts[k] = [v.yes, v.no]; offYes.set(k, v.yes); offNo.set(k, v.no);
    }
    try { checkOfflineCounts(offlineRows.length, o.ballots, o.invalid, counts, names); } catch (e) { throw fail(e.message); }
    off = { ballots: o.ballots, invalid: o.invalid, at: TS_RX.test(o.entered_at) ? o.entered_at : hourIso() };
  }
  // 파일에 적힌 개표 결과와 투표함에서 다시 센 값이 같아야 한다.
  const want = new Map();
  for (const r of Array.isArray(b.results?.races) ? b.results.races : []) for (const x of Array.isArray(r.candidates) ? r.candidates : []) want.set(x.key, x);
  for (const k of cands.keys()) {
    const w = want.get(k), y = yesN.get(k) + (offYes.get(k) ?? 0), n = noN.get(k) + (offNo.get(k) ?? 0);
    if (!w || w.yes !== y || w.no !== n) throw fail('투표 내용을 다시 센 결과가 파일의 개표 결과와 다릅니다. 파일이 바뀌었거나 손상되었을 수 있습니다.');
  }

  // 저장: 1) 선거 틀 (진행 중 상태가 아닌 setup + 숨김으로 만들어 두고, 끝까지 성공하면 종료 상태로 바꾼다)
  const stamp = (v) => (TS_RX.test(v) ? v : hourIso());
  const er = await run(c.env,
    "INSERT INTO election (title, base_date, phase, roster_locked, created_at, hidden) VALUES (?,?, 'setup', 1, ?, 1)", title, baseDate, iso());
  const eid = er.meta.last_row_id;
  const rollback = async () => { try { await batch(c.env, wipeStmts(c.env, eid)); } catch { /* 숨김·setup 상태로 남아 있으면 삭제 기능으로 지운다 */ } };
  try {
    const pj = (p) => [p.name, p.birth];
    const st = [];
    for (const part1 of chunked([...people.values()], CHUNK)) {
      st.push(stmt(c.env,
        "INSERT INTO person (election_id, role, name, birth, reg_date, member_ok) SELECT ?1, json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]') FROM json_each(?2)",
        eid, JSON.stringify(part1.map((p) => [p.role, p.name, p.birth, p.reg, p.ok]))));
    }
    st.push(stmt(c.env,
      "INSERT INTO race (election_id, name, rule, sort_order) SELECT ?1, json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]') FROM json_each(?2)",
      eid, JSON.stringify(races.map((r, i) => [r.name, r.rule, i]))));
    st.push(stmt(c.env,
      "INSERT INTO candidate (race_id, person_id) SELECT r.id, p.id FROM json_each(?2) j JOIN race r ON r.election_id = ?1 AND r.sort_order = json_extract(j.value,'$[0]') " +
      "JOIN person p ON p.election_id = ?1 AND p.name = json_extract(j.value,'$[1]') AND p.birth = json_extract(j.value,'$[2]') ORDER BY j.key",
      eid, JSON.stringify([...cands.values()].map((x) => [x.ri, ...pj(x.person)]))));
    for (const part1 of chunked([...people.values()].filter((p) => p.inRoll), CHUNK)) {
      st.push(stmt(c.env,
        "INSERT INTO roll (election_id, person_id) SELECT ?1, p.id FROM json_each(?2) j JOIN person p ON p.election_id = ?1 AND p.name = json_extract(j.value,'$[0]') AND p.birth = json_extract(j.value,'$[1]')",
        eid, JSON.stringify(part1.map(pj))));
    }
    await batch(c.env, st);

    // 2) 후보 번호 확인
    const candRows = await all(c.env,
      'SELECT c.id, r.sort_order AS ri, p.name, p.birth FROM candidate c JOIN race r ON r.id = c.race_id JOIN person p ON p.id = c.person_id WHERE r.election_id = ?', eid);
    const cid = new Map(candRows.map((r) => [`${r.ri}|${r.name}|${r.birth}`, r.id]));
    const cidOf = (k) => cid.get(`${cands.get(k).ri}|${cands.get(k).person.name}|${cands.get(k).person.birth}`);
    const n = await one(c.env,
      'SELECT (SELECT count(*) FROM person WHERE election_id = ?1) AS p, (SELECT count(*) FROM roll WHERE election_id = ?1) AS r, (SELECT count(*) FROM race WHERE election_id = ?1) AS rc', eid);
    if (candRows.length !== cands.size || n.p !== people.size || n.rc !== races.length || n.r !== [...people.values()].filter((p) => p.inRoll).length) {
      throw new Error('mismatch-1');
    }

    // 3) QR 사용 기록, 오프라인 확인, 오프라인 합계, 투표함
    const st2 = [];
    for (const part1 of chunked(onlineRows, CHUNK)) {
      st2.push(stmt(c.env,
        "INSERT INTO ticket (election_id, person_id, token_hash, status, issued_at, used_at) SELECT ?1, p.id, json_extract(j.value,'$[2]'), 'used', json_extract(j.value,'$[3]'), json_extract(j.value,'$[4]') " +
        "FROM json_each(?2) j JOIN person p ON p.election_id = ?1 AND p.name = json_extract(j.value,'$[0]') AND p.birth = json_extract(j.value,'$[1]')",
        eid, JSON.stringify(part1.map((x) => [...pj(people.get(x.person)), randomHex(32), stamp(x.issued_at), stamp(x.used_at)]))));
    }
    for (const part1 of chunked(offlineRows, CHUNK)) {
      st2.push(stmt(c.env,
        "INSERT INTO offline_voter (election_id, person_id, checked_at) SELECT ?1, p.id, json_extract(j.value,'$[2]') " +
        "FROM json_each(?2) j JOIN person p ON p.election_id = ?1 AND p.name = json_extract(j.value,'$[0]') AND p.birth = json_extract(j.value,'$[1]')",
        eid, JSON.stringify(part1.map((x) => [...pj(people.get(x.person)), stamp(x.checked_at)]))));
    }
    if (off) {
      st2.push(stmt(c.env, 'INSERT INTO offline_tally (election_id, ballots, invalid, entered_at) VALUES (?,?,?,?)', eid, off.ballots, off.invalid, off.at));
      st2.push(stmt(c.env,
        "INSERT INTO offline_count (election_id, candidate_id, yes, no) SELECT ?1, json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]') FROM json_each(?2)",
        eid, JSON.stringify([...cands.keys()].map((k) => [cidOf(k), offYes.get(k) ?? 0, offNo.get(k) ?? 0]))));
    }
    const bids = ballots.map(() => randomHex(16));
    for (const part1 of chunked(bids, 800)) {
      st2.push(stmt(c.env, 'INSERT INTO ballot (id, election_id) SELECT value, ?1 FROM json_each(?2)', eid, JSON.stringify(part1)));
    }
    const items = [];
    ballots.forEach((bl, i) => { for (const k of Object.keys(bl)) items.push([bids[i], cidOf(k), bl[k]]); });
    for (const part1 of chunked(items, 800)) {
      st2.push(stmt(c.env,
        "INSERT INTO ballot_item (ballot_id, candidate_id, choice) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]') FROM json_each(?1)",
        JSON.stringify(part1)));
    }
    await batch(c.env, st2);

    // 4) 저장된 값으로 다시 개표해 파일의 결과와 맞는지 확인한 뒤, 종료 상태로 바꿔 목록에 나타낸다.
    const res = await buildResults(c.env, eid);
    if (res.ballots !== b.results.ballots || !res.consistent) throw new Error('mismatch-2');
    for (const r of res.races) for (const x of r.candidates) {
      const k = [...cands.keys()].find((kk) => cidOf(kk) === x.candidate_id);
      if (x.yes !== want.get(k).yes || x.no !== want.get(k).no) throw new Error('mismatch-3');
    }
    await batch(c.env, [
      stmt(c.env, "UPDATE election SET phase = 'closed', hidden = 0 WHERE id = ? AND phase = 'setup'", eid),
      auditStmt(c.env, c.admin.id, eid, 'election.restore', {
        source_title: srcTitle, people: people.size, online_ballots: ballots.length, offline_ballots: off ? off.ballots : 0, time_removed: b.time_removed === true,
      }),
    ]);
  } catch (e) {
    await rollback();
    if (e instanceof HttpError) throw e;
    if (/^mismatch/.test(String(e?.message))) throw new HttpError(500, '복원한 자료가 파일과 일치하지 않아 중단하고 되돌렸습니다. 다시 시도하세요.');
    throw e;
  }
  return json({ id: eid, title });
});

route('POST', '/api/admin/elections', 'chair', async (c) => {
  const d = parseJson(c);
  const title = strField(d, 'title', 1, 100, '선거 이름'), base = dateField(d, 'base_date', '선거일');
  const r = await run(c.env, 'INSERT INTO election (title, base_date, created_at) VALUES (?,?,?)', title, base, iso());
  const eid = r.meta.last_row_id;
  await audit(c.env, c.admin.id, eid, 'election.create', { title });
  return json({ id: eid });
});

route('PATCH', '/api/admin/elections/{eid}', 'chair', async (c) => {
  const d = parseJson(c), { eid } = c.params;
  const el = await getElection(c.env, eid);
  needSetup(el);
  const st = [];
  if ('title' in d) st.push(stmt(c.env, 'UPDATE election SET title = ? WHERE id = ?', strField(d, 'title', 1, 100, '선거 이름'), eid));
  if ('base_date' in d) {
    needUnlocked(el);
    st.push(stmt(c.env, 'UPDATE election SET base_date = ? WHERE id = ?', dateField(d, 'base_date', '선거일'), eid));
  }
  const detail = {};
  for (const k of ['title', 'base_date']) if (k in d) detail[k] = d[k];
  st.push(auditStmt(c.env, c.admin.id, eid, 'election.update', detail));
  await batch(c.env, st);
  return json({ ok: true });
});

route('DELETE', '/api/admin/elections/{eid}', 'chair', async (c) => {
  // 끝난(또는 시작하지 않은) 선거와 그 안의 모든 자료(교적부, QR, 투표함, 사진, 기록)를 지운다. 진행 중인 선거는 지울 수 없다.
  const { eid } = c.params, d = parseJson(c), el = await getElection(c.env, eid);
  if (el.phase === 'open') throw new HttpError(409, '진행 중인 선거는 삭제할 수 없습니다. 먼저 투표를 종료하세요.');
  if (typeof d.confirm_title !== 'string' || d.confirm_title.trim() !== el.title.trim()) throw bad('확인을 위해 선거 이름을 정확히 입력하세요.');
  const n = (sql) => countOf(c.env, sql, eid);
  const summary = {
    title: el.title, phase: el.phase, people: await n('SELECT count(*) AS n FROM person WHERE election_id = ?'),
    ballots: await n('SELECT count(*) AS n FROM ballot WHERE election_id = ?'),
  };
  // 모든 문장에 같은 조건(진행 중이 아님)을 걸어, 삭제 도중 상태가 바뀌어도 일부만 지워지지 않게 한다.
  const res = await batch(c.env, wipeStmts(c.env, eid));
  if (changes(res[res.length - 1]) !== 1) throw new HttpError(409, '선거를 삭제하지 못했습니다. 상태를 새로 고침하세요.');
  // 삭제 사실만 남긴다(개인정보 없음).
  await audit(c.env, c.admin.id, null, 'election.delete', { election_id: eid, ...summary });
  return json({ ok: true });
});

route('GET', '/api/admin/elections/{eid}/progress', 'staff', async (c) => {
  // 투표율만 알려 준다. 후보별 득표는 어디에도 나오지 않는다.
  const { eid } = c.params, el = await getElection(c.env, eid);
  const r = await one(c.env,
    "SELECT (SELECT count(*) FROM roll WHERE election_id=?1) AS voters, " +
    "(SELECT count(*) FROM ticket WHERE election_id=?1 AND status IN ('issued','used')) AS issued, " +
    "(SELECT count(*) FROM ticket WHERE election_id=?1 AND status='used') AS voted, " +
    "(SELECT count(*) FROM offline_voter WHERE election_id=?1) AS offline", eid);
  return json({
    phase: el.phase, roster_locked: !!el.roster_locked, base_date: el.base_date, title: el.title,
    voters: r.voters, issued: r.issued, voted: r.voted, waiting: r.issued - r.voted, offline: r.offline,
  });
});

route('POST', '/api/admin/elections/{eid}/people/import', 'chair', async (c) => {
  const { eid } = c.params;
  if (!c.raw.length) throw bad('파일이 비어 있습니다.');
  let result;
  try { result = await parseUpload(c.raw, c.url.searchParams.get('name') || ''); }
  catch (e) { throw bad(e.message); }
  if (!result.ok.length) throw bad('읽을 수 있는 행이 없습니다. 열 제목(직분, 이름, 생년월일, 등록일)을 확인하세요.');
  const el = await getElection(c.env, eid);
  needSetup(el); needUnlocked(el);
  const st = [stmt(c.env, 'DELETE FROM race WHERE election_id = ?', eid), stmt(c.env, 'DELETE FROM person WHERE election_id = ?', eid)];
  for (let i = 0; i < result.ok.length; i += CHUNK) {
    const part = result.ok.slice(i, i + CHUNK).map((p) => [p.role, p.name, p.birth, p.reg_date, p.member_ok]);
    st.push(stmt(c.env,
      "INSERT INTO person (election_id, role, name, birth, reg_date, member_ok) SELECT ?1, json_extract(value,'$[0]'), " +
      "json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]') FROM json_each(?2)",
      eid, JSON.stringify(part)));
  }
  st.push(auditStmt(c.env, c.admin.id, eid, 'people.import', { imported: result.ok.length, excluded: result.bad.length }));
  await batch(c.env, st);
  return json({ imported: result.ok.length, excluded: result.bad });
});

route('GET', '/api/admin/elections/{eid}/people', 'chair', async (c) => {
  const { eid } = c.params, el = await getElection(c.env, eid);
  const rows = await all(c.env,
    'SELECT p.id, p.role, p.name, p.birth, p.reg_date, p.member_ok, ' +
    'EXISTS(SELECT 1 FROM roll r WHERE r.election_id = p.election_id AND r.person_id = p.id) AS in_roll ' +
    'FROM person p WHERE p.election_id = ? ORDER BY p.name, p.birth', eid);
  return json(rows.map((r) => ({
    id: r.id, role: r.role, name: r.name, birth: r.birth, reg_date: r.reg_date, member_ok: !!r.member_ok,
    age: ageOn(r.birth, el.base_date), ineligible_reason: ineligibleReason(r.birth, el.base_date, !!r.member_ok), in_roll: !!r.in_roll,
  })));
});

route('POST', '/api/admin/elections/{eid}/people/member-ok', 'chair', async (c) => {
  const { eid } = c.params, d = parseJson(c), value = d.value ? 1 : 0, ids = d.person_ids;
  const el = await getElection(c.env, eid);
  needSetup(el); needUnlocked(el);
  let r;
  if (ids === undefined || ids === null) {
    r = await run(c.env, 'UPDATE person SET member_ok = ? WHERE election_id = ?', value, eid);
  } else {
    if (!Array.isArray(ids) || !ids.every(Number.isInteger)) throw bad('교인 목록이 올바르지 않습니다.');
    r = await run(c.env, 'UPDATE person SET member_ok = ?1 WHERE election_id = ?2 AND id IN (SELECT value FROM json_each(?3))',
      value, eid, JSON.stringify(ids));
  }
  await audit(c.env, c.admin.id, eid, 'people.member_ok', { value: !!value, count: changes(r) });
  return json({ updated: changes(r) });
});

route('POST', '/api/admin/elections/{eid}/roll/lock', 'chair', async (c) => {
  const { eid } = c.params, el = await getElection(c.env, eid);
  needSetup(el); needUnlocked(el);
  const ids = (await all(c.env, 'SELECT id, birth, member_ok FROM person WHERE election_id = ?', eid))
    .filter((r) => ineligibleReason(r.birth, el.base_date, !!r.member_ok) === null).map((r) => r.id);
  if (!ids.length) throw bad('선거인이 한 명도 없습니다. 무흠 입교 체크를 확인하세요.');
  const st = [stmt(c.env, 'DELETE FROM roll WHERE election_id = ?', eid)];
  for (let i = 0; i < ids.length; i += 1000) {
    st.push(stmt(c.env, 'INSERT INTO roll (election_id, person_id) SELECT ?1, value FROM json_each(?2)', eid, JSON.stringify(ids.slice(i, i + 1000))));
  }
  st.push(stmt(c.env, 'UPDATE election SET roster_locked = 1 WHERE id = ?', eid));
  st.push(auditStmt(c.env, c.admin.id, eid, 'roll.lock', { voters: ids.length, base_date: el.base_date }));
  await batch(c.env, st);
  return json({ voters: ids.length });
});

route('POST', '/api/admin/elections/{eid}/roll/unlock', 'chair', async (c) => {
  const { eid } = c.params;
  needSetup(await getElection(c.env, eid));
  await batch(c.env, [
    stmt(c.env, 'DELETE FROM roll WHERE election_id = ?', eid),
    stmt(c.env, 'UPDATE election SET roster_locked = 0 WHERE id = ?', eid),
    auditStmt(c.env, c.admin.id, eid, 'roll.unlock', {}),
  ]);
  return json({ ok: true });
});

route('GET', '/api/admin/elections/{eid}/races', 'chair', async (c) => {
  await getElection(c.env, c.params.eid);
  return json(await racesWithCandidates(c.env, c.params.eid));
});

route('POST', '/api/admin/elections/{eid}/races', 'chair', async (c) => {
  const { eid } = c.params, d = parseJson(c);
  const name = strField(d, 'name', 1, 100, '투표 항목 이름');
  if (!RULES.includes(d.rule)) throw bad('가결 기준을 선택하세요.');
  needSetup(await getElection(c.env, eid));
  const r = await run(c.env,
    'INSERT INTO race (election_id, name, rule, sort_order) VALUES (?1,?2,?3,(SELECT COALESCE(MAX(sort_order),0)+1 FROM race WHERE election_id = ?1))',
    eid, name, d.rule);
  const rid = r.meta.last_row_id;
  await audit(c.env, c.admin.id, eid, 'race.create', { race_id: rid, name, rule: d.rule });
  return json({ id: rid });
});

route('PATCH', '/api/admin/elections/{eid}/races/{rid}', 'chair', async (c) => {
  const { eid, rid } = c.params, d = parseJson(c);
  if (!RULES.includes(d.rule)) throw bad('가결 기준을 선택하세요.');
  needSetup(await getElection(c.env, eid));
  const r = await run(c.env, 'UPDATE race SET rule = ? WHERE id = ? AND election_id = ?', d.rule, rid, eid);
  if (changes(r) === 0) throw new HttpError(404, '투표 항목을 찾을 수 없습니다.');
  await audit(c.env, c.admin.id, eid, 'race.rule', { race_id: rid, rule: d.rule });
  return json({ ok: true });
});

route('DELETE', '/api/admin/elections/{eid}/races/{rid}', 'chair', async (c) => {
  const { eid, rid } = c.params;
  needSetup(await getElection(c.env, eid));
  const r = await run(c.env, 'DELETE FROM race WHERE id = ? AND election_id = ?', rid, eid);
  if (changes(r) === 0) throw new HttpError(404, '투표 항목을 찾을 수 없습니다.');
  await audit(c.env, c.admin.id, eid, 'race.delete', { race_id: rid });
  return json({ ok: true });
});

route('POST', '/api/admin/elections/{eid}/races/{rid}/candidates', 'chair', async (c) => {
  const { eid, rid } = c.params, pid = intField(parseJson(c), 'person_id', '교인');
  needSetup(await getElection(c.env, eid));
  if (!(await one(c.env, 'SELECT 1 AS x FROM race WHERE id = ? AND election_id = ?', rid, eid))) throw new HttpError(404, '투표 항목을 찾을 수 없습니다.');
  if (!(await one(c.env, 'SELECT 1 AS x FROM person WHERE id = ? AND election_id = ?', pid, eid))) throw new HttpError(404, '교적부에 없는 교인입니다.');
  const r = await run(c.env, 'INSERT OR IGNORE INTO candidate (race_id, person_id) VALUES (?,?)', rid, pid);
  if (changes(r) === 0) throw new HttpError(409, '이미 이 항목의 후보입니다.');
  await audit(c.env, c.admin.id, eid, 'candidate.add', { race_id: rid, person_id: pid });
  return json({ id: r.meta.last_row_id });
});

route('DELETE', '/api/admin/elections/{eid}/candidates/{cid}', 'chair', async (c) => {
  const { eid, cid } = c.params;
  needSetup(await getElection(c.env, eid));
  const r = await run(c.env, 'DELETE FROM candidate WHERE id = ? AND race_id IN (SELECT id FROM race WHERE election_id = ?)', cid, eid);
  if (changes(r) === 0) throw new HttpError(404, '후보를 찾을 수 없습니다.');
  await audit(c.env, c.admin.id, eid, 'candidate.delete', { candidate_id: cid });
  return json({ ok: true });
});

route('PUT', '/api/admin/elections/{eid}/people/{pid}/photo', 'chair', async (c) => {
  // 후보 사진. 화면에서 360x480 JPEG로 줄여 올리며, 서버는 500KB 이하의 JPG/PNG/WEBP만 받는다.
  const { eid, pid } = c.params;
  if (c.raw.length > MAX_PHOTO) throw new HttpError(413, '사진 용량은 500KB 이하여야 합니다.');
  const mime = detectImageMime(c.raw);
  if (!mime) throw bad('JPG, PNG, WEBP 사진만 올릴 수 있습니다.');
  needSetup(await getElection(c.env, eid));
  if (!(await one(c.env, 'SELECT 1 AS x FROM person WHERE id = ? AND election_id = ?', pid, eid))) throw new HttpError(404, '교적부에 없는 교인입니다.');
  await run(c.env,
    'INSERT INTO person_photo (person_id, mime, data_b64, updated_at) VALUES (?,?,?,?) ' +
    'ON CONFLICT(person_id) DO UPDATE SET mime=excluded.mime, data_b64=excluded.data_b64, updated_at=excluded.updated_at',
    pid, mime, toBase64(c.raw), iso());
  await audit(c.env, c.admin.id, eid, 'photo.upload', { person_id: pid });
  return json({ photo_url: photoUrl(pid, true) });
});

route('DELETE', '/api/admin/elections/{eid}/people/{pid}/photo', 'chair', async (c) => {
  const { eid, pid } = c.params;
  needSetup(await getElection(c.env, eid));
  await run(c.env, 'DELETE FROM person_photo WHERE person_id = ? AND person_id IN (SELECT id FROM person WHERE election_id = ?)', pid, eid);
  await audit(c.env, c.admin.id, eid, 'photo.delete', { person_id: pid });
  return json({ ok: true });
});

route('POST', '/api/admin/elections/{eid}/start', 'chair', async (c) => {
  const { eid } = c.params, el = await getElection(c.env, eid);
  needSetup(el);
  if (!el.roster_locked) throw new HttpError(409, '선거인명부를 먼저 확정하세요.');
  if ((await countOf(c.env, 'SELECT count(*) AS n FROM race WHERE election_id = ?', eid)) === 0) throw new HttpError(409, '투표 항목을 하나 이상 등록하세요.');
  const empty = await all(c.env, 'SELECT name FROM race r WHERE election_id = ? AND NOT EXISTS (SELECT 1 FROM candidate c WHERE c.race_id = r.id)', eid);
  if (empty.length) throw new HttpError(409, '후보가 없는 투표 항목이 있습니다: ' + empty.map((r) => r.name).join(', '));
  const r = await run(c.env, "UPDATE election SET phase = 'open' WHERE id = ? AND phase = 'setup'", eid);
  if (changes(r) !== 1) throw new HttpError(409, '투표가 시작된 뒤에는 수정할 수 없습니다.');
  await audit(c.env, c.admin.id, eid, 'election.start', {});
  return json({ phase: 'open' });
});

route('POST', '/api/admin/elections/{eid}/close', 'chair', async (c) => {
  // 한 번에 처리: 투표 종료 + 사용하지 않은 QR 무효화. 종료 이후의 제출은 phase 조건 때문에 모두 거절된다.
  // 투표함은 무작위 ID의 WITHOUT ROWID 테이블이라 별도의 섞기가 필요 없다.
  const { eid } = c.params, el = await getElection(c.env, eid);
  if (el.phase !== 'open') throw new HttpError(409, '진행 중인 투표만 종료할 수 있습니다.');
  const res = await batch(c.env, [
    stmt(c.env, "UPDATE election SET phase = 'closed' WHERE id = ? AND phase = 'open'", eid),
    stmt(c.env, "UPDATE ticket SET status = 'revoked' WHERE election_id = ? AND status = 'issued' AND (SELECT phase FROM election WHERE id = ?) = 'closed'", eid, eid),
  ]);
  if (changes(res[0]) !== 1) throw new HttpError(409, '진행 중인 투표만 종료할 수 있습니다.');
  const revoked = changes(res[1]);
  const ballots = await countOf(c.env, 'SELECT count(*) AS n FROM ballot WHERE election_id = ?', eid);
  const used = await countOf(c.env, "SELECT count(*) AS n FROM ticket WHERE election_id = ? AND status = 'used'", eid);
  const offline = await countOf(c.env, 'SELECT count(*) AS n FROM offline_voter WHERE election_id = ?', eid);
  await audit(c.env, c.admin.id, eid, 'election.close', { ballots, used_tickets: used, revoked_unused: revoked, offline_checked_in: offline });
  return json({ phase: 'closed', ballots, used_tickets: used, revoked_unused: revoked, offline_checked_in: offline });
});

async function issueTicket(c, reissue) {
  const { eid } = c.params, pid = intField(parseJson(c), 'person_id', '교인');
  const el = await getElection(c.env, eid);
  if (el.phase !== 'open') throw new HttpError(409, '투표가 진행 중일 때만 QR을 발급할 수 있습니다.');
  if (!(await one(c.env, 'SELECT 1 AS x FROM roll WHERE election_id = ? AND person_id = ?', eid, pid))) throw new HttpError(404, '선거인명부에 없는 교인입니다.');
  if (await one(c.env, 'SELECT 1 AS x FROM offline_voter WHERE election_id = ? AND person_id = ?', eid, pid)) {
    throw new HttpError(409, '오프라인 투표로 확인된 선거인입니다. QR을 발급하려면 오프라인 확인을 먼저 취소하세요.');
  }
  const live = await one(c.env, "SELECT id, status FROM ticket WHERE election_id = ? AND person_id = ? AND status IN ('issued','used')", eid, pid);
  if (live) {
    if (live.status === 'used') throw new HttpError(409, '이미 투표를 완료한 선거인입니다.');
    if (!reissue) throw new HttpError(409, '이미 QR이 발급되었습니다. 분실한 경우 재발급을 사용하세요.');
  } else if (reissue) throw new HttpError(409, '재발급할 QR이 없습니다. 먼저 발급하세요.');
  const token = newToken();
  const st = [];
  if (live) st.push(stmt(c.env, "UPDATE ticket SET status = 'revoked' WHERE id = ? AND status = 'issued'", live.id));
  st.push(stmt(c.env,
    "INSERT INTO ticket (election_id, person_id, token_hash, issued_by, issued_at) SELECT ?1, ?2, ?3, ?4, ?5 " +
    "WHERE (SELECT phase FROM election WHERE id = ?1) = 'open' " +
    "AND NOT EXISTS (SELECT 1 FROM offline_voter WHERE election_id = ?1 AND person_id = ?2)",
    eid, pid, await tokenHash(token, c.env.VOTE_PEPPER), c.admin.id, iso()));
  let res;
  try { res = await batch(c.env, st); }
  catch (e) {
    if (isUnique(e)) throw new HttpError(409, '이미 QR이 발급되었거나 투표를 완료한 선거인입니다.');
    throw e;
  }
  if (changes(res[res.length - 1]) !== 1) throw new HttpError(409, '지금은 QR을 발급할 수 없습니다. 상태를 새로 고침하세요.');
  await audit(c.env, c.admin.id, eid, reissue ? 'ticket.reissue' : 'ticket.issue', { person_id: pid });
  // 토큰 원문은 이 응답에서만 볼 수 있다. 주소의 # 뒤 값은 서버 접속 기록에 남지 않는다.
  return json({ token, url: `${c.url.origin}/v#${token}` });
}
route('POST', '/api/admin/elections/{eid}/tickets', 'staff', (c) => issueTicket(c, false));
route('POST', '/api/admin/elections/{eid}/tickets/reissue', 'staff', (c) => issueTicket(c, true));

route('GET', '/api/admin/elections/{eid}/desk', 'staff', async (c) => {
  const { eid } = c.params;
  await getElection(c.env, eid);
  return json(await all(c.env,
    'SELECT p.id AS person_id, p.name, p.role, p.birth, ' +
    "CASE WHEN EXISTS (SELECT 1 FROM offline_voter o WHERE o.election_id = r.election_id AND o.person_id = p.id) " +
    "THEN 'offline' ELSE COALESCE(t.status, 'none') END AS status " +
    'FROM roll r JOIN person p ON p.id = r.person_id ' +
    "LEFT JOIN ticket t ON t.election_id = r.election_id AND t.person_id = p.id AND t.status IN ('issued','used') " +
    'WHERE r.election_id = ? ORDER BY p.name, p.birth', eid));
});

// ---------- 오프라인(종이) 투표 ----------
route('POST', '/api/admin/elections/{eid}/offline', 'staff', async (c) => {
  // 본인 확인 후 종이 투표를 하게 하는 선거인을 표시한다. 이미 발급된 QR은 무효가 된다.
  const { eid } = c.params, pid = intField(parseJson(c), 'person_id', '교인');
  if ((await getElection(c.env, eid)).phase !== 'open') throw new HttpError(409, '투표가 진행 중일 때만 확인할 수 있습니다.');
  if (!(await one(c.env, 'SELECT 1 AS x FROM roll WHERE election_id = ? AND person_id = ?', eid, pid))) throw new HttpError(404, '선거인명부에 없는 교인입니다.');
  const live = await one(c.env, "SELECT id, status FROM ticket WHERE election_id = ? AND person_id = ? AND status IN ('issued','used')", eid, pid);
  if (live?.status === 'used') throw new HttpError(409, '이미 온라인으로 투표를 완료한 선거인입니다.');
  const res = await batch(c.env, [
    stmt(c.env, "UPDATE ticket SET status = 'revoked' WHERE election_id = ? AND person_id = ? AND status = 'issued'", eid, pid),
    stmt(c.env,
      "INSERT OR IGNORE INTO offline_voter (election_id, person_id, checked_by, checked_at) SELECT ?1, ?2, ?3, ?4 " +
      "WHERE (SELECT phase FROM election WHERE id = ?1) = 'open' " +
      "AND NOT EXISTS (SELECT 1 FROM ticket WHERE election_id = ?1 AND person_id = ?2 AND status = 'used')",
      eid, pid, c.admin.id, iso()),
  ]);
  if (changes(res[1]) !== 1) {
    if (await one(c.env, 'SELECT 1 AS x FROM offline_voter WHERE election_id = ? AND person_id = ?', eid, pid)) throw new HttpError(409, '이미 오프라인 투표로 확인되었습니다.');
    throw new HttpError(409, '이미 온라인으로 투표를 완료했거나 투표가 진행 중이 아닙니다.');
  }
  await audit(c.env, c.admin.id, eid, 'offline.checkin', { person_id: pid, revoked_qr: !!live });
  return json({ ok: true });
});

route('DELETE', '/api/admin/elections/{eid}/offline/{pid}', 'staff', async (c) => {
  const { eid, pid } = c.params;
  if ((await getElection(c.env, eid)).phase !== 'open') throw new HttpError(409, '투표가 진행 중일 때만 취소할 수 있습니다.');
  const r = await run(c.env, 'DELETE FROM offline_voter WHERE election_id = ? AND person_id = ?', eid, pid);
  if (changes(r) === 0) throw new HttpError(404, '오프라인 투표로 확인된 선거인이 아닙니다.');
  await audit(c.env, c.admin.id, eid, 'offline.cancel', { person_id: pid });
  return json({ ok: true });
});

route('GET', '/api/admin/elections/{eid}/offline-results', 'chair', async (c) => {
  const { eid } = c.params, el = await getElection(c.env, eid);
  const checked = await countOf(c.env, 'SELECT count(*) AS n FROM offline_voter WHERE election_id = ?', eid);
  const tally = await one(c.env, 'SELECT ballots, invalid, entered_at FROM offline_tally WHERE election_id = ?', eid);
  const counts = new Map((await all(c.env, 'SELECT candidate_id, yes, no FROM offline_count WHERE election_id = ?', eid)).map((r) => [r.candidate_id, r]));
  const races = await racesWithCandidates(c.env, eid);
  for (const race of races) for (const cand of race.candidates) {
    const v = counts.get(cand.id);
    cand.yes = v ? v.yes : null; cand.no = v ? v.no : null;
  }
  return json({
    phase: el.phase, checked_in: checked, entered: !!tally, ballots: tally ? tally.ballots : null,
    invalid: tally ? tally.invalid : null, entered_at: tally ? tally.entered_at : null, races,
  });
});

route('PUT', '/api/admin/elections/{eid}/offline-results', 'chair', async (c) => {
  // 종이 투표지를 개표한 합계를 입력한다(투표 종료 후). 다시 입력하면 이전 입력을 대체한다.
  const { eid } = c.params, d = parseJson(c);
  const ballots = intField(d, 'ballots', '유효 투표지 수'), invalid = intField(d, 'invalid', '무효 투표지 수');
  if (d.counts === null || typeof d.counts !== 'object' || Array.isArray(d.counts)) throw bad('후보별 가/부 수를 입력하세요.');
  const counts = {};
  for (const [k, v] of Object.entries(d.counts)) {
    const id = Number(k);
    if (!Number.isInteger(id) || !v || !Number.isInteger(v.yes) || !Number.isInteger(v.no)) throw bad('가/부 수는 숫자로 입력하세요.');
    counts[id] = [v.yes, v.no];
  }
  if ((await getElection(c.env, eid)).phase !== 'closed') throw new HttpError(409, '투표를 종료한 뒤에 입력할 수 있습니다.');
  const checked = await countOf(c.env, 'SELECT count(*) AS n FROM offline_voter WHERE election_id = ?', eid);
  const names = {};
  for (const r of await all(c.env,
    'SELECT c.id, p.name FROM candidate c JOIN race r ON r.id = c.race_id JOIN person p ON p.id = c.person_id WHERE r.election_id = ?', eid)) names[r.id] = r.name;
  try { checkOfflineCounts(checked, ballots, invalid, counts, names); }
  catch (e) { throw bad(e.message); }
  await batch(c.env, [
    stmt(c.env, 'DELETE FROM offline_count WHERE election_id = ?', eid),
    stmt(c.env, 'DELETE FROM offline_tally WHERE election_id = ?', eid),
    stmt(c.env, 'INSERT INTO offline_tally (election_id, ballots, invalid, entered_by, entered_at) VALUES (?,?,?,?,?)', eid, ballots, invalid, c.admin.id, iso()),
    stmt(c.env,
      "INSERT INTO offline_count (election_id, candidate_id, yes, no) SELECT ?1, json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]') FROM json_each(?2)",
      eid, JSON.stringify(Object.entries(counts).map(([id, [y, n]]) => [Number(id), y, n]))),
    auditStmt(c.env, c.admin.id, eid, 'offline.results', { ballots, invalid, checked_in: checked }),
  ]);
  return json({ ok: true });
});

// 온라인 투표함과 오프라인 입력 결과를 합산해 가결 여부를 판정한다.
// 결과에는 후보별 합계(가/부)만 담는다. 온라인과 오프라인을 나눈 후보별 값은 어디에도 내보내지 않는다.
async function buildResults(env, eid) {
  const onlineN = await countOf(env, 'SELECT count(*) AS n FROM ballot WHERE election_id = ?', eid);
  const used = await countOf(env, "SELECT count(*) AS n FROM ticket WHERE election_id = ? AND status = 'used'", eid);
  const checked = await countOf(env, 'SELECT count(*) AS n FROM offline_voter WHERE election_id = ?', eid);
  const tally = await one(env, 'SELECT ballots, invalid FROM offline_tally WHERE election_id = ?', eid);
  const rows = await all(env,
    'SELECT r.id AS race_id, r.name AS race_name, r.rule, c.id AS cid, p.id AS pid, p.name, p.role, ' +
    'EXISTS(SELECT 1 FROM person_photo ph WHERE ph.person_id = p.id) AS has_photo, ' +
    "(SELECT count(*) FROM ballot_item bi WHERE bi.candidate_id = c.id AND bi.choice = 'Y') AS yes, " +
    "(SELECT count(*) FROM ballot_item bi WHERE bi.candidate_id = c.id AND bi.choice = 'N') AS no, " +
    'COALESCE((SELECT oc.yes FROM offline_count oc WHERE oc.candidate_id = c.id), 0) AS off_yes, ' +
    'COALESCE((SELECT oc.no FROM offline_count oc WHERE oc.candidate_id = c.id), 0) AS off_no ' +
    'FROM race r JOIN candidate c ON c.race_id = r.id JOIN person p ON p.id = c.person_id ' +
    'WHERE r.election_id = ? ORDER BY r.sort_order, r.id, c.id', eid);
  const offN = tally ? tally.ballots : 0, n = onlineN + offN;
  const races = new Map();
  for (const r of rows) {
    if (!races.has(r.race_id)) races.set(r.race_id, { race_id: r.race_id, name: r.race_name, rule: r.rule, voters: n, need: needVotes(r.rule, n), candidates: [] });
    const yes = r.yes + r.off_yes, no = r.no + r.off_no;
    races.get(r.race_id).candidates.push({
      candidate_id: r.cid, name: r.name, role: r.role, photo_url: photoUrl(r.pid, !!r.has_photo), yes, no, passed: isPassed(r.rule, n, yes),
    });
  }
  return {
    ballots: n, online_ballots: onlineN, offline_ballots: offN, offline_checked_in: checked,
    offline_invalid: tally ? tally.invalid : 0, offline_pending: checked > 0 && !tally,
    used_tickets: used, consistent: onlineN === used, races: [...races.values()],
  };}

route('GET', '/api/admin/elections/{eid}/results', 'chair', async (c) => {
  const { eid } = c.params, el = await getElection(c.env, eid);
  if (el.phase !== 'closed') throw new HttpError(409, '투표를 종료한 뒤에만 개표 결과를 볼 수 있습니다.');
  return json(await buildResults(c.env, eid));
});

route('GET', '/api/admin/elections/{eid}/audit', 'chair', async (c) => {
  const { eid } = c.params;
  await getElection(c.env, eid);
  const rows = await all(c.env,
    'SELECT a.at, u.username, a.action, a.detail FROM audit_log a LEFT JOIN admin_user u ON u.id = a.admin_id ' +
    'WHERE a.election_id = ? ORDER BY a.id DESC LIMIT 500', eid);
  return json(rows.map((r) => ({ at: r.at, username: r.username, action: r.action, detail: JSON.parse(r.detail) })));
});

// =====================================================================
// 유권자 API
// =====================================================================
function ticketError(status) {
  if (status === 'used') return new HttpError(409, '이미 투표를 완료한 QR입니다.');
  if (status === 'revoked') return new HttpError(409, '무효가 된 QR입니다. 접수처에 문의하세요.');
  return null;
}
async function badToken(c) {
  await rateFail(c.env, 'token', c.ip);
  return new HttpError(404, '등록되지 않은 QR입니다. 접수처에 문의하세요.');
}
async function tokenFrom(c, d) {
  const t = d.token;
  if (typeof t !== 'string' || t.length < 8 || t.length > 64) throw bad('투표 코드를 입력하세요.');
  return tokenHash(t, c.env.VOTE_PEPPER);
}

route('POST', '/api/vote/lookup', null, async (c) => {
  // QR을 확인하고 투표 화면에 필요한 후보 목록(이름, 직분, 사진 주소)을 돌려준다.
  await rateCheck(c.env, 'token', c.ip, 30, 300);
  const th = await tokenFrom(c, parseJson(c));
  const t = await one(c.env,
    'SELECT t.status, t.election_id, p.name, p.role, e.title, e.phase FROM ticket t ' +
    'JOIN person p ON p.id = t.person_id JOIN election e ON e.id = t.election_id WHERE t.token_hash = ?', th);
  if (!t) throw await badToken(c);
  const err = ticketError(t.status);
  if (err) throw err;
  if (t.phase !== 'open') throw new HttpError(409, '투표가 진행 중이 아닙니다.');
  const races = await racesWithCandidates(c.env, t.election_id);
  return json({
    voter: { name: t.name, role: t.role }, election: t.title,
    races: races.map((r) => ({
      id: r.id, name: r.name, rule: r.rule,
      candidates: r.candidates.map((x) => ({ id: x.id, name: x.name, role: x.role, photo_url: x.photo_url })),
    })),
  });
});

route('POST', '/api/vote/submit', null, async (c) => {
  // QR 사용 처리와 투표함 저장은 한 번의 batch(=트랜잭션)라 둘 다 되거나 둘 다 안 된다.
  // 같은 QR로 동시에 여러 번 제출해도 첫 문장(status='issued' 조건)을 통과하는 요청은 하나뿐이고,
  // 나머지 문장은 changes()=1 조건이 맞을 때만 실행된다.
  await rateCheck(c.env, 'token', c.ip, 30, 300);
  const d = parseJson(c), th = await tokenFrom(c, d);
  if (d.choices === null || typeof d.choices !== 'object' || Array.isArray(d.choices)) throw bad('모든 후보에 가 또는 부를 선택해야 합니다.');
  const t = await one(c.env, 'SELECT id, election_id, status FROM ticket WHERE token_hash = ?', th);
  if (!t) throw await badToken(c);
  const err = ticketError(t.status);
  if (err) throw err;
  const eid = t.election_id;
  if ((await getElection(c.env, eid)).phase !== 'open') throw new HttpError(409, '투표가 진행 중이 아닙니다.');
  const candIds = (await all(c.env, 'SELECT c.id FROM candidate c JOIN race r ON r.id = c.race_id WHERE r.election_id = ?', eid)).map((r) => r.id);
  const picks = [];
  for (const [k, v] of Object.entries(d.choices)) {
    const id = Number(k);
    if (!Number.isInteger(id) || (v !== 'Y' && v !== 'N')) throw bad('모든 후보에 가 또는 부를 선택해야 합니다.');
    picks.push([id, v]);
  }
  const want = new Set(candIds);
  if (picks.length !== want.size || !picks.every(([id]) => want.has(id))) throw bad('모든 후보에 가 또는 부를 선택해야 합니다.');
  const bid = randomHex(16);
  // 사용 시각은 '시' 단위로만 남긴다. 투표함 행에는 시각도, 유권자 정보도 없다.
  const res = await batch(c.env, [
    stmt(c.env,
      "UPDATE ticket SET status = 'used', used_at = ?1 WHERE id = ?2 AND status = 'issued' " +
      "AND EXISTS (SELECT 1 FROM election e WHERE e.id = ticket.election_id AND e.phase = 'open')", hourIso(), t.id),
    stmt(c.env, 'INSERT INTO ballot (id, election_id) SELECT ?1, ?2 WHERE changes() = 1', bid, eid),
    stmt(c.env,
      "INSERT INTO ballot_item (ballot_id, candidate_id, choice) SELECT ?1, json_extract(value,'$[0]'), json_extract(value,'$[1]') " +
      'FROM json_each(?2) WHERE EXISTS (SELECT 1 FROM ballot WHERE id = ?1)', bid, JSON.stringify(picks)),
  ]);
  if (changes(res[0]) !== 1 || changes(res[1]) !== 1) {
    const now = await one(c.env, 'SELECT status FROM ticket WHERE id = ?', t.id);
    throw ticketError(now?.status) ?? new HttpError(409, '투표가 진행 중이 아닙니다.');
  }
  return json({ ok: true });
});

route('GET', '/api/photo/{pid}', null, async (c) => {
  // 후보로 등록된 교인의 사진만 내려 주므로 일반 교인 사진은 노출되지 않는다.
  const row = await one(c.env,
    'SELECT ph.mime, ph.data_b64 FROM person_photo ph WHERE ph.person_id = ? ' +
    'AND EXISTS (SELECT 1 FROM candidate c WHERE c.person_id = ph.person_id)', c.params.pid);
  if (!row) throw new HttpError(404, '사진이 없습니다.');
  return new Response(fromBase64(row.data_b64), { headers: { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=300' } });
});

// =====================================================================
// 요청 처리
// =====================================================================
const PAGES = { '/admin': '/static/admin.html', '/v': '/static/vote.html' };

function secure(resp) {
  const h = new Headers(resp.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Frame-Options', 'DENY');
  const ct = h.get('Content-Type') || '';
  if (ct.startsWith('text/html')) h.set('Content-Security-Policy', CSP);
  if (ct.startsWith('application/json')) h.set('Cache-Control', 'no-store');
  return new Response(resp.body, { status: resp.status, headers: h });
}

async function handle(req, env) {
  if (!env.VOTE_PEPPER || env.VOTE_PEPPER.length < 32) {
    throw new HttpError(500, '서버 설정이 끝나지 않았습니다. VOTE_PEPPER(32자 이상)를 등록하세요.');
  }
  const url = new URL(req.url), path = url.pathname, method = req.method;
  if (method === 'GET' && path === '/') return new Response(null, { status: 302, headers: { Location: '/admin' } });

  let match = null, pathMatched = false;
  for (const r of routes) {
    const m = r.rx.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (r.method === method) { match = { r, params: Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, Number(v)])) }; break; }
  }
  if (!match) {
    if (pathMatched) throw new HttpError(405, '허용되지 않는 요청입니다.');
    if (method !== 'GET') throw new HttpError(404, '찾을 수 없습니다.');
    const target = PAGES[path] ?? path;
    if (!target.startsWith('/static/') || target.includes('..')) throw new HttpError(404, '찾을 수 없습니다.');
    const resp = await env.ASSETS.fetch(new Request(new URL(target, url.origin), { method: 'GET' }));
    if (resp.status !== 200) throw new HttpError(404, '찾을 수 없습니다.');
    const h = new Headers(resp.headers);
    h.set('Cache-Control', 'no-cache');
    return new Response(resp.body, { status: 200, headers: h });
  }

  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, '파일이 너무 큽니다.');
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length > MAX_BODY) throw new HttpError(413, '파일이 너무 큽니다.');
  const c = {
    env, req, url, raw, params: match.params, admin: null,
    ip: req.headers.get('CF-Connecting-IP') || 'local',
  };
  const { role } = match.r;
  if (method !== 'GET' && (role || path === '/api/admin/login') && req.headers.get('X-Requested-With') !== 'fetch') {
    throw new HttpError(403, '허용되지 않는 요청입니다.');
  }
  if (role) {
    c.admin = await currentAdmin(c);
    if (role === 'chair' && c.admin.role !== 'chair') throw new HttpError(403, '이 작업을 할 권한이 없습니다.');
  }
  return match.r.fn(c);
}

export default {
  async fetch(req, env) {
    try {
      return secure(await handle(req, env));
    } catch (e) {
      if (e instanceof HttpError) return secure(json({ detail: e.msg }, e.status));
      console.error(e && e.stack ? e.stack : e);
      return secure(json({ detail: '서버에서 오류가 발생했습니다. 잠시 후 다시 시도하세요.' }, 500));
    }
  },
};
