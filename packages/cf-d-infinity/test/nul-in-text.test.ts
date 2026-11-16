// NUL (U+0000) を含む TEXT を、どの経路でも全部返し、全部保存すること (段 0 に見つけた欠陥。値の作り直しの段 3 で直り、
// test/open/ から移した)。
//
// sql.js (Worker の SQLite) と node:sqlite のドライバは、結果の TEXT を C の文字列として読むので、最初の NUL から後ろを落として返す。
// 値そのものは切れていない (hex() で見える)。DO の SQLite のドライバは全部を返す。段 2 までは、次の 2 つが起きていた。
// - シャードが答える文 (主キーで 1 行を読む) は全部を返し、Worker の SQLite が答える文 (行を集めて答える文、表を読まない文) は
//   切って返した。同じ値の答えが、文がどこで実行されたかで変わった (AGENTS.md の規則 4)。
// - INSERT … SELECT は、Worker の SQLite で読んだ行を引数に戻して書く。切れた値が保存され、黙ってデータを失った。
// シミュレータの検査では見えなかった。シャードの代わりの node:sqlite も、基準の node:sqlite も、同じように NUL で切って返したからである。
// 段 3 で、検査の側 (シミュレータと基準) が TEXT を全部読むようにしてから、Worker の SQLite の読みを型つきにした (TEXT を BLOB で
// 運ぶ。src/value.ts の scratchElemSql)。test/workerd-limits.test.ts が、3 つのドライバの違いを事実として持っている。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { SimCluster } from "./sim";

const NUL = "a\u0000b";
const BUNDLE = "dist/worker.nul.js";
let mf: Miniflare;
const sql = async (s: string, params: unknown[] = []) => {
  const r = await mf.dispatchFetch("http://x/sql", { method: "POST", body: JSON.stringify({ sql: s, params }), headers: { authorization: "Bearer test" } });
  const j = (await r.json()) as { rows?: Record<string, unknown>[]; error?: string };
  if (j.error) throw new Error(j.error);
  return j.rows ?? [];
};

beforeAll(async () => {
  const script = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: { bundle: string } }).scripts.bundle;
  execFileSync("npx", ["esbuild", ...script.split(" ").slice(1).map((a) => (a.startsWith("--outfile=") ? `--outfile=${BUNDLE}` : a))], { stdio: "inherit" });
  mf = new Miniflare({
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
  for (const ddl of ["CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", "CREATE TABLE t2(id INTEGER PRIMARY KEY, v TEXT)"]) {
    await mf.dispatchFetch("http://x/ddl", { method: "POST", body: JSON.stringify({ sql: ddl }), headers: { authorization: "Bearer test" } });
  }
  await sql("INSERT INTO t(id, v) VALUES (1, ?), (2, ?), (3, ?), (4, ?)", [NUL, NUL, NUL, NUL]);
}, 60000);
afterAll(() => mf?.dispose());

describe("a TEXT that contains a NUL character", () => {
  it("comes back whole from a statement that the Worker's SQLite answers (simulator; no shard is involved)", async () => {
    const db = new Db(new SimCluster({ shards: 2 }));
    expect((await db.query("SELECT ? AS v, hex(?) AS h", [NUL, NUL])).rows).toEqual([{ v: NUL, h: "610062" }]);
  });

  it("comes back whole on workerd, whether a shard or the Worker's SQLite answers", async () => {
    // 主キーで 1 行を読む文は、シャードが答える。
    expect(await sql("SELECT v, hex(v) AS h FROM t WHERE id = 1")).toEqual([{ v: NUL, h: "610062" }]);
    // 表を読まない文と、2 つのシャードの行を集める文は、Worker の SQLite が答える。
    expect(await sql("SELECT ? AS v", [NUL])).toEqual([{ v: NUL }]);
    expect(await sql("SELECT id, v FROM t ORDER BY id")).toEqual([1, 2, 3, 4].map((id) => ({ id, v: NUL })));
    expect(await sql("SELECT a.v FROM t a JOIN t b ON a.id = b.id ORDER BY a.id")).toEqual([1, 2, 3, 4].map(() => ({ v: NUL })));
  });

  it("is stored whole by INSERT … SELECT on workerd", async () => {
    await sql("INSERT INTO t2(id, v) SELECT id, v FROM t");
    expect(await sql("SELECT id, hex(v) AS h FROM t2 ORDER BY id")).toEqual([1, 2, 3, 4].map((id) => ({ id, h: "610062" })));
  });
});
