// 未解決: ロックを取る読みが、書き込み禁止の表で通る。BEGIN IMMEDIATE の取引が、全シャードが prepare を適用した後の DDL を取り消させ、
// DDL は busy でない誤りで失敗する。
//
// 不変条件: M24 の asSqlite (specs/m24_table_epochs.qnt の m24_retry)。DDL の結果は、利用者の時刻だけで決まり、SQLite (busy_timeout
// 5 秒) と同じである。全シャードが prepare を適用したとき、表の行ロックはどこにもなかった。その後に始めた取引は、SQLite では DDL の
// 書き込みのロックを待つので、DDL を失敗させない (BEGIN IMMEDIATE は、DDL が終わるのを待ってから始まる)。失敗するとしても、DDL は
// busy の類の誤り (conflict) だけで失敗する。
// 持ち主: シャードの、ロックを取る読みの入口 (src/shard/kernel.ts の lockedStep。lockRows の書き込み禁止の確かめは、書き込みとして頼る
// 表 (Dep.write) の行にしか当たらない) と、Worker の取引の層 (src/client/db.ts の Txn.shardRead は、通常の経路でだけ lockRows を付ける。
// attemptStatement は、ロックを持つ取引の書き込みが禁止に当たると、DDL を取り消させる (M24 の WOUND))。
//
// 場面。表 x に 4 行。CREATE UNIQUE INDEX xu ON x(v) (シャードをまたぐ UNIQUE。既存の行から作る build) が、全シャードで prepare を
// 適用し、既存の行を読んでいる。その読みを 6 秒止める (行の多い表の build)。別の接続が BEGIN IMMEDIATE で、x の 1 行を主キーで読み、
// その行を書いて COMMIT する。
// いま (5808b08): 通常の経路では、読みは禁止の表でロックを取り、書き込みは禁止に当たって DDL を取り消させ、取引は確定する。DDL は、
// 取り消されたことを既存の行を読み終えてから知り、待ちの期限 (5 秒) を過ぎているのでやり直さず、取り消しの理由の文 (conflict でない)
// で失敗する。基準経路では、読みはロックを取らないので、DDL は確定し、取引の書き込みが、DDL の後に古い計画として断られる (SQLITE_BUSY)。
// 結果が経路で変わる。
// SQLite では、BEGIN IMMEDIATE の取引は DDL を待ち、DDL も取引も通る。ここでは、その答えを、どちらの経路でも期待する。直し方は
// 決めていない (読みも、書き込みが TableLocked で待つように禁止の解けるのを待てば、取引はまだ何も読んでいないので、DDL の後の表定義で
// 計画し直せる。基準経路では、読みがロックを取らないことも直す必要がある)。
// 乱択の検査 test/ddl-concurrent.test.ts の 9 (test/ddl-lock-holders.ts の D1) が、同じ欠陥を見つける。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import type { Reference } from "../../src/sql/plan";
import { hold } from "../ddl-harness";
import { SimCluster } from "../sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

async function scene(reference: Reference | undefined) {
  const c = new SimCluster({ shards: 2 });
  const admin = new Db(c);
  await admin.ddl("CREATE TABLE x(id INTEGER PRIMARY KEY, v INTEGER NOT NULL, w INTEGER NOT NULL DEFAULT 0)");
  await admin.query("INSERT INTO x(id, v) VALUES (1, 10), (2, 20), (3, 30), (4, 40)");
  // 既存の行を読む build の要求 (Db.scanForIndex)。取引の読みには LIMIT がない。
  const scan = hold(c, "gate", (m) => m.from === "client" && m.method === "exec" && /FROM "x" .*ORDER BY .* LIMIT \d+$/.test((m.req as { sql?: string }).sql ?? ""));
  const ddl = outcome(admin.ddl("CREATE UNIQUE INDEX xu ON x(v)"));
  await scan.reached;
  const tx = new Db(c, { retries: 0, ...(reference ? { reference } : {}) });
  const steps: Record<string, string> = {};
  const txn = (async () => {
    steps.begin = await outcome(tx.query("BEGIN IMMEDIATE"));
    steps.read = await outcome(tx.query("SELECT v, w FROM x WHERE id = 1"));
    steps.update = await outcome(tx.query("UPDATE x SET w = w + 1 WHERE id = 1"));
    if (steps.update === "ok") steps.commit = await outcome(tx.query("COMMIT"));
    else await tx.query("ROLLBACK").catch(() => undefined);
  })();
  await c.sleep(6_000);
  scan.release();
  await txn;
  const result = { ...steps, ddl: await ddl, index: "xu" in (await c.catalog()).indexes };
  c.net.gate = () => undefined;
  return result;
}

const SQLITE = { begin: "ok", read: "ok", update: "ok", commit: "ok", ddl: "ok", index: true };

describe("a BEGIN IMMEDIATE transaction that reads and writes a table while a UNIQUE index is built on it", () => {
  it("waits for the build, which then commits (the default path)", async () => {
    expect(await scene(undefined)).toEqual(SQLITE);
  });
  it("gets the same outcome on the reference path", async () => {
    expect(await scene("scans")).toEqual(SQLITE);
  });
});
