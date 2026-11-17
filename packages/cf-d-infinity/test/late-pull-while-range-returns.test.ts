// 直した (2026-11-17。計画書の不変条件 15、docs/design-move-messages.md、モデル M5d): 親は、渡し終えた移動の pull に、記録も印も変えずに
// 「渡し終えた」と答え、子は、受け取り中でない移動の応答を捨てる。下は、直す前 (5808b08) の欠陥の説明で、この試験は、その再現である。
//
// 直す前の欠陥 (2026-11-17、生成器 10 が見つけた。遅れた移動のメッセージの類で、遅れた移動のメッセージの類の表 (test/history.ts の LateRow) にない形。LateRow の returning): 終わった移動の遅れた pull が、範囲が前の
// 持ち主へ戻る途中 (前の持ち主が受け取り中) で、そのグループが前の持ち主へもう届いた後に届くと、前の持ち主は、そのグループを渡し直そうと
// して、内部の誤り (UNIQUE constraint failed: __moved.g, __moved.epoch, __moved.after) で答える。その pull を待っていた利用者の文も、この誤りで
// 失敗する。問題 55 の誤りと同じである。
//
// 問題 55 (test/stale-pull-after-return.test.ts) は、遅れた pull を、範囲が戻る移動を前の持ち主が適用した直後 (グループがまだ届く前) に届け、
// 54 の直し (渡した印を、グループが戻るまで外さない) で通るようになった。印は、グループが届いたときに外れる (src/shard/kernel.ts の
// receiveStep)。その後で届いた pull は、印がないので、新しい渡しとして __moved に (g, 移動 1) を足そうとし、移動 1 の drain が足した行と
// ぶつかる。表の 3 (test/late-pull-of-carried-group.test.ts) は、同じことを、前の持ち主が受け取り終えた後に届けて起こす。
// 乱択の検査では、生成器 10 (test/move-returns.test.ts の「generator 10」) が「situation returning」として数え、内部の誤りの
// 検査が見つける。
//
// 台本: 1 シャードの全部の範囲を s0 から s1 へ動かし (移動 1)、s1 で id 7 を読む文が送る on-demand の pull を止める。移動 1 は drain で
// グループを運んで閉じる。範囲を s1 から s0 へ戻し (移動 2)、s0 の finishMove を止めて、s0 を受け取り中のままにする。グループが s0 に届いて
// から、止めた pull を届ける。
//
// 不変条件 (計画書の不変条件 15): シャードは、生きた記録 (親なら終わっていない fence、子なら受け取り中の __incoming) を持つ移動の epoch を
// 名指しする要求と応答でだけ、渡しと受け取りの記録 (__moved、__moved_txn、__arrived) を変える。メモリの印 (moved、arrived) は、その記録から
// 導く。ここでは、親 s0 が、終わった fence (移動 1) の pull で渡しを始めた。s0 は、移動 2 を受け取り中だが、移動 1 の生きた記録はない。
// 持ち主は、シャードの移動の手順 (src/shard/kernel.ts の pullPieces と fenceOf)。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { REGION_TOKENS } from "../src/routing";
import { SimCluster, type Rpc } from "./sim";

const whole = { start: 0, end: REGION_TOKENS };
const ids = Array.from({ length: 40 }, (_, i) => i + 1);
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

describe("a late pull of a finished move that reaches the former parent while the range comes back, after the group already came back", () => {
  it("is refused or answered without handing the group again, and the statement that waited for it does not fail with an internal error", async () => {
    const c = new SimCluster({ shards: 1 });
    await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    await new Db(c).query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
    const g = keyString([7n]);
    const gates = { list: latch(), pull: latch(), finish: latch() };
    let [listed, pulled, finishing] = [false, false, false];
    c.net.gate = (m) => {
      if (m.from === "s1" && m.method === "listGroups" && !listed) return (listed = true), gates.list.promise;
      if (m.from === "s1" && m.method === "pull" && !pulled && wants(m, g)) return (pulled = true), gates.pull.promise;
      // 移動 2 の、s0 の finishMove を止める。s0 は受け取り中のままである。
      if (m.from === "s0" && m.to === "s1" && m.method === "finishMove" && !finishing) return (finishing = true), gates.finish.promise;
      return undefined;
    };
    // 移動 1 (s0 から s1)。s1 で id 7 を読む文の on-demand の pull を止め、drain を進めて閉じる。
    await c.moveAt("s0", "s1", whole, ["s0", "s1"]);
    const reader = new Db(c).query("SELECT n FROM items WHERE id = 7").then(() => "ok", (e: Error) => e.message);
    for (let i = 0; i < 100 && !pulled; i++) await c.sleep(5);
    expect(pulled).toBe(true);
    gates.list.resolve();
    expect(await closed(c)).toBe(true);
    // 移動 2 (s1 から s0)。s0 の drain がグループを引き取り、finishMove で止まる。
    const { epoch } = await c.moveAt("s1", "s0", whole, ["s1", "s0"]);
    for (let i = 0; i < 400 && !finishing; i++) await c.sleep(5);
    expect({ finishing, back: c.backends.get("s0")!.exec(`SELECT epoch FROM __arrived WHERE g = ?`, g).map((r) => r.epoch).includes(epoch) }).toEqual({ finishing: true, back: true });
    // グループは s0 に戻った。s0 はまだ受け取り中である。そこへ、移動 1 の止めた pull を届ける。
    gates.pull.resolve();
    const read = await reader;
    gates.finish.resolve();
    expect(await closed(c)).toBe(true);
    await c.settle();
    const internal = c.net.failed.filter((f) => /UNIQUE constraint failed: __moved/.test(f.message)).map((f) => `${f.m.from} -> ${f.m.to} ${String(f.m.method)}`);
    const db = new Db(c, { retries: 5 });
    const write = await db.query("UPDATE items SET n = 70 WHERE id = 7").then(() => "ok", (e: Error) => e.message);
    const after = (await db.query("SELECT n FROM items WHERE id = 7")).rows;
    expect({
      read: read === "ok" || /^(not owner|conflict|migrating|read too old)/.test(read) ? "ok or retryable" : read,
      internal, write, after,
    }).toEqual({ read: "ok or retryable", internal: [], write: "ok", after: [{ n: 70 }] });
  });
});
