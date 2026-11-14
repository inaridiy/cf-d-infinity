// workerd と DO の SQLite の事実を確かめるための、小さな Worker (test/workerd-limits.test.ts が使う)。
//
// D∞ の Worker (src/worker.ts) は使わない。確かめたいのは土台の振る舞いで、D∞ がそれをどう包んでいるかではない。
// 渡された SQL と引数を DO の SQLite でそのまま実行し、結果の JS の型を isolate の中で見分けて返す。
// 試験との間は JSON なので、JSON が消す区別 (-0 と 0、number と bigint、BLOB) は、消える前に文字にしておく。
import { buildSync } from "esbuild";
import { Miniflare } from "miniflare";

/** 引数の書き方。JSON で運べない値を、isolate の中で作る。 */
export type Arg =
  | null
  | string
  /** JS の数。`String(x)` の表記で渡す ("-0"、"Infinity"、"NaN" も渡せる)。 */
  | { f: string }
  | { big: string }
  | { hex: string }
  /** 文字 c を n 回くり返した文字列。 */
  | { rep: [string, number] }
  /** 0 を n バイト並べた BLOB。 */
  | { zero: number };

export interface Step {
  sql: string;
  params?: Arg[];
  /** 値そのものではなく、型と長さだけを返す (大きな値を JSON で運ばない)。 */
  lengths?: boolean;
}

/** 結果の値。先頭が isolate の中での JS の型、次がその文字での表記である。 */
export type Cell = ["null"] | ["number" | "bigint" | "string" | "blob" | "other", string | number];

export interface StepResult {
  columns: string[];
  rows: Cell[][];
  rowsRead: number;
  rowsWritten: number;
  error?: string;
}

/** 型の親和性の変換を確かめる表。型の親和性ごとに 1 列ある。 */
export const CONV_DDL = "CREATE TABLE IF NOT EXISTS conv(id INTEGER PRIMARY KEY, t TEXT, n NUMERIC, i INTEGER, r REAL, b BLOB)";
export const CONV_COLUMNS = ["t", "n", "i", "r", "b"] as const;
/** 列に入った値を、型と、型ごとに元へ戻せる表記で読む式。TEXT は 16 進で読む (`quote()` は NUL で切る)。 */
const stored = (c: string) => `typeof(${c}) || ':' || CASE typeof(${c}) WHEN 'real' THEN quote(${c}) WHEN 'text' THEN hex(${c}) WHEN 'blob' THEN hex(${c}) ELSE ifnull(${c}, '') END`;
/**
 * 値 1 つを 5 つの列に入れ、入った値を読む文。node:sqlite、sql.js、DO で同じ文を使う。
 * REAL の値は `(CAST(?1 AS REAL)+0.0)` で包む。sql.js は 32 ビットに収まる整数の値の数を INTEGER として束縛するからである
 * (DO と node:sqlite では、包んでも値は変わらない)。
 */
export const convSql = (kind: "real" | "text") => {
  const v = kind === "real" ? "(CAST(?1 AS REAL)+0.0)" : "?1";
  return `INSERT OR REPLACE INTO conv(id, t, n, i, r, b) VALUES (1, ${v}, ${v}, ${v}, ${v}, ${v}) RETURNING ${CONV_COLUMNS.map(stored).join(", ")}`;
};

/**
 * キー文字列の関数 (src/keys.ts) を、workerd で動く 1 つのモジュールにまとめる。keyValues は、JSON.parse の reviver が元の文面を
 * 受け取ることに頼っている。同じ関数を workerd の V8 で動かして確かめる。
 */
