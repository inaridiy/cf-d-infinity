// DDL が行ロックの持ち主を待っている間に来た取引は、行がどのシャードにあっても、DDL の後ろで待つ (直った。2026-11-17 までは
// test/open/ にあった。計画書の不変条件 16 の D3)。
//
// 不変条件: M24c (specs/m24c_lock_holders.qnt) の asSqlite と placementFree。DDL の結果は、DDL より前にロックを取った取引の時刻だけで
// 決まり、置き場所に依らない。SQLite の書き込みのロックに公平な列はなく、持ち主が確定した時、待っていた DDL と、待っていた新しい書き手の
// どちらが先にロックを取るかは決まっていない。D∞ は、いつも DDL を先にする (DDL を始めた後に最初のロックを求めた取引は、DDL の後ろで
// 待つ)。待つ間に来た取引がロックを得て持ち続けると、DDL は 5 秒で SQLITE_BUSY になり、行が、もう prepare を適用したシャードにあれば、
// その取引は禁止で待って DDL は通るので、成否が置き場所で決まる (AGENTS.md の規則 4)。
// 持ち主: シャードの、ロックを与える 1 つの判断 (src/shard/kernel.ts の tableGate)。prepare の適用を待ち始めた時 (ShardKernel.pending) から、
// その表の新しい行ロックを、その表の行ロックを持たない取引に与えない。禁止は、DDL が終わるまで続く。ロックを持つ取引が書き込み禁止に
// 当たって試みを取り消させるとき、Meta が、取り消しと同じ手で、やり直しの prepare を記録するので (src/meta.ts の abort)、開いている
// 試みのない時がない。
//
// 場面は 5 つである。4 つは、行を 1 つのシャードに置いた形と、2 つのシャードに置いた形で、同じ結果になることを確かめる。欠陥のスイッチを
// 渡すと、モデルの赤の再生になる。5 つ目 (行を待っていた要求) は、ロックを与える判断が、与える直前にあることを確かめる。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import type { Faults } from "../src/types";
import { tenantOn } from "./ddl-harness";
import { REFERENCE_ONLY, SimCluster } from "./sim";

const BUSY = /^(conflict|read too old|not owner|migrating|upgrading)/;
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => (BUSY.test(e.message) ? "busy" : e.message));
const UPDATE = "UPDATE x SET v = v + 1 WHERE tenant_id = ? AND id = 1";
const ALTER = "ALTER TABLE x ADD COLUMN y INTEGER";
type Placement = "one shard" | "two shards";
const PLACEMENTS: Placement[] = ["one shard", "two shards"];

async function cluster(faults: Faults, tenants: [string, number][]) {
  const c = new SimCluster({ shards: 2, faults });
  const admin = new Db(c);
  await admin.ddl("CREATE TABLE x(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))");
  const ids: number[] = [];
  for (const [shard, skip] of tenants) ids.push(await tenantOn(c, shard, skip));
  for (const t of ids) await admin.query("INSERT INTO x VALUES (?, 1, 1)", [t]);
  const t0 = c.runtime.now();
  const until = async (ms: number) => {
    const left = t0 + ms - c.runtime.now();
    if (left > 0) await c.sleep(left);
  };
  /** 始めてからの時間と、結果。 */
  const timed = (p: Promise<unknown>) => {
    const started = c.runtime.now();
    return outcome(p).then((r) => ({ r, ms: c.runtime.now() - started }));
  };
  return { c, admin, ids, until, timed };
}

/**
 * 取引 H (SQL の BEGIN) が行 a (s0) を書く。別の接続が ALTER TABLE x ADD COLUMN を始める。0.5 秒後に、取引 R (SQL の BEGIN) が行 b を書く。
 * 1 秒後に H が COMMIT する。R は 3 秒後に b を読み、6 秒後に COMMIT する。b は、a と同じ s0 か、s1 にある。
 * R の書き込みは、s0 (H を待っている) でも s1 (もう prepare を適用した) でも、DDL が終わるまで待つ。DDL は H の COMMIT の後で確定する。
 * R は、まだ何も読み書きしていないので、DDL の後の表定義で書き直して確定する。
 */
