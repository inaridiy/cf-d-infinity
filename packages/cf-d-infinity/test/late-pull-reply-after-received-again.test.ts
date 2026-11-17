// 直した (2026-11-17。計画書の不変条件 15、docs/design-move-messages.md、モデル M5d): 親は、渡し終えた移動の pull に、記録も印も変えずに
// 「渡し終えた」と答え、子は、受け取り中でない移動の応答を捨てる。下は、直す前 (5808b08) の欠陥の説明で、この試験は、その再現である。
//
// 直す前の欠陥 (2026-11-17、遅れた移動のメッセージの類の表 (test/history.ts の LateRow) の 6。遅れた移動のメッセージの類): 親が、終わっていない fence の下で答えた pull の応答が、子に遅れて届く。
// その間に、範囲は親へ戻り、もう一度同じ子へ移り、子はそのグループを受け取り直していた。子は、受け取り終えた移動 1 の応答を、到着の記録が
// 移動ごとにあるので新しい到着として受け取り、移動 1 のときの行を書き戻す。その後で子が消した行が、生き返る。
//
// 台本: s0 の範囲を s2 へ動かし (移動 1)、s2 で z を読む文が送る on-demand の pull の応答だけを止める (s0 は、移動 1 の fence の下で z を渡す)。
// 移動 1 は drain で z を運んで閉じる。範囲を s0 へ戻し (移動 2)、もう一度 s2 へ動かす (移動 3)。s2 が持ち主のときに z の行を消して確定し、
// 止めた応答を届ける。見つけたのは 類の見直し (2026-11-17)の D である。乱択の検査では、生成器 10 (test/move-returns.test.ts の「generator 10」)
// が「situation 6」として数え、遅れた応答が受け手の到着の記録を変えたことを報告する。モデルでは、M5d の member6Test である。
//
// 不変条件 (計画書の不変条件 15): シャードは、生きた記録 (親なら終わっていない fence、子なら受け取り中の __incoming) を持つ移動の epoch を
// 名指しする要求と応答でだけ、渡しと受け取りの記録 (__moved、__moved_txn、__arrived) を変える。メモリの印 (moved、arrived) は、その記録から
// 導く。直す前は、子 s2 が、受け取り終えた移動 1 の応答で、到着の記録と行を書いた。持ち主は、受け取った記録の入口 (src/shard/kernel.ts の
// receiving と、印を取る storePieces)。この場面は、親の側の規則だけでは止まらない (親は、生きた fence の下で、正しく渡している)。
//
// スイッチの再生 (M5d の赤の run)。childAcceptsStale は、子の規則を外す (m5d_red_child_stale の member6Test): 子は、受け取り終えた移動 1 の
// piece を受け取り、消した行が戻る。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, regionsOf } from "../src/routing";
import type { Faults } from "../src/types";
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

async function scene(faults: Faults = {}) {
  const c = new SimCluster({ shards: 2, faults });
  await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  const { routing } = await c.catalog();
  const [range] = regionsOf(routing, "s0");
  const on = (shard: string, skip = 0) => {
    for (let i = 1; ; i++) if (ownerOf(routing, keyString([BigInt(i)])) === shard && skip-- === 0) return i;
  };
  const [z, kept, y] = [on("s0"), on("s0", 1), on("s1")];
  await new Db(c).query("INSERT INTO items VALUES (?, 1), (?, 1), (?, 1)", [z, kept, y]);
  const g = keyString([BigInt(z)]);
  // s2 の drain の最初の listGroups を止め、s2 の on-demand の pull (グループ z) の応答だけを止める。親は、終わっていない fence の下で渡す。
  const gates = { list: latch(), reply: latch() };
  let [listed, held] = [false, false];
  c.net.gate = (m) => {
    if (m.from === "s2" && m.method === "listGroups" && !listed) return (listed = true), gates.list.promise;
    return undefined;
  };
  c.net.reply = (m) => {
    if (m.from === "s2" && m.to === "s0" && m.method === "pull" && !held && wants(m, g)) return (held = true), gates.reply.promise;
    return undefined;
  };
  const { epoch: move1 } = await c.moveAt("s0", "s2", range!, ["s0", "s2"]);
  const reader = new Db(c).query("SELECT n FROM items WHERE id = ?", [z]).then(() => "ok", (e: Error) => e.message);
  for (let i = 0; i < 100 && !held; i++) await c.sleep(5);
  expect(held).toBe(true);
  gates.list.resolve();
  expect(await closed(c)).toBe(true);
  await c.moveAt("s2", "s0", range!, ["s2", "s0"]);
  expect(await closed(c)).toBe(true);
  const { epoch: move3 } = await c.moveAt("s0", "s2", range!, ["s0", "s2"]);
  expect(await closed(c)).toBe(true);
  // s2 が持ち主である。z の行を消して確定し、移動 1 の止めた応答を届ける。
  await new Db(c).query("DELETE FROM items WHERE id = ?", [z]);
  const before = (await new Db(c).query("SELECT n FROM items WHERE id = ?", [z])).rows;
  // 届く前の、s2 の z の到着の記録。移動 1 と移動 3 で届いた。
  const arrivals = () => c.backends.get("s2")!.exec(`SELECT epoch FROM __arrived WHERE g = ? ORDER BY epoch`, g)
    .map((r) => (r.epoch === move1 ? "move 1" : r.epoch === move3 ? "move 3" : `epoch ${r.epoch}`));
  const arrivedBefore = arrivals();
  gates.reply.resolve();
  await reader;
  await c.settle();
  await c.sleep(200);
  const after = (await new Db(c).query("SELECT n FROM items WHERE id = ?", [z])).rows;
  return { before, arrivedBefore, after, arrived: arrivals() };
}

/** 規則の下の答え。s2 は、受け取り終えた移動 1 の応答を捨てる。消した行は戻らない。 */
const GREEN = { before: [], arrivedBefore: ["move 1", "move 3"], after: [], arrived: ["move 1", "move 3"] };

describe("the answer to a pull of a finished move, reaching the child after it received the group again in a later move", () => {
  it("is not taken as an arrival: a row the child deleted afterwards does not come back", async () => {
    expect(await scene()).toEqual(GREEN);
  });
  it("put back (childAcceptsStale): the child takes the piece of the move it finished receiving, and the row it deleted comes back", async () => {
    // m5d_red_child_stale の member6Test。持ち主の行が、確定した書き込みのとおりでなくなる (ownerHasTruth)。
    expect(await scene({ childAcceptsStale: true })).toEqual({ ...GREEN, after: [{ n: 1 }] });
  });
});
