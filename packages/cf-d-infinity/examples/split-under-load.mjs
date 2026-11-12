#!/usr/bin/env node
// デモ: 書き込みが続く中でシャードを割っていっても、答えが変わらないこと。
//
//   npm run demo
//
// 本物の workerd と Durable Objects (Miniflare) を、この計算機の上で動かす。Cloudflare のアカウントは要らない。
// シャード 1 つから始め、口座の表 (シャードをまたぐ UNIQUE の列を持つ) に、何人もの書き手が、シャードをまたぐ取引で
// お金を動かし続ける。その最中に、シャードを 1 → 2 → 4 → 8 と割る。見張り役は、合計残高が変わらないことと、
// 同じ持ち主の口座をもう 1 つ作れないことを、確かめ続ける。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { Miniflare } from "miniflare";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNTS = 200;
const START = 100;
const WRITERS = 6;
const ROUNDS = 3; // 1 → 2 → 4 → 8
const LOAD_MS = Number(process.env.DEMO_LOAD_MS ?? 2500); // 割る前と、割り終えた後に負荷をかける時間

const say = (s) => process.stdout.write(`${s}\n`);
say("bundling the Worker ...");
execFileSync("npm", ["run", "-s", "bundle"], { cwd: root, stdio: "ignore" });

const mf = new Miniflare({
  modules: [
    { type: "ESModule", path: "dist/worker.js", contents: readFileSync(join(root, "dist/worker.js"), "utf8") },
    { type: "CompiledWasm", path: "dist/sql-wasm.wasm", contents: readFileSync(join(root, "src/sql-wasm.wasm")) },
  ],
  compatibilityDate: "2026-07-01",
  bindings: { DINF_SHARD_COUNT: "1", DINF_API_TOKEN: "demo", DINF_ADMIN_TOKEN: "demo-admin" },
  durableObjects: {
    DINF_SHARD: { className: "DinfShard", useSQLite: true },
    DINF_META: { className: "DinfMeta", useSQLite: true },
    DINF_AUTOSCALER: { className: "DinfAutoscaler", useSQLite: true },
  },
});
const url = (await mf.ready).toString().replace(/\/$/, "");
const admin = async (path, body = {}) => {
  const r = await fetch(`${url}${path}`, { method: "POST", headers: { authorization: "Bearer demo-admin" }, body: JSON.stringify(body) });
  const json = await r.json();
  if (r.status !== 200) throw new Error(`${path}: ${json.error ?? r.status}`);
  return json;
};
const client = () => createClient({ url, authToken: "demo", intMode: "number" });

// 持ち主の列は UNIQUE で、行の置き場所を決める列 (id) を含まない。だから一意性はシャードをまたいで守る必要がある。
const db = client();
await db.execute("CREATE TABLE accounts(id INTEGER PRIMARY KEY, owner TEXT NOT NULL UNIQUE, balance INTEGER NOT NULL)");
for (let i = 0; i < ACCOUNTS; i += 50) {
  const ids = Array.from({ length: 50 }, (_, k) => i + k + 1);
  await db.execute({ sql: `INSERT INTO accounts VALUES ${ids.map(() => "(?, ?, ?)").join(", ")}`, args: ids.flatMap((id) => [BigInt(id), `owner-${id}`, BigInt(START)]) });
}
const TOTAL = ACCOUNTS * START;

// 失敗の分類。競合と、範囲表が古いこと (分割の直後) は、取引をやり直せばよい。
const retryable = (e) => /SQLITE_BUSY|conflict|not owner|migrating|read too old|moved at|schema busy|split busy/i.test(String(e?.message ?? e));
const stats = { committed: 0, retried: 0, checks: 0, refused: 0, waited: 0, wrong: [] };
let running = true;

async function writer(n) {
  const c = client();
  let seed = n * 7919 + 1;
  const rand = (m) => ((seed = (seed * 48271) % 2147483647) % m);
  while (running) {
    const a = 1 + rand(ACCOUNTS);
    const b = 1 + ((a + rand(ACCOUNTS - 1)) % ACCOUNTS);
    const tx = await c.transaction("write");
    try {
      const have = Number((await tx.execute({ sql: "SELECT balance FROM accounts WHERE id = ?", args: [BigInt(a)] })).rows[0].balance);
      const amount = Math.min(have, 1 + rand(20));
      await tx.execute({ sql: "UPDATE accounts SET balance = balance - ? WHERE id = ?", args: [BigInt(amount), BigInt(a)] });
      await tx.execute({ sql: "UPDATE accounts SET balance = balance + ? WHERE id = ?", args: [BigInt(amount), BigInt(b)] });
      await tx.commit();
      stats.committed++;
    } catch (e) {
      tx.close();
      if (retryable(e)) stats.retried++;
      else stats.wrong.push(`transfer: ${e.message}`);
    }
  }
}

