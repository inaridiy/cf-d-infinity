// 値の格納の型を、本物の SQLite と比べる生成器。計画書の不変条件 6 と 11 (未解決の問題 19 と 20 を見つけ、直したことを確かめる)。
//
// 型のある引数 (INTEGER は BigInt、REAL は数、TEXT、BLOB、NULL) と、型を揃えると変わる値 ('0x10'、' 12 '、'1e400'、
// 整数の値の REAL など) を、型の親和性の違う列とキーに入れ、typeof と値を読む文を、@libsql/client (Hrana) から流す。
// 基準は node:sqlite で、INTEGER を BigInt、REAL を数で束縛する。sqld が Hrana の integer と float を束縛するのと同じである。
// SQLite との差分テスト (test/diff.ts) は、引数を使わず、結果を JS の値で比べるので、型の違いを見ない。これはそれを見る。
// SQLite との比べ方は、基準経路だけの実行 (vitest.config.ts の reference-scans、reference-full) でも流す。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { clientOf } from "./libsql";
import { prng, seedsOr, SimCluster } from "./sim";

type Arg = null | bigint | number | string | Uint8Array;

const SCHEMA = [
  "CREATE TABLE tv(id INTEGER PRIMARY KEY, i INTEGER, r REAL, n NUMERIC, t TEXT, u)",
  "CREATE TABLE tk(k TEXT PRIMARY KEY, v)",
  "CREATE TABLE nk(k NUMERIC PRIMARY KEY, v)",
  "CREATE TABLE ik(k INT PRIMARY KEY, v)",
  "CREATE TABLE uk(k PRIMARY KEY, v)",
];

/** 型を揃えると変わる値を多めに混ぜた、型のある値。 */
function valueOf(r: () => number): Arg {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  switch (Math.floor(r() * 6)) {
    case 0: return pick([0n, 1n, 5n, -3n, 12n, 2n ** 40n, -(2n ** 53n) + 1n]);
    case 1: return pick([2.0, 5.0, 0.5, 2.5, -0.25, 0.1 + 0.2, 1e20, 123456789.123456789, 3.0e-7]);
    case 2: return pick(["5", " 12 ", "+5", ".5", "5.", "1e3", "0x10", "0b1", "1e400", "007", "3.0", "abc", "", "-"]);
    case 3: return pick([new Uint8Array([1, 2]), new Uint8Array([])]);
    case 4: return null;
    default: return pick([1n, 2n, 3n, 2.0, 3.0, "2", "3"]);
  }
}

interface Step { sql: string; args: Arg[] }

