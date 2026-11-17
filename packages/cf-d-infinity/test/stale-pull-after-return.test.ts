// 直った (2026-11-17、問題 55。問題 54 の直しで、渡した印を、グループが戻ってくるまで外さないので、遅れた pull を渡し直そうとしない): 終わった移動の遅れた pull が、範囲が戻ってきた前の親に届くと、親はそのグループを、終わった移動の fence でもう一度渡そうとし、
// 内部の誤り (UNIQUE constraint failed: __moved.g, __moved.epoch, __moved.after) で答える。その pull を待っていた利用者の文も、この誤りで
// 失敗する。
//
// 見つけたのは、範囲が前の持ち主へ戻る移動の乱択の検査 (test/move-returns.test.ts の seed 119、2026-11-16) である。移動 15 (s5 から s0) の
// 途中で、s0 の利用者の文が、まだ届いていないグループ [35] を引き取る pull (on-demand) を s5 へ送り、その配送が遅れた。その間に s0 の drain が
// [35] を引き取り、移動 15 が閉じ、移動 17 (s0 から s5、同じ区間) が始まって、s5 は move-start を適用した (moveStarted が、区間のグループの
// 「渡した」印をメモリから外す)。そこへ遅れた pull が届いた。s5 の pullPieces は、epoch 15 の fence (終わった印のあるもの) を引き、メモリに
// 印がないので新しい渡しとして __moved に (g, 15) を足そうとし、drain の pull が足した行とぶつかった。印は、SQLite に書く前にメモリへ付けて
// いるので、書き込みが失敗した後も、s5 はメモリの上で、[35] を epoch 15 で渡して ack を待つものとして持ち続ける。
//
// ここでは 1 シャードの全部の範囲を s0 から s1 へ、s1 から s0 へ動かし、1 つ目の移動の on-demand の pull を、2 つ目の移動を s0 が適用するまで
// 止める。
// 不変条件の候補: 親は、終わっていない fence の下でだけグループを渡す。終わった移動の pull は、渡し直さずに断る (要求した側は、もう
// 受け取ったか、持ち主でない)。渡した印 (メモリ) と記録 (__moved) は、同じ書き込みの後で一緒に変わる。持ち主は、送り出した側の記録
// (src/shard/kernel.ts の pullPieces、fenceOf、moveStarted)。問題 54 と同じ持ち主である。
// 直ったのは、グループが前の親へ戻る前に届く pull だけである。グループが戻った後 (前の親はまだ受け取り中) に届く pull は、同じ内部の誤りで
// 答える (2026-11-17、生成器 5 が見つけた。test/open/late-pull-while-range-returns.test.ts)。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { REGION_TOKENS } from "../src/routing";
import { SimCluster } from "./sim";

const whole = { start: 0, end: REGION_TOKENS };
const ids = Array.from({ length: 40 }, (_, i) => i + 1);
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

describe("a delayed pull of a finished move that reaches the former parent after the range came back", () => {
  it("is refused or answered without handing the group again, and the statement that waited for it does not fail with an internal error", async () => {
    const c = new SimCluster({ shards: 1 });
    await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    await new Db(c).query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
    const g = keyString([7n]);

    // 移動 1 (s0 から s1)。s1 の drain の最初の listGroups と、s1 の on-demand の pull を止める。
    let releaseList!: () => void;
    const list = new Promise<void>((r) => (releaseList = r));
    let releasePull!: () => void;
    const pull = new Promise<void>((r) => (releasePull = r));
    let pulled = false;
    let listed = false;
    c.net.gate = (m) => {
      if (m.from === "s1" && m.method === "listGroups" && !listed) {
        listed = true;
        return list;
      }
      if (m.from === "s1" && m.method === "pull" && !pulled && (m.req as { want: { g: string }[] }).want.some((w) => w.g === g)) {
        pulled = true;
        return pull;
      }
      return undefined;
    };
    await c.moveAt("s0", "s1", whole, ["s0", "s1"]);
    // 利用者の文が s1 で id 7 を読む。グループはまだ届いていないので、s1 が on-demand で pull する (止まる)。
    const reader = outcome(new Db(c).query("SELECT n FROM items WHERE id = 7"));
    for (let i = 0; i < 100 && !pulled; i++) await c.sleep(5);
    expect(pulled).toBe(true);
    // drain を進める。移動 1 は、止めた pull を待たずに閉じる。
    releaseList();
    for (let i = 0; i < 200 && (await c.moves()).length > 0; i++) await c.sleep(50);
    expect(await c.moves()).toEqual([]);

    // 移動 2 (s1 から s0)。s0 は move-start を適用して受け取り始める。そこへ、移動 1 の止めた pull が届く。
    await c.moveAt("s1", "s0", whole, ["s1", "s0"]);
    releasePull();
    const read = await reader;
    for (let i = 0; i < 400 && (await c.moves()).length > 0; i++) await c.sleep(50);
    await c.settle();

    const db = new Db(c, { retries: 5 });
    const write = await outcome(db.query("UPDATE items SET n = 70 WHERE id = 7"));
    const after = (await db.query("SELECT n FROM items WHERE id = 7")).rows;
    const wide = (await db.query("SELECT count(*) AS c FROM items")).rows;
    const internal = c.net.failed.filter((f) => /UNIQUE constraint failed: __moved/.test(f.message)).map((f) => `${f.m.from} -> ${f.m.to} ${String(f.m.method)}`);
    expect({
      read: read === "ok" || /^(not owner|conflict|migrating|read too old)/.test(read) ? "ok or retryable" : read,
      internal, write, after, wide, open: await c.moves(),
    }).toEqual({ read: "ok or retryable", internal: [], write: "ok", after: [{ n: 70 }], wide: [{ c: 40 }], open: [] });
  });
});
