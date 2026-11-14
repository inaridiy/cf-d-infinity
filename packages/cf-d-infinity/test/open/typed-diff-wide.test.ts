// 未解決: 型を保った突き合わせ (test/typed-diff.test.ts) の 2 つ目の生成器を、いまは通らない値を混ぜて流す。
// docs/design-values.md の「足す検査」の 2。
//
// 生成器 (test/typed-diff-harness.ts の script2) は、指定すれば次の値を混ぜる。test/typed-diff.test.ts は、混ぜずに流している。
// - 2^53 を超える整数と、列に入ると 2^53 を超える INTEGER になる値 (文字列、整数の値の REAL)。いまは保存を断る (計画書の K1)。
//   値の作り直しの段 3 で通る。
// - NUL を含む文字列。いまは、Worker の SQLite (sql.js) を通ると最初の NUL で切れる (test/open/nul-in-text.test.ts)。
//   シミュレータでは、シャードの代わりの node:sqlite のドライバも NUL で切って返す。TEXT は hex() で読んで比べる。
// 通るようになったら、test/typed-diff.test.ts の script2 の呼び出しに指定を足して、この試験を消す。
// 断られた文の後は SQLite と状態が分かれるので、seed ごとに、最初の食い違いで止める。
import { describe, expect, it } from "vitest";
import { seedsOr } from "../sim";
import { runTyped, script2, SCHEMA2 } from "../typed-diff-harness";

describe("value types against SQLite through Hrana, with values that do not pass yet", () => {
  for (const seed of seedsOr([1, 2, 3, 4])) {
    it(`integers beyond 2^53, seed ${seed}`, async () => {
      const r = await runTyped(SCHEMA2, script2(seed, 60, { wideIntegers: true }), 1 + (seed % 4), { stopAtFirst: true });
      expect(r.problems).toEqual([]);
    });
    it(`TEXT that contains NUL, seed ${seed}`, async () => {
      const r = await runTyped(SCHEMA2, script2(seed, 60, { nul: true }), 1 + (seed % 4), { stopAtFirst: true });
      expect(r.problems).toEqual([]);
    });
  }
});
