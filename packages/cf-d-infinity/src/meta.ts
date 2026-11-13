import { SqlError, checkStorageFormat, type Backend, type Faults, type TableDef, type Ts } from "./types";
import { parseDdl, publishBuild, type IndexInfo, type ParsedDdl, type SchemaView } from "./sql/ddl";
import { systemRuntime, type Runtime } from "./runtime";
import { CAPTURE_TABLES } from "./shard/rows";
import { applyMove, initialRouting, type Routing } from "./routing";

export interface DdlEntry extends ParsedDdl {
  version: number;
  /** この版が取り消す版。取り消された版をまだ適用していないシャードは、両方を飛ばす。 */
  reverts?: number;
  /** 取り消しの理由。シャードが適用に失敗したときの SQLite のメッセージ。 */
  reason?: string;
  /** 取引が読んだ表を DROP する前に、その表を書き込み禁止にする版。次の版が、その DROP か、取り消しである (finishLock)。 */
  guard?: { tables: string[] };
  /**
   * index を公開する版が運ぶ時刻。シャードは、この版を適用するときに、時計をここまで進める。
   * index を使わずに確定した書き込みは、どれもこの時刻以下である。index を使う文は、この版を適用したシャードで読むので、
   * この時刻より後になる。公開が、時刻の順の中の 1 点になる (specs/m12_unique_index_build.qnt の m12_clock)。
   */
  at?: Ts;
}

/**
 * 既存の行から index を作る間は、表への書き込みが止まる。その止め方の期限。
 * 作る側は、作業の合間に期限を延ばし続ける (MetaCore.renewLock)。作る側 (Worker の 1 回の呼び出し) が止まると延長も止まり、
 * INDEX_LEASE_MS のうちに Meta が取り消す。延ばし続けても、作り始めてから INDEX_BUILD_MAX_MS を過ぎれば取り消す。
 * 書き込みが止まる時間の上限である。
 */
export const INDEX_LEASE_MS = 5_000;
export const INDEX_BUILD_MAX_MS = 300_000;

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
  /** Worker の SQLite で再生する DDL の履歴。sqlite_master と PRAGMA はこれから答える。 */
  ddl: string[];
  routing: Routing;
  /** 最新の版が取り消しなら、取り消された版と理由。DDL を出した側が、失敗を利用者へ返すのに使う。 */
  revoked?: { version: number; reason: string };
}

/** index を作っている最中で、別の表定義の変更を記録できない。終わるのを待ってやり直す。 */
export class SchemaBusy extends Error {
  readonly retryable = true;
  constructor(readonly what: string) {
    super(`schema busy: ${what} is in progress`);
  }
}

/**
 * 分割が持つ、保守の操作の枠 (specs/m15_maintenance_slot.qnt)。分割どうしは枠を共有でき、DDL とは排他である。
 * 枠を取った直後は期限がある。分割を進める側が、子が受け取り始める前に止まっても、枠が残らないようにするためである。
 * 子が受け取り始めると (startSplit)、期限を外す。分割は取り消せないので、進める側 (Autoscaler) が再開して終える。
 */
export interface SplitSlot {
  id: string;
  parent: string;
  child: string;
  start: number;
  end: number;
  /** 分割の版。子はこの版で受け取り始め、親はこの版まで追いついてから fence する。 */
  version: number;
  started: boolean;
  until: number;
}
export type SplitMove = Pick<SplitSlot, "parent" | "child" | "start" | "end">;

/** 表への書き込みを止めている作業の名前。誤りの文に使う。 */
function describe(e: DdlEntry): string {
  return e.build ? `CREATE INDEX ${e.build.index}` : `the lock on ${e.guard!.tables.join(", ")} before DROP TABLE`;
}

