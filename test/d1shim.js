// Cloudflare D1와 같은 모양(prepare/bind/all/run/batch)으로 node:sqlite를 감싼 시험용 도구.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function makeD1(migrationPath) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(migrationPath).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(migrationPath + '/' + f, 'utf8'));
  const isSelect = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql);
  const exec = (sql, args) => {
    const st = db.prepare(sql);
    if (isSelect(sql)) return { success: true, results: st.all(...args).map((r) => ({ ...r })), meta: { changes: 0 } };
    const r = st.run(...args);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  class Stmt {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...a) { this.args = a.map((x) => (x === undefined ? null : x)); return this; }
    async all() { return exec(this.sql, this.args); }
    async run() { return exec(this.sql, this.args); }
    async first() { return exec(this.sql, this.args).results[0] ?? null; }
  }
  return {
    raw: db,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => exec(s.sql, s.args));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error('D1_ERROR: ' + e.message);
      }
    },
  };
}
