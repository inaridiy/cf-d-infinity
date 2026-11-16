// 照合順序のキーの検査の部品 (docs/design-unique-keys.md の「照合順序のキーの検査」、段 0 の (a))。
//
// キーの関数 (段 1 で入る正規化。UNIQUE の値をキーの行の主キー k にする) が、SQLite の UNIQUE と同じ値を同じと見なすことを確かめる。
// キーの関数はまだないので、検査は関数を引数に取る。ここには、通るはずの参照の実装 (referenceKey) と、わざと壊した実装 (BROKEN) を置く。
// test/unique-keys.test.ts (node:sqlite と sql.js) と test/unique-keys-workerd.test.ts (手元の workerd の DO の SQLite) が使う。
//
// 比べ方:
// - 値は型ごとに SQL の literal で書き、束縛しない。DO は JS の数を REAL で束縛し、BigInt を束縛できない。sql.js は 32 ビットに収まる
//   整数の値の数を INTEGER で束縛する。TEXT は `CAST(x'..' AS TEXT)` で書く。束縛すると、ドライバによっては NUL で切れる。
// - 値 (と値の組) に番号を付けて、型のない列の表に入れる。照合順序ごとに、UNIQUE のある表へ、番号の順に INSERT OR IGNORE で入れる。
//   残った行が、SQLite の UNIQUE が別と見なした値の類の、最初の値である。
// - 各値の類の代表は、残った行のうち、照合順序で等しい最小の番号である。比べるのは列どうしにする。`x = CAST(x'..' AS TEXT)` のように
//   literal と比べると、右辺の TEXT の親和性が、左の型のない列の数を TEXT に変えてしまい、INTEGER の 1 と TEXT の '1' が等しくなる。
// - 加えて、全部の組を `a.x = b.x COLLATE X` で比べて、等しい組を引く。UNIQUE の index と `=` の両方を、キーの関数と比べる。
// - ドライバから読むのは、番号と、hex() と quote() の ASCII の文字だけである。node:sqlite と sql.js は、結果の TEXT を NUL で切る
//   (未解決の問題 32)。等しいかどうかは、いつも SQLite の中で決まる。
// - キーの関数には、ここで作った JS の値を渡す。ドライバから読み戻した値は渡さない。入った値が作ったとおりかは、typeof()、hex()、
//   quote() で確かめる (検査そのものの確かめ)。
import { DatabaseSync } from "node:sqlite";
import type initSqlJs from "sql.js";
import { keyString } from "../src/keys";
import type { Value } from "../src/types";
import { prng } from "./sim";

export type Collation = "BINARY" | "NOCASE" | "RTRIM";

/**
 * キーの関数の形。制約の列の値 (SQLite が格納した要素) と、列ごとの照合順序から、キーの行の主キー k を作る。
 * キーの行を持たない組 (どれかの列が NULL) は null を返す。null の組は、どの組とも衝突しない。
 */
export type KeyFn = (values: readonly Value[], collations: readonly Collation[]) => string | null;

const utf8 = new TextEncoder();

/** TEXT の正規形。docs/design-unique-keys.md の「正規形」の表のとおり。 */
function normalText(s: string, c: Collation): string {
  switch (c) {
    case "BINARY":
      return s;
    case "RTRIM":
      // 末尾の U+0020 だけを落とす。タブ、改行、U+00A0、U+3000 は落とさない。
      return s.replace(/ +$/, "");
    case "NOCASE": {
      // sqlite3StrNICmp は ASCII の 26 文字だけを畳み、左の文字列の NUL で止まる。等しければ、全体のバイト数を比べる。
      // だから NUL を含む値は、最初の NUL の手前と、全体の UTF-8 のバイト数で決まる。NUL を含まない値の正規形は NUL を含まないので、
      // 2 つの形は混ざらない。
      const nul = s.indexOf("\u0000");
      const head = (nul < 0 ? s : s.slice(0, nul)).replace(/[A-Z]/g, (ch) => ch.toLowerCase());
      return nul < 0 ? head : `${head}\u0000${utf8.encode(s).length}`;
    }
  }
}

