// 分割が持つ保守の操作の枠の終わり方 (不変条件 4、specs/m15_maintenance_slot.qnt)。
//
// 分割を進める側 (Autoscaler) は、どの段の前でも止まり得る (Worker の呼び出しの打ち切り、DO の再起動)。
//   子が受け取り始める前に止まった: 枠は期限 (5 秒) で消え、表定義の変更が通る。
//   子が受け取り始めた後に止まった: 分割は取り消せないので、枠は残り、表定義の変更は待つ。Meta の枠の一覧から再開すると、
//   分割が終わって枠が返り、表定義の変更が通る。止まっている間も、子へ移った行は読める。
import { describe, expect, it } from "vitest";
import { split, splitsToResume } from "../src/autoscaler";
import { Db, type Cluster } from "../src/client/db";
import { planSplit, slotOf } from "../src/routing";
import type { ShardApi } from "../src/types";
import { SimCluster } from "./sim";

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
