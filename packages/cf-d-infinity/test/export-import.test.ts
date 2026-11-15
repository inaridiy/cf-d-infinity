// export が書いた文を import で読み戻して、同じ行になることを確かめる。CLI が使う部品 (bin/dump.js) と、
// Worker 側の頁送りと取り込みを、シミュレータの上でつなぐ。
//
// CLI と Worker のあいだは JSON である (bin/cli.js の使い捨ての Worker が Response.json で返し、CLI が JSON で送る)。頁、続きの位置、
// 取り込む行の束は、どれも JSON を 1 度通してから使う。JSON を通さないと、JSON で運べない値 (bigint、無限大) の失いが見えない。
import { describe, expect, it } from "vitest";
// @ts-expect-error 型定義のない JS のモジュール
import * as dumpJs from "../bin/dump.js";
import { Db } from "../src/client/db";
import type { Value } from "../src/types";
import * as transfer from "../src/transfer";
import type { ExportCursor } from "../src/transfer";
import { SimCluster } from "./sim";

const { importBatches, insertLines, parseInsert } = dumpJs as {
  importBatches(rows: unknown[][]): unknown[][][];
  insertLines(table: string, columns: string[], rows: unknown[][]): string[];
  parseInsert(line: string): { table: string; columns: string[]; rows: unknown[][] } | null;
};
const { exportPage, importRows } = transfer;
/** 書き出しの形式の版。版を持たない頃のコードでは undefined で、取り込みはそれを無視する。 */
const FORMAT = (transfer as { EXPORT_FORMAT?: number }).EXPORT_FORMAT;

/** CLI と Worker のあいだの JSON を 1 度通す。 */
const viaJson = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

async function dump(c: SimCluster, table: string, limit = 1000): Promise<{ lines: string[]; pages: number }> {
  const lines: string[] = [];
  let pages = 0;
  for (let cursor: ExportCursor | null = null; ; ) {
    const page = viaJson(await exportPage(c, table, viaJson(cursor), limit));
    if (page.rows.length) lines.push(...insertLines(table, page.columns, page.rows));
    cursor = page.cursor;
    if (cursor === null) break;
    if (++pages > 1000) throw new Error("export does not finish");
  }
  return { lines, pages };
}

async function load(c: SimCluster, lines: string[]): Promise<void> {
  for (const line of lines) {
    const insert = parseInsert(line);
    if (!insert) throw new Error(`not an exported INSERT: ${line.slice(0, 80)}`);
    for (const batch of importBatches(insert.rows)) {
      await (importRows as (...a: unknown[]) => Promise<number>)(new Db(c), insert.table, insert.columns, viaJson(batch), FORMAT);
    }
  }
}

const DOCS = `CREATE TABLE docs(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, body, PRIMARY KEY (tenant_id, id))`;

async function roundTrip(bodies: Value[]): Promise<void> {
  const src = new SimCluster({ shards: 2 });
  await src.client().ddl(DOCS);
  for (const [i, body] of bodies.entries()) await new Db(src).query("INSERT INTO docs VALUES (?, ?, ?)", [BigInt((i % 5) + 1), BigInt(i + 1), body]);
  const { lines } = await dump(src, "docs");
  const dst = new SimCluster({ shards: 3 });
  await dst.client().ddl(DOCS);
  await load(dst, lines);
  const all = (c: SimCluster) => new Db(c).query("SELECT tenant_id, id, typeof(body) AS t, body FROM docs ORDER BY id").then((r) => r.values);
  expect(await all(dst)).toEqual(await all(src));
}

const I64 = [0n, 1n, -1n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 53n + 1n, -(2n ** 53n) - 1n, 2n ** 63n - 1n, -(2n ** 63n), 1541815603606036480n];
const TEXTS = ["a\u0000b", "\u0000", "nul\u0000inside\u0000", "", "x", "i5", "r1.0", "t", "b00", "it's", "x\ny\r\nz"];
/** 型ごとの値。REAL の 5 は、Db の引数では JS の数なので REAL である。 */
const VALUES: Value[] = [
  null, ...I64, ...TEXTS,
  0.5, -1.5, 5, 0, 1e300, 2 ** 63, -(2 ** 63), 2 ** 53 + 2, 0.30000000000000004, 5e-324, Infinity, -Infinity,
  new Uint8Array([0, 1, 255]), new Uint8Array(0),
];
const V = "CREATE TABLE v(id INTEGER PRIMARY KEY, x)";
/** 主キーに 64 ビットの整数と NUL を含む文字列を置く。頁が小さいと、続きの位置がその値を JSON で運ぶ。 */
const K = "CREATE TABLE k(a INTEGER NOT NULL, b TEXT NOT NULL, x, PRIMARY KEY (a, b))";
const KB = ["a\u0000b", "\u0000", "", "z"];

