// 要素とタプルの符号 (src/value.ts) の性質の試験。docs/design-values.md の「足す検査」の 3。値の作り直しの段 1。
//
// 値 1 つを文字列にしたものが要素、行を要素の配列にしたものがタプルである。SQL の式でも JS でも同じ形に作る。確かめるのは次の 3 つ。
// - JS で要素にして戻すと、同じ値になる。
// - SQL のタプルの式 (node:sqlite と sql.js) が作った要素を JS で戻すと、表に入れた値と等しい。列は 1、32、33、64、100。
//   double は、型の変換の検査と同じ集まり (2 万個) をビットで比べる。
// - タプルの式は、どの関数の呼び出しも引数が 32 以下である。node:sqlite と sql.js は上限を掛けないので、式の文面を数える。
// workerd の DO の SQLite での同じ式は、test/workerd-limits.test.ts が 100 列の表で流す。
import { DatabaseSync } from "node:sqlite";
import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { realOf } from "../src/value";
import {
  decodeElem, decodeTuple, encodeElem, encodeTuple, jsonElemSql, MAX_FUNCTION_ARGS, parseTuple, returningElemSql, selectElemSql, tupleSql, typedOf,
  type Elem, type TypedValue,
} from "../src/value";
import { prng } from "./sim";
import { bitsOf, doubles, EDGE_DOUBLES, INT64, int64s, sqljsBinding } from "./value-corpus";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
/** 型と値を、比べられる文字にする。double はビットで比べる。-0.0 は 0.0 と区別しない (設計書の「JS の型」)。 */
const shown = (v: TypedValue): string =>
  v === null ? "NULL"
    : typeof v === "bigint" ? `INTEGER ${v}`
      : typeof v === "number" ? `REAL ${bitsOf(Object.is(v, -0) ? 0 : v)} (${v})`
        : typeof v === "string" ? `TEXT ${JSON.stringify(v)}`
          : `BLOB ${hex(v)}`;

const STRINGS = [
  "", "abc", "a b", "é", "日本語", "😀", "x'y", 'q"r', "back\\slash", "line\nbreak", "tab\t", "a\u0000b", "\u0000", "x\u0000",
  // 要素やタプルに見える文字列。印は前に 1 文字付くだけなので、中身が何であっても取り違えない。
  "i5", "r1.5", "t", "b00", "null", "[\"i1\"]", "9223372036854775807", "5.0", "\u2028",
];
const BLOBS = [new Uint8Array([]), new Uint8Array([0]), new Uint8Array([1, 2]), new Uint8Array([0, 255, 0]), new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 256))];
const REALS = [...EDGE_DOUBLES, 0, -0, 5, 0.5, -0.25, 0.1 + 0.2, 1e20, 1e21, 1e-7, 123456789.123456789, Infinity, -Infinity, 1 / 3, 5e-324];

/** 乱択の、型のある値。 */
function values(n: number, seed: number): TypedValue[] {
  const r = prng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const ints = [...INT64, ...int64s(200, seed + 1)];
  const reals = [...REALS, ...doubles(300, seed + 2)];
  return Array.from({ length: n }, (): TypedValue => {
    switch (Math.floor(r() * 5)) {
      case 0: return pick(ints);
      case 1: return pick(reals);
      case 2: return pick(STRINGS);
      case 3: return pick(BLOBS);
      default: return null;
    }
  });
}

/** 型を保って、sql.js の表に 1 行入れる文。 */
function sqljsInsert(table: string, row: TypedValue[]): { sql: string; params: (string | number | Uint8Array | null)[] } {
  const { marks, params } = sqljsBinding(row);
  return { sql: `INSERT INTO ${table} VALUES (${marks.join(", ")})`, params };
}

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;
let SQL: SqlJs;
beforeAll(async () => {
  SQL = await initSqlJs();
});

/** 表を作り、行を入れ、1 列の文字列を返す文を、2 つのエンジンで実行する。 */
function onBoth(columns: number, rows: TypedValue[][], read: (cols: string[]) => string): { node: string[]; sqljs: string[] } {
  const cols = Array.from({ length: columns }, (_, i) => `c${i}`);
  const ddl = `CREATE TABLE w(${cols.join(", ")})`;
  const lite = new DatabaseSync(":memory:");
  lite.exec(ddl);
  const insert = lite.prepare(`INSERT INTO w VALUES (${cols.map(() => "?").join(", ")})`);
  for (const row of rows) insert.run(...(row as never[]));
  const node = (lite.prepare(read(cols)).all() as Record<string, string>[]).map((r) => Object.values(r)[0]!);
  const db = new SQL.Database();
  db.run(ddl);
  for (const row of rows) {
    const { sql, params } = sqljsInsert("w", row);
    db.run(sql, params);
  }
  const sqljs = (db.exec(read(cols))[0]?.values ?? []).map((r) => r[0] as string);
  db.close();
  return { node, sqljs };
}

