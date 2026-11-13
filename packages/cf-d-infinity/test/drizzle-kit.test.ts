// 本物の drizzle-kit が書き出す移行を、本物の Drizzle の移行 (drizzle-orm の migrate) で D∞ に流す (計画書の未解決の問題 10)。
//
// test/drizzle-fixtures.ts の移行は、drizzle-kit の出力を記憶で書いたものだった。ここでは drizzle-kit の API
// (`generateSQLiteMigration`) に、スキーマの前と後を渡して移行の文を作らせる。列を足す移行と、列の制約を変えて表を作り直す
// 移行 (`__new_<表名>` を作って写し、古い表を消して名前を変える) を含む。
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { drizzleMigrationsTable } from "../src/binding";
import { migrations } from "./drizzle-fixtures";
import { clientOf } from "./libsql";
import { SimCluster } from "./sim";

const v1 = {
  users: sqliteTable("users", { id: integer("id").primaryKey(), email: text("email").notNull().unique(), name: text("name") }),
  posts: sqliteTable("posts", { id: integer("id").primaryKey(), userId: integer("user_id").notNull(), title: text("title").notNull() },
    (t) => [index("posts_user").on(t.userId)]),
};
// 列を足す。
const v2 = {
  ...v1,
  users: sqliteTable("users", { id: integer("id").primaryKey(), email: text("email").notNull().unique(), name: text("name"), age: integer("age") }),
};
// 列の制約を変える。SQLite には ALTER COLUMN がないので、drizzle-kit は表を作り直す。
const v3 = {
  ...v2,
  users: sqliteTable("users", {
    id: integer("id").primaryKey(), email: text("email").notNull().unique(), name: text("name").notNull().default(""), age: integer("age"),
  }),
};

async function generated() {
  const [s0, s1, s2, s3] = await Promise.all([{}, v1, v2, v3].map((s) => generateSQLiteDrizzleJson(s)));
  return [
    { tag: "0000_init", sql: await generateSQLiteMigration(s0!, s1!) },
    { tag: "0001_add_age", sql: await generateSQLiteMigration(s1!, s2!) },
    { tag: "0002_name_not_null", sql: await generateSQLiteMigration(s2!, s3!) },
  ];
}

describe("migrations that drizzle-kit itself generates", () => {
  it("include a table rebuild through __new_users", async () => {
    const [, , rebuild] = await generated();
    const text = rebuild!.sql.join("\n");
    expect(text).toMatch(/CREATE TABLE `__new_users`/);
    expect(text).toMatch(/INSERT INTO `__new_users`/);
    expect(text).toMatch(/DROP TABLE `users`/);
    expect(text).toMatch(/ALTER TABLE `__new_users` RENAME TO `users`/);
  });

  it("run through Drizzle's migrator on D∞, keep the rows, and keep UNIQUE across shards", async () => {
    const list = await generated();
    const c = new SimCluster({ shards: 3 });
    const client = clientOf(c);
    await client.execute(drizzleMigrationsTable());
    await migrate(drizzle(client), { migrationsFolder: migrations(list.slice(0, 2)) });
    await client.execute("INSERT INTO users(id, email, name, age) VALUES (1, 'a@x', 'A', 30), (2, 'b@x', 'B', 40), (3, 'c@x', 'C', NULL)");
    await client.execute("INSERT INTO posts(id, user_id, title) VALUES (1, 1, 'p1'), (2, 2, 'p2')");
    await migrate(drizzle(client), { migrationsFolder: migrations(list) });
    const rows = await client.execute("SELECT id, email, name, age FROM users ORDER BY id");
    expect(rows.rows.map((r) => ({ ...r }))).toEqual([
      { id: 1, email: "a@x", name: "A", age: 30 }, { id: 2, email: "b@x", name: "B", age: 40 }, { id: 3, email: "c@x", name: "C", age: null },
    ]);
    expect((await client.execute("SELECT count(*) AS n FROM __drizzle_migrations")).rows[0]!.n).toBe(3);
    await expect(client.execute("INSERT INTO users(id, email, name) VALUES (9, 'a@x', 'Z')")).rejects.toThrow(/UNIQUE constraint failed/);
    await client.execute("INSERT INTO users(id, email) VALUES (10, 'z@x')"); // name の既定値 ''
    expect((await client.execute("SELECT name FROM users WHERE id = 10")).rows[0]!.name).toBe("");
    expect((await client.execute("SELECT count(*) AS n FROM posts WHERE user_id = 1")).rows[0]!.n).toBe(1);
  });

  it("fails as SQLite does when a row breaks the new constraint, and leaves the old table and its rows intact", async () => {
    // drizzle-kit の作り直しは、列をそのまま写す (`INSERT INTO __new_users(...) SELECT ... FROM users`)。NULL の name の行があると、
    // 本物の SQLite でも NOT NULL の違反で失敗する。D∞ は、取引の中の DDL の前で取引を確定するので、作りかけの `__new_users` が残る
    // (README の Limitations)。元の表と行は変わらない。
    const list = await generated();
    const c = new SimCluster({ shards: 3 });
    const client = clientOf(c);
    await client.execute(drizzleMigrationsTable());
    await migrate(drizzle(client), { migrationsFolder: migrations(list.slice(0, 2)) });
    await client.execute("INSERT INTO users(id, email, name) VALUES (1, 'a@x', 'A'), (2, 'b@x', NULL)");
    await expect(migrate(drizzle(client), { migrationsFolder: migrations(list) })).rejects.toThrow(/NOT NULL constraint failed: __new_users\.name/);
    expect((await client.execute("SELECT id, name FROM users ORDER BY id")).rows.map((r) => ({ ...r }))).toEqual([{ id: 1, name: "A" }, { id: 2, name: null }]);
    expect((await client.execute("SELECT count(*) AS n FROM __drizzle_migrations")).rows[0]!.n).toBe(2);
  });
});
