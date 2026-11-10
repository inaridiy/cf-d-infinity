#!/usr/bin/env node
// cf-d-infinity のコマンド。手元で動いている dev サーバ (wrangler dev でも cf dev でも) の DB を、binding 越しに呼ぶ。
//   sql     文を実行して結果を表で出す
//   slow    遅い文の記録を見る
//   status  シャードと範囲表、Autoscaler の履歴を見る
// 使い捨ての Worker を miniflare で立て、DinfDatabase への Service Binding を dev registry 経由で張る。
// HTTP の入口もトークンも使わない。binding を張れることが権限である。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HELP = `cf-d-infinity <command> [options]

Commands:
  sql [SQL]     run SQL and print the result. SQL comes from the argument, --file, or standard input.
                Several statements separated by ";" run in order; the last result is printed.
  slow          list recorded slow statements, newest first (threshold: DINF_SLOW_QUERY_MS, default 500 ms)
  status        list the shards, the slot ranges they own, and recent autoscaler events

Options:
  --local         target the dev server running on this machine (the default, and the only target so far)
  --worker <NAME> the Worker that exports DinfDatabase (default: "name" in ./wrangler.jsonc or ./cloudflare.config.ts)
  --file <PATH>   sql: read the statements from a file
  --param <V>     sql: a bound parameter for "?" placeholders; repeat for more (numbers and null are typed)
  --limit <N>     slow: number of entries (default 20)
  --json          print JSON instead of a table
  -h, --help      show this help

Start the project with \`wrangler dev\` or \`cf dev\` first. The command starts a throwaway local Worker with a
Service Binding to that dev server's DinfDatabase entrypoint, calls it, and exits. No HTTP endpoint and no token
are involved.
`;

class Fail extends Error {}

function parseArgs(argv) {
  const out = { command: argv[0], positional: [], params: [], json: false, limit: 20 };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--worker") out.worker = value();
    else if (a === "--file") out.file = value();
    else if (a === "--param") out.params.push(typed(value()));
    else if (a === "--limit") out.limit = Number(value());
    else if (a === "--json") out.json = true;
    else if (a === "--local") out.local = true;
    else if (a === "--remote") throw new Fail("--remote is not available yet: this command only reaches a dev server on this machine");
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("--")) throw new Fail(`unknown option ${a}; see --help`);
    else out.positional.push(a);
  }
  return out;
}

