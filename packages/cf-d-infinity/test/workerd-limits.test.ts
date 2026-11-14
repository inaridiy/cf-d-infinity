// 本物の workerd と Durable Object の SQLite で確かめる。シミュレータの SQLite と上限や振る舞いが違わないことを見る。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";
import initSqlJs from "sql.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyStringExact } from "../src/keys";
import { ownerOf, type Routing } from "../src/routing";
import { initStoredValue, storedValue } from "../src/sql/stored";
import type { Affinity } from "../src/types";
import { decodeElem, decodeTuple, jsonElemSql, parseTuple, returningElemSql, selectElemSql, tupleSql, type TypedValue } from "../src/value";
import { bitsOf, doubles, EDGE_DOUBLES, INT64, int64s, numericStrings } from "./value-corpus";
import { CONV_COLUMNS, CONV_DDL, convSql, probe, type Arg, type Cell, type Probe, type Step } from "./workerd-probe";

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
    await post("/ddl", { sql: "CREATE TABLE docs(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, body TEXT, PRIMARY KEY (tenant_id, id))" });
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
    // 101 列の表は、DO の SQLite の列の上限 (100) で作れない。(値の作り直しの段 1 までは、変更を捕捉する写しの表が 1 列多かったので、
    // 100 列の表も作れなかった。段 2 で写しの表はなくなり、主キーのある 100 列の表は作れる。test/expression-depth.test.ts)
    const cols = ["id INTEGER PRIMARY KEY", ...Array.from({ length: 100 }, (_, i) => `c${i} INTEGER`)].join(", ");
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

// ---- 値の作り直し (docs/design-values.md) が頼っている事実 ----
//
// 設計書の「確かめた事実」の表の workerd の列と、「推測」の表を確かめる。手元の workerd (Miniflare) の結果で、本番の Cloudflare の
// 結果ではない。事実は見たとおりに書いてある。workerd を上げて結果が変わると、ここが落ちる。そのときは、設計書の表と
// docs/platform-facts.md を直し、その事実に頼っている決定を見直す。
//
// 文字列だけを返す文は、同じ文を node:sqlite と sql.js でも実行して比べる。数を返す文は、ドライバごとに JS の型が違うので、
// DO の結果だけを見る (その違いそのものが、確かめる事実である)。

// 要素の式は、src/value.ts のものを使う。workerd で確かめるのは、D∞ が流す文面そのものである。
const [selectElem, returningElem, jsonElem] = [selectElemSql, returningElemSql, jsonElemSql];
/** 結果を返す SELECT を、型つきの読みの形に包む (設計書の「シャードからの読み」)。 */
const typedRead = (sql: string, n: number) => {
  const cols = Array.from({ length: n }, (_, i) => `"c${i}"`);
  return `WITH "__dinf_r"(${cols.join(", ")}) AS (\n${sql}\n) SELECT ${cols.map(selectElem).join(", ")} FROM (SELECT * FROM "__dinf_r" LIMIT -1 OFFSET 0)`;
};

const INT64_MAX = "9223372036854775807";
const INT64_MIN = "-9223372036854775808";
/** 手元の workerd の、1 つの値と 1 行の長さの上限 (バイト)。公式の表の 2 MB とも 8 MB とも違う。 */
const LOCAL_MAX_LENGTH = 2_200_000;

/** 1 つの文の結果。値は文字にする。 */
type Texts = (string | null)[][] | { error: string };
/** 型と値を、比べられる文字にする。double はビットで比べる。-0.0 は 0.0 と区別しない。 */
const shownValue = (v: TypedValue): string =>
  v === null ? "NULL"
    : typeof v === "bigint" ? `INTEGER ${v}`
      : typeof v === "number" ? `REAL ${bitsOf(Object.is(v, -0) ? 0 : v)} (${v})`
        : typeof v === "string" ? `TEXT ${JSON.stringify(v)}`
          : `BLOB ${Buffer.from(v).toString("hex")}`;
/** DO のドライバが返した値 (workerd-probe.ts が文字にしたもの) を、ドライバの値に戻す。 */
const driverValue = (c: Cell): string | number | Uint8Array | null =>
  c[0] === "null" ? null : c[0] === "number" ? Number(c[1]) : c[0] === "blob" ? Uint8Array.from(Buffer.from(String(c[1]), "hex")) : String(c[1]);
/** 型の親和性の変換の表 (workerd-probe.ts の CONV_COLUMNS) の、列ごとの親和性。 */
const CONV_AFFINITY: Affinity[] = ["TEXT", "NUMERIC", "INTEGER", "REAL", "BLOB"];
/** storedValue の答えが、DO の列に入った値 (workerd-probe.ts の stored の書き方) と同じか。 */
const sameStored = (got: TypedValue, stored: string): boolean =>
  got === null ? stored === "null:"
    : typeof got === "bigint" ? stored === `integer:${got}`
      : typeof got === "number" ? stored.startsWith("real:") && bitsOf(Number(stored.slice(5))) === bitsOf(Object.is(got, -0) ? 0 : got)
        : typeof got === "string" ? stored === `text:${Buffer.from(got, "utf8").toString("hex").toUpperCase()}`
          : stored === `blob:${Buffer.from(got).toString("hex").toUpperCase()}`;
const textOf = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Uint8Array ? `x'${Buffer.from(v).toString("hex")}'` : String(v);
const cellText = (c: Cell): string | null => (c[0] === "null" ? null : c[0] === "blob" ? `x'${c[1]}'` : String(c[1]));

