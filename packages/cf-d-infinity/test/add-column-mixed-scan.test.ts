// ADD COLUMN と並行する取引の読みが、`column index out of range` で失敗しないこと。計画書の未解決の問題 11 (2026-11-12 に直した)。
//
// 直す前は、行を Worker へ集める走査 (src/client/db.ts の scan) が、各シャードに `SELECT rowid, *` を送り、列の並びを最初のシャードの答えから
// 取っていた。ADD COLUMN が全シャードに行き渡る途中で、シャードによって行の形が違うと、形の違う行が混ざり、Worker の SQLite
// (ScratchDb.load) に入れるときに失敗した。いまは、列を計画した表定義から名指しする (src/shard/rows.ts の scanList)。
// 見つけたのは、DDL と並行する取引の検査 (test/ddl-concurrent.test.ts の「ALTER TABLE ADD COLUMN」) の seed 835 である
// (2026-11-12、seed 1 から 1000 の掃引)。CI で 1 回だけ出ていたもの (2026-11-11) と同じ誤りで、値の型の作り直しの前の版
// (8c7943c) でも落ちる。手で組んだ順序では、版の適用の競り合いを作れなかったので、seed で再現する (決定的である)。
import { describe, expect, it } from "vitest";
import { runScenario, type Env } from "./ddl-harness";

describe("transactions racing ALTER TABLE ADD COLUMN (seed 835)", () => {
  it("never fail with a row shape that mixes schema versions", async () => {
    const r = await runScenario(835, {
      slowPhase2: true,
      ddl: async (e: Env) => {
        await e.at(0.4);
        await e.ddl("ALTER TABLE acct ADD COLUMN extra INTEGER DEFAULT 5");
        e.useExtra = true;
      },
    });
    expect(r.errors.filter((m) => /column index out of range/.test(m))).toEqual([]);
  }, 120_000);
});
