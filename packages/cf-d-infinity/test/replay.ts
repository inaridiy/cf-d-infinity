// 文を再生する検査。
//
// 並行に流した取引と文を、元の文と引数、返った結果、確定したかどうか、時刻と一緒に記録する。
// 確定した取引を確定の時刻の順に並べ、同じ文を 1 つの本物の SQLite で順に実行して、1 文ずつ結果を比べる。
// 結果が違えば、直列な実行と同じでない (取引の検証の誤り) か、文の意味が SQLite と違う (計画の誤り) かのどちらかである。
// 行イメージを再生するのではなく、文を再生する。行イメージの再生は、内部の辻褄しか確かめない。
//
// 読みについては、実時間の順序も確かめる。取引でない読みと、取引の最初の読みは、始まる前に確定した書き込みを見る約束である。
import { DatabaseSync } from "node:sqlite";
import type { Ts, Value } from "../src/types";

export interface StatementRecord {
  /** 文のひな形の名前。対応した形ごとに、成功した実行を数えるのに使う。 */
  shape: string;
  sql: string;
  params: Value[];
  /** 返った行。エラーなら error。 */
  values?: Value[][];
  error?: string;
  /** 文の後の、取引の読む時点。取引は読む時点を先へ進めることがある。食い違いを調べるときに見る。 */
  readAt?: Ts;
  /** 文を出した時点と、応答が返った時点の通し番号。 */
  span?: [number, number];
}

export interface TxnRecord {
  id: number;
  statements: StatementRecord[];
  outcome: "committed" | "aborted";
  /** 直列の順序での位置。書き込みのある取引は確定の時刻、読みだけなら読んだ時刻。 */
  at?: Ts;
  readOnly: boolean;
  /** 実時間の順序。要求を出した時点と、応答が返った時点の通し番号。 */
  start: number;
  end: number;
  /** 触ったシャード。実時間の順序は、同じシャードを触った取引の間でだけ約束されている。 */
  shards: Set<string>;
  /** 最初の文が触ったシャード。取引の読む時点は最初の読みで決まるので、約束が掛かるのはこのシャードである。 */
  firstShards?: Set<string>;
}

export interface ReplayReport {
  problems: string[];
  /** ひな形ごとの、確定した取引の中で成功した実行の数、エラーになった数、断られた数。 */
  coverage: Record<string, { ok: number; error: number; unsupported: number }>;
  committed: number;
  aborted: number;
}

const norm = (rows: unknown[][], ordered: boolean): string[] => {
  const out = rows.map((r) => JSON.stringify(r, (_k, x) => (x instanceof Uint8Array ? [...x] : x)));
  return ordered ? out : out.sort();
};

