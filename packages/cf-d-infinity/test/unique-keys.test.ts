// 照合順序のキーの検査 (docs/design-unique-keys.md の段 0 の (a))。node:sqlite (シミュレータのシャードの SQLite) と sql.js (Worker の
// SQLite) で流す。手元の workerd の DO の SQLite では test/unique-keys-workerd.test.ts が流す。部品と比べ方は test/unique-keys.ts にある。
//
// キーの関数は段 1 で入る。それまでは、ここにある参照の実装が通り、わざと壊した実装が全部落ちることを確かめる。段 1 は、入れた関数を
// referenceKey と並べて judgeAll に渡す (参照の実装は残す。壊した実装が落ちることは、比べ方の確かめとして残す)。
import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { BROKEN, collect, corpus, engineDifferences, judgeAll, nodeEngine, referenceKey, setups, sqljsEngine } from "./unique-keys";

describe("the collation key oracle, on node:sqlite and sql.js", () => {
  const values = corpus();
  const results = new Map<string, Awaited<ReturnType<typeof collect>>>();
  beforeAll(async () => {
    const SQL = await initSqlJs();
    for (const e of [nodeEngine(), sqljsEngine(SQL)]) results.set(e.name, await collect(e, values));
  });

  it("stores every value as it was written", () => {
    for (const r of results.values()) expect(r.loaded).toEqual([]);
  });

  it("sees the UNIQUE index and = agree on each engine", () => {
    for (const r of results.values()) expect(r.self).toEqual([]);
  });

  it("sees the same classes on both engines", () => {
    const [a, b] = [...results.entries()];
    expect(setups(values).flatMap((s) => engineDifferences(a![0], a![1].classes.get(s.name)!, b![0], b![1].classes.get(s.name)!, s))).toEqual([]);
  });

  it("passes the reference key function", () => {
    for (const [name, r] of results) expect(judgeAll(referenceKey, name, r.classes, values)).toEqual([]);
  });

  for (const [how, key] of Object.entries(BROKEN)) {
    it(`rejects a key function broken by ${how}`, () => {
      for (const [name, r] of results) {
        const problems = judgeAll(key, name, r.classes, values);
        console.log(`UNIQUE-KEYS ${name} rejects "${how}": ${problems.length} findings, first: ${problems[0]}`);
        expect(problems.length, `${how} on ${name}`).toBeGreaterThan(0);
      }
    });
  }

  it("reports the size of each setup", () => {
    for (const [name, r] of results) {
      for (const s of setups(values)) {
        const c = r.classes.get(s.name)!;
        console.log(`UNIQUE-KEYS ${name} ${s.name}: ${c.tuples.length} values, ${c.survivors.size} kept by the UNIQUE index, ${c.pairs.size} equal pairs under =`);
      }
    }
  });
});
