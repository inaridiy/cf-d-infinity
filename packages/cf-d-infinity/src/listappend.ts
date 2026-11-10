// 黒箱の直列化可能性検査 (bench/elle.mjs) のための負荷。計測用の Worker とシミュレータで共用する。
// キーごとのリストへ一意の要素を追記し、読み取りはリスト全体を返す。キーは時間の窓ごとに入れ替えて、リストを短く保つ。
// 取引は楽観的 (Db.transaction の自動リトライ)、悲観的 (BEGIN IMMEDIATE)、autocommit の 3 種類を混ぜる。
import type { Db } from "./client/db";

export type Op = ["r", number, string[] | null] | ["a", number, string];
export interface Record_ { id: string; type: "ok" | "fail" | "info"; ops: Op[]; mode: string; error?: string }

/** 確定していないことが確かな失敗か。それ以外 (通信の断、DO の再起動) は結果が分からないものとして扱う。 */
const definitelyAborted = (m: string) =>
  /^(conflict|read too old|not owner|migrating|upgrading|cannot|no such|UNIQUE|NOT NULL)/i.test(m) || /SQLITE_BUSY/.test(m);

export interface ListAppendOpts {
  lanes: number;
  /** この時刻 (ms) まで流す。 */
  until?: number;
  /** レーンごとの取引数。until の代わりに使う (シミュレータ向け)。 */
  ops?: number;
  epochMs?: number;
  keysPerEpoch?: number;
  rnd?: () => number;
  now?: () => number;
  tag?: string;
}

export async function runListAppend(newDb: () => Db, o: ListAppendOpts): Promise<{ history: Record_[]; failures: Record<string, number>; count: number }> {
  const rnd = o.rnd ?? Math.random;
  const now = o.now ?? Date.now;
  const inv = o.tag ?? crypto.randomUUID().slice(0, 8);
  const history: Record_[] = [];
  const failures: Record<string, number> = {};
  const epochMs = o.epochMs ?? 20000;
  const width = o.keysPerEpoch ?? 32;
  let seq = 0;
  const pick = () => Math.floor(now() / epochMs) * 1000 + Math.floor(rnd() * width);
  const read = async (q: { query: Db["query"] }, k: number): Promise<string[]> => {
    const v = (await q.query("SELECT v FROM jep WHERE k = ? AND id = 1", [k])).rows[0]?.v as string | undefined;
    return v ? v.split(",") : [];
  };
  const append = (q: { query: Db["query"] }, k: number, e: string) =>
    q.query("INSERT INTO jep(k, id, v) VALUES (?, 1, ?) ON CONFLICT(k, id) DO UPDATE SET v = v || ',' || excluded.v", [k, e]);
  const plan = () => {
    const keys = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, pick))];
    const readOnly = rnd() < 0.25;
    return keys.map((k) => ({ k, read: readOnly || rnd() < 0.6, write: !readOnly && rnd() < 0.7 }));
  };
  const note = (m: string) => (failures[m.slice(0, 80)] = (failures[m.slice(0, 80)] ?? 0) + 1);

  await Promise.all(Array.from({ length: o.lanes }, async () => {
    for (let done = 0; o.ops !== undefined ? done < o.ops : now() < (o.until ?? 0); done++) {
      const n = seq++;
      const steps = plan();
      const mode = rnd() < 0.15 ? "auto" : rnd() < 0.5 ? "optimistic" : "pessimistic";
      const db = newDb();
      if (mode === "auto") {
        const k = steps[0]!.k;
        const rec: Record_ = { id: `${inv}-${n}-0`, type: "ok", mode, ops: [["a", k, `${inv}-${n}-0`]] };
        try {
          await append(db, k, rec.id);
        } catch (e) {
          const m = String((e as Error)?.message ?? e);
          note(m);
          rec.type = definitelyAborted(m) ? "fail" : "info";
          rec.error = m.slice(0, 120);
        }
        history.push(rec);
        continue;
      }
      if (mode === "optimistic") {
        let current: Record_ | null = null;
        let attempt = 0;
        try {
          await db.transaction(async (tx) => {
            // 前の試行は再試行できる失敗で終わっている。Db は確定していない失敗しか再試行しない。
            if (current) {
              current.type = "fail";
              history.push(current);
            }
            const rec: Record_ = { id: `${inv}-${n}-${attempt++}`, type: "ok", mode, ops: [] };
            current = rec;
            for (const s of steps) {
              if (s.read) rec.ops.push(["r", s.k, await read(tx, s.k)]);
              if (s.write) {
                await append(tx, s.k, rec.id);
                rec.ops.push(["a", s.k, rec.id]);
                if (rnd() < 0.3) rec.ops.push(["r", s.k, await read(tx, s.k)]);
              }
            }
          });
          history.push(current!);
        } catch (e) {
          const m = String((e as Error)?.message ?? e);
          note(m);
          if (current) {
            (current as Record_).type = definitelyAborted(m) ? "fail" : "info";
            (current as Record_).error = m.slice(0, 120);
            history.push(current);
          }
        }
        continue;
      }
      // 悲観的: BEGIN IMMEDIATE の対話的な取引。再試行は自前で行う。
      for (let attempt = 0; attempt < 5; attempt++) {
        const rec: Record_ = { id: `${inv}-${n}-${attempt}`, type: "ok", mode, ops: [] };
        let committing = false;
        try {
          await db.query("BEGIN IMMEDIATE");
          for (const s of steps) {
            if (s.read) rec.ops.push(["r", s.k, await read(db, s.k)]);
            if (s.write) {
              await append(db, s.k, rec.id);
              rec.ops.push(["a", s.k, rec.id]);
            }
          }
          committing = true;
          await db.query("COMMIT");
          history.push(rec);
          break;
        } catch (e) {
          const m = String((e as Error)?.message ?? e);
          note(m);
          if (db.inTransaction) await db.query("ROLLBACK").catch(() => db.abandon());
          // COMMIT より前の失敗は確定していない。COMMIT の失敗は文言で分ける。
          rec.type = !committing || definitelyAborted(m) ? "fail" : "info";
          rec.error = m.slice(0, 120);
          history.push(rec);
          if (rec.type === "info" || !definitelyAborted(m)) break;
        }
      }
    }
  }));
  return { history, failures, count: history.filter((h) => h.type === "ok").length };
}

