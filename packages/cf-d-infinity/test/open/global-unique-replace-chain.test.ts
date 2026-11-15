// 未解決: シャードをまたぐ UNIQUE の表への複数行の OR REPLACE で、ある行が消した行が、後の行に消された行の分だけ、消えずに残る。
//
// `INSERT OR REPLACE INTO g VALUES (100, 1, 'b@x'), (101, 4, 'd@x'), (4, 4, 'b@x')` を、行 1 から 6 (u = id、email は 'a@x' から) の
// 表に流す。SQLite は、行 100 が u = 1 の行 1 と email 'b@x' の行 2 を消し、行 101 が email 'd@x' の行 4 を消し、最後の行 4 が、
// 主キーで (なし)、u = 4 で行 101 を、email 'b@x' で行 100 を消す。残るのは行 3、4 ('b@x')、5、6 である。D∞ では、行 1 が残る。
// 後の行に消される行 (100) が消した行 (1) が、消えずに残る形である。1 シャードでも、基準経路だけの実行 (REFERENCE=scans、full) でも
// 同じである。
//
// 見つけたのは、UNIQUE の文の差分の検査 (test/unique-diff.ts、docs/design-unique-keys.md の段 0 の (c)、2026-11-15。seed 61、71)。
// 計画書の番号のついた不変条件には当たらない (どの置き場所でも同じに起きる)。衝突の処理の欠陥のまとまり (設計書の「段 0 の結果」) の
// 1 つで、持ち主は基準経路の書き込み (src/client/db.ts の Txn.wasmWrite。REPLACE が消した行の捕捉。SQLite は REPLACE で消した行に
// DELETE の trigger を、recursive_triggers を有効にしたときだけ発火させる。原因は確かめていない) である。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SimCluster } from "../sim";

async function same(ddl: string, statements: string[], read: string, shards: number) {
  const db = new SimCluster({ shards }).client();
  const lite = new DatabaseSync(":memory:");
  await db.ddl(ddl);
  lite.exec(ddl);
  for (const sql of [...statements, read]) {
    const sqlite = (() => {
      try {
        const st = lite.prepare(sql);
        return st.columns().length ? JSON.stringify(st.all().map((r) => Object.values(r))) : `changes ${st.run().changes}`;
      } catch (e) {
        return `ERROR ${(e as Error).message}`;
      }
    })();
    const ours = await db.query(sql).then((r) => (r.columns.length ? JSON.stringify(r.values.map((v) => v.map((x) => (typeof x === "bigint" ? Number(x) : x)))) : `changes ${r.changes}`), (e: Error) => `ERROR ${e.message}`);
    expect({ sql, shards, ours }).toEqual({ sql, shards, ours: sqlite });
  }
}

const ROWS = "INSERT INTO g VALUES (1, 1, 'a@x'), (2, 2, 'b@x'), (3, 3, 'c@x'), (4, 4, 'd@x'), (5, 5, 'e@x'), (6, 6, 'f@x')";

describe("a multi-row OR REPLACE whose later row displaces an earlier one", () => {
  it("leaves the rows SQLite leaves, on a table with a UNIQUE that spans shards", async () => {
    for (const shards of [1, 3]) {
      await same("CREATE TABLE g(id INTEGER PRIMARY KEY, u INTEGER UNIQUE, email TEXT, UNIQUE (email))", [
        ROWS,
        "INSERT OR REPLACE INTO g VALUES (100, 1, 'b@x'), (101, 4, 'd@x'), (4, 4, 'b@x')",
      ], "SELECT id, u, email FROM g ORDER BY id", shards);
    }
  });

  it("leaves the rows SQLite leaves, with two rows of one statement", async () => {
    for (const shards of [1, 3]) {
      await same("CREATE TABLE g(id INTEGER PRIMARY KEY, u INTEGER UNIQUE, email TEXT, UNIQUE (email))", [
        ROWS,
        "INSERT OR REPLACE INTO g VALUES (116, 2, 'a@x'), (117, 2, 'c@x')",
      ], "SELECT id, u, email FROM g ORDER BY id", shards);
    }
  });
});
