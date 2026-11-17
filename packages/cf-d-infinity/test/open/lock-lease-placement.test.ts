// 行ロックの寿命は取引のもので、行の置き場所に依らない (docs/design-lock-lease.md、モデル M25、specs/m25_txn_lock_lease.qnt)。
//
// 約束 (docs/sql-language.md の「取引」)。
//   - 行ロックは、取引が最後の文を実行してから 5 秒の間は切れない。7.5 秒文を実行しなければ切れる (Worker が落ちたときのため)。
//   - 取引のどの文も、取引の全部の行ロックを延ばす。切れるかどうかは、取引を放っておいた時間だけで決まり、取引の行がどのシャードに
//     あるかには依らない (AGENTS.md の規則 4)。
// 2026-11-16 までは、ロックの TTL (5 秒) を延ばすのは、そのシャードでロックを取る文を実行したときだけだった。取引がシャード A で働き
// 続ける間に、シャード B のロックは切れた。行が 1 つのシャードにあれば切れなかった (M25 の m25_red_per_shard と m25_per_shard_same)。
// ロックを取らない読みは、同じシャードでもロックを延ばさなかった。
//
// 場面は M25 と同じである。悲観の取引が行 x を書き、行 y で働き続ける。別の接続の autocommit の書き込み W が x を書く。x と y を同じ
// シャードに置いた場面と、別のシャードに置いた場面を並べる。欠陥のスイッチを渡すと、同じ場面が、モデルの赤の再生になる。
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

/** 表 t の行 x (tenant X、s0) と y (tenant Y。同じ s0 か、s1)。 */
export async function scene(placement: Placement, o: Switches = {}) {
  const c = new SimCluster({ shards: 2, faults: o.faults, clientFaults: o.clientFaults });
  const db = new Db(c);
  await db.ddl("CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))");
  const X = await tenantOn(c, "s0");
  const Y = placement === "one shard" ? await tenantOn(c, "s0", 1) : await tenantOn(c, "s1");
  await db.query("INSERT INTO t VALUES (?, 1, 1)", [X]);
  await db.query("INSERT INTO t VALUES (?, 1, 1)", [Y]);
  const t0 = c.runtime.now();
  const timed = (p: Promise<unknown>) => {
    const r = { outcome: undefined as string | undefined, at: -1 };
    const done = outcome(p).then((x) => {
      r.outcome = x;
      r.at = c.runtime.now() - t0;
      return r;
    });
    return { r, done };
  };
  const until = async (ms: number) => {
    const left = t0 + ms - c.runtime.now();
    if (left > 0) await c.sleep(left);
  };
  const value = async (tenant: number) => (await new Db(c).query("SELECT v FROM t WHERE tenant_id = ? AND id = 1", [tenant])).rows[0]?.v;
  return { c, X, Y, timed, until, value };
}

const WRITE = "UPDATE t SET v = v + 1 WHERE tenant_id = ? AND id = 1";
const READ = "SELECT v FROM t WHERE tenant_id = ? AND id = 1";

/**
 * 取引が x を書き、y への文 (書き込みか、ロックを取らない読み) を 2 秒ごとに実行し、8 秒後に COMMIT する。5.5 秒に、別の接続が x を書く。
 * 別の接続の書き込みは、取引の COMMIT まで待ち、取引の COMMIT は通る。
 */
export async function keepsWorking(placement: Placement, statement: "write" | "read", o: Switches = {}) {
  const s = await scene(placement, o);
  const tx = new Db(s.c, { retries: 0, faults: o.clientFaults });
  await tx.query("BEGIN");
  await tx.query(WRITE, [s.X]);
  const statements: string[] = [];
  let other: ReturnType<typeof s.timed> | undefined;
  for (const at of [2000, 4000, 6000]) {
    if (at === 6000) {
      await s.until(5500);
      other = s.timed(new Db(s.c, { faults: o.clientFaults }).query(WRITE, [s.X]));
    }
    await s.until(at);
    statements.push(await outcome(tx.query(statement === "write" ? WRITE : READ, [s.Y])));
  }
  await s.until(8000);
  const commit = await outcome(tx.query("COMMIT"));
  await other!.done;
  return { statements, commit, other: other!.r.outcome, otherWaitedForCommit: other!.r.at >= 8000, x: await s.value(s.X) };
}
export const KEEPS_WORKING = { statements: ["ok", "ok", "ok"], commit: "ok", other: "ok", otherWaitedForCommit: true, x: 3 };

/**
 * 取引が x と y を書いて、8 秒放っておかれる。3 秒に、別の接続が x を書く。その書き込みは、取引のロックが切れるまで待って通る。
 * ロックは、最後の文から 5 秒の間は切れず、7.5 秒の後には残らない。取引の COMMIT は競合になる。
 */
export async function leftIdle(placement: Placement, o: Switches = {}) {
  const s = await scene(placement, o);
  const tx = new Db(s.c, { retries: 0, faults: o.clientFaults });
  await tx.query("BEGIN");
  await tx.query(WRITE, [s.X]);
  await tx.query(WRITE, [s.Y]);
  await s.until(3000);
  const other = s.timed(new Db(s.c, { faults: o.clientFaults }).query(WRITE, [s.X]));
  await s.until(8000);
  const commit = await outcome(tx.query("COMMIT"));
  await other.done;
  return { other: other.r.outcome, lockOutlived5s: other.r.at >= 5000, lockGoneBy7500: other.r.at <= 7600, commit, x: await s.value(s.X) };
}
export const LEFT_IDLE = { other: "ok", lockOutlived5s: true, lockGoneBy7500: true, commit: "busy", x: 2 };

describe("row locks live by the transaction's lease, wherever its rows are", () => {
  for (const statement of ["write", "read"] as const) {
    for (const placement of PLACEMENTS) {
      it(`a transaction that keeps running ${statement}s on another row keeps the lock on the row it wrote first (${placement})`, async () => {
        expect(await keepsWorking(placement, statement)).toEqual(KEEPS_WORKING);
      });
    }
  }

  for (const placement of PLACEMENTS) {
    it(`a transaction left idle loses its locks between 5 and 7.5 seconds after its last statement (${placement})`, async () => {
      expect(await leftIdle(placement)).toEqual(LEFT_IDLE);
    });

    // ROLLBACK の unlock が届かなかったシャードのロックは、lease の期限まで残る。終わった取引の文は、lease を延ばさない。
    it(`a lock whose unlock was lost at ROLLBACK is gone 7.5 seconds after the last statement (${placement})`, async () => {
      const s = await scene(placement);
      const tx = new Db(s.c, { retries: 0 });
      await tx.query("BEGIN");
      await tx.query(WRITE, [s.X]);
      await tx.query(WRITE, [s.Y]);
      s.c.net.drop = (m) => m.method === "unlock";
      await s.until(1000);
      await tx.query("ROLLBACK");
      s.c.net.drop = () => false;
      await s.until(3000);
      const other = s.timed(new Db(s.c).query(WRITE, [s.X]));
      await other.done;
      expect({ other: other.r.outcome, gone: other.r.at <= 7600 }).toEqual({ other: "ok", gone: true });
    });
  }
});
