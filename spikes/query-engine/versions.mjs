import { Miniflare } from "miniflare";
import { readFileSync } from "fs";
// DO (workerd) 側の SQLite と sql.js の SQLite のバージョン・機能を比べる
const doScript = `import { DurableObject } from "cloudflare:workers";
export class S extends DurableObject { info() { const q = (s) => { try { return this.ctx.storage.sql.exec(s).toArray()[0]; } catch (e) { return "ERR " + e.message; } };
  return { version: q("select sqlite_version() v"), arrow: q("select json('{\\"a\\":1}') ->> '$.a' a"), strict: q("create table if not exists s1(a integer) strict"), math: q("select sqrt(4) r"), fts: q("create virtual table if not exists f using fts5(x)") , window: q("select row_number() over (order by 1) r"), returning: q("create table if not exists r1(a integer)"), filter: q("select count(*) filter (where 1) c from (select 1)") }; } }
export default { async fetch(req, env) { return Response.json(await env.S.get(env.S.idFromName("a")).info()); } };`;
const mf = new Miniflare({ modules: [{ type: "ESModule", path: "do.js", contents: doScript }], compatibilityDate: "2026-01-01", durableObjects: { S: { className: "S", useSQLite: true } } });
console.log("DO:", await (await mf.dispatchFetch("http://x/")).text()); await mf.dispose();
const js = readFileSync("dist/bench-sqljs.js", "utf8").replace('case "/mem":', 'case "/ver": out = { version: q("select sqlite_version() v").first, arrow: q("select json(\'{\\"a\\":1}\') ->> \'$.a\' a").first, math: (() => { try { return q("select sqrt(4) r").first; } catch (e) { return "ERR " + e.message; } })(), fts: (() => { try { db.run("create virtual table f using fts5(x)"); return "ok"; } catch (e) { return "ERR " + e.message; } })(), compile: db.exec("pragma compile_options")[0].values.map(r => r[0]).filter(o => /JSON|FTS|MATH|OMIT|RTREE|SESSION|ENABLE|THREADSAFE/.test(o)) }; break;\n      case "/mem":');
const mf2 = new Miniflare({ modules: [{ type: "ESModule", path: "bench-sqljs.js", contents: js }, { type: "CompiledWasm", path: "sql-wasm.wasm", contents: readFileSync("node_modules/sql.js/dist/sql-wasm.wasm") }], compatibilityDate: "2026-01-01" });
await mf2.dispatchFetch("http://x/init"); console.log("sql.js:", await (await mf2.dispatchFetch("http://x/ver")).text()); await mf2.dispose();
