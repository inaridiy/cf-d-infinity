// 新旧コードが同時に話すときの版の検査。デプロイ後も旧コードの DO が最大 300 秒動く。
import { describe, expect, it } from "vitest";
import { checkProtocol, PROTOCOL_VERSION, VersionSkew } from "../src/types";

describe("protocol version", () => {
  it("accepts requests without a version as version 1, and the current version", () => {
    expect(() => checkProtocol(undefined)).not.toThrow();
    expect(() => checkProtocol(PROTOCOL_VERSION)).not.toThrow();
  });
  it("supports the two-step upgrade: accept the new version first, send it later", () => {
    // 1 段目: 新しいコードの DO は版 2 まで受け付ける。旧コードの Worker が送る版 1 も通る。
    expect(() => checkProtocol(1, 2)).not.toThrow();
    expect(() => checkProtocol(2, 2)).not.toThrow();
    // 2 段目を早まると、旧コードのまま残る DO が版 2 を拒否し、呼び出し側は再試行する。
    expect(() => checkProtocol(2, 1)).toThrow(/^upgrading: /);
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
});
