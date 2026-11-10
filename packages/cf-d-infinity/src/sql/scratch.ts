// Worker の中の SQLite。シャードと同じエンジンで元の SQL を実行するので、式の意味を再実装せずに済む。
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { Catalog } from "../meta";
import type { Backend, Row, Value } from "../types";

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

export class ScratchDb implements Backend {
  constructor(private db: Database) {}
  iterate(sql: string, ...params: Value[]): { columns: string[]; rows: Iterable<Value[]> } {
    const { columns, values } = this.raw(sql, ...params);
    return { columns, rows: values };
  }
  raw(sql: string, ...params: Value[]): { columns: string[]; values: Value[][] } {
    const st = this.db.prepare(sql);
    try {
      st.bind(params as never);
      const columns = st.getColumnNames();
      const values: Value[][] = [];
      while (st.step()) values.push(st.get() as Value[]);
      return { columns, values };
    } finally {
      st.free();
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
    const roots = new Map<number, string>();
    for (const r of this.exec(`SELECT rootpage, tbl_name FROM sqlite_master WHERE rootpage > 0`)) {
      roots.set(r.rootpage as number, r.tbl_name as string);
    }
    const out = new Set<string>();
    for (const op of this.exec(`EXPLAIN ${sql}`)) {
      if (op.opcode === "OpenRead" || op.opcode === "OpenWrite") {
        const t = roots.get(op.p2 as number);
        if (t && !t.startsWith("sqlite_")) out.add(t);
      }
    }
    return [...out];
  }

  /** 行をまとめて投入する。1 回の取引で流すと 10 万行で 100 ms 前後である。 */
  load(table: string, columns: string[], rows: Value[][]): void {
    if (rows.length === 0) return;
    const list = columns.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ");
    const st = this.db.prepare(`INSERT INTO "${table}" (${list}) VALUES (${columns.map(() => "?").join(", ")})`);
    this.db.run("BEGIN");
    try {
      for (const r of rows) st.run(r as never);
      this.db.run("COMMIT");
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