async function watcher() {
  const c = client();
  while (running) {
    try {
      const r = (await c.execute("SELECT sum(balance) AS total, count(*) AS n, min(balance) AS low FROM accounts")).rows[0];
      stats.checks++;
      if (Number(r.total) !== TOTAL || Number(r.n) !== ACCOUNTS || Number(r.low) < 0) stats.wrong.push(`snapshot: total ${r.total}, rows ${r.n}, lowest ${r.low}`);
    } catch (e) {
      if (retryable(e)) stats.waited++;
      else stats.wrong.push(`check: ${e.message}`);
    }
    const owner = `owner-${1 + (stats.checks % ACCOUNTS)}`;
    try {
      await c.execute({ sql: "INSERT INTO accounts(id, owner, balance) VALUES (?, ?, 0)", args: [BigInt(100000 + stats.checks), owner] });
      stats.wrong.push(`a second account for ${owner} was accepted`);
    } catch (e) {
      if (/UNIQUE constraint failed/.test(e.message)) stats.refused++;
      else if (retryable(e)) stats.waited++;
      else stats.wrong.push(`duplicate: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const shardsNow = async () => (await admin("/admin/status")).shards;
say(`${ACCOUNTS} accounts, ${TOTAL} in total, on ${(await shardsNow()).length} shard; ${WRITERS} writers start moving money`);
const t0 = Date.now();
const work = [...Array.from({ length: WRITERS }, (_, i) => writer(i)), watcher()];
let next = 1;
for (let round = 0; round < ROUNDS; round++) {
  await new Promise((r) => setTimeout(r, LOAD_MS));
  const before = await shardsNow();
  for (const parent of before) {
    const child = `shard-${next++}`;
    for (let attempt = 0; ; attempt++) {
      try {
        await admin("/admin/split", { parent, child });
        break;
      } catch (e) {
        if (attempt >= 20 || !retryable(e)) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
  const after = await shardsNow();
  say(`  ${((Date.now() - t0) / 1000).toFixed(1)} s: split ${before.length} → ${after.length} shards while writing (${stats.committed} transfers so far)`);
}
// 割り終えた後の 1 秒ごとの確定の数。割った直後に詰まって、戻るかを見る。
const perSecond = [];
const checksPerSecond = [];
for (let at = stats.committed, seen = stats.checks, i = 0; i < Math.ceil(LOAD_MS / 1000); i++) {
  await new Promise((r) => setTimeout(r, 1000));
  perSecond.push(stats.committed - at);
  checksPerSecond.push(stats.checks - seen);
  at = stats.committed;
  seen = stats.checks;
}
running = false;
await Promise.all(work);

const final = (await db.execute("SELECT sum(balance) AS total, count(*) AS n FROM accounts")).rows[0];
const owners = (await db.execute("SELECT count(DISTINCT owner) AS n FROM accounts")).rows[0];
say("");
say(`shards:              1 → ${(await shardsNow()).length}, split under load`);
say(`transfers committed: ${stats.committed} transactions, most of them across shards after the first split (${stats.retried} conflicts retried)`);
say(`after the last split: ${perSecond.join(", ")} transfers per second; ${checksPerSecond.join(", ")} snapshot reads per second`);
say(`snapshots checked:   ${stats.checks}, every one totalling ${TOTAL} (${stats.waited} retried during a split)`);
say(`duplicates refused:  ${stats.refused} attempts to reuse an owner across shards`);
say(`final:               total ${final.total}, ${final.n} accounts, ${owners.n} distinct owners`);
const ok = stats.wrong.length === 0 && Number(final.total) === TOTAL && Number(final.n) === ACCOUNTS && Number(owners.n) === ACCOUNTS;
say(ok ? "\nno answer changed while the data moved." : `\nPROBLEMS (${stats.wrong.length}):\n  ${stats.wrong.slice(0, 10).join("\n  ")}`);
await mf.dispose();
process.exit(ok ? 0 : 1);
