import { Miniflare } from "miniflare";
import { readFileSync, statSync } from "fs";
import { performance } from "perf_hooks";
const js = readFileSync("dist/bench-official.js", "utf8");
const wasm = readFileSync("node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm");
console.log("official: bundle js KB:", (statSync("dist/bench-official.js").size / 1024).toFixed(0), "wasm KB:", (wasm.length / 1024).toFixed(0));
const mf = new Miniflare({ modules: [{ type: "ESModule", path: "bench-official.js", contents: js }, { type: "CompiledWasm", path: "sqlite3.wasm", contents: wasm }], compatibilityDate: "2026-01-01" });
async function t(path) { const s = performance.now(); const r = await mf.dispatchFetch("http://x" + path); const body = await r.text(); console.log(path.padEnd(16), (performance.now() - s).toFixed(1).padStart(8), "ms", body.slice(0, 200)); }
await t("/init"); await t("/init"); await t("/load?n=100000"); await t("/groupby"); await t("/window"); await t("/mem");
await mf.dispose();
