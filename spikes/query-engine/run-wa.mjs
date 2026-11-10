import { Miniflare } from "miniflare";
import { readFileSync, statSync } from "fs";
import { performance } from "perf_hooks";
const js = readFileSync("dist/bench-wa.js", "utf8");
const wasm = readFileSync("node_modules/wa-sqlite/dist/wa-sqlite.wasm");
console.log("wa-sqlite: bundle js KB:", (statSync("dist/bench-wa.js").size / 1024).toFixed(0), "wasm KB:", (wasm.length / 1024).toFixed(0));
const mf = new Miniflare({ modules: [{ type: "ESModule", path: "bench-wa.js", contents: js }, { type: "CompiledWasm", path: "wa-sqlite.wasm", contents: wasm }], compatibilityDate: "2026-01-01" });
async function t(path) { const s = performance.now(); const r = await mf.dispatchFetch("http://x" + path); const body = await r.text(); console.log(path.padEnd(16), (performance.now() - s).toFixed(1).padStart(8), "ms", body.slice(0, 300)); }
await t("/init"); await t("/init"); await t("/load?n=100000"); await t("/groupby");
await mf.dispose();
