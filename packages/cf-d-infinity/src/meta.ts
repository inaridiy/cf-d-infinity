import { SqlError, checkStorageFormat, type Backend, type Faults, type TableDef, type Ts } from "./types";
import { parseDdl, type DdlMode, type IndexInfo, type ParsedDdl } from "./sql/ddl";
import { systemRuntime, type Runtime } from "./runtime";
import { CAPTURE_TABLES } from "./shard/rows";
import { checkInterval, initialRouting, rangeText, sameInterval, slotAligned, type Interval, type Routing } from "./routing";
import { describeOpen, fenceOf, fold, objectKey, refusal, type EpochRecord, type Logged, type Move, type ObjectEpochs, type OpenDdl, type OpenMove, type Snapshot } from "./catalog";

/**
 * 表定義の遷移の期限 (docs/design-catalog-epoch.md の「期限」)。prepare から commit か abort までの間、fence の表への書き込みが止まる。
 * 進める側 (DDL を出した Worker の 1 回の呼び出し) は、作業の合間に期限を延ばし続ける (MetaCore.renew)。進める側が止まると延長も
 * 止まり、LEASE_MS のうちに Meta が abort を記録する。延ばし続けても、prepare から TRANSITION_MAX_MS を過ぎれば abort する。
 * 書き込みが止まる時間の上限である。
 */
export const LEASE_MS = 5_000;
export const TRANSITION_MAX_MS = 300_000;

/**
 * DDL の待ちの期限 (docs/design-catalog-epoch.md の「表ごとの epoch」の「Worker」)。DDL を始めてから、この時間までは、表の行ロックを持つ
 * 取引を待つ。SQLite の busy_timeout に相当する 5 秒で、行ロックの待ちの上限 (src/shard/kernel.ts の LOCK_WAIT_MS) と同じである。
 * 遷移ごとの期限 (LEASE_MS) とは別のもので、DDL を進める側が持つ。取り消させられた DDL のやり直しも、この時間を数え直さない。
 */
export const DDL_WAIT_MS = 5_000;

/**
 * 表定義の epoch が、呼び出し側の見た epoch から進んでいた。表定義を取り直してやり直す。
 * DO の間ではクラスが落ちるので、数を文に書く。
 */
export class SchemaMoved extends Error {
  readonly retryable = true;
  constructor(readonly schema: number) {
    super(`schema moved to epoch ${schema}`);
  }
}

/** 開いている表定義の遷移の、Meta の外に見せる部分。 */
export interface OpenTransition {
  epoch: number;
  mode: DdlMode;
  fence: string[];
  /** mode build のとき、作っている index の名前。 */
  index?: string;
  /** やり直しの試みなら、その DDL の最初の試みの prepare の epoch。DDL を進める側が、自分の DDL のやり直しを見分ける。 */
  retryOf?: number;
}

export interface Catalog {
  tables: Record<string, TableDef>;
  views: Record<string, string>;
  indexes: Record<string, IndexInfo>;
  /** Worker の SQLite で再生する DDL の履歴。sqlite_master と PRAGMA はこれから答える。commit された文だけが入る。 */
  ddl: string[];
  routing: Routing;
  /**
   * このスナップショットの epoch (畳んだ最後の epoch)。要求が運び (ExecReq.epoch)、シャードは、これが自分より新しく、要求の行が
   * 自分のスナップショットで自分のものでなければ、列を適用してから所有を確かめ直す (段 2)。
   */
  epoch: number;
  /**
   * どれかの DDL が最後に確定した epoch (commit の記録でだけ進む)。取引は、これで自分の表定義を名指す (TxnDump.schema、MetaCore.catalogAt)。
   * 要求が運ぶのは、これではなく、頼るものごとの epoch (objects から作る ExecReq.deps) である。
   */
  schema: number;
  /** 表と view の epoch (src/catalog.ts の Snapshot.objects)。鍵は小文字の名前。 */
  objects: Record<string, ObjectEpochs>;
  /** 開いている表定義の遷移。fence の表への書き込みは、シャードが TableLocked で断る。 */
  open?: OpenTransition;
  /** 最後の表定義の記録が abort なら、その遷移と理由。wound は、行ロックを持つ取引が取り消させた印。 */
  aborted?: { of: number; reason: string; wound?: true };
}

