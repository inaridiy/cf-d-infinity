// Worker が SQLite の値の変換を写す関数 (src/keys.ts) を、本物の SQLite と大量の値で突き合わせる (計画書の不変条件 6)。
//
// Worker は行の置き場所を、文の中の値を列の型に揃えたキーで決める。揃え方が SQLite と 1 つでも違えば、その値の行は
// Worker が思うのと別のシャードにあり、読みは空を返し、書き込みはシャードのキーの確認で断られる。答えが置き場所で変わる。
// 手で選んだ値の試験 (test/key-affinity.test.ts) は、1e14 の REAL を "1" と書く誤りも、文の中の `5.0` を整数にする誤りも
// 踏まなかった (2026-11-13 の Codex の見直し、指摘 C7 と C8)。ここでは、値を生成して、次の 2 段で比べる。
//   1. storedAs と、各親和性の列に入れた値 (typeof と quote で読む)。storedAs が揃えないと答えた値 (undefined) は飛ばす。
//   2. 文の中の literal と引数の値を、シャード 4 つの D∞ と SQLite に入れて、同じ literal で引く。
// 1 段目は、REAL を TEXT にする変換を JS で写した関数を、CAST(REAL AS TEXT) と 2 万個の double で比べていた。1e14 を "1" と書く
// 誤りを直しても、15 桁目の丸めが SQLite 3.51 と違う値が残ったので、その変換は写すのをやめた (src/keys.ts の storedAs)。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { storedAs } from "../src/keys";
import type { Affinity, Value } from "../src/types";
import { isReal, realOf } from "../src/value";
import { SimCluster } from "./sim";

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** 変換を間違えやすい double。10 の冪、整数の値、15 桁と 17 桁の境、非正規化数の近く。 */
function doubles(n: number, seed: number): number[] {
  const r = prng(seed);
  const out: number[] = [0.1, 0.5, 1.5, 5, 10, 100, 1e14, 1e15, 1e16, 1e-4, 1e-5, 123456789012345, 1234567890123456, 2 ** 53, 2 ** 63, 1e300, 5e-324, 0.30000000000000004];
  for (let e = -30; e <= 30; e++) out.push(10 ** e, 3 * 10 ** e, -(10 ** e), 1.25 * 10 ** e);
  for (let i = 0; i < n; i++) {
    const e = Math.floor(r() * 60) - 30;
    const kind = r();
    if (kind < 0.3) out.push(Math.round(r() * 1e6) * 10 ** Math.max(0, e)); // 整数の値
    else if (kind < 0.6) out.push(Number((r() * 10).toPrecision(1 + Math.floor(r() * 17))) * 10 ** e);
    else out.push((r() - 0.5) * 10 ** e);
  }
  return out.filter((x) => Number.isFinite(x));
}

