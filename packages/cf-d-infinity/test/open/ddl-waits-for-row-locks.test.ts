// 表の行を書いて行ロックを持つ取引と、その表の DDL (docs/design-catalog-epoch.md の「触った表の DDL と SQLite」、実装の一覧の 9 と 10、
// モデル M24 の m24_lock と m24_retry)。
//
// 約束 (docs/sql-language.md の「取引の中の DDL」)。SQLite で、書いた取引が書き込みのロックを持つ間、ほかの接続の DDL が busy_timeout
// (5 秒) まで待つのと同じである。
//   - 取引が表の行を書いて行ロックを持っている間は、その表の DDL のほうが待つ。待つのは、DDL を始めてから 5 秒までである。
//   - 取引がそのうちに確定するか取り消せば、DDL は通る。5 秒を過ぎても取引がロックを持っていれば、DDL が SQLITE_BUSY で失敗する。
//   - 取引の、その後の文と COMMIT は、DDL を待たない。取引の行がどのシャードにあっても、結果は同じである (AGENTS.md の規則 4)。
// 行を 1 つのシャードに置いた場面と、2 つのシャードに置いた場面を並べる。2 つのシャードでは、取引の 2 つ目の書き込みが、もう prepare を
// 適用したシャードの書き込み禁止に当たる。取引は、DDL を取り消させ (WOUND)、断ったシャードから、その行のロックを受け取る (HOLD)。
// DDL を進める側は、同じ 5 秒の中で、新しい epoch の prepare でやり直す (RETRY、KEEP_BUDGET、FRESH_EPOCH)。
// 欠陥のスイッチを渡すと、同じ場面が、モデルの赤の再生になる。
import { describe, expect, it } from "vitest";
import { Db, type ClientFaults } from "../../src/client/db";
import type { Faults } from "../../src/types";
import { tenantOn } from "../ddl-harness";
import { SimCluster } from "../sim";

const BUSY = /^(conflict|read too old|not owner|migrating|upgrading)/;
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => (BUSY.test(e.message) ? "busy" : e.message));

export type Placement = "one shard" | "two shards";
export const PLACEMENTS: Placement[] = ["one shard", "two shards"];
export interface Switches { faults?: Faults; clientFaults?: ClientFaults }

/** 表 x の行 x1 (tenant A) と x2 (tenant B)。x1 は s0 に、x2 は、同じ s0 か、s1 に置く。 */
export async function scene(placement: Placement, o: Switches = {}, create = "CREATE TABLE x(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))") {
  const c = new SimCluster({ shards: 2, faults: o.faults, clientFaults: o.clientFaults });
  const db = new Db(c);
  await db.ddl(create);
  const A = await tenantOn(c, "s0");
  const B = placement === "one shard" ? await tenantOn(c, "s0", 1) : await tenantOn(c, "s1");
  await db.query("INSERT INTO x (tenant_id, id, v) VALUES (?, 1, 1)", [A]);
  await db.query("INSERT INTO x (tenant_id, id, v) VALUES (?, 1, 1)", [B]);
  const t0 = c.runtime.now();
  /** 始めてからの時間と、終わったときの結果を覚える。 */
  const timed = (p: Promise<unknown>) => {
    const started = c.runtime.now();
    const r = { outcome: undefined as string | undefined, ms: -1 };
    const done = outcome(p).then((x) => {
      r.outcome = x;
      r.ms = c.runtime.now() - started;
      return r;
    });
    return { r, done };
  };
  /** 場面の始まりから ms 経つまで待つ。 */
  const until = async (ms: number) => {
    const left = t0 + ms - c.runtime.now();
    if (left > 0) await c.sleep(left);
  };
  const value = async (tenant: number) => (await new Db(c).query("SELECT v FROM x WHERE tenant_id = ? AND id = 1", [tenant])).rows[0]?.v;
  const columns = async () => (await c.catalog()).tables.x!.columns;
  return { c, A, B, timed, until, value, columns };
}

const UPDATE = "UPDATE x SET v = v + 1 WHERE tenant_id = ? AND id = 1";
const ALTER = "ALTER TABLE x ADD COLUMN y INTEGER";

