// 同期の SHA-256 (src/sha256.ts) を node:crypto と突き合わせる。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256, sha256Text } from "../src/sha256";
import { prng } from "./sim";

describe("sha256", () => {
  it("matches node:crypto on the standard vectors and on random inputs of every length around the block size", () => {
    expect(sha256Text("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const r = prng(1);
    for (let n = 0; n < 300; n++) {
      const data = Uint8Array.from({ length: n < 200 ? n : n * 37 }, () => Math.floor(r() * 256));
      expect(sha256(data)).toBe(createHash("sha256").update(data).digest("hex"));
    }
    expect(sha256Text("あいう")).toBe(createHash("sha256").update("あいう", "utf8").digest("hex"));
  });
});