/** 表定義、DDL 履歴、範囲表、rowid の採番を持つ。hot path には載せない。 */
export class MetaCore {
  private rt: Runtime;
  private leaseMs: number;
  private buildMaxMs: number;
  /** 欠陥を再導入するスイッチ。検査が欠陥を見つけることを確かめる試験だけが渡す。 */
  private faults: Faults;
  constructor(
    private b: Backend, private initialShards: string[] = [],
    opts: { runtime?: Runtime; leaseMs?: number; buildMaxMs?: number; faults?: Faults } = {},
  ) {
    this.rt = opts.runtime ?? systemRuntime;
    this.leaseMs = opts.leaseMs ?? INDEX_LEASE_MS;
    this.buildMaxMs = opts.buildMaxMs ?? INDEX_BUILD_MAX_MS;
    this.faults = opts.faults ?? {};
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

  /**
   * 表への書き込みを止めている作業 (index の作成か、DROP の前の書き込み禁止) を記録した版。最新の版がそれであるときだけ、作業の最中である。
   * 作業の間は、ほかの表定義の変更を記録しない。だから、終わり方 (公開、DROP、取り消し) は「最新の版がこの版のまま」のときだけ
   * 次の版を積み、どれか 1 つしか起きない。
   */
  private building(all = this.entries()): DdlEntry | null {
    const last = all.at(-1);
    return last?.build || last?.guard ? last : null;
  }

  /**
   * Hrana の baton に署名する鍵。DINF_BATON_SECRET が設定されていないときに使う。最初に呼ばれたときに乱数で作って保存し、
   * 以後は同じ値を返す。データ用のトークンから計算できる鍵だと、トークンを持つ人が取引の状態を書き換えた baton を作れる。
   * 乱数は Runtime の uuid (本番は crypto.randomUUID、122 ビットの乱数) を 2 つつなげる。
   */
  batonSecret(): string {
    const have = this.b.exec(`SELECT v FROM __meta WHERE k = 'baton_secret'`)[0]?.v as string | undefined;
    if (have) return have;
    const secret = `${this.rt.uuid()}${this.rt.uuid()}`;
    this.b.exec(`INSERT INTO __meta(k, v) VALUES ('baton_secret', ?) ON CONFLICT(k) DO NOTHING`, secret);
    return this.b.exec(`SELECT v FROM __meta WHERE k = 'baton_secret'`)[0]!.v as string;
  }

  private splitSlots(): SplitSlot[] {
    const r = this.b.exec(`SELECT v FROM __meta WHERE k = 'splits'`)[0];
    return r ? (JSON.parse(r.v as string) as SplitSlot[]) : [];
  }
  private setSplitSlots(list: SplitSlot[]): void {
    this.b.exec(`INSERT INTO __meta(k, v) VALUES ('splits', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, JSON.stringify(list));
  }

  /**
   * 保守の操作の枠を、誰が持っているか。DDL を記録する場所と、分割が枠を取る場所が、この 1 つで確かめる。
   * exclusive は表への書き込みを止めている作業 (index の作成、DROP の前の禁止)。splits は進行中の分割である。
   */
  private holders(): { exclusive: DdlEntry | null; splits: SplitSlot[] } {
    return { exclusive: this.building(), splits: this.splitSlots() };
  }

  /** DDL を記録してよいか。だめなら、待ってやり直せる誤りを投げる。 */
  private assertFreeForDdl(): void {
    const h = this.holders();
    if (h.exclusive) throw new SchemaBusy(describe(h.exclusive));
    if (h.splits.length > 0) throw new SchemaBusy(`a shard split of ${h.splits.map((x) => x.parent).join(", ")}`);
  }

  /**
   * 分割のために、保守の操作の枠を取る。basedOn は、呼び出し側が全シャードへ適用させた版で、最新の版と違えば断る。
   * こうすると、分割の途中に、最新の版の取り消し (シャードが適用に失敗した版) が入ることもない。
   * 同じ範囲の分割の枠がもうあれば、それを返す (分割の再開)。
   */
  async beginSplit(move: SplitMove, basedOn: number): Promise<SplitSlot> {
    this.expire();
    const list = this.splitSlots();
    const same = list.find((x) => x.parent === move.parent && x.child === move.child && x.start === move.start && x.end === move.end);
    if (same) return same;
    const cat = this.current();
    if (basedOn !== cat.version) throw new SchemaMoved(cat.version);
    const h = this.holders();
    if (h.exclusive) throw new SchemaBusy(describe(h.exclusive));
    const slot: SplitSlot = { id: `split:${move.parent}:${move.child}:${move.start}:${move.end}`, ...move, version: cat.version, started: false, until: this.rt.now() + this.leaseMs };
    this.setSplitSlots([...list, slot]);
    return slot;
  }

  /** 子が受け取り始める。枠が生きていれば、期限を外して分割の版を返す。枠がなければ (期限切れ) 断る。 */
  async startSplit(id: string, move: SplitMove): Promise<{ version: number }> {
    this.expire();
    const list = this.splitSlots();
    const slot = list.find((x) => x.id === id);
    // 欠陥のスイッチ: 枠が期限で消えていても断らず、いまの版で受け取り始めさせる。枠のないまま分割が進み、DDL が記録される。
    if (!slot && this.faults.startWithoutSlot) return { version: this.current().version };
    if (!slot || slot.parent !== move.parent || slot.child !== move.child || slot.start !== move.start || slot.end !== move.end) {
      throw new SqlError(`split ${id}: no such split slot (it expired before the child started, or it is for another range)`);
    }
    if (!slot.started) this.setSplitSlots(list.map((x) => (x.id === id ? { ...x, started: true } : x)));
    return { version: slot.version };
  }

  /** 親が fence する前に、枠が生きていて、子が受け取り始めていることを確かめる。 */
  async checkSplit(id: string, move: SplitMove): Promise<void> {
    if (this.faults.fenceWithoutSlot) return;
    const slot = this.splitSlots().find((x) => x.id === id);
    if (!slot?.started || slot.parent !== move.parent || slot.child !== move.child || slot.start !== move.start || slot.end !== move.end) {
      throw new SqlError(`split ${id}: the split slot is not held, or the child has not started receiving`);
    }
  }

  /** 分割が終わった。枠を返す。 */
  async endSplit(id: string): Promise<void> {
    this.setSplitSlots(this.splitSlots().filter((x) => x.id !== id));
  }

  /** 進行中の分割の枠。Autoscaler が、止まった分割を再開するのに使う。 */
  async splits(): Promise<SplitSlot[]> {
    this.expire();
    return this.splitSlots();
  }

  /**
   * 期限を過ぎた index の作成を取り消す。外から呼ばれるたびに、最初に確かめる。
   * 書き込みを断られた Worker も、版を進めたいシャードも、Meta に尋ねる。だから、タイマーがなくても、待っている者がいれば取り消される。
   */
  private expire(): void {
    // 子が受け取り始める前に、期限を過ぎた分割の枠を捨てる。
    const slots = this.splitSlots();
    const live = slots.filter((x) => x.started || this.rt.now() <= x.until);
    if (live.length !== slots.length) this.setSplitSlots(live);
    const b = this.building();
    if (!b) return;
    const lease = this.lease();
    const now = this.rt.now();
    if (lease?.version === b.version && now <= lease.until) return;
    const reason = lease?.version === b.version && now > lease.started + this.buildMaxMs
      ? `${describe(b)} did not finish within ${Math.round(this.buildMaxMs / 1000)} seconds and was withdrawn; the table is unchanged`
      : `${describe(b)} stopped before it finished and was withdrawn; the table is unchanged`;
    this.revoke(b.version, reason);
  }

  /** 作っている最中の index の期限。版、作り始めた時刻、いまの期限。 */
  private lease(): { version: number; started: number; until: number } | null {
    const r = this.b.exec(`SELECT v FROM __meta WHERE k = 'build_lease'`)[0];
    return r ? (JSON.parse(r.v as string) as { version: number; started: number; until: number }) : null;
  }
  private setLease(l: { version: number; started: number; until: number }): void {
    this.b.exec(`INSERT INTO __meta(k, v) VALUES ('build_lease', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, JSON.stringify(l));
  }

  /**
   * 表への書き込みを止めている作業の期限を延ばす。version は作業を始めた版で、まだ作業の最中でなければ断る。
   * 取り消された後の延長が、作業を生き返らせることはない (公開と同じ確認。specs/m12_unique_index_build.qnt の ONE_EXIT)。
   */
  async renewLock(version: number): Promise<{ leaseMs: number }> {
    this.expire();
    const b = this.building();
    const lease = this.lease();
    if (!b || b.version !== version || lease?.version !== version) {
      throw new SqlError(`the schema change that locked the table is no longer in progress`);
    }
    this.setLease({ ...lease, until: Math.min(this.rt.now() + this.leaseMs, lease.started + this.buildMaxMs) });
    return { leaseMs: this.leaseMs };
  }

  async catalog(): Promise<Catalog> {
    this.expire();
    return this.current();
  }

  private current(): Catalog {
    const cat: Catalog = { version: 0, tables: {}, views: {}, indexes: {}, ddl: [], routing: this.routing() };
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
      // 取り消された文と取り消す文は、Worker の SQLite で再生しない。
      if (e.user && !reverted.has(e.version)) cat.ddl.push(e.user);
    }
    const last = all.at(-1);
    if (last?.reverts !== undefined) cat.revoked = { version: last.reverts, reason: last.reason ?? "" };
    return cat;
  }

  async ddlSince(version: number): Promise<{ version: number; ddl: DdlEntry[] }> {
    this.expire();
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
    this.expire();
    const cat = this.current();
    if (basedOn !== undefined && basedOn !== cat.version) throw new SchemaMoved(cat.version);
    this.assertFreeForDdl();
    const parsed = parseDdl(sql, cat);
    if (!parsed.noop) {
      this.append(parsed, cat.version + 1);
      const now = this.rt.now();
      if (parsed.build) this.setLease({ version: cat.version + 1, started: now, until: now + this.leaseMs });
    }
    return this.current();
  }

  /**
   * シャードが適用できなかった版を取り消す。取り消す文を次の版として記録し、その版を返す。取り消せなければ null。
   * 取り消せるのは、最新の版で、取り消す文を持つものだけである。
   */
  async revokeDdl(version: number, reason: string): Promise<number | null> {
    this.expire();
    return this.revoke(version, reason);
  }

  private revoke(version: number, reason: string): number | null {
    const all = this.entries();
    const done = all.find((e) => e.reverts === version);
    if (done) return done.version;
    const e = all.at(-1);
    if (!e || e.version !== version || !e.undo || e.reverts !== undefined) return null;
    const before: SchemaView = { tables: {}, views: {}, indexes: {} };
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

  /**
   * 既存の行の項目を埋め終えた index を公開する。version は index を作り始めた版で、それが最新の版のままでなければ断る。
   * 期限切れで取り消された後に、遅れてきた公開が通ることはない。at は公開の時刻 (DdlEntry.at)。
   */
  async publishIndex(table: string, name: string, version: number, at: Ts): Promise<Catalog> {
    this.expire();
    const b = this.building();
    if (!b || b.version !== version || b.build!.table !== table || b.build!.index !== name) {
      throw new SqlError(`CREATE INDEX ${name}: the index is no longer being built`);
    }
    this.append({ ...publishBuild(this.current().tables[table]!, b.build!), at }, b.version + 1);
    return this.current();
  }

  /**
   * 取引が読んだ表を DROP する前に、その表を書き込み禁止にする (specs/m14_rebuild_guard.qnt)。表定義の形は変えない。
   * 次の版は、finishLock が記録する DROP か、取り消しである。期限は index の作成と同じく、延ばし続ける。
   */
  async lockTables(tables: string[], basedOn?: number): Promise<Catalog> {
    this.expire();
    const cat = this.current();
    if (basedOn !== undefined && basedOn !== cat.version) throw new SchemaMoved(cat.version);
    this.assertFreeForDdl();
    const defs = tables.map((t) => {
      const def = cat.tables[t];
      if (!def) throw new SqlError(`no such table: ${t}`);
      return { ...structuredClone(def), locked: `DROP TABLE ${t} by a transaction that read it` };
    });
    const version = cat.version + 1;
    this.append({ sql: [], defs, drops: [], user: null, guard: { tables }, undo: { sql: [], user: null } }, version);
    const now = this.rt.now();
    this.setLease({ version, started: now, until: now + this.leaseMs });
    return this.current();
  }

  /** 書き込み禁止の版 (lockTables) を、その DROP で終える。version は禁止の版で、それが最新の版のままでなければ断る。 */
  async finishLock(version: number, sql: string): Promise<Catalog> {
    this.expire();
    const b = this.building();
    if (this.faults.dropAfterExpiry && !(b?.guard && b.version === version)) {
      // 欠陥のスイッチ: DROP が禁止と結び付いていない。期限切れで禁止が解けた後でも、最新の版の次に DROP を記録する。
      const cat = this.current();
      this.append(parseDdl(sql, cat), cat.version + 1);
      return this.current();
    }
    if (!b?.guard || b.version !== version) throw new SqlError(`DROP TABLE: the lock on the table was withdrawn before the table was dropped`);
    const parsed = parseDdl(sql, this.current());
    if (!b.guard.tables.every((t) => parsed.drops.includes(t))) throw new SqlError(`DROP TABLE: the statement does not drop ${b.guard.tables.join(", ")}`);
    this.append(parsed, version + 1);
    return this.current();
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
