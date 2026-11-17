// 未解決: DDL が行ロックの持ち主を待っている間に、同じシャードの別の行を書いた取引も、DDL を待たせる。その取引がロックを持ち続けると、
// DDL は 5 秒で SQLITE_BUSY になる。行が、もう prepare を適用したシャードにあれば、その取引の書き込みは禁止に当たって待ち、DDL は
// 通る。DDL の成否が、行の置き場所で決まる (AGENTS.md の規則 4)。
//
// 不変条件: M24 の asSqlite (specs/m24_table_epochs.qnt の m24_retry)。DDL の結果は、利用者の時刻だけで決まり、置き場所に依らない。
// m24_retry の取引は 1 件で、DDL を始めた後に書いた取引の形はモデルにない (docs/design-catalog-epoch.md の「表ごとの epoch の実装の
// 結果」の「見つけて直していないもの」の 2 つ目: 行ロックを取り続ける書き手がいる表の DDL は、5 秒で SQLITE_BUSY になる。モデルにも
// 試験にもない)。SQLite でも、書き手が途切れなければ DDL は busy_timeout で失敗し、2 つの接続のどちらが先にロックを取るかは決まって
// いない。ここで確かめるのは、成否が置き場所に依らないことだけである。
// 持ち主: シャードの prepare の行ロックの待ち (src/shard/kernel.ts の applyStep。prepare は fence の表の行ロックが 1 つもない瞬間を
// 待ち、待つ間も、その表への新しい書き込みを通す)。
//
// 場面。取引 H (SQL の BEGIN) が行 a (s0) を書く。別の接続が ALTER TABLE x ADD COLUMN を始める。0.5 秒後に、取引 R (SQL の BEGIN) が
// 行 b を書く。1 秒後に H が COMMIT する。R は 3 秒後に b を読み、6 秒後に COMMIT する。b は、a と同じ s0 か、s1 にある。
// いま (5808b08): b が s0 なら、s0 は H を待っている間に R の書き込みを通し、H の COMMIT の後は R を待つ。DDL は 5 秒で SQLITE_BUSY。
// b が s1 なら、s1 はもう prepare を適用していて、R の書き込みは禁止に当たって待つ。H の COMMIT の後に DDL が確定し、R は、まだ何も
// 読み書きしていないので、DDL の後の表定義で書き直して確定する。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { tenantOn } from "../ddl-harness";
import { SimCluster } from "../sim";

const BUSY = /^(conflict|read too old|not owner|migrating|upgrading)/;
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => (BUSY.test(e.message) ? "busy" : e.message));
const UPDATE = "UPDATE x SET v = v + 1 WHERE tenant_id = ? AND id = 1";

async function writerDuringTheWait(placement: "one shard" | "two shards") {
  const c = new SimCluster({ shards: 2 });
  const admin = new Db(c);
  await admin.ddl("CREATE TABLE x(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))");
  const a = await tenantOn(c, "s0");
  const b = placement === "one shard" ? await tenantOn(c, "s0", 1) : await tenantOn(c, "s1");
  await admin.query("INSERT INTO x VALUES (?, 1, 1), (?, 1, 1)", [a, b]);
  const h = new Db(c, { retries: 0 });
  const r = new Db(c, { retries: 0 });
  await h.query("BEGIN");
  await h.query(UPDATE, [a]);
  const t0 = c.runtime.now();
  const until = async (ms: number) => {
    const left = t0 + ms - c.runtime.now();
    if (left > 0) await c.sleep(left);
  };
  const ddl = outcome(admin.ddl("ALTER TABLE x ADD COLUMN y INTEGER"));
  await until(500);
  await r.query("BEGIN");
  const rWrite = outcome(r.query(UPDATE, [b]));
  await until(1_000);
  const hCommit = await outcome(h.query("COMMIT"));
  const rWrote = await rWrite;
  await until(3_000);
  const rRead = await outcome(r.query("SELECT v FROM x WHERE tenant_id = ? AND id = 1", [b]));
  await until(6_000);
  const rCommit = await outcome(r.query("COMMIT"));
  return { hCommit, rWrote, rRead, rCommit, ddl: await ddl };
}

describe("a transaction that writes the table while a DDL waits for another transaction's row lock", () => {
  it("gets the same outcome, and the DDL gets the same outcome, wherever its row is", async () => {
    expect(await writerDuringTheWait("one shard")).toEqual(await writerDuringTheWait("two shards"));
  });
});
