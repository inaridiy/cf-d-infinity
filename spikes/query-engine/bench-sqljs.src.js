// workerd 上で sql.js (SQLite WASM) を動かし、読み込み・JOIN・GROUP BY の所要を測る。時間は Node 側で測る。
import "./shim.js";
import initSqlJs from "sql.js";
import wasmModule from "./sql-wasm.wasm";

let SQL, db, memory;
async function init() {
  if (SQL) return;
  SQL = await initSqlJs({
    instantiateWasm(imports, cb) {
      const inst = new WebAssembly.Instance(wasmModule, imports);
      memory = inst.exports.memory ?? imports.env?.memory;
      globalThis.__wasmExports = inst.exports;
      cb(inst);
      return inst.exports;
    },
  });
  db = new SQL.Database();
  SQL.__exports = globalThis.__wasmExports;
}
function rowsFromShards(n, seed) {
  // シャードから集めた行を模す (JSON で届いた想定)
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { id: i, g: (i * 7919 + seed) % 1000, n: (i * 31) % 10007, s: "name-" + ((i * 13) % 5000) };
  return out;
}
function load(table, rows) {
  db.run(`CREATE TABLE IF NOT EXISTS ${table}(id INTEGER PRIMARY KEY, g INTEGER, n INTEGER, s TEXT) STRICT`);
  db.run("BEGIN");
  const st = db.prepare(`INSERT INTO ${table}(id, g, n, s) VALUES (?, ?, ?, ?)`);
  for (const r of rows) st.run([r.id, r.g, r.n, r.s]);
  st.free();
  db.run("COMMIT");
}
function q(sql) {
  const res = db.exec(sql);
  return res.length ? { cols: res[0].columns, n: res[0].values.length, first: res[0].values[0] } : { n: 0 };
}
export default {
  async fetch(req) {
    const url = new URL(req.url);
    const n = Number(url.searchParams.get("n") ?? 100000);
    let out;
    switch (url.pathname) {
      case "/init": await init(); out = { ok: true }; break;
      case "/gen": { const rows = rowsFromShards(n, 0); out = { n: rows.length }; break; }  // 行生成だけの時間 (差分を取る)
      case "/load": load("t", rowsFromShards(n, 0)); out = q("SELECT count(*) c FROM t"); break;
      case "/load2": load("u", rowsFromShards(n, 3)); out = q("SELECT count(*) c FROM u"); break;
      case "/groupby": out = q("SELECT g, count(*) c, sum(n) s FROM t GROUP BY g"); break;
      case "/having": out = q("SELECT g, count(*) c FROM t GROUP BY g HAVING count(*) > 100 ORDER BY c DESC LIMIT 10"); break;
      case "/distinct": out = q("SELECT count(*) FROM (SELECT DISTINCT s FROM t)"); break;
      case "/window": out = q("SELECT id, row_number() OVER (ORDER BY n DESC) rn FROM t LIMIT 10"); break;
      case "/join-pk": out = q("SELECT count(*) c, sum(t.n + u.n) s FROM t JOIN u ON t.id = u.id"); break;
      case "/join-noidx": out = q("SELECT count(*) c FROM t JOIN u ON t.s = u.s WHERE t.id < 2000"); break;
      case "/topn": out = q("SELECT id, n FROM t ORDER BY n DESC LIMIT 10"); break;
      case "/mem": out = { wasmMemoryBytes: memory?.buffer.byteLength, dbBytes: db.export().length, exportKeys: Object.keys(SQL?.__exports ?? {}).filter((k) => /mem/i.test(k)) }; break;
      case "/json": { const rows = rowsFromShards(n, 0); const s = JSON.stringify(rows); const back = JSON.parse(s); out = { bytes: s.length, n: back.length }; break; }
      case "/drop": db.run("DROP TABLE IF EXISTS t"); db.run("DROP TABLE IF EXISTS u"); out = { ok: true }; break;
      default: out = { error: "unknown" };
    }
    return Response.json(out);
  },
};
