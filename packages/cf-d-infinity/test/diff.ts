// 本物の SQLite と同じ文を流して 1 文ずつ比べる。
import { DatabaseSync } from "node:sqlite";
import { Db } from "../src/client/db";
import { SimCluster } from "./sim";

interface Out {
  columns: string[];
  values: unknown[][];
  error: boolean;
  message?: string;
}

const real = (db: DatabaseSync, sql: string): Out => {
  try {
    const st = db.prepare(sql);
    const columns = st.columns().map((c) => c.name);
    if (columns.length === 0) {
      st.run();
      return { columns, values: [], error: false };
    }
    st.setReturnArrays(true);
    return { columns, values: st.all() as unknown as unknown[][], error: false };
  } catch (e) {
    return { columns: [], values: [], error: true, message: (e as Error).message };
  }
};

const ours = async (db: Db, sql: string): Promise<Out> => {
  try {
    const r = await db.query(sql);
    return { columns: r.columns, values: r.values, error: false };
  } catch (e) {
    return { columns: [], values: [], error: true, message: (e as Error).message };
  }
};

const norm = (v: unknown[][], sorted: boolean) => {
  const rows = v.map((r) => JSON.stringify(r, (_k, x) => (x instanceof Uint8Array ? [...x] : x)));
  return sorted ? rows : [...rows].sort();
};

export async function diff(script: string, shards = 4, dumps: string[] = [], unsupported?: string[]): Promise<string[]> {
  const sqlite = new DatabaseSync(":memory:");
  const c = new SimCluster({ shards });
  const db = new Db(c, { idBlock: 1000 });
  const problems: string[] = [];
  const trail: string[] = [];
  for (const raw of script.split(/;\s*\n/)) {
    const sql = raw.replace(/^\s*--.*$/gm, "").trim();
    if (!sql) continue;
    const b = await ours(db, sql);
    // 対応していない文は断ることにしている。断った文は SQLite でも実行しないで、両方を同じ状態のまま先へ進める。
    // 約束は「SQLite と同じ答えを返すか、unsupported で断るか」である。
    if (b.error && /^unsupported:/.test(b.message ?? "")) {
      unsupported?.push(sql);
      continue;
    }
    const a = real(sqlite, sql);
    trail.push(`${sql.slice(0, 60)}${a.error ? " [E]" : ""}${b.error ? ` [e:${b.message?.slice(0, 30)}]` : ""}`);
    await c.settle();
    if (a.error !== b.error) {
      problems.push(`${sql}\n  sqlite: ${a.error ? `ERROR ${a.message}` : JSON.stringify(a.values).slice(0, 120)}\n  ours:   ${b.error ? `ERROR ${b.message}` : JSON.stringify(b.values).slice(0, 120)}`);
      continue;
    }
    if (a.error) continue;
    if (dumps.length) {
      // 書き込みの度に全表を比べて、最初に分かれた文を見つける。値は quote() で比べる。JS の値では、INTEGER の 2 と REAL の
      // 2.0 が同じ数になり、格納の型の違いを見落とす (2026-11-13 の README の確認の指摘 R8)。
      for (const plain of dumps) {
        const cols = real(sqlite, `SELECT * FROM (${plain.replace(/\s+ORDER\s+BY[\s\S]*$/i, "")}) LIMIT 0`).columns;
        const d = cols.length ? plain.replace(/^\s*SELECT\s+[\s\S]*?\s+FROM\s/i, `SELECT ${cols.map((c) => `quote("${c.replaceAll('"', '""')}")`).join(", ")} FROM `) : plain;
        const inTx = db.inTransaction;
        const x = real(sqlite, d);
        const y = await ours(db, d);
        void inTx;
        if (JSON.stringify(x.values) !== JSON.stringify(y.values)) {
          problems.push(`TRAIL ${trail.slice(-7).join(" | ")}`);
          problems.push(`DIVERGED after: ${sql}\n  sqlite: ${JSON.stringify(x.values).slice(0, 300)}\n  ours:   ${JSON.stringify(y.values).slice(0, 300)}${y.error ? ` ERROR ${y.message}` : ""}`);
          return problems;
        }
      }
    }
    const ordered = /ORDER\s+BY/i.test(sql);
    if (a.columns.length && JSON.stringify(a.columns) !== JSON.stringify(b.columns)) {
      problems.push(`${sql}\n  columns sqlite: ${a.columns}\n  columns ours:   ${b.columns}`);
    }
    const x = norm(a.values, ordered);
    const y = norm(b.values, ordered);
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      problems.push(`${sql}\n  sqlite: ${x.slice(0, 6).join(" ")}\n  ours:   ${y.slice(0, 6).join(" ")}`);
    }
  }
  return problems;
}

