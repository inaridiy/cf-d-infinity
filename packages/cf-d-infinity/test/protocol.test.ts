// 新旧コードが同時に話すときの版の検査。デプロイ後も旧コードの DO が最大 300 秒動く。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyString } from "../src/keys";
import { encode } from "../src/shard/rows";
import { checkProtocol, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, VersionSkew } from "../src/types";
import { realOf } from "../src/value";

/**
 * 値の表現の見本。Worker と DO の間を、要求の引数、行イメージ、キー文字列として行き来する。どれかの表現が変わったら、
 * 新旧のコードが同じ値を別の意味に読むので、PROTOCOL_VERSION を上げ、下の表に新しい版の指紋を足す。
 */
function wireSample(): string {
  const values = [5, realOf(5), 0.5, realOf(-0), "5", "", null, new Uint8Array([0, 255]), Number.POSITIVE_INFINITY, 2 ** 53 - 1];
  const change = { table: "t", pk: keyString([1]), sk: keyString(["a"]), before: null, after: Object.fromEntries(values.map((v, i) => [`c${i}`, v])) };
  return [
    JSON.stringify(values, (_k, x) => (x instanceof Uint8Array ? { u8: [...x] } : typeof x === "number" && !Number.isFinite(x) ? String(x) : x)),
    encode(change),
    keyString(values),
  ].join("\n");
}
const WIRE: Record<number, string> = {
  2: "51cd756d252c0541",
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
