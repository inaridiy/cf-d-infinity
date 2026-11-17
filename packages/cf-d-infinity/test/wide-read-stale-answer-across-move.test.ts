// 取引の全表の読みで、1 つのシャードの答えが、T を進める確かめ (Txn.advance) の間に古くなり、範囲の移動の後に読み直される場合。
//
//   1. 取引が、s1 の上の半分 (後で s2 へ移る) の行 a を読む。T = T0。
//   2. 別の接続が、s0 の行を書き換える。s0 の範囲に T0 より新しい確定ができる。
//   3. 取引の全表の読みを、fresh を付けて s0 と s1 へ送る。s0 は `moved at` と答え、取引は T を進めようとする (refresh)。
//      s1 の答えと refresh は、試験が止めておく。
//   4. その間に、s1 の上の半分が s2 へ移る。
//   5. refresh を通すと、s1 は行 a の範囲を手放しているので断る。止めていた s1 の答えを通すと、その答えは T0 の古い答えになる
//      (Txn.call の stale)。取引は s1 へ同じ文を送り直す。
//
// 読み直しの要求の claim を、取り替えた後の範囲表で作ると、s2 へ移った区間を、どのシャードにも尋ねない。数え上げは移った行を落とす。
// 正しい振る舞いは、全部の行を数えるか、文か取引を誤りで終えることである。全表の読みの区間の検査 (test/sim.ts の checkTiling) が、
// 抜けた区間を報告する。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { REGION_TOKENS, SUBSLOTS, tokenOf } from "../src/routing";
import { SimCluster } from "./sim";

const ROWS = 40;
const key = (id: number) => keyString([BigInt(id)]);
const ids = Array.from({ length: ROWS }, (_v, i) => i + 1);
const token = (id: number) => tokenOf(key(id), key(id));

describe("a transaction's whole-table read whose answer from one shard turned stale while a range of that shard moved", () => {
  it("counts every row or fails, and never drops the rows that moved", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = new Db(c);
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    await db.query(`INSERT INTO t VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
    const half = Math.floor(REGION_TOKENS / 2 / SUBSLOTS) * SUBSLOTS;
    const cut = Math.floor((REGION_TOKENS * 3) / 4 / SUBSLOTS) * SUBSLOTS;
    const moving = ids.filter((id) => token(id) >= cut);
    const onS0 = ids.filter((id) => token(id) < half);
    expect(moving.length).toBeGreaterThan(0);
    expect(onS0.length).toBeGreaterThan(0);

    const tx = await new Db(c, { retries: 0 }).begin();
    await tx.query("SELECT v FROM t WHERE id = ?", [moving[0]!]);
    await new Db(c).query("UPDATE t SET v = v + 100 WHERE id = ?", [onS0[0]!]);

    // s1 の全表の読みの答えと、取引の refresh を止める。
    let releaseReply!: () => void;
    const reply = new Promise<void>((r) => (releaseReply = r));
    let releaseRefresh!: () => void;
    const refresh = new Promise<void>((r) => (releaseRefresh = r));
    let heldReply = false;
    let heldRefresh = false;
    c.net.reply = (m) => {
      if (m.from === "client" && m.to === "s1" && m.method === "exec" && /count/i.test((m.req as { sql: string }).sql) && !heldReply) {
        heldReply = true;
        return reply;
      }
      return undefined;
    };
    c.net.gate = (m) => {
      if (m.from === "client" && m.method === "refresh" && !heldRefresh) {
        heldRefresh = true;
        return refresh;
      }
      return undefined;
    };
    const counted = tx.query("SELECT count(*) AS n FROM t").then((r) => r.rows[0], (e: Error) => `error ${e.message}`);
    for (let i = 0; i < 200 && !(heldReply && heldRefresh); i++) await c.sleep(5);
    expect({ heldReply, heldRefresh }).toEqual({ heldReply: true, heldRefresh: true });
    await c.moveAt("s1", "s2", { start: cut, end: REGION_TOKENS }, ["s1", "s2"]);
    for (let i = 0; i < 400 && (await c.moves()).length > 0; i++) await c.sleep(50);
    expect(await c.moves()).toEqual([]);
    releaseRefresh();
    await c.sleep(50);
    releaseReply();
    const out = await counted;
    if (typeof out === "string") expect(out).toMatch(/^error /);
    else expect(out).toEqual({ n: ROWS });
  });
});
