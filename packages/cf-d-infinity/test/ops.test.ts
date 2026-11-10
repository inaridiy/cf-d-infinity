// 運用の機能を本物の workerd で確かめる。遅い文の記録と、cf-d-infinity コマンド。
// コマンドは使い捨ての Worker を立て、dev registry 経由で DinfDatabase を呼ぶ。ここでは miniflare が dev サーバの役をする。
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- JavaScript のモジュール
import { workerBundle } from "../scripts/esbuild-options.mjs";

const run = promisify(execFile);
const CLI = resolve("bin/cli.js");
let logged: Miniflare;
let quiet: Miniflare;
const registry = mkdtempSync(join(tmpdir(), "dinf-registry-"));

const worker = (name: string, vars: Record<string, string>) => new Miniflare({
  // dev サーバと同じく、自分を registry に登録する。
  unsafeDevRegistryPath: registry,
  name,
  modules: [
    { type: "ESModule", path: "dist/ops-db.js", contents: readFileSync("dist/ops-db.js", "utf8") },
    { type: "CompiledWasm", path: "dist/sql-wasm.wasm", contents: readFileSync("src/sql-wasm.wasm") },
  ],
  compatibilityDate: "2026-07-01",
  bindings: { DINF_SHARD_COUNT: "4", DINF_API_TOKEN: "test", DINF_ADMIN_TOKEN: "admin-test", ...vars },
  durableObjects: {
    DINF_SHARD: { className: "DinfShard", useSQLite: true },
    DINF_META: { className: "DinfMeta", useSQLite: true },
    DINF_AUTOSCALER: { className: "DinfAutoscaler", useSQLite: true },
  },
});
const post = async (mf: Miniflare, path: string, body: unknown, token = "test") => {
  const r = await mf.dispatchFetch(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};
const sql = (mf: Miniflare, s: string, params: unknown[] = []) => post(mf, "/sql", { sql: s, params });
type Slow = { at: number; ms: number; plan: string; shards: number; rows: number; changes: number; attempts: number; error?: string; sql: string };
const slow = async (mf: Miniflare, limit = 200) => (await post(mf, "/admin/slow", { limit }, "admin-test")).json as Slow[];
/** 記録は応答の後で書かれるので、現れるまで少し待つ。 */
const slowFor = async (mf: Miniflare, match: (e: Slow) => boolean) => {
  for (let i = 0; i < 40; i++) {
    const hit = (await slow(mf)).find(match);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
};
const cli = async (args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string } = {}) => {
  const child = run("node", [CLI, ...args], {
    cwd: opts.cwd, env: { PATH: process.env.PATH ?? "", HOME: registry, WRANGLER_REGISTRY_PATH: registry, ...opts.env },
  });
  if (opts.input !== undefined) {
    child.child.stdin!.end(opts.input);
  } else child.child.stdin!.end();
  return child.then((r) => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
};

beforeAll(async () => {
  await build({ ...workerBundle, entryPoints: { "ops-db": "src/cloudflare.ts" }, outdir: "dist", logLevel: "error", external: ["cloudflare:workers", "*.wasm"] });
  logged = worker("ops-db", { DINF_SLOW_QUERY_MS: "0" });
  quiet = worker("ops-quiet", { DINF_SLOW_QUERY_MS: "off" });
  await logged.ready;
  for (const mf of [logged, quiet]) {
    await sql(mf, "CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER NOT NULL, note TEXT)");
    await sql(mf, "INSERT INTO t(id, n) VALUES (1, 10), (2, 20), (3, 30), (4, 40), (5, 50), (6, 60), (7, 70), (8, 80)");
  }
}, 60000);
afterAll(async () => {
  await logged?.dispose();
  await quiet?.dispose();
});

describe("the slow statement log", () => {
  it("records where a statement ran: one shard for a point read, every shard for a scan", async () => {
    await sql(logged, "SELECT n FROM t WHERE id = 3");
    const point = await slowFor(logged, (e) => e.sql === "SELECT n FROM t WHERE id = 3");
    expect(point).toMatchObject({ plan: "shard", shards: 1, rows: 1, changes: 0, attempts: 1 });
    expect(point!.error).toBeUndefined();
    expect(Math.abs(Date.now() - point!.at)).toBeLessThan(60_000);

    await sql(logged, "SELECT sum(n) AS s FROM t");
    const scan = await slowFor(logged, (e) => e.sql === "SELECT sum(n) AS s FROM t");
    expect(scan!.shards).toBe(4);
    expect(["gather", "partial"]).toContain(scan!.plan);
  });

  it("records writes, a batch as one transaction, and failures; never the bound parameters", async () => {
    await sql(logged, "UPDATE t SET note = ? WHERE id = 1", ["s3cret-value"]);
    expect(await slowFor(logged, (e) => e.sql.startsWith("UPDATE t SET note"))).toMatchObject({ plan: "write", shards: 1, changes: 1 });

    await post(logged, "/batch", { statements: [{ sql: "UPDATE t SET n = n + 1 WHERE id = 1" }, { sql: "UPDATE t SET n = n - 1 WHERE id = 2" }] });
    const batch = await slowFor(logged, (e) => e.plan === "transaction");
    expect(batch!.sql).toBe("BEGIN; UPDATE t SET n = n + 1 WHERE id = 1; UPDATE t SET n = n - 1 WHERE id = 2; COMMIT");
    expect(batch!.shards).toBeGreaterThanOrEqual(2);

    expect((await sql(logged, "SELECT * FROM nope")).status).toBe(400);
    expect((await slowFor(logged, (e) => e.sql === "SELECT * FROM nope"))!.error).toMatch(/no such table/);

    expect(JSON.stringify(await slow(logged))).not.toContain("s3cret-value");
  });

  it("returns the newest entries first and honours the limit", async () => {
    await sql(logged, "SELECT 'last' AS marker FROM t WHERE id = 1");
    await slowFor(logged, (e) => e.sql.includes("'last'"));
    const two = await slow(logged, 2);
    expect(two).toHaveLength(2);
    expect(two[0]!.sql).toContain("'last'");
  });

  it("is admin-only", async () => {
    expect((await post(logged, "/admin/slow", {}, "test")).status).toBe(401);
  });
});

describe("the cf-d-infinity command", () => {
  const to = ["--worker", "ops-db"];

  it("runs SQL through a throwaway Worker bound to the dev server, and prints a table; --param binds values", async () => {
    const r = await cli(["sql", "SELECT id, n, note FROM t WHERE id >= ? ORDER BY id LIMIT 2", "--param", "7", ...to]);
    expect([r.code, r.stderr]).toEqual([0, ""]);
    expect(r.stdout).toBe("id  n   note\n--  --  ----\n7   70  NULL\n8   80  NULL\n(2 rows)\n");
    const w = await cli(["sql", "UPDATE t SET note = ? WHERE id = ?", "--param", "hello", "--param", "8", "--local", ...to]);
    expect(w.stdout).toBe("OK, 1 row changed\n");
    expect((await sql(logged, "SELECT note FROM t WHERE id = 8")).json.rows).toEqual([{ note: "hello" }]);
  });

  it("reads statements from a file and from standard input, and prints JSON on request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dinf-cli-"));
    writeFileSync(join(dir, "s.sql"), "CREATE TABLE IF NOT EXISTS f(id INTEGER PRIMARY KEY, v TEXT);\nINSERT OR REPLACE INTO f(id, v) VALUES (1, 'a');\nSELECT v FROM f WHERE id = 1;\n");
    const file = await cli(["sql", "--file", join(dir, "s.sql"), "--json", ...to]);
    expect(JSON.parse(file.stdout)).toMatchObject({ columns: ["v"], rows: [{ v: "a" }] });
    const piped = await cli(["sql", ...to], { input: "SELECT count(*) AS c FROM f" });
    expect(piped.stdout).toBe("c\n-\n1\n(1 row)\n");
  });

  it("takes the Worker name from wrangler.jsonc or cloudflare.config.ts in the current directory", async () => {
    const project = (file: string, content: string) => {
      const dir = mkdtempSync(join(tmpdir(), "dinf-cli-"));
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, file), content);
      symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
      return dir;
    };
    const wrangler = project("wrangler.jsonc", `{\n  // a comment with "name": "wrong"\n  "name": "ops-db", /* trailing */\n  "main": "src/index.ts",\n}\n`);
    expect((await cli(["sql", "SELECT 1 AS one"], { cwd: wrangler })).stdout).toContain("(1 row)");
    const cf = project("cloudflare.config.ts", `import { defineConfig } from "cf/config";\nexport default defineConfig({ worker: { name: "ops-db", compatibilityDate: "2026-11-04" } });\n`);
    expect((await cli(["status"], { cwd: cf })).stdout).toMatch(/^4 shards, routing version \d+\n/);
    const none = await cli(["sql", "SELECT 1"], { cwd: mkdtempSync(join(tmpdir(), "dinf-cli-")) });
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/pass --worker/);
  });

  it("lists slow statements and the cluster status", async () => {
    await cli(["sql", "SELECT 'from the cli' AS x FROM t WHERE id = 1", ...to]);
    await slowFor(logged, (e) => e.sql.includes("from the cli"));
    const s = await cli(["slow", "--limit", "5", ...to]);
    expect(s.stdout.split("\n")[0]).toMatch(/^time\s+ms\s+plan\s+shards\s+rows\s+tries\s+statement$/);
    expect(s.stdout).toContain("SELECT 'from the cli' AS x FROM t WHERE id = 1");
    expect(JSON.parse((await cli(["slow", "--json", "--limit", "1", ...to])).stdout)).toHaveLength(1);
    expect((await cli(["status", ...to])).stdout).toContain("shard-0");
    expect((await cli(["slow", "--worker", "ops-quiet"])).stdout).toMatch(/No slow statements recorded/);
  });

  it("exits with 1 and a readable message on a SQL error, a Worker that is not running, and unusable flags", async () => {
    const err = await cli(["sql", "SELECT * FROM nope", ...to]);
    expect([err.code, err.stdout]).toEqual([1, ""]);
    expect(err.stderr).toMatch(/no such table: nope/);
    const down = await cli(["status", "--worker", "not-running"]);
    expect(down.code).toBe(1);
    expect(down.stderr).toMatch(/no dev server is running for the Worker "not-running"/);
    // --remote は本番を相手にするので、ここでは Wrangler を呼ぶ前に止まる経路だけを確かめる。
    expect((await cli(["sql", "SELECT 1", "--remote", "--local", ...to])).stderr).toMatch(/exclude each other/);
    const bare = mkdtempSync(join(tmpdir(), "dinf-cli-"));
    writeFileSync(join(bare, "package.json"), "{}");
    expect((await cli(["sql", "SELECT 1", "--remote", ...to], { cwd: bare })).stderr).toMatch(/--remote needs Wrangler in this project/);
    expect((await cli(["frobnicate"])).stderr).toMatch(/unknown command/);
  });
});

// 最後に置く。記録の予算を使い切るので、これより後のテストは 10 秒のあいだ記録を確かめられない。
describe("the slow statement log under a burst", () => {
  it("stops recording when a burst exceeds the per-isolate budget, and records nothing when turned off", async () => {
    const before = (await slow(logged)).length;
    for (let i = 0; i < 60; i++) await sql(logged, `SELECT ${i} AS burst FROM t WHERE id = 1`);
    await new Promise((r) => setTimeout(r, 300));
    const added = (await slow(logged)).length - before;
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(60);

    await sql(quiet, "SELECT n FROM t WHERE id = 3");
    await new Promise((r) => setTimeout(r, 300));
    expect(await slow(quiet)).toEqual([]);
  });
});
