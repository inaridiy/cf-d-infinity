// 未解決: 列の定義に `INTEGER PRIMARY KEY DESC` と書いた列を、rowid の別名として記録する。
//
// SQLite では、列の定義の `INTEGER PRIMARY KEY DESC` は rowid の別名にならない (SQLite の文書の「ROWIDs and the INTEGER PRIMARY
// KEY」にある例外。表の制約の `PRIMARY KEY (x DESC)` は別名になる)。別名でない列は、ふつうの INTEGER の列で、主キーの index を持つ。
// 値を省くと NULL が入り、整数でない値も入る。DDL の解釈 (src/sql/ddl.ts の createTable の rowidAlias) は、方向を見ずに別名として
// 記録する。
//
// 見つけたのは、列の解決の検査 (test/unique-columns.ts の primaryKeyDesc、docs/design-unique-keys.md の段 0 の (b)、2026-11-15)。
// 不変条件は 6 (行と shard key の同一性) と 11 (値の格納の型)、持ち主は ddl.ts の createTable である。直すなら、rowid の別名かどうかも
// SQLite に決めさせる (段 1 の resolveConstraints で、主キーの index (index_list の origin = 'pk') の有無から読む)。
// 直したら test/ へ移し、test/unique-columns.test.ts の primaryKeyDesc を既定に入れる。
import { describe, expect, it } from "vitest";
import { parseDdl } from "../../src/sql/ddl";
import { diff } from "../diff";

describe("a column declared INTEGER PRIMARY KEY DESC", () => {
  it("is not recorded as the rowid alias", () => {
    const def = parseDdl("CREATE TABLE a (x INTEGER PRIMARY KEY DESC, y)", { tables: {}, views: {}, indexes: {} }).defs[0]!;
    expect(def.rowidAlias).toBe(null);
  });

  it("answers as SQLite does", async () => {
    for (const shards of [1, 3]) {
      const problems = await diff(`
        CREATE TABLE a (x INTEGER PRIMARY KEY DESC, y);
        INSERT INTO a (x, y) VALUES (5, 'five');
        INSERT INTO a (x, y) VALUES ('7', 'seven');
        INSERT INTO a (x, y) VALUES ('abc', 'text');
        INSERT INTO a (y) VALUES ('omitted');
        SELECT typeof(x), x, y FROM a ORDER BY y;
      `, shards);
      expect(problems, `${shards} shards`).toEqual([]);
    }
  });
});
