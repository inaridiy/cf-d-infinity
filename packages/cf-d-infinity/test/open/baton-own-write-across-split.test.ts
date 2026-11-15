// 未解決: Hrana の baton で続く取引が、分割の前に書いた行を、分割の後の文で見ない。行ロックを取る文が、取引自身の書き込みの前の値を
// 答える (COMMIT は、その後 `conflict: not owner` で失敗する)。
//
// baton は、要求ごとに取引を組み立て直す (Txn.load)。組み立て直した取引の範囲表は、その要求の接続の範囲表 (いまのもの) で、取引が
// 溜めた書き込みは、書いたときのシャードのものとして残る。書いた行が分割で動いていると、文は新しい持ち主へ送られ、その文の overlay
// (取引自身の書き込み) に、その行が入らない。`UPDATE ... RETURNING` は最新の状態で実行して行ロックを取るので、子の範囲の床にも
// 止められず、取引の書き込みの前の値に足した値を返す。段 2 より前のコード (`44306cf`) でも同じである。
// Db.begin() と SQL の BEGIN の取引は、段 2 で同じ形を断るようにした (Txn.reroute が、取引の書き込みの行が別のシャードへ動いて
// いれば競合で断る。test/transaction-own-writes-across-split.test.ts)。baton の組み立て直しには、その確かめがない。
// 見つけたのは、段 2 の作業の確かめ (2026-11-15)。不変条件の候補: 取引の文は、取引自身の書き込みを必ず見る (見られないなら答えない)。
// 持ち主は Worker の取引の層 (Txn.load)。
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db } from "../../src/client/db";
import { handlePipeline, type PipelineReq } from "../../src/client/hrana";
import { keyString } from "../../src/keys";
import { SUBSLOTS, tokenOf } from "../../src/routing";
import { SimCluster } from "../sim";

const ROWS = 40;
const key = (id: number) => keyString([BigInt(id)]);

describe("a Hrana baton transaction whose own write moved in a split", () => {
  it("does not answer a locking statement without its own write", async () => {
    const c = new SimCluster({ shards: 1 });
    const admin = new Db(c);
    await admin.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    await admin.query(`INSERT INTO t VALUES ${Array.from({ length: ROWS }, (_v, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
    const r = (await c.catalog()).routing.ranges.find((x) => x.shard === "s0")!;
    const cut = Math.floor((r.start + r.end) / 2 / SUBSLOTS) * SUBSLOTS;
    const moving = Array.from({ length: ROWS }, (_v, i) => i + 1).find((id) => tokenOf(key(id), key(id)) >= cut)!;
    let baton: string | null = null;
    const one = async (sql: string): Promise<{ type: string; response?: { result: { rows: { value?: string }[][] } } }> => {
      const req = { baton, requests: [{ type: "execute", stmt: { sql } }] } as unknown as PipelineReq;
      const res = (await handlePipeline(req, async (token) => new Db(c, { token }))) as unknown as { baton: string | null; results: never[] };
      baton = res.baton;
      return res.results[0]!;
    };
    await one("BEGIN");
    await one(`UPDATE t SET v = v + 100 WHERE id = ${moving}`);
    await split(c, "s0", "s1", { range: { start: cut, end: r.end } });
    const answer = await one(`UPDATE t SET v = v + 1 WHERE id = ${moving} RETURNING v`);
    // 答えるなら、取引自身の書き込みの後の値である。答えられないなら、誤りで断る。
    if (answer.type === "ok") expect(answer.response!.result.rows.map((row) => Number(row[0]!.value))).toEqual([moving + 101]);
    await one("ROLLBACK");
  });
});
