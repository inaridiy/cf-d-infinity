// 未解決: 1 つの文の中で UNIQUE に当たるものが 2 つ以上あると、誤りの文言に、SQLite と違う制約を書く。
//
// SQLite は、行を 1 つずつ入れ、行ごとに、主キー (rowid) と、後で作った index から順に確かめる。`u INTEGER UNIQUE, ..., UNIQUE (email)`
// では、email の index が先である。D∞ は、シャードをまたぐ UNIQUE を、文を実行した後で、変更の順 × 表定義の index の順 (u が先) に
// 確かめる (src/client/db.ts の Txn.indexChanges と assertUnique)。文の行どうしの重複と、全部の行の主キーも、行ごとではなく先に確かめる。
// 文はどちらでも失敗し、表の中身は変わらない。違うのは文言だけである (OR FAIL の文は、test/open/or-fail-keeps-earlier-rows.test.ts)。
// 1 シャードでも起きる。基準経路だけの実行 (REFERENCE=scans、full) でも、複数行の文 (下の 3 つ目) で起きる。基準経路も、衝突の処理を
// 書かない INSERT のシャードをまたぐ UNIQUE の衝突を、Worker の SQLite ではなく、文の後の indexChanges で見つけるからである。
//
// 見つけたのは、UNIQUE の文の差分の検査 (test/unique-diff.ts、docs/design-unique-keys.md の段 0 の (c)、2026-11-15。seed 1、4、8、21)。
// 計画書の番号のついた不変条件には当たらない (どの置き場所でも同じに起きる)。衝突の処理の欠陥のまとまり (設計書の「段 0 の結果」) の
// 1 つで、持ち主は Worker の UNIQUE の確かめ (indexChanges、assertUnique) である。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SimCluster } from "../sim";

const DDL = "CREATE TABLE g(id INTEGER PRIMARY KEY, u INTEGER UNIQUE, email TEXT, UNIQUE (email))";

async function answers(statements: string[], shards: number) {
  const db = new SimCluster({ shards }).client();
  const lite = new DatabaseSync(":memory:");
  await db.ddl(DDL);
  lite.exec(DDL);
  const out: { sql: string; sqlite: string; ours: string }[] = [];
  for (const sql of statements) {
    const sqlite = (() => {
      try {
        return `changes ${lite.prepare(sql).run().changes}`;
      } catch (e) {
        return `ERROR ${(e as Error).message}`;
      }
    })();
    const ours = await db.query(sql).then((r) => `changes ${r.changes}`, (e: Error) => `ERROR ${e.message}`);
    out.push({ sql, sqlite, ours });
  }
  return out;
}

describe("a statement that meets two UNIQUE conflicts", () => {
  it("reports the one SQLite reports", async () => {
    for (const shards of [1, 3]) {
      const out = await answers([
        "INSERT INTO g VALUES (1, 1, 'a@x'), (2, 2, 'b@x'), (3, 3, 'c@x')",
        // 1 行が、u と email の両方で行 1 と衝突する。SQLite は email を書く。
        "INSERT INTO g VALUES (10, 1, 'a@x')",
        // 1 行目が email で、3 行目が主キーで衝突する。SQLite は 1 行目の email を書く。
        "INSERT INTO g VALUES (11, 9, 'b@x'), (12, 8, 'y@x'), (3, 7, 'z@x')",
        // 1 行目が u と email の両方で行 3 と衝突し、2 行目が u で 1 行目と重なる。SQLite は 1 行目の email を書く。
        "INSERT INTO g VALUES (13, 3, 'c@x'), (14, 3, 'q@x')",
      ], shards);
      for (const o of out) expect({ ...o, shards }).toEqual({ ...o, ours: o.sqlite, shards });
    }
  });
});
