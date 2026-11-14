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
import { keyString, storedAs } from "../src/keys";
import type { Affinity, Value } from "../src/types";
import { isReal, realOf } from "../src/value";
import { prng, SimCluster } from "./sim";
import { doubles, EDGE_DOUBLES, INT64 } from "./value-corpus";

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

// ---- キーが等しいことと、SQLite が同じキーと見なすこと (docs/design-values.md の「キー文字列」、「足す検査」の 4) ----
//
// SQLite は INTEGER と REAL を正確に比べる。REAL の 2^53 と INTEGER の 2^53 は同じキーで、INTEGER の 2^53 + 1 は別のキーである。
// キー文字列が等しいことと、型のない主キーで UNIQUE の違反になることが、2^53 と 2^63 の前後でも一致しなければならない。
// 一致しなければ、同じ行が 2 つのシャードに入るか、別の行が同じ行として扱われる。

/** 型のある値。BigInt は INTEGER、数は REAL。 */
type Typed = bigint | number;
const EDGE_VALUES: Typed[] = [...INT64, ...EDGE_DOUBLES, 5, 0.5, 0, 2 ** 53 - 1, -(2 ** 53) + 1, 2 ** 31, 2 ** 53 + 4, 2 ** 60 + 256];
const shown = (v: Typed) => (typeof v === "bigint" ? `INTEGER ${v}` : `REAL ${v}`);

/** 値の組のうち、型のない主キーで、片方の行がある表にもう片方を入れると UNIQUE の違反になる組。 */
function collisions(values: Typed[]): Set<string> {
  const lite = new DatabaseSync(":memory:");
  lite.exec("CREATE TABLE u(k PRIMARY KEY)");
  const insert = lite.prepare("INSERT INTO u VALUES (?)");
  const out = new Set<string>();
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      lite.exec("DELETE FROM u");
      insert.run(values[i]!);
      try {
        insert.run(values[j]!);
      } catch (e) {
        if (!/UNIQUE constraint failed/.test((e as Error).message)) throw e;
        out.add(`${i},${j}`);
      }
    }
  }
  return out;
}

/** キーの関数 key が、値の組のそれぞれで、SQLite と同じ答えを出すか。key が undefined を返す値は、その関数が扱わない値である。 */
function keyDisagreements(values: Typed[], key: (v: Typed) => string | undefined): { bad: string[]; equal: number } {
  const same = collisions(values);
  const bad: string[] = [];
  let equal = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const [a, b] = [key(values[i]!), key(values[j]!)];
      if (a === undefined || b === undefined) continue;
      if (a === b) equal++;
      if ((a === b) !== same.has(`${i},${j}`)) bad.push(`${shown(values[i]!)} and ${shown(values[j]!)}: keys ${a} and ${b}, SQLite says ${same.has(`${i},${j}`) ? "the same key" : "different keys"}`);
    }
  }
  return { bad, equal };
}

describe("a key string is equal exactly when SQLite takes two values for the same key", () => {
  it("today's keyString, over the values that can be stored today", () => {
    // いま保存できるのは、絶対値が 2^53 未満の INTEGER と、REAL である (2^53 以上の INTEGER は断る。計画書の K1)。
    const today = (v: Typed): Value | undefined =>
      typeof v === "number" ? realOf(v) : v > -(2n ** 53n) && v < 2n ** 53n ? Number(v) : undefined;
    const r = keyDisagreements(EDGE_VALUES, (v) => {
      const x = today(v);
      return x === undefined ? undefined : keyString([x]);
    });
    expect(r.bad.slice(0, 10)).toEqual([]);
    // 等しい組もある (INTEGER の 5 と REAL の 5.0 など)。なければ、「どれも違う」と答える関数でも通ってしまう。
    expect(r.equal).toBeGreaterThan(3);
  });
});
