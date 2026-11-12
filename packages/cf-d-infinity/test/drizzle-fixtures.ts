// drizzle-kit が書き出す形の移行。本物の Drizzle の移行 (drizzle-orm の migrate) に流す。
// 作り直しの移行の形は、drizzle-kit の出力を記憶で書いたものである。本物の drizzle-kit 0.31 の出力は test/drizzle-kit.test.ts で
// 流している (計画書の未解決の問題 10)。本物との違いは 1 つ: 本物の INSERT ... SELECT は列をそのまま写し、`coalesce` を付けない。
// ここでは NULL の行も写す場合を試すために付けてある。
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** drizzle-kit が書き出す形の移行の置き場を作る。 */
export function migrations(list: { tag: string; sql: string[] }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "dinf-drizzle-"));
  mkdirSync(join(dir, "meta"));
  list.forEach((m) => writeFileSync(join(dir, `${m.tag}.sql`), m.sql.join("\n--> statement-breakpoint\n")));
  const entries = list.map((m, i) => ({ idx: i, version: "6", when: 1_700_000_000_000 + i * 1000, tag: m.tag, breakpoints: true }));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries }));
  return dir;
}

export const INIT = {
  tag: "0000_init",
  sql: [
    "CREATE TABLE `users` (`id` integer PRIMARY KEY NOT NULL, `email` text NOT NULL, `name` text);",
    "CREATE TABLE `posts` (`id` integer PRIMARY KEY NOT NULL, `user_id` integer NOT NULL, `title` text NOT NULL);",
    // Drizzle の `.unique()`。shard key を含まないので、シャードをまたぐ UNIQUE の index になる。
    "CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);",
  ],
};
export const ADD = { tag: "0001_add_age", sql: ["ALTER TABLE `users` ADD `age` integer;"] };
// drizzle-kit が、列の制約を変えるときに作る形 (SQLite は ALTER COLUMN を持たない)。
export const REBUILD = {
  tag: "0002_name_not_null",
  sql: [
    "PRAGMA foreign_keys=OFF;",
    "CREATE TABLE `__new_users` (`id` integer PRIMARY KEY NOT NULL, `email` text NOT NULL, `name` text DEFAULT '' NOT NULL, `age` integer);",
    "INSERT INTO `__new_users`(\"id\", \"email\", \"name\", \"age\") SELECT \"id\", \"email\", coalesce(\"name\", ''), \"age\" FROM `users`;",
    "DROP TABLE `users`;",
    "ALTER TABLE `__new_users` RENAME TO `users`;",
    "PRAGMA foreign_keys=ON;",
    // 作り直した表に、index を作り直す。行のある表なので、書き込みを止めて作る。
    "CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);",
  ],
};