describe("facts about workerd and the Durable Object SQLite that the value rework relies on", () => {
  let p: Probe;
  let SQL: Awaited<ReturnType<typeof initSqlJs>>;
  beforeAll(async () => {
    p = probe();
    instances.push(p.mf);
    SQL = await initSqlJs();
    await initStoredValue(SQL);
  });

  /** 同じ文の並びを、node:sqlite、sql.js、DO で実行する。引数は文字列だけ (3 つとも TEXT として束縛する)。 */
  async function three(steps: { sql: string; params?: string[] }[]): Promise<{ node: Texts[]; sqljs: Texts[]; workerd: Texts[] }> {
    const lite = new DatabaseSync(":memory:");
    const node = steps.map((s): Texts => {
      try {
        const st = lite.prepare(s.sql);
        st.setReadBigInts(true);
        st.setReturnArrays(true);
        return (st.all(...(s.params ?? [])) as unknown as unknown[][]).map((r) => r.map(textOf));
      } catch (e) {
        return { error: (e as Error).message };
      }
    });
    const db = new SQL.Database();
    const sqljs = steps.map((s): Texts => {
      try {
        const st = db.prepare(s.sql);
        try {
          st.bind(s.params ?? []);
          const rows: (string | null)[][] = [];
          while (st.step()) rows.push((st.get as (p: null, c: { useBigInt: boolean }) => unknown[]).call(st, null, { useBigInt: true }).map(textOf));
          return rows;
        } finally {
          st.free();
        }
      } catch (e) {
        return { error: (e as Error).message };
      }
    });
    db.close();
    const workerd = (await p.run(steps)).map((r): Texts => (r.error !== undefined ? { error: r.error } : r.rows.map((row) => row.map(cellText))));
    return { node, sqljs, workerd };
  }
  /** 3 つのエンジンが同じ結果を返すことを確かめて、その結果を返す。DO が誤りの後ろに足す符号は除いて比べる。 */
  async function agreed(steps: { sql: string; params?: string[] }[]): Promise<Texts[]> {
    const r = await three(steps);
    const plain = (t: Texts) => (Array.isArray(t) ? t : { error: t.error.replace(/: SQLITE_.*$/, "") });
    expect(r.workerd.map(plain), "workerd against node:sqlite").toEqual(r.node.map(plain));
    expect(r.sqljs.map(plain), "sql.js against node:sqlite").toEqual(r.node.map(plain));
    return r.workerd.map(plain);
  }
  const one = async (sql: string, params: Step["params"] = [], lengths = false) => (await p.run([{ sql, params, lengths }]))[0]!;

  it("hides sqlite_version(); the behaviour is that of SQLite 3.47", async () => {
    const [version, source, options, pretty, fromRight, iif2, unistr] = await p.run([
      { sql: "SELECT sqlite_version()" },
      { sql: "SELECT sqlite_source_id()" },
      { sql: "PRAGMA compile_options" },
      { sql: "SELECT json_pretty('[1]')" }, // 3.46 からある関数だが、許可の一覧にない
      { sql: "SELECT '[1,2,3]' ->> -1" }, // 3.47 から、右から数える添字が使える
      { sql: "SELECT iif(1, 2)" }, // 3.48 から、引数 2 つの iif が使える
      { sql: "SELECT unistr('a')" }, // 3.50 から
    ]);
    // DO の SQLite は、使える関数と PRAGMA を許可の一覧で絞っている。版を返すものは一覧にない。
    expect(version!.error).toMatch(/not authorized to use function: sqlite_version/);
    expect(source!.error).toMatch(/not authorized to use function: sqlite_source_id/);
    expect(options!.error).toMatch(/not authorized/);
    expect(pretty!.error).toMatch(/not authorized to use function: json_pretty/);
    expect(fromRight!.rows).toEqual([[["number", "3"]]]);
    expect(iif2!.error).toMatch(/wrong number of arguments to function iif/);
    expect(unistr!.error).toMatch(/no such function: unistr/);
  });

  it("quote() cuts a TEXT at its first NUL; 't' || x and json_array keep it, and the DO driver returns it whole", async () => {
    const nul = "a\u0000b";
    // SQL の中の値。3 つのエンジンで同じである。quote() は NUL で切り、't' || x と json_array は切らない。
    const [inSql] = await agreed([{ sql: "SELECT quote(?1), hex('t' || ?1), json_array('t' || ?1), length(?1), length(CAST(?1 AS BLOB))", params: [nul] }]);
    expect(inSql).toEqual([["'a'", "74610062", '["ta\\u0000b"]', "1", "3"]]);
    // ドライバが返す文字列。DO は NUL を含めて全部を返す。node:sqlite と sql.js は、最初の NUL で切って返す
    // (値は切れていない。上の hex のとおりである)。設計書は 3 つとも「保つ」と書いていた。
    // そのため、Worker の SQLite (sql.js) とシミュレータ (node:sqlite) からは、TEXT を素の列で正確に読めない。
    // JSON の中に入れれば (json_array は NUL を \u0000 と書く)、どのドライバでも全部が届く。
    const raw = await three([{ sql: "SELECT 't' || ?1, ?1", params: [nul] }]);
    expect(raw.workerd).toEqual([[[`t${nul}`, nul]]]);
    expect(raw.node).toEqual([[["ta", "a"]]]);
    expect(raw.sqljs).toEqual([[["ta", "a"]]]);
  });

  it("(CAST(? AS INTEGER)+0) turns a bound decimal string into the exact INTEGER, without an affinity", async () => {
    for (const digits of [INT64_MAX, INT64_MIN, "9007199254740993", "-9007199254740993", "9007199254740992", "0", "-1"]) {
      const [r] = await agreed([{
        sql: "SELECT 'i' || (CAST(?1 AS INTEGER)+0), typeof((CAST(?1 AS INTEGER)+0)), json_array((CAST(?1 AS INTEGER)+0)), (CAST(?1 AS INTEGER)+0) = ?1, CAST(?1 AS INTEGER) = ?1",
        params: [digits],
      }]);
      // 最後の 2 列: 包んだ式は型の親和性を持たないので、同じ数字の文字列と等しくない。CAST だけの式は INTEGER の親和性を
      // 持つので、文字列の側が数に変わって等しくなる。
      expect(r).toEqual([[`i${digits}`, "integer", `[${digits}]`, "0", "1"]]);
    }
  });

  it("evaluates a CTE column once per reference unless LIMIT -1 OFFSET 0 fences the subquery", async () => {
    const mixed = "SELECT CASE WHEN random() % 2 THEN 5 ELSE 'x' END FROM s64";
    // 型と、要素の式が付けた印が食い違う行の数。列を 2 回参照するので、参照のたびに random() が評価されると食い違う。
    const mismatches = (from: string) =>
      `WITH r(c0) AS (${mixed}) SELECT '' || sum((typeof(c0) = 'integer') <> (substr(${selectElem("c0")}, 1, 1) = 'i')) FROM ${from}`;
    const r = await three([
      { sql: "CREATE TABLE s64(i INTEGER PRIMARY KEY)" },
      { sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 64) INSERT INTO s64 SELECT i FROM n" },
      { sql: mismatches("r") },
      { sql: mismatches("(SELECT * FROM r LIMIT -1 OFFSET 0)") },
      { sql: `EXPLAIN QUERY PLAN WITH r(c0) AS (${mixed}) SELECT ${selectElem("c0")} FROM (SELECT * FROM r LIMIT -1 OFFSET 0)` },
    ]);
    for (const [engine, out] of Object.entries(r)) {
      const [, , loose, fenced, plan] = out as (string | null)[][][];
      expect(Number(loose![0]![0]), `${engine}: without the fence`).toBeGreaterThan(0);
      expect(fenced, `${engine}: with the fence`).toEqual([["0"]]);
      // 中間の表は作らない。co-routine として実行する。
      expect(plan!.map((row) => row[3]).join(" | "), engine).toMatch(/CO-ROUTINE/);
      expect(plan!.map((row) => row[3]).join(" | "), engine).not.toMatch(/MATERIALIZE/);
    }
  });

  it("gives an AFTER trigger new.* with the column affinity applied and the assigned rowid", async () => {
    const tuple = (prefix: string) => `json_array(${["rowid", "a", "b", "c", "d", "e"].map((c) => jsonElem(`${prefix}${c}`)).join(", ")})`;
    const r = await agreed([
      { sql: "CREATE TABLE tr(a INTEGER, b TEXT, c REAL, d NUMERIC, e)" },
      { sql: "CREATE TABLE cap(seq INTEGER PRIMARY KEY, new TEXT)" },
      { sql: `CREATE TRIGGER tr_i AFTER INSERT ON tr BEGIN INSERT INTO cap(new) VALUES (${tuple("new.")}); END` },
      { sql: `INSERT INTO tr(a, b, c, d, e) VALUES ('7', 5, 5, '1e2', ${INT64_MAX})` },
      { sql: "INSERT INTO tr(a, b, c, d, e) VALUES (2.0, 2.5, '3', ' 12 ', x'00ff')" },
      { sql: "INSERT INTO tr(a, b, c, d, e) VALUES (0.1 + 0.2, 'a' || char(0) || 'b', 9.0e+999, NULL, -9223372036854775807 - 1)" },
      { sql: "SELECT new FROM cap ORDER BY seq" },
      { sql: `SELECT ${tuple("")} FROM tr ORDER BY rowid` },
    ]);
    expect(r[6]).toEqual([
      [`["i1","i7","t5","r5.0","i100","i${INT64_MAX}"]`],
      ['["i2","i2","t2.5","r3.0","i12","b00FF"]'],
      [`["i3","r3.000000000000000445e-01","ta\\u0000b","r9.0e+999",null,"i${INT64_MIN}"]`],
    ]);
    // trigger が見た行は、表に入った行と同じである。本体から読み直さなくてよい。
    expect(r[6]).toEqual(r[7]);
  });

  it("returns an integral value of a REAL column from RETURNING exactly only when the expression marks it", async () => {
    const r = await agreed([
      { sql: "CREATE TABLE rr(id INTEGER PRIMARY KEY, r REAL, u)" },
      { sql: `INSERT INTO rr(id, r, u) VALUES (1, 5, 5.0) RETURNING typeof(r), ${returningElem("r")}, ${returningElem("u")}, typeof(${selectElem("r")})` },
    ]);
    expect(r[1]).toEqual([["real", "r5.0", "r5.0", "real"]]);
    // SELECT の形の式 (REAL を素のまま返す) を RETURNING に使うと、node:sqlite のドライバには INTEGER の 5 が届く。
    // SQLite は、REAL の列に入る整数の値を整数として持っていて、INSERT の RETURNING では REAL に戻す前の値を返す。
    const lite = new DatabaseSync(":memory:");
    lite.exec("CREATE TABLE rr(id INTEGER PRIMARY KEY, r REAL, u)");
    const st = lite.prepare(`INSERT INTO rr(id, r) VALUES (1, 5) RETURNING ${selectElem("r")} AS v, typeof(r) AS t`);
    st.setReadBigInts(true);
    expect({ ...st.get() }).toEqual({ v: 5n, t: "real" });
    // DO のドライバは INTEGER も REAL も JS の数にするので、同じ文が 5 を返す。「数は REAL」と読めば合うが、偶然である。
    const [, plain] = await p.run([
      { sql: "CREATE TABLE rr(id INTEGER PRIMARY KEY, r REAL, u)" },
      { sql: `INSERT INTO rr(id, r) VALUES (1, 5) RETURNING ${selectElem("r")}, typeof(r)` },
    ]);
    expect(plain!.rows).toEqual([[["number", "5"], ["string", "real"]]]);
  });

  it("evaluates a RETURNING expression once when it is read through a fenced subquery", async () => {
    const once = `(SELECT typeof("x") || ':' || substr(${selectElem('"x"')}, 1, 1) FROM (SELECT CASE WHEN random() % 2 THEN id ELSE 'x' || id END AS "x" LIMIT -1 OFFSET 0))`;
    // 式は行の列を参照する。参照しない式は、文に 1 回だけ評価されて、どの行にも同じ値が返る。
    const r = await three([
      { sql: "CREATE TABLE s64(i INTEGER PRIMARY KEY)" },
      { sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 64) INSERT INTO s64 SELECT i FROM n" },
      { sql: "CREATE TABLE rr(id INTEGER PRIMARY KEY, r REAL)" },
      { sql: `INSERT INTO rr(id, r) SELECT i, 1 FROM s64 RETURNING ${once}` },
    ]);
    for (const [engine, out] of Object.entries(r)) {
      const kinds = new Set((out[3] as (string | null)[][]).map((row) => row[0]));
      expect([...kinds].sort(), engine).toEqual(["integer:i", "text:t"]);
    }
  });

  it("compares INTEGER and REAL exactly, also as keys of a primary key without a type", async () => {
    const r = await agreed([
      { sql: "SELECT 9007199254740993 = 9007199254740992.0, 9007199254740992 = 9007199254740992.0, 9223372036854775807 = 9223372036854775808.0, 9223372036854775807 < 9223372036854775808.0" },
      { sql: "CREATE TABLE up(k PRIMARY KEY, v)" },
      { sql: "INSERT INTO up VALUES (9007199254740992, 'integer 2^53')" },
      { sql: "INSERT INTO up VALUES (9007199254740992.0, 'real 2^53')" },
      { sql: "INSERT INTO up VALUES (9007199254740993, 'integer 2^53 + 1')" },
      { sql: "INSERT INTO up VALUES (1152921504606846976.0, 'real 2^60')" },
      { sql: "SELECT typeof(k) || ' ' || CASE typeof(k) WHEN 'real' THEN quote(k) ELSE k END, v FROM up ORDER BY k" },
      // 主キーは `IS ?` で引く。INTEGER の引数は、REAL で入っている同じ値の行にも当たる。
      { sql: "SELECT v FROM up WHERE k IS (CAST(?1 AS INTEGER)+0)", params: ["9007199254740993"] },
      { sql: "SELECT v FROM up WHERE k IS (CAST(?1 AS INTEGER)+0)", params: ["1152921504606846976"] },
      { sql: "SELECT v FROM up WHERE k IS (CAST(?1 AS INTEGER)+0)", params: ["1152921504606846977"] },
    ]);
    expect(r[0]).toEqual([["0", "1", "0", "1"]]);
    expect(r[3]).toEqual({ error: "UNIQUE constraint failed: up.k" });
    expect(r[6]).toEqual([["integer 9007199254740992", "integer 2^53"], ["integer 9007199254740993", "integer 2^53 + 1"], ["real 1.152921504606846976e+18", "real 2^60"]]);
    expect(r.slice(7)).toEqual([[["integer 2^53 + 1"]], [["real 2^60"]], []]);
  });

  it("binds every JS number as REAL, cannot bind a BigInt, and reads an INTEGER beyond 2^53 as a rounded number", async () => {
    const [types, big, wide, special] = await p.run([
      { sql: "SELECT typeof(?), typeof(?), typeof(?), typeof(?), typeof(?), typeof(?)", params: [{ f: "5" }, { f: "0.5" }, { f: "1e300" }, "x", { hex: "00ff" }, null] },
      { sql: "SELECT ?", params: [{ big: "5" }] },
      { sql: `SELECT 9007199254740993, ${INT64_MAX}, 5, 5.0, x'00ff'` },
      // NaN は NULL として束縛される。無限大はそのまま通る。
      { sql: "SELECT ?, ?, ?, typeof(?), quote(?)", params: [{ f: "Infinity" }, { f: "-Infinity" }, { f: "NaN" }, { f: "NaN" }, { f: "Infinity" }] },
    ]);
    expect(types!.rows[0]!.map((c) => c[1])).toEqual(["real", "real", "real", "text", "blob", "null"]);
    expect(big!.error).toMatch(/BigInt/);
    // INTEGER の 5 と REAL の 5.0 は、どちらも JS の 5 である。
    expect(wide!.rows).toEqual([[["number", "9007199254740992"], ["number", "9223372036854776000"], ["number", "5"], ["number", "5"], ["blob", "00ff"]]]);
    expect(special!.rows).toEqual([[["number", "Infinity"], ["number", "-Infinity"], ["null"], ["string", "null"], ["string", "9.0e+999"]]]);
  });

  it("keeps the sign of -0.0 in the driver, loses it in a REAL column, and writes 0.0 in every text form", async () => {
    const [, , , rows, bound] = await p.run([
      { sql: "CREATE TABLE z(id INTEGER PRIMARY KEY, r REAL, u)" },
      { sql: "INSERT INTO z VALUES (1, ?, ?)", params: [{ f: "-0" }, { f: "-0" }] },
      { sql: "INSERT INTO z VALUES (2, -0.0, -0.0)" },
      { sql: "SELECT r, u, quote(r), quote(u), u || '', printf('%.1f', u) FROM z ORDER BY id" },
      { sql: "SELECT ?, typeof(?), quote(?), ? || ''", params: [{ f: "-0" }, { f: "-0" }, { f: "-0" }, { f: "-0" }] },
    ]);
    // 設計書の推測は「-0.0 を束縛して読むと 0.0 になる」だった。DO のドライバは符号を保って束縛し、型のない列からは -0 を返す。
    // REAL の列は、整数の値を整数として持つので、符号を落とす。文字にする関数 (quote、||、printf) は、どれも 0.0 と書く。
    // だから、SQL の中から符号は見えず、行イメージ (quote で書く) を通った行は 0.0 になる。違いが見えるのは、ドライバが返す
    // JS の数の符号だけである。
    const row: Cell[] = [["number", "0"], ["number", "-0"], ["string", "0.0"], ["string", "0.0"], ["string", "0.0"], ["string", "0.0"]];
    expect(rows!.rows).toEqual([row, row]);
    expect(bound!.rows).toEqual([[["number", "-0"], ["string", "real"], ["string", "0.0"], ["string", "0.0"]]]);
  });

  it("passes the source text of a number to a JSON.parse reviver", async () => {
    // キー文字列の整数を桁のまま書いてよいかは、これで決まる (設計書の「読み戻し」)。受け取れなければ、2^53 以上の整数に印が要る。
    const got = await p.reviver(`[9007199254740993,"12",{"a":${INT64_MIN}},1.5,true,null,[18446744073709551616]]`);
    expect(got).toEqual([
      ["0", "number", "9007199254740993"],
      ["1", "string", '"12"'],
      ["a", "number", INT64_MIN],
      ["2", "object", "no source"],
      ["3", "number", "1.5"],
      ["4", "boolean", "true"],
      ["5", "object", "null"],
      ["0", "number", "18446744073709551616"],
      ["6", "object", "no source"],
      ["", "object", "no source"],
    ]);
  });

  it("reads a key string back with keyValues inside workerd, to the digit", async () => {
    // keyValues (src/keys.ts) を、workerd の中で動かす。行の置き場所はキー文字列から決まるので、Worker が読み戻した値が
    // 1 桁でも違えば、別の行を指す。
    const values: TypedValue[] = [
      ...INT64, ...int64s(300, 11), ...EDGE_DOUBLES, ...doubles(300, 12), 0.5, 1e19, 1e21, Infinity, -Infinity,
      "abc", "a\u0000b", "9223372036854775807", new Uint8Array([0, 255]), null,
    ];
    const keys = values.map((v, i) => keyStringExact([v, values[(i * 7) % values.length]!]));
    const back = await p.keys(keys);
    expect(back.map((b) => b.again)).toEqual(keys);
    // 整数は BigInt で戻る。2^53 を超える整数も丸まらない (丸まっていれば、もう一度書いたキーが元と違う)。
    const integers = back.filter((_b, i) => typeof values[i] === "bigint");
    expect(integers.every((b) => b.types[0] === "bigint")).toBe(true);
    expect(integers.length).toBeGreaterThan(300);
  });

  it("captures and reads a table of 100 columns with the tuple expression, 64-bit integers and NUL included", async () => {
    const cols = Array.from({ length: 100 }, (_, i) => `c${i}`);
    // PRIMARY KEY のない表は、rowid を先頭に置く。要素は 101 個になり、32 個ずつの入れ子が 4 つになる。
    const all = ["rowid", ...cols];
    const tuple = (prefix: string) => tupleSql(all.map((c) => `${prefix}${c}`));
    const triggers = [
      `CREATE TRIGGER w_i AFTER INSERT ON w BEGIN INSERT INTO cap(tbl, new) VALUES ('w', ${tuple("new.")}); END`,
      `CREATE TRIGGER w_u AFTER UPDATE ON w BEGIN INSERT INTO cap(tbl, old, new) VALUES ('w', ${tuple("old.")}, ${tuple("new.")}); END`,
      `CREATE TRIGGER w_d AFTER DELETE ON w BEGIN INSERT INTO cap(tbl, old) VALUES ('w', ${tuple("old.")}); END`,
    ];
    const pool: TypedValue[] = [...INT64, ...EDGE_DOUBLES, 0.1 + 0.2, 5, 0.5, "", "abc", "a\u0000b", "é", "i5", new Uint8Array([]), new Uint8Array([0, 255]), null];
    const rows = [0, 1, 2].map((r) => cols.map((_c, i) => pool[(i * 3 + r * 7) % pool.length]!));
    // DO は BigInt を束縛できず、数は REAL として束縛する。INTEGER は、10 進の文字列を `(CAST(? AS INTEGER)+0)` で包んで束縛する。
    const insert = (row: TypedValue[], returning = ""): Step => ({
      sql: `INSERT INTO w VALUES (${row.map((v) => (typeof v === "bigint" ? "(CAST(? AS INTEGER)+0)" : "?")).join(", ")})${returning}`,
      params: row.map((v): Arg =>
        v === null ? null : typeof v === "bigint" ? String(v) : typeof v === "number" ? { f: Object.is(v, -0) ? "-0" : String(v) }
          : typeof v === "string" ? v : { hex: Buffer.from(v).toString("hex") }),
    });
    const r = await p.run([
      { sql: `CREATE TABLE w(${cols.join(", ")})` },
      { sql: "CREATE TABLE cap(seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, old TEXT, new TEXT)" },
      ...triggers.map((sql) => ({ sql })),
      ...rows.map((row) => insert(row)),
      { sql: "SELECT old, new FROM cap ORDER BY seq" },
      // 主キーで行を読む文と同じ形。タプルを 1 列で読む。
      { sql: `SELECT ${tupleSql(all)} FROM w ORDER BY rowid` },
      // 型つきの読み。結果は、DO の上限ちょうどの 100 列である。
      { sql: typedRead("SELECT * FROM w ORDER BY rowid", 100) },
      { sql: "UPDATE w SET c1 = c0, c0 = NULL WHERE rowid = 2" },
      { sql: "DELETE FROM w WHERE rowid = 3" },
      { sql: "SELECT old, new FROM cap WHERE seq > 3 ORDER BY seq" },
      // RETURNING による捕捉。足す文面は、タプルの式 1 つである。
      insert(rows[0]!, ` RETURNING ${tupleSql(all)}`),
    ]);
    expect(r.map((step) => step.error)).toEqual(r.map(() => undefined));
    const [captured, read, typed, , , changed, returned] = r.slice(8);
    const want = (row: TypedValue[], rowid: number) => [BigInt(rowid), ...row].map(shownValue);
    const tupleOf = (c: Cell) => (c[0] === "null" ? null : decodeTuple(parseTuple(String(c[1]))).map(shownValue));
    expect(captured!.rows.map((row) => row.map(tupleOf))).toEqual(rows.map((row, i) => [null, want(row, i + 1)]));
    expect(read!.rows.map((row) => tupleOf(row[0]!))).toEqual(rows.map((row, i) => want(row, i + 1)));
    expect(typed!.rows.map((row) => row.map((c) => shownValue(decodeElem(driverValue(c)))))).toEqual(rows.map((row) => row.map(shownValue)));
    expect(changed!.rows.map((row) => row.map(tupleOf))).toEqual([
      [want(rows[1]!, 2), [BigInt(2), null, rows[1]![0]!, ...rows[1]!.slice(2)].map(shownValue)],
      [want(rows[2]!, 3), null],
    ]);
    // rowid 3 の行を消したので、次の行はまた rowid 3 になる (採番した rowid が、返したタプルに入っている)。
    expect(returned!.rows.map((row) => tupleOf(row[0]!))).toEqual([want(rows[0]!, 3)]);
    // trigger の文面は、文の長さの上限 (100 KB) に収まる。列名が 9 文字の 100 列の表で、UPDATE の trigger は 35 KB、
    // RETURNING に足すタプルの式は 15 KB である (設計書の「費用」の表)。
    const long = (prefix: string) => tupleSql(Array.from({ length: 100 }, (_, i) => `${prefix}"column_${String(i).padStart(2, "0")}"`));
    const update = `CREATE TRIGGER "__cap_some_table_U" AFTER UPDATE ON "some_table" WHEN EXISTS (SELECT 1 FROM __cap_on) BEGIN INSERT INTO __cap(tbl, old, new) VALUES ('some_table', ${long("old.")}, ${long("new.")}); END`;
    expect(Math.round(update.length / 1000)).toBe(35);
    expect(Math.round(tupleSql(Array.from({ length: 100 }, (_, i) => `"column_${String(i).padStart(2, "0")}"`)).length / 1000)).toBe(15);
  });

  it("carries a BigInt over Durable Object RPC and over a Service Binding, at the top level and inside objects", async () => {
    const r = await p.bigint();
    const nested = `{"a":["bigint ${INT64_MAX}","bigint ${INT64_MIN}"],"b":{"0":1,"1":2}}`;
    for (const via of ["durableObject", "serviceBinding"] as const) {
      expect(r[via].error, via).toBeUndefined();
      expect(r[via].arrived, via).toEqual([`bigint ${INT64_MAX}`, nested]);
      expect(r[via].returned, via).toEqual([`bigint ${INT64_MAX}`, nested]);
      expect(r[via].blob, via).toBe("[object Uint8Array]");
    }
    expect(r.structuredClone).toBe(`{"top":"bigint ${INT64_MAX}","nested":${nested}}`);
  });

  it("limits a result, a subquery and a CTE to 100 columns", async () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `${i} AS c${i}`).join(", ");
    const names = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`).join(", ");
    const [ok, result, subquery, cte, table100, table101, rowidStar, typed100] = await p.run([
      { sql: `SELECT ${list(100)}`, lengths: true },
      { sql: `SELECT ${list(101)}` },
      { sql: `SELECT count(*) FROM (SELECT ${list(101)})` },
      { sql: `WITH r(${names(101)}) AS (SELECT ${list(101)}) SELECT count(*) FROM r` },
      { sql: `CREATE TABLE w100(${names(100)})` },
      { sql: `CREATE TABLE w101(${names(101)})` },
      // PRIMARY KEY のない 100 列の表は、rowid を足した読みが 101 列になる。
      { sql: "SELECT rowid, * FROM w100" },
      // 型つきの読みは列を足さないので、100 列の結果を読める。
      { sql: typedRead("SELECT * FROM w100", 100) },
    ]);
    expect(ok!.columns).toHaveLength(100);
    for (const refused of [result, subquery, cte, rowidStar]) expect(refused!.error).toMatch(/too many columns in result set/);
    expect(table100!.error).toBeUndefined();
    expect(table101!.error).toMatch(/too many columns on w101/);
    expect(typed100!.error).toBeUndefined();
    expect(typed100!.columns).toHaveLength(100);
  });

  it("accepts up to 127 arguments to an SQL function, not the documented 32", async () => {
    const call = (n: number) => `SELECT length(json_array(${Array.from({ length: n }, (_, i) => i).join(", ")}))`;
    const [a32, a33, a127, a128] = await p.run([32, 33, 127, 128].map((n) => ({ sql: call(n) })));
    // 公式の表は「SQL 関数の引数は 32 まで」と書いている。手元の workerd は SQLite の既定の 127 まで受け付ける。
    // 本番が 32 で断るかは、手元では確かめられない。タプルの式は、どちらでも通るように 32 個ずつの入れ子にする。
    expect([a32!.error, a33!.error, a127!.error]).toEqual([undefined, undefined, undefined]);
    expect(a128!.error).toMatch(/too many arguments on function json_array/);
  });

  it("limits a value and a row to 2,200,000 bytes, a statement to 100,000 bytes and bound parameters to 100", async () => {
    const L = LOCAL_MAX_LENGTH;
    expect((await one("SELECT length(?)", [{ rep: ["a", L] }], true)).rows).toEqual([[["number", String(L)]]]);
    expect((await one("SELECT length(?)", [{ rep: ["a", L + 1] }], true)).error).toMatch(/string or blob too big/);
    // 長さはバイトで数える。3 バイトの文字は 733,333 個まで。
    expect((await one("SELECT length(?)", [{ rep: ["あ", Math.floor(L / 3)] }], true)).error).toBeUndefined();
    expect((await one("SELECT length(?)", [{ rep: ["あ", Math.floor(L / 3) + 1] }], true)).error).toMatch(/string or blob too big/);
    expect((await one("SELECT length(?)", [{ zero: L }], true)).error).toBeUndefined();
    expect((await one("SELECT length(?)", [{ zero: L + 1 }], true)).error).toMatch(/string or blob too big/);
    expect((await one(`SELECT ${"1".padEnd(100_000 - 7, " ")}`)).error).toBeUndefined();
    expect((await one(`SELECT ${"1".padEnd(100_001 - 7, " ")}`)).error).toMatch(/too long|too big/i);
    const params = (n: number) => one(`SELECT coalesce(${Array.from({ length: n }, () => "?").join(", ")})`, Array.from({ length: n }, () => ({ f: "1" })));
    expect((await params(100)).error).toBeUndefined();
    expect((await params(101)).error).toMatch(/too many SQL variables/);
  });

  it("limits the depth of an expression tree to 100, which the official table does not list", async () => {
    // SQLite の既定は 1,000 である。2 項の演算子を n 個の項に並べると、深さは n になる。D∞ が作る式 (列ごとの条件を OR や AND で
    // つないだもの) は、列の数だけ深くなる。シミュレータの node:sqlite は 1,000 のままなので、この上限は workerd でしか見えない。
    const chain = (n: number, op: string) => one(`SELECT ${Array.from({ length: n }, () => "1").join(` ${op} `)}`);
    for (const op of ["+", "OR", "AND", "||"]) {
      expect((await chain(100, op)).error, op).toBeUndefined();
      expect((await chain(101, op)).error, op).toMatch(/Expression tree is too large \(maximum depth 100\)/);
    }
  });

  it("reads back the largest TEXT a row can hold with the 't' mark, and the hex of a BLOB up to half the limit", async () => {
    const L = LOCAL_MAX_LENGTH;
    // 行の長さには、行の見出し (ここでは 7 バイト) が入る。この表に入る TEXT は L - 7 バイトまで。
    const fits = L - 7;
    const r = await p.run([
      { sql: "CREATE TABLE big(id INTEGER PRIMARY KEY, a TEXT, b BLOB)" },
      { sql: "INSERT INTO big(id, a) VALUES (1, ?)", params: [{ rep: ["a", fits + 1] }] },
      { sql: "INSERT INTO big(id, a) VALUES (1, ?)", params: [{ rep: ["a", fits] }] },
      // 印を付けると 1 バイト長くなる。入る上限の TEXT でも、まだ値の上限に収まる。
      { sql: `SELECT ${selectElem("a")} FROM big WHERE id = 1`, lengths: true },
      // タプルにすると、印、引用符、角括弧で 5 バイト長くなる。これも収まる。
      { sql: `SELECT json_array(${jsonElem("a")}) FROM big WHERE id = 1`, lengths: true },
      // JSON が文字を逃がすと (引用符は 2 バイトになる)、収まらない。行イメージにできない行がある。
      { sql: "UPDATE big SET a = replace(a, 'aaaaaaaa', 'aaaaaaa\"') WHERE id = 1" },
      { sql: `SELECT json_array(${jsonElem("a")}) FROM big WHERE id = 1`, lengths: true },
      // BLOB は 16 進で 2 倍になる。結果の文字列は、上限ちょうどの長さでは作れない (終端の分が要る)。
      { sql: `INSERT INTO big(id, b) VALUES (2, zeroblob(${L / 2 - 1}))` },
      { sql: `INSERT INTO big(id, b) VALUES (3, zeroblob(${L / 2}))` },
      { sql: `SELECT ${jsonElem("b")} FROM big WHERE id = 2`, lengths: true },
      { sql: `SELECT ${jsonElem("b")} FROM big WHERE id = 3`, lengths: true },
      // 素のままなら、BLOB は上限の近くまで読める。型つきの読みは BLOB を素のまま返す。
      { sql: `SELECT ${selectElem("b")} FROM big WHERE id = 3`, lengths: true },
    ]);
    expect(r[1]!.error).toMatch(/string or blob too big/);
    expect(r[2]!.error).toBeUndefined();
    expect(r[3]!.rows).toEqual([[["string", fits + 1]]]);
    expect(r[4]!.rows).toEqual([[["string", fits + 5]]]);
    expect(r[5]!.error).toBeUndefined();
    expect(r[6]!.error).toMatch(/string or blob too big/);
    expect(r[9]!.rows).toEqual([[["string", L - 1]]]);
    expect(r[10]!.error).toMatch(/string or blob too big/);
    expect(r[11]!.rows).toEqual([[["blob", L / 2]]]);
  });

  it("bills the same rows read for a statement and for the same statement wrapped as a typed read", async () => {
    const o = "billing";
    await p.run([
      { sql: "CREATE TABLE a(id INTEGER PRIMARY KEY, g INTEGER, v TEXT, x)" },
      { sql: "CREATE INDEX a_g ON a(g)" },
      { sql: "CREATE TABLE b(id INTEGER PRIMARY KEY, a_id INTEGER, w REAL)" },
      { sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) INSERT INTO a SELECT i, i % 10, 'v' || i, CASE i % 3 WHEN 0 THEN i WHEN 1 THEN i + 0.5 ELSE 't' || i END FROM n" },
      { sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) INSERT INTO b SELECT i, 1 + i % 200, i / 4.0 FROM n" },
    ], o);
    const statements: [string, number][] = [
      ["SELECT id, g, v, x FROM a", 4],
      ["SELECT id, v FROM a WHERE id = 7", 2],
      ["SELECT id, x FROM a WHERE g = 3", 2],
      ["SELECT id, v FROM a ORDER BY id DESC LIMIT 5", 2],
      ["SELECT id, v FROM a ORDER BY v LIMIT 5 OFFSET 3", 2],
      ["SELECT g, count(*), sum(id), total(x) FROM a GROUP BY g", 4],
      ["SELECT a.id, b.w FROM a JOIN b ON b.a_id = a.id WHERE a.g = 2", 2],
      ["SELECT id, row_number() OVER (ORDER BY v) FROM a WHERE g < 2", 2],
      ["SELECT id FROM a WHERE g = 1 UNION ALL SELECT id FROM b WHERE a_id = 5 ORDER BY 1 LIMIT 7", 1],
      ["SELECT DISTINCT g FROM a", 1],
    ];
    /** 印の付いた値を、素の読みが返す形に戻す。 */
    const plainOf = (c: Cell): Cell => (c[0] !== "string" ? c : String(c[1])[0] === "i" ? ["number", String(c[1]).slice(1)] : ["string", String(c[1]).slice(1)]);
    const r = await p.run(statements.flatMap(([sql, n]) => [{ sql }, { sql: typedRead(sql, n) }]), o);
    const billed: Record<string, [number, number]> = {};
    statements.forEach(([sql], i) => {
      const [plain, typed] = [r[2 * i]!, r[2 * i + 1]!];
      expect(typed.error, sql).toBeUndefined();
      expect(typed.rows.map((row) => row.map(plainOf)), sql).toEqual(plain.rows);
      billed[sql] = [plain.rowsRead, typed.rowsRead];
    });
    expect(Object.entries(billed).filter(([, [plain, typed]]) => plain !== typed)).toEqual([]);
    // 行を読んでいることも見る。どちらも 0 なら、比べたことにならない。
    expect(billed["SELECT id, g, v, x FROM a"]).toEqual([200, 200]);
    expect(billed["SELECT id, v FROM a WHERE id = 7"]).toEqual([1, 1]);
  });

  it("converts values to the affinity of a column exactly as node:sqlite and sql.js do", async () => {
    const reals = [...doubles(20000, 2), ...EDGE_DOUBLES];
    const texts = [...new Set(numericStrings(reals))];
    const lite = new DatabaseSync(":memory:");
    lite.exec(CONV_DDL);
    const sqljs = new SQL.Database();
    sqljs.run(CONV_DDL);
    const differ: Record<string, string[]> = {};
    const note = (key: string, text: string) => void (differ[key] ??= []).push(text);
    const undecided: Record<string, number> = {};
    let roundTrips = 0;
    for (const kind of ["real", "text"] as const) {
      const values = kind === "real" ? reals : texts;
      const onDo = await p.convert(kind, values);
      const node = lite.prepare(convSql(kind));
      node.setReturnArrays(true);
      const js = sqljs.prepare(convSql(kind));
      values.forEach((v, i) => {
        const a = node.get(v) as unknown as string[];
        const b = js.get([v]) as string[];
        const c = onDo[i]!;
        CONV_COLUMNS.forEach((col, j) => {
          if (b[j] !== a[j]) note(`${kind} into ${col}: sql.js against node:sqlite`, `${JSON.stringify(v)}: ${b[j]} / ${a[j]}`);
          if (c[j] !== a[j]) note(`${kind} into ${col}: workerd against node:sqlite`, `${JSON.stringify(v)}: ${c[j]} / ${a[j]}`);
          // Worker が決める値 (storedValue) は、DO の列に入った値と同じである。決めない変換 (undefined) は比べない。
          const decided = storedValue(v, CONV_AFFINITY[j]!);
          if (decided === undefined) undecided[`${kind} into ${col}`] = (undecided[`${kind} into ${col}`] ?? 0) + 1;
          else if (!sameStored(decided, c[j]!)) note(`${kind} into ${col}: storedValue against workerd`, `${JSON.stringify(v)}: ${String(decided)} / ${c[j]}`);
        });
        // 型のない列に入った REAL を quote() で書いた文字列は、JS の Number() で元の double に戻る (要素の 'r' の読み方)。
        if (typeof v === "number") {
          for (const [engine, row] of [["node:sqlite", a], ["sql.js", b], ["workerd", c]] as const) {
            if (bitsOf(Number(row[4]!.replace(/^real:/, ""))) !== bitsOf(v)) note(`quote() round trip: ${engine}`, `${v}: ${row[4]}`);
            else roundTrips++;
          }
        }
      });
      js.free();
    }
    sqljs.close();
    expect(Object.fromEntries(Object.entries(differ).map(([k, v]) => [k, `${v.length} values, for example ${v.slice(0, 3).join("; ")}`]))).toEqual({});
    expect(roundTrips).toBe(3 * reals.length);
    // storedValue が決めないのは、REAL を TEXT にする変換だけである。
    expect(undecided).toEqual({ "real into t": reals.length });
    // 値の数は、設計書の「確かめた事実」の表に書いてある。値の集まりを変えたら、設計書も直す。
    expect([reals.length, texts.length]).toEqual([20285, 113390]);
  }, 300_000);
});
