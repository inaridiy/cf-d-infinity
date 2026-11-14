// 未解決: 式の木が深い利用者の文は、DO でだけ失敗し、シミュレータでは通る。
//
// DO の SQLite は、式の木の深さを 100 までに制限している (test/workerd-limits.test.ts)。シャードは、届いた文の深さを測らない
// (src/shard-limits.ts の shardLimitOf は、文の長さ、束縛の変数の数、複合 SELECT の項の数、値の大きさだけを見る)。D∞ が作る文は、
// 表を作るときに深さを確かめる (builtLimitOf) が、利用者の文は確かめない。さらに、整数の引数を `(CAST(? AS INTEGER)+0)` で包む
// 書き換え (src/value.ts の bindTyped) は、1 項あたり深さを 2 足すので、SQLite に直に送れば通る文が、D∞ では深さ 100 を超える。
// node:sqlite は深さ 1,000 まで受け付けるので、シミュレータの試験では見えない。
// 値の作り直しの段 2 で、99 列の主キーの表を workerd で確かめていて見つけた (2026-11-14)。
//
// 正しい振る舞いは 2 つのどちらかである。シミュレータと同じく答えるか (シャードが深すぎる文を ShardLimit で断り、Worker が
// 基準経路で実行し直す。Worker の SQLite の上限は 1,000 である)、文の形で決まる理由で、どこでも同じように断るか。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BUNDLE = "dist/worker.open-user-depth.js";
let mf: Miniflare;
const post = async (path: string, body: unknown) => {
  const r = await mf.dispatchFetch(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer test" } });
  return { status: r.status, json: (await r.json().catch(() => null)) as { error?: string; rows?: unknown[] } | null };
};

beforeAll(() => {
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
}, 60000);
afterAll(() => mf?.dispose());

describe("a user statement whose expression tree is deeper than the DO SQLite allows", () => {
  it("answers as SQLite does: a row looked up by its 99-column key with bound integers", async () => {
    // 99 項の `k = ?` を AND でつなぐと、SQLite に直に送れば深さ 100 で通る。整数の引数を包むと 102 になる。
    const cols = Array.from({ length: 99 }, (_, i) => `k${i}`);
    const created = await post("/ddl", { sql: `CREATE TABLE p(${cols.map((c) => `${c} INTEGER NOT NULL`).join(", ")}, v INTEGER, PRIMARY KEY (${cols.join(", ")}))` });
    expect(created.json?.error).toBeUndefined();
    const values = cols.map((_c, i) => i);
    expect((await post("/sql", { sql: `INSERT INTO p(${cols.join(", ")}, v) VALUES (${cols.map(() => "?").join(", ")}, 7)`, params: values })).json?.error).toBeUndefined();
    const read = await post("/sql", { sql: `SELECT v FROM p WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")}`, params: values });
    expect(read.json?.error).toBeUndefined();
    expect(read.json?.rows).toEqual([{ v: 7 }]);
  }, 60000);
});
