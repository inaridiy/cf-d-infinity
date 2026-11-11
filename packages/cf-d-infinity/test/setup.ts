// どの試験にも掛かる検査。シミュレータのシャードが実行した文のうち、宣言した範囲 (span) の外の行に依存したものがあれば、
// その試験を失敗にする。範囲の外の行は、intent の決着も commit の検証も受けないので、取引の検証が成り立たない。
// 文の形ごとに範囲の作り方を確かめる代わりに、実行された文のすべてをこれで確かめる。
import { afterEach, beforeAll, beforeEach, expect } from "vitest";
import { spanFaults } from "../src/client/spans";
import { openScratch } from "../src/sql/scratch";
import { allSpanEscapes, injectedFault } from "./sim";

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

afterEach(() => {
  const found = allSpanEscapes.splice(0);
  const seen = new Set<string>();
  const distinct = found.filter((e) => !seen.has(e.sql) && seen.add(e.sql));
  expect(
    distinct.map((e) => `${e.shard}: ${e.sql.slice(0, 160)} | spans ${JSON.stringify(e.spans).slice(0, 200)} | all rows: ${e.full.slice(0, 120)} | rows in spans only: ${e.narrowed.slice(0, 120)}`),
    "statements that depend on rows outside their declared spans",
  ).toEqual([]);
});
