// Worker の中の SQLite。シャードと同じエンジンで元の SQL を実行するので、式の意味を再実装せずに済む。
import initSqlJs, { type Database, type SqlJsStatic, type Statement } from "sql.js";
import type { Catalog } from "../meta";
import { SqlError, type Backend, type Plain, type PlainRow, type Value } from "../types";
import { bindPlain, bindTyped, decodeScratch, restoreColumns, scratchElemSql, typedReadSql } from "../value";
import { initStoredValue } from "./stored";

// Emscripten の glue が self.location を参照する。Workers にはないので補う。
if (typeof globalThis.location === "undefined") {
  (globalThis as unknown as { location: { href: string } }).location = { href: "http://worker/" };
}

let wasmModule: WebAssembly.Module | null = null;
let engine: Promise<SqlJsStatic> | null = null;

/** Workers では wasm を実行時に生成できないので、バンドルしたモジュールを渡す。 */
export function setSqlWasm(mod: WebAssembly.Module): void {
  wasmModule = mod;
}

/**
 * sql.js を初期化する。isolate に 1 度だけである。型の親和性の変換 (src/sql/stored.ts の storedValue) の SQLite も、同じ engine で
 * ここで開く。文を計画する前に、Db がこれを待つ (src/client/db.ts の runPlanned)。
 */
export function sqlJs(): Promise<SqlJsStatic> {
  engine ??= initSqlJs(
    wasmModule
      ? {
          instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) {
            const inst = new WebAssembly.Instance(wasmModule!, imports);
            done(inst);
            return inst.exports;
          },
        } as never
      : undefined,
  ).then(async (SQL) => {
    await initStoredValue(SQL);
    return SQL;
  });
  return engine;
}

/** 文を SQLite がコンパイルした結果から読み取ったこと。 */
export interface Compiled {
  /** 文が開く表。読むだけの表も、書く表も入る。 */
  tables: string[];
  /**
   * 文が読むために開く表。INSERT ... VALUES の挿入先のように、書くためにだけ開く表は入らない。
   * 行を集めるときは、こちらを見る。挿入先の表を全部集める必要はない (衝突し得る行は、実行した後で探して集める)。
   */
  read: string[];
  /** 文が表定義そのものを読む。 */
  metadata: boolean;
  /** 結果の列名。SQLite が文を用意したときに付けた名前である。シャードへ送る読みの ExecReq.columns に使う。 */
  columns: string[];
}

