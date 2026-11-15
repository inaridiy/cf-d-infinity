import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { D1Compatible } from "../src/client/d1";
import { Db } from "../src/client/db";
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
  await client.ddl(`CREATE TABLE users(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, name TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, id))`);
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

// 64 ビットの整数と NUL を含む文字列 (docs/design-values.md の「D1 互換の API、Service Binding、HTTP の JSON」と、決めたことの 1 と 2)。
// 結果の INTEGER は、既定 (intMode "number") では JS の数で、JS の数で正確に表せない INTEGER は誤りにする。intMode "bigint" は
// INTEGER をすべて bigint で、"string" はすべて 10 進の文字列で返す (@libsql/client と同じ)。引数の JS の数は、安全な整数なら
// INTEGER、ほかは REAL である。どれも値で決まり、行の置き場所と、答えるのがシャードか Worker の SQLite かには依らない。
describe("64-bit integers and NUL through the D1 compatible API", () => {
  const WIDE = [2n ** 63n - 1n, -(2n ** 63n), 2n ** 53n + 1n, 2n ** 53n, -(2n ** 53n) - 1n];
  const NUL = "a\u0000b";
  const T = "CREATE TABLE w(id INTEGER PRIMARY KEY, n INTEGER, v, s TEXT)";
  // 主キーで 1 行を読む文はシャードが、全行を並べる文と表を読まない文は Worker の SQLite が答える (2 シャード以上)。
  const READS = {
    byKey: "SELECT id, n, v, s FROM w WHERE id = ?",
    scan: "SELECT id, n, v, s FROM w ORDER BY id",
    noTable: "SELECT ? AS n, ? AS s",
  };
  const fill = async (d1: D1Compatible) => {
    await d1.prepare(T).run();
    for (const [i, n] of WIDE.entries()) await d1.prepare("INSERT INTO w(id, n, v, s) VALUES (?, ?, ?, ?)").bind(i + 1, n, n, NUL).run();
  };

  for (const shards of [1, 2, 4]) {
    it(`refuses a wide INTEGER in the result by default, and returns it exactly with intMode, on ${shards} shards`, async () => {
      const c = new SimCluster({ shards });
      const plain = new D1Compatible(new Db(c));
      await fill(plain);
      await c.settle();
      for (const [name, sql] of Object.entries(READS)) {
        const args = name === "byKey" ? [1] : name === "noTable" ? [WIDE[0], NUL] : [];
        await expect(plain.prepare(sql).bind(...args).all(), name).rejects.toThrow(/cannot hold exactly/);
        await expect(plain.prepare(sql).bind(...args).raw(), name).rejects.toThrow(/cannot hold exactly/);
        await expect(plain.prepare(sql).bind(...args).first(), name).rejects.toThrow(/cannot hold exactly/);
      }
      // 安全な範囲の INTEGER は、既定では JS の数である。
      expect((await plain.prepare("SELECT id, s FROM w WHERE id = ?").bind(1).all()).results).toEqual([{ id: 1, s: NUL }]);

      const big = new D1Compatible(new Db(c), { intMode: "bigint" } as never);
      expect((await big.prepare(READS.byKey).bind(1).all()).results).toEqual([{ id: 1n, n: WIDE[0], v: WIDE[0], s: NUL }]);
      expect((await big.prepare(READS.scan).all()).results).toEqual(WIDE.map((n, i) => ({ id: BigInt(i + 1), n, v: n, s: NUL })));
      expect(await big.prepare(READS.scan).raw()).toEqual(WIDE.map((n, i) => [BigInt(i + 1), n, n, NUL]));
      expect(await big.prepare(READS.noTable).bind(WIDE[1], NUL).first()).toEqual({ n: WIDE[1], s: NUL });
      expect(await big.prepare("SELECT n FROM w WHERE id = ?").bind(2).first("n")).toBe(WIDE[1]);
      // REAL は、どの intMode でも JS の数である。
      expect(await big.prepare("SELECT 1.5 AS r, 2.0 AS q").first()).toEqual({ r: 1.5, q: 2 });

      const str = new D1Compatible(new Db(c), { intMode: "string" } as never);
      expect((await str.prepare(READS.scan).all()).results).toEqual(WIDE.map((n, i) => ({ id: String(i + 1), n: String(n), v: String(n), s: NUL })));
      expect(await str.prepare(READS.noTable).bind(WIDE[0], NUL).raw()).toEqual([[String(WIDE[0]), NUL]]);

      const [batch] = await big.batch([big.prepare(READS.byKey).bind(3)]);
      expect(batch!.results).toEqual([{ id: 3n, n: WIDE[2], v: WIDE[2], s: NUL }]);
      await expect(plain.batch([plain.prepare(READS.byKey).bind(3)])).rejects.toThrow(/cannot hold exactly/);
    });
  }

  it("returns last_row_id in the intMode, and refuses by default an explicit rowid that a JS number cannot hold", async () => {
    const c = new SimCluster({ shards: 2 });
    const plain = new D1Compatible(new Db(c));
    await plain.prepare(T).run();
    expect((await plain.prepare("INSERT INTO w(id, n) VALUES (?, 1)").bind(7).run()).meta.last_row_id).toBe(7);
    // 文は実行され、確定している。結果の last_row_id を JS の数にできないので、誤りにする (丸めた数は返さない)。
    await expect(plain.prepare("INSERT INTO w(id, n) VALUES (?, 1)").bind(2n ** 60n).run()).rejects.toThrow(/last_row_id .*cannot hold exactly/);
    expect(await new D1Compatible(new Db(c), { intMode: "string" } as never).prepare("SELECT count(*) AS c FROM w WHERE id = ?").bind(2n ** 60n).first("c")).toBe("1");
    const big = new D1Compatible(new Db(c), { intMode: "bigint" } as never);
    expect((await big.prepare("INSERT INTO w(id, n) VALUES (?, 1)").bind(2n ** 61n).run()).meta.last_row_id).toBe(2n ** 61n);
    const str = new D1Compatible(new Db(c), { intMode: "string" } as never);
    expect((await str.prepare("INSERT INTO w(id, n) VALUES (?, 1)").bind(-(2n ** 62n)).run()).meta.last_row_id).toBe(String(-(2n ** 62n)));
  });

  it("binds a JS number that is an integer outside the safe range as REAL, whether a shard or the Worker's SQLite answers", async () => {
    // 決めたことの 2。渡された double をそのまま入れる。INTEGER の列は、型の親和性で整数にする (値は 2^60 のまま)。
    const c = new SimCluster({ shards: 2 });
    const d1 = new D1Compatible(new Db(c), { intMode: "bigint" } as never);
    await d1.prepare(T).run();
    for (const x of [2 ** 60, -(2 ** 60), 2 ** 53, 1e17, 9007199254740993]) {
      expect(await d1.prepare("SELECT typeof(?) AS t, ? AS x").bind(x, x).first(), String(x)).toEqual({ t: "real", x });
    }
    await d1.prepare("INSERT INTO w(id, n, v) VALUES (1, ?, ?)").bind(2 ** 60, 2 ** 60).run();
    expect(await d1.prepare("SELECT typeof(n) AS tn, n, typeof(v) AS tv, v FROM w WHERE id = 1").first()).toEqual({ tn: "integer", n: 2n ** 60n, tv: "real", v: 2 ** 60 });
    // 安全な整数の JS の数と、bigint は INTEGER である。
    expect(await d1.prepare("SELECT typeof(?) AS a, typeof(?) AS b").bind(2 ** 53 - 1, 2n ** 60n).first()).toEqual({ a: "integer", b: "integer" });
  });

  it("refuses an integer argument that does not fit in 64 bits, the same way on every path", async () => {
    const c = new SimCluster({ shards: 2 });
    const d1 = new D1Compatible(new Db(c));
    await d1.prepare(T).run();
    for (const x of [2n ** 63n, -(2n ** 63n) - 1n]) {
      await expect(d1.prepare("SELECT ? AS x").bind(x).all()).rejects.toThrow(/does not fit in 64 bits/);
      await expect(d1.prepare("INSERT INTO w(id, n) VALUES (1, ?)").bind(x).run()).rejects.toThrow(/does not fit in 64 bits/);
    }
    expect((await d1.prepare("SELECT count(*) AS c FROM w").first("c"))).toBe(0);
  });

  it("refuses an intMode it does not know", () => {
    expect(() => new D1Compatible(new Db(new SimCluster({ shards: 1 })), { intMode: "double" } as never)).toThrow(/intMode/);
  });
});
