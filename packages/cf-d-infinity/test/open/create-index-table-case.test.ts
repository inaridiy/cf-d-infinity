// 未解決: CREATE INDEX の ON に、表の名前を定義と違う大文字と小文字で書くと、`no such table: main.T` で断る。
//
// SQLite は表の名前の大文字と小文字を区別しない (src/sql/ddl.ts の assertFree の注釈のとおり)。DDL の解釈 (createIndex) は、
// ON の表を、表定義の鍵の綴りのまま引く (existingTable)。CREATE TABLE t のあとの `CREATE INDEX i ON T (email)` は、SQLite では通るが、
// D∞ は断る (誤った拒否。表定義と行は壊れない)。一意でない index も UNIQUE index も同じである。
//
// 見つけたのは、列の解決の検査 (test/unique-columns.ts の tableCase、docs/design-unique-keys.md の段 0 の (b)、2026-11-15)。
// 未解決の問題 31 と同じ種類 (DDL の中の名指しを、定義の綴りに解決しない) で、持ち主も同じ ddl.ts である。問題 31 の直し
// (段 1 の resolveConstraints) で、表の名前も同じ 1 つの関数で解決するのがよい。不変条件は、計画書の規則 4 の「SQLite と同じ答えを
// 返すか、文の形で断る」である (表の綴りで断るのは、形の拒否として `unsupported:` ですらない)。
// 直したら test/ へ移し、test/unique-columns.test.ts の tableCase を既定に入れる。
import { describe, expect, it } from "vitest";
import { diff } from "../diff";

describe("CREATE INDEX on a table name spelled in another case", () => {
  it("creates the index, as SQLite does", async () => {
    const problems = await diff(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT, n INTEGER);
      INSERT INTO t VALUES (1, 'a', 1), (2, 'b', 2);
      CREATE INDEX t_n ON T (n);
      CREATE UNIQUE INDEX t_email ON T (email);
      INSERT INTO t VALUES (3, 'a', 3);
      SELECT id, email, n FROM t ORDER BY id;
    `, 2);
    expect(problems).toEqual([]);
  });
});
