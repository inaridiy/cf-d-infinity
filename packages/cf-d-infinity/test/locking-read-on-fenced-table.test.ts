// ロックを取る読みは、書き込み禁止の表でロックを得ない。BEGIN IMMEDIATE の取引は、全シャードが prepare を適用した後の DDL を取り消させず、
// DDL の後ろで待つ (直った。2026-11-17 までは test/open/ にあった。計画書の不変条件 16 の D1)。
//
// 不変条件: M24 の asSqlite と、M24c (specs/m24c_lock_holders.qnt) の ANY_DEP と preparedStays。DDL の結果は、DDL より前にロックを取った
// 取引の時刻だけで決まり、SQLite (busy_timeout 5 秒) と同じである。全シャードが prepare を適用したとき、表の行ロックはどこにもなかった。
// その後に始めた取引は、SQLite では DDL の書き込みのロックを待つので、DDL を失敗させない (BEGIN IMMEDIATE は、DDL が終わるのを待ってから
// 始まる)。
// 持ち主: シャードの、ロックを与える 1 つの判断 (src/shard/kernel.ts の tableGate。書いた行も、ロックを取る読みの行も、表への頼り方に
// 依らずに通る) と、Worker の取引の層 (src/client/db.ts の Txn.shardRead と Txn.lockRead。主キーの読みは、どちらの経路でも、行を読む前に
// ロックを求める)。
//
// 場面。表 x に 4 行。CREATE UNIQUE INDEX xu ON x(v) (シャードをまたぐ UNIQUE。既存の行から作る build) が、全シャードで prepare を
// 適用し、既存の行を読んでいる。その読みを 6 秒止める (行の多い表の build)。別の接続が BEGIN IMMEDIATE で、x の 1 行を主キーで読み、
// その行を書いて COMMIT する。
// 読みは、ロックを与えられずに、DDL が終わるまで待つ。取引は、まだ何も読んでいないので、DDL の後の表定義で計画し直し、どの文も通る。
// DDL は確定する。SQLite と同じ答えで、通常の経路でも、行を集める経路 (基準経路) でも同じである。
// 2026-11-17 までは、通常の経路では、読みが禁止の表でロックを取り、書き込みが禁止に当たって DDL を取り消させた。DDL は、取り消された
// ことを既存の行を読み終えてから知り、待ちの期限 (5 秒) を過ぎているのでやり直さず、競合でない誤りで失敗した。基準経路では、読みが
// ロックを取らず、DDL は確定し、取引の書き込みが、DDL の後に古い計画として断られた。結果が経路で変わった。
// 乱択の検査 test/ddl-concurrent.test.ts の 9 (test/ddl-lock-holders.ts) が、同じ欠陥を見つける。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import type { Reference } from "../src/sql/plan";
import type { Faults } from "../src/types";
import { hold } from "./ddl-harness";
import { REFERENCE_ONLY, SimCluster } from "./sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

async function scene(reference: Reference | undefined, faults: Faults = {}) {
  const c = new SimCluster({ shards: 2, faults });
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
  const result: Record<string, string | boolean> = { ...steps, ddl: await ddl, index: "xu" in (await c.catalog()).indexes };
  c.net.gate = () => undefined;
  return result;
}

const SQLITE = { begin: "ok", read: "ok", update: "ok", commit: "ok", ddl: "ok", index: true };

describe("a BEGIN IMMEDIATE transaction that reads and writes a table while a UNIQUE index is built on it", () => {
  it("waits for the build, which then commits (the default path)", async () => {
    expect(await scene(undefined)).toEqual(SQLITE);
  });
  for (const reference of ["scans", "full"] as const) {
    it(`gets the same outcome on the reference path (${reference})`, async () => {
      expect(await scene(reference)).toEqual(SQLITE);
    });
  }

  // m24c_red_reads。ロックを与える判断が、書き込みとして頼る表の行にしか、書き込み禁止を確かめない。読みは禁止の表でロックを取り、
  // 続く書き込みが、全シャードが prepare を適用した DDL を取り消させる。取引は確定し、DDL は失敗する。
  it.skipIf(REFERENCE_ONLY)("put back (lockGateWritesOnly): the read takes its lock on the fenced table, and the write withdraws the build", async () => {
    const r = await scene(undefined, { lockGateWritesOnly: true });
    expect({ read: r.read, update: r.update, commit: r.commit, index: r.index }).toEqual({ read: "ok", update: "ok", commit: "ok", index: false });
    expect(r.ddl).toMatch(/^conflict: a transaction that holds row locks on x reached the table's write lock/);
  });
});
