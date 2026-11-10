// 本番で BEGIN の競合率を測る。@libsql/client の transaction() を使う。
import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";

const url = process.env.URL, authToken = process.env.TOKEN;
const admin = createClient({ url, authToken });
const out = [];

async function run(name, mode, hotRows, clients, ms = 8000) {
  const table = `c_${Math.random().toString(36).slice(2, 8)}`;
  await admin.execute(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)`);
  const ids = Array.from({ length: hotRows }, (_, i) => i + 1);
  for (let at = 0; at < ids.length; at += 30) {
    await admin.execute(`INSERT INTO ${table} VALUES ${ids.slice(at, at + 30).map((i) => `(${i}, 0)`).join(",")}`);
  }
  let ok = 0, busy = 0;
  const reasons = {};
  const lat = [];
  const end = Date.now() + ms;
  await Promise.all(Array.from({ length: clients }, async () => {
    const db = createClient({ url, authToken });
    while (Date.now() < end) {
      const id = 1 + Math.floor(Math.random() * hotRows);
      const t0 = performance.now();
      const tx = await db.transaction(mode);
      try {
        const r = await tx.execute({ sql: `SELECT n FROM ${table} WHERE id = ?`, args: [id] });
        await tx.execute({ sql: `UPDATE ${table} SET n = ? WHERE id = ?`, args: [Number(r.rows[0].n) + 1, id] });
        await tx.commit();
        ok++;
        lat.push(performance.now() - t0);
      } catch (e) {
        busy++;
        const k = String(e.message).slice(0, 44);
        reasons[k] = (reasons[k] ?? 0) + 1;
        try { await tx.rollback(); } catch {}
      } finally {
        tx.close();
      }
    }
  }));
  const sum = Number((await admin.execute(`SELECT sum(n) s FROM ${table}`)).rows[0].s);
  const s = [...lat].sort((a, b) => a - b);
  const row = { name, clients, perSec: Math.round(ok / (ms / 1000)), busyPct: +(100 * busy / Math.max(1, ok + busy)).toFixed(1), p50: Math.round(s[s.length >> 1] ?? 0), p99: Math.round(s[Math.floor(s.length * 0.99)] ?? 0), ok, sum, exact: sum === ok, reasons };
  out.push(row);
  console.log(JSON.stringify(row).slice(0, 210));
  await admin.execute(`DROP TABLE ${table}`);
}

await run("write, 1000 rows", "write", 1000, 20);
await run("write, 100 hot rows", "write", 100, 20);
await run("write, 10 hot rows", "write", 10, 20);
await run("write, 1 hot row", "write", 1, 20);
await run("deferred, 100 hot rows", "deferred", 100, 20);
await run("deferred, 1 hot row", "deferred", 1, 20);
writeFileSync("bench/results/contention-prod.json", JSON.stringify(out, null, 1));
