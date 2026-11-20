// 가결 판정, 선거인 자격, 토큰·비밀번호, 교적부 파일(엑셀/CSV) 읽기. DB와 웹에 의존하지 않는 순수 로직.
import { readXlsx } from './xlsx.js';

export const MAX_ROWS = 5000;
export const RULES = ['half', 'twothirds'];
const enc = new TextEncoder();

// ---------- 가결 판정 ----------
/** 투표자 수 n명일 때 가결에 필요한 최소 '가' 표 수. */
export function needVotes(rule, n) {
  if (rule === 'half') return Math.floor(n / 2) + 1;               // 과반: 가 > n/2 (정확히 절반이면 부결)
  if (rule === 'twothirds') return Math.floor((2 * n + 2) / 3);    // 3분의 2 이상(올림)
  throw new Error('알 수 없는 가결 기준: ' + rule);
}
export const isPassed = (rule, n, yes) => n > 0 && yes >= needVotes(rule, n);

// ---------- 오프라인(종이) 투표 결과 검증 ----------
/** counts: { 후보id: [가, 부] }, names: { 후보id: 이름 }. 문제가 있으면 Error(한국어 안내). */
export function checkOfflineCounts(checkedIn, ballots, invalid, counts, names) {
  if (ballots < 0 || invalid < 0) throw new Error('투표지 수는 0 이상이어야 합니다.');
  if (ballots + invalid > checkedIn) {
    throw new Error(`투표지 합계(유효 ${ballots}장 + 무효 ${invalid}장)가 오프라인 투표 확인 인원(${checkedIn}명)보다 많습니다.`);
  }
  const a = Object.keys(counts).sort(), b = Object.keys(names).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) throw new Error('모든 후보의 가/부 수를 입력하세요.');
  for (const [cid, [yes, no]] of Object.entries(counts)) {
    if (yes < 0 || no < 0) throw new Error(`${names[cid]} 후보의 가/부 수는 0 이상이어야 합니다.`);
    if (yes + no !== ballots) {
      throw new Error(`${names[cid]} 후보의 가(${yes}) + 부(${no}) = ${yes + no}표가 유효 투표지 수(${ballots}장)와 다릅니다.`);
    }
  }
}

// ---------- 날짜 ----------
const pad = (n, w = 2) => String(n).padStart(w, '0');
function mkDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (y < 1000 || t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}
/** 문자열·숫자·엑셀 일련번호를 'YYYY-MM-DD'로. 읽을 수 없으면 null. */
export function toDate(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  let s;
  if (typeof v === 'number') {
    const n = Math.trunc(v);
    if (n >= 19000101 && n <= 21001231) s = String(n);
    else if (n >= 20000 && n < 80000) {                       // 엑셀 날짜 일련번호
      const t = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return mkDate(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    } else return null;
  } else s = String(v).trim();
  for (const rx of [/^(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})/, /^(\d{4})(\d{2})(\d{2})$/]) {
    const m = rx.exec(s);
    if (m) return mkDate(+m[1], +m[2], +m[3]);
  }
  return null;
}

// ---------- 선거인 자격 ----------
export function ageOn(birth, base) {
  const [by, bm, bd] = birth.split('-').map(Number), [cy, cm, cd] = base.split('-').map(Number);
  return cy - by - (cm < bm || (cm === bm && cd < bd) ? 1 : 0);
}
/** 선거인이 아닌 이유. 선거인이면 null. */
export function ineligibleReason(birth, base, memberOk) {
  if (ageOn(birth, base) < 18) return '만 18세 미만';
  if (!memberOk) return '무흠 입교인 아님';
  return null;
}

// ---------- 토큰, 비밀번호 ----------
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // i, l, o, 0, 1 제외
export function randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }
export const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
export const randomHex = (n) => hex(randomBytes(n));
const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function newToken() {
  const chars = [];
  while (chars.length < 16) {
    for (const x of randomBytes(32)) if (x < 248 && chars.length < 16) chars.push(ALPHABET[x % 31]);   // 248 = 31*8, 치우침 없이 고르기
  }
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}
export const normalizeToken = (t) => [...String(t).toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg))));
}
/** DB에는 토큰 원문이 아니라 이 해시(HMAC-SHA256)만 저장한다. */
export const tokenHash = (token, pepper) => hmacHex(pepper, normalizeToken(token));
export async function sha256Hex(s) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))); }