/**
 * 取引が x1 を書き、DDL が始まり、1 秒後に取引が x2 を書き、2 秒後に COMMIT する。DDL は、取引の COMMIT の後で確定する。
 * 取引の 2 つ目の書き込みと COMMIT は、DDL を待たない。
 */
export async function commitsInTime(placement: Placement, o: Switches = {}) {
  const s = await scene(placement, o);
  const tx = new Db(s.c, { retries: 0, faults: o.clientFaults });
  await tx.query("BEGIN");
  await tx.query(UPDATE, [s.A]);
  const ddl = s.timed(new Db(s.c, { faults: o.clientFaults }).ddl(ALTER));
  await s.until(1000);
  const second = s.timed(tx.query(UPDATE, [s.B]));
  await s.until(2000);
  const commit = s.timed(tx.query("COMMIT"));
  await Promise.all([second.done, commit.done, ddl.done]);
  return {
    second: second.r.outcome, secondWaited: second.r.ms >= 900, commit: commit.r.outcome, commitWaited: commit.r.ms >= 900,
    ddl: ddl.r.outcome, ddlAfterCommit: ddl.r.ms >= 1900, ddlWithin5s: ddl.r.ms < 5000,
    columns: await s.columns(), A: await s.value(s.A), B: await s.value(s.B),
  };
}
export const COMMITS_IN_TIME = {
  second: "ok", secondWaited: false, commit: "ok", commitWaited: false, ddl: "ok", ddlAfterCommit: true, ddlWithin5s: true,
  columns: ["tenant_id", "id", "v", "y"], A: 2, B: 2,
};

/**
 * 取引が x1 を書き、DDL が始まり、取引は 1 秒後と 3 秒後に x2 を書いて、6 秒後に COMMIT する。DDL は、始めてから 5 秒で (それより前でなく)
 * SQLITE_BUSY になる。取引は断られない。
 */
export async function holdsPastDeadline(placement: Placement, o: Switches = {}) {
  const s = await scene(placement, o);
  const tx = new Db(s.c, { retries: 0, faults: o.clientFaults });
  await tx.query("BEGIN");
  await tx.query(UPDATE, [s.A]);
  const ddl = s.timed(new Db(s.c, { faults: o.clientFaults }).ddl(ALTER));
  await s.until(1000);
  const second = s.timed(tx.query(UPDATE, [s.B]));
  await s.until(3000);
  const third = s.timed(tx.query(UPDATE, [s.B]));
  await s.until(6000);
  const commit = await outcome(tx.query("COMMIT"));
  await Promise.all([second.done, third.done, ddl.done]);
  return {
    second: second.r.outcome, secondWaited: second.r.ms >= 900, third: third.r.outcome, commit,
    ddl: ddl.r.outcome, ddlAt5s: ddl.r.ms >= 4900 && ddl.r.ms < 5600,
    columns: await s.columns(), A: await s.value(s.A), B: await s.value(s.B),
  };
}
export const HOLDS_PAST_DEADLINE = {
  second: "ok", secondWaited: false, third: "ok", commit: "ok", ddl: "busy", ddlAt5s: true,
  columns: ["tenant_id", "id", "v"], A: 2, B: 3,
};

/**
 * 取引が x1 を書き、DDL が始まり、取引が x2 を書いて (2 つのシャードでは、書き込み禁止に当たって DDL を取り消させ、断ったシャードから
 * ロックを受け取る)、1 秒後に ROLLBACK する。やり直しの DDL は、ROLLBACK の後すぐに確定する (断ったシャードのロックも ROLLBACK が放す)。
 */
export async function rollsBack(placement: Placement, o: Switches = {}) {
  const s = await scene(placement, o);
  const tx = new Db(s.c, { retries: 0, faults: o.clientFaults });
  await tx.query("BEGIN");
  await tx.query(UPDATE, [s.A]);
  const ddl = s.timed(new Db(s.c, { faults: o.clientFaults }).ddl(ALTER));
  await s.until(500);
  const second = await outcome(tx.query(UPDATE, [s.B]));
  await s.until(1000);
  const rollback = await outcome(tx.query("ROLLBACK"));
  await ddl.done;
  return { second, rollback, ddl: ddl.r.outcome, ddlSoonAfterRollback: ddl.r.ms >= 900 && ddl.r.ms < 2000, columns: await s.columns(), A: await s.value(s.A), B: await s.value(s.B) };
}
export const ROLLS_BACK = { second: "ok", rollback: "ok", ddl: "ok", ddlSoonAfterRollback: true, columns: ["tenant_id", "id", "v", "y"], A: 1, B: 1 };

