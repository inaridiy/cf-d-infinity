// 見つかっている欠陥の再現 (2026-11-16。計画書の未解決の問題 47 の作業で、Hrana の fromH を読んで見つけた。不変条件 11)。
//
// Hrana の引数は型を書いた値 ({ type, value }) である。src/client/hrana.ts の fromH は type で枝を選ぶが、value の JS の型を
// 確かめない。`float` の文字列は TEXT に、`text` の数は REAL に、`float` の配列は BLOB になる (src/client/d1.ts の toValue の
// 2026-11-16 より前の穴と同じ形)。`float` の object は SQLite のドライバの束縛の誤り (`Wrong API use`) に、`blob` の数か欠けた
// base64 は fromBase64 の中の TypeError (`s.padEnd is not a function`) になり、知らない type は undefined のまま束縛へ進んで、
// 文が実行される。正しくは、どれも、文を実行する前に、引数の番号を書いた利用者の誤りとして断る。
// 直す場所は fromH の 1 か所である (この作業では src/client/hrana.ts に触らない取り決めだった)。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { handlePipeline, type PipelineReq } from "../../src/client/hrana";
import { SimCluster } from "../sim";

const execute = async (c: SimCluster, sql: string, args: unknown[]) => {
  const out = (await handlePipeline({ baton: null, requests: [{ type: "execute", stmt: { sql, args } }] } as PipelineReq, async (token) => new Db(c, { token }))) as {
    results: { type: string; response?: { result: { rows: { type: string; value?: unknown }[][] } }; error?: { message: string } }[];
  };
  const r = out.results[0]!;
  return r.type === "ok" ? { row: r.response!.result.rows[0] } : { error: r.error!.message };
};

describe("Hrana arguments whose value does not match their type", () => {
  it("are refused before the statement runs, as a user error that names the argument", async () => {
    const c = new SimCluster({ shards: 2 });
    for (const arg of [
      { type: "float", value: "abc" },
      { type: "float", value: [65, 66] },
      { type: "float", value: { a: 1 } },
      { type: "text", value: 5 },
      { type: "text", value: [65, 66] },
      { type: "blob", base64: 5 },
      { type: "blob" },
      { type: "bogus", value: 1 },
    ]) {
      const got = await execute(c, "SELECT typeof(?1) AS t, ?1 AS v", [arg]);
      expect.soft(got, JSON.stringify(arg)).toMatchObject({ error: expect.stringMatching(/argument 1|parameter 1/) });
      expect.soft(got, JSON.stringify(arg)).not.toMatchObject({ error: expect.stringMatching(/is not a function|Cannot read|undefined/) });
    }
  });
});
