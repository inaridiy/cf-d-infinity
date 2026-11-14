// 100 列に近い表と、100 列に近い主キーの表を、本物の workerd の DO で作り、書き、読む。
//
// DO の SQLite は、式の木の深さを 100 までに制限している (SQLite の既定は 1,000。公式の上限の表にはない。
// test/workerd-limits.test.ts が事実として持っている)。シミュレータの node:sqlite は深さ 1,000 まで受け付けるので、
// シミュレータの試験では見えない。ここで本物の workerd で確かめる。
//
// 値の作り直しの段 0 (2026-11-14) で見つけた欠陥の再現だった。行イメージを読む文 (段 1 までの imageList) が、2^53 を超える整数が
// ないかを見る条件を列ごとに OR でつないだので、97 列から 99 列の表は CREATE TABLE を通るのに、1 行も書けなかった。段 2 で、
// 行イメージはタプルになり、その条件はなくなった。主キーの列を AND でつなぐ条件 (主キーで行を読む、消す、書き換える文) も、
// 主キーの列の数だけ深くなったので、釣り合った木に組む (src/shard/rows.ts の joinTerms)。表を作るときの確かめは、D∞ が作る文の
// 式の深さも見る (src/shard-limits.ts の builtLimitOf)。正しい振る舞いは 2 つのどちらかである。作れた表には書けるか、書けない表は
// CREATE TABLE が表定義だけで決まる理由で断るか (AGENTS.md の規則 4)。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BUNDLE = "dist/worker.wide-tables.js";
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
  for (const columns of [97, 98, 99, 100]) {
    it(`${columns} columns: either CREATE TABLE refuses the table, or rows can be written to it`, async () => {
      const rest = Array.from({ length: columns - 1 }, (_, i) => `c${i} INTEGER`).join(", ");
      const created = await post("/ddl", { sql: `CREATE TABLE w${columns}(id INTEGER PRIMARY KEY, ${rest})` });
      // 段 2 から、主キーのある 100 列までの表は作れる (段 1 までは、変更を捕捉する写しの表が 1 列多く、100 列の表は作れなかった)。
      expect(created.json?.error).toBeUndefined();
      const insert = await post("/sql", { sql: `INSERT INTO w${columns}(id, c0) VALUES (1, 5)`, params: [] });
      expect(insert.json?.error).toBeUndefined();
      const update = await post("/sql", { sql: `UPDATE w${columns} SET c1 = 6 WHERE id = 1`, params: [] });
      expect(update.json?.error).toBeUndefined();
      expect((await post("/sql", { sql: `SELECT id, c0, c1 FROM w${columns}`, params: [] })).json?.rows).toEqual([{ id: 1, c0: 5, c1: 6 }]);
    }, 60000);
  }
});

// 主キーが多くの列にまたがる表。D∞ が作る条件のうち、主キーの列を AND でつなぐもの (行を主キーで読む、消す、書き換える文) は、
// 主キーの列の数だけ深くなる。99 列の主キーでは深さが 100 を超える (値の作り直しの段 2 で足した。2026-11-14)。
describe("a table whose primary key spans almost 100 columns on workerd", () => {
  for (const columns of [50, 99]) {
    it(`${columns} key columns: either CREATE TABLE refuses the table, or rows can be written, changed and deleted`, async () => {
      const cols = Array.from({ length: columns }, (_, i) => `k${i}`);
      const created = await post("/ddl", { sql: `CREATE TABLE p${columns}(${cols.map((c) => `${c} INTEGER NOT NULL`).join(", ")}, v INTEGER, PRIMARY KEY (${cols.join(", ")}))` });
      if (created.status !== 200) {
        expect(created.json?.error).toMatch(/^unsupported: the table p\d+ is too wide/);
        return;
      }
      const key = (n: number) => cols.map((_c, i) => (i === 0 ? n : i)).join(", ");
      const where = (n: number) => cols.map((c, i) => `${c} = ${i === 0 ? n : i}`).join(" AND ");
      for (const n of [1, 2]) {
        const insert = await post("/sql", { sql: `INSERT INTO p${columns}(${cols.join(", ")}, v) VALUES (${key(n)}, ${n * 10})`, params: [] });
        expect(insert.json?.error).toBeUndefined();
      }
      // 主キーで 1 行に絞れない UPDATE は、trigger で捕捉し、変更前の行を主キーで読み直さずに、主キーの条件で書き戻す。
      const update = await post("/sql", { sql: `UPDATE p${columns} SET v = v + 1 WHERE v >= 10`, params: [] });
      expect(update.json?.error).toBeUndefined();
      const remove = await post("/sql", { sql: `DELETE FROM p${columns} WHERE ${where(2)}`, params: [] });
      expect(remove.json?.error).toBeUndefined();
      expect((await post("/sql", { sql: `SELECT k0, v FROM p${columns} ORDER BY k0`, params: [] })).json?.rows).toEqual([{ k0: 1, v: 11 }]);
    }, 60000);
  }
});

// 行イメージのタプルが、DO の SQLite の値の長さの上限 (手元の workerd で 2,200,000 バイト) を超える書き込み。値は上限に収まるが、
// JSON が引用符を逃がす (`"` は 2 バイトになる) ので、タプルにすると収まらない。SQLite は捕捉の中で「string or blob too big」で
// 文を止める。1 行のイメージがその上限を超える書き込みは、取引の大きさの上限 (1,000,000 バイト) も超えるので、同じ誤りで断る
// (docs/design-values.md の「大きさの勘定」)。
describe("a row whose image does not fit in one value on workerd", () => {
  it("is refused as a transaction that is too large, by the RETURNING capture and by the trigger capture", async () => {
    expect((await post("/ddl", { sql: "CREATE TABLE big(id INTEGER PRIMARY KEY, body TEXT)" })).status).toBe(200);
    const body = '"'.repeat(1_200_000);
    const insert = await post("/sql", { sql: "INSERT INTO big VALUES (1, ?)", params: [body] });
    expect(insert.json?.error).toMatch(/^transaction too large/);
    // 主キーで 1 行に絞れない文は、trigger で捕捉する。
    expect((await post("/sql", { sql: "INSERT INTO big VALUES (2, 'a')", params: [] })).json?.error).toBeUndefined();
    const update = await post("/sql", { sql: "UPDATE big SET body = ? WHERE body = 'a'", params: [body] });
    expect(update.json?.error).toMatch(/^transaction too large/);
    expect((await post("/sql", { sql: "SELECT id, body FROM big", params: [] })).json?.rows).toEqual([{ id: 2, body: "a" }]);
  }, 60000);
});
