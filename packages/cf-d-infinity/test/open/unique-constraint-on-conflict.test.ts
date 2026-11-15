// 未解決: 表の制約の UNIQUE に書いた衝突の処理 (`UNIQUE (email) ON CONFLICT IGNORE`) を、D∞ が知らない。
//
// SQLite では、制約に書いた ON CONFLICT が、衝突の処理を書かない文 (`INSERT INTO`、`UPDATE`) の既定になる。DDL の解釈
// (src/sql/ddl.ts の createTable) は、制約の衝突の処理を記録しない。文の計画は、衝突の処理を書かない文を、ふつうの INSERT として扱う。
// - shard key を含まない UNIQUE: シャードへ送る CREATE TABLE から制約を外し、index の表 `__gidx_*` で守る。制約の衝突の処理も消える。
//   衝突を見つけるのは Worker の UNIQUE の確かめ (src/client/db.ts の assertUnique) で、文の衝突の処理だけを見る。衝突する INSERT は、
//   IGNORE されずに `UNIQUE constraint failed` になる。REPLACE なら、行を置き換えずに誤りになる。
// - shard key を含む UNIQUE: シャードの SQLite は制約のとおり REPLACE で行を消すが、D∞ の捕捉 (RETURNING) は、消えた行を知らない。
//   行イメージの検査 (test/setup.ts) が、捕捉した行と表の行の食い違いで落ちる。
// どちらも、シャードの数に依らない (1 シャードでも同じ)。
//
// 見つけたのは、UNIQUE の文の差分の検査 (test/unique-diff.ts、docs/design-unique-keys.md の段 0 の (c)、2026-11-15。seed 9、27、99)。
// 不変条件は、計画書の規則 4 (SQLite と同じ答え) と、7 (グローバル index の項目と行の一致)、持ち主は ddl.ts の createTable (制約の
// 衝突の処理を表定義に記録しない) と、それを使わない文の計画 (src/sql/plan.ts) である。直すなら、制約の衝突の処理を表定義に記録し、
// それのある表への書き込みを、衝突の処理を書いた文と同じに計画する。
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

describe("the ON CONFLICT clause of a UNIQUE constraint", () => {
  it("IGNORE on a UNIQUE without the shard key: a plain INSERT that conflicts is ignored", async () => {
    for (const shards of [1, 3]) {
      await same("CREATE TABLE og(id INTEGER PRIMARY KEY, email TEXT, UNIQUE (email) ON CONFLICT IGNORE)", [
        "INSERT INTO og VALUES (1, 'a@x'), (2, 'b@x')",
        "INSERT INTO og VALUES (3, 'a@x')",
        "INSERT INTO og VALUES (4, 'c@x'), (5, 'c@x')",
      ], "SELECT id, email FROM og ORDER BY id", shards);
    }
  });

  it("REPLACE on a UNIQUE without the shard key: a plain INSERT that conflicts replaces the row", async () => {
    for (const shards of [1, 3]) {
      await same("CREATE TABLE og(id INTEGER PRIMARY KEY, email TEXT UNIQUE ON CONFLICT REPLACE)", [
        "INSERT INTO og VALUES (1, 'a@x'), (2, 'b@x')",
        "INSERT INTO og VALUES (3, 'a@x')",
        "UPDATE og SET email = 'b@x' WHERE id = 3",
      ], "SELECT id, email FROM og ORDER BY id", shards);
    }
  });

  it("REPLACE on a UNIQUE with the shard key: the capture knows the rows it replaced", async () => {
    // 行イメージの検査 (test/setup.ts) が、この試験の後で、捕捉した行と表の行の食い違いを報告する。
    for (const shards of [1, 3]) {
      await same("CREATE TABLE oc(tenant INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, PRIMARY KEY (tenant, id), UNIQUE (tenant, code) ON CONFLICT REPLACE)", [
        "INSERT INTO oc VALUES (1, 1, 'a'), (1, 2, 'b')",
        "INSERT INTO oc VALUES (1, 3, 'a')",
        "INSERT INTO oc VALUES (1, 4, 'c'), (1, 5, 'c')",
      ], "SELECT tenant, id, code FROM oc ORDER BY tenant, id", shards);
    }
  });
});