describe("a DDL on a table whose rows an open transaction wrote", () => {
  for (const placement of PLACEMENTS) {
    it(`waits for the transaction and commits after its COMMIT; the transaction is not delayed (${placement})`, async () => {
      expect(await commitsInTime(placement)).toEqual(COMMITS_IN_TIME);
    });

    it(`is busy at 5 seconds, not before, when the transaction still holds its locks; the transaction commits (${placement})`, async () => {
      expect(await holdsPastDeadline(placement)).toEqual(HOLDS_PAST_DEADLINE);
    });

    it(`commits soon after the transaction rolls back (${placement})`, async () => {
      expect(await rollsBack(placement)).toEqual(ROLLS_BACK);
    });

    it(`fails on its rows after it waited, and the transaction commits (${placement})`, async () => {
      const s = await scene(placement);
      // tenant A の 2 行が同じ v を持つので、(tenant_id, v) の UNIQUE index は、行の試しで失敗する。
      await new Db(s.c).query("INSERT INTO x VALUES (?, 2, 5), (?, 3, 5)", [s.A, s.A]);
      const tx = new Db(s.c, { retries: 0 });
      await tx.query("BEGIN");
      await tx.query(UPDATE, [s.A]);
      await tx.query(UPDATE, [s.B]);
      const ddl = s.timed(new Db(s.c).ddl("CREATE UNIQUE INDEX xu ON x(tenant_id, v)"));
      await s.until(1000);
      expect(await outcome(tx.query("COMMIT"))).toBe("ok");
      await ddl.done;
      expect({ ddl: ddl.r.outcome, afterCommit: ddl.r.ms >= 900 }).toEqual({ ddl: expect.stringMatching(/UNIQUE constraint failed/), afterCommit: true });
      expect([await s.value(s.A), await s.value(s.B)]).toEqual([2, 2]);
    });

    // シャードをまたぐ UNIQUE の index の項目は、行と別のシャードに載る。取引は項目のロックを持たないので、項目のシャードは prepare を
    // 待たずに適用する。禁止は表 x のもので、index の表のものではないので、取引の COMMIT は、項目のシャードでも断られない。
    it(`does not refuse the COMMIT of a transaction whose rows carry a cross-shard UNIQUE (${placement})`, async () => {
      const s = await scene(placement, {}, "CREATE TABLE x(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, u INTEGER UNIQUE, PRIMARY KEY (tenant_id, id))");
      const tx = new Db(s.c, { retries: 0 });
      await tx.query("BEGIN");
      await tx.query("UPDATE x SET v = v + 1, u = 100 WHERE tenant_id = ? AND id = 1", [s.A]);
      await tx.query("UPDATE x SET v = v + 1, u = 200 WHERE tenant_id = ? AND id = 1", [s.B]);
      const ddl = s.timed(new Db(s.c).ddl(ALTER));
      await s.until(1000);
      expect(await outcome(tx.query("COMMIT"))).toBe("ok");
      await ddl.done;
      expect({ ddl: ddl.r.outcome, columns: await s.columns() }).toEqual({ ddl: "ok", columns: ["tenant_id", "id", "v", "u", "y"] });
      expect([await s.value(s.A), await s.value(s.B)]).toEqual([2, 2]);
    });
  }

  // 楽観の取引 (Worker の中の Db.begin()) は、COMMIT まで行ロックを持たないので、DDL を待たせない。COMMIT が SQLITE_BUSY になる。
  it("does not wait for a Db.begin() transaction, whose COMMIT is busy", async () => {
    const s = await scene("two shards");
    const tx = await new Db(s.c, { retries: 0 }).begin();
    await tx.query(UPDATE, [s.A]);
    const ddl = s.timed(new Db(s.c).ddl(ALTER));
    await ddl.done;
    expect({ ddl: ddl.r.outcome, soon: ddl.r.ms < 1000 }).toEqual({ ddl: "ok", soon: true });
    expect(await outcome(tx.commit())).toBe("busy");
    expect(await s.value(s.A)).toBe(1);
  });
});