/** 参照の実装。段 1 のキーの関数は、これと同じ答えを返すはずである。 */
export const referenceKey: KeyFn = (values, collations) => {
  if (values.some((v) => v === null)) return null;
  return keyString(values.map((v, i) => (typeof v === "string" ? normalText(v, collations[i]!) : v)));
};

/** TEXT の正規化だけを差し替えたキーの関数。 */
const withText = (text: (s: string, c: Collation) => string): KeyFn => (values, collations) => {
  if (values.some((v) => v === null)) return null;
  return keyString(values.map((v, i) => (typeof v === "string" ? text(v, collations[i]!) : v)));
};

/**
 * わざと壊したキーの関数。検査が検査になっていることの確かめに使う。どれも、どれかのエンジンで落ちなければならない。
 * 名前は、壊し方である。
 */
export const BROKEN: Record<string, KeyFn> = {
  // NOCASE を Unicode の小文字にする。'É' と 'é'、'K' (U+212A) と 'k' を同じと見なしてしまう。
  "Unicode lowercasing": withText((s, c) => (c === "NOCASE" ? normalText(s.toLowerCase(), c) : normalText(s, c))),
  // RTRIM で空白を全部落とす。先頭と途中の空白も落とすので、'a b' と 'ab' を同じと見なす。
  "dropping all spaces": withText((s, c) => (c === "RTRIM" ? s.replaceAll(" ", "") : normalText(s, c))),
  // RTRIM で末尾の空白の類を全部落とす (trimEnd)。'a\t' と 'a'、'a　' と 'a' を同じと見なす。
  "trimEnd for RTRIM": withText((s, c) => (c === "RTRIM" ? s.trimEnd() : normalText(s, c))),
  // NOCASE の NUL の規則を落とす。'a\0x' と 'A\0y' を別と見なす。
  "ignoring the NUL rule": withText((s, c) => (c === "NOCASE" ? s.replace(/[A-Z]/g, (ch) => ch.toLowerCase()) : normalText(s, c))),
  // NULL を含む組にもキーを作る。SQLite の UNIQUE は、NULL を含む組をどれも別の値と見なす。
  "a key for tuples with NULL": (values, collations) => keyString(values.map((v, i) => (typeof v === "string" ? normalText(v, collations[i]!) : v))),
  // REAL を JS の表記で書く (保存の形式 1 の keyString の書き方)。2^53 を超える整数の値の REAL の表記は、double の正確な値ではない。
  "REAL in the JS notation": (values, collations) => {
    if (values.some((v) => v === null)) return null;
    return JSON.stringify(values.map((v, i) =>
      typeof v === "string" ? normalText(v, collations[i]!) : typeof v === "bigint" ? `i${v}` : typeof v === "number" ? (Number.isFinite(v) ? `i${v}` : `f${v}`) : v instanceof Uint8Array ? { b: [...v] } : v));
  },
};

// ---- 値 ----

const KELVIN = "K";
/** 決まった TEXT。大文字と小文字、先頭と末尾の空白、空白の類、NUL の位置、多バイト文字、合成文字、大文字と小文字の対が 1 対 1 でない文字。 */
const TEXTS: string[] = [
  "", " ", "  ", "a", "A", "b", "B", "ab", "AB", "Ab", "aB", "abc", "ABC", "aBc",
  "a ", "A ", "a  ", "A  ", " a", " A", "  a", "a b", "A B", "ab ", "AB ", "a b ", "a\t", "A\t", "a\t ", "a \t", "a\n", "a\r\n",
  "a ", "A ", "a　", "\t", "\n", " ", "　", "  ", "  ", "x", "X",
  "\u0000", "\u0000\u0000", "a\u0000", "A\u0000", "a\u0000x", "A\u0000y", "A\u0000yz", "a\u0000X", "a\u0000\u0000", "\u0000a", "\u0000A", "\u0000b",
  "ab\u0000", "AB\u0000c", "Ab\u0000d", "a\u0000 ", "a \u0000", "A \u0000", "a\u0000é", "A\u0000ab", "é\u0000a", "É\u0000b", "é\u0000é",
  "é", "É", "é", "É", "ß", "ẞ", "ss", "SS", "ı", "I", "i", "İ", KELVIN, "k", "K", "ǅ", "ǆ", "Ǆ", "Ω", "ω", "Ａ", "ａ",
  "日本", "日本 ", "日本　", "😀", "😀 ", "😀\u0000", "1", "1.0", " 1", "1 ", "01", "0x10", "-0", "NULL", "null",
];

