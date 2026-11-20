-- 교회 선출투표 (Cloudflare D1 / SQLite)
CREATE TABLE admin_user (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('chair','desk')), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE admin_session (
  token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL);
CREATE TABLE election (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, base_date TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'setup' CHECK (phase IN ('setup','open','closed')),
  roster_locked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE person (
  id INTEGER PRIMARY KEY, election_id INTEGER NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  role TEXT NOT NULL, name TEXT NOT NULL, birth TEXT NOT NULL, reg_date TEXT NOT NULL,
  member_ok INTEGER NOT NULL DEFAULT 0, UNIQUE (election_id, name, birth));
CREATE TABLE roll (
  election_id INTEGER NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE, PRIMARY KEY (election_id, person_id));
CREATE TABLE race (
  id INTEGER PRIMARY KEY, election_id INTEGER NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  name TEXT NOT NULL, rule TEXT NOT NULL CHECK (rule IN ('half','twothirds')), sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE candidate (
  id INTEGER PRIMARY KEY, race_id INTEGER NOT NULL REFERENCES race(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE, UNIQUE (race_id, person_id));
-- 사진은 base64 글자로 저장한다(D1의 BLOB 처리 차이를 피하기 위함).
CREATE TABLE person_photo (
  person_id INTEGER PRIMARY KEY REFERENCES person(id) ON DELETE CASCADE,
  mime TEXT NOT NULL, data_b64 TEXT NOT NULL, updated_at TEXT NOT NULL);
-- ticket(누가 투표했는지)과 ballot(무엇을 선택했는지) 사이에는 어떤 참조 키도 두지 않는다.
CREATE TABLE ticket (
  id INTEGER PRIMARY KEY, election_id INTEGER NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','used','revoked')),
  issued_by INTEGER REFERENCES admin_user(id), issued_at TEXT NOT NULL, used_at TEXT);
CREATE UNIQUE INDEX ticket_one_live ON ticket (election_id, person_id) WHERE status IN ('issued','used');
-- 투표함 두 테이블은 WITHOUT ROWID + 무작위 ID: 저장 순서로 투표 순서를 알 수 없다.
CREATE TABLE ballot (id TEXT PRIMARY KEY, election_id INTEGER NOT NULL REFERENCES election(id) ON DELETE CASCADE) WITHOUT ROWID;
CREATE TABLE ballot_item (
  ballot_id TEXT NOT NULL REFERENCES ballot(id) ON DELETE CASCADE,
  candidate_id INTEGER NOT NULL REFERENCES candidate(id) ON DELETE RESTRICT,
  choice TEXT NOT NULL CHECK (choice IN ('Y','N')), PRIMARY KEY (ballot_id, candidate_id)) WITHOUT ROWID;
CREATE INDEX ballot_item_candidate ON ballot_item (candidate_id);
-- 오프라인(종이) 투표: 참여 확인과 후보별 집계 합계만 저장한다. 개인별 선택은 없다.
CREATE TABLE offline_voter (
  election_id INTEGER NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  checked_by INTEGER REFERENCES admin_user(id), checked_at TEXT NOT NULL, PRIMARY KEY (election_id, person_id));
CREATE TABLE offline_tally (
  election_id INTEGER PRIMARY KEY REFERENCES election(id) ON DELETE CASCADE,
  ballots INTEGER NOT NULL, invalid INTEGER NOT NULL DEFAULT 0, entered_by INTEGER REFERENCES admin_user(id), entered_at TEXT NOT NULL);
CREATE TABLE offline_count (
  election_id INTEGER NOT NULL REFERENCES election(id) ON DELETE CASCADE,
  candidate_id INTEGER NOT NULL REFERENCES candidate(id) ON DELETE CASCADE,
  yes INTEGER NOT NULL, no INTEGER NOT NULL, PRIMARY KEY (election_id, candidate_id));
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, admin_id INTEGER, election_id INTEGER,
  action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
-- 실패 횟수 제한(Worker는 여러 곳에서 동시에 실행되므로 DB에 기록한다)
CREATE TABLE rate_hit (id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX rate_hit_key ON rate_hit (bucket, key, at);
