// 1 操作あたりの課金行数を、本物の workerd の DO SQLite で数える。ROWCOST=1 のときだけ動く。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
const post = async (path: string, body: unknown) => {
  const auth = path.startsWith("/admin/") ? "admin-test" : "test";
  const r = await mf.dispatchFetch(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${auth}` } });
  const j = (await r.json()) as Record<string, unknown>;
  if (j.error) throw new Error(String(j.error));
  return j;
};
const N = 40;
type Stat = Record<string, { calls: number; rowsWritten: number; rowsRead: number }>;

const SHARDS = 4;

/**
 * 1 操作あたりの課金行数を返す。
 * シャードは HLC の上限を `__meta` に保存する。これは操作の数ではなく時間で決まり、シャードごとに毎秒 1 行までである。
 * 操作あたりの行数に混ぜると、計測が秒の境目を跨ぐかどうかで結果が揺れるので、分けて上限を検査する。
 */
async function measure(name: string, op: (i: number) => Promise<unknown>) {
  await post("/admin/rowstats", {});
  const t0 = Date.now();
  for (let i = 0; i < N; i++) await op(i);
  const seconds = (Date.now() - t0) / 1000;
  const s = (await post("/admin/rowstats", {})) as Stat;
  const clock = Object.entries(s).filter(([k]) => k.endsWith(" __meta")).reduce((a, [, v]) => a + v.rowsWritten, 0);
  const w = (Object.values(s).reduce((a, v) => a + v.rowsWritten, 0) - clock) / N;
  const parts = Object.entries(s).filter(([, v]) => v.rowsWritten > 0).sort((a, b) => b[1].rowsWritten - a[1].rowsWritten)
    .map(([k, v]) => `${k}=${(v.rowsWritten / N).toFixed(2)}`);
  console.log(`ROWCOST ${name}: ${w.toFixed(2)} rows/op + ${clock} clock rows in ${seconds.toFixed(2)} s  [${parts.join(", ")}]`);
  expect(clock, `${name}: clock rows`).toBeLessThanOrEqual(SHARDS * (Math.ceil(seconds) + 1));
  return w;
}

beforeAll(async () => {
  execFileSync("npm", ["run", "-s", "bundle"], { stdio: "inherit" });
  mf = new Miniflare({
    modules: [
      { type: "ESModule", path: "dist/worker.js", contents: readFileSync("dist/worker.js", "utf8") },
      { type: "CompiledWasm", path: "dist/sql-wasm.wasm", contents: readFileSync("src/sql-wasm.wasm") },
    ],
    compatibilityDate: "2026-07-01",
    bindings: { DINF_SHARD_COUNT: String(SHARDS), DINF_API_TOKEN: "test", DINF_ADMIN_TOKEN: "admin-test" },
    durableObjects: {
      DINF_SHARD: { className: "DinfShard", useSQLite: true },
      DINF_META: { className: "DinfMeta", useSQLite: true },
      DINF_AUTOSCALER: { className: "DinfAutoscaler", useSQLite: true },
    },
  });
  await post("/ddl", { sql: "CREATE TABLE b(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id,id)) SHARD KEY (tenant_id)" });
  await post("/ddl", { sql: "CREATE TABLE u(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT, PRIMARY KEY (tenant_id,id)) SHARD KEY (tenant_id)" });
  await post("/ddl", { sql: "CREATE UNIQUE INDEX u_email ON u(email)" });
  for (let t = 1; t <= 200; t++) await post("/sql", { sql: "INSERT INTO b(tenant_id,id,n) VALUES (?,1,0)", params: [t] });
}, 120000);
afterAll(() => mf?.dispose());

describe.skipIf(!process.env.ROWCOST)("billed rows per operation", () => {
  it("measures", async () => {
    const sql = (s: string, params: unknown[]) => post("/sql", { sql: s, params });
    // 上限は本体の行 (主キーと rowid を持つ表は 2 行) と変更ログの 1 行。
    expect(await measure("insert (autocommit)", (i) => sql("INSERT INTO b(tenant_id,id,n) VALUES (?,2,0)", [i + 1]))).toBeLessThanOrEqual(3);
    expect(await measure("update by pk (autocommit)", (i) => sql("UPDATE b SET n = n + 1 WHERE tenant_id = ? AND id = 1", [(i % 200) + 1]))).toBeLessThanOrEqual(2);
    expect(await measure("read by pk", (i) => sql("SELECT n FROM b WHERE tenant_id = ? AND id = 1", [(i % 200) + 1]))).toBe(0);
    expect(await measure("batch: read + update same shard", (i) => post("/batch", { statements: [
      { sql: "SELECT n FROM b WHERE tenant_id = ? AND id = 1", params: [(i % 200) + 1] },
      { sql: "UPDATE b SET n = n + 1 WHERE tenant_id = ? AND id = 1", params: [(i % 200) + 1] }] }))).toBeLessThanOrEqual(3.2);
    await measure("batch: 2 updates, 2 tenants", (i) => post("/batch", { statements: [
      { sql: "UPDATE b SET n = n - 1 WHERE tenant_id = ? AND id = 1", params: [(i % 100) + 1] },
      { sql: "UPDATE b SET n = n + 1 WHERE tenant_id = ? AND id = 1", params: [(i % 100) + 101] }] }));
    await measure("insert with global unique index", (i) => sql("INSERT INTO u(tenant_id,id,email) VALUES (?,1,?)", [i + 1, `u${i}@x`]));
  }, 300000);
});
