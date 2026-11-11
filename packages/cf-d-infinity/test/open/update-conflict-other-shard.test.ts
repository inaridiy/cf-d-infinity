// 未解決: `UPDATE OR IGNORE` と `UPDATE OR REPLACE` が、衝突する行が別のシャードにあるときだけ `unsupported:` で断られる。
// 行がどのシャードに載るかは利用者が決められないので、これは「その構文が使えない」のと同じである (持ち主の規則 4)。
// 正しい挙動は、行の配置にかかわらず SQLite と同じ結果になることである。ここでは、それを期待して書く。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { quiescentProblems } from "../invariants";
import { SimCluster } from "../sim";

const USERS = `CREATE TABLE users(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT, code TEXT, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id), UNIQUE (email), UNIQUE (tenant_id, code)) SHARD KEY (tenant_id)`;
const ALL = "SELECT tenant_id, id, email, code, n FROM users ORDER BY tenant_id, id";

describe("UPDATE that resolves conflicts itself, on a table with a UNIQUE that spans shards", () => {
  it("gives SQLite's result when the conflicting row belongs to another tenant", async () => {
    const c = new SimCluster({ shards: 3 });
    const db = c.client();
    const lite = new DatabaseSync(":memory:");
    await db.ddl(USERS);
    lite.exec(USERS.replace(/SHARD KEY \([^)]*\)/, ""));
    for (const sql of [
      "INSERT INTO users(tenant_id, id, email, code) VALUES (1, 1, 'a@x', 'c1')",
      "INSERT INTO users(tenant_id, id, email, code) VALUES (2, 1, 'b@x', 'c1')",
      "INSERT INTO users(tenant_id, id, email, code) VALUES (3, 1, 'c@x', 'c1')",
      "UPDATE OR IGNORE users SET email = 'a@x' WHERE tenant_id = 2 AND id = 1",
      "UPDATE OR IGNORE users SET email = 'a@x' WHERE tenant_id IN (2, 3)",
      "UPDATE OR REPLACE users SET email = 'a@x' WHERE tenant_id = 2 AND id = 1",
      "UPDATE OR IGNORE users SET n = n + 1, email = 'fresh@x' WHERE tenant_id = 2",
    ]) {
      const want = (() => {
        try {
          return Number(lite.prepare(sql).run().changes);
        } catch (e) {
          return `ERROR ${(e as Error).message}`;
        }
      })();
      const got = await db.query(sql).then((r) => r.changes, (e: Error) => `ERROR ${e.message}`);
      expect({ sql, got }).toEqual({ sql, got: want });
    }
    expect((await db.query(ALL)).rows).toEqual(lite.prepare(ALL).all().map((r) => ({ ...r })));
    expect(await quiescentProblems(c)).toEqual([]);
  });
});
