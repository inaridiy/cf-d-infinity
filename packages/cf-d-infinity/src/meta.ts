import { SqlError, checkStorageFormat, type Backend, type Faults, type TableDef, type Ts } from "./types";
import { parseDdl, publishBuild, type IndexInfo, type SchemaView } from "./sql/ddl";
import { systemRuntime, type Runtime } from "./runtime";
import { CAPTURE_TABLES } from "./shard/rows";
import { checkInterval, contains, initialRouting, overlaps, rangeText, sameInterval, type Interval, type Routing } from "./routing";
import { fold, splitId, type DdlEntry, type EpochRecord, type Logged, type Snapshot } from "./catalog";

export type { DdlEntry } from "./catalog";

/**
 * 既存の行から index を作る間は、表への書き込みが止まる。その止め方の期限。
 * 作る側は、作業の合間に期限を延ばし続ける (MetaCore.renewLock)。作る側 (Worker の 1 回の呼び出し) が止まると延長も止まり、
 * INDEX_LEASE_MS のうちに Meta が取り消す。延ばし続けても、作り始めてから INDEX_BUILD_MAX_MS を過ぎれば取り消す。
 * 書き込みが止まる時間の上限である。
 */
export const INDEX_LEASE_MS = 5_000;
export const INDEX_BUILD_MAX_MS = 300_000;

/**
 * DDL の版が、呼び出し側の見た版から進んでいた。表定義を取り直してやり直す。schema は、その版の表定義の epoch である。
 * DO の間ではクラスが落ちるので、どちらの数も文に書く。
 */
export class SchemaMoved extends Error {
  readonly retryable = true;
  constructor(readonly version: number, readonly schema: number) {
    super(`schema moved to version ${version} (schema epoch ${schema})`);
  }
}

export interface Catalog {
  /** 表定義の版 (DdlEntry.version)。Meta の入口 (basedOn、取り消し、公開) は、段 3 まで、この数で話す。 */
  version: number;
  tables: Record<string, TableDef>;
  views: Record<string, string>;
  indexes: Record<string, IndexInfo>;
  /** Worker の SQLite で再生する DDL の履歴。sqlite_master と PRAGMA はこれから答える。 */
  ddl: string[];
  routing: Routing;
  /** 最新の版が取り消しなら、取り消された版と理由。DDL を出した側が、失敗を利用者へ返すのに使う。 */
  revoked?: { version: number; reason: string };
  /**
   * このスナップショットの epoch (畳んだ最後の epoch)。要求が運び (ExecReq.epoch)、シャードは、これが自分より新しく、要求の行が
   * 自分のスナップショットで自分のものでなければ、列を適用してから所有を確かめ直す (段 2)。
   */
  epoch: number;
  /** 表定義が最後に変わった epoch。要求が運び (ExecReq.schema)、シャードは自分の表定義の epoch と等しいことを確かめる (段 2)。 */
  schema: number;
}

/**
 * スナップショットを、Worker とシャードに渡す形 (Catalog) にする。開いている遷移と移動は、まだ Meta の外に出さない。
 * epoch と schema は、段 2 で足した (要求が運ぶ)。段 1 の比べ合い (test/meta-old.ts) は、比べる前に、この 2 つを落とす。
 */
function catalogOf(s: Snapshot): Catalog {
  const cat: Catalog = { version: s.version, tables: s.tables, views: s.views, indexes: s.indexes, ddl: s.ddl, routing: s.routing } as Catalog;
  if (s.revoked) cat.revoked = s.revoked;
  cat.epoch = s.epoch;
  cat.schema = s.schema;
  return cat;
}

