import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { D1Compatible } from "../src/client/d1";
import { SimCluster } from "./sim";

const users = sqliteTable("users", {
  tenantId: integer("tenant_id").notNull(),
  id: integer("id").notNull(),
  name: text("name"),
  n: integer("n").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.tenantId, t.id] })]);

async function setup() {
  const c = new SimCluster();
  const client = c.client();
  await client.ddl(`CREATE TABLE users(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, name TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`);
  return { c, client, d1: new D1Compatible(client) };
}

describe("D1 compatible surface", () => {
  it("supports prepare, bind, first, all, run", async () => {
    const { d1 } = await setup();
    await d1.prepare("INSERT INTO users(tenant_id,id,name) VALUES (?,?,?)").bind(1, 1, "a").run();
    expect(await d1.prepare("SELECT name FROM users WHERE tenant_id = ? AND id = ?").bind(1, 1).first("name")).toBe("a");
    expect((await d1.prepare("SELECT * FROM users WHERE tenant_id = ?").bind(1).all()).results).toHaveLength(1);
  });
  it("runs batch as one transaction across shards", async () => {
    const { c, d1 } = await setup();
    await d1.batch([1, 2, 3, 4, 5, 6].map((t) => d1.prepare("INSERT INTO users(tenant_id,id,n) VALUES (?,1,1)").bind(t)));
    await c.settle();
    const r = await d1.prepare("SELECT count(*) c, sum(n) s FROM users").first();
    expect(r).toEqual({ c: 6, s: 6 });
  });
  it("works under the Drizzle D1 driver", async () => {
    const { c, d1 } = await setup();
    const orm = drizzle(d1 as never);
    await orm.insert(users).values({ tenantId: 1, id: 1, name: "alice" });
    await orm.insert(users).values([{ tenantId: 2, id: 1, name: "bob" }, { tenantId: 3, id: 1, name: "carol" }]);
    await c.settle();
    await orm.update(users).set({ n: sql`${users.n} + 5` }).where(and(eq(users.tenantId, 1), eq(users.id, 1)));
    const rows = await orm.select().from(users).where(and(eq(users.tenantId, 1), eq(users.id, 1)));
    expect(rows).toEqual([{ tenantId: 1, id: 1, name: "alice", n: 5 }]);
    await orm.delete(users).where(and(eq(users.tenantId, 1), eq(users.id, 1)));
    expect(await orm.select().from(users).where(eq(users.tenantId, 1))).toEqual([]);
  });
});
