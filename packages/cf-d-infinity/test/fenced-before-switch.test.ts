// 分割を進める側が、親の fence の後で止まっても、移る範囲の行は読めて書ける (計画書の未解決の問題 17。M21 の m21_red_fence_first)。
//
// 段 4 より前は、親の fence が、範囲表の切り替えより先の別の手だった。進める側が間で止まると、範囲表は親を指したまま、親は fence した
// ので、その範囲の要求を「持ち主は子だ」と断る。Worker は範囲表を取り直すが、範囲表は変わっていないので、また親へ送り、やり直しを
// 使い切って誤りを返した。Autoscaler が分割を再開するまで (最長で判断の間隔、1 分)、その範囲は読めも書けもしなかった。
// 見つけたのは、分割の枠の試験 (test/split-slot.test.ts) を書いたときである (2026-11-11)。この試験は test/open/ にあり、段 4 で通った。
//
// 段 4 で、親の fence は、Meta の列の move-start を親が適用することになった (docs/design-catalog-epoch.md の「未解決の問題 17 は
// 閉じるか」)。親が区間を断る時点で、Meta の列には、子を宛先にした範囲表がある。断られた Worker が範囲表を取り直せば、子へ送り、子は
// 記録を適用して受け取り始め、行を親から引き取って答える。ここでは、モデルの反例と同じ形を作る。進める側は、移動を開いて、親にだけ
// 適用させ (fence)、子に知らせる前に止まる。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { planSplit, slotOf } from "../src/routing";
import { SimCluster } from "./sim";

describe("a split stopped right after the parent's fence", () => {
  it("still answers reads and writes for the moving range, through a fresh Worker and through one holding the old range table", async () => {
    const c = new SimCluster({ shards: 1 });
    await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    await new Db(c).query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
    const range = planSplit((await c.catalog()).routing, "s0")!;
    const moving = ids.filter((id) => slotOf(JSON.stringify([id])) >= range.start && slotOf(JSON.stringify([id])) < range.end);
    // 分割の前の範囲表を持ったままの接続。
    const stale = new Db(c);
    await stale.query("SELECT n FROM items WHERE id = 1");
    // 移動を開き、親にだけ適用させる (fence)。ここで分割を進める側が止まる。子は何も知らない。
    await c.moveAt("s0", "s1", range, ["s0"]);
    expect(await c.shard("s0").moves({})).toEqual({ outgoing: [{ ...range, to: "s1" }], incoming: [] });
    const [a, b] = [moving[0]!, moving[1]!];
    const read = (db: Db, id: number) => db.query("SELECT n FROM items WHERE id = ?", [id]).then((r) => r.rows, (e: Error) => e.message);
    const write = (db: Db, id: number) => db.query("UPDATE items SET n = 0 WHERE id = ?", [id]).then(() => "ok", (e: Error) => e.message);
    expect({ read: await read(new Db(c), a), write: await write(new Db(c), a) }).toEqual({ read: [{ n: a }], write: "ok" });
    expect({ read: await read(stale, b), write: await write(stale, b) }).toEqual({ read: [{ n: b }], write: "ok" });
  });
});
