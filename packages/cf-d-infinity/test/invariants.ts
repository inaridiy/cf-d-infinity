// シミュレータの試験の終わりに確かめる不変条件。
// 並行の試験は履歴が直列化可能かを見るが、それだけでは「確定したのに適用できない取引」や
// 「本体とずれた index」を見逃す。全部の要求が終わった後の静止した状態で、後始末が済んでいることを確かめる。
import { expect } from "vitest";
import { ORPHAN_AGE_MS } from "../src/shard/core";
import { encode } from "../src/shard/rows";
import type { Row } from "../src/types";
import type { SimCluster } from "./sim";

const tryExec = (b: { exec(sql: string): Row[] }, sql: string): Row[] => {
  try {
    return b.exec(sql);
  } catch (e) {
    if (/no such table/.test(String(e))) return [];
    throw e;
  }
};

/**
 * 残った仕事を再駆動で片付ける。DO の alarm に当たる。
 * anchor が決着を送り損ねた intent は、ORPHAN_AGE_MS より古くなってから問い合わせる作りなので、時計を進めてから回す。
 */
export async function drain(c: SimCluster, rounds = 6): Promise<void> {
  await c.settle();
  // HLC は再起動のたびに保存済みの上限 (最大 1 秒先) から再開するので、再起動を繰り返す試験では物理時刻より
  // 何秒も先へ進んでいる。prepare_ts はその HLC の値なので、ORPHAN_AGE_MS だけ進めても「古い」と判定されない。
  c.ahead += ORPHAN_AGE_MS + 60_000;
  for (let i = 0; i < rounds; i++) {
    await c.settle();
    let more = false;
    for (const core of c.cores.values()) more = (await core.redrive()) || more;
    await c.settle();
    if (!more) return;
  }
}

/** 静止した状態の問題点を集める。空なら健全である。 */
export async function quiescentProblems(c: SimCluster): Promise<string[]> {
  await drain(c);
  const problems: string[] = [];
  for (const [id, b] of c.backends) {
    const intents = b.exec(`SELECT txn, tbl, pk FROM __intents`);
    if (intents.length) problems.push(`${id}: ${intents.length} intents remain, e.g. ${JSON.stringify(intents[0])}`);
    const open = b.exec(`SELECT txn FROM __txn WHERE status = 'committed' AND done = 0`);
    if (open.length) problems.push(`${id}: ${open.length} committed transactions were never fully applied, e.g. ${open[0]!.txn}`);
    const errors = c.cores.get(id)?.lastRedriveErrors ?? [];
    if (errors.length) problems.push(`${id}: redrive keeps failing: ${errors[0]}`);
  }

  // グローバル index は本体と一致する。書き込み専用の間は backfill が済んでいないので、余分な行がないことだけを見る。
  const cat = await c.catalog();
  for (const def of Object.values(cat.tables)) {
    for (const ix of def.globalIndexes) {
      const expected = new Set<string>();
      const actual = new Set<string>();
      for (const b of c.backends.values()) {
        for (const row of tryExec(b, `SELECT * FROM "${def.name}"`)) {
          const vals = ix.columns.map((col) => row[col] ?? null);
          if (vals.some((v) => v === null)) continue;
          expected.add(`${encode(vals)} -> ${encode(def.pk.map((col) => row[col] ?? null))}`);
        }
        for (const row of tryExec(b, `SELECT "k", "pk" FROM "${ix.table}"`)) actual.add(`${row.k} -> ${row.pk}`);
      }
      const dangling = [...actual].filter((e) => !expected.has(e));
      const missing = [...expected].filter((e) => !actual.has(e));
      if (dangling.length) problems.push(`index ${ix.name}: ${dangling.length} entries point at no row, e.g. ${dangling[0]}`);
      if (ix.state === "public" && missing.length) problems.push(`index ${ix.name}: ${missing.length} rows are not indexed, e.g. ${missing[0]}`);
    }
    // シャード内の UNIQUE は SQLite が守る。ここではシャードを跨いだ UNIQUE (public な UNIQUE のグローバル index) の重複を見る。
    for (const ix of def.globalIndexes.filter((i) => i.state === "public")) {
      const seen = new Map<string, number>();
      for (const b of c.backends.values()) {
        for (const row of tryExec(b, `SELECT * FROM "${def.name}"`)) {
          const vals = ix.columns.map((col) => row[col] ?? null);
          if (vals.some((v) => v === null)) continue;
          seen.set(encode(vals), (seen.get(encode(vals)) ?? 0) + 1);
        }
      }
      const dup = [...seen].filter(([, n]) => n > 1);
      if (dup.length) problems.push(`unique index ${ix.name}: ${dup.length} values appear more than once, e.g. ${dup[0]![0]}`);
    }
  }
  return problems;
}

export async function expectQuiescent(c: SimCluster): Promise<void> {
  expect(await quiescentProblems(c)).toEqual([]);
}
