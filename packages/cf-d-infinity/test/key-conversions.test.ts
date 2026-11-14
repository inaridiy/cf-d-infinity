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
import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { keyString, keyValues, storedAs } from "../src/keys";
import { oldKeyString } from "./key-string-old";
import { initStoredValue, storedValue } from "../src/sql/stored";
import type { Affinity, Value } from "../src/types";
import { decodeTuple, isReal, parseTuple, realOf, tupleSql, typedOf, type TypedValue } from "../src/value";
import { prng, SimCluster } from "./sim";
import { bitsOf, doubles, EDGE_DOUBLES, INT64, int64s, numericStrings, sqljsBinding, TRICKY_STRINGS } from "./value-corpus";

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
  it("the format-1 keyString (test/key-string-old.ts), over the values that can be stored today", () => {
    // いま保存できるのは、絶対値が 2^53 未満の INTEGER と、REAL である (2^53 以上の INTEGER は断る。計画書の K1)。
    const today = (v: Typed): Value | undefined =>
      typeof v === "number" ? realOf(v) : v > -(2n ** 53n) && v < 2n ** 53n ? Number(v) : undefined;
    const r = keyDisagreements(EDGE_VALUES, (v) => {
      const x = today(v);
      return x === undefined ? undefined : oldKeyString([x]);
    });
    expect(r.bad.slice(0, 10)).toEqual([]);
    // 等しい組もある (INTEGER の 5 と REAL の 5.0 など)。なければ、「どれも違う」と答える関数でも通ってしまう。
    expect(r.equal).toBeGreaterThan(3);
  });

  it("the new key string, over every 64-bit INTEGER and every REAL", () => {
    // 段 2 から使う keyString。2^53 以上の INTEGER と、その前後の REAL の組でも一致する。
    const r = keyDisagreements(EDGE_VALUES, (v) => keyString([v]));
    expect(r.bad.slice(0, 10)).toEqual([]);
    // INTEGER の 2^53 と REAL の 2^53、INTEGER の -2^63 と REAL の -2^63 のような、2^53 以上で等しい組が入っている。
    expect(r.equal).toBeGreaterThan(8);
    expect(keyString([2n ** 60n])).toBe(keyString([2 ** 60]));
    expect(keyString([2n ** 60n + 1n])).not.toBe(keyString([2 ** 60]));
    expect(keyString([-(2n ** 63n)])).toBe(keyString([-(2 ** 63)]));
    // 形式 1 の keyString は、JS の表記で書く。2^53 以上では、表記が同じでも値が違う INTEGER がある。
    expect(oldKeyString([realOf(2 ** 60)])).toBe("[1152921504606847000]");
    expect(keyString([realOf(2 ** 60)])).toBe("[1152921504606846976]");
  });
});

// ---- 新しいキー文字列と、その読み戻し (値の作り直しの段 1 で足し、段 2 から使う) ----

const shownTyped = (v: TypedValue): string =>
  v === null ? "NULL"
    : typeof v === "bigint" ? `INTEGER ${v}`
      : typeof v === "number" ? `REAL ${bitsOf(Object.is(v, -0) ? 0 : v)} (${v})`
        : typeof v === "string" ? `TEXT ${JSON.stringify(v)}`
          : `BLOB ${[...v].join(",")}`;

