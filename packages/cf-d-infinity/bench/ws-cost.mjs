// WebSocket (hrana2) で文を流し、課金の単位 (Worker と DO のリクエスト) が文の数に比例しないことを確かめる。
// 使い方: URL=https://... TOKEN=... CONNS=10 PER=1000 node bench/ws-cost.mjs
import { createClient } from "@libsql/client";

const url = process.env.URL.replace(/^http/, "ws");
const CONNS = Number(process.env.CONNS ?? 10);
const PER = Number(process.env.PER ?? 1000);
const ROWS = 256;

const admin = createClient({ url, authToken: process.env.TOKEN });
await admin.execute("CREATE TABLE IF NOT EXISTS ws_cost(id INTEGER PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)");
await admin.execute(`INSERT OR IGNORE INTO ws_cost(id) SELECT value FROM json_each('[${Array.from({ length: ROWS }, (_, i) => i + 1).join(",")}]')`);
const before = Number((await admin.execute("SELECT sum(n) s FROM ws_cost")).rows[0].s);
admin.close();

const t0 = Date.now();
let ok = 0;
const failures = {};
await Promise.all(Array.from({ length: CONNS }, async (_, c) => {
  const db = createClient({ url, authToken: process.env.TOKEN });
  try {
    for (let i = 0; i < PER; i++) {
      try {
        await db.execute({ sql: "UPDATE ws_cost SET n = n + 1 WHERE id = ?", args: [1 + ((c * PER + i) % ROWS)] });
        ok++;
      } catch (e) {
        const m = String(e?.message ?? e).slice(0, 80);
        failures[m] = (failures[m] ?? 0) + 1;
      }
    }
  } finally {
    db.close();
  }
}));
const secs = (Date.now() - t0) / 1000;
const check = createClient({ url, authToken: process.env.TOKEN });
const after = Number((await check.execute("SELECT sum(n) s FROM ws_cost")).rows[0].s);
check.close();
console.log(JSON.stringify({ statements: CONNS * PER, ok, failures, secs, perSec: Math.round(ok / secs), sumDelta: after - before, exact: after - before === ok }));