/** 決まった INTEGER。64 ビットの端、2^53 の前後、REAL で正確に書けない整数 (JS の表記と同じ数字の整数)。 */
const INTEGERS: bigint[] = [
  0n, 1n, -1n, 2n, 5n, 2n ** 31n - 1n, 2n ** 31n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 53n + 1n, -(2n ** 53n), -(2n ** 53n) - 1n,
  2n ** 62n + 1024n, 4611686018427389000n, 2n ** 63n - 1n, -(2n ** 63n) + 1n, -(2n ** 63n),
];

/** 決まった REAL。整数の値、-0.0、2^53 と 2^63 の前後、無限大、非正規化数。 */
const REALS: number[] = [
  0, -0, 1, -1, 2, 5, 0.5, 1.5, 0.1, 2 ** 31, 2 ** 53, 2 ** 53 + 2, -(2 ** 53), 2 ** 62 + 1024, 2 ** 63, -(2 ** 63), 2 ** 64,
  1e20, 1e300, -1e300, 5e-324, 2.2250738585072014e-308, Number.MAX_VALUE, Infinity, -Infinity,
];

/** BLOB。TEXT と同じバイト列のものを含める。照合順序は BLOB に効かない。 */
const BLOBS: Uint8Array[] = [new Uint8Array([]), new Uint8Array([0])].concat(["a", "A", "a ", "A ", "a\u0000x", "A\u0000y", "é", "1", "ab"].map((s) => utf8.encode(s)));

/** 乱択の短い TEXT の文字。照合順序で比べ方が変わる文字を多めに入れる。 */
const ALPHABET = ["a", "A", "b", "B", " ", " ", "\t", "\u0000", "é", "É", " ", "　", "x", "X", "ß"];

/** 検査に流す値の全部。番号は、この並びの位置である。 */
export function corpus(seed = 1, random = 120): Value[] {
  const r = prng(seed);
  const extra: string[] = [];
  for (let k = 0; k < random; k++) {
    const n = Math.floor(r() * 5);
    extra.push(Array.from({ length: n }, () => ALPHABET[Math.floor(r() * ALPHABET.length)]!).join(""));
  }
  return [null, ...TEXTS, ...INTEGERS, ...REALS, ...BLOBS, null, ...extra];
}

/** 組の検査に使う値。類が 2 つ以上の値を持つものを選ぶ。 */
export const TUPLE_MEMBERS: Value[] = [
  null, "a", "A", "a ", "A ", "a\t", " a", "b", "a\u0000x", "A\u0000y", "a\u0000", "é", "É", "", " ", "ß", "x", "X", "a b",
  1n, 1, "1", utf8.encode("a"), utf8.encode("A"), 0n, -0, 2n ** 53n, 2 ** 53,
];

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** 値を SQL の literal にする。TEXT は UTF-8 のバイト列から作るので、NUL もそのまま入る。 */
export function literal(v: Value): string {
  if (v === null) return "NULL";
  if (typeof v === "bigint") return v === -(2n ** 63n) ? "(-9223372036854775807 - 1)" : `${v}`;
  if (typeof v === "number") {
    if (v === Infinity) return "9e999";
    if (v === -Infinity) return "-9e999";
    if (Object.is(v, -0)) return "-0.0";
    const s = String(v);
    // 小数点も指数もない表記は、SQLite が INTEGER として読む。REAL にするために `.0` を足す。
    return /[.e]/.test(s) ? s : `${s}.0`;
  }
  if (typeof v === "string") return `CAST(x'${hex(utf8.encode(v))}' AS TEXT)`;
  return `x'${hex(v)}'`;
}

