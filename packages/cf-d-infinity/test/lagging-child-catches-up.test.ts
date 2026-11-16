// 遅れている子のシャードが、最新の範囲表と表定義で計画した要求を受けると、追いついてから答える。
//
// Epoch の段 2 (docs/design-catalog-epoch.md) の先に書く試験の 2 つ目である。段 2 では、要求が Worker のスナップショットの epoch と
// 表定義の epoch を運ぶ。シャードは、要求の表定義の epoch が自分より新しいか、要求の epoch が自分より新しく、要求の行が自分の
// スナップショットでは自分のものでないときに、Meta の列を適用してから確かめ直す (M21 の gate)。子は、範囲の移動の記録を
// 適用するまで、自分が宛先だと知らない。この試験は、段 2 より前のコードで通り、段 2 の後も通り続けなければならない。
//
// 1. 分割を進める側が、範囲表を切り替えた直後に止まる。子は受け取りを始めただけで、行は 1 つも届いていない。最新の範囲表を
//    持つ Worker が、動いた行を読み書きする。
// 2. 分割が終わった後、Meta に表定義の変更を記録するが、どのシャードにも適用させない。最新の表定義と範囲表を持つ Worker が、
//    動いた行に、足した列で書く。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, planSplit, tokenOf } from "../src/routing";
import { SimCluster } from "./sim";

const ROWS = 40;
async function seeded(): Promise<SimCluster> {
  const c = new SimCluster({ shards: 1 });
  const db = new Db(c);
  await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  await db.query(`INSERT INTO t VALUES ${Array.from({ length: ROWS }, (_v, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
  return c;
}
const key = (id: number) => keyString([BigInt(id)]);
const health = async (c: SimCluster, id: string) => (await c.shard(id).health({})).schema;

describe("a child shard that is behind the newest catalog", () => {
  it("serves a moved row to a Worker with the newest range table before any row was copied", async () => {
    const c = await seeded();
    const range = planSplit((await c.catalog()).routing, "s0")!;
    const moved = Array.from({ length: ROWS }, (_v, i) => i + 1).find((id) => {
      const t = tokenOf(key(id), key(id));
      return t >= range.start && t < range.end;
    })!;
    // split() の最初の 3 段だけを進めて止まる (分割を進める側の要求が切れた)。行はまだ親にある。
    const slot = await c.reserveSplit("s0", "s1", range);
    const { schema } = await c.shard("s1").beginIncoming({ ...range, from: "s0", slot: slot.id });
    await c.shard("s0").fence({ ...range, to: "s1", schema, slot: slot.id });
    await c.switchRange({ ...range, to: "s1", from: "s0" });
    expect(ownerOf((await c.catalog()).routing, key(moved))).toBe("s1");

    const db = new Db(c, { retries: 0 });
    expect((await db.query("SELECT v FROM t WHERE id = ?", [moved])).rows).toEqual([{ v: moved }]);
    await db.query("UPDATE t SET v = v + 100 WHERE id = ?", [moved]);
    expect((await new Db(c, { retries: 0 }).query("SELECT v FROM t WHERE id = ?", [moved])).rows).toEqual([{ v: moved + 100 }]);

    // 分割を最後まで進めても、行は 1 つだけで、書いた値が残る。
    await split(c, "s0", "s1");
    expect((await new Db(c).query("SELECT count(*) AS n, sum(v) AS s FROM t")).rows).toEqual([
      { n: ROWS, s: (ROWS * (ROWS + 1)) / 2 + 100 },
    ]);
  });

  it("applies a schema change it has not seen when a Worker with the newest catalog writes a moved row", async () => {
    const c = await seeded();
    const range = planSplit((await c.catalog()).routing, "s0")!;
    await split(c, "s0", "s1", { range });
    const { routing } = await c.catalog();
    const moved = Array.from({ length: ROWS }, (_v, i) => i + 1).find((id) => ownerOf(routing, key(id)) === "s1")!;
    // DDL を出した Worker が、commit を記録した後、どのシャードにも commit を適用させる前に止まった。段 3 から、commit は、全シャードが
    // prepare を適用した後でだけ記録されるので、どのシャードも prepare の epoch にいて、commit の epoch を知らない。
    await c.applyDdl("ALTER TABLE t ADD COLUMN note TEXT");
    const before = [await health(c, "s0"), await health(c, "s1")];
    expect(before[0]).toBe(before[1]);
    expect(before[1]).toBeLessThan((await c.catalog()).schema);

    const db = new Db(c, { retries: 0 });
    await db.query("UPDATE t SET note = 'x' WHERE id = ?", [moved]);
    expect((await db.query("SELECT v, note FROM t WHERE id = ?", [moved])).rows).toEqual([{ v: moved, note: "x" }]);
    // 子は、表定義の変更を適用して、親と同じ表定義になった。親は、まだ要求を受けていないので、遅れたままでよい。
    expect(await health(c, "s1")).toBeGreaterThan(before[1]!);
    await new Db(c).query("SELECT count(*) AS n FROM t WHERE note IS NULL");
    expect(await health(c, "s0")).toBe(await health(c, "s1"));
  });
});