async function writerDuringTheWait(placement: Placement, faults: Faults = {}) {
  const s = await cluster(faults, [["s0", 0], placement === "one shard" ? ["s0", 1] : ["s1", 0]]);
  const [a, b] = s.ids as [number, number];
  const h = new Db(s.c, { retries: 0 });
  const r = new Db(s.c, { retries: 0 });
  await h.query("BEGIN");
  await h.query(UPDATE, [a]);
  const ddl = s.timed(s.admin.ddl(ALTER));
  await s.until(500);
  await r.query("BEGIN");
  const rWrite = s.timed(r.query(UPDATE, [b]));
  await s.until(1_000);
  const hCommit = await outcome(h.query("COMMIT"));
  const rWrote = await rWrite;
  await s.until(3_000);
  const rRead = await outcome(r.query("SELECT v FROM x WHERE tenant_id = ? AND id = 1", [b]));
  await s.until(6_000);
  const rCommit = await outcome(r.query("COMMIT"));
  const d = await ddl;
  return { hCommit, rWrote: rWrote.r, rWaitedForTheDdl: rWrote.ms >= 400, rRead, rCommit, ddl: d.r, ddlAfterH: d.ms >= 900 && d.ms < 2_000 };
}
const WRITER_DURING_THE_WAIT = { hCommit: "ok", rWrote: "ok", rWaitedForTheDdl: true, rRead: "ok", rCommit: "ok", ddl: "ok", ddlAfterH: true };

/**
 * やり直しの間 (M24c の m24c_red_gap)。取引 H が行 a (s0) を書く。DDL が始まる。0.5 秒後に取引 R が行 b を書こうとして待つ。0.8 秒後に
 * H が行 a2 を書き、2 秒後に COMMIT する。R は 6 秒後に COMMIT する。2 つのシャードの形では、a2 と b は s1 にある。s1 は prepare を
 * 適用していて、H の書き込みは禁止に当たり、試みを取り消させる。Meta は、取り消しと同じ手で、やり直しの prepare を記録する。s1 は、
 * abort と、やり直しの prepare を、続けて適用する (H のロックを待ち始める)。R は、その間のどこでも、ロックを得ない。
 */
async function holderWoundsWhileAnotherWaits(placement: Placement, faults: Faults = {}) {
  const other = placement === "one shard" ? "s0" : "s1";
  const s = await cluster(faults, [["s0", 0], [other, placement === "one shard" ? 1 : 0], [other, placement === "one shard" ? 2 : 1]]);
  const [a, a2, b] = s.ids as [number, number, number];
  const h = new Db(s.c, { retries: 0 });
  const r = new Db(s.c, { retries: 0 });
  await h.query("BEGIN");
  await h.query(UPDATE, [a]);
  const ddl = s.timed(s.admin.ddl(ALTER));
  await s.until(500);
  await r.query("BEGIN");
  const rWrite = s.timed(r.query(UPDATE, [b]));
  await s.until(800);
  const hSecond = await s.timed(h.query(UPDATE, [a2]));
  await s.until(2_000);
  const hCommit = await outcome(h.query("COMMIT"));
  const rWrote = await rWrite;
  await s.until(3_000);
  const rRead = await outcome(r.query("SELECT v FROM x WHERE tenant_id = ? AND id = 1", [b]));
  await s.until(6_000);
  const rCommit = await outcome(r.query("COMMIT"));
  const d = await ddl;
  return {
    hSecond: hSecond.r, hWaited: hSecond.ms >= 400, hCommit, rWrote: rWrote.r, rWaitedForTheDdl: rWrote.ms >= 1_400, rRead, rCommit,
    ddl: d.r, ddlAfterH: d.ms >= 1_900 && d.ms < 3_000,
  };
}
const HOLDER_WOUNDS = {
  hSecond: "ok", hWaited: false, hCommit: "ok", rWrote: "ok", rWaitedForTheDdl: true, rRead: "ok", rCommit: "ok", ddl: "ok", ddlAfterH: true,
};

