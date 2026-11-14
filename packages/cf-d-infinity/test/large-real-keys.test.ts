// 2^53 以上の整数の値の REAL を主キーに持つ行 (値の作り直しの段 2)。
//
// K1 が断るのは、格納の型が INTEGER の 2^53 以上の値だけで、整数の値の REAL (2^60 など) は保存できる。そのキー文字列は、
// 整数の数字で書く (`[1152921504606846976]`。src/keys.ts の keyString)。読み戻す keyValues は整数を INTEGER (bigint) で返すので、
// 今の Value に戻す keyParams が、JS の数に正確に戻す。2^53 以上の INTEGER を断る橋 (fromTypedValue) をキーに通すと、こういう行は
// 引けなくなる。ここでは、キーで書き換え、消し、取引の中で読み、分割で運んでも、行が引けることを確かめる。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { realOf } from "../src/value";
import { SimCluster } from "./sim";

const KEYS = [2 ** 60, 2 ** 60 + 2 ** 8, 1e17, -(2 ** 62), 2 ** 53, 2 ** 63 - 2 ** 10];

describe("rows keyed by integral REALs beyond 2^53", () => {
  it("are found by key through updates, deletes, transactions and a split", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    // 型のない主キーの列には、REAL がそのまま入る。
    await db.ddl("CREATE TABLE r(k PRIMARY KEY, v INTEGER)");
    for (const [i, k] of KEYS.entries()) await db.query("INSERT INTO r VALUES (?, ?)", [realOf(k), i]);
    const read = async () => (await db.query("SELECT typeof(k) AS t, k, v FROM r ORDER BY k")).rows;
    const want = (vs: Map<number, number>) => [...vs].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ t: "real", k, v }));
    const state = new Map(KEYS.map((k, i) => [k, i]));
    expect(await read()).toEqual(want(state));
    // 主キーで書き換える (RETURNING の捕捉) と、主キーで消す。
    await db.query("UPDATE r SET v = v + 10 WHERE k = ?", [realOf(2 ** 60)]);
    state.set(2 ** 60, 10);
    await db.query("DELETE FROM r WHERE k = ?", [realOf(1e17)]);
    state.delete(1e17);
    // 主キーで 1 行に絞れない文 (trigger の捕捉)。
    await db.query("UPDATE r SET v = v + 100 WHERE v >= 4");
    for (const [k, v] of state) if (v >= 4) state.set(k, v + 100);
    expect(await read()).toEqual(want(state));
    // 取引の中で読み、書く。書いた行は取引が溜めた変更から読む。
    await db.transaction(async (tx) => {
      expect((await tx.query("SELECT v FROM r WHERE k = ?", [realOf(2 ** 60 + 2 ** 8)])).rows).toEqual([{ v: 1 }]);
      await tx.query("UPDATE r SET v = 7 WHERE k = ?", [realOf(2 ** 60 + 2 ** 8)]);
      expect((await tx.query("SELECT v FROM r WHERE k = ?", [realOf(2 ** 60 + 2 ** 8)])).rows).toEqual([{ v: 7 }]);
    });
    state.set(2 ** 60 + 2 ** 8, 7);
    // 分割で運ぶ。運んだ行も、キーで引ける。
    await split(c, "s0", "s2");
    await split(c, "s1", "s3");
    expect(await read()).toEqual(want(state));
    for (const [k, v] of state) expect((await db.query("SELECT v FROM r WHERE k = ?", [realOf(k)])).rows, String(k)).toEqual([{ v }]);
    await c.settle();
  });
});