const ITER = 100000;   // Workers가 허용하는 PBKDF2 최대 반복 횟수
async function pbkdf2(password, salt, iter) {
  const k = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256));
}
export async function hashPassword(password) {
  const salt = randomBytes(16);
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITER))}`;
}
export async function verifyPassword(password, stored) {
  try {
    const [scheme, iter, saltB64, dkB64] = stored.split('$');
    if (scheme !== 'pbkdf2' || +iter > ITER) return false;
    const got = await pbkdf2(password, unb64(saltB64), +iter), want = unb64(dkB64);
    if (got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
    return diff === 0;
  } catch { return false; }
}

// ---------- 사진 ----------
/** 파일 앞부분(매직 바이트)으로 형식을 확인한다. */
export function detectImageMime(d) {
  if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'image/jpeg';
  if (d.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => d[i] === x)) return 'image/png';
  if (d.length >= 12 && String.fromCharCode(...d.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...d.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
export { b64 as toBase64, unb64 as fromBase64 };

// ---------- CSV ----------
export function readCsv(u8) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch {
    try { text = new TextDecoder('euc-kr', { fatal: true }).decode(u8); }
    catch { throw new Error('CSV 파일의 글자 인코딩을 읽지 못했습니다. UTF-8로 저장해 주세요.'); }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], cur = '', inQ = false, any = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') { inQ = true; any = true; }
    else if (ch === ',') { row.push(cur); cur = ''; any = true; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (any || cur) { row.push(cur); rows.push(row); }
      row = []; cur = ''; any = false;
    } else { cur += ch; any = true; }
  }
  if (any || cur) { row.push(cur); rows.push(row); }
  if (rows.length > MAX_ROWS + 5) throw new Error(`행이 너무 많습니다. ${MAX_ROWS}행 이하로 올려 주세요.`);
  return rows;
}

// ---------- 교적부 해석 ----------
const str = (v) => (v === null || v === undefined ? '' : String(v));
const TRUTHY = new Set(['o', 'y', 'yes', 'true', '1', 'v', '✓', '○', '◯', '예', '무흠', '해당']);
const truthy = (v) => (typeof v === 'boolean' ? v : TRUTHY.has(str(v).trim().toLowerCase()));
const findCol = (head, ...keys) => head.findIndex((h) => keys.some((k) => h.includes(k)));

/** 첫 행은 제목 행. 열 제목을 못 찾으면 앞 4개 열(직분, 이름, 생년월일, 등록일)로 읽는다.
 *  선택 열 '무흠' 또는 '입교'가 없으면 모두 '아님'으로 둔다. */
export function parseRows(rows) {
  const result = { ok: [], bad: [] };
  if (!rows.length) return result;
  const head = rows[0].map((c) => str(c).replace(/ /g, ''));
  let iRole = findCol(head, '직분', '직책'), iName = findCol(head, '이름', '성명'),
    iBirth = findCol(head, '생년월일', '생일'), iReg = findCol(head, '등록일', '등록'), iMem = findCol(head, '무흠', '입교');
  let start = 1;
  if (Math.min(iRole, iName, iBirth, iReg) < 0) {
    [iRole, iName, iBirth, iReg, iMem] = [0, 1, 2, 3, -1];
    start = toDate(rows[0][2]) ? 0 : 1;
  }
  const seen = new Set();
  for (let idx = start; idx < rows.length; idx++) {
    const r = rows[idx];
    if (r.every((c) => str(c).trim() === '')) continue;
    const role = str(r[iRole]).trim(), name = str(r[iName]).trim();
    const birth = toDate(r[iBirth]), reg = toDate(r[iReg]);
    const why = [];
    if (!name) why.push('이름 없음');
    if (!role) why.push('직분 없음');
    if (!birth) why.push('생년월일 형식 오류');
    if (!reg) why.push('등록일 형식 오류');
    if (!why.length && seen.has(name + '|' + birth)) why.push('중복');
    if (why.length) { result.bad.push({ row: idx + 1, name: name || '(이름 없음)', reason: why.join(', ') }); continue; }
    seen.add(name + '|' + birth);
    result.ok.push({ role, name, birth, reg_date: reg, member_ok: iMem >= 0 && truthy(r[iMem]) ? 1 : 0 });
  }
  return result;
}

/** 업로드된 파일 바이트를 읽는다. .csv가 아니고 zip(PK) 형식이면 엑셀로 읽는다. */
export async function parseUpload(u8, filename = '') {
  const csv = filename.toLowerCase().endsWith('.csv');
  let rows;
  if (csv) rows = readCsv(u8);
  else if (u8[0] === 0x50 && u8[1] === 0x4b) rows = await readXlsx(u8, MAX_ROWS);
  else throw new Error('엑셀(.xlsx) 또는 CSV 파일을 올려 주세요.');
  return parseRows(rows);
}
