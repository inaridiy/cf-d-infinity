import { Miniflare } from "miniflare";
import { readFileSync, statSync } from "fs";
import { performance } from "perf_hooks";
const js = readFileSync("dist/bench-sqljs.js", "utf8");
const wasm = readFileSync("node_modules/sql.js/dist/sql-wasm.wasm");
console.log("bundle js KB:", (statSync("dist/bench-sqljs.js").size / 1024).toFixed(0), "wasm KB:", (wasm.length / 1024).toFixed(0));
const mf = new Miniflare({
  modules: [
    { type: "ESModule", path: "bench-sqljs.js", contents: js },
    { type: "CompiledWasm", path: "sql-wasm.wasm", contents: wasm },
  ],
  compatibilityDate: "2026-01-01",
});
async function t(path) {
  const s = performance.now();
  const r = await mf.dispatchFetch("http://x" + path);
  const body = await r.json();
  const ms = performance.now() - s;
  console.log(path.padEnd(22), ms.toFixed(1).padStart(8), "ms", JSON.stringify(body).slice(0, 120));
}
await t("/init"); await t("/init");
await t("/gen?n=100000");
await t("/load?n=100000");
await t("/load2?n=100000");
await t("/groupby"); await t("/having"); await t("/distinct"); await t("/window");
await t("/join-pk"); await t("/join-noidx"); await t("/topn"); await t("/mem");
await t("/json?n=100000");
await t("/drop"); await t("/load?n=500000"); await t("/groupby"); await t("/mem");
await mf.dispose();