/** 値を人が読める形にする。TEXT は JSON の表記 (NUL は \u0000) で書く。 */
export function shown(v: Value): string {
  if (v === null) return "NULL";
  if (typeof v === "bigint") return `INTEGER ${v}`;
  if (typeof v === "number") return `REAL ${Object.is(v, -0) ? "-0.0" : String(v)}`;
  if (typeof v === "string") return `TEXT ${JSON.stringify(v)}`;
  return `BLOB x'${hex(v)}'`;
}

// ---- SQLite の側 ----

/** 文を順に実行して、文ごとに結果の行を返す。値は文字にする (読むのは番号と ASCII の文字だけである)。同じ engine の呼び出しは、同じデータベースに続けて効く。 */
export interface Engine {
  name: string;
  run(sql: string[]): Promise<(string | null)[][][]>;
}

const cellText = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Uint8Array ? `x'${hex(v)}'` : String(v);

/** node:sqlite (シミュレータのシャードの SQLite)。 */
export function nodeEngine(): Engine {
  const db = new DatabaseSync(":memory:");
  return {
    name: "node:sqlite",
    run: async (sqls) => sqls.map((sql) => {
      const st = db.prepare(sql);
      if (st.columns().length === 0) return (st.run(), []);
      st.setReturnArrays(true);
      st.setReadBigInts(true);
      return (st.all() as unknown as unknown[][]).map((r) => r.map(cellText));
    }),
  };
}

/** sql.js (Worker の SQLite)。 */
export function sqljsEngine(SQL: Awaited<ReturnType<typeof initSqlJs>>): Engine {
  const db = new SQL.Database();
  return {
    name: "sql.js",
    run: async (sqls) => sqls.map((sql) => {
      const st = db.prepare(sql);
      try {
        const rows: (string | null)[][] = [];
        while (st.step()) rows.push(st.get().map(cellText));
        return rows;
      } finally {
        st.free();
      }
    }),
  };
}

/** 照合順序の検査の 1 つの場面。列の数だけ照合順序がある。 */
export interface Setup {
  name: string;
  collations: Collation[];
  /** 照合順序を書く場所。column は列の定義 (`x COLLATE NOCASE UNIQUE`)、index は CREATE UNIQUE INDEX の列。 */
  declared: "column" | "index";
  /** 組の検査に使う値の番号。なければ、1 列で値の全部を使う。 */
  members?: number[];
}

/** 場面ごとの SQLite の答え。組は番号で表し、番号の順に入れた。 */
export interface Classes {
  /** 組の番号と、組の値 (corpus の番号)。 */
  tuples: { id: number; members: number[] }[];
  /** INSERT OR IGNORE で残った組。 */
  survivors: Set<number>;
  /** 組ごとの、残った組のうち `=` で等しい最小の番号。NULL を含む組は null。 */
  rep: Map<number, number | null>;
  /** `=` で等しい組の対 (小さい番号が先)。 */
  pairs: Set<string>;
}

const pairKey = (a: number, b: number) => `${Math.min(a, b)},${Math.max(a, b)}`;

/** 値を表 v に入れる文。文の長さの上限 (DO は 100 KB) に収まるように分ける。 */
export function loadSql(values: Value[]): string[] {
  const out = ["CREATE TABLE v(i INTEGER PRIMARY KEY, x)"];
  for (let k = 0; k < values.length; k += 40) {
    out.push(`INSERT INTO v(i, x) VALUES ${values.slice(k, k + 40).map((v, j) => `(${k + j}, ${literal(v)})`).join(", ")}`);
  }
  return out;
}

