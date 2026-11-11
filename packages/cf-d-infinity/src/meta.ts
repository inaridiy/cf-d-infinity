import { SqlError, checkStorageFormat, type Backend, type TableDef } from "./types";
import { parseDdl, type IndexInfo, type ParsedDdl, type SchemaView, type TriggerInfo } from "./sql/ddl";
import { CAPTURE_TABLES } from "./shard/rows";
import { applyMove, initialRouting, type Routing } from "./routing";

export interface DdlEntry extends ParsedDdl {
  version: number;
  /** この版が取り消す版。取り消された版をまだ適用していないシャードは、両方を飛ばす。 */
  reverts?: number;
  /** 取り消しの理由。シャードが適用に失敗したときの SQLite のメッセージ。 */
  reason?: string;
}

/** DDL の版が、呼び出し側の見た版から進んでいた。表定義を取り直してやり直す。 */
export class SchemaMoved extends Error {
  readonly retryable = true;
  constructor(readonly version: number) {
    super(`schema moved to version ${version}`);
  }
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
  /** 最新の版が取り消しなら、取り消された版と理由。DDL を出した側が、失敗を利用者へ返すのに使う。 */
  revoked?: { version: number; reason: string };
}

/** 表定義、DDL 履歴、範囲表、rowid の採番を持つ。hot path には載せない。 */
export class MetaCore {
  constructor(private b: Backend, private initialShards: string[] = []) {
    b.exec(`CREATE TABLE IF NOT EXISTS __ddl(version INTEGER PRIMARY KEY, entry TEXT NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __routing(version INTEGER PRIMARY KEY, body TEXT NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __seq(name TEXT PRIMARY KEY, next INTEGER NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __meta(k TEXT PRIMARY KEY, v)`);
    checkStorageFormat(b, "__meta", "schema object");
    for (const s of CAPTURE_TABLES) b.exec(s);
    this.replayShadow();
  }

