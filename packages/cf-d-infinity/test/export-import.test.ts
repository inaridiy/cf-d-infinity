// export が書いた文を import で読み戻して、同じ行になることを確かめる。CLI が使う部品 (bin/dump.js) と、
// Worker 側の頁送りと取り込みを、シミュレータの上でつなぐ。
import { describe, expect, it } from "vitest";
// @ts-expect-error 型定義のない JS のモジュール
import { importBatches, insertLines, parseInsert } from "../bin/dump.js";
import { Db } from "../src/client/db";
import type { Value } from "../src/types";
import { exportPage, importRows, type ExportCursor } from "../src/transfer";
import { SimCluster } from "./sim";

const hex = (v: Uint8Array) => Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");

async function dump(c: SimCluster, table: string, limit = 1000): Promise<{ lines: string[]; pages: number }> {
  const lines: string[] = [];
  let pages = 0;
  for (let cursor: ExportCursor | null = null; ; ) {
    const page = await exportPage(c, table, cursor, limit);
    if (page.rows.length) {
      const rows = page.rows.map((r) => r.map((v) => (v instanceof Uint8Array ? { $blob: hex(v) } : v)));
      lines.push(...(insertLines(table, page.columns, rows) as string[]));
    }
    cursor = page.cursor;
    if (cursor === null) break;
    if (++pages > 1000) throw new Error("export does not finish");
  }
  return { lines, pages };
}

async function load(c: SimCluster, lines: string[]): Promise<void> {
  for (const line of lines) {
    const insert = parseInsert(line) as { table: string; columns: string[]; rows: unknown[][] } | null;
    if (!insert) throw new Error(`not an exported INSERT: ${line.slice(0, 80)}`);
    for (const batch of importBatches(insert.rows) as unknown[][][]) await importRows(new Db(c), insert.table, insert.columns, batch);
  }
}

const DOCS = `CREATE TABLE docs(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, body, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`;

async function roundTrip(bodies: Value[]): Promise<void> {
  const src = new SimCluster({ shards: 2 });
  await src.client().ddl(DOCS);
  for (const [i, body] of bodies.entries()) await new Db(src).query("INSERT INTO docs VALUES (?, ?, ?)", [(i % 5) + 1, i + 1, body]);
  const { lines } = await dump(src, "docs");
  const dst = new SimCluster({ shards: 3 });
  await dst.client().ddl(DOCS);
  await load(dst, lines);
  const all = (c: SimCluster) => new Db(c).query("SELECT tenant_id, id, typeof(body) AS t, body FROM docs ORDER BY id").then((r) => r.rows);
  expect(await all(dst)).toEqual(await all(src));
}

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
  it("reads lines it did not write as not-an-INSERT, so the caller sends them as SQL", () => {
    expect(parseInsert(`INSERT INTO t VALUES (1);`)).toBeNull();
    expect(parseInsert(`INSERT INTO "t"("a") VALUES (1), (lower('X'));`)).toBeNull();
    expect(parseInsert(`CREATE TABLE "t"("a");`)).toBeNull();
    expect(parseInsert(`INSERT INTO "t"("a", "b""c") VALUES (1, 'x'), (NULL, X'00ff');`)).toEqual({
      table: "t", columns: ["a", 'b"c'], rows: [[1, "x"], [null, { $blob: "00ff" }]],
    });
  });
  it("pages through a composite primary key at every page size", async () => {
    // 主キーに NULL のある行は作れない (test/admission.test.ts)。以前は、そういう行でページが終わる場合をここで確かめていた。
    const c = new SimCluster({ shards: 1 });
    await c.client().ddl("CREATE TABLE t(a INTEGER NOT NULL, b TEXT, v TEXT, PRIMARY KEY (a, b)) SHARD KEY (a)");
    await expect(new Db(c).query("INSERT INTO t VALUES (1, NULL, 'x')")).rejects.toThrow(/^unsupported: NULL in the primary key column b of t/);
    const rows: [number, string][] = [[1, ""], [1, "a"], [1, "x"], [2, ""], [2, "a"], [2, "b"], [3, ""], [3, "z"]];
    for (const [i, [a, b]] of rows.entries()) await new Db(c).query("INSERT INTO t VALUES (?, ?, ?)", [a, b, `v${i}`]);
    for (const limit of [1, 2, 3, 100]) {
      const { lines } = await dump(c, "t", limit);
      const got = lines.flatMap((l) => (parseInsert(l) as { rows: unknown[][] }).rows.map((r) => r[2])).sort();
      expect(got).toEqual(rows.map((_, i) => `v${i}`));
    }
  });
});
