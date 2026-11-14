// 新旧コードが同時に話すときの版の検査。デプロイ後も旧コードの DO が最大 300 秒動く。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyStringExact } from "../src/keys";
import { SUBSLOTS, type Interval } from "../src/routing";
import { encode } from "../src/shard/rows";
import { checkProtocol, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, VersionSkew, type Piece, type PiecePayload, type PieceWant, type Span } from "../src/types";
import { encodeTuple, realOf, typedOf } from "../src/value";

/**
 * 値の表現の見本。Worker と DO の間を、要求の引数、行イメージ、キー文字列として行き来する。どれかの表現が変わったら、
 * 新旧のコードが同じ値を別の意味に読むので、PROTOCOL_VERSION を上げ、下の表に新しい版の指紋を足す。
 */
function wireSample(): string {
  const values = [5, realOf(5), 0.5, realOf(-0), "5", "", null, new Uint8Array([0, 255]), Number.POSITIVE_INFINITY, 2 ** 53 - 1];
  // 行イメージは、表定義の列の順のタプルである (版 4 から)。
  const change = { table: "t", pk: keyStringExact([1]), sk: keyStringExact(["a"]), before: null, after: encodeTuple(values.map(typedOf)) };
  return [
    JSON.stringify(values, (_k, x) => (x instanceof Uint8Array ? { u8: [...x] } : typeof x === "number" && !Number.isFinite(x) ? String(x) : x)),
    encode(change),
    keyStringExact(values),
    moveSample(),
  ].join("\n");
}

/**
 * 範囲の移動と、所有の確かめが運ぶ形の見本 (版 3 から)。読む範囲の claim、範囲 (token の区間)、piece の名前、子が欲しい piece、
 * 運ぶデータである。型を付けてあるので、src/types.ts の形を変えると、ここが型の検査を通らなくなる。
 * 見本を直すと指紋が変わるので、版を上げることになる。
 */
function moveSample(): string {
  const g = keyStringExact(["a"]);
  const at: [string, string] = ["t", keyStringExact([1])];
  // slot の境目に揃った範囲と、ブロックの中で切った範囲。
  const range = { start: 32768 * SUBSLOTS, end: 65536 * SUBSLOTS } satisfies Interval;
  const part = { start: 7 * SUBSLOTS + 32768, end: 8 * SUBSLOTS } satisfies Interval;
  const span = { kind: "table", table: "t", claim: [range, part] } satisfies Span;
  const piece = { g, range, after: null } satisfies Piece;
  const want = [{ g, from: null }, { g, at }] satisfies PieceWant[];
  const payload = { g, range: part, after: null, upTo: at, m: 1024, rows: [{ table: "t", row: ["i1", null, "tx"] }], intents: [], schema: 3 } satisfies PiecePayload;
  return JSON.stringify([span, range, part, piece, want, payload]);
}

/** 版ごとの、見本の指紋。古い版の値は、その版のときの見本のもので、いまの見本からは作れない。 */
const WIRE: Record<number, string> = {
  2: "51cd756d252c0541",
  3: "9dadba1e69298e9c",
  4: "dfb952441f2824e0",
};

describe("protocol version", () => {
  it("accepts the current version and refuses requests older than the minimum", () => {
    expect(() => checkProtocol(PROTOCOL_VERSION)).not.toThrow();
    // 版のない要求は版 1 とみなす。版 1 の数の意味は今と違うので、再試行させる (旧コードの Worker が入れ替わるまで)。
    expect(() => checkProtocol(undefined)).toThrow(/^upgrading: /);
    expect(() => checkProtocol(MIN_PROTOCOL_VERSION - 1)).toThrow(/^upgrading: /);
  });
  it("supports the two-step upgrade: accept the new version first, send it later", () => {
    const v = PROTOCOL_VERSION;
    // 1 段目: 新しいコードの DO は版 v+1 まで受け付ける。旧コードの Worker が送る版 v も通る。
    expect(() => checkProtocol(v, v + 1)).not.toThrow();
    expect(() => checkProtocol(v + 1, v + 1)).not.toThrow();
    // 2 段目を早まると、旧コードのまま残る DO が版 v+1 を拒否し、呼び出し側は再試行する。
    expect(() => checkProtocol(v + 1, v)).toThrow(/^upgrading: /);
  });
  it("asks a newer caller to retry while the shard still runs old code", () => {
    let err: unknown;
    try {
      checkProtocol(PROTOCOL_VERSION + 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VersionSkew);
    // RPC を越えるとクラスは失われるので、Worker は文言の接頭辞で再試行を判断する。
    expect((err as Error).message).toMatch(/^upgrading: /);
    expect((err as VersionSkew).retryable).toBe(true);
  });
  it("changes the version whenever the value representation on the wire changes", () => {
    const got = createHash("sha256").update(wireSample()).digest("hex").slice(0, 16);
    expect({ version: PROTOCOL_VERSION, sample: got }).toEqual({ version: PROTOCOL_VERSION, sample: WIRE[PROTOCOL_VERSION] });
  });
});
