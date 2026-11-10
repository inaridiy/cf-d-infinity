import { DurableObject } from "cloudflare:workers";
class Rollback extends Error {}
// 文をパースせず、trigger で行の変更を捕捉できるかを確かめる。
export class Shard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const s = ctx.storage.sql;
    s.exec(`CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, email TEXT UNIQUE, n INTEGER)`);
    s.exec(`CREATE TABLE IF NOT EXISTS __cap(seq INTEGER PRIMARY KEY, op TEXT, old TEXT, new TEXT)`);
    s.exec(`CREATE TABLE IF NOT EXISTS __cap_on(on_ INTEGER)`);
    const w = `WHEN EXISTS (SELECT 1 FROM __cap_on)`;
    s.exec(`CREATE TRIGGER IF NOT EXISTS t_i AFTER INSERT ON t ${w} BEGIN INSERT INTO __cap(op,old,new) VALUES('i',NULL,json_object('id',new.id,'email',new.email,'n',new.n)); END`);
    s.exec(`CREATE TRIGGER IF NOT EXISTS t_u AFTER UPDATE ON t ${w} BEGIN INSERT INTO __cap(op,old,new) VALUES('u',json_object('id',old.id,'email',old.email,'n',old.n),json_object('id',new.id,'email',new.email,'n',new.n)); END`);
    s.exec(`CREATE TRIGGER IF NOT EXISTS t_d AFTER DELETE ON t ${w} BEGIN INSERT INTO __cap(op,old,new) VALUES('d',json_object('id',old.id,'email',old.email,'n',old.n),NULL); END`);
  }
  run() {
    const s = this.ctx.storage.sql, out = {};
    s.exec(`DELETE FROM t`);
    s.exec(`INSERT INTO t VALUES(1,'a',1),(2,'b',2)`);
    const capture = (sql, ...p) => {
      let cap, written = 0;
      try {
        this.ctx.storage.transactionSync(() => {
          s.exec(`INSERT INTO __cap_on VALUES(1)`);
          const c = s.exec(sql, ...p); c.toArray(); written = c.rowsWritten;
          cap = s.exec(`SELECT op, old, new FROM __cap ORDER BY seq`).toArray();
          throw new Rollback();
        });
      } catch (e) { if (!(e instanceof Rollback)) throw e; }
      return { cap, written };
    };
    out.upsert = capture(`INSERT INTO t VALUES(1,'a',1) ON CONFLICT(id) DO UPDATE SET n = n + 10`);
    out.insertSelect = capture(`INSERT INTO t(id,email,n) SELECT id + 10, email || '2', n FROM t`);
    out.replace = capture(`INSERT OR REPLACE INTO t VALUES(3,'a',9)`);
    out.updateFrom = capture(`UPDATE t SET n = x.m FROM (SELECT max(n) m FROM t) x WHERE id = 1`);
    out.deleteWhere = capture(`DELETE FROM t WHERE n > 1`);
    out.after = s.exec(`SELECT count(*) c, sum(n) s FROM t`).one();
    out.capLeft = s.exec(`SELECT count(*) c FROM __cap`).one();
    // 通常の書き込みでは trigger が __cap に書かないことを確認する
    const plain = s.exec(`UPDATE t SET n = 5 WHERE id = 1`); plain.toArray();
    out.plainWritten = plain.rowsWritten;
    out.capAfterPlain = s.exec(`SELECT count(*) c FROM __cap`).one();
    return out;
  }
}
export default { async fetch(req, env) { return Response.json(await env.SHARD.get(env.SHARD.idFromName("a")).run()); } };