describe("the new key string against the format-1 one", () => {
  it("is the same string for every value that can be stored today, except integral REALs beyond 2^53 that JS does not write exactly", () => {
    // いま保存できる値。絶対値が 2^53 未満の INTEGER、REAL、TEXT、BLOB、NULL。行の token はキー文字列から決まるので、
    // 文字列が 1 バイトでも変わると、その行の置き場所が変わる。
    const today: Value[] = [
      ...[...INT64, ...int64s(2000, 5)].filter((v) => v > -(2n ** 53n) && v < 2n ** 53n).map(Number),
      ...[...doubles(20000, 2), ...EDGE_DOUBLES, 0, -0, Infinity, -Infinity].map(realOf),
      // 印のない、64 ビットに収まらない整数の値の数も、今の決まりでは REAL である。
      1e20, 2 ** 64, -(2 ** 70),
      null, ...numericStrings(doubles(300, 3)), ...TRICKY_STRINGS, "a\u0000b", "é", 'q"r', "back\\slash",
      new Uint8Array([]), new Uint8Array([0, 255, 16]), new Uint8Array([1, 2]),
    ];
    const bad: string[] = [];
    let changed = 0;
    for (const v of today) {
      const [was, now] = [oldKeyString([v]), keyString([v])];
      // 今の決まりの値 (整数の JS の数は INTEGER) で渡しても、型のある値 (BigInt は INTEGER) で渡しても、同じ文字列になる。
      if (keyString([typedOf(v)]) !== now) bad.push(`${JSON.stringify(v)}: ${now} with today's value, ${keyString([typedOf(v)])} with the typed value`);
      if (was === now) continue;
      // 変わってよいのは、設計書の「変わるキーと変わらないキー」の 2 行目だけである。
      const x = isReal(v) ? v.real : null;
      if (x === null || Math.abs(x) < 2 ** 53 || x < -(2 ** 63) || x >= 2 ** 63) bad.push(`${JSON.stringify(v)}: ${was} became ${now}`);
      else if (now !== `[${BigInt(x)}]`) bad.push(`${JSON.stringify(v)}: ${now} is not the exact value ${BigInt(x)}`);
      else changed++;
    }
    expect(bad.slice(0, 10)).toEqual([]);
    // その 1 つの場合が、値の集まりに入っている。入っていなければ、「変わってよい」の条件は何も確かめていない。
    expect(changed).toBeGreaterThan(0);
    // 複数の列のキーも、列ごとの書き方を並べたものである。
    const r = prng(9);
    for (let i = 0; i < 2000; i++) {
      const key = Array.from({ length: 1 + Math.floor(r() * 3) }, () => today[Math.floor(r() * today.length)]!);
      const changes = key.some((v) => oldKeyString([v]) !== keyString([v]));
      if ((oldKeyString(key) === keyString(key)) === changes) bad.push(`${JSON.stringify(key)}: ${oldKeyString(key)} and ${keyString(key)}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe("a key string read back with keyValues", () => {
  const KEYS: TypedValue[] = [
    ...INT64, ...int64s(200, 7), ...EDGE_DOUBLES, ...doubles(300, 8), 5, 0.5, -0.25, 1e19, 1e21, Infinity, -Infinity,
    "", "abc", "5", "5.0", "a\u0000b", "é", 'q"r', "9223372036854775807", new Uint8Array([]), new Uint8Array([0, 255]), new Uint8Array([53]),
  ];

  it("gives values that write the same key string again", () => {
    const bad: string[] = [];
    for (const v of KEYS) {
      const key = keyString([v, null, v]);
      const back = keyValues(key);
      if (keyString(back) !== key) bad.push(`${shownTyped(v)}: ${key} read back as ${back.map(shownTyped).join(", ")}`);
      // 型は、INTEGER と、整数の値で 64 ビットに収まる REAL が INTEGER で戻り、ほかは元の型で戻る。
      const integral = typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v) && v >= -(2 ** 63) && v < 2 ** 63);
      const want = integral ? shownTyped(BigInt(v as bigint | number)) : shownTyped(v);
      if (shownTyped(back[0]!) !== want || back[1] !== null) bad.push(`${shownTyped(v)}: read back as ${shownTyped(back[0]!)}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(keyValues("[9007199254740993,-9223372036854775808,0.5,1e+21]").map(shownTyped))
      .toEqual([9007199254740993n, -(2n ** 63n), 0.5, 1e21].map(shownTyped));
  });

  it("finds exactly the row the key was made from, also when the row holds a REAL and the key reads back as an INTEGER", () => {
    const lite = new DatabaseSync(":memory:");
    lite.exec("CREATE TABLE u(k PRIMARY KEY, v INTEGER)");
    lite.exec("CREATE TABLE c(a, b, v INTEGER, PRIMARY KEY (a, b))");
    const stored: [TypedValue, number][] = [];
    const seen = new Set<string>();
    KEYS.forEach((v, i) => {
      // 同じキーの値 (INTEGER の 5 と REAL の 5.0 など) は、先に入れたものだけが行になる。
      if (seen.has(keyString([v]))) return;
      seen.add(keyString([v]));
      lite.prepare("INSERT INTO u VALUES (?, ?)").run(v as never, i);
      lite.prepare("INSERT INTO c VALUES (?, ?, ?)").run(v as never, KEYS[(i * 7) % KEYS.length] as never, i);
      stored.push([v, i]);
    });
    const one = lite.prepare("SELECT v FROM u WHERE k IS ?");
    const two = lite.prepare("SELECT v FROM c WHERE a IS ? AND b IS ?");
    const bad: string[] = [];
    for (const [v, i] of stored) {
      const [k] = keyValues(keyString([v]));
      const rows = one.all(k as never).map((r) => r.v);
      if (rows.length !== 1 || rows[0] !== i) bad.push(`${shownTyped(v)} looked up as ${shownTyped(k!)}: rows ${JSON.stringify(rows)}`);
      const [a, b] = keyValues(keyString([v, KEYS[(i * 7) % KEYS.length]!]));
      const pair = two.all(a as never, b as never).map((r) => r.v);
      if (pair.length !== 1 || pair[0] !== i) bad.push(`(${shownTyped(v)}, …) looked up: rows ${JSON.stringify(pair)}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(stored.length).toBeGreaterThan(500);
  });
});

// ---- storedValue (値の作り直しの段 1。まだどこからも呼ばれていない) ----

describe("storedValue", () => {
  it("refuses to answer before its SQLite is open", () => {
    // JS で決まる変換でも投げる。初期化を忘れた呼び出しが、値によって通ったり落ちたりしない。
    expect(() => storedValue("5", "INTEGER")).toThrow(/before initStoredValue/);
    expect(() => storedValue(5n, "INTEGER")).toThrow(/before initStoredValue/);
  });

  describe("once its SQLite is open", () => {
    const AFFINITIES: [string, Affinity][] = [["t", "TEXT"], ["n", "NUMERIC"], ["i", "INTEGER"], ["r", "REAL"], ["b", "BLOB"]];
    const DDL = "CREATE TABLE a(id INTEGER PRIMARY KEY, t TEXT, n NUMERIC, i INTEGER, r REAL, b BLOB)";
    /** 値を 5 つの列に入れ、入った値をタプルで読む文。mark は引数の書き方 (sql.js では型を保つ式で包む)。 */
    const insert = (mark: string) => `INSERT OR REPLACE INTO a(id, t, n, i, r, b) VALUES (1, ${AFFINITIES.map(() => mark).join(", ")}) RETURNING ${tupleSql(AFFINITIES.map(([c]) => c))}`;
    let SQL: Awaited<ReturnType<typeof initSqlJs>>;
    beforeAll(async () => {
      SQL = await initSqlJs();
      await initStoredValue(SQL);
    });

    it("gives the value that node:sqlite and sql.js store in a column of each affinity", () => {
      const reals = [...doubles(2000, 2), ...EDGE_DOUBLES, 0, -0, Infinity, -Infinity, NaN];
      const values: TypedValue[] = [
        ...reals, ...INT64, ...int64s(300, 4), ...new Set(numericStrings([...doubles(300, 3), ...EDGE_DOUBLES])),
        "a\u0000b", "5\u0000", "é", null, new Uint8Array([]), new Uint8Array([0, 255]), new Uint8Array([53]),
      ];
      const lite = new DatabaseSync(":memory:");
      lite.exec(DDL);
      const node = lite.prepare(insert("?1"));
      const db = new SQL.Database();
      db.run(DDL);
      const bad: string[] = [];
      const undecided: Record<string, number> = {};
      for (const v of values) {
        const onNode = decodeTuple(parseTuple(Object.values(node.get(v as never) as Record<string, string>)[0]!));
        const { marks, params } = sqljsBinding([v]);
        const onSqljs = decodeTuple(parseTuple(db.exec(insert(marks[0]!.replace("?", "?1")), params)[0]!.values[0]![0] as string));
        AFFINITIES.forEach(([, affinity], j) => {
          const want = shownTyped(onNode[j]!);
          if (shownTyped(onSqljs[j]!) !== want) bad.push(`${shownTyped(v)} into ${affinity}: sql.js stores ${shownTyped(onSqljs[j]!)}, node:sqlite ${want}`);
          const got = storedValue(v, affinity);
          if (got === undefined) {
            const kind = `${v === null ? "NULL" : typeof v === "bigint" ? "INTEGER" : typeof v === "number" ? "REAL" : typeof v === "string" ? "TEXT" : "BLOB"} into ${affinity}`;
            undecided[kind] = (undecided[kind] ?? 0) + 1;
          } else if (shownTyped(got) !== want) bad.push(`${shownTyped(v)} into ${affinity}: storedValue says ${shownTyped(got)}, SQLite stores ${want}`);
        });
      }
      db.close();
      expect(bad.slice(0, 10)).toEqual([]);
      // 決めないのは、REAL を TEXT にする変換だけである (NaN は NULL として入るので、そこには数えない)。
      expect(undecided).toEqual({ "REAL into TEXT": reals.length - 1 });
    });

    it("leaves the conversion of a string to SQLite: forms that JS reads differently, and a string that keeps a NUL", () => {
      const cases: [TypedValue, Affinity, TypedValue][] = [
        ["0x10", "INTEGER", "0x10"], [" 12 ", "INTEGER", 12n], ["1e3", "INTEGER", 1000n], ["1e3", "REAL", 1000], ["abc", "NUMERIC", "abc"], ["", "INTEGER", ""],
        ["9223372036854775807", "INTEGER", 2n ** 63n - 1n], ["9223372036854775808", "INTEGER", 2 ** 63], ["-9223372036854775808", "NUMERIC", -(2n ** 63n)],
        ["9007199254740993", "REAL", 2 ** 53], ["1e400", "REAL", Infinity], ["5.0", "TEXT", "5.0"], ["5\u0000", "INTEGER", "5\u0000"], ["a\u0000b", "NUMERIC", "a\u0000b"],
        // 数どうしの変換。安全な範囲は JS で決まり、その外は SQLite が決める。
        [5, "INTEGER", 5n], [5n, "REAL", 5], [5n, "TEXT", "5"], [0.5, "INTEGER", 0.5], [2 ** 60, "INTEGER", 2n ** 60n], [1e19, "INTEGER", 1e19],
        [2n ** 53n + 1n, "REAL", 2 ** 53], [2n ** 63n - 1n, "REAL", 2 ** 63], [2n ** 63n - 1n, "TEXT", "9223372036854775807"], [-0, "INTEGER", 0n],
      ];
      for (const [v, a, want] of cases) expect(`${shownTyped(v)} into ${a}: ${shownTyped(storedValue(v, a) as TypedValue)}`).toBe(`${shownTyped(v)} into ${a}: ${shownTyped(want)}`);
      expect(storedValue(0.5, "TEXT")).toBeUndefined();
    });
  });
});
