// M21 の遷移の条件と、src/catalog.ts の関数の突き合わせ (docs/design-catalog-epoch.md の段 1 の検査 (c))。
//
// 材料 (test/fixtures/m21/probes.json) は、test/fixtures/m21/generate.mjs が、M21 の乱択の経路の各状態で、Meta の手の候補を
// model 自身に試させた答えである。状態ごとに、Meta の手の答えに関わる model の変数 (prepE、commitE、abortE、len、acks、dead、
// drained) と、候補ごとに model が受けたか断ったかを持つ。この試験は、model の列の 3 つの表から epoch の列を組み立て、畳み、
// 同じ候補を refusal に尋ねる。
//
//   model が受ける手は、関数も受ける。
//   model が断る手は、関数も断る。ただし、model だけの条件で断られた手は数えない (下の modelOnly)。
//
// 断った手は、関数が挙げた条件ごとに数える。数が 0 の条件があれば、その条件は確かめられていないので、試験を落とす。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fold, refusal, type DdlMode, type EpochRecord, type Logged, type Refusal } from "../src/catalog";
import { REGION_TOKENS } from "../src/routing";

interface Probe {
  len: number;
  prepE: Record<string, number>;
  commitE: Record<string, number>;
  abortE: Record<string, number>;
  acks: Record<string, number[]>;
  dead: Record<string, boolean>;
  drained: boolean;
  pfenced: boolean;
  verdicts: Record<string, boolean>;
}
interface Probes {
  model: string;
  sha256: string;
  instances: { name: string; constants: Record<string, boolean>; probed: number; states: Probe[] }[];
}

const DIR = join(import.meta.dirname, "fixtures", "m21");
const probes = JSON.parse(readFileSync(join(DIR, "probes.json"), "utf8")) as Probes;

// model の番号。操作は BUILD、CHECK、DROP、SPLIT、シャードは P、Q、C。
const BUILD = 1, CHECK = 2, DROP = 3, SPLIT = 4;
const SHARD: Record<number, string> = { 1: "P", 2: "Q", 3: "C" };
const MODE: Record<number, DdlMode> = { [BUILD]: "build", [CHECK]: "trial", [DROP]: "guard" };
// 最初の範囲表。行 1 は P、行 2 は Q にある。移動は、行 1 を含む P の区間の後ろ半分を C へ移す (P にも区間が残るので、移動の後の
// シャードは P、Q、C の 3 つになる。model の shardsAt と同じ)。
const HALF = REGION_TOKENS / 2;
const MOVE = { from: "P", to: "C", start: HALF / 2, end: HALF };

/** model の列の 3 つの表から、epoch の列を組み立てる。epoch ごとに、ちょうど 1 つの記録がある。 */
function logOf(p: Probe): Logged[] {
  const log: Logged[] = [{ epoch: 0, rec: { kind: "genesis", routing: { version: 1, ranges: [{ start: 0, end: HALF, shard: "P" }, { start: HALF, end: REGION_TOKENS, shard: "Q" }] } } }];
  for (let e = 1; e <= p.len; e++) {
    const recs: EpochRecord[] = [];
    for (const op of [BUILD, CHECK, DROP, SPLIT]) {
      const [pe, ce, ae] = [p.prepE[op]!, p.commitE[op]!, p.abortE[op]!];
      if (pe === e) recs.push(op === SPLIT ? { kind: "move-start", ...MOVE } : prepareOf(op));
      if (ce === e) recs.push(op === SPLIT ? { kind: "move-end", of: pe } : { kind: "commit", of: pe });
      if (ae === e) recs.push({ kind: "abort", of: pe, reason: "model" });
    }
    if (recs.length !== 1) throw new Error(`epoch ${e} has ${recs.length} records in ${JSON.stringify(p)}`);
    log.push({ epoch: e, rec: recs[0]! });
  }
  return log;
}

function prepareOf(op: number): EpochRecord {
  return { kind: "prepare", mode: MODE[op]!, fence: ["t"], ddl: { sql: [], defs: [], drops: op === DROP ? ["t"] : [], user: null } };
}

/** model の Meta の手を、記録と、commit に添える ok のシャードにする。 */
function candidate(c: string, p: Probe): { rec: EpochRecord; acks: string[] } {
  const m = /^(prepareOp|commitOp|expire)\((\d)\)$/.exec(c);
  if (m) {
    const op = Number(m[2]);
    if (m[1] === "prepareOp") return { rec: prepareOf(op), acks: [] };
    if (m[1] === "commitOp") return { rec: { kind: "commit", of: p.prepE[op]! }, acks: p.acks[op]!.map((s) => SHARD[s]!) };
    return { rec: { kind: "abort", of: p.prepE[op]!, reason: "expired" }, acks: [] };
  }
  if (c === "startSplit") return { rec: { kind: "move-start", ...MOVE }, acks: [] };
  if (c === "endSplit") return { rec: { kind: "move-end", of: p.prepE[SPLIT]! }, acks: [] };
  throw new Error(`unknown candidate ${c}`);
}