/**
 * 2 つの持ち主 (M24c の m24c_red_holder_here)。取引 H1 が行 a (s0) を、取引 H2 が行 b を書く。DDL が始まる。0.5 秒後に H1 が行 a2 を書く。
 * H1 は 1 秒後に、H2 は 2 秒後に COMMIT する。2 つのシャードの形では、a2 と b は s1 にあり、s1 は H2 を待っている。H1 は、s1 には
 * ロックを持たないが、x の行ロックを持つ取引なので (要求が運ぶ)、a2 の書き込みは、待たずに通る。
 */
async function twoHolders(placement: Placement, faults: Faults = {}) {
  const other = placement === "one shard" ? "s0" : "s1";
  const s = await cluster(faults, [["s0", 0], [other, placement === "one shard" ? 1 : 0], [other, placement === "one shard" ? 2 : 1]]);
  const [a, a2, b] = s.ids as [number, number, number];
  const h1 = new Db(s.c, { retries: 0 });
  const h2 = new Db(s.c, { retries: 0 });
  await h1.query("BEGIN");
  await h1.query(UPDATE, [a]);
  await h2.query("BEGIN");
  await h2.query(UPDATE, [b]);
  const ddl = s.timed(s.admin.ddl(ALTER));
  await s.until(500);
  const second = await s.timed(h1.query(UPDATE, [a2]));
  await s.until(1_000);
  const commit1 = await outcome(h1.query("COMMIT"));
  await s.until(2_000);
  const commit2 = await outcome(h2.query("COMMIT"));
  const d = await ddl;
  return { second: second.r, secondWaited: second.ms >= 400, commit1, commit2, ddl: d.r, ddlAfterBoth: d.ms >= 1_900 && d.ms < 3_000 };
}
/**
 * 基準経路の full は、条件を押し下げずに表の全行を読む (src/sql/plan.ts の Reference)。H2 の書き込みが読んだ範囲は表の全体で、先に確定した
 * H1 の書き込みが、H2 の COMMIT を `span changed after T` の競合にする。DDL とは関係がなく、置き場所にも依らない (どちらの形でも同じ)。
 */
const FULL = process.env.REFERENCE === "full";
const TWO_HOLDERS = { second: "ok", secondWaited: false, commit1: "ok", commit2: FULL ? "busy" : "ok", ddl: "ok", ddlAfterBoth: true };

/**
 * ロックを取らない書き込み (M24c の OPTIMISTIC と optimisticOutcome)。楽観の取引 O (Worker の中の Db.begin()) が行 b を書く (COMMIT まで
 * 手元に溜める)。取引 H が行 a (s0) を書く。DDL が始まる。0.5 秒後に、O が COMMIT し、別の接続が autocommit で行 c を書く。1 秒後に H が
 * COMMIT する。b と c は、a と同じ s0 か、s1 にある。
 * O の COMMIT は、s0 (H を待っている) でも s1 (もう prepare を適用した) でも、待たずに競合になる (docs/sql-language.md の、SQLite との
 * 違いの 3 つ目)。autocommit の書き込みは、どちらでも、DDL が終わるまで待って、通る。
 */
async function locklessWritesDuringTheWait(placement: Placement, faults: Faults = {}) {
  const other = placement === "one shard" ? "s0" : "s1";
  const s = await cluster(faults, [["s0", 0], [other, placement === "one shard" ? 1 : 0], [other, placement === "one shard" ? 2 : 1]]);
  const [a, b, c] = s.ids as [number, number, number];
  const o = await new Db(s.c, { retries: 0 }).begin();
  await o.query(UPDATE, [b]);
  const h = new Db(s.c, { retries: 0 });
  await h.query("BEGIN");
  await h.query(UPDATE, [a]);
  const ddl = s.timed(s.admin.ddl(ALTER));
  await s.until(500);
  const auto = s.timed(new Db(s.c).query(UPDATE, [c]));
  const oCommit = await outcome(o.commit());
  await s.until(1_000);
  const hCommit = await outcome(h.query("COMMIT"));
  const au = await auto;
  const d = await ddl;
  return { oCommit, auto: au.r, autoWaitedForTheDdl: au.ms >= 400, hCommit, ddl: d.r, ddlAfterH: d.ms >= 900 && d.ms < 2_000 };
}
const LOCKLESS_WRITES = { oCommit: "busy", auto: "ok", autoWaitedForTheDdl: true, hCommit: "ok", ddl: "ok", ddlAfterH: true };

