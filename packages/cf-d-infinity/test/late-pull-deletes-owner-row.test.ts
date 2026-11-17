// 直した (2026-11-17。計画書の不変条件 15、docs/design-move-messages.md、モデル M5d): 親は、渡し終えた移動の pull に、記録も印も変えずに
// 「渡し終えた」と答え、子は、受け取り中でない移動の応答を捨てる。下は、直す前 (5808b08) の欠陥の説明で、この試験は、その再現である。
//
// 直す前の欠陥 (2026-11-17、遅れた移動のメッセージの類の表 (test/history.ts の LateRow) の 2。遅れた移動のメッセージの類): 終わった移動の遅れた pull が、範囲が前の持ち主へ戻って受け取り終え、
// 前の持ち主 (いまの持ち主) がそのグループに行を確定した後で届くと、前の持ち主は、その行を、終わった移動の宛先へ渡し直す。宛先は受け取って
// ack を返し、前の持ち主は ack で自分の行を消す。確定した行が、持ち主から消える (宛先には残るが、宛先は持ち主でない)。
//
// 台本: s0 の範囲を s2 へ動かし (移動 1)、s2 の on-demand の pull (行のないグループ z) を止める。移動 1 が閉じ、範囲を s0 へ戻し (移動 2)、
// s0 が受け取り終えてから、z に行を確定し (1 シャードの取引)、止めた pull を届ける。表の 1 (test/late-pull-after-range-returned.test.ts) と
// 同じ場面で、届ける前に行を確定する。見つけたのは 類の見直し (2026-11-17)の B である。乱択の検査では、生成器 10 (test/move-returns.test.ts の
// 「generator 10」を OPEN=1 で流す) が、この場面を「situation 2」として数える。
//
// 不変条件 (計画書の不変条件 15): シャードは、生きた記録 (親なら終わっていない fence、子なら受け取り中の __incoming) を持つ移動の epoch を
// 名指しする要求と応答でだけ、渡しと受け取りの記録 (__moved、__moved_txn、__arrived) を変える。メモリの印 (moved、arrived) は、その記録から
// 導く。ここでは、親 s0 が、終わった fence (移動 1) の pull で、渡しの記録を足した。持ち主は、シャードの移動の手順 (src/shard/kernel.ts の
// pullPieces と fenceOf。渡し直しの ack を受ける ack)。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, regionsOf } from "../src/routing";
import { SimCluster, type Rpc } from "./sim";

const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const wants = (m: Rpc, g: string) => (m.req as { want: { g: string }[] }).want.some((w) => w.g === g);
const closed = async (c: SimCluster, tries = 400) => {
  for (let i = 0; i < tries && (await c.moves()).length > 0; i++) await c.sleep(50);
  return (await c.moves()).length === 0;
};

describe("a late pull of a finished move that reaches the former parent after the range came back and the owner committed a row in the group", () => {
  it("does not hand the row to the former child: the owner keeps its committed row", async () => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    const { routing } = await c.catalog();
    const [range] = regionsOf(routing, "s0");
    const on = (shard: string, skip = 0) => {
      for (let i = 1; ; i++) if (ownerOf(routing, keyString([BigInt(i)])) === shard && skip-- === 0) return i;
    };
    // z には行を置かない。行も intent もないグループは、移動で運ばれない。
    const [z, kept, y] = [on("s0"), on("s0", 1), on("s1")];
    await new Db(c).query("INSERT INTO items VALUES (?, 1), (?, 1)", [kept, y]);
    const g = keyString([BigInt(z)]);
    // s2 の drain の最初の listGroups と、s2 の on-demand の pull (グループ z) を止める。
    const gates = { list: latch(), pull: latch() };
    let [listed, pulled] = [false, false];
    c.net.gate = (m) => {
      if (m.from === "s2" && m.method === "listGroups" && !listed) return (listed = true), gates.list.promise;
      if (m.from === "s2" && m.method === "pull" && !pulled && wants(m, g)) return (pulled = true), gates.pull.promise;
      return undefined;
    };
    // 移動 1 (s0 から s2)。s2 で z を読む文が、on-demand の pull を送る (止まる)。drain を進め、移動 1 を閉じる。
    await c.moveAt("s0", "s2", range!, ["s0", "s2"]);
    const reader = new Db(c).query("SELECT n FROM items WHERE id = ?", [z]).then(() => "ok", (e: Error) => e.message);
    for (let i = 0; i < 100 && !pulled; i++) await c.sleep(5);
    expect(pulled).toBe(true);
    gates.list.resolve();
    expect(await closed(c)).toBe(true);
    // 移動 2 (s2 から s0)。s0 が受け取り終え、移動が閉じる。
    await c.moveAt("s2", "s0", range!, ["s2", "s0"]);
    expect(await closed(c)).toBe(true);
    // 範囲は s0 に戻った。z に行を確定する (1 シャードの取引で、何も飛んでいない)。それから、移動 1 の止めた pull を届ける。
    await new Db(c).query("INSERT INTO items VALUES (?, 7)", [z]);
    const before = (await new Db(c).query("SELECT n FROM items WHERE id = ?", [z])).rows;
    gates.pull.resolve();
    await reader;
    await c.settle();
    await c.sleep(200);
    const after = (await new Db(c).query("SELECT n FROM items WHERE id = ?", [z])).rows;
    expect({ before, after, atOwner: c.backends.get("s0")!.exec("SELECT n FROM items WHERE id = ?", z) }).toEqual({
      before: [{ n: 7 }], after: [{ n: 7 }], atOwner: [{ n: 7 }],
    });
  });
});
