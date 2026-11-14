// どの試験にも掛かる検査。シミュレータのシャードが実行した文のうち、宣言した範囲 (span) の外の行に依存したものがあれば、
// その試験を失敗にする。範囲の外の行は、intent の決着も commit の検証も受けないので、取引の検証が成り立たない。
// 文の形ごとに範囲の作り方を確かめる代わりに、実行された文のすべてをこれで確かめる。
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, beforeAll, beforeEach, expect } from "vitest";
import { spanFaults } from "../src/client/spans";
import { parseObserver } from "../src/sql/cst";
import { openScratch } from "../src/sql/scratch";
import { allSpanEscapes, injectedFault, tracedNets } from "./sim";

// PARSER_CORPUS=<ディレクトリ> を付けて流すと、試験が解析に渡した文を、プロセスごとの 1 行 1 文の JSON のファイルに書き出す。
// パーサの突き合わせ (test/parser-oracle.test.ts) が、これを文の集まりとして読む。同じ文は、プロセスの中で 1 度だけ書く。
if (process.env.PARSER_CORPUS && !parseObserver.seen) {
  const dir = process.env.PARSER_CORPUS;
  mkdirSync(dir, { recursive: true });
  const seen = new Set<string>();
  parseObserver.seen = (source) => {
    if (seen.has(source)) return;
    seen.add(source);
    appendFileSync(`${dir}/${process.pid}.jsonl`, `${JSON.stringify(source)}\n`);
  };
}

// Worker の SQLite (sql.js) の初期化は、本物の非同期の入出力である。試験の途中で初めて起きると、仮想の実行環境の
// 出来事との前後が実行ごとに変わる。先に済ませておく。
beforeAll(async () => {
  (await openScratch({ ddl: [] })).close();
});

// 欠陥のスイッチを、環境変数 FAULT で入れる (sim.ts の injectedFault)。範囲の作り方のスイッチは、プロセス全体で 1 つである。
beforeEach(() => {
  const f = injectedFault();
  if (f?.side === "span") (spanFaults as Record<string, boolean>)[f.name] = true;
});

// RPC_TRACE=<ディレクトリ> を付けて流すと、試験ごとに、その試験が作ったクラスタの RPC の送り元、宛先、種類の列を 1 つのファイルに
// 書き出す (sim.ts の tracedNets)。要求の中身は書かない。変更の前後で同じ seed の実行が同じ RPC を送るかを、diff で比べる。
afterEach(() => {
  const dir = process.env.RPC_TRACE;
  if (!dir) return;
  const nets = tracedNets.splice(0);
  const state = expect.getState();
  const name = `${basename(state.testPath ?? "unknown")}--${state.currentTestName ?? "unknown"}`.replace(/[^A-Za-z0-9._-]+/g, "_");
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}.txt`, nets.map((n, i) => n.log.map((m) => `${i} ${m.from}>${m.to} ${String(m.method)}\n`).join("")).join(""));
});

afterEach(() => {
  const found = allSpanEscapes.splice(0);
  const seen = new Set<string>();
  const distinct = found.filter((e) => !seen.has(e.sql) && seen.add(e.sql));
  expect(
    distinct.map((e) => `${e.shard}: ${e.sql.slice(0, 160)} | spans ${JSON.stringify(e.spans).slice(0, 200)} | all rows: ${e.full.slice(0, 120)} | rows in spans only: ${e.narrowed.slice(0, 120)}`),
    "statements that depend on rows outside their declared spans",
  ).toEqual([]);
});
