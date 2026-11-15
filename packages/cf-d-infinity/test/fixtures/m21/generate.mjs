#!/usr/bin/env node
// M21 (specs/m21_catalog_epoch.qnt) の乱択の経路から、Meta の手を model に尋ねた答えを作る。test/catalog-m21.test.ts が読む。
// docs/design-catalog-epoch.md の段 1 の検査 (c)。
//
// 手順:
//   1. インスタンスごとに、quint run (simulator、--mbt) で乱択の経路を作る。--mbt は、各状態に、その状態を作った手の名前と
//      nondet の値を付ける。
//   2. 経路の各状態 k で、Meta の手の候補 (prepareOp、commitOp、expire、startSplit、endSplit) を 1 つずつ試す。試すのは
//      model 自身である。初めの状態から k までの手を並べた run (控え) と、その後に候補を 1 つ足した run を作り、quint test に
//      流す。控えが通り、候補を足した run が落ちれば、model はその状態でその手を断る。候補の条件を TypeScript に写して
//      決めることはしない (写し間違えると、突き合わせる意味がなくなる)。控えが落ちれば、経路の再生が壊れているので止まる。
//   3. 状態の中で Meta の手の答えに関わる変数 (列の 3 つの表、len、acks、dead、drained、pfenced) と、候補ごとの答えを書き出す。
//      同じ変数の値で答えが違う状態があれば、答えがほかの変数にも依るので、止まる (試験はこの変数しか見ない)。
//
// 経路は model の手だけでできているが、手を選ぶ重みは変えてある (下の BIASED)。quint は、作業の場所に写した model を読む。
// 写しは specs/ のものと同じ中身で、その sha256 を書き出す。
//
// 使い方 (リポジトリの直下から。specs/ に quint を入れておく: cd specs && npm ci):
//   node packages/cf-d-infinity/test/fixtures/m21/generate.mjs
// 書き出すのは、この台本の隣の probes.json である。model を変えたら作り直す (試験が model の sha256 を比べる)。
// 8 つのインスタンスで 50 分ほど掛かる。M21_TRACES、M21_STEPS、M21_SEED で経路の数と長さと seed を、M21_ONLY でインスタンスを、
// M21_TMP で作業の場所を、M21_OUT で書き出す先を変えられる。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.M21_ROOT ?? resolve(here, "../../../../..");
const specs = join(root, "specs");
const MODEL = join(specs, "m21_catalog_epoch.qnt");
const OUT = process.env.M21_OUT ?? join(here, "probes.json");

// 経路の数と長さ。乱数の seed は固定して、同じ答えを作り直せるようにする。
const TRACES = Number(process.env.M21_TRACES ?? 12);
const STEPS = Number(process.env.M21_STEPS ?? 40);
const SEED = process.env.M21_SEED ?? "0x2115";
const CHUNK = 400;

const source = readFileSync(MODEL, "utf8");
const sha256 = createHash("sha256").update(source).digest("hex");

/** model の中のインスタンスが m21_core に渡す定数。そのまま、候補を試す run の module にも渡す。 */
function constantsOf(module) {
  const m = new RegExp(`module ${module} \\{\\s*import m21_core\\(([^)]*)\\)\\.\\*`).exec(source);
  if (!m) throw new Error(`no instance ${module} in ${MODEL}`);
  return Object.fromEntries(m[1].split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.split("=").map((y) => y.trim())));
}

// 突き合わせるインスタンス。決めた設計 (green) の場面を全部使う。all は specs/ にないインスタンスで、m21_green_split の定数の
// まま、4 つの操作を全部入れる (DROP と移動、index の作成と DROP の組み合わせを、同じ経路で見るため)。
const INSTANCES = [
  ...["m21_green_build", "m21_green_check", "m21_green_ddl2", "m21_green_drop", "m21_green_split", "m21_green_split_txns", "m21_green_split_build"]
    .map((name) => ({ name, constants: constantsOf(name) })),
  { name: "all", constants: { ...constantsOf("m21_green_split"), HAS_BUILD: "true", HAS_DROP: "true" } },
];

