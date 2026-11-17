// どの試験にも掛かる検査。シミュレータのシャードが実行した文のうち、宣言した範囲 (span) の外の行に依存したものがあれば、
// その試験を失敗にする。範囲の外の行は、intent の決着も commit の検証も受けないので、取引の検証が成り立たない。
// 文の形ごとに範囲の作り方を確かめる代わりに、実行された文のすべてをこれで確かめる。
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, beforeAll, beforeEach, expect } from "vitest";
import { Txn } from "../src/client/db";
import { spanFaults } from "../src/client/spans";
import { imageChecks, imageFaults } from "../src/shard/rows";
import { parseObserver } from "../src/sql/cst";
import { openScratch } from "../src/sql/scratch";
import { systemRuntime } from "../src/runtime";
import { allDriverIntegers, allSpanEscapes, allTilingProblems, allWriteEscapes, checkTiling, imageCheckOff, injectedFault, realTimeCluster, tracedNets } from "./sim";

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
  if (f?.side === "image") (imageFaults as Record<string, boolean>)[f.name] = true;
});

// RPC_TRACE=<ディレクトリ> を付けて流すと、試験ごとに、その試験が作ったクラスタの RPC の送り元、宛先、種類の列を 1 つのファイルに
// 書き出す (sim.ts の tracedNets)。要求の中身は書かない。変更の前後で同じ seed の実行が同じ RPC を送るかを、diff で比べる。
afterEach(() => {
  const dir = process.env.RPC_TRACE;
  if (!dir) return;
  const nets = tracedNets.splice(0);
  const state = expect.getState();
  const full = `${basename(state.testPath ?? "unknown")}--${state.currentTestName ?? "unknown"}`;
  // 長い試験の名前は、ファイルの名前の上限 (255 バイト) を超える。先頭を残し、名前全体の指紋を足す。
  const name = `${full.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160)}-${createHash("sha256").update(full).digest("hex").slice(0, 12)}`;
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

// 書き込みの側の範囲の検査 (sim.ts の checkWrites)。シミュレータのシャードが受け入れようとした書き込みのうち、宣言した範囲の外の
// 行を書く文か、行を持ち主でないシャードに残す書き込みがあれば、その試験を失敗にする。シャードの守り (kernel.ts の claimed) が
// 断った書き込みも数える。守りがあっても、Worker が宣言を誤ったことには変わりないからである。範囲の検査と同じく、
// SimOptions の noSpanCheck で切る。
afterEach(() => {
  const found = allWriteEscapes.splice(0);
  const seen = new Set<string>();
  const distinct = found
    .map((e) => `${e.shard}: ${e.sql === null ? "(a transaction's writes at commit)" : e.sql.slice(0, 160)} | ${e.row} | ${e.problem.slice(0, 240)}`)
    .filter((s) => !seen.has(s) && seen.add(s));
  expect(distinct.slice(0, 10), "writes outside their declared spans, or rows left on a shard that does not own them").toEqual([]);
});

// 全表の読みの区間の検査 (test/sim.ts の checkTiling、M19 の m19_red_gap)。Worker が 1 つの文の答えにまとめたシャードの答えの claim が、
// 1 つの範囲表のスナップショットで token の全体をちょうど覆わなければ、その試験を失敗にする。
// Worker が複数のシャードの答えをまとめるところは、ReadScope.budgeted の 1 か所である (走査、押し下げた読み、部分の集約、書き込みの
// 基準経路の集める読み)。その返り値の parts が、使った答えの全部である (予算を超えて読み直したシャードは、読み直した答えだけが入る)。
// 押し下げる書き込みの文 (Txn.write) は、いつも shard key で宛先を決め、全表の span を運ばない (src/sql/plan.ts の planUpdateDelete。
// 主キーか shard key で絞れない UPDATE と DELETE は、基準経路で行を集める)。UNIQUE の index を作る走査 (Db.scanShard) は、ページごとに
// 別の時点で読む作り方の読みで、文の読みではない。どちらも確かめない。
// ReadScope は書き出されていないので、Txn の親の prototype から取る。名前が変わったら、ここで落とす (黙って確かめなくなるのを防ぐ)。
// 包みは同じ Promise を返し、確かめは横に付けた then で走らせる。async の包みにすると、Promise の解決の段が増え、同じ seed の RPC の列が
// 変わり得る。横の then は、呼び出し側の続きより先に、同じ段で走る (RPC_TRACE で、包む前と同じ RPC の列であることを確かめた)。
{
  const scope = Object.getPrototypeOf(Txn.prototype) as { budgeted?: (...a: unknown[]) => Promise<{ parts: unknown[] }> };
  const budgeted = scope.budgeted;
  if (typeof budgeted !== "function") throw new Error("test/setup.ts: ReadScope.budgeted is gone from src/client/db.ts; move the tiling check (test/sim.ts checkTiling) to where the Worker now merges the answers of one statement");
  scope.budgeted = function (this: unknown, ...a: unknown[]) {
    const out = budgeted.apply(this, a);
    out.then(({ parts }) => {
      try {
        checkTiling(parts);
      } catch (e) {
        allTilingProblems.push(`the tiling check could not read the answers: ${(e as Error)?.message ?? String(e)}`);
      }
    }, () => undefined);
    return out;
  };
}
afterEach(() => {
  const found = [...new Set(allTilingProblems.splice(0))];
  expect(found.slice(0, 5), "whole-table reads whose answers do not cover the token space exactly once under one routing snapshot").toEqual([]);
});

// 型つきの読みの検査 (docs/design-values.md の「足す検査」の 5 の 1 つ目、test/sim.ts の allDriverIntegers)。利用者の表に触る文
// (Backend.query) が、ドライバから INTEGER を数として読んだら、その試験を失敗にする。DO のドライバは、その INTEGER を丸めて返す。
afterEach(() => {
  const found = [...new Set(allDriverIntegers.splice(0))];
  expect(found.slice(0, 5), "statements through query that read an INTEGER as a driver number (a read that is not typed)").toEqual([]);
});

// 決定性の検査。シミュレータの試験は、時計、待ち、乱数、取引の ID を、クラスタの仮想の実行環境から取る (AGENTS.md)。本物の
// systemRuntime を呼んだ試験は、同じ seed でも実行ごとに要求の中身が変わる (2026-11-15、Cluster を手で包んだ試験が runtime を
// 渡さず、Db が systemRuntime の取引の ID と時刻を使っていた)。実時間のクラスタ (realTime か now) を作った試験だけは許す。
const systemCalls: string[] = [];
for (const name of ["now", "after", "random", "uuid"] as const) {
  const real = systemRuntime[name] as (...a: unknown[]) => unknown;
  (systemRuntime as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
    systemCalls.push(name);
    return real(...a);
  };
}
beforeEach(() => {
  systemCalls.length = 0;
  realTimeCluster.now = false;
});
afterEach(() => {
  const used = [...new Set(systemCalls)];
  systemCalls.length = 0;
  if (used.length === 0 || realTimeCluster.now) return;
  throw new Error(`this test used the real clock or randomness (systemRuntime.${used.join(", ")}) without a real-time cluster; pass the cluster's runtime (a Cluster wrapper must keep \`runtime\`)`);
});
