import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// test/open/ には、見つかっているがまだ直していない欠陥の再現テストを置く。正しい挙動を期待して書いてあるので、いまは落ちる。
// 既定の実行からは外す。`OPEN=1 npx vitest run test/open` で実行する。直したら test/ の直下へ移す。
const open = process.env.OPEN ? [] : ["test/open/**"];

// 試験は 2 組に分ける。
// sim: シミュレータの上の試験。仮想の時計で動き、実時間に依らない。計算機の全部のコアを使う。
// workerd: 本物の workerd (Miniflare) を動かす試験。実時間で待ち、負荷の閾値を実時間の書き込みの速さで超える試験もある。
//          ほかの試験と同時に流すと、CPU を取り合って遅くなり、制限時間や閾値に届かずに落ちる。sim が終わってから、
//          ファイルを 1 つずつ流す (CI の計算機は 4 コアで、workerd の試験どうしでも取り合う)。
const dir = join(import.meta.dirname, "test");
const tests = [
  ...readdirSync(dir).map((f) => `test/${f}`),
  ...readdirSync(join(dir, "open")).map((f) => `test/open/${f}`),
].filter((f) => f.endsWith(".test.ts"));
const workerd = tests.filter((f) => /from "miniflare"/.test(readFileSync(join(import.meta.dirname, f), "utf8")));

export default defineConfig({
  test: {
    testTimeout: 30000,
    pool: "forks",
    setupFiles: ["test/setup.ts"],
    projects: [
      {
        extends: true,
        test: { name: "sim", include: ["test/**/*.test.ts"], exclude: ["node_modules/**", ...workerd, ...open], sequence: { groupOrder: 0 } },
      },
      {
        extends: true,
        test: { name: "workerd", include: workerd, exclude: ["node_modules/**", ...open], sequence: { groupOrder: 1 }, poolOptions: { forks: { singleFork: true } } },
      },
    ],
  },
});