export function replay(ddl: string[], history: TxnRecord[]): ReplayReport {
  const problems: string[] = [];
  const coverage: ReplayReport["coverage"] = {};
  const count = (shape: string, k: "ok" | "error" | "unsupported") => {
    (coverage[shape] ??= { ok: 0, error: 0, unsupported: 0 })[k]++;
  };
  const lite = new DatabaseSync(":memory:");
  for (const s of ddl) lite.exec(s.replace(/\bSHARD\s+KEY\s*\([^)]*\)/i, ""));

  const done = history.filter((t) => t.outcome === "committed");
  for (const t of done) if (t.at === undefined) problems.push(`txn ${t.id}: committed without a timestamp (${t.statements.map((s) => s.shape).join(", ")})`);
  // 同じ時刻なら、書き込みが先、読みが後。読みは、その時刻までの確定を全部見る。
  const order = done.filter((t) => t.at !== undefined).sort((a, b) => a.at! - b.at! || Number(a.readOnly) - Number(b.readOnly) || a.id - b.id);

  for (const t of order) {
    lite.exec("BEGIN");
    for (const s of t.statements) {
      if (s.error !== undefined && /^unsupported:/.test(s.error)) {
        count(s.shape, "unsupported");
        continue;
      }
      let got: { values?: unknown[][]; error?: string };
      try {
        const st = lite.prepare(s.sql);
        if (st.columns().length === 0) {
          st.run(...(s.params as never[]));
          got = { values: [] };
        } else {
          st.setReturnArrays(true);
          got = { values: st.all(...(s.params as never[])) as unknown as unknown[][] };
        }
      } catch (e) {
        got = { error: (e as Error).message };
      }
      const where = `txn ${t.id} at ${t.at}: [${s.shape}] ${s.sql} ${JSON.stringify(s.params)}`;
      if ((s.error !== undefined) !== (got.error !== undefined)) {
        problems.push(`${where}\n  ours:   ${s.error !== undefined ? `ERROR ${s.error}` : JSON.stringify(s.values)}\n  sqlite: ${got.error !== undefined ? `ERROR ${got.error}` : JSON.stringify(got.values)}`);
      } else if (s.error === undefined) {
        const ordered = /\bORDER\s+BY\b/i.test(s.sql);
        const a = norm(s.values ?? [], ordered);
        const b = norm(got.values ?? [], ordered);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          // 前後の取引も出す。並べ方の誤りか、読みの誤りかを見分けるのに要る。
          const i = order.indexOf(t);
          const near = order.slice(Math.max(0, i - 6), i + 7).map((x) =>
            `    ${x === t ? ">" : " "} txn ${x.id} at ${x.at} ${x.readOnly ? "R" : "W"} [${x.start}..${x.end}] shards ${[...x.shards].sort().join(",")}: ${x.statements.map((y) => `${y.sql.slice(0, 70)} ${JSON.stringify(y.params)}${y.error ? " ERR" : ""}${y.readAt ? ` @${y.readAt}` : ""}${y.span ? ` [${y.span.join("..")}]` : ""}`).join(" ; ")}`);
          problems.push(`${where}\n  ours:   ${a.join(" ")}\n  sqlite: ${b.join(" ")}\n${near.join("\n")}`);
        }
      }
      count(s.shape, s.error === undefined ? "ok" : "error");
    }
    lite.exec("COMMIT");
  }

  // 実時間の順序。応答まで返った書き込みは、その後で始まった読みより前に並んでいなければならない。
  // シャードごとの時計で守る約束なので、同じシャードを触った取引の間でだけ確かめる。触ったシャードが重ならない書き込みは、
  // 読みの結果に関わらないので、時刻が前後していてもよい。
  const writes = order.filter((t) => !t.readOnly);
  for (const r of order.filter((t) => t.readOnly)) {
    const mine = r.firstShards ?? r.shards;
    const missed = writes.filter((w) => w.end < r.start && w.at! > r.at! && [...w.shards].some((id) => mine.has(id)));
    if (missed.length === 0) continue;
    // 時刻が前後していても、その書き込みが読みの結果に関わらなければ、約束は破れていない。
    // 見逃した書き込みを読みの直前へ移した順序で再生し、読みの結果が変わるかを見る。
    const alt = new DatabaseSync(":memory:");
    for (const d of ddl) alt.exec(d.replace(/\bSHARD\s+KEY\s*\([^)]*\)/i, ""));
    const run = (t: TxnRecord): string[] => t.statements.map((x) => {
      if (x.error !== undefined && /^unsupported:/.test(x.error)) return "skipped";
      try {
        const st = alt.prepare(x.sql);
        if (st.columns().length === 0) {
          st.run(...(x.params as never[]));
          return "[]";
        }
        st.setReturnArrays(true);
        return JSON.stringify(norm(st.all(...(x.params as never[])) as unknown as unknown[][], /\bORDER\s+BY\b/i.test(x.sql)));
      } catch {
        return "error";
      }
    });
    for (const t of order) {
      if (t === r) break;
      if (!missed.includes(t)) run(t);
    }
    for (const w of missed) run(w);
    const seen = run(r);
    const recorded = r.statements.map((x) => (x.error !== undefined ? (/^unsupported:/.test(x.error) ? "skipped" : "error") : JSON.stringify(norm(x.values ?? [], /\bORDER\s+BY\b/i.test(x.sql)))));
    if (JSON.stringify(seen) !== JSON.stringify(recorded)) {
      const show = (x: TxnRecord) => `txn ${x.id} at ${x.at} [${x.start}..${x.end}] shards ${[...x.shards].sort().join(",")}: ${x.statements.map((y) => `${y.sql.slice(0, 80)} ${JSON.stringify(y.params)}${y.error ? " ERR" : ""}`).join(" ; ")}`;
      problems.push(`a read started after a write was acknowledged, and its result does not include that write\n  read:  ${show(r)}\n  writes: ${missed.map(show).join("\n          ")}\n  with the writes visible the read returns ${seen.join(" ")}\n  it returned ${recorded.join(" ")}`);
    }
  }
  return { problems, coverage, committed: done.length, aborted: history.length - done.length };
}