function keysModule(): string {
  const out = buildSync({
    stdin: { contents: 'export { keyString, keyValues } from "./src/keys";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true, format: "esm", write: false, logLevel: "silent",
  });
  return out.outputFiles[0]!.text;
}

const SCRIPT = `
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { keyString, keyValues } from "./keys.js";
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const show = (v) => v === null ? ["null"] : typeof v === "bigint" ? ["bigint", String(v)]
  : typeof v === "number" ? ["number", Object.is(v, -0) ? "-0" : String(v)]
  : typeof v === "string" ? ["string", v]
  : v instanceof ArrayBuffer ? ["blob", hex(v)] : ["other", Object.prototype.toString.call(v)];
const size = (v) => v === null ? ["null"] : typeof v === "string" ? ["string", v.length] : v instanceof ArrayBuffer ? ["blob", v.byteLength] : [typeof v, String(v)];
const arg = (a) => a === null || typeof a === "string" ? a
  : "f" in a ? Number(a.f) : "big" in a ? BigInt(a.big) : "hex" in a ? unhex(a.hex) : "rep" in a ? a.rep[0].repeat(a.rep[1]) : new Uint8Array(a.zero);
const message = (e) => String((e && e.message) || e);
// 届いた値の型を、届いた側で見る。object の中の bigint も見分ける。
const seen = (v) => typeof v === "bigint" ? "bigint " + v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? "bigint " + x : x));

export class Probe extends DurableObject {
  run(steps) {
    const out = [];
    for (const s of steps) {
      try {
        const cur = this.ctx.storage.sql.exec(s.sql, ...(s.params ?? []).map(arg));
        const rows = [...cur.raw()].map((r) => r.map(s.lengths ? size : show));
        out.push({ columns: cur.columnNames, rows, rowsRead: cur.rowsRead, rowsWritten: cur.rowsWritten });
      } catch (e) {
        out.push({ columns: [], rows: [], rowsRead: 0, rowsWritten: 0, error: message(e) });
      }
    }
    return out;
  }
  convert(ddl, sql, values) {
    this.ctx.storage.sql.exec(ddl);
    return values.map((v) => [...this.ctx.storage.sql.exec(sql, v).raw()][0]);
  }
  echo(v) {
    return { seen: seen(v), back: v };
  }
}
export class Echo extends WorkerEntrypoint {
  echo(v) {
    return { seen: seen(v), back: v };
  }
}

const attempt = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return { error: message(e) };
  }
};
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const stub = env.PROBE.get(env.PROBE.idFromName(url.searchParams.get("o") ?? "a"));
    const body = await req.json();
    if (url.pathname === "/run") return Response.json(await stub.run(body));
    if (url.pathname === "/convert") return Response.json(await stub.convert(body.ddl, body.sql, body.values));
    if (url.pathname === "/reviver") {
      const sources = [];
      JSON.parse(body.text, function (k, v, context) {
        sources.push([k, typeof v, context === undefined ? "no context" : typeof context.source === "string" ? context.source : "no source"]);
        return v;
      });
      return Response.json(sources);
    }
    if (url.pathname === "/keys") {
      // キー文字列を値に戻し、戻した値の型と、もう一度書いたキー文字列を返す。
      return Response.json(body.map((key) => {
        const values = keyValues(key);
        return { types: values.map((v) => (v === null ? "null" : v instanceof Uint8Array ? "blob" : typeof v)), again: keyString(values) };
      }));
    }
    if (url.pathname === "/bigint") {
      const values = { top: 9223372036854775807n, nested: { a: [9223372036854775807n, -9223372036854775808n], b: new Uint8Array([1, 2]) } };
      const via = (target) => attempt(async () => {
        const top = await target.echo(values.top);
        const nested = await target.echo(values.nested);
        return { arrived: [top.seen, nested.seen], returned: [seen(top.back), seen(nested.back)], blob: Object.prototype.toString.call(nested.back.b) };
      });
      return Response.json({ durableObject: await via(stub), serviceBinding: await via(env.ECHO), structuredClone: await attempt(async () => seen(structuredClone(values))) });
    }
    return new Response("not found", { status: 404 });
  },
};
`;

export interface Probe {
  mf: Miniflare;
  /** 文を順に実行する。object を渡さなければ、呼び出しごとに新しい DO を使う。 */
  run(steps: Step[], object?: string): Promise<StepResult[]>;
  /** 値を 1 つずつ、型の親和性ごとの列に入れて読む。 */
  convert(kind: "real" | "text", values: (number | string)[]): Promise<string[][]>;
  /** JSON.parse の reviver が受け取った [キー, 値の型, 元の文面] の並び。 */
  reviver(text: string): Promise<[string, string, string][]>;
  /** キー文字列を、workerd の中の keyValues で値に戻す。戻した値の型と、keyString でもう一度書いた文字列を返す。 */
  keys(keys: string[]): Promise<{ types: string[]; again: string }[]>;
  /** BigInt を DO の RPC と Service Binding の RPC に通した結果。 */
  bigint(): Promise<Record<"durableObject" | "serviceBinding", { arrived: string[]; returned: string[]; blob: string; error?: string }> & { structuredClone: string }>;
}

export function probe(): Probe {
  const modules = [
    { type: "ESModule" as const, path: "probe.js", contents: SCRIPT },
    { type: "ESModule" as const, path: "keys.js", contents: keysModule() },
  ];
  const options = { modules, compatibilityDate: "2026-07-01" };
  const mf = new Miniflare({
    workers: [
      { name: "probe", ...options, durableObjects: { PROBE: { className: "Probe", useSQLite: true } }, serviceBindings: { ECHO: { name: "echo", entrypoint: "Echo" } } },
      // Service Binding の相手は、別の Worker にする。同じ Worker の中の呼び出しでは、境界を越えない。
      { name: "echo", ...options, durableObjects: { PROBE: { className: "Probe", useSQLite: true } } },
    ],
  });
  let n = 0;
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const r = await mf.dispatchFetch(`http://x${path}`, { method: "POST", body: JSON.stringify(body) });
    if (r.status !== 200) throw new Error(`probe ${path}: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };
  return {
    mf,
    run: (steps, object = `o${++n}`) => post(`/run?o=${object}`, steps),
    convert: async (kind, values) => {
      const object = `conv${++n}`;
      const out: string[][] = [];
      // 1 回の要求に全部は載せない。要求と応答の JSON が大きくなりすぎる。
      for (let i = 0; i < values.length; i += 4000) {
        out.push(...(await post<string[][]>(`/convert?o=${object}`, { ddl: CONV_DDL, sql: convSql(kind), values: values.slice(i, i + 4000) })));
      }
      return out;
    },
    reviver: (text) => post("/reviver", { text }),
    keys: (keys) => post("/keys", keys),
    bigint: () => post("/bigint", null),
  };
}