describe("export followed by import", () => {
  it("keeps a value larger than a statement may be", async () => {
    await roundTrip(["small", "x".repeat(150_000)]);
  });
  it("keeps rows of multi-byte text that together exceed a statement in bytes", async () => {
    await roundTrip(Array.from({ length: 100 }, () => "あ".repeat(400)));
  });
  it("keeps quotes, newlines, NUL, numbers, NULL and BLOBs as they were", async () => {
    await roundTrip(["it's", "a\nb\r\nc", "nul\0inside", "'", "", "'' || char(10) || ''", 0, -1.5, 1e300, 9007199254740991, null, new Uint8Array([0, 1, 255]), new Uint8Array(0)]);
  });

  for (const shards of [1, 2, 4]) {
    it(`keeps every 64-bit integer, NUL in TEXT, REAL and BLOB exactly, with its type, on ${shards} shards`, async () => {
      const src = new SimCluster({ shards });
      const db = new Db(src);
      await db.ddl(V);
      await db.ddl(K);
      for (const [i, x] of VALUES.entries()) await db.query("INSERT INTO v(id, x) VALUES (?, ?)", [BigInt(i + 1), x]);
      for (const [i, a] of I64.entries()) {
        for (const b of KB) await db.query("INSERT INTO k(a, b, x) VALUES (?, ?, ?)", [a, b, I64[I64.length - 1 - i]!]);
      }
      const want = {
        v: VALUES.map((x, i) => [BigInt(i + 1), x]),
        k: I64.flatMap((a, i) => KB.map((b) => [a, b, I64[I64.length - 1 - i]!])),
      };
      const read = async (c: SimCluster) => ({
        v: (await new Db(c).query("SELECT id, x FROM v ORDER BY id")).values,
        // 主キーの順は SQLite の順である (BINARY の比べ方で、NUL は "" の後ろ、ほかの文字の前)。
        k: (await new Db(c).query("SELECT a, b, x FROM k")).values,
      });
      const sorted = (rows: Value[][]) => [...rows].sort((p, q) => JSON.stringify(p, (_k, x) => (typeof x === "bigint" ? String(x) : x)) < JSON.stringify(q, (_k, x) => (typeof x === "bigint" ? String(x) : x)) ? -1 : 1);
      const before = await read(src);
      expect(before.v).toEqual(want.v);
      expect(sorted(before.k)).toEqual(sorted(want.k));
      // 型も比べる。typeof は SQLite が答える。
      const types = (c: SimCluster) => new Db(c).query("SELECT typeof(x) FROM v ORDER BY id").then((r) => r.values.map((x) => x[0]));
      const wantTypes = await types(src);

      for (const limit of [1, 3, 1000]) {
        const v = await dump(src, "v", limit);
        const k = await dump(src, "k", limit);
        // 64 ビットの端は、10 進の literal のまま書く。
        expect(v.lines.join("\n")).toContain("9223372036854775807");
        expect(v.lines.join("\n")).toContain("-9223372036854775808");
        const dst = new SimCluster({ shards: shards === 4 ? 1 : shards * 2 });
        const target = new Db(dst);
        await target.ddl(V);
        await target.ddl(K);
        await load(dst, [...v.lines, ...k.lines]);
        const after = await read(dst);
        expect(after.v, `limit ${limit}`).toEqual(want.v);
        expect(sorted(after.k), `limit ${limit}`).toEqual(sorted(want.k));
        expect(await types(dst), `limit ${limit}`).toEqual(wantTypes);
      }
    }, 120_000);
  }

  it("reads lines it did not write as not-an-INSERT, so the caller sends them as SQL", () => {
    expect(parseInsert(`INSERT INTO t VALUES (1);`)).toBeNull();
    expect(parseInsert(`INSERT INTO "t"("a") VALUES (1), (lower('X'));`)).toBeNull();
    expect(parseInsert(`CREATE TABLE "t"("a");`)).toBeNull();
    expect(parseInsert(`INSERT INTO "t"("a") VALUES (1-2);`)).toBeNull();
  });
  it("pages through a composite primary key at every page size", async () => {
    // 主キーに NULL のある行は作れない (test/admission.test.ts)。以前は、そういう行でページが終わる場合をここで確かめていた。
    const c = new SimCluster({ shards: 1 });
    await c.client().ddl("CREATE TABLE t(a INTEGER NOT NULL, b TEXT, v TEXT, PRIMARY KEY (a, b))");
    await expect(new Db(c).query("INSERT INTO t VALUES (1, NULL, 'x')")).rejects.toThrow(/^unsupported: NULL in the primary key column b of t/);
    const rows: [number, string][] = [[1, ""], [1, "a"], [1, "x"], [2, ""], [2, "a"], [2, "b"], [3, ""], [3, "z"]];
    for (const [i, [a, b]] of rows.entries()) await new Db(c).query("INSERT INTO t VALUES (?, ?, ?)", [BigInt(a), b, `v${i}`]);
    for (const limit of [1, 2, 3, 100]) {
      const { lines } = await dump(c, "t", limit);
      const got = lines.flatMap((l) => parseInsert(l)!.rows.map((r) => r[2])).sort();
      expect(got).toEqual(rows.map((_, i) => `tv${i}`));
    }
  });
});

