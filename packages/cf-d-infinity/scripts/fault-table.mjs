#!/usr/bin/env node
// 欠陥を 1 つずつ戻して、乱択の検査が見つけるかを表にする (計画書の Plan of Work の 5)。
//
//   node scripts/fault-table.mjs --to 40 --procs 8 --out /tmp/fault-table.md
//   node scripts/fault-table.mjs --to 40 --only ignoreTableLock,repinOnRestore
//
// 欠陥のスイッチ (src/types.ts の Faults、src/client/spans.ts の spanFaults、src/client/db.ts の ClientFaults) を、環境変数
// FAULT で 1 つずつ入れ (test/sim.ts の injectedFault)、乱択の検査の seed ごとの試験を、同じ seed の範囲で流す。
// 「見つけた」は、その欠陥を入れたときに落ちた試験の数である。欠陥を入れない行 (none) で落ちる数が、検査そのものの誤りの数になる。
// 作業ツリーで流すと、途中の編集が混ざる。コミットした版の worktree で流す。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, d) => {
  const i = args.indexOf(name);
  return i < 0 ? d : args[i + 1];
};
const from = Number(flag("--from", "1"));
const to = Number(flag("--to", "40"));
const procs = Number(flag("--procs", String(Math.max(1, availableParallelism() - 2))));
const outFile = flag("--out", null);
const only = flag("--only", null)?.split(",");

/** 欠陥のスイッチ。triggerCapture は欠陥ではなく、遅い経路を使わせるだけである (見つからないのが正しい)。 */
const SHARD = [
  "autoIgnoresUniqueIntents", "ddlIgnoresIntents", "childKeepsOldSchema", "noSchemaRecheck", "noWriteSetLimit", "noRealtimeBump",
  "anchorNoAbsorb", "skipReadOnlyPrepare", "refreshNoBump", "predicateProtected", "ignoreIntentsInValidation", "readerTimeoutPass",
  "hlcNoCeiling", "rowwiseUndo", "pushAfterDecide", "applyAfterMoved", "triggerCapture", "dropIntentsOnMove", "servePastMove",
  "ignoreFence", "staleWideRead", "finishWithoutClock", "ignoreTableLock", "publishWithoutClock", "validateFromT", "trustLocks",
];
const OTHER = ["rowSpanDespiteUnique", "repinOnRestore", "replayAcrossSchemaChange", "dropWithoutGuard", "noImplicitCommit", "ddlAfterFailedCommit"];
const FAULTS = ["none", ...(only ?? [...SHARD, ...OTHER])];
const HARNESSES = ["test/replay.test.ts", "test/history.test.ts", "test/ddl-concurrent.test.ts"];

const children = [];
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const c of children) c.kill(signal);
    process.exit(130);
  });
}

/** 1 つの欠陥と 1 つの検査を、seed の範囲を分けて並べて流す。落ちた試験の数、全部の数、落ちた seed を返す。 */
async function run(fault, file) {
  const out = mkdtempSync(join(tmpdir(), "fault-table-"));
  const chunks = Math.min(procs, to - from + 1);
  const size = Math.ceil((to - from + 1) / chunks);
  const jobs = [];
  for (let i = 0; i < chunks; i++) {
    const a = from + i * size;
    const b = Math.min(to, a + size - 1);
    if (a > b) continue;
    const json = join(out, `${i}.json`);
    const argv = ["node_modules/vitest/vitest.mjs", "run", file, "--project", "sim", "--reporter=json", `--outputFile=${json}`, "-t", "seed \\d+"];
    const env = { ...process.env, SEEDS: `${a}..${b}` };
    if (fault === "none") delete env.FAULT;
    else env.FAULT = fault;
    jobs.push(new Promise((done) => {
      const child = spawn(process.execPath, argv, { env, stdio: "ignore" });
      children.push(child);
      child.on("exit", () => done(json));
    }));
  }
  let found = 0;
  let total = 0;
  const seeds = new Set();
  for (const json of await Promise.all(jobs)) {
    let report;
    try {
      report = JSON.parse(readFileSync(json, "utf8"));
    } catch {
      continue;
    }
    for (const suite of report.testResults ?? []) {
      for (const t of suite.assertionResults ?? []) {
        if (t.status !== "passed" && t.status !== "failed") continue;
        // 欠陥を自分で入れて、決まった seed で見つかることを確かめる試験は、表に数えない (ほかの seed では落ちるのが正しい)。
        if (/put back|search: seeds/.test(t.fullName)) continue;
        total++;
        if (t.status === "failed") {
          found++;
          const seed = /seed (\d+)/.exec(t.fullName)?.[1];
          if (seed) seeds.add(Number(seed));
        }
      }
    }
  }
  rmSync(out, { recursive: true, force: true });
  return { found, total, seeds: [...seeds].sort((x, y) => x - y) };
}

const rows = [];
const t0 = Date.now();
for (const fault of FAULTS) {
  const cells = [];
  for (const file of HARNESSES) {
    const r = await run(fault, file);
    cells.push(r);
    process.stderr.write(`${fault} ${file}: ${r.found}/${r.total} (seeds ${r.seeds.slice(0, 8).join(",")}${r.seeds.length > 8 ? ",..." : ""}) ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  }
  rows.push({ fault, cells });
}

const name = (f) => f.replace(/^test\//, "").replace(/\.test\.ts$/, "");
const lines = [
  `seeds ${from}..${to}, project sim. Each cell is failed tests / seeded tests run, then the seeds that failed (first 6).`,
  "",
  `| fault | ${HARNESSES.map(name).join(" | ")} |`,
  `|---|${HARNESSES.map(() => "---").join("|")}|`,
  ...rows.map((r) => `| ${r.fault} | ${r.cells.map((c) => `${c.found}/${c.total}${c.seeds.length ? ` (${c.seeds.slice(0, 6).join(", ")}${c.seeds.length > 6 ? ", ..." : ""})` : ""}`).join(" | ")} |`),
];
const text = lines.join("\n") + "\n";
if (outFile) writeFileSync(outFile, text);
process.stdout.write(text);
