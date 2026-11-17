// 直した (2026-11-17。計画書の不変条件 15、docs/design-move-messages.md、モデル M5d): 親は、渡し終えた移動の pull に、記録も印も変えずに
// 「渡し終えた」と答え、子は、受け取り中でない移動の応答を捨てる。下は、直す前 (5808b08) の欠陥の説明で、この試験は、その再現である。
//
// 直す前の欠陥 (2026-11-17 に見つけた。問題 55 の残り): 終わった移動の遅れた pull が、範囲が前の持ち主へ戻って、受け取り終えた後で届くと、
// 前の持ち主は、そのグループを、終わった移動の宛先へ渡し直す。渡した印が付いたままになるので、その後でそのグループを書いた取引の
// phase 2 を、前の持ち主 (いまの持ち主) は、intent を適用せず、どこへも転送せずに、受け取ったと答える。anchor は、届け終えた印を付ける。
// intent は残り、行は取引の前のままである。読み手か再駆動が anchor に尋ねても、適用は同じ印で飛ばされる。anchor が記録を消した後
// (TXN_RETAIN_MS) は、presumed abort で捨てられ、確定した書き込みが失われる。
//
// 問題 55 は、54 の直し (渡した印を、グループが戻るまで外さない) で起きなくなったとしていた (test/stale-pull-after-return.test.ts)。
// その試験は、遅れた pull を、範囲が戻る移動の途中 (印がまだある間) に届ける。印は、範囲を受け取り終えたときに外れる (kernel.ts の
// unmarked)。その後で届いた pull は、印がないので、新しい渡しとして扱われる。運ばれなかったグループ (移動のときに行も intent もない
// グループ) では、前の移動の記録 (__moved) もないので、書き込みも通る。
//
// 見つけたのは、範囲が前の持ち主へ戻る移動の乱択の検査 (test/move-returns.test.ts) の seed 18 である。2026-11-17 の変更 (表定義の変更の
// 床を、適用の時刻に置かなくした) で、シャードが時計を読む順が変わり、同じ seed が別の実行になって、この順序に当たった。移動 3 (s2 から
// s3) の、s3 の on-demand の pull (グループ [23]) が遅れ、移動 3 が閉じ、範囲が移動 8 で s2 へ戻って受け取り終えた後で、s2 に届いた。s2 は
// [23] を epoch 3 で s3 へ渡したものとし、その後の取引 (anchor は s4) の [23] の intent を、phase 2 で適用しなかった。検査は
// 「s1: the intent of txn … (group [23]) is still there, but anchor s4 delivered its phase 2 to every participant」と報告した
// (intent は、その後の移動で s1 へ運ばれていた)。この変更の前の木 (aa1eea6) でも、下の場面は同じに落ちる。
//
// ここでは、s0 の範囲を s2 へ動かし (移動 1)、s2 の on-demand の pull (行のないグループ z) を止める。移動 1 が閉じ、範囲を s0 へ戻し
// (移動 2)、s0 が受け取り終えてから、止めた pull を届ける。その後で、z (s0) と y (s1) を書く取引を確定する。
//
// 不変条件: 親は、終わっていない fence の下でだけグループを渡す。終わった移動の pull には、渡し直さずに「渡し終えた」と答える (M5c の
// m5c_red_rehand は「断る」としていた。断ると、行のないグループを待っていた文が失敗するので、M5d が「答える」に替えた)。参加者は、intent を
// 適用したか、いまの持ち主へ転送した後でだけ、phase 2 を受け取ったと答える (問題 54 の不変条件)。持ち主は、渡した記録の入口
// (src/shard/kernel.ts の handing と、印を取る handGroup)。問題 54、55 と同じ持ち主である。
// 類の見直し (2026-11-17) が、これを遅れた移動のメッセージの類の表の 1 とした (2 から 7 は test/late-pull-*.test.ts)。類の不変条件は、
// 計画書の不変条件 15 である: シャードは、生きた記録 (親なら終わっていない fence、子なら受け取り中の __incoming) を持つ移動の epoch を名指しする
// 要求と応答でだけ、渡しと受け取りの記録を変え、メモリの印は、その記録から導く。持ち主は、シャードの移動の手順である。乱択の検査では、
// 生成器 10 (test/move-returns.test.ts の「generator 10」) が「situation 1」として数える。モデルでは、M5d の member1Test である。
//
// スイッチの再生 (M5d の赤の run)。rehandFinished は、親の規則を外す (m5d_red_rehand の rehandTest): 渡した記録が、終わった移動に付く。
// 印は記録から作るので付かず、後の取引は適用される。bootMarksDiffer を足すと (m5d_red_boot_differs の member1Test)、印を手ごとに書き換える
// ので、渡し直しの印が残り、後の取引の phase 2 は、適用も転送もされない。再起動すると、印は記録から作り直されて消える。bootMarksDiffer
// だけでは、何も変わらない (生きた記録の下の書き換えは、記録から作る印と同じである。m5d_marks_return)。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, regionsOf } from "../src/routing";
import type { Faults } from "../src/types";
import { strandedIntents } from "./history";
import { SimCluster } from "./sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
/** シャード id のメモリの、グループ g の「渡した」印 (src/shard/kernel.ts の ShardKernel の moved)。 */
const markOf = (c: SimCluster, id: string, g: string) =>
  (c.cores.get(id) as unknown as { k: { moved: Map<string, { epoch: number; acked: boolean }> } }).k.moved.get(g) ?? null;

