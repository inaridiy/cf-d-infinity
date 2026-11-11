// 増設の手順が途中で終わったとき、重ねて実行されたときの回帰テスト。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db, type Cluster } from "../src/client/db";
import { planSplit } from "../src/routing";
import { drain, quiescentProblems } from "./invariants";
import { SimCluster } from "./sim";

const ROWS = 400;
async function seeded(): Promise<SimCluster> {
  const c = new SimCluster({ shards: 1 });
  await c.client().ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  for (let i = 1; i <= ROWS; i += 50) {
    await new Db(c).query(`INSERT INTO items(id, n) VALUES ${Array.from({ length: 50 }, (_, k) => `(${i + k}, ${i + k})`).join(", ")}`);
  }
  return c;
}
/** 主キーで 1 行ずつ引いて見つかった数と、表全体を数えた結果。 */
async function census(c: SimCluster): Promise<{ byKey: number; wide: number | string }> {
  let byKey = 0;
  for (let i = 1; i <= ROWS; i++) {
    byKey += await new Db(c, { retries: 2 }).query("SELECT n FROM items WHERE id = ?", [i]).then((x) => x.rows.length, () => 0);
  }
  const wide = await new Db(c, { retries: 3 }).query("SELECT count(*) AS n FROM items").then((r) => r.rows[0]!.n as number, (e: Error) => e.message);
  return { byKey, wide };
}
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const whole = { byKey: ROWS, wide: ROWS };

describe("a split that is interrupted or repeated", () => {
  it("resumes with the same range when the same command is run again after the range table was switched", async () => {
    const c = await seeded();
    c.net.drop = (m) => m.method === "drain" && m.from === "client";
    expect(await outcome(split(c, "s0", "s1"))).toMatch(/rpc dropped/);
    c.net.drop = () => false;
    expect(await outcome(split(c, "s0", "s1"))).toBe("ok");
    expect(await census(c)).toEqual(whole);
    const moves = await Promise.all(["s0", "s1"].map((id) => c.shard(id).moves({})));
    expect(moves).toEqual([{ outgoing: [], incoming: [] }, { outgoing: [], incoming: [] }]);
    expect(await quiescentProblems(c)).toEqual([]);
  }, 60_000);

  it("refuses to split a shard that is still receiving its range, and works once that finished", async () => {
    const c = await seeded();
    c.net.drop = (m) => m.method === "drain" && m.from === "client" && m.to === "s1";
    await split(c, "s0", "s1").catch(() => undefined);
    c.net.drop = () => false;
    expect(await outcome(split(c, "s1", "s2"))).toMatch(/still receiving a range/);
    expect(await census(c)).toEqual({ byKey: ROWS, wide: expect.stringMatching(/migrating/) });
    expect(await outcome(split(c, "s0", "s1"))).toBe("ok");
    expect(await outcome(split(c, "s1", "s2"))).toBe("ok");
    await drain(c);
    expect(await census(c)).toEqual(whole);
    expect(await quiescentProblems(c)).toEqual([]);
  }, 60_000);

  it("refuses a second split of a range that is already being handed to another shard", async () => {
    const c = await seeded();
    const range = planSplit((await c.catalog()).routing, "s0")!;
    // 1 つ目の増設は、子の受け入れと親の fence の後、範囲表の切り替えで失敗した。
    const metaDown: Cluster = {
      shard: (id) => c.shard(id), catalog: () => c.catalog(), applyDdl: (q) => c.applyDdl(q), publishIndex: (t, n, v, at) => c.publishIndex(t, n, v, at), revokeDdl: (v, r) => c.revokeDdl(v, r), renewLock: (v) => c.renewLock(v), lockTables: (t, b) => c.lockTables(t, b), finishLock: (v, q) => c.finishLock(v, q), beginSplit: (m, b) => c.beginSplit(m, b), endSplit: (id) => c.endSplit(id), splits: () => c.splits(),
      allocate: (t, n, m) => c.allocate(t, n, m), switchRange: async () => { throw new Error("meta unreachable"); },
    };
    expect(await outcome(split(metaDown, "s0", "s1", { range }))).toMatch(/meta unreachable/);
    expect(await outcome(split(c, "s0", "s2"))).toMatch(/already handing slots .* to s1/);
    // シャードに直接頼んでも通らない。
    // 枠を示さない fence も、枠のある別の子への fence も通らない。
    await expect(c.shard("s0").fence({ ...range, to: "s2", slot: "none" })).rejects.toThrow(/split slot/);
    await expect(c.shard("s0").pull({ groups: ["[1]"], to: "s2", maxBytes: 1000 })).rejects.toThrow();
    await expect(c.switchRange({ ...range, to: "s2", from: "s9" })).rejects.toThrow(/owned by s0, not by s9/);
    // 1 つ目の増設をやり直すまで、その範囲は読めない (親は fence 済みで、範囲表はまだ親を指している)。行は失われていない。
    expect(await outcome(split(c, "s0", "s1", { range }))).toBe("ok");
    await drain(c);
    expect(await census(c)).toEqual(whole);
    expect(await quiescentProblems(c)).toEqual([]);
  }, 60_000);

  it("works when the split was planned with a schema older than the parent's", async () => {
    const c = await seeded();
    const before = await c.catalog();
    await c.client().ddl("ALTER TABLE items ADD COLUMN extra INTEGER DEFAULT 5");
    // 増設を始めた側は、DDL の前の表定義を持っている。親はすでに新しい版にいる。
    const stale: Cluster = {
      shard: (id) => c.shard(id), catalog: async () => before, applyDdl: (q) => c.applyDdl(q), publishIndex: (t, n, v, at) => c.publishIndex(t, n, v, at), revokeDdl: (v, r) => c.revokeDdl(v, r), renewLock: (v) => c.renewLock(v), lockTables: (t, b) => c.lockTables(t, b), finishLock: (v, q) => c.finishLock(v, q), beginSplit: (m, b) => c.beginSplit(m, b), endSplit: (id) => c.endSplit(id), splits: () => c.splits(),
      allocate: (t, n, m) => c.allocate(t, n, m), switchRange: (m) => c.switchRange(m),
    };
    expect(await outcome(split(stale, "s0", "s1"))).toBe("ok");
    await drain(c);
    expect(await census(c)).toEqual(whole);
    expect((await new Db(c).query("SELECT count(*) AS n FROM items WHERE extra = 5")).rows).toEqual([{ n: ROWS }]);
    expect(await quiescentProblems(c)).toEqual([]);
  }, 60_000);
});
