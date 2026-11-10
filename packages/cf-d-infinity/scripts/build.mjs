// 公開する lib/ を作る。
//   lib/cloudflare.js  Worker に組み込む側 (DO のクラス、DinfDatabase、HTTP と Cron の入口)
//   lib/client.js      アプリ側の薄いクライアント (connect)
//   lib/sql-wasm.wasm  sql.js の SQLite。lib/cloudflare.js が相対パスで import する
//   lib/types/         型定義
// sql.js (MIT) は束ねる。Node 向けの分岐が fs などを参照するので、利用者の設定に alias を求めないためである。
// sql-parser-cst (GPL-2.0-or-later) は束ねず、依存として参照する。束ねると配布物が GPL の結合著作物になる。
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, statSync } from "node:fs";
import { build } from "esbuild";
import { workerBundle } from "./esbuild-options.mjs";

rmSync("lib", { recursive: true, force: true });

// src/sql-wasm.wasm は sql.js の配布物の写しである。JS 側と版が揃っていないと起動時に壊れる。
if (!readFileSync("src/sql-wasm.wasm").equals(readFileSync("node_modules/sql.js/dist/sql-wasm.wasm"))) {
  throw new Error("src/sql-wasm.wasm differs from node_modules/sql.js/dist/sql-wasm.wasm; copy it again after upgrading sql.js");
}

await build({
  entryPoints: { cloudflare: "src/cloudflare.ts", client: "src/binding.ts" },
  ...workerBundle, target: "es2023", outdir: "lib", logLevel: "warning",
  external: ["cloudflare:workers", "sql-parser-cst", "*.wasm"],
});
cpSync("src/sql-wasm.wasm", "lib/sql-wasm.wasm");
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });

const server = readFileSync("lib/cloudflare.js", "utf8");
const client = readFileSync("lib/client.js", "utf8");
if (!/from\s*"sql-parser-cst"/.test(server)) throw new Error("sql-parser-cst must stay an external import");
if (/from\s*"(fs|path|crypto|sql\.js)"/.test(server)) throw new Error("lib/cloudflare.js still imports a module the consumer would have to alias");
if (/typeof process\.versions\.node/.test(server)) throw new Error("lib/cloudflare.js still lets sql.js detect Node; it would fail under nodejs_compat");
if (/cloudflare:workers|sql-parser-cst|sql-wasm/.test(client)) throw new Error("lib/client.js must not pull in the server");
console.log(`lib/cloudflare.js ${statSync("lib/cloudflare.js").size} bytes, lib/client.js ${statSync("lib/client.js").size} bytes`);