async function scene(faults: Faults = {}) {
  const c = new SimCluster({ shards: 2, faults });
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

  // 移動 1 (s0 から s2)。s2 の drain の最初の listGroups と、s2 の on-demand の pull (グループ z) を止める。
  let releaseList!: () => void;
  const list = new Promise<void>((r) => (releaseList = r));
  let releasePull!: () => void;
  const pull = new Promise<void>((r) => (releasePull = r));
  let pulled = false;
  let listed = false;
  c.net.gate = (m) => {
    if (m.from === "s2" && m.method === "listGroups" && !listed) {
      listed = true;
      return list;
    }
    if (m.from === "s2" && m.method === "pull" && !pulled && (m.req as { want: { g: string }[] }).want.some((w) => w.g === g)) {
      pulled = true;
      return pull;
    }
    return undefined;
  };
  const { epoch: move1 } = await c.moveAt("s0", "s2", range!, ["s0", "s2"]);
  // 利用者の文が s2 で z を読む。グループはまだ届いていないので、s2 が on-demand で pull する (止まる)。
  const reader = outcome(new Db(c).query("SELECT n FROM items WHERE id = ?", [z]));
  for (let i = 0; i < 100 && !pulled; i++) await c.sleep(5);
  expect(pulled).toBe(true);
  // drain を進める。移動 1 は、止めた pull を待たずに閉じる。
  releaseList();
  for (let i = 0; i < 200 && (await c.moves()).length > 0; i++) await c.sleep(50);
  expect(await c.moves()).toEqual([]);

  // 移動 2 (s2 から s0)。s0 が受け取り終え、移動が閉じてから、移動 1 の止めた pull を届ける。
  await c.moveAt("s2", "s0", range!, ["s2", "s0"]);
  for (let i = 0; i < 400 && (await c.moves()).length > 0; i++) await c.sleep(50);
  expect(await c.moves()).toEqual([]);
  releasePull();
  const read = await reader;
  await c.settle();
  // 遅れた pull の後の、s0 の渡した記録 (__moved) と、メモリの印。
  const handed = c.backends.get("s0")!.exec(`SELECT epoch FROM __moved WHERE g = ?`, g).map((r) => (r.epoch === move1 ? "move 1" : `epoch ${r.epoch}`));
  const marked = markOf(c, "s0", g);
  const mark = marked ? `${marked.epoch === move1 ? "move 1" : `epoch ${marked.epoch}`}${marked.acked ? ", acked" : ", not acked"}` : null;

  // anchor が全参加者へ phase 2 を届け終えた取引の数 (anchor の記録の done)。
  const done = () => ["s0", "s1"].reduce((n, id) => n + c.backends.get(id)!.exec("SELECT txn FROM __txn WHERE status = 'committed' AND done = 1").length, 0);
  const before = done();
  // z (s0) と y (s1) を書く取引。確定の後、anchor が phase 2 を届け終えるまで待つ。
  const tx = await new Db(c).begin();
  await tx.query("INSERT INTO items VALUES (?, 5)", [z]);
  await tx.query("UPDATE items SET n = 5 WHERE id = ?", [y]);
  const commit = await outcome(tx.commit());
  const delivered = () => done() > before;
  for (let i = 0; i < 200 && !delivered(); i++) await c.sleep(5);
  // 読み手と再駆動が来る前に、直に SQLite を読む。
  const stranded = strandedIntents(c).length;
  const applied = c.backends.get("s0")!.exec("SELECT n FROM items WHERE id = ?", z);
  const wasDelivered = delivered();
  // 再起動すると、印は記録から作り直される。
  c.restart("s0");
  return {
    read: read === "ok" || /^(not owner|conflict|migrating|read too old)/.test(read) ? "ok or retryable" : read,
    handed, mark, commit, delivered: wasDelivered, stranded, applied, markAfterRestart: markOf(c, "s0", g),
  };
}

/** 規則の下の答え。s0 は「渡し終えた」と答え、記録も印も作らない。後の取引の phase 2 は、s0 で適用される。 */
const GREEN = { read: "ok or retryable", handed: [], mark: null, commit: "ok", delivered: true, stranded: 0, applied: [{ n: 5 }], markAfterRestart: null };

describe("a delayed pull of a finished move that reaches the former parent after it received the range back", () => {
  it("is not answered by handing the group again: a transaction that then writes the group is applied when its phase 2 arrives", async () => {
    expect(await scene()).toEqual(GREEN);
  });
  it("put back (rehandFinished): the parent records a handing in the finished move, but the marks derived from the records keep the data right", async () => {
    // m5d_red_rehand の rehandTest。破れるのは規則そのもの (handsUnderFence) で、行と intent と印は壊れない (m5dData は緑)。
    expect(await scene({ rehandFinished: true })).toEqual({ ...GREEN, handed: ["move 1"] });
  });
  it("put back (rehandFinished and bootMarksDiffer): the mark of the re-hand stays in memory, and the committed write is not applied", async () => {
    // m5d_red_boot_differs の member1Test。動いている間の印は残り、起動のときの印は外れる。
    expect(await scene({ rehandFinished: true, bootMarksDiffer: true })).toEqual({
      ...GREEN, handed: ["move 1"], mark: "move 1, not acked", stranded: 1, applied: [],
    });
  });
  it("bootMarksDiffer alone changes nothing: under a live record, the step-by-step marks equal the derived ones", async () => {
    expect(await scene({ bootMarksDiffer: true })).toEqual(GREEN);
  });
});
