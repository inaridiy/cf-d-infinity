// 未解決: 範囲が前の持ち主へ戻る途中に届いた phase 2 を、前の持ち主が、intent を適用も転送もせずに受け取ったと答える。
//
// 2 シャードの取引 (z は s0、y は s1。s1 が anchor) が確定を返し、s0 への phase 2 (finalize) は、まだ届いていない。z の intent は、範囲と
// 一緒に s2 へ行く (移動 1)。範囲が s0 へ戻る移動 2 で、s0 は move-start を適用して受け取り始め (z を「渡した」印は、ここで外れる)、まだ z を
// 引き取っていない。そこへ phase 2 が届く。s0 には z の intent がなく、渡した印もないので、s0 は何も適用せず、どこへも転送せずに答える。
// anchor は、s0 への phase 2 を届け終えたものとする。z の intent は、後で範囲と一緒に s0 に届き、決着しないまま残る。読み手が来れば、
// anchor に尋ねて決着させるが、anchor が届け終えた取引の記録を消した後 (TXN_RETAIN_MS) は、presumed abort で捨てられる。
//
// 見つけたのは、catalog epoch の段 4 で、送り出した側の記録を移動ごとにしたときである (2026-11-16)。段 4 より前は、範囲は前の持ち主へ
// 戻らなかった。test/range-returns.test.ts の phase 2 の場面は、phase 2 を両方の移動が終わった後に届けるので、この窓を通らない。
// 不変条件の候補: 参加者は、intent を適用したか、いまの持ち主へ転送した後でだけ、phase 2 を受け取ったと答える。
// 持ち主は、送り出した側の記録 (src/shard/kernel.ts の moved、moveStarted、forwards)。
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db } from "../../src/client/db";
import { keyString } from "../../src/keys";
import { ownerOf, regionsOf } from "../../src/routing";
import { SimCluster } from "../sim";

describe("phase 2 that reaches a former owner while its range is coming back", () => {
  it("is applied, or forwarded to the shard that holds the intent, before the former owner acknowledges it", async () => {
    const c = new SimCluster({ shards: 2 });
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
    // phase 2 が s0 に届き、s0 が答える。
    const answered = c.net.log.length;
    releasePhase2();
    for (let i = 0; i < 200 && !c.net.log.slice(answered).some((m) => m.method === "finalize" && m.to === "s0"); i++) await c.sleep(5);
    await c.sleep(50);
    // s0 が z を引き取り、移動 2 が終わる。
    releaseList();
    expect(await back).toBe("ok");
    await c.settle();
    // 読み手が来る前に、z の intent は決着している (適用されたか、いまの持ち主で適用された)。
    const left = c.backends.get("s0")!.exec("SELECT txn FROM __intents").length + c.backends.get("s2")!.exec("SELECT txn FROM __intents").length;
    const applied = c.backends.get("s0")!.exec("SELECT n FROM items WHERE id = ?", z);
    // anchor は、全参加者へ phase 2 を届け終えた印を付けている (この印の後、TXN_RETAIN_MS で記録を消してよい)。
    const delivered = c.backends.get("s1")!.exec("SELECT done FROM __txn WHERE status = 'committed'").every((r) => r.done === 1);
    expect({ left, applied, delivered }).toEqual({ left: 0, applied: [{ n: 5 }], delivered: true });
  });
});
