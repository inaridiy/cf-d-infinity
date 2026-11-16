// 分割が持つ保守の操作の枠の終わり方 (不変条件 4、specs/m15_maintenance_slot.qnt)。
//
// 分割を進める側 (Autoscaler) は、どの段の前でも止まり得る (Worker の呼び出しの打ち切り、DO の再起動)。
//   子が受け取り始める前に止まった: 枠は期限 (5 秒) で消え、表定義の変更が通る。
//   子が受け取り始めた後に止まった: 分割は取り消せないので、枠は残り、表定義の変更は待つ。Meta の枠の一覧から再開すると、
//   分割が終わって枠が返り、表定義の変更が通る。止まっている間も、子へ移った行は読める。
import { describe, expect, it } from "vitest";
import { split, splitsToResume } from "../src/autoscaler";
import { Db, type ClientFaults, type Cluster } from "../src/client/db";
import { ownerOf, planSplit, slotOf } from "../src/routing";
import type { Faults, ShardApi } from "../src/types";
import { delivers, SimCluster } from "./sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

/** 分割の段。この順に呼ばれる。 */
const STEPS = ["beginIncoming", "fence", "switchRange", "drain", "finishMove", "finishIncoming", "endSplit"] as const;

/** 段 step の前で止まる、分割を進める側。 */
function stopsBefore(c: SimCluster, step: (typeof STEPS)[number]): Cluster {
  const stopped = () => Promise.reject(new Error(`driver stopped before ${step}`));
  return new Proxy(c as unknown as Cluster, {
    get(target, prop, receiver) {
      if (prop === step) return stopped;
      if (prop === "shard") {
        return (id: string) => new Proxy({} as ShardApi, {
          get: (_t, method: keyof ShardApi) => (method === step ? stopped : (req: never) => (c.shard(id)[method] as (r: never) => Promise<unknown>)(req)),
        });
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

async function seeded() {
  const c = new SimCluster({ shards: 1 });
  await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  const ids = Array.from({ length: 40 }, (_, i) => i + 1);
  await new Db(c).query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
  const range = planSplit((await c.catalog()).routing, "s0")!;
  const moved = ids.find((id) => slotOf(JSON.stringify([id])) >= range.start && slotOf(JSON.stringify([id])) < range.end)!;
  return { c, range, moved };
}

describe("a split whose driver stops", () => {
  it("before the child starts receiving: the slot lapses, and a schema change goes through", async () => {
    const { c, range } = await seeded();
    expect(await outcome(split(stopsBefore(c, "beginIncoming"), "s0", "s1", { range }))).toMatch(/driver stopped/);
    expect((await c.splits()).map((s) => s.started)).toEqual([false]);
    const t0 = c.time;
    expect(await outcome(new Db(c).ddl("CREATE TABLE other(id INTEGER PRIMARY KEY)"))).toBe("ok");
    // 枠の期限 (5 秒) を待った。
    expect(c.time - t0).toBeGreaterThanOrEqual(5_000);
    expect(c.time - t0).toBeLessThan(10_000);
    expect(await c.splits()).toEqual([]);
    // 後から同じ分割をやり直せる。
    expect(await outcome(split(c, "s0", "s1", { range }))).toBe("ok");
  });

  for (const step of STEPS.slice(1)) {
    it(`before ${step}: a schema change waits, the moved row stays readable, and resuming from Meta finishes it`, async () => {
      const { c, range, moved } = await seeded();
      expect(await outcome(split(stopsBefore(c, step), "s0", "s1", { range }))).toMatch(/driver stopped/);
      expect((await c.splits()).map((s) => s.started)).toEqual([true]);
      // 子が受け取り始めた分割は取り消せない。表定義の変更は待ち、待ち切れなければ、やり直せる誤りを返す。
      expect(await outcome(new Db(c, { splitWaitMs: 2_000 }).ddl("CREATE TABLE other(id INTEGER PRIMARY KEY)"))).toMatch(/a shard split.* is in progress; retry/);
      // 止まっている間も、行は読める (子へ移った行も、取りに行く)。fence と範囲表の切り替えの間で止まったときは読めない。
      // 分割の手順の別の欠陥で、test/open/fenced-before-switch.test.ts に再現がある (計画書の未解決の問題 17)。
      if (step !== "switchRange") expect((await new Db(c).query("SELECT n FROM items WHERE id = ?", [moved])).rows).toEqual([{ n: moved }]);
      // Autoscaler は、Meta に残った枠から再開する。
      const jobs = splitsToResume(await c.splits(), () => false);
      expect(jobs).toEqual([{ parent: "s0", child: "s1", range }]);
      for (const j of jobs) await split(c, j.parent, j.child, { range: j.range });
      expect(await c.splits()).toEqual([]);
      expect(await outcome(new Db(c).ddl("CREATE TABLE other(id INTEGER PRIMARY KEY)"))).toBe("ok");
      const rows = (await new Db(c).query("SELECT count(*) AS n FROM items")).rows;
      expect(rows).toEqual([{ n: 40 }]);
      const [p, ch] = await Promise.all([c.shard("s0").moves({}), c.shard("s1").moves({})]);
      expect({ p, ch }).toEqual({ p: { outgoing: [], incoming: [] }, ch: { outgoing: [], incoming: [] } });
    });
  }
});

// specs/m15_maintenance_slot.qnt の m15_red_no_based_on。段 3 より前は、分割は、全シャードが最新の版を適用した後でだけ枠を取った
// (BASED_ON)。適用に失敗するシャードが、枠を取った後に取り消しの版を記録すると、分割の途中に版が進み、移動の途中の親と子は、その版を
// 断り続けたからである。段 3 で取り消しがなくなり、行で失敗する DDL は、prepare の確かめで見つかって abort になる。遷移が開いている間
// (prepare から commit か abort まで) は枠を取らず (M21 の MOVE_WAITS_DDL)、枠がある間は遷移を開かない (DDL_WAITS_MOVE) ので、
// 分割の途中に表定義の記録が入る形がない。後継の赤 (m21_red_move_during_ddl) の再生は段 4 で足す。
// ここでは、モデルの反例の始まりと同じ順で流す: 分割に関わらないシャード s1 で失敗する DDL の prepare が記録され、進める側がそこで止まる
// (s1 はまだ prepare を適用していない)。分割を進める側が枠を取ろうとする。欠陥のスイッチ splitWithoutSync (枠の前に全シャードへ適用
// させない) を入れても入れなくても、分割は遷移が終わるのを待ち、期限で abort された後に始まって終わる。
describe("a split does not start while a schema change is open, so no schema record lands mid-split (m15_red_no_based_on)", () => {
  const scenario = async (clientFaults?: ClientFaults) => {
    const c = new SimCluster({ shards: 2, clientFaults });
    const db = new Db(c);
    await db.ddl("CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, gone INTEGER, PRIMARY KEY (tenant_id, id))");
    const { routing } = await c.catalog();
    const range = planSplit(routing, "s0")!;
    const tenants = Array.from({ length: 200 }, (_, i) => i + 1);
    const on = (shard: string) => tenants.filter((t) => ownerOf(routing, JSON.stringify([t])) === shard);
    const inRange = (t: number) => slotOf(JSON.stringify([t])) >= range.start && slotOf(JSON.stringify([t])) < range.end;
    const [moved, stays, bad] = [on("s0").find(inRange)!, on("s0").find((t) => !inRange(t))!, on("s1")[0]!];
    await db.query("INSERT INTO p VALUES (?, 1, 'x', NULL), (?, 1, 'y', NULL)", [moved, stays]);
    // s1 にだけ、次の DDL に反する行を置く。空の表では通るので、Meta は prepare を記録する。
    await db.query("INSERT INTO p VALUES (?, 1, 'z', 1), (?, 2, 'z', 1)", [bad, bad]);
    // DDL を進める側は、prepare を記録した直後に止まった (どのシャードにも prepared を尋ねていない)。
    const p = await c.prepare("CREATE UNIQUE INDEX ux ON p(tenant_id, code) WHERE gone IS NOT NULL", {}, (await c.catalog()).schema);
    // 遷移が開いている間は、枠を取らない。Autoscaler は、保留の分割を次の判断でやり直す (worker.ts の runSplit)。
    const busy = await outcome(split(c, "s0", "s2", { range }));
    // 期限が過ぎるまで、何度かやり直す。
    let split2 = busy;
    for (let i = 0; i < 10 && split2 !== "ok"; i++) {
      await c.sleep(1_000);
      split2 = await outcome(split(c, "s0", "s2", { range }));
    }
    const cat = await c.catalog();
    const read = (t: number) => outcome(new Db(c, { retries: 2 }).query("SELECT code FROM p WHERE tenant_id = ? AND id = 1", [t]));
    return { busy, split: split2, aborted: cat.aborted?.of === p.epoch, reads: { parent: await read(stays), child: await read(moved) } };
  };

  it("waits for the transition to end (here: its lease lapses), and then splits; the rows stay readable", async () => {
    expect(await scenario()).toEqual({ busy: expect.stringMatching(/^split busy: schema busy:/), split: "ok", aborted: true, reads: { parent: "ok", child: "ok" } });
  });

  it("with splitWithoutSync (the slot taken without the sync before it), the same: the switch reproduces nothing since stage 3", async () => {
    expect(await scenario({ splitWithoutSync: true })).toEqual({ busy: expect.stringMatching(/^split busy: schema busy:/), split: "ok", aborted: true, reads: { parent: "ok", child: "ok" } });
  });
});

// specs/m15_maintenance_slot.qnt の m15_red_late_start。子が受け取り始める前の枠は、期限で消える。期限切れの後に届いた子の受け取りの
// 始まりは断る (EXPIRY_GUARD)。断らないと、枠のないまま分割が進み、その間に DDL が記録され、移動の途中の親と子は、その記録を断り続ける。
// モデルの反例と同じ順で流す: 分割を進める側が枠を取り (reserve)、そこで止まる。枠が期限で消える (expire)。遅れて、子の受け取りの
// 始まりが届く (beginIncoming)。DDL の prepare が記録される (record)。親がそれを適用する前に、fence が届く。新しい表定義で計画した要求が
// 親に届く。段 3 から、DDL は prepare の後で全シャードの prepared を待つので、移動の途中の親が prepare を適用できず、DDL は待ち切れずに
// abort になる。
// 実装では、親の fence の前にも、枠が生きていることを確かめる (Meta の checkSplit)。モデルには、この 2 つ目の守りがない。
describe("a child that starts receiving after the split slot lapsed (m15_red_late_start)", () => {
  const scenario = async (faults: Faults = {}) => {
    const c = new SimCluster({ shards: 1, leaseMs: 1_000, faults });
    await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    await new Db(c).query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
    const range = planSplit((await c.catalog()).routing, "s0")!;
    const stays = ids.find((id) => slotOf(JSON.stringify([id])) < range.start || slotOf(JSON.stringify([id])) >= range.end)!;
    const slot = await c.reserveSplit("s0", "s1", range);
    await c.sleep(1_100);
    const lapsed = (await c.splits()).length === 0;
    const begun = await c.shard("s1").beginIncoming({ ...range, from: "s0", slot: slot.id }).then((r) => r, (e: Error) => e);
    const started = begun instanceof Error ? begun.message : "ok";
    // DDL の prepare を記録した後、それが親へ届くのを止める (段 3 から、進める側は prepared で届ける)。その間に、分割を進める側の
    // fence が親に届く。範囲表は切り替えていないので、次の記録の epoch は、いまの epoch に 1 を足したもの。
    const next = (await c.catalog()).epoch + 1;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const hit = new Promise<void>((r) => (reached = r));
    c.net.gate = (m) => {
      if (m.to !== "s0" || !delivers(m, next)) return undefined;
      reached();
      return held;
    };
    const ddl = outcome(new Db(c, { splitWaitMs: 300 }).ddl("CREATE TABLE other(id INTEGER PRIMARY KEY)"));
    await hit;
    // 子が受け取り始めなければ、分割を進める側は fence に進まない (枠を取り直してやり直す)。
    const fenced = begun instanceof Error ? "skipped" : await outcome(c.shard("s0").fence({ ...range, to: "s1", schema: begun.schema, slot: slot.id }));
    c.net.gate = () => undefined;
    release();
    const recorded = await ddl;
    // 新しい表定義で計画した、親に残る行の読み。
    const read = await outcome(new Db(c, { retries: 2 }).query("SELECT n FROM items WHERE id = ?", [stays]));
    return { lapsed, started, fenced, recorded, read };
  };

  it("refuses the late start, so the schema change and the reads go through", async () => {
    expect(await scenario()).toEqual({ lapsed: true, started: expect.stringMatching(/no such split slot/), fenced: "skipped", recorded: "ok", read: "ok" });
  });

  it("put back the start alone: the parent's fence still checks the slot and refuses", async () => {
    expect(await scenario({ startWithoutSlot: true })).toEqual({
      lapsed: true, started: "ok", fenced: expect.stringMatching(/split slot is not held/), recorded: "ok", read: "ok",
    });
  });

  it("put back both guards: the split runs without a slot, and the parent refuses the schema records written meanwhile", async () => {
    expect(await scenario({ startWithoutSlot: true, fenceWithoutSlot: true })).toEqual({
      lapsed: true, started: "ok", fenced: "ok",
      recorded: expect.stringMatching(/waiting for a shard split on s0/), read: expect.stringMatching(/waiting for a shard split on s0/),
    });
  });
});
