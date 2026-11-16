// 分割をまたぐ取引のうち、動かない行だけを読み書きする取引は、分割の後も続けられ、確定できる。
//
// Epoch の段 2 (docs/design-catalog-epoch.md) の先に書く試験の 1 つ目である。段 2 では、要求が Worker のスナップショットの epoch と
// 表定義の epoch を運び、シャードは表定義の epoch が等しいことを確かめ、所有は自分のスナップショットで引く。epoch が等しいことを
// 求めると、分割の記録を知ったシャードが、動いていない行の、分割より前に始まった取引まで断る (M21 の m21_red_strict_epoch、
// specs/m21_catalog_epoch.qnt の pinnedSurvives)。この試験は、段 2 より前のコードで通り、段 2 の後も通り続けなければならない。
//
// 取引は、分割の前に、残る行を読んで書く。分割は、別の行の範囲を子へ動かす。取引は、分割の後も同じ範囲表と表定義で続け、
// 残る行をもう一度読み、別の残る行を書いて確定する。2 シャードの場面では、確定は 2 つのシャードの 2PC になり、分割を知った
// 親 (s0) が参加者になる。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, planSplit, tokenOf, type Interval } from "../src/routing";
import { SimCluster } from "./sim";

const ROWS = 40;
async function seeded(shards: number): Promise<SimCluster> {
  const c = new SimCluster({ shards });
  const db = new Db(c);
  await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  await db.query(`INSERT INTO t VALUES ${Array.from({ length: ROWS }, (_v, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
  return c;
}
const key = (id: number) => keyString([BigInt(id)]);
/** 行が、分割で動く区間 r に入るか。主キーが 1 列なので、shard key も主キーも同じキー文字列である。 */
const inside = (r: Interval, id: number) => {
  const t = tokenOf(key(id), key(id));
  return t >= r.start && t < r.end;
};
/** 分割で s0 から動く区間と、s0 に残る行 2 つ、動く行 1 つ、ほかのシャードの行 (あれば) を選ぶ。 */
async function choose(c: SimCluster) {
  const { routing } = await c.catalog();
  const range = planSplit(routing, "s0")!;
  const ids = Array.from({ length: ROWS }, (_v, i) => i + 1);
  const onS0 = ids.filter((id) => ownerOf(routing, key(id)) === "s0");
  const stay = onS0.filter((id) => !inside(range, id));
  const move = onS0.filter((id) => inside(range, id));
  const other = ids.find((id) => ownerOf(routing, key(id)) !== "s0");
  expect(stay.length).toBeGreaterThanOrEqual(2);
  expect(move.length).toBeGreaterThanOrEqual(1);
  return { range, a: stay[0]!, b: stay[1]!, moved: move[0]!, other };
}
const value = async (c: SimCluster, id: number) => (await new Db(c).query("SELECT v FROM t WHERE id = ?", [id])).rows[0]?.v;

describe("a transaction that touches only rows a split does not move", () => {
  for (const shards of [1, 2]) {
    it(`keeps reading its snapshot and commits (Db.begin, ${shards} shard${shards > 1 ? "s" : ""})`, async () => {
      const c = await seeded(shards);
      const { range, a, b, moved, other } = await choose(c);
      const tx = await new Db(c, { retries: 0 }).begin();
      expect((await tx.query("SELECT v FROM t WHERE id = ?", [a])).rows).toEqual([{ v: a }]);
      await tx.query("UPDATE t SET v = v + 100 WHERE id = ?", [a]);
      if (other !== undefined) await tx.query("UPDATE t SET v = v + 100 WHERE id = ?", [other]);
      await split(c, "s0", `s${shards}`, { range });
      expect(ownerOf((await c.catalog()).routing, key(moved))).toBe(`s${shards}`);
      // 別の接続が、取引の読んでいない行を、動いた行も含めて書く。取引の読みは変わらない。
      await new Db(c).query("UPDATE t SET v = -1 WHERE id = ?", [moved]);
      expect((await tx.query("SELECT v FROM t WHERE id = ?", [b])).rows).toEqual([{ v: b }]);
      expect((await tx.query("SELECT v FROM t WHERE id = ?", [a])).rows).toEqual([{ v: a + 100 }]);
      await tx.query("UPDATE t SET v = v + 1000 WHERE id = ?", [b]);
      await tx.commit();
      expect(await value(c, a)).toBe(a + 100);
      expect(await value(c, b)).toBe(b + 1000);
      if (other !== undefined) expect(await value(c, other)).toBe(other + 100);
      expect(await value(c, moved)).toBe(-1);
    });
  }

  for (const begin of ["BEGIN", "BEGIN IMMEDIATE"]) {
    it(`keeps going and commits (SQL ${begin}, 2 shards)`, async () => {
      const c = await seeded(2);
      const { range, a, b, other } = await choose(c);
      const db = new Db(c, { retries: 0 });
      await db.query(begin);
      expect((await db.query("SELECT v FROM t WHERE id = ?", [a])).rows).toEqual([{ v: a }]);
      await db.query("UPDATE t SET v = v + 100 WHERE id = ?", [a]);
      await db.query("UPDATE t SET v = v + 100 WHERE id = ?", [other!]);
      await split(c, "s0", "s2", { range });
      expect((await db.query("SELECT v FROM t WHERE id = ?", [b])).rows).toEqual([{ v: b }]);
      await db.query("UPDATE t SET v = v + 1000 WHERE id = ?", [b]);
      await db.query("COMMIT");
      expect([await value(c, a), await value(c, b), await value(c, other!)]).toEqual([a + 100, b + 1000, other! + 100]);
    });
  }
});
