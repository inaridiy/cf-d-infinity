// autocommit の書き込みは、捕捉できる形なら高速経路 (核の directStep) で 1 回だけ実行する。別の表を読む DELETE のように、
// シャードで捕捉できないと分かった文は、高速経路をやめて、下書きして確定する道 (autoStep) へ戻る。戻るときに、制御を 1 回
// 手放す (高速経路の結果を待つ)。2026-11-14 までは、戻った後の下書きと確定を、手放す前の確かめ (持ち主、未決着の intent) の
// まま実行していた (計画書の未解決の問題 26)。
//
// 調べた結果、これは欠陥ではなかった。手放すのは microtask 1 回だけで、その間に走れるのは、同じ出来事の中で、もう起こされて
// いた待ち手 (行ロックを待っていた文) の続きだけである。待ち手は、行ロックを取るか、autocommit として書くかしかしない。
// 範囲の持ち主が変わること、intent が置かれること、表定義が変わることは、どれも別の出来事 (RPC の配送かタイマー) で起きる。
// 行ロックと書き込みは、戻った後の下書きが、その同期区間の中で見る。
//
// いまの核は、待ちの後で 1 歩を先頭から呼び直すので、戻った後も区間に入り直す (確かめは、何も変わっていなければ通るだけである)。
// この試験は、その窓に待ち手の続きが入る形を作り、結果が直列な実行のどれかになることを確かめる。
//
// 形: 行 A/1 に、確定済みで未適用の intent がある。悲観的な取引 X の UPDATE が、その行を待っている。autocommit の DELETE (Y) が
// 届く。Y は、別の表を読む条件を持つので、高速経路では捕捉できない。Y は、intent を決着させて X を起こし、高速経路を試して、戻る。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { hold, tenantOn } from "./ddl-harness";
import { SimCluster } from "./sim";

const T = `CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (tenant_id, id))`;
const U = `CREATE TABLE u(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (tenant_id, id))`;

async function scenario(seed: number) {
  const c = new SimCluster({ shards: 2, seed });
  const db = new Db(c);
  await db.ddl(T);
  await db.ddl(U);
  const A = await tenantOn(c, "s0");
  const B = await tenantOn(c, "s1");
  await db.query("INSERT INTO t VALUES (?, 1, 1)", [A]);
  await db.query("INSERT INTO u VALUES (?, 1)", [A]);
  await db.query("INSERT INTO t VALUES (?, 1, 1)", [B]);

  // 取引 W が、A/1 と B/1 を n = 2 にする。anchor は s1 (1 行余分に読む)。s0 の prepare の応答を止めて、W を未決のままにする。
  const ack = hold(c, "reply", (m) => m.method === "prepare" && m.to === "s0");
  const w = db.transaction(async (tx) => {
    await tx.query("SELECT n FROM t WHERE tenant_id = ? AND id = 2", [B]);
    await tx.query("UPDATE t SET n = 2 WHERE tenant_id = ? AND id = 1", [A]);
    await tx.query("UPDATE t SET n = 2 WHERE tenant_id = ? AND id = 1", [B]);
  });
  await ack.reached;

  // 取引 X の UPDATE は、W の intent に当たって、行を待つ (W は未決なので、intent は決着しない)。
  const x = new Db(c);
  await x.query("BEGIN");
  const xUpdate = x.query("UPDATE t SET n = n + 1 WHERE tenant_id = ? AND id = 1", [A]);
  await c.sleep(20);

  // W を確定させる。s0 への finalize は止めるので、s0 には、確定済みで未適用の intent が残る。X は待ったままである。
  let releaseFinalize!: () => void;
  const finalizeHeld = new Promise<void>((r) => (releaseFinalize = r));
  c.net.gate = (m) => (m.method === "finalize" && m.to === "s0" ? finalizeHeld : undefined);
  ack.release();
  await w;

  // autocommit の Y が届く。DELETE は捕捉できる形として送られるが、別の表を読むので、シャードは高速経路をやめて戻る。
  // Y は intent を決着させるので、X が起こされる。Y が消すのは、n = 2 のままの行だけである。
  const y = new Db(c).query(
    "DELETE FROM t WHERE tenant_id = ? AND id = 1 AND n = 2 AND EXISTS (SELECT 1 FROM u WHERE u.tenant_id = ?)", [A, A],
  );
  const xChanged = (await xUpdate).changes;
  await x.query("COMMIT");
  const yChanged = (await y).changes;
  releaseFinalize();
  await c.settle();
  const rows = (await new Db(c).query("SELECT id, n FROM t WHERE tenant_id = ? ORDER BY id", [A])).rows;
  return { xChanged, yChanged, rows };
}

describe("an autocommit write that falls back from the direct path while a woken lock waiter runs", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`ends in a state that some serial order of the three writers gives (seed ${seed})`, async () => {
      const r = await scenario(seed);
      // W が先 (n = 2)。X が Y より先なら、X は行を n = 3 にし、Y は n = 2 の行を見つけない。Y が先なら、Y が行を消し、
      // X の UPDATE は行を見つけない。両方が効いた結果 (X が 1 行を書き、Y も 1 行を消す) は、どの順でも起きない。
      const serial = [
        { xChanged: 1, yChanged: 0, rows: [{ id: 1, n: 3 }] },
        { xChanged: 0, yChanged: 1, rows: [] },
      ];
      expect(r).toBeOneOf(serial);
    });
  }
});