  /**
   * シャードで実行する文を、Meta 自身の SQLite の空の表でも実行しておく。新しい DDL は、ここで通ってから記録する。
   * 構文は通るが SQLite が拒否する文 (NOT NULL で既定値のない ADD COLUMN、重複した列名など) を記録すると、
   * 全シャードが適用に失敗し続け、直すための DDL も通らなくなる。
   */
  private replayShadow(): void {
    const done = (this.b.exec(`SELECT v FROM __meta WHERE k = 'shadow'`)[0]?.v as number | undefined) ?? 0;
    for (const e of this.entries(done)) {
      // この仕組みより前に記録された文は、通らなくても記録を変えられない。できるだけ追従する。
      for (const s of e.sql) {
        try {
          this.b.exec(s);
        } catch {
          // 続ける
        }
      }
      this.shadowAt(e.version);
    }
  }
  private shadowAt(version: number): void {
    this.b.exec(`INSERT INTO __meta(k, v) VALUES ('shadow', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, version);
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
  async switchRange(move: { start: number; end: number; to: string; from?: string }): Promise<Routing> {
    const current = this.routing();
    const done = current.ranges.some((x) => x.shard === move.to && x.start <= move.start && x.end >= move.end);
    if (done) return current; // 増設の手順はやり直せるので、切り替えも冪等にする。
    // 範囲の持ち主が、呼び出し側の思っている親でなければ断る。別の増設が先に切り替えていると、その子が持つ行を
    // 範囲表が指さなくなる。
    const owners = [...new Set(current.ranges.filter((x) => x.start < move.end && move.start < x.end).map((x) => x.shard))];
    if (move.from !== undefined && !(owners.length === 1 && owners[0] === move.from)) {
      throw new SqlError(`slots [${move.start}, ${move.end}) are owned by ${owners.join(", ")}, not by ${move.from}`);
    }
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
    const all = this.entries();
    const reverted = new Set(all.flatMap((e) => (e.reverts === undefined ? [] : [e.reverts, e.version])));
    for (const e of all) {
      cat.version = e.version;
      for (const d of e.defs) cat.tables[d.name] = d;
      for (const n of e.drops) delete cat.tables[n];
      Object.assign(cat.views, e.views);
      for (const n of e.dropViews ?? []) delete cat.views[n];
      Object.assign(cat.indexes, e.indexes);
      for (const n of e.dropIndexes ?? []) delete cat.indexes[n];
      Object.assign(cat.triggers, e.triggers);
      for (const n of e.dropTriggers ?? []) delete cat.triggers[n];
      // 取り消された文と取り消す文は、Worker の SQLite で再生しない。
      if (e.user && !reverted.has(e.version)) cat.ddl.push(e.user);
    }
    const last = all.at(-1);
    if (last?.reverts !== undefined) cat.revoked = { version: last.reverts, reason: last.reason ?? "" };
    return cat;
  }

  async ddlSince(version: number): Promise<{ version: number; ddl: DdlEntry[] }> {
    const ddl = this.entries(version);
    return { version: ddl.at(-1)?.version ?? version, ddl };
  }

  private append(p: Omit<DdlEntry, "version">, version: number): void {
    const entry: DdlEntry = { ...p, version };
    this.b.tx(() => {
      try {
        for (const s of entry.sql) this.b.exec(s);
      } catch (e) {
        throw new SqlError((e as Error).message);
      }
      this.b.exec(`INSERT INTO __ddl(version, entry) VALUES (?, ?)`, entry.version, JSON.stringify(entry));
      this.shadowAt(version);
    });
  }

  /**
   * DDL を記録する。basedOn は呼び出し側が全シャードへ適用し終えた版で、現在の版と違えば断る。
   * こうすると、新しい版が記録されるのは、前の版を全シャードが適用した後だけになる。
   * シャードが適用に失敗した版を取り消せるのは、その後に別の版が積まれていないからである。
   */
  async applyDdl(sql: string, basedOn?: number): Promise<Catalog> {
    const cat = await this.catalog();
    if (basedOn !== undefined && basedOn !== cat.version) throw new SchemaMoved(cat.version);
    const parsed = parseDdl(sql, cat);
    if (!parsed.noop) {
      this.append(parsed, cat.version + 1);
    }
    return this.catalog();
  }

  /**
   * シャードが適用できなかった版を取り消す。取り消す文を次の版として記録し、その版を返す。取り消せなければ null。
   * 取り消せるのは、最新の版で、取り消す文を持つものだけである。
   */
  async revokeDdl(version: number, reason: string): Promise<number | null> {
    const all = this.entries();
    const done = all.find((e) => e.reverts === version);
    if (done) return done.version;
    const e = all.at(-1);
    if (!e || e.version !== version || !e.undo || e.reverts !== undefined) return null;
    const before: SchemaView = { tables: {}, views: {}, indexes: {}, triggers: {} };
    for (const x of all.slice(0, -1)) {
      for (const d of x.defs) before.tables[d.name] = d;
      for (const n of x.drops) delete before.tables[n];
      Object.assign(before.indexes, x.indexes);
      for (const n of x.dropIndexes ?? []) delete before.indexes[n];
    }
    const names = e.defs.map((d) => d.name);
    this.append({
      sql: e.undo.sql,
      defs: names.flatMap((n) => (before.tables[n] ? [before.tables[n]!] : [])),
      drops: names.filter((n) => !before.tables[n]),
      user: e.undo.user,
      dropIndexes: Object.keys(e.indexes ?? {}).filter((n) => !before.indexes[n]),
      reverts: version,
      reason,
    }, version + 1);
    return version + 1;
  }

  /** backfill が終わった index を検索に使えるようにする。 */
  async publishIndex(table: string, name: string, basedOn?: number): Promise<Catalog> {
    const cat = await this.catalog();
    if (basedOn !== undefined && basedOn !== cat.version) throw new SchemaMoved(cat.version);
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
