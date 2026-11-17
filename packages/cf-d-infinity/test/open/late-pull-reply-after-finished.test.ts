// 未解決 (2026-11-17、consult-58 の表 (test/history.ts の LateRow) の 7。遅れた移動のメッセージの類): 親が、終わっていない fence の下で答えた pull の応答が、子が移動を
// 受け取り終えた後に届く。子は、受け取り終えた移動の応答を到着として受け取り、そのグループの到着の記録 (__arrived) を、受け取り終えた後で
// 足す。グループは運ばれていなかった (行も intent もなかった) ので、子は、受け取り終えたときに、親の時計の後で空のグループとして受け持って
// いた。後から足した到着の記録とメモリの印は、受け取り終えた後の記録とメモリを変える。グループをさらに先へ渡した後なら、到着の受け取りが、
// 先へ渡した印も外す (表の 4 の子の側。test/open/late-pull-forward-chain.test.ts)。
//
// 台本: s0 の範囲を s2 へ動かし (移動 1)、s2 で z (行のないグループ) を読む文が送る on-demand の pull を、s2 の drain が終わり、s2 が
// finishMove を送るまで止める。そこで pull を放し、finishMove を、s0 が pull に答えるまで止める (s0 は、終わっていない fence の下で z を渡す)。
// pull の応答を止め、finishMove を放す。移動 1 が閉じてから、止めた応答を届ける。consult-58 の表の 7 の台本で、見直しの試験にはなかったので
// 足した。乱択の検査では、生成器 5 (test/move-returns.test.ts と test/move-chains.test.ts の「generator 5」を OPEN=1 で流す) が「situation 7」
// として数え、遅れた応答が受け手の到着の記録を変えたことを報告する。
//
// 不変条件 (計画書の不変条件 15): シャードは、生きた記録 (親なら終わっていない fence、子なら受け取り中の __incoming) を持つ移動の epoch を
// 名指しする要求と応答でだけ、渡しと受け取りの記録 (__moved、__moved_txn、__arrived) を変える。メモリの印 (moved、arrived) は、その記録から
// 導く。ここでは、子 s2 が、受け取り終えた移動 1 の応答で、到着の記録を足した。持ち主は、シャードの移動の手順 (src/shard/kernel.ts の
// fetchStep と receiveStep)。
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
const kernelOf = (c: SimCluster, id: string) => (c.cores.get(id) as unknown as { k: { arrived: Map<string, unknown> } }).k;
const closed = async (c: SimCluster, tries = 400) => {
  for (let i = 0; i < tries && (await c.moves()).length > 0; i++) await c.sleep(50);
  return (await c.moves()).length === 0;
};

describe("the answer to a pull that the parent gave under a live fence, reaching the child after it finished receiving the move", () => {
  it("is not taken as an arrival: the child adds no arrival record to the move it finished receiving", async () => {
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
    const gates = { pull: latch(), finish: latch(), reply: latch() };
    let [pulled, finishing, answered] = [false, false, false];
    c.net.gate = (m) => {
      // s2 の on-demand の pull を、s2 が finishMove を送るまで止める (drain は z を運ばずに終わる)。
      if (m.from === "s2" && m.method === "pull" && !pulled && wants(m, g)) return (pulled = true), gates.pull.promise;
      // finishMove が来たら、止めた pull を放し、finishMove を、s0 が pull に答えるまで止める。
      if (m.from === "s2" && m.method === "finishMove" && !finishing) {
        finishing = true;
        gates.pull.resolve();
        return gates.finish.promise;
      }
      return undefined;
    };
    c.net.reply = (m) => {
      // s0 は、終わっていない fence の下で z を渡した。その応答を止めて、finishMove を放す。
      if (m.from === "s2" && m.to === "s0" && m.method === "pull" && !answered && wants(m, g)) {
        answered = true;
        gates.finish.resolve();
        return gates.reply.promise;
      }
      return undefined;
    };
    const { epoch } = await c.moveAt("s0", "s2", range!, ["s0", "s2"]);
    const reader = new Db(c).query("SELECT n FROM items WHERE id = ?", [z]).then(() => "ok", (e: Error) => e.message);
    for (let i = 0; i < 100 && !pulled; i++) await c.sleep(5);
    expect(pulled).toBe(true);
    // 移動 1 は、止めた応答を待たずに閉じる。s0 は、移動 1 で z を渡した記録を持つ。
    expect(await closed(c)).toBe(true);
    expect({
      answered,
      handed: c.backends.get("s0")!.exec(`SELECT epoch FROM __moved WHERE g = ?`, g),
      finished: c.backends.get("s2")!.exec(`SELECT done FROM __incoming WHERE epoch = ?`, epoch),
    }).toEqual({ answered: true, handed: [{ epoch }], finished: [{ done: 1 }] });
    // 止めた応答を届ける。
    gates.reply.resolve();
    const read = await reader;
    await c.settle();
    await c.sleep(200);
    expect({
      read: /^(ok|not owner|conflict|migrating|read too old)/.test(read) ? "ok or retryable" : read,
      arrivals: c.backends.get("s2")!.exec(`SELECT epoch FROM __arrived WHERE g = ?`, g),
      mark: kernelOf(c, "s2").arrived.get(g) ?? null,
    }).toEqual({ read: "ok or retryable", arrivals: [], mark: null });
  });
});
