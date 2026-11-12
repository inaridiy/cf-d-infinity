#!/usr/bin/env node
// 欠陥を 1 つずつ戻して、乱択の検査が見つけるかを表にする (計画書の Plan of Work の 5)。
//
//   node scripts/fault-table.mjs --to 40 --procs 8 --out /tmp/fault-table.md
//   node scripts/fault-table.mjs --to 40 --only ignoreTableLock,repinOnRestore
//   node scripts/fault-table.mjs --to 40 --out /tmp/fault-table.md --resume    (表にもうある欠陥は飛ばして、続きから)
//
// 1 回の vitest の実行には、時間の上限がある (--limit 秒、既定 900)。欠陥のせいで、同期の無限ループに入って止まる実行がある
// (試験の制限時間は、イベントループが回らないと効かない)。上限を超えた実行は、プロセスのグループごと止め、表に「止まった」と書く。
// 表は、欠陥 1 つごとに書き足す。途中で止めても、そこまでの行は残る。
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
const limitMs = Number(flag("--limit", "900")) * 1000;
const resume = args.includes("--resume");

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
    for (const c of children) killGroup(c);
    process.exit(130);
  });
}

/** 子と、子が起こした vitest の作業プロセスを、まとめて止める。子は自分のプロセスのグループで起こしてある。 */
function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // もう終わっている
  }
}

/** 1 つの欠陥と 1 つの検査を、seed の範囲を分けて並べて流す。落ちた試験の数、全部の数、落ちた seed、止まった実行の数を返す。 */
async function run(fault, file) {
  const out = mkdtempSync(join(tmpdir(), "fault-table-"));
  const chunks = Math.min(procs, to - from + 1);
  const size = Math.ceil((to - from + 1) / chunks);
  const jobs = [];
  const hung = [];
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
      const child = spawn(process.execPath, argv, { env, stdio: "ignore", detached: true });
      children.push(child);
      const timer = setTimeout(() => {
        hung.push(`${a}..${b}`);
        killGroup(child);
      }, limitMs);
      child.on("exit", () => {
        clearTimeout(timer);
        done(json);
      });
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
  return { found, total, seeds: [...seeds].sort((x, y) => x - y), hung };
}

const name = (f) => f.replace(/^test\//, "").replace(/\.test\.ts$/, "");
const header = [
  `seeds ${from}..${to}, project sim. Each cell is failed tests / seeded tests run, then the seeds that failed (first 6).`,
  `"hung a..b" means the run of seeds a..b did not finish within ${limitMs / 1000} s and was killed.`,
  "",
  `| fault | ${HARNESSES.map(name).join(" | ")} |`,
  `|---|${HARNESSES.map(() => "---").join("|")}|`,
];
const cell = (c) => [
  `${c.found}/${c.total}`,
  c.seeds.length ? `(${c.seeds.slice(0, 6).join(", ")}${c.seeds.length > 6 ? ", ..." : ""})` : "",
  c.hung.length ? `hung ${c.hung.join(", ")}` : "",
].filter(Boolean).join(" ");

// 続きから流すときは、表にもうある行を残し、その欠陥は流さない。
const kept = [];
if (resume && outFile) {
  try {
    for (const line of readFileSync(outFile, "utf8").split("\n")) {
      const m = /^\| (\w+) \| /.exec(line);
      if (m && m[1] !== "fault") kept.push({ fault: m[1], line });
    }
  } catch {
    // まだ表がない
  }
}
const lines = [...header, ...kept.map((k) => k.line)];
const write = () => {
  if (outFile) writeFileSync(outFile, lines.join("\n") + "\n");
};
write();
const t0 = Date.now();
for (const fault of FAULTS) {
  if (kept.some((k) => k.fault === fault)) continue;
  const cells = [];
  for (const file of HARNESSES) {
    const r = await run(fault, file);
    cells.push(r);
    process.stderr.write(`${fault} ${file}: ${cell(r)} ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  }
  lines.push(`| ${fault} | ${cells.map(cell).join(" | ")} |`);
  write();
}
process.stdout.write(lines.join("\n") + "\n");
