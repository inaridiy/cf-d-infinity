// 未解決 (計画書の未解決の問題 37): 取引は、途中の範囲の移動 (分割) をまたげない。
//
// 約束 (docs/sql-language.md の「取引」、2026-11-15 に決めた): 取引の途中で範囲が動いても、取引は続けられる。動いた行への文は
// 新しい持ち主へ送る。動いた範囲を移動の時刻より前の読み取り時刻で読む文は、それまでの読みが今も成り立てば読み取り時刻を進めて
// 読み、成り立たなければ競合になる。どちらも、移動がなく同じ行が別の接続に書かれたときと同じ扱いである。`not owner` では失敗しない。
// 利用者は分割の時期を選べないので、分割で取引が失敗すると、答えが置き場所で変わる (AGENTS.md の規則 4)。
//
// いまは、分割の後、動いた範囲に触る文が `not owner` で断られる (置き場所の差分の検査 test/placement-differential.test.ts が、
// 300 seed で約 200 文を数えた)。持ち主は Epoch の段 2 (取引は表定義の epoch だけを名乗り、範囲表の変化では古くならない)。
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db } from "../../src/client/db";
import { keyString } from "../../src/keys";
import { ownerOf, SUBSLOTS } from "../../src/routing";
import { SimCluster } from "../sim";

const ROWS = 40;
async function seeded(): Promise<SimCluster> {
  const c = new SimCluster({ shards: 1 });
  const db = new Db(c);
  await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  await db.query(`INSERT INTO t VALUES ${Array.from({ length: ROWS }, (_v, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
  return c;
}
/** s0 の範囲の後ろ半分を s1 へ動かし、動いた行の id を返す。 */
async function splitHalf(c: SimCluster): Promise<number[]> {
  const { routing } = await c.catalog();
  const r = routing.ranges.find((x) => x.shard === "s0")!;
  const cut = Math.floor((r.start + r.end) / 2 / SUBSLOTS) * SUBSLOTS;
  await split(c, "s0", "s1", { range: { start: cut, end: r.end } });
  const after = (await c.catalog()).routing;
  return Array.from({ length: ROWS }, (_v, i) => i + 1).filter((id) => ownerOf(after, keyString([BigInt(id)])) === "s1");
}
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

describe("a transaction that a split crosses", () => {
  it("keeps reading its snapshot and writes the moved rows, then commits", async () => {
    const c = await seeded();
    const tx = await new Db(c, { retries: 0 }).begin();
    const before = (await tx.query("SELECT id, v FROM t ORDER BY id")).rows;
    const moved = await splitHalf(c);
    expect(moved.length).toBeGreaterThan(0);
    const id = moved[0]!;
    expect(await outcome(tx.query("SELECT id, v FROM t ORDER BY id"))).toBe("ok");
    expect((await tx.query("SELECT id, v FROM t ORDER BY id")).rows).toEqual(before);
    expect(await outcome(tx.query("UPDATE t SET v = v + 100 WHERE id = ?", [id]))).toBe("ok");
    expect(await outcome(tx.query("UPDATE t SET v = v + 1000 WHERE v < 3"))).toBe("ok");
    expect(await outcome(tx.commit())).toBe("ok");
    const after = (await new Db(c).query("SELECT v FROM t WHERE id = ?", [id])).rows;
    expect(after).toEqual([{ v: BigInt(id) + 100n }]);
  });

  it("fails with a conflict, not with not owner, when a row it read changed after the split", async () => {
    const c = await seeded();
    const tx = await new Db(c, { retries: 0 }).begin();
    await tx.query("SELECT id, v FROM t ORDER BY id");
    const moved = await splitHalf(c);
    await new Db(c).query("UPDATE t SET v = -1 WHERE id = ?", [moved[0]!]);
    const read = await outcome(tx.query("SELECT id, v FROM t ORDER BY id"));
    const end = read === "ok" ? await outcome(tx.query("UPDATE t SET v = 0 WHERE id = 1").then(() => tx.commit())) : read;
    expect(end).not.toMatch(/not owner/);
    expect(end).toMatch(/^(conflict|read too old)/);
  });
});
