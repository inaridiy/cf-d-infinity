// 未解決: 行ロックを失った取引の COMMIT が、表の書き込み禁止に当たると、取引が SQLITE_BUSY で失敗する。
//
// 約束 (docs/design-catalog-epoch.md の「表ごとの epoch」の「シャード」と「Worker」)。X の行のロックを別のシャードに持つ取引の書き込みか
// COMMIT が、X の書き込み禁止に当たったら、シャードは、断るときに、その行のロックを取引に与え、Worker は、DDL を取り消させて、
// やり直す。取引は失敗しない。
// 実装したのは、書き込みの文が当たる形だけである (test/ddl-waits-for-row-locks.test.ts)。COMMIT が当たる形は、モデルにない
// (M24 の「確かめていないこと」: m24_retry の HOLD は、x2 の書き込みが当たる形だけを持つ)。規則 3 により、モデルを先に書く。
// COMMIT をやり直すには、2PC の ID を取り直し、断られた試みが参加者に置いた intent と、放したロックの扱いを決めなければならない。
//
// ロックを持つシャードでは、prepare がロックを待つので、ロックが生きている取引の COMMIT は、書き込み禁止に当たらない
// (test/ddl-waits-for-row-locks.test.ts の「does not refuse the COMMIT …」)。当たるのは、ロックを故障で失ったときである。ここでは、
// 取引が行を書いたシャードが再起動して、メモリのロックが消える。
//
// 場面。取引が x1 (s0) と x2 (s1) を書く。s0 が再起動する。別の接続が x に列を足す。s0 は、ロックがないので prepare を適用し、s1 は、
// 取引のロックを待つ。取引が COMMIT する。s0 は、取引の x1 の書き込みを、書き込み禁止で断る。
// SQLite では、書いた取引の COMMIT は、ほかの接続の DDL では失敗しない (DDL のほうが待つ)。別の接続は x1 を書いていない。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { tenantOn } from "../ddl-harness";
import { SimCluster } from "../sim";

const BUSY = /^(conflict|read too old|not owner|migrating|upgrading)/;
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => (BUSY.test(e.message) ? `busy (${e.message.slice(0, 80)})` : e.message));

describe("a transaction that lost a row lock to a shard restart", () => {
  it("still commits while a DDL on its table waits for its other lock", async () => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE x(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))");
    const A = await tenantOn(c, "s0");
    const B = await tenantOn(c, "s1");
    await new Db(c).query("INSERT INTO x VALUES (?, 1, 1)", [A]);
    await new Db(c).query("INSERT INTO x VALUES (?, 1, 1)", [B]);
    const tx = new Db(c, { retries: 0 });
    await tx.query("BEGIN");
    await tx.query("UPDATE x SET v = v + 1 WHERE tenant_id = ? AND id = 1", [A]);
    await tx.query("UPDATE x SET v = v + 1 WHERE tenant_id = ? AND id = 1", [B]);
    c.restart("s0");
    const ddl = outcome(new Db(c).ddl("ALTER TABLE x ADD COLUMN y INTEGER"));
    await c.sleep(1000);
    expect(await outcome(tx.query("COMMIT"))).toBe("ok");
    expect(await ddl).toBe("ok");
  });
});