/** prepare の答え。epoch は記録した prepare の epoch で、何もしない DDL (IF NOT EXISTS など) なら null (何も記録しない)。 */
export interface Prepared {
  epoch: number | null;
  mode: DdlMode;
  /** prepare の ddl (commit で表定義に入るもの)。mode build の進める側は、ここから作る index を知る。 */
  ddl?: ParsedDdl;
  /** prepare を記録した後のスナップショット。 */
  catalog: Catalog;
}

/** スナップショットを、Worker とシャードに渡す形 (Catalog) にする。 */
function catalogOf(s: Snapshot): Catalog {
  const cat: Catalog = { tables: s.tables, views: s.views, indexes: s.indexes, ddl: s.ddl, routing: s.routing, epoch: s.epoch, schema: s.schema, objects: s.objects };
  if (s.open) {
    const o: OpenTransition = { epoch: s.open.epoch, mode: s.open.mode, fence: s.open.fence };
    if (s.open.mode === "build") o.index = Object.keys(s.open.ddl.indexes ?? {})[0]!;
    if (s.open.retryOf !== undefined) o.retryOf = s.open.retryOf;
    cat.open = o;
  }
  if (s.aborted) cat.aborted = s.aborted;
  return cat;
}

/** Meta の epoch の列を読む。after より後の epoch を、昇順で返す。Meta の外 (シミュレータの検査) も、これで読む。 */
export function readEpochs(b: Backend, after = -1): Logged[] {
  return b
    .exec(`SELECT epoch, rec FROM __epoch WHERE epoch > ? ORDER BY epoch`, after)
    .map((r) => ({ epoch: r.epoch as number, rec: JSON.parse(r.rec as string) as EpochRecord }));
}

/** 表定義の遷移か分割が進行中で、別の表定義の変更を記録できない。終わるのを待ってやり直す。 */
export class SchemaBusy extends Error {
  readonly retryable = true;
  constructor(readonly what: string) {
    super(`schema busy: ${what} is in progress`);
  }
}

/** 移動を開けない。重なる移動か、親か子の移動が開いている。終わるのを待ってやり直す。 */
export class SplitBusy extends Error {
  readonly retryable = true;
  constructor(detail: string) {
    super(`split busy: ${detail}`);
  }
}

/** 区間の形を確かめる。おかしな区間を、範囲表に書かない。 */
function assertInterval(x: Interval): void {
  try {
    checkInterval(x);
  } catch (e) {
    throw new SqlError((e as Error).message);
  }
}

/** 表定義の遷移を開いてよいかを尋ねるための、中身のない prepare の記録。 */
const PROBE: EpochRecord = { kind: "prepare", mode: "plain", ddl: { sql: [], defs: [], drops: [], user: null }, fence: [] };

/** 開いている表定義の遷移の期限。 */
interface Lease {
  epoch: number;
  started: number;
  until: number;
}

/** Meta の SQLite で試した文を巻き戻すための印。 */
const ROLLBACK = Symbol("rollback");

/**
 * 表定義、DDL 履歴、範囲表、rowid の採番を持つ。hot path には載せない。
 * 表定義の遷移と範囲の移動は、epoch の列 (__epoch、src/catalog.ts) に記録し、答えは列を畳んで作る。記録を足せるかは、列を畳んだ
 * スナップショットから決める (catalog.ts の refusal)。
 * 表定義の変更は 2 相である (段 3。docs/design-catalog-epoch.md の「表定義の遷移」)。prepare が表への書き込みを止め、進める側が
 * 全シャードの ok を集めた後で commit が確定する。失敗か期限切れなら abort が禁止を解く。取り消しの文 (逆操作) はない。
 * 範囲の移動は move-start で始まり、子が受け取り終えた後の move-end で閉じる (段 4)。取り消しはない。表定義の遷移と移動は、同時に
 * 開かない (両方向)。
 */
