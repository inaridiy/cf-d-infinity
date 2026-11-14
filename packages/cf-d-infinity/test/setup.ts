// どの試験にも掛かる検査。シミュレータのシャードが実行した文のうち、宣言した範囲 (span) の外の行に依存したものがあれば、
// その試験を失敗にする。範囲の外の行は、intent の決着も commit の検証も受けないので、取引の検証が成り立たない。
// 文の形ごとに範囲の作り方を確かめる代わりに、実行された文のすべてをこれで確かめる。
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, beforeAll, beforeEach, expect } from "vitest";
import { spanFaults } from "../src/client/spans";
import { imageChecks } from "../src/shard/rows";
import { parseObserver } from "../src/sql/cst";
import { openScratch } from "../src/sql/scratch";
import { allSpanEscapes, imageCheckOff, injectedFault, tracedNets } from "./sim";

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

// 行イメージの検査 (docs/design-values.md の「足す検査」の 5)。捕捉でまとめた変更後の行が文の後の本体の行と違うか、タプルの長さが
// 読む表定義の列の数と違えば、その試験を失敗にする。検査は報告するだけで、処理を変えない (RPC の列も変わらない)。シャードの捕捉と、
// Worker の SQLite (基準経路の書き込み) の捕捉の両方に掛かる。守りを外して古い欠陥を再現する試験は、noImageCheck で切る。
const imageProblems: string[] = [];
imageChecks.report = (problem) => {
  if (!imageCheckOff.now) imageProblems.push(problem);
};
afterEach(() => {
  const found = [...new Set(imageProblems.splice(0))];
  imageCheckOff.now = false;
  expect(found.slice(0, 5), "row images that disagree with the table or with its definition").toEqual([]);
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
