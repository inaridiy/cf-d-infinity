// 範囲が前の持ち主へ戻る途中に届いた phase 2 を、前の持ち主は、intent を適用するか、intent を持つシャードへ転送してから受け取ったと答える
// (未解決の問題 54。specs/m5c_phase2_return.qnt)。
//
// 2 シャードの取引 (z は s0、y は s1。s1 が anchor) が確定を返し、s0 への phase 2 (finalize) は、まだ届いていない。z の intent は、範囲と
// 一緒に s2 へ行く (移動 1)。範囲が s0 へ戻る移動 2 で、s0 は move-start を適用して受け取り始め、まだ z を引き取っていない。そこへ phase 2 が
// 届く。s0 には z の intent がない。段 4 のコードは、z を「渡した」印を move-start の適用で外していたので、s0 は何も適用せず、どこへも
// 転送せずに答えた。anchor は、s0 への phase 2 を届け終えたものとする。z の intent は、後で範囲と一緒に s0 に届き、決着しないまま残る。
// 読み手が来れば anchor に尋ねて決着させるが、anchor が届け終えた取引の記録を消した後 (TXN_RETAIN_MS) は、presumed abort で捨てられる。
//
// いまは、印を、z が届き直したとき (receive) か、範囲を受け取り終えたとき (finishIncoming。運ばれなかったグループ) に外す (kernel.ts の
// unmarked)。印のある s0 は、phase 2 を s2 へ転送する。s2 は、まだ z を渡していなければ自分で適用し、渡していれば、移動 2 の記録で s0 へ
// 転送し返す。s0 は、piece を運ぶ転送を受けると、z を引き取ってから適用する。
// 欠陥のスイッチ unmarkOnReturn は、段 4 のコードの外し方に戻す (m5c_red_clear_at_start)。
//
// 見つけたのは、catalog epoch の段 4 で、送り出した側の記録を移動ごとにしたときである (2026-11-16)。段 4 より前は、範囲は前の持ち主へ
// 戻らなかった。test/range-returns.test.ts の phase 2 の場面は、phase 2 を両方の移動が終わった後に届けるので、この窓を通らない。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, regionsOf } from "../src/routing";
import type { Faults } from "../src/types";
import { SimCluster } from "./sim";

/** 取引を確定させ、s0 への phase 2 を、範囲が s0 へ戻る移動の途中まで止めてから届ける。restart なら、届ける前に s0 を再起動する。 */
async function scenario(faults?: Faults, restart = false) {
  const c = new SimCluster({ shards: 2, faults });
  await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  const { routing } = await c.catalog();
  const [range] = regionsOf(routing, "s0");
  const on = (shard: string, skip = 0) => {
    for (let i = 1; ; i++) if (ownerOf(routing, keyString([BigInt(i)])) === shard && skip-- === 0) return i;
  };
  const [z, y, w] = [on("s0"), on("s1"), on("s1", 1)];
  await new Db(c).query("INSERT INTO items VALUES (?, 1), (?, 1), (?, 1)", [z, y, w]);
  // s1 を anchor にする (書かずに読んだ範囲の多い参加者)。s0 への phase 2 を止める。
  let releasePhase2!: () => void;
  const phase2 = new Promise<void>((r) => (releasePhase2 = r));
  let releaseList!: () => void;
  const list = new Promise<void>((r) => (releaseList = r));
  let holdList = false;
  c.net.gate = (m) => {
    if (m.method === "finalize" && m.to === "s0") return phase2;
    if (holdList && m.from === "s0" && m.method === "listGroups") return list;
    return undefined;
  };
  // s0 が anchor からの phase 2 に答えた時点で、まだ適用されていない取引の intent の数 (s0 と s2 の分)。
  const pending = () => ["s0", "s2"].reduce((n, id) => n + (c.backends.get(id)?.exec("SELECT txn FROM __intents").length ?? 0), 0);
  let atAnswer: number | null = null;
  let armed = false;
  c.net.reply = (m) => {
    if (armed && m.method === "finalize" && m.to === "s0" && m.from === "s1") atAnswer = pending();
  };
  const tx = await new Db(c).begin();
  await tx.query("SELECT n FROM items WHERE id = ?", [w]);
  await tx.query("UPDATE items SET n = 5 WHERE id = ?", [z]);
  await tx.query("UPDATE items SET n = 5 WHERE id = ?", [y]);
  await tx.commit();
  // 移動 1: z の intent は s2 へ行く。
  expect(await split(c, "s0", "s2", { range: range! }).then(() => "ok")).toBe("ok");
  // 移動 2: s0 は受け取り始めるが、まだ何も引き取らない。
  holdList = true;
  const back = split(c, "s2", "s0", { range: range! }).then(() => "ok", (e: Error) => e.message);
  for (let i = 0; i < 200 && (await c.shard("s0").moves({})).incoming.length === 0; i++) await c.sleep(5);
  if (restart) c.restart("s0");
  // phase 2 が s0 に届き、s0 が答える。
  const answered = c.net.log.length;
  armed = true;
  releasePhase2();
  for (let i = 0; i < 200 && !c.net.log.slice(answered).some((m) => m.method === "finalize" && m.to === "s0"); i++) await c.sleep(5);
  await c.sleep(50);
  // s0 が z を引き取り、移動 2 が終わる。再起動した s0 では、進める側の drain は古い instance と一緒に失敗し、子の alarm が続きを進める。
  releaseList();
  expect(await back).toMatch(restart ? /^fenced instance/ : /^ok$/);
  for (let i = 0; i < 400 && (await c.moves()).length > 0; i++) await c.sleep(50);
  expect(await c.moves()).toEqual([]);
  await c.settle();
  // 読み手が来る前に、z の intent は決着している (適用されたか、いまの持ち主で適用された)。
  const left = pending();
  const applied = c.backends.get("s0")!.exec("SELECT n FROM items WHERE id = ?", z);
  // anchor は、全参加者へ phase 2 を届け終えた印を付けている (この印の後、TXN_RETAIN_MS で記録を消してよい)。
  const delivered = c.backends.get("s1")!.exec("SELECT done FROM __txn WHERE status = 'committed'").every((r) => r.done === 1);
  return { atAnswer, left, applied, delivered };
}

describe("phase 2 that reaches a former owner while its range is coming back", () => {
  it("is applied, or forwarded to the shard that holds the intent, before the former owner acknowledges it", async () => {
    expect(await scenario()).toEqual({ atAnswer: 0, left: 0, applied: [{ n: 5 }], delivered: true });
  });

  it("is handled the same way when the former owner restarts after it began to receive the range back", async () => {
    // 印は起動のときに表から作り直す。受け取り始めただけの範囲では外さない。
    expect(await scenario(undefined, true)).toEqual({ atAnswer: 0, left: 0, applied: [{ n: 5 }], delivered: true });
  });

  it("put back (m5c_red_clear_at_start): the former owner acknowledges it without applying or forwarding it", async () => {
    // s0 は、z の intent が s2 に残ったまま答え、anchor は届け終えた印を付ける。z の intent は s0 に残り、z の行は取引の前の値のままである。
    expect(await scenario({ unmarkOnReturn: true })).toEqual({ atAnswer: 1, left: 1, applied: [{ n: 1 }], delivered: true });
    // 再起動した s0 も、起動のときに印を外して、同じに答える。この形では、移動の終わりを待つ間に s0 の再駆動 (取り残された intent の
    // 決着) が anchor に尋ねて適用する。anchor が記録を消した後なら、presumed abort で捨てる。
    expect(await scenario({ unmarkOnReturn: true }, true)).toMatchObject({ atAnswer: 1, delivered: true });
  });
});
