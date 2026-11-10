// 本番の Worker に対する確認。PROD_URL と PROD_TOKEN があるときだけ動く。
import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSlt } from "./slt/runner";

const url = process.env.PROD_URL;
const authToken = process.env.PROD_TOKEN;

const stats = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return { p50: s[Math.floor(s.length / 2)]!, p90: s[Math.floor(s.length * 0.9)]!, n: s.length };
};

describe.skipIf(!url)("production", () => {
  const db = createClient({ url: url ?? "http://localhost", authToken });
  const results: Record<string, unknown> = {};
  const time = async (name: string, fn: (i: number) => Promise<unknown>, n = 25) => {
    await fn(0);
    const out: number[] = [];
    for (let i = 1; i <= n; i++) {
      const t0 = performance.now();
      await fn(i);
      out.push(performance.now() - t0);
    }
    results[name] = stats(out);
    console.log(`LAT ${name.padEnd(44)} p50 ${stats(out).p50.toFixed(0).padStart(6)} ms  p90 ${stats(out).p90.toFixed(0).padStart(6)} ms`);
  };

  it("runs a stock client and measures latency by query type", async () => {
    for (const t of ["users", "orders", "members", "big"]) await db.execute(`DROP TABLE IF EXISTS ${t}`);
    await db.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, org INTEGER, email TEXT UNIQUE, name TEXT)");
    await db.execute("CREATE TABLE orders(org INTEGER, id INTEGER, user_id INTEGER, total INTEGER, status TEXT, PRIMARY KEY (org, id)) SHARD KEY (org)");
    await db.execute("CREATE TABLE members(org INTEGER, id INTEGER, role TEXT, PRIMARY KEY (org, id)) SHARD KEY (org)");
    for (let at = 0; at < 600; at += 100) {
      await db.batch(Array.from({ length: 100 }, (_, i) => {
        const n = at + i + 1;
        return { sql: "INSERT INTO users(id, org, email, name) VALUES (?, ?, ?, ?)", args: [n, n % 40, `u${n}@x`, `name${n % 100}`] };
      }), "write");
    }
    for (let org = 0; org < 40; org++) {
      await db.execute({ sql: "INSERT INTO members VALUES (?, 1, 'admin')", args: [org] });
      await db.batch(Array.from({ length: 50 }, (_, i) => ({
        sql: "INSERT INTO orders VALUES (?, ?, ?, ?, ?)", args: [org, i, i + 1, (i * 7) % 100, i % 3 ? "paid" : "open"],
      })), "write");
    }
    expect((await db.execute("SELECT count(*) c FROM orders")).rows[0]!.c).toBe(2000);

    await time("baseline SELECT 1 (no shard)", () => db.execute("SELECT 1"));
    await time("point read by primary key", (i) => db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [(i % 600) + 1] }));
    await time("point write (autocommit, no index)", (i) => db.execute({ sql: "UPDATE orders SET total = total + 1 WHERE org = ? AND id = ?", args: [i % 40, 1] }));
    await time("join inside one shard", (i) => db.execute({ sql: "SELECT m.role, sum(o.total) FROM members m JOIN orders o ON o.org = m.org WHERE m.org = ? GROUP BY m.role", args: [i % 40] }));
    await time("lookup through a global index", (i) => db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [`u${(i % 600) + 1}@x`] }));
    await time("insert with a global UNIQUE (2PC)", (i) => db.execute({ sql: "INSERT INTO users(id, org, email) VALUES (?, 1, ?)", args: [100000 + i, `new${i}-${Date.now()}@x`] }), 15);
    await time("all shards: count(*) (partial aggregate)", () => db.execute("SELECT count(*) FROM orders"));
    await time("all shards: GROUP BY (partial aggregate)", () => db.execute("SELECT status, count(*), sum(total) FROM orders GROUP BY status"));
    await time("all shards: ORDER BY LIMIT (top N)", () => db.execute("SELECT id, total FROM orders ORDER BY total DESC LIMIT 5"));
    await time("all shards: HAVING (Worker SQLite, 2,000 rows)", () => db.execute("SELECT org, sum(total) s FROM orders GROUP BY org HAVING s > 100"), 15);
    await time("cross-shard JOIN (Worker SQLite)", () => db.execute("SELECT u.org, count(*) FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id < 50 GROUP BY u.org"), 15);
    await time("batch: 2 shards in one transaction", (i) => db.batch([
      { sql: "UPDATE orders SET total = 1 WHERE org = ? AND id = 2", args: [i % 40] },
      { sql: "UPDATE orders SET total = 2 WHERE org = ? AND id = 2", args: [(i + 7) % 40] },
    ], "write"), 15);
    await time("interactive transaction (3 statements)", async (i) => {
      const tx = await db.transaction("write");
      await tx.execute({ sql: "SELECT total FROM orders WHERE org = ? AND id = 3", args: [i % 40] });
      await tx.execute({ sql: "UPDATE orders SET total = total + 1 WHERE org = ? AND id = 3", args: [i % 40] });
      await tx.commit();
    }, 15);
    writeFileSync("bench/results/latency-by-query.json", JSON.stringify(results, null, 1));
  }, 500000);

  it("measures the cost of gathering rows into the Worker", async () => {
    await db.execute("DROP TABLE IF EXISTS big");
    await db.execute("CREATE TABLE big(id INTEGER PRIMARY KEY, v INTEGER, t TEXT)");
    const out: Record<string, unknown> = {};
    let have = 0;
    for (const target of [1000, 10000, 50000]) {
      while (have < target) {
        const base = have;
        await db.execute({
          sql: `INSERT INTO big SELECT ${base} + value, value % 97, 'row-' || value FROM json_each(?)`,
          args: [JSON.stringify(Array.from({ length: 1000 }, (_, k) => k + 1))],
        });
        have += 1000;
      }
      const t0 = performance.now();
      const r = await db.execute("SELECT v, count(*) c FROM big GROUP BY v HAVING c > 0 ORDER BY v LIMIT 3");
      const ms = performance.now() - t0;
      out[target] = { ms, rows: r.rows.length };
      console.log(`GATHER ${target} rows: ${ms.toFixed(0)} ms`);
    }
    writeFileSync("bench/results/gather.json", JSON.stringify(out, null, 1));
  }, 500000);

  it("passes sqllogictest through the production stack", async () => {
    await db.execute("DROP TABLE IF EXISTS t1");
    const r = await runSlt("test/slt/select1.test", {
      run: async (sql) => {
        const res = await db.execute(sql);
        return { values: res.rows.map((row) => res.columns.map((_, i) => row[i] ?? null)) };
      },
    }, { limit: Number(process.env.PROD_SLT ?? 300) });
    console.log(`SLT production select1: queries ${r.passed}/${r.queries}, statements ${r.statements - r.statementFailures}/${r.statements}`);
    for (const [k, v] of [...r.errors].slice(0, 5)) console.log(`  ${v} x ${k}`);
    expect(r.failed).toBe(0);
  }, 500000);
});
