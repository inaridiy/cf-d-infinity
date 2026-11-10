// Worker 向けに束ねるときの共通の設定。公開物 (scripts/build.mjs) とテストが同じものを使う。
/** @type {import("esbuild").BuildOptions} */
export const workerBundle = {
  bundle: true,
  format: "esm",
  platform: "browser",
  // sql.js の Node 向けの分岐が参照するだけで、Workers では実行されない。
  alias: { fs: "./src/empty.js", path: "./src/empty.js", crypto: "./src/empty.js" },
  // sql.js は process.versions.node があると Node で動いているとみなし、__dirname と fs を使おうとする。
  // nodejs_compat を有効にした Worker には process があるので、束ねる時点でこの判定を偽にする。
  define: { "process.versions.node": "undefined" },
};
