// 増設の手順が途中で終わったとき、重ねて実行されたときの回帰テスト。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { planSplit } from "../src/routing";
import { drain, quiescentProblems } from "./invariants";
import { SimCluster, withOverrides } from "./sim";

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
    const range = planSplit((await c.catalog()).routing, "s0")!;
    c.net.drop = (m) => m.method === "drain" && m.from === "client" && m.to === "s1";
    await split(c, "s0", "s1", { range }).catch(() => undefined);
    c.net.drop = () => false;
    expect(await outcome(split(c, "s1", "s2"))).toMatch(/still receiving a range/);
    // 段 4 から、子は、移動を知った後は自分で終える (docs/design-catalog-epoch.md の決めたこと 4)。進める側の drain は届かなかったが、
    // 行の読みが子に届くと、子は move-start を適用して受け取り始め、そのまま移動を終える。
    expect((await census(c)).byKey).toBe(ROWS);
    await c.settle();
    expect(await census(c)).toEqual(whole);
    // 同じ分割をもう一度呼んでも、終わった分割として通る。
    expect(await outcome(split(c, "s0", "s1", { range }))).toBe("ok");
    expect(await outcome(split(c, "s1", "s2"))).toBe("ok");
    await drain(c);
    expect(await census(c)).toEqual(whole);
    expect(await quiescentProblems(c)).toEqual([]);
  }, 60_000);

  it("refuses a second split of a range that is already being handed to another shard", async () => {
    const c = await seeded();
    const range = planSplit((await c.catalog()).routing, "s0")!;
    // 1 つ目の増設は、移動を開いた (move-start を記録した) 後、子への drain が届かずに失敗した。
    const unreachable = async () => {
      throw new Error("child unreachable");
    };
    const childDown = withOverrides(c, {
      shard: (id: string) => (id === "s1" ? new Proxy(c.shard(id), { get: (t, m) => (m === "drain" ? unreachable : Reflect.get(t, m)) }) : c.shard(id)),
    });
    expect(await outcome(split(childDown, "s0", "s1", { range }))).toMatch(/child unreachable/);
    expect(await outcome(split(c, "s0", "s2"))).toMatch(/already handing slots .* to s1/);
    // Meta に直接頼んでも通らない。親が開いている移動の端である。範囲表はもう s1 を指すので、ほかの親からの移動も断る。
    await expect(c.startMove({ ...range, to: "s2", from: "s0" })).rejects.toThrow(/owned by s1, not by s0/);
    await expect(c.startMove({ start: 0, end: range.start, to: "s2", from: "s0" })).rejects.toThrow(/split busy: a move of .* from s0 to s1 is in progress/);
    await expect(c.startMove({ ...range, to: "s2", from: "s9" })).rejects.toThrow(/owned by s1, not by s9/);
    // 親は、fence の宛先でない子への pull を断る。pull は、開いている移動を epoch で名指しする。
    const [open] = await c.moves();
    await expect(c.shard("s0").pull({ ...range, want: [{ g: "[1]", from: null }], to: "s2", maxBytes: 1000, epoch: open!.epoch })).rejects.toThrow();
    // 1 つ目の増設をやり直すと終わる。行は失われていない。
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
    const stale = withOverrides(c, { catalog: async () => before });
    expect(await outcome(split(stale, "s0", "s1"))).toBe("ok");
    await drain(c);
    expect(await census(c)).toEqual(whole);
    expect((await new Db(c).query("SELECT count(*) AS n FROM items WHERE extra = 5")).rows).toEqual([{ n: ROWS }]);
    expect(await quiescentProblems(c)).toEqual([]);
  }, 60_000);
});