describe("the export format", () => {
  const { EXPORT_FORMAT, exportHeader, fileFormat, literal } = dumpJs as {
    EXPORT_FORMAT: number;
    exportHeader(): string[];
    fileFormat(lines: string[]): number;
    literal(e: unknown): string;
  };

  it("carries rows as tuples of elements, and the same format number on both sides", async () => {
    expect(EXPORT_FORMAT).toBe(FORMAT);
    const c = new SimCluster({ shards: 1 });
    const db = new Db(c);
    await db.ddl(V);
    await db.query("INSERT INTO v(id, x) VALUES (1, ?), (2, ?), (3, ?), (4, ?), (5, ?), (6, NULL)", [2n ** 63n - 1n, "a\u0000b", 5, Infinity, new Uint8Array([0, 255])]);
    const page = await exportPage(c, "v", null, 1000);
    expect(page).toMatchObject({ format: FORMAT, columns: ["id", "x"] });
    expect(page.rows).toEqual([
      ["i1", "i9223372036854775807"], ["i2", "ta\u0000b"], ["i3", "r5.0"], ["i4", "r9.0e+999"], ["i5", "b00FF"], ["i6", null],
    ]);
  });

  it("writes each element as the SQL literal that SQLite reads back as the same value, and reads it back", () => {
    const cases: [unknown, string][] = [
      [null, "NULL"], ["i-9223372036854775808", "-9223372036854775808"], ["i9223372036854775807", "9223372036854775807"], ["i0", "0"],
      ["r5.0", "5.0"], ["r-1.5", "-1.5"], ["r1e+300", "1e+300"], ["r9.0e+999", "9.0e+999"], ["r-9.0e+999", "-9.0e+999"],
      ["ta\u0000b", "'a' || char(0) || 'b'"], ["tit's", "'it''s'"], ["t", "''"], ["b00FF", "X'00FF'"], ["b", "X''"],
    ];
    for (const [e, sql] of cases) expect(literal(e), JSON.stringify(e)).toBe(sql);
    const line = insertLines("t", ["x"], cases.map(([e]) => [e]))[0]!;
    expect(parseInsert(line)!.rows).toEqual(cases.map(([e]) => [e]));
    // 書いたものでない literal も、SQLite の読み方で要素にする。
    expect(parseInsert(`INSERT INTO "t"("a", "b""c") VALUES (1, 'x'), (NULL, X'00ff'), (007, 1E5), (99999999999999999999, .5);`)).toEqual({
      table: "t", columns: ["a", 'b"c'], rows: [["i1", "tx"], [null, "b00FF"], ["i7", "r100000.0"], ["r100000000000000000000.0", "r0.5"]],
    });
  });

  it("refuses values that are not elements, instead of writing them as something else", () => {
    for (const bad of [5, "5", "x5", { $int: "5" }, { $blob: "00" }, { real: 5 }, "i5.0", "r", "bXY"]) expect(() => literal(bad), JSON.stringify(bad)).toThrow();
  });

  it("starts the file with its format number, and reads it back", () => {
    const header = exportHeader();
    expect(header[0]).toBe(`-- cf-d-infinity export format ${EXPORT_FORMAT}`);
    expect(fileFormat([...header, "CREATE TABLE t(a);"])).toBe(EXPORT_FORMAT);
    expect(() => fileFormat(["CREATE TABLE t(a);"])).toThrow(/export format/);
    expect(() => fileFormat(["-- cf-d-infinity export format 999", "CREATE TABLE t(a);"])).toThrow(/format 999/);
  });

  it("refuses to import rows of another format or another shape, before writing anything", async () => {
    const c = new SimCluster({ shards: 1 });
    const db = new Db(c);
    await db.ddl(V);
    const put = (rows: unknown, format: unknown = FORMAT) => (importRows as (...a: unknown[]) => Promise<number>)(new Db(c), "v", ["id", "x"], rows, format);
    await expect(put([["i1", "tx"]], undefined)).rejects.toThrow(/export format/);
    await expect(put([["i1", "tx"]], 999)).rejects.toThrow(/export format/);
    // 版 0 の形 (INTEGER は JS の数、BLOB と REAL と 64 ビットの整数は印の object) と、印のない文字列。
    for (const row of [[1, "tx"], ["i1", 5], ["i1", { $int: "9007199254740993" }], ["i1", { $blob: "00" }], ["i1", { real: 5 }], ["i1", "x"], ["i1"]]) {
      await expect(put([row]), JSON.stringify(row)).rejects.toThrow();
    }
    expect((await db.query("SELECT count(*) FROM v")).values).toEqual([[0n]]);
    expect(await put([["i1", "tx"], ["i2", null]])).toBe(2);
    expect((await db.query("SELECT id, x FROM v ORDER BY id")).values).toEqual([[1n, "x"], [2n, null]]);
  });
});
