// 見つかっている欠陥の再現 (2026-11-16。計画書の未解決の問題 47 の作業で、入口の値の規則を使う側を見直して見つけた。不変条件 11)。
//
// CLI の `sql` は、`--param 5.0` を REAL の要素 `r5.0` にする (bin/cli.js の typed)。使い捨ての Worker は要素を JS の数の 5 に戻し
// (dec)、Service Binding の query に渡す。Service Binding は D1 の規則 (安全な整数の JS の数は INTEGER) で読むので、REAL として
// 書いた引数が INTEGER になる。正しくは、CLI が REAL と書いた引数は REAL のまま束縛される。JS の数は 5.0 と 5 を見分けられない
// ので、直すのは CLI と Worker のあいだの運び方である (要素のまま運ぶか、HTTP の /sql に literal の文面で送る)。
// bin/ だけでは直せない (2026-11-16 に確かめた)。使い捨ての Worker が呼べる DinfDatabase の query、batch、取引の execute は、どれも
// toValue を通り、REAL の 5.0 になる JS の値はない。HTTP の入口はトークンが要り、importRows は INSERT しかしない。引数を要素で受け取る
// 入口を src/entrypoint.ts に足し (decodeElem で読み、INTEGER の 64 ビットの範囲を確かめる)、使い捨ての Worker がそれを呼べば、
// この試験は通る (試作で確かめた)。
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- JavaScript のモジュール
import { workerBundle } from "../../scripts/esbuild-options.mjs";

const run = promisify(execFile);
const registry = mkdtempSync(join(tmpdir(), "dinf-registry-"));
let mf: Miniflare;

beforeAll(async () => {
  // test/ops.test.ts と同じく、Worker を dev registry に登録し、CLI の使い捨ての Worker から呼ばせる。出力先は分ける。
  await build({ ...workerBundle, entryPoints: { "cli-real-db": "src/cloudflare.ts" }, outdir: "dist", logLevel: "error", external: ["cloudflare:workers", "*.wasm"] });
  mf = new Miniflare({
    unsafeDevRegistryPath: registry,
    name: "cli-real-db",
    modules: [
      { type: "ESModule", path: "dist/cli-real-db.js", contents: readFileSync("dist/cli-real-db.js", "utf8") },
      { type: "CompiledWasm", path: "dist/sql-wasm.wasm", contents: readFileSync("src/sql-wasm.wasm") },
    ],
    compatibilityDate: "2026-07-01",
    bindings: { DINF_SHARD_COUNT: "2", DINF_API_TOKEN: "test", DINF_ADMIN_TOKEN: "admin-test" },
    durableObjects: {
      DINF_SHARD: { className: "DinfShard", useSQLite: true },
      DINF_META: { className: "DinfMeta", useSQLite: true },
      DINF_AUTOSCALER: { className: "DinfAutoscaler", useSQLite: true },
    },
  });
  await mf.ready;
}, 60000);
afterAll(() => mf?.dispose());

describe("the CLI's sql --param", () => {
  it("binds a parameter written with a decimal point as REAL", async () => {
    const out = await run("node", [resolve("bin/cli.js"), "sql", "SELECT typeof(?) AS a, typeof(?) AS b", "--param", "5.0", "--param", "5", "--json", "--worker", "cli-real-db"], {
      env: { PATH: process.env.PATH ?? "", HOME: registry, WRANGLER_REGISTRY_PATH: registry },
    });
    expect(JSON.parse(out.stdout).rows).toEqual([{ a: "real", b: "integer" }]);
  }, 60000);
});
