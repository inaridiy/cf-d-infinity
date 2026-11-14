// 実行のたびに変わり得る入力 (実時間、待ち、乱数、識別子) は、src/runtime.ts の Runtime を通す。
// シミュレータは seed から決まる Runtime を渡して、同じ seed を同じ実行にする。検査が見つけた失敗を再現するための前提である。
//
// ここでは、Runtime を通さない呼び出しがソースにないことを確かめる。同じ seed が同じ実行になること自体は、
// 乱択の検査のそれぞれが確かめる (test/replay.test.ts、test/ddl-concurrent.test.ts、test/history.test.ts)。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

/**
 * 実物を直に呼んでよいファイル。
 * runtime.ts は実物の Runtime を定義する。worker.ts は Durable Object と Worker の入口で、本番でしか動かない。
 * bench.ts と listappend.ts は、本番に負荷を掛ける道具である (listappend.ts は、乱数と時計を引数で差し替えられる)。
 */
const ALLOWED = new Set(["runtime.ts", "worker.ts", "bench.ts", "listappend.ts"]);
const BANNED = /\b(setTimeout|setInterval|setImmediate)\s*\(|\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bMath\.random\s*\(|\bcrypto\.(randomUUID|getRandomValues)\s*\(|\bperformance\.now\s*\(/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".ts") ? [path] : [];
  });
}

describe("nondeterministic input goes through the Runtime", () => {
  it("no source file outside the allowed ones calls a timer, the wall clock or a random source directly", () => {
    const found: string[] = [];
    for (const path of files(SRC)) {
      const name = relative(SRC, path);
      if (ALLOWED.has(name)) continue;
      readFileSync(path, "utf8").split("\n").forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (BANNED.test(code)) found.push(`${name}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("the check itself finds a direct call", () => {
    for (const line of ["await new Promise((r) => setTimeout(r, 5));", "const t0 = Date.now();", "if (Math.random() < 0.5) return;", "const id = crypto.randomUUID();"]) {
      expect(BANNED.test(line), line).toBe(true);
    }
    expect(BANNED.test("const t0 = this.rt.now();")).toBe(false);
  });
});

// シャードの状態を読み書きするのは、同期の核 (src/shard/kernel.ts) だけである。核は待たない。待つのは殻 (src/shard/core.ts) で、
// 核が返した待ち (src/shard/step.ts の Effect) を実行してから、核の同じ 1 歩を先頭から呼び直す。核の中に待ちがなければ、
// 待ちの前に確かめたことを、待ちの後まで持ち越す書き方ができない。ここでは、核のソースに、待つ手段がないことを確かめる。
const WAITS = /\b(async|await|Promise|PromiseLike|queueMicrotask)\b|\.(then|catch|finally|sync|after)\s*\(/;
const code = (line: string) => line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/^\s*\/\*\*.*$/, "");

describe("the shard kernel is synchronous", () => {
  it("src/shard/kernel.ts has no async function, no await, no Promise, no timer and no storage sync", () => {
    const found: string[] = [];
    readFileSync(join(SRC, "shard", "kernel.ts"), "utf8").split("\n").forEach((line, i) => {
      if (WAITS.test(code(line))) found.push(`kernel.ts:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
    expect(found).toEqual([]);
  });

  it("no frame of a kernel program can hold a Section: a check made before a wait cannot be carried past it", () => {
    // frame は、待ちをまたいで残る、ただ 1 つのものである。その宣言に、同期区間の印の型が現れない。
    const src = readFileSync(join(SRC, "shard", "kernel.ts"), "utf8");
    const frames = src.slice(src.indexOf("// ---- 手続きの frame ----"), src.indexOf("export class ShardKernel"));
    expect(frames.length).toBeGreaterThan(1000);
    expect(frames.split("\n").filter((line) => /\bSection\b/.test(code(line)))).toEqual([]);
  });

  it("the check itself finds a wait, and the shell is where the waits are", () => {
    for (const line of ["  private async exec(req: ExecReq): Promise<ExecRes> {", "    await this.b.sync();", "    p.then(() => undefined);", "    queueMicrotask(() => this.wakeNext(key));", "    this.rt.after(5, wake);"]) {
      expect(WAITS.test(code(line)), line).toBe(true);
    }
    expect(WAITS.test(code("    return wait({ kind: \"sync\" }); // 確定を await する"))).toBe(false);
    const shell = readFileSync(join(SRC, "shard", "core.ts"), "utf8").split("\n").filter((line) => WAITS.test(code(line)));
    expect(shell.length).toBeGreaterThan(0);
  });
});