/** 入った値が作ったとおりかを確かめる。違いの説明を返す。 */
export async function checkLoaded(e: Engine, values: Value[]): Promise<string[]> {
  const [rows] = await e.run(["SELECT i, typeof(x), hex(x), quote(x) FROM v ORDER BY i"]);
  const out: string[] = [];
  for (const [i, type, hx, q] of rows!) {
    const v = values[Number(i)]!;
    const want = v === null ? "null" : typeof v === "bigint" ? "integer" : typeof v === "number" ? "real" : typeof v === "string" ? "text" : "blob";
    let same = type === want;
    if (same && typeof v === "bigint") same = q === `${v}`;
    // quote() は REAL を元に戻せる桁数で書く。-0.0 は 0.0 と同じ値である (SQLite は符号を持たないことがある)。
    if (same && typeof v === "number") same = Number(q) === v || (q === "9.0e+999" && v === Infinity) || (q === "-9.0e+999" && v === -Infinity);
    if (same && typeof v === "string") same = hx === hex(utf8.encode(v)).toUpperCase();
    if (same && v instanceof Uint8Array) same = hx === hex(v).toUpperCase();
    if (!same) out.push(`${e.name}: value #${i} ${shown(v)} was stored as ${type} ${q} (hex ${hx})`);
  }
  if (rows!.length !== values.length) out.push(`${e.name}: ${rows!.length} values stored, ${values.length} written`);
  return out;
}

/** 場面の表を作り、SQLite の答えを読む。値は loadSql で入れてあること。 */
export async function sqliteClasses(e: Engine, s: Setup, values: Value[]): Promise<Classes> {
  const t = `t_${s.name}`;
  const u = `u_${s.name}`;
  const n = s.collations.length;
  const cols = Array.from({ length: n }, (_v, k) => `c${k}`);
  const tuples: { id: number; members: number[] }[] = [];
  const sql: string[] = [];
  sql.push(`CREATE TABLE ${t}(i INTEGER PRIMARY KEY, ${cols.join(", ")})`);
  if (!s.members) {
    if (n !== 1) throw new Error(`setup ${s.name}: a setup without members has one column`);
    for (let k = 0; k < values.length; k++) tuples.push({ id: k, members: [k] });
    sql.push(`INSERT INTO ${t}(i, c0) SELECT i, x FROM v`);
  } else {
    if (n !== 2) throw new Error(`setup ${s.name}: a setup with members has two columns`);
    for (const a of s.members) for (const b of s.members) tuples.push({ id: a * 1000 + b, members: [a, b] });
    const list = s.members.join(", ");
    sql.push(`INSERT INTO ${t}(i, c0, c1) SELECT a.i * 1000 + b.i, a.x, b.x FROM v a, v b WHERE a.i IN (${list}) AND b.i IN (${list})`);
  }
  tuples.sort((x, y) => x.id - y.id);
  if (s.declared === "column") {
    const defs = cols.map((c, k) => `${c} COLLATE ${s.collations[k]}${n === 1 ? " UNIQUE" : ""}`);
    sql.push(`CREATE TABLE ${u}(i INTEGER PRIMARY KEY, ${defs.join(", ")}${n > 1 ? `, UNIQUE (${cols.join(", ")})` : ""})`);
  } else {
    sql.push(`CREATE TABLE ${u}(i INTEGER PRIMARY KEY, ${cols.join(", ")})`);
    sql.push(`CREATE UNIQUE INDEX ${u}_k ON ${u}(${cols.map((c, k) => `${c} COLLATE ${s.collations[k]}`).join(", ")})`);
  }
  sql.push(`INSERT OR IGNORE INTO ${u}(i, ${cols.join(", ")}) SELECT i, ${cols.join(", ")} FROM ${t} ORDER BY i`);
  const eq = (l: string, r: string) => cols.map((c, k) => `${l}.${c} = ${r}.${c} COLLATE ${s.collations[k]}`).join(" AND ");
  const reads = [
    `SELECT i FROM ${u} ORDER BY i`,
    `SELECT t.i, (SELECT min(u.i) FROM ${u} u WHERE ${eq("u", "t")}) FROM ${t} t ORDER BY t.i`,
    `SELECT a.i, b.i FROM ${t} a JOIN ${t} b ON a.i < b.i WHERE ${eq("a", "b")} ORDER BY 1, 2`,
  ];
  const out = await e.run([...sql, ...reads]);
  const [survivors, reps, pairs] = out.slice(sql.length);
  return {
    tuples,
    survivors: new Set(survivors!.map((r) => Number(r[0]))),
    rep: new Map(reps!.map((r) => [Number(r[0]), r[1] === null ? null : Number(r[1])])),
    pairs: new Set(pairs!.map((r) => pairKey(Number(r[0]), Number(r[1])))),
  };
}