describe("an element", () => {
  it("is written in the form the design note gives", () => {
    const cases: [TypedValue, Elem][] = [
      [null, null], [5n, "i5"], [-(2n ** 63n), "i-9223372036854775808"], [2n ** 63n - 1n, "i9223372036854775807"],
      [5, "r5.0"], [0.5, "r0.5"], [0.1 + 0.2, "r0.30000000000000004"], [1e21, "r1e+21"], [1e-7, "r1e-7"], [-0, "r0.0"],
      [Infinity, "r9.0e+999"], [-Infinity, "r-9.0e+999"], ["abc", "tabc"], ["", "t"], [new Uint8Array([0, 255]), "b00FF"], [new Uint8Array([]), "b"],
      // SQLite は NaN を NULL として束縛する。
      [NaN, null],
    ];
    for (const [v, want] of cases) expect(encodeElem(v), shown(v)).toBe(want);
  });

  it("reads back as the value it was written from", () => {
    const bad: string[] = [];
    for (const v of values(5000, 1)) {
      const back = decodeElem(encodeElem(v));
      if (shown(back) !== shown(v)) bad.push(`${shown(v)} came back as ${shown(back)}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("reads back after a tuple went through JSON, as a change log entry and an intent do", () => {
    const row = values(400, 2);
    const back = decodeTuple(JSON.parse(JSON.stringify(encodeTuple(row))) as Elem[]);
    expect(back.map(shown)).toEqual(row.map(shown));
  });

  it("reads what a driver returns for a typed read: a number is REAL, a BLOB is a BLOB, a marked string is INTEGER or TEXT", () => {
    expect(decodeElem(5)).toBe(5);
    expect(decodeElem(0.5)).toBe(0.5);
    expect(decodeElem(null)).toBe(null);
    expect(decodeElem("i9007199254740993")).toBe(9007199254740993n);
    expect(decodeElem("ti5")).toBe("i5");
    expect(decodeElem("r5.0")).toBe(5);
    expect(decodeElem(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
    // DO のドライバは、BLOB を ArrayBuffer で返す。
    expect(decodeElem(new Uint8Array([1, 2]).buffer)).toEqual(new Uint8Array([1, 2]));
    // 印のない文字列は要素ではない。包み忘れた文の結果を、黙って TEXT として読まない。
    for (const s of ["", "5", "x5", "null"]) expect(() => decodeElem(s)).toThrow(/not an element/);
    // 印の後ろが、その型の書き方でないものも要素ではない。空の文字列を 0 と読んだり、16 進を数と読んだりしない。
    for (const s of ["i", "i ", "i0x10", "i5.0", "i 5", "i1e3", "r", "rabc", "r5x", "r 5", "r0x10", "rInfinity", "b0", "bzz"]) expect(() => decodeElem(s), s).toThrow(/not an element/);
    expect(decodeElem("t")).toBe("");
    expect(decodeElem("b")).toEqual(new Uint8Array([]));
    expect(decodeElem("i-0")).toBe(0n);
  });

  it("made in SQL and made in JS reads back as the same value, also where the two texts differ", () => {
    const lite = new DatabaseSync(":memory:");
    // SQL が作った要素は、JSON の中に入れて読む。素の列で読むと、node:sqlite のドライバが NUL で切る。
    const one = lite.prepare(`SELECT json_array(${jsonElemSql("?1")}) AS e`);
    const bad: string[] = [];
    let differ = 0;
    for (const v of values(3000, 3)) {
      const inSql = (JSON.parse((one.get(v as never) as { e: string }).e) as Elem[])[0]!;
      const inJs = encodeElem(v);
      if (inSql !== inJs) differ++;
      // 文字が違ってよいのは REAL だけである (`r3.000000000000000445e-01` と `r0.30000000000000004`)。
      if (inSql !== inJs && typeof v !== "number") bad.push(`${shown(v)}: SQL wrote ${inSql}, JS wrote ${inJs}`);
      if (shown(decodeElem(inSql)) !== shown(decodeElem(inJs))) bad.push(`${shown(v)}: SQL ${inSql} reads ${shown(decodeElem(inSql))}, JS ${inJs} reads ${shown(decodeElem(inJs))}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(differ).toBeGreaterThan(0);
  });
});

describe("the tuple expression", () => {
  for (const columns of [1, 32, 33, 64, 100]) {
    it(`gives back the stored rows on node:sqlite and sql.js, ${columns} columns`, () => {
      const flat = values(columns * 30, 10 + columns);
      const rows = Array.from({ length: 30 }, (_, i) => flat.slice(i * columns, (i + 1) * columns));
      // PRIMARY KEY のない表は、rowid を先頭に置く。100 列の表では、要素が 101 個になる。
      const got = onBoth(columns, rows, (cols) => `SELECT ${tupleSql(["rowid", ...cols])} AS t FROM w ORDER BY rowid`);
      const want = rows.map((row, i) => [BigInt(i + 1), ...row].map(shown));
      for (const [engine, tuples] of Object.entries(got)) {
        const back = tuples.map((json) => decodeTuple(parseTuple(json)).map(shown));
        expect(back, engine).toEqual(want);
      }
      // 2 つのエンジンは、同じ行に 1 バイトも違わないタプルを書く。保存するのは、平らにした後の配列である。
      expect(got.sqljs.map((json) => JSON.stringify(parseTuple(json)))).toEqual(got.node.map((json) => JSON.stringify(parseTuple(json))));
    });
  }

  it("gives back every double of the conversion corpus bit for bit", () => {
    const reals = [...doubles(20000, 2), ...EDGE_DOUBLES];
    const rows: TypedValue[][] = [];
    for (let i = 0; i < reals.length; i += 100) rows.push(Array.from({ length: 100 }, (_, j) => reals[i + j] ?? null));
    const got = onBoth(100, rows, (cols) => `SELECT ${tupleSql(cols)} AS t FROM w ORDER BY rowid`);
    for (const [engine, tuples] of Object.entries(got)) {
      const back = tuples.flatMap((json) => decodeTuple(parseTuple(json))).slice(0, reals.length);
      const bad = reals.flatMap((x, i) => (typeof back[i] === "number" && bitsOf(back[i] as number) === bitsOf(x) ? [] : [`${x} came back as ${String(back[i])}`]));
      expect(bad.slice(0, 10), engine).toEqual([]);
    }
  });

  it("never calls a function with more than 32 arguments", () => {
    expect(MAX_FUNCTION_ARGS).toBe(32);
    /** 式の中の関数の呼び出しごとの、引数の数。括弧の深さを追って、呼び出しの直下のカンマを数える。 */
    const argumentCounts = (sql: string): { name: string; args: number }[] => {
      const out: { name: string; args: number }[] = [];
      const open: { name: string; args: number }[] = [];
      for (let i = 0; i < sql.length; i++) {
        const c = sql[i]!;
        if (c === "'") {
          i = sql.indexOf("'", i + 1);
        } else if (c === '"') {
          i = sql.indexOf('"', i + 1);
        } else if (c === "(") {
          let j = i;
          while (j > 0 && /[A-Za-z_]/.test(sql[j - 1]!)) j--;
          open.push({ name: sql.slice(j, i), args: 1 });
        } else if (c === ")") {
          out.push(open.pop()!);
        } else if (c === "," && open.length > 0) {
          open[open.length - 1]!.args++;
        }
      }
      return out;
    };
    for (const n of [1, 2, 31, 32, 33, 64, 65, 100, 101, 1024]) {
      const cols = Array.from({ length: n }, (_, i) => `"c${i}"`);
      const calls = argumentCounts(tupleSql(cols));
      expect(Math.max(...calls.map((c) => c.args)), `${n} columns`).toBeLessThanOrEqual(32);
      // 数え方が効いていることも見る。列の式は、列ごとに 1 回ずつ現れる。
      expect(calls.filter((c) => c.name === "hex")).toHaveLength(n);
      expect(calls.filter((c) => c.name === "json_array").length, `${n} columns`).toBe(n <= 32 ? 1 : 1 + Math.ceil(n / 32));
    }
    // 32 個ずつの入れ子は 1 段だけである。1,024 列を超える並びは作らない (表の列の上限は 100)。
    expect(() => tupleSql(Array.from({ length: 1025 }, (_, i) => `c${i}`))).toThrow(/too many columns/);
  });

  it("is flattened by exactly one level when it is read", () => {
    expect(parseTuple('["i1",null,"tx"]')).toEqual(["i1", null, "tx"]);
    expect(parseTuple('[["i1",null],["tx"]]')).toEqual(["i1", null, "tx"]);
    // 要素は文字列か null なので、配列が混ざっていれば入れ子である。配列でない JSON と、2 段の入れ子は、タプルではない。
    expect(() => parseTuple('{"a":1}')).toThrow(/not a tuple/);
    expect(() => parseTuple('[[["i1"]]]')).toThrow(/not a tuple/);
    expect(() => parseTuple("[1]")).toThrow(/not a tuple/);
  });
});

describe("the element expressions for result columns", () => {
  // NUL を含む文字列は入れない。node:sqlite と sql.js のドライバは、結果の TEXT を最初の NUL で切って返す
  // (test/workerd-limits.test.ts。DO のドライバは全部を返す)。タプルは JSON なので、上の試験では NUL も通っている。
  const plain = (seed: number) => values(600, seed).filter((v) => !(typeof v === "string" && v.includes("\u0000")));

  it("SELECT: marks INTEGER and TEXT and returns REAL and BLOB as they are", () => {
    const vs = plain(20);
    const lite = new DatabaseSync(":memory:");
    lite.exec("CREATE TABLE u(id INTEGER PRIMARY KEY, v)");
    const insert = lite.prepare("INSERT INTO u(v) VALUES (?)");
    for (const v of vs) insert.run(v as never);
    const st = lite.prepare(`SELECT ${selectElemSql("v")} AS e FROM u ORDER BY id`);
    st.setReadBigInts(true);
    const rows = st.all() as { e: Elem | number | Uint8Array }[];
    expect(rows.map((r) => shown(decodeElem(r.e)))).toEqual(vs.map(shown));
    // 印を付けた列は TEXT になる。ドライバが INTEGER を数として返すことはない。
    expect(rows.every((r) => typeof r.e !== "bigint")).toBe(true);
    const db = new SQL.Database();
    db.run("CREATE TABLE u(id INTEGER PRIMARY KEY, v)");
    for (const v of vs) {
      const { sql, params } = sqljsInsert("u(v)", [v]);
      db.run(sql, params);
    }
    const got = (db.exec(`SELECT ${selectElemSql("v")} FROM u ORDER BY id`)[0]?.values ?? []).map((r) => shown(decodeElem(r[0] as Elem | number | Uint8Array)));
    expect(got).toEqual(vs.map(shown));
    db.close();
  });

  it("RETURNING: marks REAL too, so that an integer put into a REAL column comes back as REAL", () => {
    const vs = plain(21);
    const lite = new DatabaseSync(":memory:");
    lite.exec("CREATE TABLE u(id INTEGER PRIMARY KEY, v, r REAL)");
    const st = lite.prepare(`INSERT INTO u(v, r) VALUES (?, ?) RETURNING ${returningElemSql("v")} AS v, ${returningElemSql("r")} AS r`);
    st.setReadBigInts(true);
    const got = vs.map((v, i) => st.get(v as never, BigInt(i)) as { v: Elem | Uint8Array; r: Elem });
    expect(got.map((g) => shown(decodeElem(g.v)))).toEqual(vs.map(shown));
    // REAL の列に入れた整数は、REAL として返る (`r5.0`)。SELECT の形の式だと、ドライバには INTEGER が届く。
    expect(got.map((g) => g.r)).toEqual(vs.map((_v, i) => `r${i}.0`));
    expect(got.map((g) => shown(decodeElem(g.r)))).toEqual(vs.map((_v, i) => shown(i)));
  });
});

describe("the bridge from today's values", () => {
  it("reads an integral JS number as INTEGER and a marked or fractional number as REAL", () => {
    expect([typedOf(5), typedOf(realOf(5)), typedOf(0.5), typedOf("5"), typedOf(null)].map(shown)).toEqual([5n, 5, 0.5, "5", null].map(shown));
    // 64 ビットに収まらない整数の値は、今の決まりでも REAL である。
    expect(shown(typedOf(1e20))).toBe(shown(1e20));
    expect(typedOf(new Uint8Array([1]))).toEqual(new Uint8Array([1]));
  });
});
