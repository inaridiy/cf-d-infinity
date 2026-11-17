// 新旧コードが同時に話すときの版の検査。デプロイ後も旧コードの DO が最大 300 秒動く。
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyString } from "../src/keys";
import { SUBSLOTS, type Interval } from "../src/routing";
import { encode } from "../src/shard/rows";
import { checkProtocol, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, VersionSkew, type ExecReq, type ExecRes, type Piece, type PiecePayload, type PieceWant, type ShardApi, type Span } from "../src/types";
import { encodeTuple } from "../src/value";

/**
 * 値の表現の見本。Worker と DO の間を、要求の引数、行イメージ、キー文字列として行き来する。どれかの表現が変わったら、
 * 新旧のコードが同じ値を別の意味に読むので、PROTOCOL_VERSION を上げ、下の表に新しい版の指紋を足す。
 */
function wireSample(): string {
  // 値は、JS の型が格納の型である (版 5 から)。bigint は INTEGER、number は REAL。
  const values = [5n, 5, 0.5, -0, "5", "", null, new Uint8Array([0, 255]), Number.POSITIVE_INFINITY, 2n ** 53n - 1n, 2n ** 63n - 1n, -(2n ** 63n)];
  // 行イメージは、表定義の列の順のタプルである (版 4 から)。
  const change = { table: "t", pk: keyString([1n]), sk: keyString(["a"]), before: null, after: encodeTuple(values) };
  // 読みの要求は、結果の列名を運ぶ (版 5 から)。条件の範囲の引数には bigint が入る。
  // 要求は、Worker のスナップショットの epoch (版 6 から) と、頼るものごとの epoch を運ぶ (版 10 から。docs/design-catalog-epoch.md の
  // 「表ごとの epoch」)。遷移の仕事の要求は、prepare の epoch を atLeast で運ぶ。
  const read = {
    sql: "SELECT a, b FROM t WHERE a = ?", params: [5n], columns: ["a", "b"], spans: [{ kind: "pred", table: "t", alias: "t", where: "a = ?", params: [5n, 2.5] }],
    deps: [{ name: "t", epoch: 4 }, { name: "u", epoch: 6, write: true }], epoch: 7, atLeast: 9,
    // 悲観の取引の要求は、取引の lease (版と残り) を運ぶ (版 10 から。docs/design-lock-lease.md)。ロックを取る要求は lock の中に、取引が
    // 行ロックを持つ表 (holds) と一緒に運ぶ。
    lease: { txn: "t-1", epoch: 2, ms: 6500 }, lock: { txn: "t-1", start: 1000, lease: { epoch: 2, ms: 6500 }, holds: ["u"] },
  } satisfies Partial<ExecReq>;
  const renew: Parameters<ShardApi["renew"]>[0] = { txn: "t-1", lease: { epoch: 3, ms: 7500 } };
  // 読みの時刻を進める確かめも、読んだ表の epoch を運ぶ (版 10 から)。
  const refresh: Parameters<ShardApi["refresh"]>[0] = { txn: "t-1", spans: [{ kind: "table", table: "t" }], from: 5, to: 9, deps: [{ name: "t", epoch: 4 }] };
  // 書き込みの応答は、文が入れた行を、入れた順に運ぶ (版 7 から。lastInsertRowid はこれだけから決める)。
  const written = { changes: [change], inserted: [{ table: "t", pk: keyString([1n]) }], count: 1 } satisfies Partial<ExecRes>;
  // 表定義の遷移の prepare を適用したかを尋ねる要求と、その答え (版 8 から。docs/design-catalog-epoch.md の段 3)。
  const prepared: [Parameters<ShardApi["prepared"]>[0], Awaited<ReturnType<ShardApi["prepared"]>>] = [{ epoch: 9 }, { ok: false, reason: "CHECK constraint failed" }];
  return [
    JSON.stringify(values, (_k, x) => (x instanceof Uint8Array ? { u8: [...x] } : typeof x === "bigint" ? { int: String(x) } : typeof x === "number" && !Number.isFinite(x) ? String(x) : x)),
    encode(change),
    keyString(values),
    encode(read),
    moveSample(),
    encode(written),
    encode(prepared),
    encode(renew),
    encode(refresh),
  ].join("\n");
}

/**
 * 範囲の移動と、所有の確かめが運ぶ形の見本 (版 3 から)。読む範囲の claim、範囲 (token の区間)、piece の名前、子が欲しい piece、
 * 運ぶデータである。型を付けてあるので、src/types.ts の形を変えると、ここが型の検査を通らなくなる。
 * 見本を直すと指紋が変わるので、版を上げることになる。
 */
function moveSample(): string {
  const g = keyString(["a"]);
  const at: [string, string] = ["t", keyString([1])];
  // slot の境目に揃った範囲と、ブロックの中で切った範囲。
  const range = { start: 32768 * SUBSLOTS, end: 65536 * SUBSLOTS } satisfies Interval;
  const part = { start: 7 * SUBSLOTS + 32768, end: 8 * SUBSLOTS } satisfies Interval;
  const span = { kind: "table", table: "t", claim: [range, part] } satisfies Span;
  // piece は、運ぶ移動の move-start の epoch を持つ (版 9 から。docs/design-catalog-epoch.md の段 4)。
  const piece = { g, range, after: null, epoch: 11 } satisfies Piece;
  const want = [{ g, from: null }, { g, at }] satisfies PieceWant[];
  const payload = { g, range: part, after: null, epoch: 11, upTo: at, m: 1024, rows: [{ table: "t", row: ["i1", null, "tx"] }], intents: [], schema: 3 } satisfies PiecePayload;
  // 子から親への移動の要求は move-start の epoch を運び、進める側の drain も、その epoch を名指しする (版 9 から)。
  const pull = { ...range, want, to: "s1", maxBytes: 1_000_000, epoch: 11 } satisfies Parameters<ShardApi["pull"]>[0];
  const drain = { ...range, epoch: 11 } satisfies Parameters<ShardApi["drain"]>[0];
  return JSON.stringify([span, range, part, piece, want, payload, pull, drain]);
}

/** 版ごとの、見本の指紋。古い版の値は、その版のときの見本のもので、いまの見本からは作れない。 */
const WIRE: Record<number, string> = {
  2: "51cd756d252c0541",
  3: "9dadba1e69298e9c",
  4: "dfb952441f2824e0",
  5: "9f3b7b3e9eaa9b09",
  6: "3ef766de45822d5c",
  7: "ada064f16f3fde8e",
  8: "edeccd61efb19a77",
  9: "4e20b5834a72831a",
  10: "fb3d9f42b31bd937",
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
