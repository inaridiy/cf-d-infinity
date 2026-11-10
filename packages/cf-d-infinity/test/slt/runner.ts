// sqllogictest の実行器。SQLite 自身の適合試験で、結果の値まで突き合わせる。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface Engine {
  run(sql: string): Promise<{ values: unknown[][] }>;
}

export interface Report {
  statements: number;
  statementFailures: number;
  queries: number;
  passed: number;
  failed: number;
  errors: Map<string, number>;
  samples: { sql: string; why: string }[];
}

function format(v: unknown, type: string): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Uint8Array) return "(blob)";
  if (type === "I") {
    const n = typeof v === "number" ? v : Number.parseFloat(String(v));
    return Number.isFinite(n) ? String(Math.trunc(n)) : "0";
  }
  if (type === "R") {
    const n = typeof v === "number" ? v : Number.parseFloat(String(v));
    return Number.isFinite(n) ? n.toFixed(3) : "0.000";
  }
  const s = String(v);
  return s === "" ? "(empty)" : [...s].map((c) => (c < " " || c > "~" ? "@" : c)).join("");
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function runSlt(path: string, engine: Engine, opts: { limit?: number; onlyQueries?: boolean } = {}): Promise<Report> {
  const lines = readFileSync(path, "utf8").split("\n");
  const report: Report = { statements: 0, statementFailures: 0, queries: 0, passed: 0, failed: 0, errors: new Map(), samples: [] };
  const fail = (sql: string, why: string) => {
    const key = why.replace(/\d+/g, "N").slice(0, 70);
    report.errors.set(key, (report.errors.get(key) ?? 0) + 1);
    if (report.samples.length < 12) report.samples.push({ sql: sql.slice(0, 200), why: why.slice(0, 160) });
  };
  let i = 0;
  let skip = false;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    i++;
    if (line === "" || line.startsWith("#")) continue;
    const [kw, ...rest] = line.split(/\s+/);
    if (kw === "hash-threshold") continue;
    if (kw === "halt") {
      // `onlyif mssql` の次の halt は他のエンジン向けで、ここでは止まらない。
      if (skip) {
        skip = false;
        continue;
      }
      break;
    }
    if (kw === "skipif") {
      if (rest[0] === "sqlite") skip = true;
      continue;
    }
    if (kw === "onlyif") {
      if (rest[0] !== "sqlite") skip = true;
      continue;
    }
    if (kw === "statement") {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "") body.push(lines[i++]!);
      const sql = body.join("\n");
      if (skip) {
        skip = false;
        continue;
      }
      report.statements++;
      const expectOk = rest[0] === "ok";
      try {
        await engine.run(sql);
        if (!expectOk) {
          report.statementFailures++;
          fail(sql, "statement should have failed");
        }
      } catch (e) {
        if (expectOk) {
          report.statementFailures++;
          fail(sql, `statement: ${(e as Error).message}`);
        }
      }
      continue;
    }
    if (kw === "query") {
      const types = rest[0]!;
      const sort = rest[1] ?? "nosort";
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "----" && lines[i]!.trim() !== "") body.push(lines[i++]!);
      const sql = body.join("\n");
      const expected: string[] = [];
      if (lines[i]?.trim() === "----") {
        i++;
        while (i < lines.length && lines[i]!.trim() !== "") expected.push(lines[i++]!.trim());
      }
      if (skip) {
        skip = false;
        continue;
      }
      if (opts.limit !== undefined && report.queries >= opts.limit) continue;
      report.queries++;
      try {
        const { values } = await engine.run(sql);
        const width = types.length;
        let rows = values.map((r) => r.map((v, c) => format(v, types[c] ?? "T")));
        if (sort === "rowsort") rows = rows.sort((a, b) => compare(a.join("\0"), b.join("\0")));
        let flat = rows.flat();
        if (sort === "valuesort") flat = [...flat].sort(compare);
        const m = expected.length === 1 ? /^(\d+) values hashing to ([0-9a-f]+)$/.exec(expected[0]!) : null;
        let ok: boolean;
        if (m) {
          const hash = createHash("md5").update(flat.map((v) => `${v}\n`).join("")).digest("hex");
          ok = Number(m[1]) === flat.length && hash === m[2];
        } else ok = JSON.stringify(flat) === JSON.stringify(expected);
        void width;
        if (ok) report.passed++;
        else {
          report.failed++;
          fail(sql, `mismatch: got ${flat.length} values ${flat.slice(0, 6).join(",")}`);
        }
      } catch (e) {
        report.failed++;
        fail(sql, `error: ${(e as Error).message}`);
      }
      continue;
    }
  }
  return report;
}
