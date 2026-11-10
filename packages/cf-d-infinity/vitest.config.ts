import { defineConfig } from "vitest/config";

// test/open/ には、見つかっているがまだ直していない欠陥の再現テストを置く。正しい挙動を期待して書いてあるので、いまは落ちる。
// 既定の実行からは外す。`OPEN=1 npx vitest run test/open` で実行する。直したら test/ の直下へ移す。
const open = process.env.OPEN ? [] : ["test/open/**"];
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["node_modules/**", ...open], testTimeout: 30000, pool: "forks" } });
