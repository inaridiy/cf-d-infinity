// UNIQUE に触れる書き込み 1 回あたりの課金行数の、いまの数 (docs/design-unique-keys.md の段 0 の (d))。
//
// 段 3 は、シャードの中の UNIQUE をキーの行にし、試適用 (uniquePending、checkUnique) の書き込みと巻き戻しを消す。代わりに、値の変わる
// キーごとにキーの行を書く (設計の「持ち主の判断が要ること」の 2)。差し引きを、ここに記録した数と比べる。
//
// 数え方は test/rowcost.test.ts と同じである。手元の workerd (Miniflare) の DO の SQLite が数える rowsWritten と rowsRead を、
// /admin/rowstats で文の種類と表ごとに合計し、操作の回数で割る。シャードが HLC の上限を `__meta` に書く行は、操作の数ではなく時間で
// 決まるので除く。操作は、どれも同じ形で揃える (衝突する操作は全部が衝突し、しない操作は全部がしない)。変更した行の数 (changes) も
// 確かめる。
//
// 数を固定する (PINNED)。数が変わったら、この試験が落ちる。意図した変更なら、出力の UNIQUE-ROWCOST の行を見て PINNED を書き直し、
// 段 3 の比べ方 (設計書の「段 0 の結果」) にも書く。
//
// 2026-11-17 に 2 つの数が減った (global: insert が 15 から 14.5、global: update the UNIQUE value が 20.95 から 20.5)。取引が溜めた
// 書き込みのうち、文に付けてシャードへ送る分 (overlay) を、文の範囲が名指す表の書き込みだけにしたからである (src/client/db.ts の
// Txn.overlay。docs/design-catalog-epoch.md の「表ごとの epoch」の実装の結果)。index の表を引く読みが、同じシャード宛の表 gu の書き込みを、
// 適用して巻き戻さなくなった。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ほかの試験と同じファイルに bundle を書くと、読み込みの途中で書き換わる (test/workerd-limits.test.ts)。出力先を分ける。
const BUNDLE = "dist/worker.unique-rowcost.js";
const SHARDS = 4;
const N = 20;
type Stat = Record<string, { calls: number; rowsWritten: number; rowsRead: number }>;

