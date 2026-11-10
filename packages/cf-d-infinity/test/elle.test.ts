// 黒箱の検査器 (bench/elle.mjs) の検出力。既知の異常を仕込んだ履歴を、それぞれ検出できること。
import { describe, expect, it } from "vitest";
// @ts-expect-error -- JavaScript のモジュール
import { check } from "../bench/elle.mjs";

type Op = ["r", string, string[] | null] | ["a", string, string];
const ok = (id: string, ops: Op[]) => ({ id, type: "ok" as const, ops });
const kinds = (h: unknown[], o = {}) => Object.keys(check(h, o).anomalies).sort();

describe("list-append checker", () => {
  it("accepts a serializable history", () => {
    const h = [
      ok("t1", [["a", "x", "1"]]),
      ok("t2", [["r", "x", ["1"]], ["a", "x", "2"], ["r", "x", ["1", "2"]]]),
      ok("t3", [["r", "x", ["1", "2"]], ["r", "y", []], ["a", "y", "3"]]),
      { id: "t4", type: "fail", ops: [["a", "y", "4"]] },
      { id: "t5", type: "info", ops: [["a", "y", "5"]] },
    ];
    const r = check(h, { finalReads: { x: ["1", "2"], y: ["3", "5"] } });
    expect(r.anomalies).toEqual({});
    expect(r.stats.infoCommitted).toBe(1);
  });

  it("detects reading an aborted write (G1a)", () => {
    expect(kinds([{ id: "t1", type: "fail", ops: [["a", "x", "1"]] }, ok("t2", [["r", "x", ["1"]]])])).toEqual(["G1a-aborted-read"]);
  });

  it("detects a lost committed append", () => {
    expect(kinds([ok("t1", [["a", "x", "1"]]), ok("t2", [["a", "x", "2"]])], { finalReads: { x: ["2"] } })).toEqual(["lost-append"]);
  });

  it("detects reads that disagree on the version order", () => {
    expect(kinds([ok("t1", [["a", "x", "1"]]), ok("t2", [["a", "x", "2"]]), ok("t3", [["r", "x", ["1", "2"]]]), ok("t4", [["r", "x", ["2"]]])]))
      .toContain("incompatible-order");
  });

  it("detects write skew (G2)", () => {
    // t1 と t2 がそれぞれ相手のキーの空を読んでから自分のキーに書く。どちらの順でも矛盾する。
    const h = [
      ok("t1", [["r", "y", []], ["a", "x", "1"]]),
      ok("t2", [["r", "x", []], ["a", "y", "2"]]),
      ok("t3", [["r", "x", ["1"]], ["r", "y", ["2"]]]),
    ];
    expect(kinds(h)).toEqual(["G2-anti-dependency-cycle"]);
  });

  it("detects a non-atomic read across keys (G1c / G2)", () => {
    // t1 が x と y に書き、t2 は x の新しい値と y の古い値を同時に見る。
    const h = [
      ok("t0", [["a", "x", "0"], ["a", "y", "00"]]),
      ok("t1", [["a", "x", "1"], ["a", "y", "11"]]),
      ok("t2", [["r", "x", ["0", "1"]], ["r", "y", ["00"]]]),
      ok("t3", [["r", "y", ["00", "11"]]]),
    ];
    expect(kinds(h).some((k) => k.startsWith("G"))).toBe(true);
  });

  it("detects a write cycle (G0)", () => {
    const h = [
      ok("t1", [["a", "x", "1"], ["a", "y", "2"]]),
      ok("t2", [["a", "x", "3"], ["a", "y", "4"]]),
      ok("r", [["r", "x", ["1", "3"]], ["r", "y", ["4", "2"]]]),
    ];
    expect(kinds(h)).toEqual(["G0-write-cycle"]);
  });

  it("detects an internal read that misses the transaction's own append", () => {
    expect(kinds([ok("t1", [["a", "x", "1"], ["r", "x", []]])])).toContain("internal");
  });
});
