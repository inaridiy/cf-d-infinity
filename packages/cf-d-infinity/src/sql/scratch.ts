// Worker の中の SQLite。シャードと同じエンジンで元の SQL を実行するので、式の意味を再実装せずに済む。
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { Catalog } from "../meta";
import { SqlError, type Backend, type Row, type Value } from "../types";
import { bindTyped, isIntegerValue, isReal, restoreColumns } from "../value";

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

function sqlJs(): Promise<SqlJsStatic> {
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
  );
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
}

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
  iterate(sql: string, ...params: Value[]): { columns: string[]; rows: Iterable<Value[]> } {
    const { columns, values } = this.raw(sql, ...params);
    return { columns, rows: values };
  }
  /**
   * 文を実行する。SQLite のエラー (構文、制約の違反) は SqlError にして投げる。
   * シャードで実行した文のエラーも SqlError で届くので、文がどちらで実行されたかで、エラーの型が変わらない。
   */
  raw(sql: string, ...params: Value[]): { columns: string[]; values: Value[][] } {
    let st: ReturnType<Database["prepare"]> | undefined;
    try {
      // sql.js は安全な整数を INTEGER として束縛する。整数の値の REAL は包む (src/value.ts)。
      const b = bindTyped(sql, params, "integer");
      st = this.db.prepare(b.sql);
      st.bind(b.params as never);
      const columns = restoreColumns(st.getColumnNames(), b.columns);
      const values: Value[][] = [];
      while (st.step()) values.push(st.get() as Value[]);
      return { columns, values };
    } catch (e) {
      throw e instanceof SqlError ? e : new SqlError(e instanceof Error ? e.message : String(e));
    } finally {
      st?.free();
    }
  }
  exec(sql: string, ...params: Value[]): Row[] {
    const { columns, values } = this.raw(sql, ...params);
    return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i] ?? null])));
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
   * 文が開く表と、文が表定義そのものを読むかどうか (metadata)。
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
    return { tables: [...out], read: [...read], metadata: schema || (virtual && /\bpragma_/i.test(identifierText(sql))) };
  }

  /** 行をまとめて投入する。1 回の取引で流すと 10 万行で 100 ms 前後である。 */
  load(table: string, columns: string[], rows: Value[][]): void {
    if (rows.length === 0) return;
    const list = columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ");
    const insert = `INSERT INTO "${table}" (${list}) VALUES (${columns.map(() => "?").join(", ")})`;
    const st = this.db.prepare(insert);
    this.db.run("BEGIN");
    try {
      // sql.js の束縛で型が変わる値 (整数の値の REAL と、32 ビットを超える整数) を含む行は、型を保つ束縛 (bindTyped) を通す。
      // ほかは用意した文で速く入れる。
      for (const r of rows) {
        if (r.some((v) => isReal(v) || (isIntegerValue(v) && (v | 0) !== v))) this.raw(insert, ...r);
        else st.run(r as never);
      }
      this.db.run("COMMIT");
    } catch (e) {
      // 集めた行が表の制約に反した (同じ UNIQUE の値の行が 2 つあるなど)。文のエラーと同じ型で返す。
      throw e instanceof SqlError ? e : new SqlError(e instanceof Error ? e.message : String(e));
    } finally {
      st.free();
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
