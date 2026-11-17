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
// 場面は M25 と同じである。悲観の取引が行 x を書き、行 y で働き続ける。別の接続の書き込み W が x を書き、x のロックを 5 秒まで待つ。
// x と y を同じシャードに置いた場面と、別のシャードに置いた場面を並べる。欠陥のスイッチを渡すと、同じ場面が、モデルの赤の再生になる。
// W は、モデルでは autocommit の書き込みである。ここでは、1 文の悲観の取引にした。autocommit の書き込みは、行を集めて Worker の SQLite で
// 実行する経路 (基準経路だけの実行) では、行ロックを待たずに COMMIT の検証で断られ、やり直すからである。
import { describe, expect, it } from "vitest";
import { Db, type ClientFaults } from "../src/client/db";
import type { Faults } from "../src/types";
import { tenantOn } from "./ddl-harness";
import { REFERENCE_ONLY, SimCluster } from "./sim";

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
 * 別の接続が、行 x を書く。悲観の取引 (BEGIN) の 1 文として書くので、文は、x の行ロックを、どの経路でも待つ (文をシャードへ送る経路では
 * シャードが文を実行するときに、行を集めて Worker の SQLite で実行する経路では、書いた行のロックを取るときに)。取引の後に始まるので、
 * 取引の行を奪わない (wound-wait)。待ちの上限は 5 秒である。
 */
async function writeX(s: { c: SimCluster; X: number }, sql = WRITE): Promise<void> {
  const db = new Db(s.c, { retries: 0 });
  await db.query("BEGIN");
  try {
    await db.query(sql, [s.X]);
  } catch (e) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
  await db.query("COMMIT");
}

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
      other = s.timed(writeX(s));
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
 * lease の性質だけを取り出したもの。取引の文と COMMIT が通り、別の接続が、取引の COMMIT まで待つ。基準経路だけの実行では、これだけを
 * 確かめる。待った後の別の接続の書き込みそのものは、行を集めて Worker の SQLite で実行する文なので、読み取り時刻とロックの間に取引が
 * 確定した行を書くことになり、COMMIT が SQLITE_BUSY になる (docs/sql-language.md の「取引」)。
 */
export const KEEPS_LOCK = { statements: KEEPS_WORKING.statements, commit: KEEPS_WORKING.commit, otherWaitedForCommit: true };

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
  const other = s.timed(writeX(s));
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
        const r = await keepsWorking(placement, statement);
        if (REFERENCE_ONLY) expect(r).toMatchObject(KEEPS_LOCK);
        else expect(r).toEqual(KEEPS_WORKING);
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
      const other = s.timed(writeX(s));
      await other.done;
      expect({ other: other.r.outcome, gone: other.r.at <= 7600 }).toEqual({ other: "ok", gone: true });
    });
  }
});

/**
 * 取引が x を書き、2 秒後に y を書いて、放っておかれる。3 秒に、別の接続が x を書く。x のロックは、最後の文 (2 秒) から 5 秒の間は切れず、
 * 最初に lease を延ばした文 (0 秒) から 7.5 秒で切れる。別の接続の書き込みは、どの置き場所でも、7.5 秒に通る。
 */
export async function idleAfterSecondStatement(placement: Placement, o: Switches = {}) {
  const s = await scene(placement, o);
  const tx = new Db(s.c, { retries: 0, faults: o.clientFaults });
  await tx.query("BEGIN");
  await tx.query(WRITE, [s.X]);
  await s.until(2000);
  await tx.query(WRITE, [s.Y]);
  await s.until(3000);
  const other = s.timed(writeX(s));
  await other.done;
  await tx.query("ROLLBACK").catch(() => undefined);
  return { other: other.r.outcome, at: Math.round(other.r.at / 100) / 10 };
}

/**
 * 取引が x と y を書き、3 秒後に y を書く (lease を延ばし、x のシャードへ renew が行く)。ROLLBACK の unlock が、x のシャードに届かない。
 * ランタイムが、同じ renew を、6 秒と 9 秒に届け直す。x のロックは、延ばした文 (3 秒) から 7.5 秒で切れる。届き直した renew では延びない。
 */
export async function renewRedelivered(o: Switches = {}) {
  const s = await scene("two shards", o);
  const tx = new Db(s.c, { retries: 0, faults: o.clientFaults });
  await tx.query("BEGIN");
  await tx.query(WRITE, [s.X]);
  await tx.query(WRITE, [s.Y]);
  await s.until(3000);
  await tx.query(WRITE, [s.Y]);
  const renewals = s.c.net.log.filter((m) => m.method === "renew" && m.to === "s0");
  s.c.net.drop = (m) => m.method === "unlock" && m.to === "s0";
  await tx.query("ROLLBACK");
  s.c.net.drop = () => false;
  for (const at of [6000, 9000]) {
    await s.until(at);
    for (const m of renewals) await s.c.shard("s0").renew(structuredClone(m.req) as never);
  }
  await s.until(9500);
  const other = s.timed(writeX(s));
  await other.done;
  return { renewals: renewals.length, other: other.r.outcome, goneBy10500: other.r.at <= 10600 };
}
export const RENEW_REDELIVERED = { renewals: 1, other: "ok", goneBy10500: true };