/** 結果を返す文 (SELECT、VALUES、WITH で始まる文) か。型つきの読みに包めるのは、この形の文だけである。 */
export const readsRows = (sql: string): boolean => /^\s*(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*(SELECT|VALUES|WITH)\b/i.test(sql);

/**
 * 文から、文字列の literal と注釈を除き、識別子を残した文面。引用した識別子 ("..."、`...`、[...]) は中身を残す。
 * 表定義を読む PRAGMA の関数の名前を探すのに使う。正規表現で文字列と注釈を順に消すと、`/* ' *\/ ... /* ' *\/` のように
 * 2 つを重ねた書き方で、間の名前を文字列と取り違えて見落とす (2026-11-12 の入口の安全の確認、指摘 3)。
 */
export function identifierText(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
    } else if (c === '"' || c === "`") {
      let id = "";
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            id += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        id += sql[i];
        i++;
      }
      out += ` ${id} `;
    } else if (c === "[") {
      const j = sql.indexOf("]", i + 1);
      out += ` ${j < 0 ? sql.slice(i + 1) : sql.slice(i + 1, j)} `;
      i = j < 0 ? n : j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const j = sql.indexOf("\n", i + 2);
      i = j < 0 ? n : j + 1;
      out += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export class ScratchDb implements Backend {
  constructor(private db: Database) {}

  /**
   * 文を用意して、束縛して、行を読む。SQLite のエラー (構文、制約の違反) は SqlError にして投げる。
   * シャードで実行した文のエラーも SqlError で届くので、文がどちらで実行されたかで、エラーの型が変わらない。
   */
  private run<T>(sql: string, params: Plain[], columns: Map<string, string> | null, read: (st: Statement) => T): { columns: string[]; out: T } {
    let st: Statement | undefined;
    try {
      st = this.db.prepare(sql);
      st.bind(params as never);
      return { columns: restoreColumns(st.getColumnNames(), columns), out: read(st) };
    } catch (e) {
      throw e instanceof SqlError ? e : new SqlError(e instanceof Error ? e.message : String(e));
    } finally {
      st?.free();
    }
  }

  private rows(b: { sql: string; params: Plain[]; columns: Map<string, string> | null }, bigints = false): { columns: string[]; values: Plain[][] } {
    const { columns, out } = this.run(b.sql, b.params, b.columns, (st) => {
      const values: Plain[][] = [];
      // sql.js の型定義は get の 2 つ目の引数 (useBigInt) を持たない。
      const get = st as unknown as { get(params: null, config?: { useBigInt: boolean }): Plain[] };
      while (st.step()) values.push(get.get(null, bigints ? { useBigInt: true } : undefined));
      return values;
    });
    return { columns, values: out };
  }

  // 内部の入口。sql.js は、32 ビットに収まる整数の値の数を INTEGER として束縛する。ほかの整数の値は包む (src/value.ts の bindPlain)。
  iterate(sql: string, ...params: Plain[]): { columns: string[]; rows: Iterable<Plain[]> } {
    const { columns, values } = this.raw(sql, ...params);
    return { columns, rows: values };
  }
  raw(sql: string, ...params: Plain[]): { columns: string[]; values: Plain[][] } {
    return this.rows(bindPlain(sql, params, "integer"));
  }
  exec(sql: string, ...params: Plain[]): PlainRow[] {
    const { columns, values } = this.raw(sql, ...params);
    return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i] ?? null])));
  }
  /** 利用者の表に触る文 (Backend.query)。値を型ごと束縛し、ドライバの値を返す。 */
  query(sql: string, params: readonly Value[]): { columns: string[]; rows: Iterable<Plain[]> } {
    const { columns, values } = this.rows(bindTyped(sql, params, "integer"));
    return { columns, rows: values };
  }

  /**
   * 結果を返す文を、型ごと正確に読む (docs/design-values.md の「Worker の SQLite」)。文を型つきの読みに包み、TEXT を BLOB で
   * 運び、`useBigInt` で読む (src/value.ts の scratchElemSql)。sql.js のドライバは結果の TEXT を最初の NUL で切るので、素の列では
   * 読まない。結果の列の数と名前は、包む前の文を用意して取る。
   */
  select(sql: string, params: readonly Value[]): { columns: string[]; values: Value[][] } {
    const b = bindTyped(sql, params, "integer");
    const { columns } = this.run(b.sql, [], b.columns, () => null);
    const wrapped = typedReadSql(b.sql, columns.length, scratchElemSql);
    const { values } = this.rows({ sql: wrapped, params: b.params, columns: null }, true);
    return { columns, values: values.map((r) => r.map(decodeScratch)) };
  }

  /**
   * 包めない文 (PRAGMA、EXPLAIN) の結果を読む。INTEGER は `useBigInt` で bigint、REAL は number で読む。TEXT は素の列で読むので、
   * NUL を含む TEXT は切れる。表定義の名前と型の文字列だけを返す文に使う。
   */
  pragma(sql: string, params: readonly Value[]): { columns: string[]; values: Value[][] } {
    return this.rows(bindTyped(sql, params, "integer"), true) as { columns: string[]; values: Value[][] };
  }

  tx<T>(fn: () => T): T {
    this.db.run("SAVEPOINT s");
    try {
      const out = fn();
      this.db.run("RELEASE s");
      return out;
    } catch (e) {
      this.db.run("ROLLBACK TO s");
      this.db.run("RELEASE s");
      throw e;
    }
  }
  async sync(): Promise<void> {}
  size(): number {
    return 0;
  }
  /**
   * 文が実際に開く表を本物のプランナに尋ねる。
   * 手書きの解析が表の参照を見落とすと、空の表として黙って誤った結果を返すので、実行の前に必ず照合する。
   */
  tablesUsed(sql: string): string[] {
    return this.reads(sql).tables;
  }

  /**
   * 文が開く表と、文が表定義そのものを読むかどうか (metadata)、結果の列名。
   *
   * 表定義を読む文は、`sqlite_master` (どの名前で呼んでも、開くのはルートページ 1 である) を読む文と、`pragma_table_info(...)` の
   * ような PRAGMA の関数を FROM に置く文である。ここには利用者の表しかないので、ここで実行すれば利用者の表定義について答える。
   * 同じ文をシャードで実行すると、シャードの内部の表について答えてしまう。呼び出し側は、metadata の文をシャードへ送らない。
   * PRAGMA の関数は仮想表として開かれる。`json_each` なども仮想表なので、仮想表を開き、かつ文面に `pragma_` で始まる
   * 名前があるときに、表定義を読む文として扱う。
   */
  reads(sql: string): Compiled {
    const roots = new Map<number, string>();
    for (const r of this.exec(`SELECT rootpage, tbl_name FROM sqlite_master WHERE rootpage > 0`)) {
      roots.set(r.rootpage as number, r.tbl_name as string);
    }
    const out = new Set<string>();
    const read = new Set<string>();
    let schema = false;
    let virtual = false;
    for (const op of this.exec(`EXPLAIN ${sql}`)) {
      if (op.opcode === "OpenRead" || op.opcode === "OpenWrite") {
        if (op.p2 === 1) schema = true;
        const t = roots.get(op.p2 as number);
        if (t && !t.startsWith("sqlite_")) {
          out.add(t);
          if (op.opcode === "OpenRead") read.add(t);
        }
      } else if (op.opcode === "VOpen") virtual = true;
    }
    const { columns } = this.run(sql, [], null, () => null);
    return { tables: [...out], read: [...read], metadata: schema || (virtual && /\bpragma_/i.test(identifierText(sql))), columns };
  }

  /**
   * 行をまとめて投入する。1 回の取引で流すと 10 万行で 100 ms 前後である。
   * 値は型ごと束縛する。sql.js の束縛で型が変わる値 (32 ビットを超える INTEGER と、整数の値の REAL) は包むので、包む引数の並び
   * (bindTyped の書き換え) ごとに、用意した文を覚えて使い回す。
   */
  load(table: string, columns: string[], rows: Value[][]): void {
    if (rows.length === 0) return;
    const list = columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ");
    const insert = `INSERT INTO "${table}" (${list}) VALUES (${columns.map(() => "?").join(", ")})`;
    const prepared = new Map<string, Statement>();
    this.db.run("SAVEPOINT load");
    try {
      for (const r of rows) {
        const b = bindTyped(insert, r, "integer");
        let st = prepared.get(b.sql);
        if (!st) prepared.set(b.sql, (st = this.db.prepare(b.sql)));
        st.run(b.params as never);
      }
      this.db.run("RELEASE load");
    } catch (e) {
      this.db.run("ROLLBACK TO load");
      this.db.run("RELEASE load");
      // 集めた行が表の制約に反した (同じ UNIQUE の値の行が 2 つあるなど)。文のエラーと同じ型で返す。
      throw e instanceof SqlError ? e : new SqlError(e instanceof Error ? e.message : String(e));
    } finally {
      for (const st of prepared.values()) st.free();
    }
  }
  close(): void {
    this.db.close();
  }
}

// DDL の履歴を再生した空のデータベース。毎回そこから開く。
// 履歴の内容をキーにする。版番号だけだと同じ isolate の別クラスタと混ざるからである。
const bases = new Map<string, Uint8Array>();

export async function openScratch(cat: Pick<Catalog, "ddl">): Promise<ScratchDb> {
  const SQL = await sqlJs();
  const key = cat.ddl.join("\0");
  let bytes = bases.get(key);
  if (!bytes) {
    const db = new SQL.Database();
    for (const stmt of cat.ddl) db.run(stmt);
    bytes = db.export();
    db.close();
    if (bases.size >= 8) bases.delete(bases.keys().next().value!);
    bases.set(key, bytes);
  }
  return new ScratchDb(new SQL.Database(bytes));
}