/** 場面の全部。1 列の 3 つの照合順序と、照合順序を混ぜた 2 列の組。 */
export function setups(values: Value[]): Setup[] {
  const members = TUPLE_MEMBERS.map((m) => {
    const at = values.findIndex((v) => shown(v) === shown(m));
    if (at < 0) throw new Error(`tuple member ${shown(m)} is not in the corpus`);
    return at;
  });
  return [
    { name: "binary", collations: ["BINARY"], declared: "column" },
    { name: "nocase", collations: ["NOCASE"], declared: "column" },
    { name: "rtrim", collations: ["RTRIM"], declared: "column" },
    { name: "nocase_binary", collations: ["NOCASE", "BINARY"], declared: "index", members },
    { name: "rtrim_nocase", collations: ["RTRIM", "NOCASE"], declared: "column", members },
    { name: "binary_rtrim", collations: ["BINARY", "RTRIM"], declared: "index", members },
  ];
}

/** SQLite の答えの、それ自身の中での食い違い (UNIQUE の index と `=` が違う類を作る)。キーの関数に依らない。 */
export function selfProblems(e: string, s: Setup, c: Classes, values: Value[]): string[] {
  const out: string[] = [];
  const show = (id: number) => `#${id} (${c.tuples.find((t) => t.id === id)!.members.map((m) => shown(values[m]!)).join(", ")})`;
  for (const t of c.tuples) {
    const rep = c.rep.get(t.id) ?? null;
    const hasNull = t.members.some((m) => values[m] === null);
    if (c.survivors.has(t.id)) {
      if (!(hasNull ? rep === null : rep === t.id)) out.push(`${e} ${s.name}: ${show(t.id)} was inserted, but = finds ${rep === null ? "nothing" : show(rep)}`);
    } else if (rep === null || rep >= t.id || !c.survivors.has(rep)) {
      out.push(`${e} ${s.name}: ${show(t.id)} was refused by the UNIQUE index, but = finds ${rep === null ? "nothing" : show(rep)}`);
    }
  }
  return out;
}

/**
 * キーの関数を、SQLite の答えと比べる。違いの説明を返す (空なら一致)。
 * 1 つ目は UNIQUE の index の類 (組ごとの、類の最初の組) で、2 つ目は `=` で等しい対の集まりである。
 */