/**
 * 行を待っていた要求。取引 H が行 a を書く。取引 R が、同じ行 a を書こうとして、行ロックの列で待つ。0.2 秒後に DDL が始まる (シャードは
 * H を待つ)。1 秒後に H が COMMIT し、R が起こされる。R は、DDL より前から行を待っていたが、x の行ロックは持っていない。ロックを与える
 * 判断は、与える直前にあるので、R は、起こされた時に、ロックを与えられず、DDL の後ろで待つ。R は 6 秒後に COMMIT する。
 * 判断が、要求の着いた時にしかなければ、R は起こされた時にロックを得て、DDL は R を待ち、5 秒で SQLITE_BUSY になる (SQLite では、H が
 * 確定した時に、待っていた DDL と R のどちらが先に進むかは決まっていない。この DB は、いつも DDL を先にする)。モデル M24c に、行の
 * 取り合いはない。
 */
async function queuedBeforeTheDdl(faults: Faults = {}) {
  const s = await cluster(faults, [["s0", 0]]);
  const [a] = s.ids as [number];
  const h = new Db(s.c, { retries: 0 });
  const r = new Db(s.c, { retries: 0 });
  await h.query("BEGIN");
  await h.query(UPDATE, [a]);
  await r.query("BEGIN");
  const rWrite = s.timed(r.query(UPDATE, [a]));
  await s.until(200);
  const ddl = s.timed(s.admin.ddl(ALTER));
  await s.until(1_000);
  const hCommit = await outcome(h.query("COMMIT"));
  const rWrote = await rWrite;
  await s.until(6_000);
  const rCommit = await outcome(r.query("COMMIT"));
  const d = await ddl;
  return { hCommit, rWrote: rWrote.r, rCommit, ddl: d.r, ddlSoonAfterH: d.ms >= 700 && d.ms < 1_800 };
}
const QUEUED_BEFORE_THE_DDL = { hCommit: "ok", rWrote: "ok", rCommit: "ok", ddl: "ok", ddlSoonAfterH: true };

describe("a transaction that writes the table while a DDL waits for another transaction's row lock", () => {
  for (const placement of PLACEMENTS) {
    it(`waits behind the DDL, which commits after the holder; then the transaction commits (${placement})`, async () => {
      expect(await writerDuringTheWait(placement)).toEqual(WRITER_DURING_THE_WAIT);
    });
  }

  // m24c_red_window。待っているシャードが、新しい取引にロックを与える。行が 1 つのシャードにあると、R はロックを得て 6 秒まで持ち、
  // DDL は 5 秒で SQLITE_BUSY になる。行が 2 つのシャードにあると、R は s1 の禁止で待ち、DDL は通る。
  it.skipIf(REFERENCE_ONLY)("put back (lockDuringDdlWait): on one shard the newcomer gets its lock and the DDL is busy; on two shards it is not", async () => {
    const one = await writerDuringTheWait("one shard", { lockDuringDdlWait: true });
    expect({ rWaitedForTheDdl: one.rWaitedForTheDdl, ddl: one.ddl }).toEqual({ rWaitedForTheDdl: false, ddl: "busy" });
    expect(await writerDuringTheWait("two shards", { lockDuringDdlWait: true })).toEqual(WRITER_DURING_THE_WAIT);
  });
});

describe("a transaction that queued on a row before the DDL started and is woken while the DDL waits", () => {
  it("is not given the lock when it is woken; it waits behind the DDL, which commits after the holder", async () => {
    expect(await queuedBeforeTheDdl()).toEqual(QUEUED_BEFORE_THE_DDL);
  });

  // 待っている prepare を見ない形。起こされた R がロックを得て 6 秒まで持ち、DDL は 5 秒で SQLITE_BUSY になる。
  it.skipIf(REFERENCE_ONLY)("put back (lockDuringDdlWait): the woken transaction takes the lock, and the DDL is busy", async () => {
    expect(await queuedBeforeTheDdl({ lockDuringDdlWait: true })).toEqual({ ...QUEUED_BEFORE_THE_DDL, ddl: "busy", ddlSoonAfterH: false });
  });
});