export class MetaCore {
  private rt: Runtime;
  private leaseMs: number;
  private maxMs: number;
  /** 欠陥を再導入するスイッチ。検査が欠陥を見つけることを確かめる試験だけが渡す。 */
  private faults: Faults;
  constructor(
    private b: Backend, private initialShards: string[] = [],
    opts: { runtime?: Runtime; leaseMs?: number; buildMaxMs?: number; faults?: Faults } = {},
  ) {
    this.rt = opts.runtime ?? systemRuntime;
    this.leaseMs = opts.leaseMs ?? LEASE_MS;
    this.maxMs = opts.buildMaxMs ?? TRANSITION_MAX_MS;
    this.faults = opts.faults ?? {};
    b.exec(`CREATE TABLE IF NOT EXISTS __epoch(epoch INTEGER PRIMARY KEY, rec TEXT NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __seq(name TEXT PRIMARY KEY, next INTEGER NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __meta(k TEXT PRIMARY KEY, v)`);
    checkStorageFormat(b, "__meta", "schema object");
    for (const s of CAPTURE_TABLES) b.exec(s);
    this.replayShadow();
  }

  /**
   * シャードで実行する文を、Meta 自身の SQLite の空の表でも実行しておく。新しい DDL は、ここで試して通ってから prepare を記録し、
   * commit を記録するときに、もう一度実行して残す。構文は通るが SQLite が拒否する文 (NOT NULL で既定値のない ADD COLUMN、
   * 重複した列名など) を記録すると、全シャードの試しが失敗し、DDL は必ず abort になる。空の表で断れば、それより前に分かる。
   * 写し終えた位置 (__meta の shadow) は epoch である。
   */
  private replayShadow(): void {
    const done = (this.b.exec(`SELECT v FROM __meta WHERE k = 'shadow'`)[0]?.v as number | undefined) ?? 0;
    const prepares = new Map<number, Extract<EpochRecord, { kind: "prepare" }>>();
    for (const { epoch, rec } of readEpochs(this.b)) {
      if (rec.kind === "prepare") prepares.set(epoch, rec);
      if (epoch <= done || rec.kind !== "commit") continue;
      const p = prepares.get(rec.of);
      for (const s of [...(p?.staging?.sql ?? []), ...(p?.ddl.sql ?? [])]) {
        try {
          this.b.exec(s);
        } catch {
          // 写しは記録を変えられない。できるだけ追従する。
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
   * 呼ばれるたびに畳む。答えの object は呼び出し側へそのまま渡り、シミュレータでは Worker がそれを持ち続けるので、
   * 控えを共有しない。畳んだ結果を覚えるのは、自分の写しを持つシャードである (kernel.ts の snap)。
   */
  private snapshot(): Snapshot {
    return fold(readEpochs(this.b), undefined, this.faults);
  }

  /** 最初の範囲表を、まだなければ epoch 0 に書く。範囲表を最初に引いたときに作る。 */
  private ensureGenesis(): void {
    if (this.b.exec(`SELECT 1 FROM __epoch WHERE epoch = 0`).length > 0) return;
    const rec: EpochRecord = { kind: "genesis", routing: initialRouting(this.initialShards) };
    this.b.exec(`INSERT INTO __epoch(epoch, rec) VALUES (0, ?)`, JSON.stringify(rec));
  }

  private routing(): Routing {
    this.ensureGenesis();
    return this.snapshot().routing;
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

  /**
   * 表定義の遷移を開いてよいか。だめなら、待ってやり直せる誤りを投げる (refusal の 2 つ)。
   *   one-open        表定義の遷移は 1 つずつ開く (M21 の ONE_OPEN)。
   *   ddl-waits-move  移動が開いている間は開かない (DDL_WAITS_MOVE)。移動の途中の親と子は表定義の記録を適用しないので、
   *                   その epoch で計画した要求を、移動が終わるまで断ることになる (m21_red_ddl_during_move)。
   */
  private assertFreeForDdl(s: Snapshot): void {
    const r = refusal(s, PROBE);
    if (r?.rule === "one-open" && !this.faults.overlappingTransitions) throw new SchemaBusy(describeOpen(r.open));
    // 欠陥のスイッチで one-open を外しても、移動の確かめは残す (遷移を除いたスナップショットで尋ね直す)。
    const m = refusal({ ...s, open: null }, PROBE);
    if (m?.rule === "ddl-waits-move" && !this.faults.ddlDuringMove) {
      throw new SchemaBusy(`a shard split of ${[...new Set(m.moves.map((x) => x.from))].join(", ")}`);
    }
  }

  /**
   * 範囲の移動を開く (move-start を記録する。docs/design-catalog-epoch.md の「移動の遷移」、段 4)。この記録が、範囲表の切り替えであり、
   * 親の fence であり (親は、この記録を適用すると、その区間の書き込みを断る)、子の受け取りの始まりである (子は、適用すると受け取り始め、
   * 自分で移動を進める)。シャードの確かめは待たない。子も親も、記録そのものから始められるからである。
   * 同じ移動 (親、子、区間) がもう開いていれば、記録を足さずに、その epoch を返す (分割の再開)。
   * 記録を足せないのは、refusal の 4 つの条件である。
   *   move-waits-ddl  表定義の遷移が開いている (M21 の MOVE_WAITS_DDL)。SchemaBusy で、待ってやり直せる。遷移の終わり (commit か
   *                   abort) が、移動の途中の親と子に届くと、適用できないからである (m21_red_move_during_ddl)。
   *   owner           区間の全体を、親が持っていない。
   *   moves-overlap   開いている移動と、区間か、親か子が重なる。SplitBusy で、待ってやり直せる。
   *   child-owns      子が、もう範囲を持っている。
   * 区間の両端は slot の境目でなければならない (シャードの移動の手順が、まだグループの全体を運ぶことを前提にしている)。
   */
  async startMove(move: Move): Promise<{ epoch: number; routing: Routing }> {
    assertInterval(move);
    if (!slotAligned(move)) throw new SqlError(`moving a part of a slot is not supported yet: ${rangeText(move)}`);
    this.expire();
    const s = this.current();
    const same = s.moves.find((m) => m.from === move.from && m.to === move.to && sameInterval(m, move));
    if (same) return { epoch: same.epoch, routing: s.routing };
    const rec: EpochRecord = { kind: "move-start", from: move.from, to: move.to, start: move.start, end: move.end };
    const busy = refusal(s, rec);
    if (busy?.rule === "move-waits-ddl" && !this.faults.moveDuringDdl) throw new SchemaBusy(describeOpen(busy.open));
    // 欠陥のスイッチで move-waits-ddl を外しても、ほかの条件は確かめる (遷移を除いたスナップショットで尋ね直す)。
    const r = busy?.rule === "move-waits-ddl" ? refusal({ ...s, open: null }, rec) : busy;
    if (r?.rule === "owner") throw new SqlError(`${rangeText(move)} are owned by ${r.owners.join(", ") || "nobody"}, not by ${move.from}`);
    if (r?.rule === "moves-overlap") {
      const m = r.moves[0]!;
      throw new SplitBusy(`a move of ${rangeText(m)} from ${m.from} to ${m.to} is in progress`);
    }
    if (r?.rule === "child-owns") throw new SqlError(`split: ${move.to} already owns other ranges`);
    if (r) throw new SqlError(`cannot start the move: ${r.rule}`);
    const epoch = this.record(rec);
    return { epoch, routing: this.snapshot().routing };
  }

  /**
   * 移動を閉じる (move-end を記録する)。epoch は、その移動の move-start の epoch である。子が受け取り終えた後で (finishIncoming の後)、
   * 子が呼ぶ (M21 の END_AFTER_DRAIN。列からは決まらないので、Meta は確かめない)。もう閉じていれば、記録を足さずに、閉じた記録の epoch を
   * 返す (子は alarm で呼び直す)。
   */
  async endMove(epoch: number): Promise<{ epoch: number }> {
    this.expire();
    const s = this.current();
    if (refusal(s, { kind: "move-end", of: epoch }) === null) return { epoch: this.record({ kind: "move-end", of: epoch }) };
    const log = readEpochs(this.b);
    const ended = log.find((x) => x.rec.kind === "move-end" && x.rec.of === epoch);
    if (ended) return { epoch: ended.epoch };
    throw new SqlError(`epoch ${epoch} is not a move`);
  }

  /** 開いている移動 (move-start の後、move-end の前)。Autoscaler が、止まった分割を再開するのに使う。 */
  async moves(): Promise<OpenMove[]> {
    this.expire();
    return this.current().moves;
  }

  /**
   * 開いている表定義の遷移の期限。prepare の epoch、prepare の時刻、いまの期限。遷移は 1 つずつ開くので、ふつうは 0 か 1 個である
   * (欠陥のスイッチ overlappingTransitions を入れた Meta だけが、2 つ持つ)。
   */
  private leases(): Lease[] {
    const r = this.b.exec(`SELECT v FROM __meta WHERE k = 'lease'`)[0];
    return r ? (JSON.parse(r.v as string) as Lease[]) : [];
  }
  private lease(epoch: number): Lease | undefined {
    return this.leases().find((l) => l.epoch === epoch);
  }
  private setLease(epoch: number, l: Lease | null): void {
    const list = [...this.leases().filter((x) => x.epoch !== epoch), ...(l ? [l] : [])];
    this.b.exec(`INSERT INTO __meta(k, v) VALUES ('lease', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, JSON.stringify(list));
  }

  /**
   * 期限を過ぎた表定義の遷移を abort する。外から呼ばれるたびに、最初に確かめる。
   * 書き込みを断られた Worker も、列を取りに来るシャードも、Meta に尋ねる。だから、タイマーがなくても、待っている者がいれば abort される。
   * 移動には期限がない (move-start の後は、子が自分で進める)。
   */
  private expire(): void {
    const now = this.rt.now();
    for (const o of this.snapshot().opens) {
      const lease = this.lease(o.epoch);
      if (lease && now <= lease.until) continue;
      const reason = lease && now > lease.started + this.maxMs
        ? `${describeOpen(o)} did not finish within ${Math.round(this.maxMs / 1000)} seconds and was withdrawn; the table is unchanged`
        : `${describeOpen(o)} stopped before it finished and was withdrawn; the table is unchanged`;
      this.b.tx(() => {
        this.record({ kind: "abort", of: o.epoch, reason });
        this.setLease(o.epoch, null);
      });
    }
  }

  /**
   * 表定義の遷移の期限を延ばす。epoch は prepare の epoch で、その遷移がもう開いていなければ断る。
   * abort された後の延長が、遷移を生き返らせることはない (commit と同じ確かめ。M21 の ONE_EXIT)。
   */
  async renew(epoch: number): Promise<{ leaseMs: number }> {
    this.expire();
    const open = this.snapshot().opens.some((o) => o.epoch === epoch);
    const lease = this.lease(epoch);
    if (!open || !lease) throw new SqlError(`the schema change that locked the table is no longer in progress`);
    this.setLease(epoch, { ...lease, until: Math.min(this.rt.now() + this.leaseMs, lease.started + this.maxMs) });
    return { leaseMs: this.leaseMs };
  }

  async catalog(): Promise<Catalog> {
    this.expire();
    return catalogOf(this.current());
  }

  private current(): Snapshot {
    this.ensureGenesis();
    return this.snapshot();
  }

  /**
   * 表定義の epoch が schema だったときの表定義に、いまの範囲表を合わせたスナップショット (設計書の「表ごとの epoch」の「Worker」)。
   * 接続をまたぐ取引 (Hrana の baton) は、最初に読むか書くかしたときの表定義の epoch を運ぶ。Worker は、取引を組み立て直すとき、
   * その後に別の DDL が確定していても、取引を失敗させずに、列をその epoch まで畳んだ表定義で計画する。範囲表と、開いている遷移は、
   * いまのものである。schema が、どれかの DDL が確定した epoch でなければ、断る (baton が、この DB のものでない)。
   */
  async catalogAt(schema: number): Promise<Catalog> {
    this.expire();
    const now = this.current();
    if (schema === now.schema) return catalogOf(now);
    const then = fold(readEpochs(this.b), schema, this.faults);
    if (!Number.isSafeInteger(schema) || schema < 0 || schema > now.schema || then.schema !== schema) {
      throw new SqlError(`schema epoch ${schema} is not an epoch at which a schema change committed`);
    }
    const { open: _o, aborted: _a, ...cat } = catalogOf(then);
    const fresh = catalogOf(now);
    return {
      ...cat, routing: fresh.routing, epoch: fresh.epoch,
      ...(fresh.open ? { open: fresh.open } : {}), ...(fresh.aborted ? { aborted: fresh.aborted } : {}),
    };
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

  /**
   * 文を Meta の SQLite の空の表で試して巻き戻す (replayShadow)。SQLite が拒否する文は、ここで断る。
   * commit で残すときと同じく、内部の表 (staging) を先に作る。
   */
  private tryShadow(p: Pick<ParsedDdl, "sql" | "staging">): void {
    try {
      this.b.tx(() => {
        for (const s of [...(p.staging?.sql ?? []), ...p.sql]) this.b.exec(s);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e === ROLLBACK) return;
      throw new SqlError((e as Error).message);
    }
  }

  /**
   * 表定義の遷移を開く (prepare を記録する)。basedOn は、呼び出し側が文を解釈した表定義の epoch で、最新と違えば SchemaMoved で断る
   * (取り消しがないので、意味は「文を解釈した表定義が最新である」ことだけである)。遷移か移動が開いていれば SchemaBusy。
   * guard は、取引が読んだ表の DROP で、その取引が読んだ表である (mode guard。読んだ範囲は、進める側が commit の前に確かめる)。
   * waitUntil は DDL の待ちの期限 (進める側の時計の時刻) で、prepare の記録が運ぶ。シャードは、fence の表に行ロックがある間、
   * その時刻まで prepare の適用を待つ。
   * 何もしない DDL (IF NOT EXISTS で表がある、など) は、何も記録せずに epoch: null を返す。
   */
  async prepare(sql: string, opts: { guard?: string[]; waitUntil?: number } = {}, basedOn?: number): Promise<Prepared> {
    this.expire();
    const s = this.current();
    if (basedOn !== undefined && basedOn !== s.schema) throw new SchemaMoved(s.schema);
    this.assertFreeForDdl(s);
    const parsed = parseDdl(sql, s);
    if (parsed.noop) return { epoch: null, mode: "plain", catalog: catalogOf(s) };
    let mode: DdlMode = parsed.mode ?? "plain";
    // 待つ表の集合 (fence) は、DDL が書き込みの epoch を進める表から導く (src/catalog.ts の fenceOf。計画書の不変条件 16)。
    let fence = fenceOf(parsed, s.tables);
    // 欠陥のスイッチ indexDdlUnfenced (2026-11-17 までの形): 行で失敗しない index の DDL (一意でない CREATE INDEX、DROP INDEX) は、
    // 書き込みの epoch だけを進める表を、fence に入れない。
    if (this.faults.indexDdlUnfenced && mode === "plain") {
      const writeOnly = new Set((parsed.changes?.write ?? []).map(objectKey));
      fence = fence.filter((t) => !writeOnly.has(objectKey(t)));
    }
    const guard = opts.guard ?? [];
    if (guard.length > 0) {
      // 取引が読んだ表の DROP。消す表は、もう fence にある。
      if (!guard.every((t) => parsed.drops.includes(t))) throw new SqlError(`DROP TABLE: the statement does not drop ${guard.join(", ")}`);
      mode = "guard";
      fence = [...new Set([...fence, ...guard])];
    }
    this.tryShadow(parsed);
    const { mode: _m, staging, ...ddl } = parsed;
    const rec: EpochRecord = {
      kind: "prepare", mode, ddl, fence, ...(staging ? { staging } : {}), ...(opts.waitUntil === undefined ? {} : { waitUntil: opts.waitUntil }),
    };
    const now = this.rt.now();
    const epoch = this.b.tx(() => {
      const e = this.record(rec);
      this.setLease(e, { epoch: e, started: now, until: now + this.leaseMs });
      return e;
    });
    return { epoch, mode, ddl, catalog: catalogOf(this.snapshot()) };
  }

  /**
   * 表定義の遷移を確定する (commit を記録する)。epoch は prepare の epoch、acks は prepared に ok と答えたシャード、at は index を
   * 公開する commit が運ぶ時刻である。確かめるのは 3 つ (設計書の「Meta の入口」)。
   *   1. その遷移が開いている。期限切れか失敗で abort された後の commit は通らない (M21 の ONE_EXIT)。先に expire を通す。
   *   2. acks が、範囲表の全シャードを含む (ALL_ACKS)。遷移が開いている間は移動が始まらないので、シャードの集合は prepare から変わらない。
   * 文は、Meta の SQLite でも実行して残す。
   */
  async commit(epoch: number, acks: string[], at?: Ts): Promise<Catalog> {
    this.expire();
    let s = this.current();
    let of = epoch;
    const r = refusal(s, { kind: "commit", of: epoch }, acks);
    if (r?.rule === "one-exit") {
      if (!this.faults.commitAfterAbort) throw new SqlError(this.closedReason(epoch));
      of = this.reopen(epoch);
      s = this.snapshot();
    } else if (r?.rule === "all-acks" && !this.faults.commitWithoutAcks) {
      throw new SqlError(`the schema change of epoch ${epoch} was not prepared on ${r.missing.join(", ")}; it was not committed`);
    }
    const open = s.opens.find((o) => o.epoch === of)!;
    this.b.tx(() => {
      try {
        for (const x of [...(open.staging?.sql ?? []), ...open.ddl.sql]) this.b.exec(x);
      } catch (e) {
        throw new SqlError((e as Error).message);
      }
      const c = this.record({ kind: "commit", of, ...(at === undefined ? {} : { at }) });
      this.shadowAt(c);
      this.setLease(of, null);
    });
    return catalogOf(this.snapshot());
  }

  /**
   * 欠陥のスイッチ commitAfterAbort: 閉じた遷移の prepare を、もう一度記録する (同じ文、同じ fence)。遅れた commit は、こちらを確定する。
   * abort から開き直すまでの間、表への書き込みは止まっていない。
   */
  private reopen(epoch: number): number {
    const hit = readEpochs(this.b).find((x) => x.epoch === epoch && x.rec.kind === "prepare");
    if (!hit) throw new SqlError(this.closedReason(epoch));
    // 期限は付けない。すぐ後の commit が閉じる。
    return this.record(hit.rec);
  }

  /** 閉じた遷移に commit が届いたときの誤りの文。abort されたなら、その理由である。 */
  private closedReason(epoch: number): string {
    const log = readEpochs(this.b);
    const aborted = log.find((x) => x.rec.kind === "abort" && x.rec.of === epoch)?.rec as Extract<EpochRecord, { kind: "abort" }> | undefined;
    if (aborted) return aborted.reason;
    if (log.some((x) => x.rec.kind === "commit" && x.rec.of === epoch)) return `the schema change of epoch ${epoch} was already committed`;
    return `the schema change of epoch ${epoch} is not open`;
  }

  /**
   * 表定義の遷移を取り消す (abort を記録する)。禁止を解き、prepare が作った内部の表を消させるだけで、利用者の表に触る文を持たない。
   * その遷移が、もう abort されていれば (期限切れか、取り消させる手)、記録せずに、その理由を返す。呼び出し側は、自分の理由と違えば、
   * そちらを利用者へ返す。もう commit された遷移は取り消せない (M21 の ONE_EXIT)。
   * wound は、fence の表の行ロックを持つ取引が、書き込み禁止に当たって取り消させる手である (M24 の WOUND)。記録に印を付ける。答えの
   * wound は、記録された (か、もう記録されていた) abort がその手のものか、である。DDL を進める側は、それを見て、やり直すかを決める。
   *
   * 取り消させる手では、abort と同じ 1 手で、やり直しの prepare を記録する (モデル M24c の ONE_RESTART)。同じ文、同じ fence、同じ待ちの
   * 期限 (KEEP_BUDGET) で、epoch だけが新しい (FRESH_EPOCH。シャードは ok を答え直す)。DDL が始まってから終わるまで、列に、開いている
   * 試みのない時がない。abort を適用したシャードは、同じ続きで、やり直しの prepare を見る。間があると、DDL の後ろで待っていた取引が、
   * その間にロックを得て、DDL を待たせる (行が 2 つのシャードにあるときだけ起きるので、成否が置き場所で決まる)。
   * 答えの next は、その DDL のやり直しのうち、いま開いている prepare の epoch である (なければ、ない)。やり直しの prepare は、DDL の
   * 最初の試みの epoch を運ぶ (retryOf) ので、何度取り消させられても、同じ DDL のやり直しだと分かる。進める側は、待ちの期限のうちなら、
   * それを引き継いで進め、過ぎていれば取り消す。進める側が止まっていれば、やり直しも、期限 (lease) で abort される。
   * 欠陥のスイッチ woundWithoutRestart は、やり直しの prepare を記録しない (2026-11-17 までの形。進める側が、後から記録する)。
   */
  async abort(epoch: number, reason: string, wound = false): Promise<{ reason: string; wound: boolean; next?: number }> {
    this.expire();
    const s = this.snapshot();
    if (refusal(s, { kind: "abort", of: epoch, reason }) === null) {
      const prepared = readEpochs(this.b).find((x) => x.epoch === epoch)!.rec as Extract<EpochRecord, { kind: "prepare" }>;
      const lease = this.lease(epoch);
      const now = this.rt.now();
      const next = this.b.tx(() => {
        this.record({ kind: "abort", of: epoch, reason, ...(wound ? { wound: true as const } : {}) });
        this.setLease(epoch, null);
        // 待ちの期限を運ばない prepare (試験が直に開いた遷移) は、やり直さない。待つ者がいない。
        if (!wound || this.faults.woundWithoutRestart || prepared.waitUntil === undefined) return undefined;
        const e = this.record({ ...prepared, retryOf: prepared.retryOf ?? epoch });
        // 書き込みが止まる時間の上限 (TRANSITION_MAX_MS) は、最初の試みから数える。
        this.setLease(e, { epoch: e, started: lease?.started ?? now, until: now + this.leaseMs });
        return e;
      });
      return { reason, wound, ...(next === undefined ? {} : { next }) };
    }
    const why = this.closedReason(epoch);
    if (/was already committed|is not open/.test(why)) throw new SqlError(`cannot withdraw: ${why}`);
    const log = readEpochs(this.b);
    const recorded = log.find((x) => x.rec.kind === "abort" && x.rec.of === epoch)?.rec as Extract<EpochRecord, { kind: "abort" }> | undefined;
    // その DDL のやり直しが、まだ開いていれば、それを答える。
    const first = log.find((x) => x.epoch === epoch)?.rec as Extract<EpochRecord, { kind: "prepare" }> | undefined;
    const origin = first?.retryOf ?? epoch;
    const next = s.opens.find((o) => o.retryOf === origin)?.epoch;
    return { reason: why, wound: recorded?.wound === true, ...(next === undefined ? {} : { next }) };
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

export type { OpenDdl };
