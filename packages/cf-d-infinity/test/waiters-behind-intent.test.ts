// 2026-11-14 に直した (src/shard/kernel.ts の wakeAll が列の写しをたどる): 同じ行の intent を 2 つ以上の文が待っていると、intent が決着したとき、待ち手の半分しか起こされない。
//
// 行の待ち手は、行ごとの列に並ぶ (核の waiters)。intent の決着 (finalize、abort) は、その行の待ち手を全部起こす (wakeAll)。
// wakeAll は、列を先頭から順にたどって起こす。起こされた待ち手は、その場で、同じ列から自分を消す (殻の waitForRow の leave)。
// たどっている配列から要素が抜けるので、1 つおきに飛ばされる。2 人なら 2 人目、3 人なら 2 人目が、起こされない。
// 飛ばされた待ち手は、列ごと捨てられるので、後でロックが空いても (wakeNext) 起こされない。intent を待っていた文には、保持者の
// 期限を見張るタイマーも、奪うタイマーもない。残るのは待ちの期限だけで、5 秒後に「lock wait timeout」で失敗する。
// 行はとうに空いている。
//
// 安全性は破れない (失敗するだけで、誤った答えも、失われた書き込みもない)。破れるのは「行が空いたら、待っていた文は進む」
// である。
//
// 見つけたのは、シャードを同期の核と殻に分ける作業で、待ち手の列の扱いを 1 行ずつ写していたときである (2026-11-14)。
// その作業は振る舞いを変えないので、この挙動もそのまま写してある。直すなら、wakeAll が列の写しをたどればよい。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { hold, tenantOn } from "./ddl-harness";
import { SimCluster } from "./sim";

const T = `CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (tenant_id, id))`;

/** 行 A/1 に未決の intent を置き、waiters 個の悲観的な取引に、その行の UPDATE を待たせる。intent の取引を確定させる。 */
async function queueBehindIntent(waiters: number) {
  const c = new SimCluster({ shards: 2 });
  const db = new Db(c);
  await db.ddl(T);
  const A = await tenantOn(c, "s0");
  const B = await tenantOn(c, "s1");
  await db.query("INSERT INTO t VALUES (?, 1, 0)", [A]);
  await db.query("INSERT INTO t VALUES (?, 1, 0)", [B]);

  // 取引 W が A/1 と B/1 を書く。anchor は s1 (1 行余分に読む)。s0 の prepare の応答を止めて、W を未決のままにする。
  const ack = hold(c, "reply", (m) => m.method === "prepare" && m.to === "s0");
  const w = db.transaction(async (tx) => {
    await tx.query("SELECT n FROM t WHERE tenant_id = ? AND id = 2", [B]);
    await tx.query("UPDATE t SET n = 100 WHERE tenant_id = ? AND id = 1", [A]);
    await tx.query("UPDATE t SET n = 100 WHERE tenant_id = ? AND id = 1", [B]);
  });
  await ack.reached;

  // 取引を 1 つずつ始めて、同じ行を待たせる。始まった順に古い。
  const runs: Promise<string>[] = [];
  for (let i = 0; i < waiters; i++) {
    const x = new Db(c, { retries: 0 });
    await x.query("BEGIN");
    runs.push((async () => {
      await x.query("UPDATE t SET n = n + 1 WHERE tenant_id = ? AND id = 1", [A]);
      await x.query("COMMIT");
      return "ok";
    })().catch((e: Error) => {
      void x.abandon();
      return e.message;
    }));
    await c.sleep(5);
  }

  const t0 = c.runtime.now();
  ack.release();
  await w;
  const results = await Promise.all(runs);
  const waited = c.runtime.now() - t0;
  await c.settle();
  const row = (await new Db(c).query("SELECT n FROM t WHERE tenant_id = ? AND id = 1", [A])).rows[0];
  return { results, waited, row };
}

describe("statements that wait for the same row behind an intent", () => {
  for (const waiters of [2, 3]) {
    it(`all go on, one after another, once the intent is decided (${waiters} waiters)`, async () => {
      const r = await queueBehindIntent(waiters);
      expect(r.results).toEqual(Array.from({ length: waiters }, () => "ok"));
      expect(r.row).toEqual({ n: 100 + waiters });
      // 行は、intent の決着と一緒に空く。待ちの期限 (5 秒) まで待たされる文はない。
      expect(r.waited).toBeLessThan(1000);
    });
  }
});
