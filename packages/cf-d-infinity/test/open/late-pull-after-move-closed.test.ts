// 未解決 (2026-11-17、生成器 10 が見つけた。遅れた移動のメッセージの類で、test/history.ts の LateRow の other): 終わった移動の遅れた pull が、
// 範囲が子に留まったまま (前の親へ戻らず、先へも渡らずに) 親に届くと、親は、その移動で運ばなかった (行も intent もなかった) グループを、
// 終わった fence で渡し直し、渡しの記録 (__moved) を足す。子は、受け取り終えた移動の応答を到着として受け取り、到着の記録 (__arrived) を足す。
// 表の 4 (親が渡し直す側) と 7 (子が受け取り終えた後に到着を足す側) を、後の移動なしで合わせた形である。生成器 10 が、不変条件 15 を破る
// 配送として、いちばん多く数える (seed 1 から 200 で、範囲が戻る実行の 78、前へ進む鎖の 57)。記録が変わるだけで、この形のままでは、
// 利用者に見える誤りはまだない。その後で範囲が親へ戻るか、子が先へ渡すと、表の 1 から 4 の結果になる。
//
// 台本: s0 の範囲を s2 へ動かし (移動 1)、s2 で z (行のないグループ) を読む文が送る on-demand の pull を止める。drain は z を運ばずに終わり、
// 移動 1 が閉じてから、止めた pull を届ける。
//
// 不変条件 (計画書の不変条件 15): シャードは、生きた記録 (親なら終わっていない fence、子なら受け取り中の __incoming) を持つ移動の epoch を
// 名指しする要求と応答でだけ、渡しと受け取りの記録 (__moved、__moved_txn、__arrived) を変える。メモリの印 (moved、arrived) は、その記録から
// 導く。持ち主は、シャードの移動の手順 (src/shard/kernel.ts の pullPieces、fetchStep、receiveStep)。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { keyString } from "../../src/keys";
import { ownerOf, regionsOf } from "../../src/routing";
import { SimCluster, type Rpc } from "../sim";

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

describe("a late pull of a finished move that reaches the parent while the range stays at the child", () => {
  it("changes neither the parent's handing records nor the child's arrival records", async () => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    const { routing } = await c.catalog();
    const [range] = regionsOf(routing, "s0");
    const on = (shard: string, skip = 0) => {
      for (let i = 1; ; i++) if (ownerOf(routing, keyString([BigInt(i)])) === shard && skip-- === 0) return i;
    };
    // z には行を置かない。drain は z を運ばない。
    const [z, kept] = [on("s0"), on("s0", 1)];
    await new Db(c).query("INSERT INTO items VALUES (?, 1)", [kept]);
    const g = keyString([BigInt(z)]);
    const gate = latch();
    let pulled = false;
    c.net.gate = (m) => {
      if (m.from === "s2" && m.method === "pull" && !pulled && wants(m, g)) return (pulled = true), gate.promise;
      return undefined;
    };
    await c.moveAt("s0", "s2", range!, ["s0", "s2"]);
    const reader = new Db(c).query("SELECT n FROM items WHERE id = ?", [z]).then(() => "ok", (e: Error) => e.message);
    for (let i = 0; i < 100 && !pulled; i++) await c.sleep(5);
    expect(pulled).toBe(true);
    // 移動 1 は、止めた pull を待たずに閉じる。
    expect(await closed(c)).toBe(true);
    gate.resolve();
    const read = await reader;
    await c.settle();
    await c.sleep(200);
    expect({
      read: /^(ok|not owner|conflict|migrating|read too old)/.test(read) ? "ok or retryable" : read,
      handed: c.backends.get("s0")!.exec(`SELECT epoch FROM __moved WHERE g = ?`, g),
      arrivals: c.backends.get("s2")!.exec(`SELECT epoch FROM __arrived WHERE g = ?`, g),
    }).toEqual({ read: "ok or retryable", handed: [], arrivals: [] });
  });
});
