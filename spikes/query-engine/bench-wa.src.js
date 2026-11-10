import "./shim.js";
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite.mjs";
import * as SQLite from "wa-sqlite";
import wasmModule from "./wa-sqlite.wasm";
let sqlite3, db;
export default {
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/init") {
        if (!sqlite3) {
          const mod = await SQLiteESMFactory({ instantiateWasm(imports, cb) { const inst = new WebAssembly.Instance(wasmModule, imports); cb(inst); return inst.exports; } });
          sqlite3 = SQLite.Factory(mod);
          db = await sqlite3.open_v2(":memory:");
        }
        return Response.json({ ok: true, version: sqlite3.libversion() });
      }
      if (url.pathname === "/load") {
        const n = Number(url.searchParams.get("n") ?? 100000);
        await sqlite3.exec(db, "CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, g INTEGER, n INTEGER, s TEXT) STRICT; BEGIN");
        for await (const stmt of sqlite3.statements(db, "INSERT INTO t(id,g,n,s) VALUES (?,?,?,?)")) {
          for (let i = 0; i < n; i++) { sqlite3.bind_collection(stmt, [i, (i * 7919) % 1000, (i * 31) % 10007, "name-" + ((i * 13) % 5000)]); await sqlite3.step(stmt); await sqlite3.reset(stmt); }
        }
        await sqlite3.exec(db, "COMMIT");
        let c; await sqlite3.exec(db, "SELECT count(*) FROM t", (row) => { c = row[0]; });
        return Response.json({ n: c });
      }
      if (url.pathname === "/groupby") { let k = 0; await sqlite3.exec(db, "SELECT g, count(*), sum(n) FROM t GROUP BY g", () => { k++; }); return Response.json({ n: k }); }
      return Response.json({ error: "unknown" });
    } catch (e) { return Response.json({ error: String(e && e.message || e), stack: String(e && e.stack).slice(0, 400) }); }
  },
};
