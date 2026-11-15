// 未解決: 部分 index の UNIQUE もある表で、シャードの中の UNIQUE の衝突を OR REPLACE で解く文が、UNIQUE の誤りで断られる。
//
// 表 p は UNIQUE (tenant, u) と、部分 index の UNIQUE (tenant, code) WHERE n > 0 を持つ。`INSERT OR REPLACE INTO p VALUES (2, 3, 1, 'c', 1)` は、
// 主キーで行 (2, 3) と、u = 1 で行 (2, 1) と衝突する。SQLite は 2 つを消して、新しい行を入れる (変更 1 行)。D∞ はどの実行でも断る。
// - 通常の実行: `UNIQUE constraint failed: p.tenant, p.u` (文の時点)。
// - 基準経路だけの実行 (REFERENCE=scans、full) と、差分の検査の seed 430 (3 つのテナントに書く文): `UNIQUE constraint failed (unique: ...)`。
//   これは取引の確定の確かめの誤り (src/client/db.ts の Txn.commit が、シャードの答えの reason から作る) である。
// 部分 index の UNIQUE のない表では起きない (そのときは、1 シャードの autocommit でシャードの SQLite が文をそのまま実行する)。
// 見立て (確かめていない): 部分 index の UNIQUE のある表への書き込みは、行を読み得る文として扱われ (TableDef.partialUnique)、文の変更を
// 1 行ずつ本体に当てる経路を通る (シャードの確定の確かめの試適用 src/shard/kernel.ts の checkUnique など)。行 (2, 3) を u = 1 に変える
// 変更を、行 (2, 1) を消す変更より先に当てると、物理の UNIQUE index が一時的な重複を断る。1 シャードでも起きる。
//
// 見つけたのは、UNIQUE の文の差分の検査 (test/unique-diff.ts、docs/design-unique-keys.md の段 0 の (c)、2026-11-15。sim の
// SEEDS=43..500 の掃引の seed 430)。不変条件は 2 (確定した取引は必ず適用できる) の手前で、SQLite が通す文を
// 変更の当て方が断る形である。持ち主は、シャードが変更の集まりを物理の UNIQUE index のある表に当てる所である。設計の「刷新案からのずれ」
// の 6 (物理の index は一意であってはならない、M22 の m22_red_physical_unique) と同じ種類で、piece の移動がなくても、1 つの文で起きる。
// 段 3 で物理の index を一意でなくし、試適用を消すと、起きなくなる見込みである。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SimCluster } from "../sim";

const DDL = [
  "CREATE TABLE p(tenant INTEGER NOT NULL, id INTEGER NOT NULL, u INTEGER, code TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, id), UNIQUE (tenant, u))",
  "CREATE UNIQUE INDEX p_code ON p(tenant, code) WHERE n > 0",
];

describe("OR REPLACE on a table with a local UNIQUE and a partial UNIQUE", () => {
  it("replaces the rows it conflicts with, as SQLite does", async () => {
    for (const shards of [1, 3]) {
      const db = new SimCluster({ shards }).client();
      const lite = new DatabaseSync(":memory:");
      for (const d of DDL) {
        await db.ddl(d);
        lite.exec(d);
      }
      for (const sql of [
        "INSERT INTO p VALUES (2, 1, 1, 'a', 1), (2, 3, 3, 'c', 1)",
        "INSERT OR REPLACE INTO p VALUES (2, 3, 1, 'c', 1)",
        "SELECT tenant, id, u, code, n FROM p ORDER BY tenant, id",
      ]) {
        const st = lite.prepare(sql);
        const sqlite = st.columns().length ? JSON.stringify(st.all().map((r) => Object.values(r))) : `changes ${st.run().changes}`;
        const ours = await db.query(sql).then((r) => (r.columns.length ? JSON.stringify(r.values.map((v) => v.map((x) => (typeof x === "bigint" ? Number(x) : x)))) : `changes ${r.changes}`), (e: Error) => `ERROR ${e.message}`);
        expect({ sql, shards, ours }).toEqual({ sql, shards, ours: sqlite });
      }
    }
  });
});
