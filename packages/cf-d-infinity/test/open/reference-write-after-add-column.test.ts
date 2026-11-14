// 未解決: 計画した後に ADD COLUMN が入ると、基準経路の書き込みが、足された列の値を既定値で上書きする。
//
// Db.transaction は、やり直すたびに表定義を取り直すが、文の計画 (Plan) は最初のものを使い続ける。基準経路の書き込み
// (Txn.wasmWrite) は、Worker の SQLite を新しい表定義 (取引の catalog) で作り、行を集める走査は計画の表定義の列だけを読む
// (src/sql/plan.ts の scanList)。足された列は集めた行に入らないので、Worker の SQLite では既定値になる。文がその列に触らなくても、
// 捕捉した変更後の行は既定値を持ち、シャードの確定した値を上書きする。
// 段 1 までは、変更後の行を Worker の SQLite の本体から読み直していたので、同じく既定値を書いた。段 2 のタプルの捕捉も同じである
// (trigger は取引の catalog で作る。src/client/db.ts の wasmWrite)。値の作り直しの段 2 で、行イメージの検査を基準経路だけの実行の
// test/ddl-concurrent.test.ts に掛けたときに、計画と取引の表定義の食い違いとして見つけた (2026-11-14)。
//
// 正しい振る舞い: 文が触らない列の値は、確定した値のまま残る。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { SimCluster } from "../sim";

describe("a reference-path write planned before an ADD COLUMN", () => {
  it("keeps the value of the added column that the statement does not touch", async () => {
    const c = new SimCluster({ shards: 2 });
    // 古い表定義を覚えた接続。文を基準経路で実行する。
    const stale = new Db(c, { reference: "full" });
    await stale.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)");
    await stale.query("INSERT INTO t VALUES (1, 0)");
    // 別の接続が列を足し、その列に値を書く。
    const other = new Db(c);
    await other.ddl("ALTER TABLE t ADD COLUMN extra TEXT DEFAULT 'd'");
    await other.query("UPDATE t SET extra = 'v' WHERE id = 1");
    // 古い接続が、足された列に触らない書き込みをする。シャードは古い版の要求を断り、取引は表定義を取り直してやり直す。
    await stale.query("UPDATE t SET n = n + 1 WHERE id = 1");
    expect((await other.query("SELECT id, n, extra FROM t")).rows).toEqual([{ id: 1, n: 1, extra: "v" }]);
  });
});
