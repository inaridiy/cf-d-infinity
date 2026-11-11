// 未解決: 分割を進める側が、親の fence の後、範囲表の切り替えの前に止まると、移る範囲の行を誰も答えない。
//
// 範囲表はまだ親を指している。親は fence したので、その範囲の要求を「持ち主は子だ」と断る。Worker は範囲表を取り直すが、
// 範囲表は変わっていないので、また親へ送り、やり直しを使い切って誤りを返す。Autoscaler が分割を再開するまで (最長で判断の
// 間隔、1 分)、その範囲は読めも書けもしない。
//
// 見つけたのは、分割の枠の試験 (test/split-slot.test.ts) を書いたときである (2026-11-11)。枠とは関係なく、それより前からある。
// 計画書の未解決の問題 17。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { planSplit, slotOf } from "../../src/routing";
import { SimCluster } from "../sim";

describe("a split stopped between the parent's fence and the range-table switch", () => {
  it("still answers reads and writes for the moving range", async () => {
    const c = new SimCluster({ shards: 1 });
    await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    await new Db(c).query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
    const range = planSplit((await c.catalog()).routing, "s0")!;
    const moved = ids.find((id) => slotOf(JSON.stringify([id])) >= range.start && slotOf(JSON.stringify([id])) < range.end)!;
    const slot = await c.reserveSplit("s0", "s1", range);
    const { schema } = await c.shard("s1").beginIncoming({ ...range, from: "s0", slot: slot.id });
    await c.shard("s0").fence({ ...range, to: "s1", schema, slot: slot.id });
    // ここで分割を進める側が止まる。範囲表は切り替わっていない。
    const read = await new Db(c).query("SELECT n FROM items WHERE id = ?", [moved]).then((r) => r.rows, (e: Error) => e.message);
    const write = await new Db(c).query("UPDATE items SET n = 0 WHERE id = ?", [moved]).then(() => "ok", (e: Error) => e.message);
    expect({ read, write }).toEqual({ read: [{ n: moved }], write: "ok" });
  });
});
