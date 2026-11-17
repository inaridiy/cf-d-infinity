// 未解決: 一意でない CREATE INDEX と DROP INDEX は、表の行ロックを持つ取引を待たない。取引の次の書き込みと COMMIT が SQLITE_BUSY になる。
//
// 不変条件: M24 の holderSurvives (行を書いた取引は、DDL のために断られない) と asSqlite (DDL は、ロックを持つ取引の終わりを待つ。
// specs/m24_table_epochs.qnt の m24_lock と m24_retry)。docs/sql-language.md の「取引の中の DDL」は「取引が表の行を書いて行ロックを
// 持っている間は、その表の DDL のほうが待つ」と約束する。SQLite でも、書いた取引が書き込みのロックを持つ間、DDL は busy_timeout まで
// 待つ。
// 持ち主: DDL の解釈 (src/sql/ddl.ts の createIndex の一意でない index と、dropIndex。どちらも fence が空で、書き込みを止めない) と、
// シャードの prepare の行ロックの待ち (src/shard/kernel.ts の applyStep。prepare は fence の表の行ロックだけを待つので、fence が空なら
// 待たない)。
// DDL は、prepare の後すぐに確定し、表の書き込みの epoch を進める (docs/design-catalog-epoch.md の「表ごとの epoch」の規則)。
//
// 場面。表 x の行 x1 (s0) と x2 (s1)。取引 (SQL の BEGIN) が x1 を書く。別の接続が、x の index の DDL を始める。1 秒後に取引が x2 を書き、
// 2 秒後に COMMIT する。ALTER TABLE x ADD COLUMN なら、DDL は取引の COMMIT を待って確定し、取引はどの文も通る
// (test/ddl-waits-for-row-locks.test.ts の commitsInTime)。
// いま (5808b08): DDL はすぐに確定し、取引の x2 の書き込みと COMMIT が、古い表定義の計画として `stale schema` で断られる。
// 乱択の検査 test/ddl-concurrent.test.ts の 9 (test/ddl-lock-holders.ts の D2) が、同じ欠陥を見つける。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { tenantOn } from "../ddl-harness";
import { SimCluster } from "../sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const UPDATE = "UPDATE x SET v = v + 1 WHERE tenant_id = ? AND id = 1";

async function holderAcross(ddlSql: string, setup: string[]) {
  const c = new SimCluster({ shards: 2 });
  const admin = new Db(c);
  await admin.ddl("CREATE TABLE x(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))");
  for (const sql of setup) await admin.ddl(sql);
  const A = await tenantOn(c, "s0");
  const B = await tenantOn(c, "s1");
  await admin.query("INSERT INTO x VALUES (?, 1, 1), (?, 1, 2)", [A, B]);
  const tx = new Db(c, { retries: 0 });
  await tx.query("BEGIN");
  await tx.query(UPDATE, [A]);
  const t0 = c.runtime.now();
  let ddlMs = -1;
  const ddl = outcome(admin.ddl(ddlSql)).then((r) => ((ddlMs = c.runtime.now() - t0), r));
  await c.sleep(1_000);
  const second = await outcome(tx.query(UPDATE, [B]));
  await c.sleep(1_000);
  const commit = await outcome(tx.query("COMMIT"));
  return { second, commit, ddl: await ddl, ddlAfterCommit: ddlMs >= 1_900 };
}

const SQLITE = { second: "ok", commit: "ok", ddl: "ok", ddlAfterCommit: true };

describe("an index DDL on a table whose rows an open transaction wrote", () => {
  it("CREATE INDEX (not UNIQUE) waits for the transaction, which commits", async () => {
    expect(await holderAcross("CREATE INDEX xi ON x(v)", [])).toEqual(SQLITE);
  });
  it("DROP INDEX of an index on every shard waits for the transaction, which commits", async () => {
    expect(await holderAcross("DROP INDEX xi0", ["CREATE INDEX xi0 ON x(v)"])).toEqual(SQLITE);
  });
  it("DROP INDEX of a UNIQUE index across shards waits for the transaction, which commits", async () => {
    expect(await holderAcross("DROP INDEX xu0", ["CREATE UNIQUE INDEX xu0 ON x(v)"])).toEqual(SQLITE);
  });
});