// 作業の場所。M21_TMP で変えられる。
const tmp = mkdtempSync(join(process.env.M21_TMP ?? tmpdir(), "m21-probes-"));
copyFileSync(MODEL, join(tmp, "m21_catalog_epoch.qnt"));
const quint = (args) => execFileSync("npx", ["quint", ...args], { cwd: specs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30 });

const BUILD = 1, CHECK = 2, DROP = 3, SPLIT = 4;
const OPS = { [BUILD]: "HAS_BUILD", [CHECK]: "HAS_CHECK", [DROP]: "HAS_DROP" };

// ITF の値を JS にする。
function plain(v) {
  if (v && typeof v === "object") {
    if ("#bigint" in v) return Number(v["#bigint"]);
    if ("#map" in v) return Object.fromEntries(v["#map"].map(([k, x]) => [plain(k), plain(x)]));
    if ("#set" in v) return v["#set"].map(plain).sort();
    if ("#tup" in v) return v["#tup"].map(plain);
    if (Array.isArray(v)) return v.map(plain);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

/** 経路の 1 歩を、quint の手の呼び出しにする。 */
function call(action, picks) {
  const p = Object.fromEntries(Object.entries(picks).filter(([, x]) => x.tag === "Some").map(([k, x]) => [k, plain(x.value)]));
  const args = {
    init: ["a", "b"], plan: ["t", "r", "nv", "pe"], repin: ["t"], enter: ["t"], prepare: ["t"], commit: ["t"], read: ["pe", "r"],
    prepareOp: ["op"], commitOp: ["op"], expire: ["op"], die: ["op"], applyNext: ["s"], ackBuild: ["s"], ackCheck: ["s"], ackDrop: ["s"],
  }[action] ?? [];
  const name = action === "init" ? "initWith" : action;
  for (const a of args) if (!(a in p)) throw new Error(`${action}: no nondet value for ${a}`);
  return args.length ? `${name}(${args.map((a) => p[a]).join(", ")})` : name;
}

/** 状態のうち、Meta の手の答えに関わる変数。 */
function projection(state) {
  const v = (k) => plain(Object.entries(state).find(([name]) => name.endsWith(`::${k}`))[1]);
  return { len: v("len"), prepE: v("prepE"), commitE: v("commitE"), abortE: v("abortE"), acks: v("acks"), dead: v("dead"), drained: v("drained"), pfenced: v("pfenced") };
}

function candidates(c) {
  const out = [];
  for (const op of [BUILD, CHECK, DROP]) if (c[OPS[op]] === "true") out.push(`prepareOp(${op})`, `commitOp(${op})`, `expire(${op})`);
  if (c.HAS_SPLIT === "true") out.push("startSplit", "endSplit");
  return out;
}

const header = (name, c) =>
  `module ${name} {\n  import m21_core(${Object.entries(c).map(([k, x]) => `${k} = ${x}`).join(", ")}).* from "./m21_catalog_epoch"\n`;
// 経路を作るときの手の選び方。model の step は手を一様に選ぶので、Meta の手と、確定に要るシャードの手 (列の適用、確かめの答え)
// が少なく、期限切れ (expire) がいつでも打てるので、表定義の遷移が確定まで進む経路がほとんどできない。model の手だけを使い、
// 選ぶ重みだけを変える (expire は step の中にだけ残す)。どの経路も model の振る舞いである。
const PROGRESS = "{ nondet s = oneOf(SHARDS) any { applyNext(s), ackBuild(s), ackCheck(s), ackDrop(s) } }";
const BIASED = `  action biased = any {
    step,
    { nondet op = oneOf(DDLS) any { prepareOp(op), commitOp(op) } },
    any { startSplit, endSplit, pull, finishData },
    ${PROGRESS},
    ${PROGRESS},
    ${PROGRESS},
  }
`;

const result = { model: "specs/m21_catalog_epoch.qnt", sha256, seed: SEED, traces: TRACES, steps: STEPS, instances: [] };
// M21_ONLY=<名前,...> で、インスタンスを選んで作る (台本を直すときの確かめ用。書き出すのは選んだものだけになる)。
const only = process.env.M21_ONLY?.split(",");
for (const inst of INSTANCES.filter((x) => !only || only.includes(x.name))) {
  const mod = `w_${inst.name}`;
  // 1. 乱択の経路
  writeFileSync(join(tmp, `${mod}.qnt`), `${header(mod, inst.constants)}${BIASED}}\n`);
  quint(["run", `--main=${mod}`, "--step=biased", "--mbt", `--max-steps=${STEPS}`, `--n-traces=${TRACES}`, `--max-samples=${TRACES}`, `--seed=${SEED}`,
    "--backend=typescript", `--out-itf=${join(tmp, `${inst.name}_{seq}.itf.json`)}`, join(tmp, `${mod}.qnt`)]);
  const files = readdirSync(tmp).filter((f) => f.startsWith(`${inst.name}_`) && f.endsWith(".itf.json")).sort();
  // 2. 候補を試す run
  const runs = [];
  const states = [];
  for (const [t, f] of files.entries()) {
    const trace = JSON.parse(readFileSync(join(tmp, f), "utf8")).states;
    const calls = trace.map((s) => call(s["mbt::actionTaken"], s["mbt::nondetPicks"]));
    for (let k = 0; k < trace.length; k++) {
      const prefix = calls[0] + calls.slice(1, k + 1).map((c) => `.then(${c})`).join("");
      const id = `t${t}_k${k}`;
      runs.push(`  run ${id}_control_Test = ${prefix}`);
      const cands = candidates(inst.constants);
      cands.forEach((c, i) => runs.push(`  run ${id}_c${i}_Test = ${prefix}.then(${c})`));
      states.push({ id, proj: projection(trace[k]), cands });
    }
  }
  // quint test の --out は module の全体も書くので、run が多いと JSON の文字列の長さの上限を超える。分けて流す。
  const passed = new Set();
  const failed = new Set();
  for (let at = 0, part = 0; at < runs.length; at += CHUNK, part++) {
    const name = `${mod}_probe${part}`;
    writeFileSync(join(tmp, `${name}.qnt`), `${header(name, inst.constants)}${runs.slice(at, at + CHUNK).join("\n")}\n}\n`);
    const out = join(tmp, `${name}.json`);
    try {
      quint(["test", `--main=${name}`, "--max-samples=1", "--backend=typescript", `--out=${out}`, join(tmp, `${name}.qnt`)]);
    } catch {
      // 落ちる run (model が断る候補) があると、quint test は 0 でない値で終わる。答えは --out から読む。
    }
    const r = JSON.parse(readFileSync(out, "utf8"));
    if (r.errors?.length) throw new Error(`${inst.name}: quint test reported errors: ${JSON.stringify(r.errors).slice(0, 500)}`);
    for (const x of r.passed) passed.add(x);
    for (const x of r.failed) failed.add(x);
  }
  // 3. 書き出す
  const seen = new Map();
  for (const s of states) {
    const control = `${s.id}_control_Test`;
    if (!passed.has(control)) throw new Error(`${inst.name}: the replay of ${s.id} does not pass (${failed.has(control) ? "failed" : "missing"})`);
    const verdicts = Object.fromEntries(s.cands.map((c, i) => {
      const n = `${s.id}_c${i}_Test`;
      if (!passed.has(n) && !failed.has(n)) throw new Error(`${inst.name}: no result for ${n}`);
      return [c, passed.has(n)];
    }));
    const key = JSON.stringify(s.proj);
    const prev = seen.get(key);
    if (prev && JSON.stringify(prev) !== JSON.stringify(verdicts)) {
      throw new Error(`${inst.name}: two states with the same Meta variables ${key} get different answers; the answers depend on other variables`);
    }
    seen.set(key, verdicts);
  }
  const constants = Object.fromEntries(["HAS_BUILD", "HAS_CHECK", "HAS_DROP", "HAS_SPLIT"].map((k) => [k, inst.constants[k] === "true"]));
  result.instances.push({ name: inst.name, constants, probed: states.length, states: [...seen].map(([k, verdicts]) => ({ ...JSON.parse(k), verdicts })) });
  console.log(`${inst.name}: ${files.length} traces, ${states.length} states probed, ${seen.size} distinct`);
}
writeFileSync(OUT, `${JSON.stringify(result)}\n`);
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${OUT}`);
