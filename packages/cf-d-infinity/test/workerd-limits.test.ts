// 本物の workerd と Durable Object の SQLite で確かめる。シミュレータの SQLite と上限や振る舞いが違わないことを見る。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerOf, type Routing } from "../src/routing";

// ほかのテスト (autoscale-cron) も同時に bundle を作る。同じファイルへ書くと、読み込みの途中で書き換わるので、出力先を分ける。
const BUNDLE = "dist/worker.limits.js";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const instances: Miniflare[] = [];
function worker(): Miniflare {
  const mf = new Miniflare({
    modules: [
      { type: "ESModule", path: "dist/worker.js", contents: readFileSync(BUNDLE, "utf8") },
      { type: "CompiledWasm", path: "dist/sql-wasm.wasm", contents: readFileSync("src/sql-wasm.wasm") },
    ],
    compatibilityDate: "2026-07-01",
    bindings: { DINF_SHARD_COUNT: "2", DINF_API_TOKEN: "test", DINF_ADMIN_TOKEN: "admin-test" },
    durableObjects: {
      DINF_SHARD: { className: "DinfShard", useSQLite: true },
      DINF_META: { className: "DinfMeta", useSQLite: true },
      DINF_AUTOSCALER: { className: "DinfAutoscaler", useSQLite: true },
    },
  });
  instances.push(mf);
  return mf;
}
const on = (mf: Miniflare) => async (path: string, body: unknown, token = "test") => {
  const r = await mf.dispatchFetch(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};

beforeAll(() => {
  const script = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: { bundle: string } }).scripts.bundle;
  const args = script.split(" ").slice(1).map((a) => (a.startsWith("--outfile=") ? `--outfile=${BUNDLE}` : a));
  execFileSync("npx", ["esbuild", ...args], { stdio: "inherit" });
}, 60000);
afterAll(async () => {
  for (const mf of instances) await mf.dispose();
});

describe("real Durable Object SQLite", () => {
  it("refuses, before commit, a transaction whose rows are small in characters but too large in bytes", async () => {
    const post = on(worker());
    await post("/ddl", { sql: "CREATE TABLE docs(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, body TEXT, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)" });
    const st = (await post("/admin/status", {}, "admin-test")).json as { routing: Routing };
    const tenantOn = (shard: string) => { for (let t = 1; ; t++) if (ownerOf(st.routing, JSON.stringify([t])) === shard) return t; };
    const [A, B] = [tenantOn("shard-0"), tenantOn("shard-1")];
    const cjk = "あ".repeat(380_000); // 380,000 文字は UTF-8 で 1.14 MB
    const commit = await post("/batch", { statements: [
      { sql: "INSERT INTO docs VALUES (?, 1, 'small')", params: [A] },
      { sql: "INSERT INTO docs VALUES (?, 1, ?)", params: [B, cjk] },
      { sql: "INSERT INTO docs VALUES (?, 2, ?)", params: [B, cjk] },
    ] });
    expect(commit.status).toBe(400);
    expect(commit.json.error).toMatch(/transaction too large/);
    const after = (await post("/admin/status", {}, "admin-test")).json as { health: { intents: number; unapplied: number }[]; problems: string[] };
    expect(after.health.map((h) => h.intents + h.unapplied)).toEqual([0, 0]);
    expect(after.problems).toEqual([]);
    expect((await post("/sql", { sql: "SELECT count(*) AS n FROM docs", params: [] })).json.rows).toEqual([{ n: 0 }]);
  }, 60000);

  it("refuses a DDL statement that SQLite rejects, and keeps serving", async () => {
    const post = on(worker());
    await post("/ddl", { sql: "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)" });
    await post("/sql", { sql: "INSERT INTO users(id, name) VALUES (1, 'a')", params: [] });
    const cols = ["id INTEGER PRIMARY KEY", ...Array.from({ length: 99 }, (_, i) => `c${i} INTEGER`)].join(", ");
    // 100 列の表は、変更を捕捉する内部の表が 101 列になるので作れない。
    for (const sql of ["ALTER TABLE users ADD COLUMN x INTEGER NOT NULL", `CREATE TABLE wide(${cols})`]) {
      expect((await post("/ddl", { sql })).status).not.toBe(200);
    }
    await sleep(2500); // isolate の表定義のキャッシュ (2 秒) が切れるのを待つ
    expect((await post("/sql", { sql: "SELECT name FROM users WHERE id = 1", params: [] })).json.rows).toEqual([{ name: "a" }]);
    expect((await post("/sql", { sql: "INSERT INTO users(id, name) VALUES (2, 'b')", params: [] })).status).toBe(200);
    expect((await post("/ddl", { sql: "CREATE TABLE fine(id INTEGER PRIMARY KEY)" })).status).toBe(200);
    const status = (await post("/admin/status", {}, "admin-test")).json as { schema: number; health: { schema: number }[]; problems: string[] };
    expect(status.health.map((h) => h.schema)).toEqual(status.health.map(() => status.schema));
    expect(status.problems).toEqual([]);
  }, 60000);
});
