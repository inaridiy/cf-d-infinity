// Review of f2224ce: access control of the data path (POST /ddl with the data token), on real workerd.
// This was a reproduction of an open defect; it passes now.
//
// Db.ddl(sql) -> parseDdl(sql) looks only at the first statement of `sql`, but for a local CREATE INDEX (and a local
// DROP INDEX) it records the WHOLE text as the shard statement (`sql: [source]`, src/sql/ddl.ts). Meta and every shard
// then pass that text to ctx.storage.sql.exec(), which runs every statement in it. POST /ddl and POST /admin/ddl hand
// the request body to Db.ddl unsplit (POST /sql splits statements first, so it is not affected).
// The simulator cannot show this: node:sqlite's prepare() compiles only the first statement.
//
// The probe statement here is harmless (it creates an empty table with an internal-looking name).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
const post = async (path: string, body: unknown, token = "data-token") => {
  const r = await mf.dispatchFetch(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
};

beforeAll(async () => {
  const out = join(process.env.REVIEW_OUT ?? mkdtempSync(join(tmpdir(), "dinf-review-")), "worker.js");
  execFileSync("npx", ["esbuild", "src/worker.ts", "--bundle", "--format=esm", "--platform=browser", "--external:cloudflare:workers", "--external:*.wasm",
    "--alias:fs=./src/empty.js", "--alias:path=./src/empty.js", "--alias:crypto=./src/empty.js", "--define:process.versions.node=undefined", `--outfile=${out}`], { stdio: "inherit" });
  mf = new Miniflare({
    modules: [
      { type: "ESModule", path: "dist/worker.js", contents: readFileSync(out, "utf8") },
      { type: "CompiledWasm", path: "dist/sql-wasm.wasm", contents: readFileSync("src/sql-wasm.wasm") },
    ],
    compatibilityDate: "2026-07-01",
    bindings: { DINF_SHARD_COUNT: "2", DINF_API_TOKEN: "data-token", DINF_ADMIN_TOKEN: "admin-token" },
    durableObjects: {
      DINF_SHARD: { className: "DinfShard", useSQLite: true },
      DINF_META: { className: "DinfMeta", useSQLite: true },
      DINF_AUTOSCALER: { className: "DinfAutoscaler", useSQLite: true },
    },
  });
}, 120_000);
afterAll(() => mf?.dispose());

describe("POST /ddl with the data token", () => {
  it("does not execute a second statement inside the shards' SQLite", async () => {
    expect((await post("/ddl", { sql: "CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))" })).status).toBe(200);
    expect((await post("/sql", { sql: "INSERT INTO t VALUES (1, 1, 1)" })).status).toBe(200);
    // Does a table of this name exist inside the shard that holds tenant 1? (Uses the CTE scoping gap reported
    // separately to look inside the shard; "no such table" is the expected answer.)
    const probe = () => post("/sql", {
      sql: "SELECT (SELECT count(*) FROM __review_probe) AS n FROM t WHERE tenant_id = 1 AND id = 1 AND EXISTS (WITH __review_probe AS (SELECT 1) SELECT 1 FROM __review_probe)",
    });
    const before = await probe();
    const ddl = await post("/ddl", { sql: "CREATE INDEX t_v ON t(tenant_id, v); CREATE TABLE __review_probe(x)" });
    const after = await probe();
    console.log(JSON.stringify({ before: before.body, ddl, after: after.body }));
    expect(before.body?.error).toMatch(/no such table/);
    // Correct: the request is refused, or the second statement is ignored; either way the shard has no such table.
    expect(String(after.body?.error ?? "")).toMatch(/no such table/);
  }, 60_000);

  it("does not execute a second statement inside Meta's SQLite (which holds the range table and the DDL log)", async () => {
    expect((await post("/ddl", { sql: "CREATE TABLE m(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))" })).status).toBe(200);
    const ddl = await post("/ddl", { sql: "CREATE INDEX m_v ON m(tenant_id, v); CREATE TABLE zzz_probe(a)" });
    const known = await post("/sql", { sql: "SELECT * FROM zzz_probe" });
    // The catalog has no table zzz_probe, so creating it must work. Meta validates the statement in its own SQLite
    // first; it refuses only if the trailing statement above was executed there.
    const create = await post("/ddl", { sql: "CREATE TABLE zzz_probe(id INTEGER PRIMARY KEY)" });
    console.log(JSON.stringify({ ddl, known: known.body, create }));
    expect(String(known.body?.error ?? "")).toMatch(/no such table/);
    expect(create.status).toBe(200);
  }, 60_000);
});
