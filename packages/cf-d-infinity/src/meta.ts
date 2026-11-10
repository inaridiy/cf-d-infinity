import type { Backend, TableDef } from "./types";
import { parseDdl, type IndexInfo, type ParsedDdl, type TriggerInfo } from "./sql/ddl";
import { applyMove, initialRouting, type Routing } from "./routing";

export interface DdlEntry extends ParsedDdl {
  version: number;
}

export interface Catalog {
  version: number;
  tables: Record<string, TableDef>;
  views: Record<string, string>;
  indexes: Record<string, IndexInfo>;
  triggers: Record<string, TriggerInfo>;
  /** Worker の SQLite で再生する DDL の履歴。sqlite_master と PRAGMA はこれから答える。 */
  ddl: string[];
  routing: Routing;
}

/** 表定義、DDL 履歴、範囲表、rowid の採番を持つ。hot path には載せない。 */
export class MetaCore {
  constructor(private b: Backend, private initialShards: string[] = []) {
    b.exec(`CREATE TABLE IF NOT EXISTS __ddl(version INTEGER PRIMARY KEY, entry TEXT NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __routing(version INTEGER PRIMARY KEY, body TEXT NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __seq(name TEXT PRIMARY KEY, next INTEGER NOT NULL)`);
  }

  /** 最初の範囲表に使うシャードを指定する。範囲表ができた後は効かない。 */
  setInitial(shards: string[]): void {
    this.initialShards = shards;
  }

  private routing(): Routing {
    const r = this.b.exec(`SELECT body FROM __routing ORDER BY version DESC LIMIT 1`)[0];
    if (r) return JSON.parse(r.body as string) as Routing;
    const first = initialRouting(this.initialShards);
    this.b.exec(`INSERT INTO __routing(version, body) VALUES (?, ?)`, first.version, JSON.stringify(first));
    return first;
  }

  /** 範囲表を切り替える。これが増設の線形化点である。 */
  async switchRange(move: { start: number; end: number; to: string }): Promise<Routing> {
    const current = this.routing();
    const done = current.ranges.some((x) => x.shard === move.to && x.start <= move.start && x.end >= move.end);
    if (done) return current; // 増設の手順はやり直せるので、切り替えも冪等にする。
    const next = applyMove(current, move);
    this.b.exec(`INSERT INTO __routing(version, body) VALUES (?, ?)`, next.version, JSON.stringify(next));
    return next;
  }

  private entries(after = 0): DdlEntry[] {
    return this.b
      .exec(`SELECT entry FROM __ddl WHERE version > ? ORDER BY version`, after)
      .map((r) => JSON.parse(r.entry as string) as DdlEntry);
  }

  async catalog(): Promise<Catalog> {
    const cat: Catalog = { version: 0, tables: {}, views: {}, indexes: {}, triggers: {}, ddl: [], routing: this.routing() };
    for (const e of this.entries()) {
      cat.version = e.version;
      for (const d of e.defs) cat.tables[d.name] = d;
      for (const n of e.drops) delete cat.tables[n];
      Object.assign(cat.views, e.views);
      for (const n of e.dropViews ?? []) delete cat.views[n];
      Object.assign(cat.indexes, e.indexes);
      for (const n of e.dropIndexes ?? []) delete cat.indexes[n];
      Object.assign(cat.triggers, e.triggers);
      for (const n of e.dropTriggers ?? []) delete cat.triggers[n];
      if (e.user) cat.ddl.push(e.user);
    }
    return cat;
  }

  async ddlSince(version: number): Promise<{ version: number; ddl: DdlEntry[] }> {
    const ddl = this.entries(version);
    return { version: ddl.at(-1)?.version ?? version, ddl };
  }

  private append(p: Omit<DdlEntry, "version">, version: number): void {
    const entry: DdlEntry = { ...p, version };
    this.b.exec(`INSERT INTO __ddl(version, entry) VALUES (?, ?)`, entry.version, JSON.stringify(entry));
  }

  async applyDdl(sql: string): Promise<Catalog> {
    const cat = await this.catalog();
    const parsed = parseDdl(sql, cat);
    if (!parsed.noop) this.append(parsed, cat.version + 1);
    return this.catalog();
  }

  /** backfill が終わった index を検索に使えるようにする。 */
  async publishIndex(table: string, name: string): Promise<Catalog> {
    const cat = await this.catalog();
    const def = structuredClone(cat.tables[table]!);
    for (const g of def.globalIndexes) if (g.name === name) g.state = "public";
    this.append({ sql: [], defs: [def], drops: [], user: null }, cat.version + 1);
    return this.catalog();
  }

  /** rowid を n 個採番する。min は利用者が明示した値で、これより大きい値から続ける。 */
  async allocate(table: string, n: number, min = 0): Promise<number> {
    const r = this.b.exec(`SELECT next FROM __seq WHERE name = ?`, table)[0];
    const start = Math.max((r?.next as number | undefined) ?? 1, min + 1);
    this.b.exec(
      `INSERT INTO __seq(name, next) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET next = excluded.next`,
      table, start + n,
    );
    return start;
  }
}
