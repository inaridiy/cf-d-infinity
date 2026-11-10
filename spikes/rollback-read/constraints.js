import { DurableObject } from "cloudflare:workers";

class Rollback extends Error {}

export class Shard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, email TEXT UNIQUE, n INTEGER, __ver INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS parent(id INTEGER PRIMARY KEY)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS child(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))`);
  }
  run() {
    const sql = this.ctx.storage.sql;
    const out = {};
    sql.exec(`DELETE FROM t`);
    for (let i = 1; i <= 5; i++) sql.exec(`INSERT INTO t VALUES(?,?,?,1)`, i, `u${i}@x`, i * 10);

    // 1. basic rollback-read: undo one update, aggregate, roll back
    const snap = (undo) => {
      let rows, written = 0;
      try {
        this.ctx.storage.transactionSync(() => {
          for (const [q, ...b] of undo) { const c = sql.exec(q, ...b); c.toArray(); written += c.rowsWritten; }
          rows = sql.exec(`SELECT sum(n) s, count(*) c FROM t`).toArray();
          throw new Rollback();
        });
      } catch (e) { if (!(e instanceof Rollback)) throw e; }
      return { rows, written };
    };
    out.before = sql.exec(`SELECT sum(n) s, count(*) c FROM t`).toArray();
    out.rollbackRead = snap([[`UPDATE t SET n=999 WHERE id=1`], [`DELETE FROM t WHERE id=2`], [`INSERT INTO t VALUES(6,'u6@x',60,2)`]]);
    out.after = sql.exec(`SELECT sum(n) s, count(*) c FROM t`).toArray();

    // 2. UNIQUE swap: commit A moved email u1->tmp, commit B gave u1 to id=2. Undo in wrong vs right order
    sql.exec(`UPDATE t SET email='moved@x' WHERE id=1`);
    sql.exec(`UPDATE t SET email='u1@x' WHERE id=2`);
    const tryUndo = (steps) => { try { return snap(steps); } catch (e) { return { error: String(e.message) }; } };
    out.undoAscWrongOrder = tryUndo([[`UPDATE t SET email='u1@x' WHERE id=1`], [`UPDATE t SET email='u2@x' WHERE id=2`]]);
    out.undoDescRightOrder = tryUndo([[`UPDATE t SET email='u2@x' WHERE id=2`], [`UPDATE t SET email='u1@x' WHERE id=1`]]);

    // 3. true swap within one txn: id1<->id2 emails. Row-at-a-time undo cannot satisfy immediate UNIQUE
    sql.exec(`UPDATE t SET email='a@x' WHERE id=3`);
    sql.exec(`UPDATE t SET email='b@x' WHERE id=4`);
    out.swapUndoNaive = tryUndo([[`UPDATE t SET email='b@x' WHERE id=3`], [`UPDATE t SET email='a@x' WHERE id=4`]]);
    // whole-statement swap passes? SQLite checks per row
    out.swapSingleStmt = tryUndo([[`UPDATE t SET email=CASE id WHEN 3 THEN 'b@x' WHEN 4 THEN 'a@x' END WHERE id IN (3,4)`]]);
    // ignore_check_constraints / defer_foreign_keys availability
    for (const p of [`PRAGMA defer_foreign_keys=ON`, `PRAGMA foreign_keys`, `PRAGMA ignore_check_constraints=ON`, `PRAGMA writable_schema=ON`, `PRAGMA recursive_triggers`]) {
      try { out[p] = sql.exec(p).toArray(); } catch (e) { out[p] = "ERR " + e.message; }
    }

    // 4. FK: undo that re-inserts child before parent
    sql.exec(`DELETE FROM child`); sql.exec(`DELETE FROM parent`);
    out.fkOrderChildFirst = (() => {
      try {
        let r;
        try {
          this.ctx.storage.transactionSync(() => {
            sql.exec(`INSERT INTO child VALUES(1, 42)`);
            sql.exec(`INSERT INTO parent VALUES(42)`);
            r = "ok";
            throw new Rollback();
          });
        } catch (e) { if (!(e instanceof Rollback)) throw e; }
        return r;
      } catch (e) { return "ERR " + e.message; }
    })();

    // 5. DDL inside rollback-read; temp tables
    try { sql.exec(`CREATE TEMP TABLE x(a)`); out.temp = "ok"; } catch (e) { out.temp = "ERR " + e.message; }

    // 6. Large delta timing is impossible here (Date.now frozen) but report row counters
    const big = sql.exec(`SELECT count(*) c FROM t`).one();
    out.finalCount = big;
    out.dbSize = sql.databaseSize;
    return out;
  }
  // rollback does not leak across an await: does a nested read see rolled-back state?
  async interleave() {
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM t`);
    sql.exec(`INSERT INTO t VALUES(1,'a',1,1)`);
    let seen;
    try {
      this.ctx.storage.transactionSync(() => {
        sql.exec(`UPDATE t SET n=2`);
        seen = sql.exec(`SELECT n FROM t`).one().n;
        throw new Rollback();
      });
    } catch (e) { if (!(e instanceof Rollback)) throw e; }
    await this.ctx.storage.sync();
    return { seenInside: seen, afterSync: sql.exec(`SELECT n FROM t`).one().n };
  }
}

export default {
  async fetch(req, env) {
    const s = env.SHARD.get(env.SHARD.idFromName("a"));
    return Response.json({ run: await s.run(), interleave: await s.interleave() });
  },
};
