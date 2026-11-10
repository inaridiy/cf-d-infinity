// Usage: node run.mjs constraints.js | node run.mjs set-undo.js
import { Miniflare } from "miniflare";
import { readFileSync } from "fs";
const file = process.argv[2] ?? "set-undo.js";
const mf = new Miniflare({
  modules: [{ type: "ESModule", path: file, contents: readFileSync(file, "utf8") }],
  compatibilityDate: "2026-01-01",
  durableObjects: { SHARD: { className: "Shard", useSQLite: true } },
});
const r = await mf.dispatchFetch("http://x/");
console.log(JSON.stringify(await r.json(), null, 1));
await mf.dispose();