export function judge(key: KeyFn, e: string, s: Setup, c: Classes, values: Value[], limit = 12): string[] {
  const out: string[] = [];
  const keys = new Map<number, string | null>();
  for (const t of c.tuples) keys.set(t.id, key(t.members.map((m) => values[m]!), s.collations));
  const show = (id: number) => `#${id} (${c.tuples.find((t) => t.id === id)!.members.map((m) => shown(values[m]!)).join(", ")})`;
  // キーの類の最初の組。
  const first = new Map<string, number>();
  const krep = new Map<number, number>();
  for (const t of c.tuples) {
    const k = keys.get(t.id)!;
    if (k === null) krep.set(t.id, t.id);
    else {
      if (!first.has(k)) first.set(k, t.id);
      krep.set(t.id, first.get(k)!);
    }
  }
  let index = 0;
  for (const t of c.tuples) {
    const srep = c.survivors.has(t.id) ? t.id : c.rep.get(t.id) ?? t.id;
    const k = krep.get(t.id)!;
    if (srep === k) continue;
    if (index++ < limit) {
      out.push(srep === t.id
        ? `${e} ${s.name}: the UNIQUE index inserted ${show(t.id)}, but the key is the one of ${show(k)}`
        : k === t.id
          ? `${e} ${s.name}: the UNIQUE index refused ${show(t.id)} as equal to ${show(srep)}, but the keys differ`
          : `${e} ${s.name}: the UNIQUE index put ${show(t.id)} with ${show(srep)}, but the key puts it with ${show(k)}`);
    }
  }
  if (index > limit) out.push(`${e} ${s.name}: ${index - limit} more tuples in the wrong class`);
  // `=` の対と、キーの等しい対。
  const byKey = new Map<string, number[]>();
  for (const t of c.tuples) {
    const k = keys.get(t.id)!;
    if (k !== null) byKey.set(k, [...(byKey.get(k) ?? []), t.id]);
  }
  const keyPairs = new Set<string>();
  for (const ids of byKey.values()) for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) keyPairs.add(pairKey(ids[a]!, ids[b]!));
  let pairs = 0;
  for (const p of c.pairs) {
    if (keyPairs.has(p)) continue;
    const [a, b] = p.split(",").map(Number) as [number, number];
    if (pairs++ < limit) out.push(`${e} ${s.name}: = says ${show(a)} and ${show(b)} are equal, but the keys differ`);
  }
  for (const p of keyPairs) {
    if (c.pairs.has(p)) continue;
    const [a, b] = p.split(",").map(Number) as [number, number];
    if (pairs++ < limit) out.push(`${e} ${s.name}: the keys of ${show(a)} and ${show(b)} are equal, but = says they differ`);
  }
  if (pairs > limit) out.push(`${e} ${s.name}: ${pairs - limit} more pairs that disagree`);
  return out;
}

/** 2 つのエンジンの答えの違い。同じ値と場面なら、同じ類を作るはずである。 */
export function engineDifferences(a: string, ca: Classes, b: string, cb: Classes, s: Setup): string[] {
  const out: string[] = [];
  const survivors = (x: Classes) => [...x.survivors].sort((p, q) => p - q).join(" ");
  if (survivors(ca) !== survivors(cb)) out.push(`${s.name}: ${a} and ${b} keep different rows under the UNIQUE index`);
  const reps = (x: Classes) => [...x.rep.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
  if (reps(ca) !== reps(cb)) out.push(`${s.name}: ${a} and ${b} find different representatives with =`);
  const pairs = (x: Classes) => [...x.pairs].sort().join(" ");
  if (pairs(ca) !== pairs(cb)) out.push(`${s.name}: ${a} and ${b} find different equal pairs with =`);
  return out;
}

/** 1 つのエンジンで、値を入れ、全部の場面の答えを読む。 */
export async function collect(e: Engine, values: Value[]): Promise<{ loaded: string[]; classes: Map<string, Classes>; self: string[] }> {
  await e.run(loadSql(values));
  const loaded = await checkLoaded(e, values);
  const classes = new Map<string, Classes>();
  const self: string[] = [];
  for (const s of setups(values)) {
    const c = await sqliteClasses(e, s, values);
    classes.set(s.name, c);
    self.push(...selfProblems(e.name, s, c, values));
  }
  return { loaded, classes, self };
}

/** キーの関数を、全部の場面で比べる。 */
export function judgeAll(key: KeyFn, e: string, classes: Map<string, Classes>, values: Value[]): string[] {
  return setups(values).flatMap((s) => judge(key, e, s, classes.get(s.name)!, values));
}
