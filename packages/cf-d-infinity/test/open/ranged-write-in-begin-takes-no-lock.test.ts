// 未解決: SQL の BEGIN の取引の中の、主キーで 1 行に絞らない UPDATE は、行ロックを取らない。
//
// docs/sql-language.md の「取引」の表は、BEGIN と BEGIN IMMEDIATE のどちらでも「書き込みは文の時点で行ロックを取る」と書く。
// 主キーで 1 行に絞る文 (計画の write) は、そのとおり、悲観的な DML (Txn.dml) で最新の行に実行してロックを取る。主キーの範囲や
// 別の列の条件で書く文 (計画の wasmWrite) は、行を集めて Worker の SQLite で実行し、変更を溜めるだけで、ロックを取らない
// (Txn.wasmWrite は dml を通らない)。別の接続は、その行を待たずに書け、取引の COMMIT が競合 (`write after T`) で失敗する。
// 表の「COMMIT の失敗: ほぼ起きない」(BEGIN IMMEDIATE) も、この形の文では成り立たない。
// 置き場所には依らない (1 シャードでも同じ)。文の形で決まる。直すのが実装か文書かは、持ち主が決める。
//
// 見つけたのは、置き場所の差分の検査 (test/placement-differential.test.ts) の、待たされた文の扱いを決めるための確かめ (2026-11-14)。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { SimCluster } from "../sim";

describe("a ranged UPDATE inside BEGIN", () => {
  it("locks the rows it changes, so another connection's write to one of them waits for the commit", async () => {
    const c = new SimCluster({ shards: 1 });
    const admin = new Db(c);
    await admin.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    await admin.query("INSERT INTO t VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5)");

    const tx = new Db(c, { retries: 0 });
    await tx.query("BEGIN");
    await tx.query("UPDATE t SET v = v + 1 WHERE id BETWEEN 2 AND 4");
    let wrote = false;
    const other = new Db(c).query("UPDATE t SET v = v + 100 WHERE id = 3").then(() => (wrote = true));
    await c.sleep(1000);
    // 行ロックを取っていれば、別の接続の書き込みは、取引が終わるまで待つ。
    expect(wrote).toBe(false);
    await tx.query("COMMIT");
    await other;
    expect((await new Db(c).query("SELECT id, v FROM t ORDER BY id")).values).toEqual([[1, 1], [2, 3], [3, 104], [4, 5], [5, 5]]);
  });
});
