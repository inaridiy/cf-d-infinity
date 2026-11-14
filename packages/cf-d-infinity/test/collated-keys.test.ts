// 照合順序 (NOCASE など) のある列は、主キー、shard key、シャードをまたぐ UNIQUE には使えない。
// 行の同一性を値そのもので決めているので、'abc' と 'ABC' を同じ行として扱う規則を、経路、分割、ロック、検証のすべてで
// 揃える必要がある。揃えきるまでは、黙って通さずに断る。キーでない列の照合順序は、SQLite がそのまま扱う。
import { describe, expect, it } from "vitest";
import { diff } from "./diff";
import { SimCluster } from "./sim";

describe("collations on key columns", () => {
  it("are refused on the primary key, the shard key and a UNIQUE that spans shards", async () => {
    const db = new SimCluster({ shards: 2 }).client();
    for (const sql of [
      "CREATE TABLE a(name TEXT COLLATE NOCASE PRIMARY KEY, n INTEGER)",
      "CREATE TABLE a(tenant TEXT COLLATE RTRIM NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (tenant, id))",
      "CREATE TABLE a(tenant_id INTEGER NOT NULL, code TEXT COLLATE NOCASE NOT NULL, PRIMARY KEY (tenant_id, code))",
      "CREATE TABLE a(id INTEGER PRIMARY KEY, email TEXT COLLATE NOCASE UNIQUE)",
    ]) await expect(db.ddl(sql)).rejects.toThrow(/^unsupported: COLLATE/);
    await db.ddl("CREATE TABLE b(id INTEGER PRIMARY KEY, email TEXT COLLATE NOCASE)");
    await expect(db.ddl("CREATE UNIQUE INDEX b_email ON b(email)")).rejects.toThrow(/^unsupported: COLLATE/);
  });

  it("are refused the same way when the collation is written in a table-level PRIMARY KEY", async () => {
    // SQLite は `PRIMARY KEY (a COLLATE NOCASE)` で、主キーの一意性を NOCASE で比べる ('abc' と 'ABC' が同じ行になる)。
    // 前は、列の名前を取り出すところが式の節を知らず、TypeError で落ちていた。
    const db = new SimCluster({ shards: 2 }).client();
    const message = (sql: string) => db.ddl(sql).then(() => "ok", (e: Error) => `${e.name}: ${e.message}`);
    const inColumn = await message("CREATE TABLE a(name TEXT COLLATE NOCASE PRIMARY KEY, n INTEGER)");
    expect(inColumn).toBe("SqlError: unsupported: COLLATE NOCASE on the primary key or shard key column name");
    for (const sql of [
      "CREATE TABLE a(name TEXT, n INTEGER, PRIMARY KEY (name COLLATE NOCASE))",
      "CREATE TABLE a(name TEXT, n INTEGER, PRIMARY KEY (name collate nocase DESC))",
      "CREATE TABLE a(name TEXT, n INTEGER, PRIMARY KEY (n, name COLLATE 'nocase'))",
      "CREATE TABLE a(name TEXT, n INTEGER, PRIMARY KEY ((name COLLATE NOCASE) COLLATE BINARY))",
      "CREATE TABLE a(name TEXT, n INTEGER, CONSTRAINT pk PRIMARY KEY (name /* c */ COLLATE -- c\n NOCASE) ON CONFLICT ABORT)",
      "CREATE TABLE a(name TEXT, n INTEGER, PRIMARY KEY (name COLLATE NOCASE)) WITHOUT ROWID",
    ]) expect(await message(sql), sql).toBe(inColumn);
    expect(await message("CREATE TABLE a(tenant TEXT, id INTEGER, PRIMARY KEY (tenant COLLATE RTRIM, id))")).toBe("SqlError: unsupported: COLLATE RTRIM on the primary key or shard key column tenant");
  });

  it("a table-level PRIMARY KEY with COLLATE BINARY, a direction, parentheses or a quoted name works as in SQLite", async () => {
    for (const shards of [1, 3]) {
      // 断った文は SQLite でも実行しないので (test/diff.ts)、断った文がないことも確かめる。
      const refused: string[] = [];
      const problems = await diff(`
        CREATE TABLE k1 (a TEXT, b INTEGER, v TEXT, PRIMARY KEY (a COLLATE BINARY DESC, b ASC));
        INSERT INTO k1 VALUES ('abc', 1, 'x'), ('ABC', 1, 'y'), ('abc', 2, 'z'), ('b', 1, 'w'), ('c', 3, 'u');
        INSERT INTO k1 VALUES ('abc', 1, 'again');
        INSERT INTO k1 VALUES ('Abc', 1, 'other');
        SELECT a, b, v FROM k1 WHERE a = 'abc' AND b = 1;
        SELECT a, b, v FROM k1 WHERE a = 'ABC';
        UPDATE k1 SET v = 'changed' WHERE a = 'abc' AND b = 2;
        DELETE FROM k1 WHERE a = 'b' AND b = 1;
        SELECT a, b, v FROM k1 ORDER BY a, b;
        CREATE TABLE k2 (a TEXT, v TEXT, PRIMARY KEY ((a)));
        INSERT INTO k2 VALUES ('p', 'x'), ('q', 'y'), ('r', 'z');
        INSERT INTO k2 VALUES ('q', 'again');
        SELECT a, v FROM k2 WHERE a = 'q';
        CREATE TABLE k3 (a TEXT, v TEXT, PRIMARY KEY ('a' COLLATE binary));
        INSERT INTO k3 VALUES ('p', 'x'), ('q', 'y'), ('r', 'z');
        INSERT INTO k3 VALUES ('r', 'again');
        SELECT a, v FROM k3 ORDER BY a DESC;
        CREATE TABLE k4 (a INTEGER, v TEXT, PRIMARY KEY (a + 1));
        CREATE TABLE k5 (a TEXT, v TEXT, PRIMARY KEY (lower(a)));
        CREATE TABLE k6 (a TEXT, v TEXT, PRIMARY KEY ((a, v)));
        SELECT name FROM sqlite_master WHERE name LIKE 'k_' ORDER BY name;
      `, shards, [], refused);
      expect({ problems, refused }, `${shards} shards`).toEqual({ problems: [], refused: [] });
    }
    // 列でない式は、SQLite と同じ文言で断る (TypeError ではない)。
    const db = new SimCluster({ shards: 2 }).client();
    await expect(db.ddl("CREATE TABLE k4 (a INTEGER, v TEXT, PRIMARY KEY (a + 1))")).rejects.toThrow(/^expressions prohibited in PRIMARY KEY and UNIQUE constraints$/);
  });

  it("work on other columns, including a UNIQUE inside one shard key", async () => {
    const db = new SimCluster({ shards: 2 }).client();
    await db.ddl("CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT COLLATE NOCASE, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code))");
    await db.query("INSERT INTO p VALUES (1, 1, 'abc')");
    await expect(db.query("INSERT INTO p VALUES (1, 2, 'ABC')")).rejects.toThrow(/UNIQUE/);
    await db.query("INSERT INTO p VALUES (2, 1, 'ABC')");
    expect((await db.query("SELECT tenant_id FROM p WHERE code = 'Abc' ORDER BY tenant_id")).rows).toEqual([{ tenant_id: 1 }, { tenant_id: 2 }]);
  });
});
