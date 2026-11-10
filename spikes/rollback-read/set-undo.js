import { DurableObject } from "cloudflare:workers";
class Rollback extends Error {}
export class Shard extends DurableObject {
  constructor(ctx, env) { super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, email TEXT UNIQUE, n INTEGER, __ver INTEGER)`);
    ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS t_n ON t(n)`);
  }
  run() {
    const sql = this.ctx.storage.sql, out = {};
    sql.exec(`DELETE FROM t`);
    sql.exec(`INSERT INTO t VALUES(1,'x',10,1),(2,'y',20,1),(3,'z',30,1)`);
    const stateAtT = sql.exec(`SELECT id,email,n FROM t ORDER BY id`).toArray();
    // forward commit c1 > T: swap a<->b through tmp; delete id=3; insert id=4 taking z
    this.ctx.storage.transactionSync(() => {
      sql.exec(`UPDATE t SET email='tmp' WHERE id=1`);
      sql.exec(`UPDATE t SET email='x' WHERE id=2`);
      sql.exec(`UPDATE t SET email='y',__ver=2 WHERE id=1`);
      sql.exec(`DELETE FROM t WHERE id=3`);
      sql.exec(`INSERT INTO t VALUES(4,'z',40,2)`);
    });
    out.current = sql.exec(`SELECT id,email,n FROM t ORDER BY id`).toArray();
    // net before-images per pk (null = did not exist at T)
    const delta = [[1,['x',10,1]],[2,['y',20,1]],[3,['z',30,1]],[4,null]];
    let snap, written = 0;
    try {
      this.ctx.storage.transactionSync(() => {
        for (const [id] of delta) { const c = sql.exec(`DELETE FROM t WHERE id=?`, id); c.toArray(); written += c.rowsWritten; }
        for (const [id, b] of delta) if (b) { const c = sql.exec(`INSERT INTO t VALUES(?,?,?,?)`, id, ...b); c.toArray(); written += c.rowsWritten; }
        snap = sql.exec(`SELECT id,email,n FROM t ORDER BY id`).toArray();
        throw new Rollback();
      });
    } catch (e) { if (!(e instanceof Rollback)) throw e; }
    out.reconstructedEqualsT = JSON.stringify(snap) === JSON.stringify(stateAtT);
    out.snap = snap; out.rolledBackRowsWritten = written;
    out.afterRollback = sql.exec(`SELECT id,email,n FROM t ORDER BY id`).toArray();
    return out;
  }
}
export default { async fetch(req, env) { return Response.json(await env.SHARD.get(env.SHARD.idFromName("a")).run()); } };