/**
 * model が断った理由が、model だけの条件 (Meta の列からは決まらない、または model の場面の作り) でありうるなら、その説明を返す。
 * そういう手は、関数が受けても違反に数えない。これは条件を写したものではなく、数えない場合の一覧である。
 */
function modelOnly(c: string, p: Probe): string | null {
  const m = /^(prepareOp|commitOp|expire)\((\d)\)$/.exec(c);
  if (m?.[1] === "prepareOp") {
    if (p.prepE[Number(m[2])] !== 0) return "the model runs each schema change at most once (prepE(op) == 0)";
    if (p.commitE[DROP] !== 0) return "the table is dropped: the DDL parser refuses statements on it (droppedAt)";
  }
  if (m?.[1] === "commitOp" && p.dead[Number(m[2])]) return "the driver of the schema change has stopped (dead)";
  if (c === "startSplit" && p.dead[SPLIT]) return "the driver of the split has stopped (dead)";
  if (c === "endSplit" && !p.drained) return "the child has not finished receiving (END_AFTER_DRAIN): stage 4, not decided by the log";
  return null;
}

/** インスタンスの全部の状態で、model の答えと refusal の答えを比べる。違いと、受けた数、断った数 (条件ごと)、数えなかった数を返す。 */
function check(inst: Probes["instances"][number]): { wrong: string[]; accepted: number; skipped: number; refused: Map<Refusal["rule"], number> } {
  const out = { wrong: [] as string[], accepted: 0, skipped: 0, refused: new Map<Refusal["rule"], number>() };
  for (const p of inst.states) {
    const snap = fold(logOf(p));
    if (snap.epoch !== p.len) out.wrong.push(`the log of ${JSON.stringify(p)} folds to epoch ${snap.epoch}`);
    for (const [c, ok] of Object.entries(p.verdicts)) {
      const { rec, acks } = candidate(c, p);
      const r = refusal(snap, rec, acks);
      const at = `${c} at len ${p.len} prepE ${JSON.stringify(p.prepE)} commitE ${JSON.stringify(p.commitE)} abortE ${JSON.stringify(p.abortE)} acks ${JSON.stringify(p.acks)}`;
      if (ok) {
        if (r) out.wrong.push(`the model takes ${at}, but refusal says ${r.rule}`);
        else out.accepted++;
      } else if (r) {
        out.refused.set(r.rule, (out.refused.get(r.rule) ?? 0) + 1);
      } else if (modelOnly(c, p)) {
        out.skipped++;
      } else {
        out.wrong.push(`the model refuses ${at}, but refusal accepts it`);
      }
    }
  }
  return out;
}

describe("the epoch log's transition conditions (src/catalog.ts) against M21", () => {
  it("uses answers made from the current model", () => {
    const model = readFileSync(join(import.meta.dirname, "..", "..", "..", probes.model), "utf8");
    expect(createHash("sha256").update(model).digest("hex"), "specs/m21_catalog_epoch.qnt changed: run test/fixtures/m21/generate.mjs again").toBe(probes.sha256);
  });

  for (const inst of probes.instances) {
    it(`${inst.name}: refuses what the model refuses, and accepts what it accepts (${inst.states.length} states)`, () => {
      expect(check(inst).wrong.slice(0, 10)).toEqual([]);
    });
  }

  it("checks every condition at least once", () => {
    // 数え直す。ほかの it が先に走ったことに頼らない (-t で 1 つだけ流しても同じ数になる)。
    const refused = new Map<Refusal["rule"], number>();
    let accepted = 0;
    let skipped = 0;
    for (const inst of probes.instances) {
      const r = check(inst);
      accepted += r.accepted;
      skipped += r.skipped;
      for (const [k, n] of r.refused) refused.set(k, (refused.get(k) ?? 0) + n);
    }
    console.log(JSON.stringify({ accepted, skipped, refused: Object.fromEntries(refused) }));
    for (const rule of ["one-open", "ddl-waits-move", "move-waits-ddl", "one-exit", "all-acks", "owner", "move-not-open"] as const) {
      expect(refused.get(rule) ?? 0, `refusals by ${rule}`).toBeGreaterThan(0);
    }
    expect(accepted).toBeGreaterThan(0);
  });
});
