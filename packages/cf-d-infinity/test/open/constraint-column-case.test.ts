// 未解決: 表の制約 (UNIQUE、PRIMARY KEY) に、列の定義と大文字小文字の違う綴りで列を書くと、表定義がその綴りのまま記録される。
//
// SQLite は列の名前の大文字と小文字を区別しない。`CREATE TABLE u (id INTEGER PRIMARY KEY, email TEXT, UNIQUE (EMAIL))` の
// UNIQUE は email の列に掛かる。DDL の解釈 (src/sql/ddl.ts の createTable) は、制約に書いてある文面をそのまま列の名前として
// 記録する (uniqueSets、pk)。列の定義の名前 (columns) と突き合わせない。
//
//   UNIQUE (EMAIL)      shard key (id) を含まないので、シャードをまたぐ UNIQUE として扱い、シャードへ送る CREATE TABLE から制約を外して
//                       index の表 `__gidx_u_0_key` (列は "EMAIL") を作る。重複した email の INSERT が通り、index の表には項目が
//                       1 つも入らない (シャード 4 つで確かめた)。Worker の SQLite は利用者の文をそのまま再生するので UNIQUE を持つ。
//                       以後、この表の行を Worker に集める読みは `UNIQUE constraint failed: u.email` で失敗する。シャードが 1 つでも同じ。
//   PRIMARY KEY (A)     pk と shard key が ["A"] になる。型は列 "A" で引くので見つからず、INTEGER でも rowid の別名にならない
//                       (rowidAlias は null、shard key の親和性は BLOB)。INSERT は、列をどう書いても
//                       `unsupported: NULL in the primary key column A` で断られる (誤った拒否。表が使えない)。
//
// 見つけたのは、表の制約の PRIMARY KEY の列の読み方を直しているとき (2026-11-14、`PRIMARY KEY (a COLLATE NOCASE)` の TypeError)。
// 不変条件は 7 (シャードをまたぐ UNIQUE の項目と行の一致) と 6 (行と shard key の同一性)、持ち主は ddl.ts の createTable である。
// 列の定義に書く形 (`email TEXT UNIQUE`) では起きない。`CREATE UNIQUE INDEX i ON u (EMAIL)` は no such column で断る (誤った拒否)。
// SQLite との差分 (test/diff.ts) は、`unsupported:` で断った文を飛ばすので、PRIMARY KEY の側は差分では見つからない。
// 直すなら、DDL の中の列の名指し (表の制約、CREATE INDEX) を、列の定義の綴りに直す関数を 1 つ作って、全部がそれを通す。
import { describe, expect, it } from "vitest";
import { parseDdl } from "../../src/sql/ddl";
import { diff } from "../diff";

describe("a table constraint that spells a column in another case than its definition", () => {
  it("enforces UNIQUE (EMAIL) on the column email, as SQLite does", async () => {
    for (const shards of [1, 3]) {
      const problems = await diff(`
        CREATE TABLE u (id INTEGER PRIMARY KEY, email TEXT, n INTEGER, UNIQUE (EMAIL));
        INSERT INTO u VALUES (1, 'a', 1), (2, 'b', 2), (3, 'c', 3), (4, 'd', 4);
        INSERT INTO u VALUES (5, 'a', 5);
        UPDATE u SET email = 'b' WHERE id = 4;
        SELECT id, email, n FROM u ORDER BY id;
      `, shards);
      expect(problems, `${shards} shards`).toEqual([]);
    }
  });

  it("records the defined column as the primary key, so that an INTEGER one is the rowid", () => {
    const def = parseDdl("CREATE TABLE s (a INTEGER, b TEXT, PRIMARY KEY (A))", { tables: {}, views: {}, indexes: {} }).defs[0]!;
    expect({ pk: def.pk, shardKey: def.shardKey, rowidAlias: def.rowidAlias, skAffinity: def.skAffinity })
      .toEqual({ pk: ["a"], shardKey: ["a"], rowidAlias: "a", skAffinity: ["INTEGER"] });
  });
});