function script(seed: number, length: number): Step[] {
  const r = prng(seed);
  const n = (m: number) => Math.floor(r() * m);
  const pick = <T,>(xs: T[]) => xs[n(xs.length)]!;
  const v = () => valueOf(r);
  // 主キーの NULL は、断ると決めてある (unsupported。計画書の不変条件 6)。断った文は SQLite と状態が分かれるので、作らない。
  const vk = (): Arg => {
    for (;;) {
      const x = v();
      if (x !== null) return x;
    }
  };
  const keyTable = () => pick(["tk", "nk", "ik", "uk"]);
  let id = 0;
  const steps: Step[] = [];
  for (let i = 0; i < length; i++) {
    const s = pick<() => Step>([
      () => ({ sql: "INSERT INTO tv(id, i, r, n, t, u) VALUES (?, ?, ?, ?, ?, ?)", args: [BigInt(++id), v(), v(), v(), v(), v()] }),
      () => ({ sql: "INSERT INTO tv(id, i, r, n, t, u) VALUES (?, ?, ?, ?, ?, ?)", args: [BigInt(++id), v(), v(), v(), v(), v()] }),
      () => ({ sql: `INSERT INTO ${keyTable()}(k, v) VALUES (?, ?)`, args: [vk(), v()] }),
      () => ({ sql: `INSERT INTO ${keyTable()}(k, v) VALUES (?, ?)`, args: [vk(), v()] }),
      () => ({ sql: `UPDATE tv SET ${pick(["i", "r", "n", "t", "u"])} = ? WHERE id = ?`, args: [v(), BigInt(1 + n(Math.max(id, 1)))] }),
      // INSERT … SELECT は、SELECT の結果を Worker で引数に戻して入れ直す経路を通る (2026-11-13 の Codex の指摘 C6)。
      () => ({ sql: "INSERT INTO tv(id, i, r, n, t, u) SELECT ?, i, r, n, t, u FROM tv WHERE id = ?", args: [BigInt(++id), BigInt(1 + n(Math.max(id - 1, 1)))] }),
      () => ({ sql: "INSERT INTO tv(id, u, t) SELECT ?, ?, ?", args: [BigInt(++id), v(), v()] }),
      () => ({ sql: `INSERT INTO tv(id, u) VALUES (?, ${pick(["5.0", "2.0e0", "-0.0", "1e14", "7"])})`, args: [BigInt(++id)] }),
      () => ({ sql: `INSERT OR IGNORE INTO ${keyTable()}(k, v) SELECT u, r FROM tv WHERE id = ? AND u IS NOT NULL`, args: [BigInt(1 + n(Math.max(id, 1)))] }),
      // 計画の途中で値を読むか計算する経路: VALUES の中のサブクエリと、キーの式 (2026-11-13 の Codex の 2 回目の見直し、指摘 3)。
      () => ({ sql: `INSERT OR IGNORE INTO ${keyTable()}(k, v) VALUES (ifnull((SELECT ${pick(["5.0", "r", "u", "2.5", "7"])} FROM tv WHERE id = ?), 1.0), ?)`, args: [BigInt(1 + n(Math.max(id, 1))), v()] }),
      () => ({ sql: `INSERT OR IGNORE INTO ${keyTable()}(k, v) VALUES (CAST(? AS ${pick(["REAL", "INTEGER", "TEXT", "NUMERIC"])}), ?)`, args: [vk(), v()] }),
      // 主キーの NULL は断ると決めてあるので、サブクエリが行を返さないときは ifnull で値を入れる (上の vk と同じ理由)。
      () => ({ sql: "INSERT INTO tv(id, t, u, n) VALUES (?, (SELECT r FROM tv WHERE id = ?), (SELECT r FROM tv WHERE id = ?), (SELECT 3.0))", args: [BigInt(++id), BigInt(1 + n(Math.max(id - 1, 1))), BigInt(1 + n(Math.max(id - 1, 1)))] }),
      () => ({ sql: "SELECT id, typeof(i), i, typeof(r), r, typeof(n), n, typeof(t), t, typeof(u), u FROM tv WHERE id = ?", args: [BigInt(1 + n(Math.max(id, 1)))] }),
      () => ({ sql: "SELECT id, typeof(u), u, typeof(n), n FROM tv WHERE id >= ? ORDER BY id", args: [BigInt(1 + n(Math.max(id, 1)))] }),
      () => ({ sql: "SELECT id, typeof(u), u, u || '', typeof(t), t FROM tv ORDER BY id", args: [] }),
      () => ({ sql: `SELECT typeof(k), k, v FROM ${keyTable()} WHERE k = ?`, args: [v()] }),
      () => ({ sql: `SELECT typeof(k), k, typeof(v), v FROM ${keyTable()} ORDER BY k`, args: [] }),
      () => ({ sql: "SELECT ? / 2 AS x, typeof(?) AS t", args: [v(), v()] }),
      () => ({ sql: "SELECT ? / 2 AS x, typeof(?) AS t, i * ? AS m FROM tv WHERE id = 1", args: [v(), v(), v()] }),
      () => ({ sql: "SELECT typeof(sum(u)), sum(u), total(r), count(*) FROM tv", args: [] }),
      () => ({ sql: "SELECT typeof(u), count(*) FROM tv GROUP BY typeof(u) ORDER BY 1", args: [] }),
      () => ({ sql: "SELECT id, typeof(u), row_number() OVER (ORDER BY id) FROM tv ORDER BY id", args: [] }),
    ])();
    steps.push(s);
  }
  return steps;
}

const show = (rows: unknown[]) => JSON.stringify(rows, (_k, x) =>
  x instanceof Uint8Array ? { blob: [...x] } : x instanceof ArrayBuffer ? { blob: [...new Uint8Array(x)] } : typeof x === "bigint" ? Number(x)
    : typeof x === "number" && !Number.isFinite(x) ? `${x}` : x);

async function run(seed: number, shards: number): Promise<string[]> {
  const lite = new DatabaseSync(":memory:");
  const c = new SimCluster({ shards });
  const client = clientOf(c);
  for (const s of SCHEMA) {
    lite.exec(s);
    await client.execute(s);
  }
  const problems: string[] = [];
  for (const step of script(seed, 40)) {
    let want: string;
    try {
      const st = lite.prepare(step.sql);
      // 2^53 を超える INTEGER は、DO と同じく精度を落とした数で比べる (node:sqlite は既定では例外を投げる)。
      st.setReadBigInts(true);
      want = st.columns().length ? show(st.all(...(step.args as never[])).map((r) => Object.values(r))) : (st.run(...(step.args as never[])), "ok");
    } catch (e) {
      want = "error";
    }
    let got: string;
    try {
      const res = await client.execute({ sql: step.sql, args: step.args as never });
      got = res.columns.length ? show(res.rows.map((r) => res.columns.map((_c, i) => r[i]))) : "ok";
    } catch (e) {
      got = /unsupported:/.test(String(e)) ? `unsupported ${(e as Error).message.slice(0, 160)}` : `error`;
      if (got === "error" && want !== "error") got = `error ${(e as Error).message.slice(0, 120)}`;
    }
    // Hrana は値を JSON で運ぶので、REAL の無限大を運べない (sqld も同じ)。クライアントの誤りになるのを、正しいとする。
    if (/"-?Infinity"/.test(want) && /HRANA_PROTO_ERROR/.test(got)) continue;
    if (got !== want) problems.push(`${step.sql} ${show(step.args)}\n  sqlite: ${want.slice(0, 200)}\n  ours:   ${got.slice(0, 200)}`);
  }
  return problems;
}

describe("value types against SQLite through Hrana", () => {
  for (const seed of seedsOr([1, 2, 3, 4, 5, 6, 7, 8])) {
    it(`seed ${seed}`, async () => {
      const problems = await run(seed, 1 + (seed % 4));
      expect(problems.slice(0, 5)).toEqual([]);
    });
  }
});
