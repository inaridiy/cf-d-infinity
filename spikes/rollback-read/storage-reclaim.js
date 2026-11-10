import { DurableObject } from "cloudflare:workers";
// split で親の行を消したあと、ファイルサイズが戻るかを確かめる。
export class Shard extends DurableObject {
  run() {
    const s = this.ctx.storage.sql, out = {};
    const size = () => s.databaseSize;
    const tryExec = (q) => { try { return s.exec(q).toArray(); } catch (e) { return "ERR " + e.message; } };
    s.exec(`CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)`);
    out.empty = size();
    const blob = "x".repeat(1000);
    this.ctx.storage.transactionSync(() => { for (let i = 0; i < 20000; i++) s.exec(`INSERT INTO t VALUES(?,?)`, i, blob); });
    out.after20kRows = size();
    out.autoVacuum = tryExec(`PRAGMA auto_vacuum`);
    out.pageSize = tryExec(`PRAGMA page_size`);
    out.pageCount = tryExec(`PRAGMA page_count`);
    const del = s.exec(`DELETE FROM t WHERE id >= 10000`); del.toArray();
    out.deletedRowsWritten = del.rowsWritten;
    out.afterDeleteHalf = size();
    out.freelist = tryExec(`PRAGMA freelist_count`);
    out.vacuum = tryExec(`VACUUM`);
    out.incremental = tryExec(`PRAGMA incremental_vacuum`);
    out.afterVacuumTries = size();
    this.ctx.storage.transactionSync(() => { for (let i = 20000; i < 25000; i++) s.exec(`INSERT INTO t VALUES(?,?)`, i, blob); });
    out.afterReuse5k = size();
    // 表を丸ごと捨てた場合
    const drop = s.exec(`DROP TABLE t`); drop.toArray();
    out.dropRowsWritten = drop.rowsWritten;
    out.afterDrop = size();
    return out;
  }
  async wipe() {
    await this.ctx.storage.deleteAll();
    return this.ctx.storage.sql.databaseSize;
  }
}
export default { async fetch(req, env) { const s = env.SHARD.get(env.SHARD.idFromName("a")); return Response.json({ run: await s.run(), afterDeleteAll: await s.wipe() }); } };
