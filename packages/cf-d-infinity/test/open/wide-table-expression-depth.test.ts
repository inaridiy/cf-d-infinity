// 未解決: 97 列から 99 列の表は、CREATE TABLE を通るのに、DO では 1 行も書けない。
//
// DO の SQLite は、式の木の深さを 100 までに制限している (SQLite の既定は 1,000。公式の上限の表にはない。
// test/workerd-limits.test.ts が事実として持っている)。行イメージを読む文 (src/shard/rows.ts の imageList) は、2^53 を超える整数が
// ないかを見る条件を、列ごとに OR でつなぐ。列が 97 以上あると、この式の深さが 100 を超え、INSERT も UPDATE も
// 「Expression tree is too large (maximum depth 100)」で失敗する。
// 表を作るときの確かめ (src/client/db.ts の assertReplays) は、文の長さと引数の数を見るが、式の深さは見ない。
// シミュレータの node:sqlite は深さ 1,000 まで受け付けるので、シミュレータの試験では通る。本物の workerd でだけ見える。
//
// 正しい振る舞いは 2 つのどちらかである。作れた表には書けるか、書けない表は CREATE TABLE が断るか (表定義だけで決まる拒否は、
// AGENTS.md の規則 4 が認めている)。100 列の表は、すでに CREATE TABLE が断っている。96 列の表には書ける。
// 見つけたのは、値の作り直しの段 0 で、DO の上限を workerd で確かめたとき (2026-11-14)。列ごとの条件は、作り直しの段 2 で
// imageList と一緒になくなる。作り直しで足す式 (主キーの列を AND でつなぐ条件など) も、同じ上限に収まるかを確かめること。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BUNDLE = "dist/worker.open-depth.js";
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

describe("a table with almost 100 columns on workerd", () => {
  for (const columns of [97, 98, 99]) {
    it(`${columns} columns: either CREATE TABLE refuses the table, or rows can be written to it`, async () => {
      const rest = Array.from({ length: columns - 1 }, (_, i) => `c${i} INTEGER`).join(", ");
      const created = await post("/ddl", { sql: `CREATE TABLE w${columns}(id INTEGER PRIMARY KEY, ${rest})` });
      if (created.status !== 200) return;
      const insert = await post("/sql", { sql: `INSERT INTO w${columns}(id, c0) VALUES (1, 5)`, params: [] });
      expect(insert.json?.error).toBeUndefined();
      const update = await post("/sql", { sql: `UPDATE w${columns} SET c1 = 6 WHERE id = 1`, params: [] });
      expect(update.json?.error).toBeUndefined();
      expect((await post("/sql", { sql: `SELECT id, c0, c1 FROM w${columns}`, params: [] })).json?.rows).toEqual([{ id: 1, c0: 5, c1: 6 }]);
    }, 60000);
  }
});