describe("the Worker's value conversions agree with SQLite", () => {
  it("stores a value in a column of each affinity as SQLite does", () => {
    const lite = new DatabaseSync(":memory:");
    lite.exec("CREATE TABLE a(t TEXT, n NUMERIC, i INTEGER, r REAL, b BLOB)");
    const cols: [string, Affinity][] = [["t", "TEXT"], ["n", "NUMERIC"], ["i", "INTEGER"], ["r", "REAL"], ["b", "BLOB"]];
    const values: Value[] = [];
    for (const x of doubles(2000, 2)) values.push(realOf(x), String(x), ` ${x} `, x.toExponential(), x.toPrecision(15));
    for (let i = -5; i < 5; i++) values.push(i, String(i), `${i}.0`, `${i}e2`, `0x${Math.abs(i)}`, `+${Math.abs(i)}`, `${i}.`, `.${Math.abs(i)}`);
    values.push("9223372036854775807", "9223372036854775808", "-9223372036854775808", "1e400", "-1e400", "abc", "", " ");
    const bad: string[] = [];
    const ins = lite.prepare(`INSERT INTO a VALUES (${cols.map(() => "?").join(", ")})`);
    const read = lite.prepare(`SELECT ${cols.map(([c]) => `typeof(${c}) AS ${c}_t, quote(${c}) AS ${c}_q`).join(", ")} FROM a`);
    for (const v of values) {
      lite.exec("DELETE FROM a");
      // 印の REAL は REAL のまま、整数は INTEGER で束縛する (node:sqlite は数を REAL で束縛するので、整数は BigInt で渡す)。
      const bound = isReal(v) ? v.real : typeof v === "number" && Number.isInteger(v) ? BigInt(v) : v;
      ins.run(...cols.map(() => bound as never));
      const row = read.get() as Record<string, string>;
      for (const [c, a] of cols) {
        const want = `${row[`${c}_t`]} ${row[`${c}_q`]}`;
        const s = storedAs(v, a);
        // undefined は「Worker では揃えない。SQLite に揃えさせる」の意味で、食い違いではない。
        if (s === undefined) continue;
        // 2^53 を超える整数は JS の数で正確に持てない。別の問題として扱う (計画書の K1、test/open/wide-integers.test.ts)。
        if (row[`${c}_t`] === "integer" && BigInt(row[`${c}_q`]!) ** 2n > 2n ** 106n) continue;
        const got = s === null ? "null NULL"
          : isReal(s) ? `real ${(lite.prepare("SELECT quote(?) AS q").get(s.real) as { q: string }).q}`
            : typeof s === "number" ? (Number.isInteger(s) && Math.abs(s) < 2 ** 63 ? `integer ${BigInt(s)}` : `real ${(lite.prepare("SELECT quote(?) AS q").get(s) as { q: string }).q}`)
              : typeof s === "string" ? `text ${(lite.prepare("SELECT quote(?) AS q").get(s) as { q: string }).q}` : "blob";
        if (got !== want) bad.push(`${JSON.stringify(v)} into ${a}: ${got} (SQLite ${want})`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("finds a row by the literal or argument it was written with, on four shards", async () => {
    const affinities = ["TEXT", "NUMERIC", "INTEGER", "REAL", "BLOB"];
    const literals = ["5.0", "5", "1e14", "100000000000000.0", "1.5", "-0.0", "0.1", "1e15", "1e16", "123.0", "'5.0'", "'5'", "' 5 '", "'1e2'", "x'05'"];
    const r = prng(3);
    for (let i = 0; i < 40; i++) literals.push(`${(r() * 10).toFixed(Math.floor(r() * 4))}e${Math.floor(r() * 40) - 20}`);
    const args: Value[] = [realOf(5), 5, realOf(1e14), realOf(1e15), realOf(0.5), "5.0", "5"];
    for (const aff of affinities) {
      const lite = new DatabaseSync(":memory:");
      const ddl = `CREATE TABLE t(k ${aff} PRIMARY KEY, v INTEGER)`;
      lite.exec(ddl);
      const db = new Db(new SimCluster({ shards: 4 }));
      await db.ddl(ddl);
      const run = async (sql: string, params: Value[] = []) => {
        const want = (() => {
          try {
            const st = lite.prepare(sql);
            const bound = params.map((p) => (isReal(p) ? p.real : typeof p === "number" && Number.isInteger(p) ? BigInt(p) : p)) as never[];
            return st.columns().length ? JSON.stringify(st.all(...bound)) : (st.run(...bound), "ok");
          } catch (e) {
            return `error ${(e as Error).message}`;
          }
        })();
        const got = await db.query(sql, params).then((x) => (x.columns.length ? JSON.stringify(x.rows) : "ok"), (e: Error) => `error ${e.message}`);
        return { want, got };
      };
      const bad: string[] = [];
      let id = 0;
      for (const l of literals) {
        id++;
        const w = await run(`INSERT OR IGNORE INTO t(k, v) VALUES (${l}, ${id})`);
        // 列が整数に揃えた値が 2^53 を超えると、保存を断る (計画書の K1、test/wide-integers.test.ts)。SQLite からも消して先へ進む。
        if (w.got.startsWith("error unsupported: an INTEGER beyond") && w.want === "ok") {
          lite.exec(`DELETE FROM t WHERE v = ${id}`);
          continue;
        }
        const s = await run(`SELECT v FROM t WHERE k = ${l} ORDER BY v`);
        if (w.got !== w.want) bad.push(`${aff} INSERT ${l}: ${w.got} (SQLite ${w.want})`);
        if (s.got !== s.want) bad.push(`${aff} SELECT ${l}: ${s.got} (SQLite ${s.want})`);
      }
      for (const a of args) {
        id++;
        const w = await run("INSERT OR IGNORE INTO t(k, v) VALUES (?, ?)", [a, id]);
        const s = await run("SELECT v FROM t WHERE k = ? ORDER BY v", [a]);
        if (w.got !== w.want) bad.push(`${aff} INSERT ? = ${JSON.stringify(a)}: ${w.got} (SQLite ${w.want})`);
        if (s.got !== s.want) bad.push(`${aff} SELECT ? = ${JSON.stringify(a)}: ${s.got} (SQLite ${s.want})`);
      }
      expect(bad.slice(0, 10)).toEqual([]);
    }
  }, 120000);
});
