#!/usr/bin/env node
// seed を大量に流して、乱択の検査が落ちる seed を集める。
//
//   node scripts/sweep.mjs test/replay.test.ts 1 2000
//   node scripts/sweep.mjs test/ddl-concurrent.test.ts 1 300 -t "CREATE UNIQUE INDEX"
//   node scripts/sweep.mjs test/history.test.ts 1 500 --procs 8
//
// seed の範囲を等分し、プロセスごとに SEEDS=a..b を与えて vitest を起動する。シミュレータは決定的なので、
// ここで落ちた seed は、同じ seed を 1 つ指定すれば同じように落ちる。
//
//   SEEDS=1234 npx vitest run test/replay.test.ts -t "seed 1234"
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const pattern = flag("-t");
// 名前がこれに当たる試験は流さない (欠陥を自分で入れて、決まった seed で見つかることを確かめる試験など)。
const exclude = flag("--exclude");
const procs = Number(flag("--procs") ?? Math.max(1, availableParallelism() - 2));
const [file, fromArg, toArg] = args;
const from = Number(fromArg);
const to = Number(toArg);
if (!file || !Number.isInteger(from) || !Number.isInteger(to) || to < from) {
  console.error("usage: node scripts/sweep.mjs <test file> <first seed> <last seed> [-t <test name pattern>] [--procs <n>]");
  process.exit(2);
}

const out = mkdtempSync(join(tmpdir(), "sweep-"));
const chunks = Math.min(procs, to - from + 1);
const size = Math.ceil((to - from + 1) / chunks);
const t0 = Date.now();
const children = [];
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const c of children) c.kill(signal);
    process.exit(130);
  });
}
const runs = Array.from({ length: chunks }, (_, i) => {
  const a = from + i * size;
  const b = Math.min(to, a + size - 1);
  if (a > b) return null;
  const json = join(out, `${i}.json`);
  // seed ごとの試験だけを流す。名前に「seed 数字」のない試験 (決定性の検査、決まった並びの再現テストなど) は、ここでは要らない。
  const names = `^(?=.*seed \\d+)${pattern ? `(?=.*${pattern})` : ""}${exclude ? `(?!.*${exclude})` : ""}`;
  // vitest を npx を介さずに起動する。介すと、この道具を止めたときに、vitest のプロセスが残る。
  const argv = ["node_modules/vitest/vitest.mjs", "run", file, "--reporter=json", `--outputFile=${json}`, "-t", names];
  return new Promise((done) => {
    const child = spawn(process.execPath, argv, { env: { ...process.env, SEEDS: `${a}..${b}` }, stdio: "ignore" });
    children.push(child);
    child.on("exit", () => done(json));
  });
}).filter(Boolean);

let passed = 0;
const failed = [];
for (const json of await Promise.all(runs)) {
  let report;
  try {
    report = JSON.parse(readFileSync(json, "utf8"));
  } catch {
    failed.push({ name: `(no report: ${json})`, message: "the vitest process did not write a report" });
    continue;
  }
  for (const suite of report.testResults ?? []) {
    for (const t of suite.assertionResults ?? []) {
      if (t.status === "passed") passed++;
      else if (t.status === "failed") failed.push({ name: t.fullName, message: (t.failureMessages?.[0] ?? "").split("\n").slice(0, 6).join("\n    ") });
    }
  }
}
rmSync(out, { recursive: true, force: true });

// 試験の名前から seed を除いた部分ごとに、落ちた seed をまとめる。
const groups = new Map();
for (const f of failed) {
  const seed = /seed (\d+)/.exec(f.name)?.[1] ?? "?";
  const title = f.name.replace(/\(?seed \d+\)?:?/, "").trim();
  const g = groups.get(title) ?? { seeds: [], sample: f.message };
  groups.set(title, g);
  g.seeds.push(seed);
}
console.log(`${file} seeds ${from}..${to}${pattern ? ` -t "${pattern}"` : ""}: ${passed} passed, ${failed.length} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s on ${chunks} processes`);
for (const [title, g] of groups) {
  console.log(`\n  ${title}\n  seeds: ${g.seeds.join(", ")}\n    ${g.sample}`);
}
process.exit(failed.length > 0 ? 1 : 0);
