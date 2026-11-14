// 公開する lib/ を作る。
//   lib/cloudflare.js  Worker に組み込む側 (DO のクラス、DinfDatabase、HTTP と Cron の入口)
//   lib/client.js      アプリ側の薄いクライアント (connect)
//   lib/sql-wasm.wasm  sql.js の SQLite。lib/cloudflare.js が相対パスで import する
//   lib/types/         型定義
// sql.js (MIT) は束ねる。Node 向けの分岐が fs などを参照するので、利用者の設定に alias を求めないためである。
// 実行時の依存はない。lib/cloudflare.js が外から読むのは、cloudflare:workers と、隣に置く wasm だけである。
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, statSync } from "node:fs";
import { build } from "esbuild";
import { workerBundle } from "./esbuild-options.mjs";

rmSync("lib", { recursive: true, force: true });

// src/sql-wasm.wasm は sql.js の配布物の写しである。JS 側と版が揃っていないと起動時に壊れる。
if (!readFileSync("src/sql-wasm.wasm").equals(readFileSync("node_modules/sql.js/dist/sql-wasm.wasm"))) {
  throw new Error("src/sql-wasm.wasm differs from node_modules/sql.js/dist/sql-wasm.wasm; copy it again after upgrading sql.js");
}

const { metafile } = await build({
  entryPoints: { cloudflare: "src/cloudflare.ts", client: "src/binding.ts" },
  ...workerBundle, target: "es2023", outdir: "lib", logLevel: "warning", metafile: true,
  external: ["cloudflare:workers", "*.wasm"],
});
cpSync("src/sql-wasm.wasm", "lib/sql-wasm.wasm");
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });

const server = readFileSync("lib/cloudflare.js", "utf8");
const client = readFileSync("lib/client.js", "utf8");
// 束ねてよい node_modules は sql.js (MIT) だけである。2026-11-14 までパーサだった sql-parser-cst は GPL で、試験の突き合わせ
// (test/parser-old.ts) にだけ残してある。配布物に入ると、配布物が GPL の結合著作物になる。
const bundled = Object.keys(metafile.inputs).filter((path) => path.includes("node_modules/") && !path.includes("node_modules/sql.js/"));
if (bundled.length) throw new Error(`lib/ bundles ${bundled.join(", ")}; only sql.js may be bundled`);
// 実行時の依存はない。外から読むのは、cloudflare:workers と、隣に置く wasm だけである。
const foreign = metafile.outputs["lib/cloudflare.js"].imports.filter((i) => i.external && i.path !== "cloudflare:workers" && !i.path.endsWith(".wasm"));
if (foreign.length) throw new Error(`lib/cloudflare.js imports ${foreign.map((i) => i.path).join(", ")}; the package has no runtime dependencies`);
if (/from\s*"(fs|path|crypto|sql\.js)"/.test(server)) throw new Error("lib/cloudflare.js still imports a module the consumer would have to alias");
if (/typeof process\.versions\.node/.test(server)) throw new Error("lib/cloudflare.js still lets sql.js detect Node; it would fail under nodejs_compat");
if (/cloudflare:workers|sql-parser-cst|sql-wasm/.test(client)) throw new Error("lib/client.js must not pull in the server");
console.log(`lib/cloudflare.js ${statSync("lib/cloudflare.js").size} bytes, lib/client.js ${statSync("lib/client.js").size} bytes`);