/** --param の値。数と null はその型で、ほかは文字列で渡す。 */
function typed(v) {
  if (v === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** コメントと末尾のカンマを許す JSON を読む。wrangler.jsonc から Worker の名前を取るためだけに使う。 */
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** DinfDatabase を export している Worker の名前。 */
function workerName(opts, cwd) {
  if (opts.worker) return opts.worker;
  for (const f of ["wrangler.jsonc", "wrangler.json"]) {
    if (!existsSync(join(cwd, f))) continue;
    const name = parseJsonc(readFileSync(join(cwd, f), "utf8")).name;
    if (typeof name === "string" && name) return name;
  }
  if (existsSync(join(cwd, "cloudflare.config.ts"))) {
    // TypeScript の設定は評価せず、文字列で書かれた名前だけを拾う。式で組み立てているなら --worker で渡す。
    const m = /\bname\s*:\s*(["'`])([A-Za-z0-9_-]+)\1/.exec(readFileSync(join(cwd, "cloudflare.config.ts"), "utf8"))
      ?? /\bconst\s+name\s*=\s*(["'`])([A-Za-z0-9_-]+)\1/.exec(readFileSync(join(cwd, "cloudflare.config.ts"), "utf8"));
    if (m) return m[2];
  }
  throw new Fail("cannot tell which Worker to reach: run this in the project directory, or pass --worker <NAME>");
}

/** dev サーバが自分を登録するディレクトリの候補。Wrangler と cf は別の場所と形式を使う。 */
function registryCandidates() {
  const home = homedir();
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const versions = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name)) : []);
  const cf = [process.env.CLOUDFLARE_DEV_REGISTRY_PATH, join(config, "cloudflare", "dev-registry"), join(home, "Library", "Preferences", "cloudflare", "dev-registry")]
    .filter(Boolean).flatMap((d) => [d, ...versions(d)]);
  const wrangler = [process.env.WRANGLER_REGISTRY_PATH, join(config, ".wrangler", "registry"), join(home, "Library", "Preferences", ".wrangler", "registry"), join(home, ".wrangler", "registry")]
    .filter(Boolean);
  return [...wrangler.map((path) => ({ path, tool: "wrangler" })), ...cf.map((path) => ({ path, tool: "cf" }))];
}

/** 利用者のプロジェクトに入っている miniflare を使う。dev サーバと同じ版でないと registry の形式が合わない。 */
async function loadMiniflare(cwd, tool) {
  const from = createRequire(join(cwd, "package.json"));
  const via = tool === "cf" ? ["@cloudflare/vite-plugin", "cf", "wrangler"] : ["wrangler", "@cloudflare/vite-plugin", "cf"];
  const tried = [];
  for (const pkg of [...via, null]) {
    try {
      const base = pkg === null ? from : createRequire(from.resolve(pkg));
      return await import(pathToFileURL(base.resolve("miniflare")).href);
    } catch (e) {
      tried.push(pkg ?? "miniflare");
    }
  }
  throw new Fail(`cannot find miniflare in this project (looked through ${tried.join(", ")}). Install wrangler or cf here; the command uses the same local runtime as your dev server.`);
}

const CONSOLE_WORKER = `
const OPS = new Set(["query", "slowQueries", "status"]);
export default {
  async fetch(request, env) {
    const { op, args } = await request.json();
    if (!OPS.has(op)) return Response.json({ error: "unknown operation " + op });
    try {
      return Response.json({ ok: await env.DINF_DB[op](...args) });
    } catch (e) {
      return Response.json({ error: String((e && e.message) || e) });
    }
  },
};`;

/** 使い捨ての Worker を立て、dev サーバの DinfDatabase を 1 回呼ぶ。 */
async function call(opts, op, args) {
  const cwd = process.cwd();
  const worker = workerName(opts, cwd);
  const found = registryCandidates().find((c) => existsSync(join(c.path, worker)));
  if (!found) {
    throw new Fail(`no dev server is running for the Worker "${worker}". Start it with \`wrangler dev\` or \`cf dev\` in its project, then run this again.`);
  }
  const m = await loadMiniflare(cwd, found.tool);
  const v4 = {
    unsafeDevRegistryPath: found.path,
    workers: [{
      name: "dinf-console",
      modules: [{ type: "ESModule", path: "console.mjs", contents: CONSOLE_WORKER }],
      compatibilityDate: "2026-07-01",
      serviceBindings: { DINF_DB: { name: worker, entrypoint: "DinfDatabase" } },
    }],
  };
  // miniflare 5 (cf が使う) は設定の形が変わった。4 の形から変換する関数を持っている。
  const mf = new m.Miniflare(m.convertV4MiniflareOptions ? m.convertV4MiniflareOptions(v4) : v4);
  try {
    const res = await mf.dispatchFetch("http://dinf.internal/", { method: "POST", body: JSON.stringify({ op, args }) });
    const json = await res.json();
    if (json.error !== undefined) {
      if (/not found\. Make sure it is running locally/.test(json.error)) {
        throw new Fail(`the dev server for "${worker}" is registered but does not answer. Restart \`wrangler dev\` or \`cf dev\`.`);
      }
      if (/does not export|no such entrypoint|DinfDatabase/i.test(json.error)) {
        throw new Fail(`${json.error}\nThe Worker "${worker}" must export DinfDatabase from its main module.`);
      }
      throw new Fail(json.error);
    }
    return json.ok;
  } finally {
    await mf.dispose();
  }
}

const cell = (v) => (v === null || v === undefined ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v));

function table(columns, rows) {
  if (columns.length === 0) return "";
  const cells = rows.map((r) => r.map(cell));
  const width = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (r) => r.map((v, i) => v.padEnd(width[i])).join("  ").trimEnd();
  return [line(columns), line(width.map((w) => "-".repeat(w))), ...cells.map(line)].join("\n");
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function sql(opts) {
  if (opts.file && opts.positional.length > 0) throw new Fail("give the SQL as an argument or with --file, not both");
  const text = opts.file ? readFileSync(opts.file, "utf8")
    : opts.positional.length > 0 ? opts.positional.join(" ")
    : process.stdin.isTTY ? "" : await readStdin();
  if (text.trim() === "") throw new Fail("no SQL: pass it as an argument, with --file, or on standard input");
  const r = await call(opts, "query", [text, opts.params]);
  if (opts.json) return console.log(JSON.stringify({ columns: r.columns, rows: r.rows, changes: r.changes, lastInsertRowid: r.lastInsertRowid }, null, 2));
  if (r.columns.length > 0) {
    console.log(table(r.columns, r.rows.map((row) => r.columns.map((c) => row[c]))));
    console.log(`(${r.rows.length} ${r.rows.length === 1 ? "row" : "rows"})`);
  } else {
    console.log(`OK, ${r.changes} ${r.changes === 1 ? "row" : "rows"} changed`);
  }
}

async function slow(opts) {
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Fail("--limit must be a positive integer");
  const list = await call(opts, "slowQueries", [opts.limit]);
  if (opts.json) return console.log(JSON.stringify(list, null, 2));
  if (list.length === 0) return console.log("No slow statements recorded. The threshold is the var DINF_SLOW_QUERY_MS (default 500 ms; 0 records every statement).");
  const oneLine = (s) => s.replace(/\s+/g, " ").trim();
  console.log(table(
    ["time", "ms", "plan", "shards", "rows", "tries", "statement"],
    list.map((e) => [
      new Date(e.at).toISOString().replace("T", " ").slice(0, 19), e.ms, e.plan || "-", e.shards,
      e.changes > 0 ? `${e.changes} changed` : e.rows, e.attempts,
      (e.error ? `[failed: ${oneLine(e.error).slice(0, 60)}] ` : "") + oneLine(e.sql).slice(0, 100),
    ]),
  ));
}

async function status(opts) {
  const s = await call(opts, "status", []);
  if (opts.json) return console.log(JSON.stringify(s, null, 2));
  const slots = new Map();
  for (const r of s.routing.ranges) slots.set(r.shard, [...(slots.get(r.shard) ?? []), `${r.start}-${r.end - 1}`]);
  console.log(`${s.shards.length} shards, routing version ${s.routing.version}`);
  console.log(table(["shard", "slots"], s.shards.map((id) => [id, (slots.get(id) ?? []).join(", ")])));
  const events = s.scaler.events.filter((e) => e.kind !== "tick").slice(-10);
  const ticks = s.scaler.events.filter((e) => e.kind === "tick");
  console.log(ticks.length === 0 ? "\nAutoscaler: no tick recorded yet (it runs on the Cron Trigger)."
    : `\nAutoscaler: last tick ${new Date(ticks.at(-1).at).toISOString()}`);
  if (events.length > 0) {
    console.log(table(["time", "event", "detail"], events.map((e) => [
      new Date(e.at).toISOString().replace("T", " ").slice(0, 19), e.kind, JSON.stringify(e.detail).slice(0, 100),
    ])));
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.command || opts.command === "-h" || opts.command === "--help") return console.log(HELP);
  if (opts.command === "sql") return sql(opts);
  if (opts.command === "slow") return slow(opts);
  if (opts.command === "status") return status(opts);
  throw new Fail(`unknown command ${opts.command}; see --help`);
}

main(process.argv.slice(2)).catch((e) => {
  if (!(e instanceof Fail)) throw e;
  console.error(`cf-d-infinity: ${e.message}`);
  process.exitCode = 1;
});