describe("writes that take no row lock while a DDL waits for another transaction's row lock", () => {
  for (const placement of PLACEMENTS) {
    it(`an optimistic COMMIT is busy and an autocommit write waits behind the DDL (${placement})`, async () => {
      expect(await locklessWritesDuringTheWait(placement)).toEqual(LOCKLESS_WRITES);
    });
  }

  // m24c_red_window の optimisticOutcome。待っているシャードが、ロックを持たない取引の書き込みを受ける。行が 1 つのシャードにあると、
  // 楽観の取引の COMMIT が通り、autocommit の書き込みは待たない。行が 2 つのシャードにあると、どちらも s1 の禁止に当たる。
  it.skipIf(REFERENCE_ONLY)("put back (lockDuringDdlWait): on one shard the optimistic COMMIT passes and the autocommit write does not wait; on two shards they do not", async () => {
    const one = await locklessWritesDuringTheWait("one shard", { lockDuringDdlWait: true });
    expect({ oCommit: one.oCommit, autoWaitedForTheDdl: one.autoWaitedForTheDdl }).toEqual({ oCommit: "ok", autoWaitedForTheDdl: false });
    expect(await locklessWritesDuringTheWait("two shards", { lockDuringDdlWait: true })).toEqual(LOCKLESS_WRITES);
  });
});

describe("a transaction that waits behind a DDL while a lock holder withdraws the DDL's attempt", () => {
  for (const placement of PLACEMENTS) {
    it(`keeps waiting across the restart, and the DDL commits after the holder (${placement})`, async () => {
      expect(await holderWoundsWhileAnotherWaits(placement)).toEqual(HOLDER_WOUNDS);
    });
  }

  // m24c_red_gap。Meta が、取り消しと一緒に、やり直しの prepare を記録しない。s1 が abort を適用してから、進める側のやり直しの prepare が
  // 届くまで、s1 には禁止も待ちもない。待っていた R が、その間にロックを得て 6 秒まで持ち、DDL は 5 秒で SQLITE_BUSY になる。
  // 行が 1 つのシャードにあると、取り消させる手が起きないので、DDL は通る。
  it.skipIf(REFERENCE_ONLY)("put back (woundWithoutRestart): on two shards the waiting transaction gets its lock between the abort and the retry, and the DDL is busy", async () => {
    const two = await holderWoundsWhileAnotherWaits("two shards", { woundWithoutRestart: true });
    expect({ hSecond: two.hSecond, hCommit: two.hCommit, rWaitedForTheDdl: two.rWaitedForTheDdl, ddl: two.ddl }).toEqual({
      hSecond: "ok", hCommit: "ok", rWaitedForTheDdl: false, ddl: "busy",
    });
    expect(await holderWoundsWhileAnotherWaits("one shard", { woundWithoutRestart: true })).toEqual(HOLDER_WOUNDS);
  });
});

describe("two transactions that hold row locks on different shards when a DDL starts", () => {
  for (const placement of PLACEMENTS) {
    it(`write on each other's shard without waiting, and the DDL commits after both (${placement})`, async () => {
      expect(await twoHolders(placement)).toEqual(TWO_HOLDERS);
    });
  }

  // m24c_red_holder_here。待っているシャードが、そのシャードにロックを持つ取引にだけ、新しいロックを与える。H1 の s1 への書き込みは、
  // ロックを持たない取引と同じに断られる。行が 1 つのシャードにあると、H1 は s0 にロックを持つので、通る。
  it.skipIf(REFERENCE_ONLY)("put back (holdsOnlyHere): on two shards the holder's write on the other shard does not pass at once", async () => {
    const two = await twoHolders("two shards", { holdsOnlyHere: true });
    expect({ second: two.second, secondWaited: two.secondWaited }).not.toEqual({ second: "ok", secondWaited: false });
    expect(await twoHolders("one shard", { holdsOnlyHere: true })).toEqual(TWO_HOLDERS);
  });
});
