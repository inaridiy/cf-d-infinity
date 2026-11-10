import "./shim.js";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import wasmModule from "./sqlite3.wasm";
let sqlite3, db, memory;
export default {
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/init") {
        if (!sqlite3) {
          sqlite3 = await sqlite3InitModule({
            print: () => {}, printErr: () => {},
            instantiateWasm(imports, cb) { const inst = new WebAssembly.Instance(wasmModule, imports); memory = inst.exports.memory ?? imports.env?.memory; cb(inst); return inst.exports; },
          });
          db = new sqlite3.oo1.DB(":memory:");
        }
        return Response.json({ ok: true, version: sqlite3.version.libVersion });
      }
      if (url.pathname === "/load") {
        const n = Number(url.searchParams.get("n") ?? 100000);
        db.exec("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, g INTEGER, n INTEGER, s TEXT) STRICT");
        db.exec("BEGIN");
        const st = db.prepare("INSERT INTO t(id,g,n,s) VALUES (?,?,?,?)");
        for (let i = 0; i < n; i++) { st.bind([i, (i * 7919) % 1000, (i * 31) % 10007, "name-" + ((i * 13) % 5000)]).stepReset(); }
        st.finalize(); db.exec("COMMIT");
        return Response.json({ n: db.selectValue("SELECT count(*) FROM t") });
      }
      if (url.pathname === "/groupby") return Response.json({ n: db.selectArrays("SELECT g, count(*), sum(n) FROM t GROUP BY g").length });
      if (url.pathname === "/window") return Response.json({ r: db.selectArrays("SELECT id, row_number() OVER (ORDER BY n DESC) rn FROM t LIMIT 3") });
      if (url.pathname === "/mem") return Response.json({ wasmMemoryBytes: memory?.buffer.byteLength });
      return Response.json({ error: "unknown" });
    } catch (e) { return Response.json({ error: String(e && e.message || e), stack: String(e && e.stack).slice(0, 300) }); }
  },
};