/**
 * 取引が x を書いて 8 秒放っておかれる (x のロックは 7.5 秒で切れる)。7.7 秒に、別の接続が x を書く。取引が 8 秒に y を書く。その文は
 * lease を取り直すが、切れた x のロックは戻らない。別の接続は、その後も、待たずに x を書ける。取引の COMMIT は、検証で競合になる。
 */
export async function expiredLockStaysGone(placement: Placement, o: Switches = {}) {
  const s = await scene(placement, o);
  const tx = new Db(s.c, { retries: 0, faults: o.clientFaults });
  await tx.query("BEGIN");
  await tx.query(WRITE, [s.X]);
  await s.until(7700);
  const first = await outcome(writeX(s));
  await s.until(8000);
  const statement = await outcome(tx.query(WRITE, [s.Y]));
  await s.until(8100);
  const other = s.timed(writeX(s));
  await s.until(9000);
  const otherDone = other.r.outcome;
  const commit = await outcome(tx.query("COMMIT"));
  await other.done;
  return { first, statement, otherBeforeCommit: otherDone, commit, x: await s.value(s.X) };
}
export const EXPIRED_STAYS_GONE = { first: "ok", statement: "ok", otherBeforeCommit: "ok", commit: "busy", x: 3 };

/**
 * COMMIT の検証は、ロックも lease も信じない。取引が x を書いた後で、x のシャードが再起動する (メモリのロックが消える)。別の接続が x を
 * 書く。取引の COMMIT は、検証で競合になる。
 */
export async function lockLostToRestart(o: Switches = {}) {
  const s = await scene("two shards", o);
  const tx = new Db(s.c, { retries: 0, faults: o.clientFaults });
  await tx.query("BEGIN");
  await tx.query(WRITE, [s.X]);
  await tx.query(WRITE, [s.Y]);
  s.c.restart("s0");
  await s.until(1000);
  const other = await outcome(writeX(s, "UPDATE t SET v = v + 100 WHERE tenant_id = ? AND id = 1"));
  const commit = await outcome(tx.query("COMMIT"));
  return { other, commit, x: await s.value(s.X) };
}

describe("the transaction's lease on its shards", () => {
  for (const placement of PLACEMENTS) {
    it(`a lock expires 7.5 seconds after the statement that last extended the lease, not after the last statement on its shard (${placement})`, async () => {
      expect(await idleAfterSecondStatement(placement)).toEqual({ other: "ok", at: 7.5 });
    });

    it(`a lock that expired is not given back by the transaction's next statement (${placement})`, async () => {
      expect(await expiredLockStaysGone(placement)).toEqual(EXPIRED_STAYS_GONE);
    });
  }

  it("a renewal that the runtime delivers again does not extend the lease", async () => {
    expect(await renewRedelivered()).toEqual(RENEW_REDELIVERED);
  });

  it("the COMMIT of a transaction whose lock was lost to a shard restart is validated, and conflicts", async () => {
    expect(await lockLostToRestart()).toEqual({ other: "ok", commit: "busy", x: 101 });
  });
});

// モデル M25 の赤の再生。
describe.skipIf(REFERENCE_ONLY)("put back: the conditions of the transaction's lease, one at a time", () => {
  it("perShardLockTtl (m25_red_per_shard): the lock on the shard the transaction left expires while it keeps working elsewhere", async () => {
    expect(await keepsWorking("two shards", "write", { faults: { perShardLockTtl: true } })).toMatchObject({ otherWaitedForCommit: false, commit: "busy" });
    // 行が 1 つのシャードにあれば、同じ文の並びで、ロックは切れない (m25_per_shard_same)。
    expect(await keepsWorking("one shard", "write", { faults: { perShardLockTtl: true } })).toEqual(KEEPS_WORKING);
  });

  it("localLockLease (m25_red_local_lease): the shard that receives statements keeps its locks longer than the others", async () => {
    const one = await idleAfterSecondStatement("one shard", { faults: { localLockLease: true } });
    const two = await idleAfterSecondStatement("two shards", { faults: { localLockLease: true } });
    expect(one).not.toEqual(two);
  });

  it("leaseIgnoresEpoch (m25_red_no_epoch): every redelivered renewal extends the lock of a transaction that rolled back", async () => {
    // 待っていた書き込みは、内部でやり直し続けて、延び続けたロックが切れた後 (16.5 秒) に通る。
    expect(await renewRedelivered({ faults: { leaseIgnoresEpoch: true } })).toMatchObject({ renewals: 1, goneBy10500: false });
  });

  it("renewRelocks (m25_red_regrant): the next statement takes back a lock that expired, and blocks a writer the transaction can no longer beat", async () => {
    for (const placement of PLACEMENTS) {
      expect(await expiredLockStaysGone(placement, { clientFaults: { renewRelocks: true } })).toMatchObject({ otherBeforeCommit: undefined, commit: "busy" });
    }
  });

  it("trustLocks (m25_red_trust_lease): a COMMIT that trusts the lock it lost to a restart overwrites another connection's write", async () => {
    expect(await lockLostToRestart({ faults: { trustLocks: true } })).toEqual({ other: "ok", commit: "ok", x: 2 });
  });
});