let mf: Miniflare;
const post = async (path: string, body: unknown) => {
  const auth = path.startsWith("/admin/") ? "admin-test" : "test";
  const r = await mf.dispatchFetch(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${auth}` } });
  const j = (await r.json()) as Record<string, unknown>;
  if (j.error) throw new Error(`${JSON.stringify(body).slice(0, 200)}: ${String(j.error)}`);
  return j;
};
const sql = (s: string, params: unknown[] = []) => post("/sql", { sql: s, params }) as Promise<{ changes: number }>;

interface Cost {
  /** 書いた行 / 操作 (`__meta` の時計の行を除く)。 */
  written: number;
  /** 文の種類と表ごとの、書いた行 / 操作。 */
  parts: Record<string, number>;
  /** 利用者の表を読んだ行 / 操作。 */
  read: number;
}

const round = (x: number) => Math.round(x * 100) / 100;

/** 操作を N 回流して、1 回あたりの行数を返す。changes は、どの操作でも同じでなければならない。 */
async function measure(name: string, changes: number, op: (i: number) => string | [string, unknown[]]): Promise<Cost> {
  await post("/admin/rowstats", {});
  for (let i = 0; i < N; i++) {
    const s = op(i);
    const [text, params] = typeof s === "string" ? [s, []] : s;
    const r = await sql(text, params);
    expect(r.changes, `${name}: changes of operation ${i}`).toBe(changes);
  }
  const s = (await post("/admin/rowstats", {})) as Stat;
  const parts: Record<string, number> = {};
  let written = 0;
  let read = 0;
  for (const [k, v] of Object.entries(s)) {
    if (!/ __/.test(k)) read += v.rowsRead;
    // 変更ログの世代を作る文 (`CREATE __log_g…`) は、世代が切り替わった操作にだけ課金される。いつ切り替わるかは時計と実行の
    // 進み方で決まり、書き込みの形では決まらない (2026-11-16、同じ操作が 20.95 と 21.35 を行き来した差は、これだった)。数えない。
    if (k.endsWith(" __meta") || v.rowsWritten === 0 || /^CREATE __log_g\d+$/.test(k)) continue;
    written += v.rowsWritten;
    // 変更ログの表の名前 (`__log_g<グループ>`) は、置き場所で決まる。内訳では 1 つにまとめる。
    const part = k.replace(/ __log_g\d+$/, " __log");
    parts[part] = round((parts[part] ?? 0) + v.rowsWritten / N);
  }
  const cost = { written: round(written / N), parts, read: round(read / N) };
  const shown = Object.entries(parts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  console.log(`UNIQUE-ROWCOST ${name}: ${cost.written} rows/op [${shown}] read ${cost.read} rows/op`);
  return cost;
}

/** 固定した数。範囲 [下, 上] は、実行ごとに変わる数である。 */
type Pin = number | [number, number];

/**
 * いまの数 (2026-11-15、b875aa5 の上で、手元の workerd。8 回流して同じだった)。written は書いた行 / 操作、parts はその内訳で、
 * 鍵は「文の種類 表」である (`__log` は変更ログ、`__cap_on` は捕捉の trigger の印、`__intents` と `__txn` は 2PC の記録)。
 * 段 3 で変わる。変わった数は、設計書の「段 0 の結果」の表と比べる。
 *
 * シャードをまたぐ UNIQUE の表への OR REPLACE と upsert (どちらも基準経路で、Worker の SQLite が衝突を決める) は、利用者の表への
 * INSERT と DELETE の行の数が、実行ごとに変わる (8 回で、OR REPLACE の DELETE gu は 1.25 から 1.55、upsert の INSERT gu は 0.7 から 1、
 * DELETE gu は 0.35 から 0.5)。ほかの内訳は同じだった (計算機に負荷を掛けた 3 回も同じだった)。操作の間で、全部のシャードの intent と
 * 未適用の確定がなくなるまで待っても、変わり方は同じだったので、前の操作の後始末の遅れではない。どこから来るかは分かっていない。
 * この 2 つは範囲で固定する。
 */
const PINNED: Record<string, { written: Pin; parts: Record<string, Pin> }> = {
  "local: insert": { written: 4, parts: { "INSERT lu": 3, "INSERT __log": 1 } },
  "local: update the UNIQUE value": { written: 7, parts: { "UPDATE lu": 5, "INSERT __cap_on": 1, "INSERT __log": 1 } },
  "local: update another column": { written: 2, parts: { "INSERT __log": 1, "UPDATE lu": 1 } },
  "local: INSERT OR IGNORE that conflicts": { written: 1, parts: { "INSERT __cap_on": 1 } },
  "local: INSERT OR IGNORE that does not conflict": { written: 9, parts: { "INSERT lu": 7, "INSERT __cap_on": 1, "INSERT __log": 1 } },
  "local: INSERT OR REPLACE that displaces a row": { written: 11, parts: { "INSERT lu": 8, "DELETE lu": 1, "INSERT __cap_on": 1, "INSERT __log": 1 } },
  "local: upsert on the UNIQUE": { written: 6, parts: { "INSERT lu": 2, "UPDATE lu": 2, "INSERT __cap_on": 1, "INSERT __log": 1 } },
  "local: delete": { written: 2, parts: { "DELETE lu": 1, "INSERT __log": 1 } },
  "global: insert": { written: 14.5, parts: { "INSERT gu": 4, "INSERT __intents": 3, "INSERT __gidx_gu_0_key": 2, "INSERT __log": 1.75, "DELETE __intents": 1.5, "INSERT __txn": 1.5, "UPDATE __txn": 0.75 } },
  "global: update the UNIQUE value": { written: 20.5, parts: { "INSERT __intents": 5.4, "UPDATE gu": 4, "DELETE __intents": 2.7, "INSERT __log": 2.45, "INSERT __gidx_gu_0_key": 2, "INSERT __txn": 1.8, "DELETE __gidx_gu_0_key": 1.25, "UPDATE __txn": 0.9 } },
  "global: update another column": { written: 4, parts: { "UPDATE gu": 3, "INSERT __log": 1 } },
  "global: INSERT OR IGNORE that conflicts": { written: 0, parts: {} },
  "global: INSERT OR IGNORE that does not conflict": { written: 12.5, parts: { "INSERT __intents": 3, "INSERT __gidx_gu_0_key": 2, "INSERT gu": 2, "INSERT __log": 1.75, "DELETE __intents": 1.5, "INSERT __txn": 1.5, "UPDATE __txn": 0.75 } },
  "global: INSERT OR REPLACE that displaces a row": { written: [19.35, 20.35], parts: { "INSERT __intents": 5.7, "INSERT gu": 3.6, "DELETE __intents": 2.85, "INSERT __log": 2.35, "INSERT __txn": 1.9, "DELETE gu": [1, 2], "UPDATE __gidx_gu_0_key": 1, "UPDATE __txn": 0.95 } },
  "global: upsert on the UNIQUE": { written: [9, 11.25], parts: { "INSERT __intents": 2, "INSERT __txn": 2, "UPDATE gu": 2, "DELETE __intents": 1, "INSERT __log": 1, "UPDATE __txn": 1, "INSERT gu": [0, 1.5], "DELETE gu": [0, 0.75] } },
  "global: delete": { written: 11.5, parts: { "INSERT __intents": 3, "DELETE gu": 2, "INSERT __log": 1.75, "DELETE __intents": 1.5, "INSERT __txn": 1.5, "DELETE __gidx_gu_0_key": 1, "UPDATE __txn": 0.75 } },
};

/** 測った数と固定した数の違い。 */
function differences(name: string, got: Cost, pin: { written: Pin; parts: Record<string, Pin> } | undefined): string[] {
  if (!pin) return [`${name}: not pinned`];
  const fits = (x: number, p: Pin) => (typeof p === "number" ? x === p : x >= p[0] && x <= p[1]);
  const out: string[] = [];
  if (!fits(got.written, pin.written)) out.push(`${name}: ${got.written} rows/op, pinned ${JSON.stringify(pin.written)}`);
  for (const k of new Set([...Object.keys(got.parts), ...Object.keys(pin.parts)])) {
    const [x, p] = [got.parts[k], pin.parts[k]];
    if (x === undefined || p === undefined || !fits(x, p)) out.push(`${name}: ${k} ${x ?? "none"}, pinned ${JSON.stringify(p ?? "none")}`);
  }
  return out;
}

beforeAll(async () => {
  const script = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: { bundle: string } }).scripts.bundle;
  const args = script.split(" ").slice(1).map((a) => (a.startsWith("--outfile=") ? `--outfile=${BUNDLE}` : a));
  execFileSync("npx", ["esbuild", ...args], { stdio: "inherit" });
  mf = new Miniflare({
    modules: [
      { type: "ESModule", path: "dist/worker.js", contents: readFileSync(BUNDLE, "utf8") },
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
  // シャードの中の UNIQUE (shard key を含む) と、シャードをまたぐ UNIQUE (含まない)。
  await post("/ddl", { sql: "CREATE TABLE lu(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code))" });
  await post("/ddl", { sql: "CREATE TABLE gu(id INTEGER PRIMARY KEY, email TEXT UNIQUE, n INTEGER NOT NULL DEFAULT 0)" });
  for (let t = 1; t <= N; t++) {
    await sql("INSERT INTO lu(tenant_id, id, code) VALUES (?, 1, 'c1'), (?, 2, 'c2')", [t, t]);
    await sql("INSERT INTO gu(id, email) VALUES (?, ?)", [t, `e${t}`]);
  }
}, 120_000);
afterAll(() => mf?.dispose());

describe("billed rows per write that touches a UNIQUE, today", () => {
  it("are the pinned numbers", async () => {
    const t = (i: number) => i + 1;
    const got: Record<string, Cost> = {};
    const m = async (name: string, changes: number, op: (i: number) => string | [string, unknown[]]) => (got[name] = await measure(name, changes, op));
    // 計測の外で 1 回流して、文の用意と表定義の読み込みを済ませる。
    await sql("INSERT INTO lu(tenant_id, id, code) VALUES (1000, 1, 'w')");
    await sql("INSERT INTO gu(id, email) VALUES (1000, 'w')");

    // シャードの中の UNIQUE (tenant_id, code)。どの操作も、テナントごとに 1 行を名指しする。
    await m("local: insert", 1, (i) => [`INSERT INTO lu(tenant_id, id, code) VALUES (?, 3, 'c3')`, [t(i)]]);
    await m("local: update the UNIQUE value", 1, (i) => [`UPDATE lu SET code = 'c3x' WHERE tenant_id = ? AND id = 3`, [t(i)]]);
    await m("local: update another column", 1, (i) => [`UPDATE lu SET n = n + 1 WHERE tenant_id = ? AND id = 3`, [t(i)]]);
    await m("local: INSERT OR IGNORE that conflicts", 0, (i) => [`INSERT OR IGNORE INTO lu(tenant_id, id, code) VALUES (?, 4, 'c1')`, [t(i)]]);
    await m("local: INSERT OR IGNORE that does not conflict", 1, (i) => [`INSERT OR IGNORE INTO lu(tenant_id, id, code) VALUES (?, 4, 'c4')`, [t(i)]]);
    await m("local: INSERT OR REPLACE that displaces a row", 1, (i) => [`INSERT OR REPLACE INTO lu(tenant_id, id, code) VALUES (?, 5, 'c4')`, [t(i)]]);
    await m("local: upsert on the UNIQUE", 1, (i) => [`INSERT INTO lu(tenant_id, id, code) VALUES (?, 6, 'c4') ON CONFLICT (tenant_id, code) DO UPDATE SET n = n + 1`, [t(i)]]);
    await m("local: delete", 1, (i) => [`DELETE FROM lu WHERE tenant_id = ? AND id = 5`, [t(i)]]);

    // シャードをまたぐ UNIQUE (email)。
    await m("global: insert", 1, (i) => [`INSERT INTO gu(id, email) VALUES (?, ?)`, [100 + i, `n${i}`]]);
    await m("global: update the UNIQUE value", 1, (i) => [`UPDATE gu SET email = ? WHERE id = ?`, [`m${i}`, 100 + i]]);
    await m("global: update another column", 1, (i) => [`UPDATE gu SET n = n + 1 WHERE id = ?`, [100 + i]]);
    await m("global: INSERT OR IGNORE that conflicts", 0, (i) => [`INSERT OR IGNORE INTO gu(id, email) VALUES (?, ?)`, [200 + i, `e${t(i)}`]]);
    await m("global: INSERT OR IGNORE that does not conflict", 1, (i) => [`INSERT OR IGNORE INTO gu(id, email) VALUES (?, ?)`, [200 + i, `o${i}`]]);
    await m("global: INSERT OR REPLACE that displaces a row", 1, (i) => [`INSERT OR REPLACE INTO gu(id, email) VALUES (?, ?)`, [300 + i, `o${i}`]]);
    await m("global: upsert on the UNIQUE", 1, (i) => [`INSERT INTO gu(id, email) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET n = n + 1`, [400 + i, `o${i}`]]);
    await m("global: delete", 1, (i) => [`DELETE FROM gu WHERE id = ?`, [300 + i]]);

    const measured = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, { written: v.written, parts: v.parts }]));
    console.log(`UNIQUE-ROWCOST measured ${JSON.stringify(measured)}`);
    expect(Object.keys(got)).toEqual(Object.keys(PINNED));
    expect(Object.entries(got).flatMap(([name, cost]) => differences(name, cost, PINNED[name]))).toEqual([]);
  }, 300_000);
});