/** Meta の epoch の列を読む。after より後の epoch を、昇順で返す。Meta の外 (シミュレータの検査) も、これで読む。 */
export function readEpochs(b: Backend, after = -1): Logged[] {
  return b
    .exec(`SELECT epoch, rec FROM __epoch WHERE epoch > ? ORDER BY epoch`, after)
    .map((r) => ({ epoch: r.epoch as number, rec: JSON.parse(r.rec as string) as EpochRecord }));
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
export interface SplitSlot extends Interval {
  id: string;
  parent: string;
  child: string;
  /** 分割の版。子はこの版で受け取り始め、親はこの版まで追いついてから fence する。 */
  version: number;
  started: boolean;
  until: number;
}
/** 分割の同一性。親、子、移す区間 (token) で決まる。 */
export type SplitMove = Pick<SplitSlot, "parent" | "child" | "start" | "end">;
const sameSplit = (a: SplitMove, b: SplitMove): boolean => a.parent === b.parent && a.child === b.child && sameInterval(a, b);
/** 区間の形を確かめる。おかしな区間を、範囲表や枠に書かない。 */
function assertInterval(x: Interval): void {
  try {
    checkInterval(x);
  } catch (e) {
    throw new SqlError((e as Error).message);
  }
}

/** 表への書き込みを止めている作業の名前。誤りの文に使う。 */
function describe(e: DdlEntry): string {
  return e.build ? `CREATE INDEX ${e.build.index}` : `the lock on ${e.guard!.tables.join(", ")} before DROP TABLE`;
}

/**
 * 表定義、DDL 履歴、範囲表、rowid の採番を持つ。hot path には載せない。
 * 表定義の版と範囲表の切り替えは、epoch の列 (__epoch、src/catalog.ts) に記録し、答えは列を畳んで作る (段 1。
 * docs/design-catalog-epoch.md)。入口の名前と答えは、列を入れる前と同じである。
 */
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
    b.exec(`CREATE TABLE IF NOT EXISTS __epoch(epoch INTEGER PRIMARY KEY, rec TEXT NOT NULL)`);
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
   * 写し終えた位置 (__meta の shadow) は epoch である。
   */
  private replayShadow(): void {
    const done = (this.b.exec(`SELECT v FROM __meta WHERE k = 'shadow'`)[0]?.v as number | undefined) ?? 0;
    for (const { epoch, rec } of readEpochs(this.b, done)) {
      if (rec.kind !== "commit" || !("ddl" in rec)) continue;
      // この仕組みより前に記録された文は、通らなくても記録を変えられない。できるだけ追従する。
      for (const s of rec.ddl.sql) {
        try {
          this.b.exec(s);
        } catch {
          // 続ける
        }
      }
      this.shadowAt(epoch);
    }
  }
  private shadowAt(epoch: number): void {
    this.b.exec(`INSERT INTO __meta(k, v) VALUES ('shadow', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, epoch);
  }

  /** 最初の範囲表に使うシャードを指定する。範囲表ができた後は効かない。 */
  setInitial(shards: string[]): void {
    this.initialShards = shards;
  }

  /** 列の最後に記録を足し、その epoch を返す。呼び出し側が、必要なら同じ取引の中で呼ぶ。 */
  private record(rec: EpochRecord): number {
    const last = this.b.exec(`SELECT max(epoch) AS e FROM __epoch`)[0]?.e as number | null | undefined;
    const epoch = (last ?? 0) + 1;
    this.b.exec(`INSERT INTO __epoch(epoch, rec) VALUES (?, ?)`, epoch, JSON.stringify(rec));
    return epoch;
  }

  /**
   * 列の最後まで畳んだもの。最初の範囲表は作らない。
   * 呼ばれるたびに畳む (段 1 と同じ)。答えの object は呼び出し側へそのまま渡り、シミュレータでは Worker がそれを持ち続けるので、
   * 控えを共有しない。畳んだ結果を覚えるのは、自分の写しを持つシャードである (kernel.ts の snap)。
   */
  private snapshot(): Snapshot {
    return fold(readEpochs(this.b));
  }

  /** 最初の範囲表を、まだなければ epoch 0 に書く。範囲表を最初に引いたときに作るのは、列を入れる前と同じである。 */
  private ensureGenesis(): void {
    if (this.b.exec(`SELECT 1 FROM __epoch WHERE epoch = 0`).length > 0) return;
    const rec: EpochRecord = { kind: "genesis", routing: initialRouting(this.initialShards) };
    this.b.exec(`INSERT INTO __epoch(epoch, rec) VALUES (0, ?)`, JSON.stringify(rec));
  }

  private routing(): Routing {
    this.ensureGenesis();
    return this.snapshot().routing;
  }

  /** 範囲表を切り替える。これが増設の線形化点である。移すのは token の区間で、区間の境目は、どの token にも置ける。 */
  async switchRange(move: Interval & { to: string; from?: string }): Promise<Routing> {
    assertInterval(move);
    const current = this.routing();
    const done = current.ranges.some((x) => x.shard === move.to && contains(x, move));
    if (done) return current; // 増設の手順はやり直せるので、切り替えも冪等にする。
    // 範囲の持ち主が、呼び出し側の思っている親でなければ断る。別の増設が先に切り替えていると、その子が持つ行を
    // 範囲表が指さなくなる。
    const owners = [...new Set(current.ranges.filter((x) => overlaps(x, move)).map((x) => x.shard))];
    if (move.from !== undefined && !(owners.length === 1 && owners[0] === move.from)) {
      throw new SqlError(`${rangeText(move)} are owned by ${owners.join(", ")}, not by ${move.from}`);
    }
    // 渡す側を省いた切り替え (試験が直に呼ぶ) は、区間の持ち主が 1 つなら、それを渡す側として記録する。
    const from = move.from ?? (owners.length === 1 ? owners[0] : undefined);
    this.record({ kind: "move-start", ...(from === undefined ? {} : { from }), to: move.to, start: move.start, end: move.end });
    return this.snapshot().routing;
  }

  /** 表定義の版の履歴。after より後の版を返す。 */
  private entries(after = 0): DdlEntry[] {
    return readEpochs(this.b).flatMap(({ rec }) => (rec.kind === "commit" && "ddl" in rec && rec.ddl.version > after ? [rec.ddl] : []));
  }

  /**
   * 表への書き込みを止めている作業 (index の作成か、DROP の前の書き込み禁止) を記録した版。最新の版がそれであるときだけ、作業の最中である。
   * 作業の間は、ほかの表定義の変更を記録しない。だから、終わり方 (公開、DROP、取り消し) は「最新の版がこの版のまま」のときだけ
   * 次の版を積み、どれか 1 つしか起きない。列の上では、開いている表定義の遷移 (Snapshot.open) である。
   */
  private building(): DdlEntry | null {
    return (this.snapshot().open?.ddl as DdlEntry | undefined) ?? null;
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
    const same = list.find((x) => sameSplit(x, move));
    if (same) return same;
    const cat = this.current();
    if (basedOn !== cat.version) throw new SchemaMoved(cat.version, cat.schema);
    const h = this.holders();
    if (h.exclusive) throw new SchemaBusy(describe(h.exclusive));
    assertInterval(move);
    const slot: SplitSlot = {
      id: splitId(move),
      parent: move.parent, child: move.child, start: move.start, end: move.end, version: cat.version, started: false, until: this.rt.now() + this.leaseMs,
    };
    this.setSplitSlots([...list, slot]);
    return slot;
  }

  /**
   * 子が受け取り始める。枠が生きていれば、期限を外して分割の版と、その版の表定義の epoch を返す。枠がなければ (期限切れ) 断る。
   * シャードは表定義の epoch で比べるので (段 2)、子は schema まで列を適用してから受け取り始める。
   */
  async startSplit(id: string, move: SplitMove): Promise<{ version: number; schema: number }> {
    this.expire();
    const list = this.splitSlots();
    const slot = list.find((x) => x.id === id);
    // 欠陥のスイッチ: 枠が期限で消えていても断らず、いまの版で受け取り始めさせる。枠のないまま分割が進み、DDL が記録される。
    if (!slot && this.faults.startWithoutSlot) {
      const cat = this.current();
      return { version: cat.version, schema: cat.schema };
    }
    if (!slot || !sameSplit(slot, move)) {
      throw new SqlError(`split ${id}: no such split slot (it expired before the child started, or it is for another range)`);
    }
    if (!slot.started) this.setSplitSlots(list.map((x) => (x.id === id ? { ...x, started: true } : x)));
    return { version: slot.version, schema: this.schemaOf(slot.version) };
  }

  /** 表定義の版 version を記録した commit の epoch。版 0 (表定義の変更がまだない) は 0 である。 */
  private schemaOf(version: number): number {
    if (version === 0) return 0;
    const hit = readEpochs(this.b).find(({ rec }) => rec.kind === "commit" && "ddl" in rec && rec.ddl.version === version);
    if (!hit) throw new SqlError(`schema version ${version} is not recorded`);
    return hit.epoch;
  }

  /** 親が fence する前に、枠が生きていて、子が受け取り始めていることを確かめる。 */
  async checkSplit(id: string, move: SplitMove): Promise<void> {
    if (this.faults.fenceWithoutSlot) return;
    const slot = this.splitSlots().find((x) => x.id === id);
    if (!slot?.started || !sameSplit(slot, move)) {
      throw new SqlError(`split ${id}: the split slot is not held, or the child has not started receiving`);
    }
  }

  /**
   * 分割が終わった。枠を返し、その分割の移動 (範囲表の切り替えの move-start) が開いていれば、move-end を記録する。
   * 移動は、枠の名前 (親、子、区間) で引く。枠が期限で消えていても (欠陥のスイッチ startWithoutSlot)、移動は閉じる。
   */
  async endSplit(id: string): Promise<void> {
    const list = this.splitSlots();
    const slot = list.find((x) => x.id === id);
    const move = this.snapshot().moves.find((m) =>
      (m.from !== undefined && splitId({ parent: m.from, child: m.to, start: m.start, end: m.end }) === id) ||
      (slot !== undefined && m.to === slot.child && sameInterval(m, slot) && (m.from === undefined || m.from === slot.parent)));
    this.b.tx(() => {
      this.setSplitSlots(list.filter((x) => x.id !== id));
      if (move) this.record({ kind: "move-end", of: move.epoch });
    });
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
    this.ensureGenesis();
    return catalogOf(this.snapshot());
  }

  async ddlSince(version: number): Promise<{ version: number; ddl: DdlEntry[] }> {
    this.expire();
    const ddl = this.entries(version);
    return { version: ddl.at(-1)?.version ?? version, ddl };
  }

  /**
   * 列の、epoch が after より後の記録を、昇順で返す。シャードは、これを自分の写し (__epoch) に足し、同じ fold で畳む (段 2)。
   * 最初の範囲表 (epoch 0) は、まだなければここで書く。写しの先頭は、いつも epoch 0 である。
   */
  async epochsSince(after: number): Promise<Logged[]> {
    this.expire();
    this.ensureGenesis();
    return readEpochs(this.b, after);
  }

  /** 表定義の版を 1 つ、commit の記録として足す。シャードで実行する文は、同じ取引の中で Meta の SQLite でも実行する。 */
  private append(p: Omit<DdlEntry, "version">, version: number): void {
    const entry: DdlEntry = { ...p, version };
    this.b.tx(() => {
      try {
        for (const s of entry.sql) this.b.exec(s);
      } catch (e) {
        throw new SqlError((e as Error).message);
      }
      this.shadowAt(this.record({ kind: "commit", ddl: entry }));
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
    if (basedOn !== undefined && basedOn !== cat.version) throw new SchemaMoved(cat.version, cat.schema);
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
    const log = readEpochs(this.b);
    const all = log.flatMap(({ epoch, rec }) => (rec.kind === "commit" && "ddl" in rec ? [{ epoch, e: rec.ddl }] : []));
    const done = all.find((x) => x.e.reverts === version);
    if (done) return done.e.version;
    const last = all.at(-1);
    const e = last?.e;
    if (!last || !e || e.version !== version || !e.undo || e.reverts !== undefined) return null;
    // 取り消す版の直前の表定義。列を、その版の 1 つ前の epoch まで畳む。
    const before: SchemaView = fold(log, last.epoch - 1);
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
    if (basedOn !== undefined && basedOn !== cat.version) throw new SchemaMoved(cat.version, cat.schema);
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
