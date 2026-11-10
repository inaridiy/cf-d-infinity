// 分散プロトコルの共有型。docs/design.md の用語に対応する。
export type Ts = number;
export type Value = string | number | null | Uint8Array;
export type Row = Record<string, Value>;

export interface GlobalIndexDef {
  name: string;
  table: string; // 内部表 __gidx_<name>
  columns: string[];
  unique: boolean;
  /** writeOnly の間は書き込みだけが更新する。backfill が終わると public になり検索に使える。 */
  state: "writeOnly" | "public";
}

export interface TableDef {
  name: string;
  columns: string[];
  /** PRIMARY KEY がない表は ["rowid"] になる。 */
  pk: string[];
  shardKey: string[];
  /** PRIMARY KEY がなく、行の識別に暗黙の rowid を使う。 */
  implicitRowid: boolean;
  /** INTEGER PRIMARY KEY の列。値を省略すると Worker が採番する。 */
  rowidAlias: string | null;
  /** shard key の列の型親和性。同じ値が同じシャードへ行くように経路の計算で値を揃える。 */
  skAffinity: Affinity[];
  /** shard key に照合順序があると、等値でも値が一致しないので経路を固定できない。 */
  skPinnable: boolean;
  /** 列の型親和性。 */
  affinity: Record<string, Affinity>;
  /** 照合順序を宣言した列。 */
  collated: string[];
  /** 列の照合順序。 */
  collation: Record<string, string>;
  /** シャード内の UNIQUE (shard key を含むもの)。 */
  uniques: string[][];
  globalIndexes: GlobalIndexDef[];
}

export type Affinity = "INTEGER" | "REAL" | "NUMERIC" | "TEXT" | "BLOB";

/** 1 行の変更。before/after はその行全体のイメージで、null は不在を表す。 */
export interface Change {
  table: string;
  pk: string; // pk 値の JSON
  sk: string; // shard key 値の JSON
  before: Row | null;
  after: Row | null;
  /** 悲観的な DML がこの行を読んだ時刻 F。検証はここから c までを見る。 */
  since?: Ts;
}

/** table が "*" の span は全表を覆う。パースできない文の保守的な読み取り範囲に使う。 */
export type Span = (
  | { kind: "pk"; table: string; pk: string; sk: string }
  | { kind: "sk"; table: string; sk: string }
  | { kind: "table"; table: string }
  /**
   * 押し下げた条件で読んだ範囲。行イメージが条件を満たす変更だけが競合になる。
   * 条件を押し下げられない読みは表単位になり、関係のない行の書き込みでも衝突する。
   */
  | { kind: "pred"; table: string; alias: string; where: string; params: Value[]; sk?: string }
) & {
  /** 悲観的な DML の読み。T ではなくこの時刻から検証する。 */
  since?: Ts;
  /**
   * 読み手の範囲表で、宛先のシャードが持つスロットの範囲 [start, end) である。
   * shard key を絞らない span に付ける。
   * span が覆うのは、表のうちこの範囲に載る行である。
   * 範囲表が古いと、その一部はすでに別のシャードへ移っている。
   * シャードは手放した範囲と重なれば NotOwner を返し、読み手に範囲表を取り直させる。
   */
  slots?: [number, number][];
};

/** shard key を絞らない span。そのシャードの表全体を覆う。 */
export const isWideSpan = (s: Span): boolean => s.kind === "table" || (s.kind === "pred" && !s.sk);

export function spanCovers(span: Span, table: string, pk: string, sk: string): boolean {
  if (span.table !== table && span.table !== "*") return false;
  if (span.kind === "pk") return span.pk === pk;
  if (span.kind === "sk") return span.sk === sk;
  if (span.kind === "pred" && span.sk !== undefined) return span.sk === sk;
  return true;
}

/** pk 等値で読み同じ pk に書く span だけが intent で守られる。phantom は intent では防げない。 */
export function unprotectedSpans(spans: Span[], writes: Pick<Change, "table" | "pk">[]): Span[] {
  return spans.filter(
    (s) => !(s.kind === "pk" && writes.some((w) => w.table === s.table && w.pk === s.pk)),
  );
}

/** 書き込み文の実行指示。行の変更は trigger が捕捉するので、文の中身は解析しない。 */
export interface WritePlan {
  /** 変更行が属すべき shard key。null ならシャードを検査しない (Worker が行ごとに振り分け済み)。 */
  sk: string | null;
  /**
   * autocommit で、trigger を使わず RETURNING で変更行を捕捉できる文の形。
   * 下書きの実行と ROLLBACK が要らなくなり、課金される行が減る。
   * update は主キーで 1 行に絞れる文に限る。変更前の行を主キーで読むからである。
   */
  capture?: "insert" | "update" | "delete";
}

export interface ExecReq {
  /** 読み取り時刻。未指定ならシャードが発行する。 */
  T?: Ts;
  /** セッションの因果トークン。 */
  minTs?: Ts;
  sql: string;
  params: Value[];
  spans: Span[];
  /** Txn が buffer している、このシャード宛の未 commit 変更。 */
  overlay?: Change[];
  /** 書き込み文の dry-run。指定時は rows に加えて changes を返す。 */
  write?: WritePlan;
  /** T より後の commit があれば読まずに ReadTooOld を返す。取引が T を進めて読み直すためである。 */
  fresh?: boolean;
  /**
   * autocommit の読み取り。開始前に確定した書き込みを必ず見せる必要がある。
   * T を指定した読みで、決着させた取引の commit 時刻が T を超えていたら、T を取り直させる。
   */
  realtime?: boolean;
  /**
   * この要求が返してよい行数とバイト数の上限。超えたら、送り返す前にシャードが拒否する。
   * 未指定ならシャードの既定の上限だけが効く。
   */
  maxRows?: number;
  maxBytes?: number;
  /** 悲観的な DML。最新の状態で実行し、変更行のロックを取る。 */
  lock?: LockOwner;
  /** 読み取りでロックを取る行。BEGIN IMMEDIATE の主キー読みに使う。 */
  lockRows?: { table: string; pk: string }[];
  schema: number;
}

export interface LockOwner {
  txn: string;
  /** 開始時刻。古い取引が優先される (wound-wait)。 */
  start: Ts;
}

export interface ExecRes {
  /** 悲観的な DML が読んだ時刻 F。 */
  F?: Ts;
  columns: string[];
  values: Value[][];
  changes: Change[];
  T: Ts;
  hlc: Ts;
  epoch: number;
}

export interface PrepareReq {
  txn: string;
  T: Ts;
  writes: Change[];
  spans: Span[];
  anchor: string;
  schema: number;
}
export type PrepareRes = { ok: true; prepareTs: Ts } | { ok: false; reason: string };

export interface Participant {
  shard: string;
  writes: Change[];
  spans: Span[];
}

export interface CommitReq {
  txn: string;
  T: Ts;
  participants: Participant[];
  schema: number;
}
export type CommitRes = { ok: true; c: Ts } | { ok: false; reason: string };

export type TxnStatus =
  | { status: "committed"; c: Ts }
  | { status: "aborted" }
  | { status: "pushed" };

/** シャードが他のシャードへ公開する RPC。すべて txn_id で冪等である。 */
export interface ShardApi {
  exec(req: ExecReq): Promise<ExecRes>;
  execAuto(req: ExecReq): Promise<ExecRes>;
  commitLocal(req: Omit<PrepareReq, "anchor">): Promise<CommitRes>;
  commit(req: CommitReq): Promise<CommitRes>;
  prepare(req: PrepareReq): Promise<PrepareRes>;
  refresh(req: { txn: string; spans: Span[]; from: Ts; to: Ts }): Promise<{ ok: boolean; reason?: string }>;
  /** groups は移動先への転送で使う。未到着ならそのグループを先に引き取る。 */
  finalize(req: { txn: string; c: Ts; groups?: string[] }): Promise<void>;
  abort(req: { txn: string; groups?: string[] }): Promise<void>;
  queryTxn(req: { txn: string; pushTo: Ts }): Promise<TxnStatus>;
  status(req: { txn: string }): Promise<TxnStatus>;
  flush(req: { upTo?: Ts }): Promise<FlushRes>;
  /** 子が受け入れの準備をする。親の fence より先に呼ぶ。 */
  beginIncoming(req: { start: number; end: number; from: string; schema: number }): Promise<void>;
  /** 親がスロットの受理を止める。以後は NotOwner を返す。 */
  fence(req: { start: number; end: number; to: string }): Promise<void>;
  listGroups(req: { start: number; end: number; limit: number; cursor?: GroupCursor | null }): Promise<{ groups: string[]; cursor: GroupCursor | null }>;
  pull(req: { groups: string[]; to: string; maxBytes: number }): Promise<GroupPayload[]>;
  ack(req: { groups: string[] }): Promise<void>;
  /** 子が背景で全グループを引き取る。 */
  drain(req: { start: number; end: number }): Promise<{ groups: number; rows: number; bytes: number }>;
  finishMove(req: { start: number; end: number }): Promise<void>;
  finishIncoming(req: { start: number; end: number }): Promise<void>;
  metrics(req: Record<string, never>): Promise<ShardMetrics>;
  /** このシャードが健全かを運用者に見せるための状態。 */
  health(req: Record<string, never>): Promise<ShardHealth>;
  /** 表の行を主キーの順に返す。論理エクスポートに使う。 */
  exportRows(req: { table: string; after: Value[] | null; limit: number }): Promise<{ columns: string[]; rows: Value[][]; pk: number[] }>;
  /** 取引の rollback でロックを手放す。届かなくても TTL で消える。 */
  unlock(req: { txn: string }): Promise<void>;
  /** DDL を適用する。全シャードへ適用してから DDL を完了させる。 */
  syncSchema(req: { version: number }): Promise<void>;
  /** 現在の HLC を返す。複数シャードの読み取りの T を決めるのに使う。 */
  now(req: Record<string, never>): Promise<Ts>;
}

export interface FlushRes {
  flushTs: Ts;
  entries: { commitTs: Ts; txn: string; changes: Change[] }[];
}

export interface MetaApi {
  ddlSince(version: number): Promise<{ version: number; ddl: string[] }>;
}

/** 移動する 1 グループ分のデータ。同じ shard key の値を持つ全表の行と未解決の intent である。 */
export interface GroupPayload {
  g: string;
  m: Ts;
  rows: { table: string; row: Row }[];
  intents: Row[];
  /** 送り出した親の表定義の版。行はこの版の形をしている。 */
  schema?: number;
}

/**
 * グループの列挙の続きの位置。表の名前の順に、表の中は shard key の順に進む。
 * table が null なら、表は読み終えている。
 */
export interface GroupCursor {
  table: string | null;
  /** この shard key より後から読む。 */
  after: Value[] | null;
  /** shard key に NULL があって after で絞れないときの読み飛ばしの数。 */
  skip?: number;
}

/** シャードの健全性。0 でない項目があれば、運用者が見るべき状態である。 */
export interface ShardHealth {
  id: string;
  schema: number;
  format: number;
  bytes: number;
  /** 適用待ちの intent の数と、最も古いものの年齢 (ms)。数秒を超えて残るなら、決着が届いていない。 */
  intents: number;
  oldestIntentMs: number;
  /** 確定したが全参加者に適用しきれていない取引の数。 */
  unapplied: number;
  /** 直近の再駆動で失敗した理由。空でなければ、同じ失敗を繰り返している。 */
  redriveErrors: string[];
  /** 移動の途中の範囲の数 (受け取り中、送り出し中)。 */
  incoming: number;
  outgoing: number;
  /** 変更ログの世代の数。 */
  logGenerations: number;
}

export interface ShardMetrics {
  id: string;
  size: number;
  reads: number;
  writes: number;
  /** 前回の報告からの経過時間 (ms)。 */
  elapsedMs: number;
  /** 最も負荷の高いグループと、その負荷の割合。 */
  topGroup: { g: string; share: number } | null;
  migrating: boolean;
  /**
   * Autoscaler から見た metrics 要求の往復時間 (ms)。シャードの待ち行列の長さを直接表す。
   * 飽和すると処理量はむしろ落ちるので、レートだけでは飽和を検知できない。
   */
  probeMs?: number;
}

export interface Clock {
  now(): number;
}

/** SQLite への同期アクセス。DO の ctx.storage と node:sqlite の両方で実装する。 */
export interface Backend {
  exec(sql: string, ...params: Value[]): Row[];
  /** 同名の列を潰さないよう、列名と値の配列で返す。 */
  raw(sql: string, ...params: Value[]): { columns: string[]; values: Value[][] };
  /**
   * 結果を 1 行ずつ返す。全行を配列にしないので、途中でやめれば残りは読まない。
   * 読み終えるか break するまで、同じ Backend への他の文を挟まないこと。
   */
  iterate(sql: string, ...params: Value[]): { columns: string[]; rows: Iterable<Value[]> };
  /** fn が throw したら ROLLBACK し、その値を再送出する。 */
  tx<T>(fn: () => T): T;
  /** 保留中の write の永続化を待つ。 */
  sync(): Promise<void>;
  /** データベースのバイト数。 */
  size(): number;
}

/** 検証済みの欠陥を再導入するスイッチ。反例の再現テスト専用で、既定はすべて false。 */
export interface Faults {
  /** autocommit の書き込みが、他の取引の intent との UNIQUE を照合しない (2026-11 のレビューで見つかった欠陥)。 */
  autoIgnoresUniqueIntents?: boolean;
  /** DDL を、持っている intent を決着させずに適用する。表や列が消えた後では、確定済みの取引の intent を適用できない。 */
  ddlIgnoresIntents?: boolean;
  /** 増設の子が、親からグループを受け取るときに表定義を追いつかせない。 */
  childKeepsOldSchema?: boolean;
  /** 行ロックや intent を待った後で、表定義を確かめ直さない。待ちの間に作られた index を保守しない書き込みが通る。 */
  noSchemaRecheck?: boolean;
  /** 取引の変更の大きさを確定の前に検査しない。変更ログの 1 行が DO の行の上限を超え、確定後の適用が失敗する。 */
  noWriteSetLimit?: boolean;
  /** 複数シャードの autocommit の読みが、決着させた取引の c > T でも T を取り直さない (同上)。 */
  noRealtimeBump?: boolean;
  anchorNoAbsorb?: boolean;
  skipReadOnlyPrepare?: boolean;
  refreshNoBump?: boolean;
  predicateProtected?: boolean;
  ignoreIntentsInValidation?: boolean;
  readerTimeoutPass?: boolean;
  hlcNoCeiling?: boolean;
  rowwiseUndo?: boolean;
  pushAfterDecide?: boolean;
  /** m5b_red_p2: 移動済みグループの phase 2 を親で適用する。 */
  applyAfterMoved?: boolean;
  /** autocommit の高速経路を使わず、常に trigger で捕捉する。 */
  triggerCapture?: boolean;
  /** m5b_red_intents: pull で intent を運ばない。 */
  dropIntentsOnMove?: boolean;
  /** 子が T < m の読みを答える (m5b_red_s3 の子の undo に相当する)。 */
  servePastMove?: boolean;
  /** 親が fence 後も要求を受理する。 */
  ignoreFence?: boolean;
  /** 親が、移動を終えた範囲を含む全表の読みを受理する。古い範囲表の読み手が、子へ移った行を読み落とす。 */
  staleWideRead?: boolean;
  /** 検証で F の代わりに T を使う。 */
  validateFromT?: boolean;
  /** 検証の代わりにロックの保持だけを信じる。ロックを失っても検出できない。 */
  trustLocks?: boolean;
}

export class ConflictError extends Error {
  readonly retryable = true;
  constructor(reason: string) {
    super(`conflict: ${reason}`);
    this.name = "ConflictError";
  }
}
export class ReadTooOld extends Error {
  readonly retryable = true;
  constructor(reason: string) {
    super(`read too old: ${reason}`);
    this.name = "ReadTooOld";
  }
}
/**
 * Worker と DO、DO と DO の間の要求の形式の版。
 * Cloudflare はデプロイ後も最大 300 秒、active な DO で旧コードを動かすので、新旧のコードが同時に話す。
 * 互換でない変更をするときだけ上げる。シャードは [MIN_PROTOCOL_VERSION, PROTOCOL_VERSION] を受け付け、
 * 新しすぎる要求は「更新中」として再試行させる。版を上げるデプロイでは、先に両方の版を読めるコードを出し、
 * 全 DO が入れ替わってから新しい版で送り始める (2 段階のデプロイ)。
 * 永続データの形式の変更は版では扱わず、起動時の移行 (ShardCore.migrateStorage) で吸収する。
 */
export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

export class VersionSkew extends Error {
  readonly retryable = true;
  constructor(detail: string) {
    super(`upgrading: ${detail}`);
    this.name = "VersionSkew";
  }
}

/** 版のない要求は版 1 とみなす。current は版を上げる訓練のときだけ上書きする。 */
export function checkProtocol(v: number | undefined, current = PROTOCOL_VERSION, min = MIN_PROTOCOL_VERSION): void {
  const got = v ?? 1;
  if (got > current) throw new VersionSkew(`request protocol ${got} is newer than this shard (${current})`);
  if (got < min) throw new VersionSkew(`request protocol ${got} is older than ${min}`);
}

export class NotOwner extends Error {
  readonly retryable = true;
  constructor(readonly to: string) {
    super(`not owner: ${to}`);
    this.name = "NotOwner";
  }
}
export class Migrating extends Error {
  readonly retryable = true;
  constructor() {
    super("migrating: a whole-table read must wait for the move to finish");
    this.name = "Migrating";
  }
}
/**
 * 1 つの取引が 1 シャードに書ける変更の合計 (変更前と変更後の行を JSON にした大きさ)。
 * 変更ログは 1 commit を 1 行に入れるので、DO の行の上限 (2 MB) に収まる必要がある。
 * 確定した後の適用で初めて上限に当たると、その取引は永久に適用できない。必ず確定の前に拒否する。
 */
export const MAX_WRITE_SET_BYTES = 1_000_000;

/**
 * Durable Object に保存しているデータの形式の版。内部の表の形や意味を、互換でない形で変えるときに上げる。
 * 新しいコードが書いた DO を古いコードが開くと、黙って壊すおそれがある。版が新しすぎれば起動を拒否する。
 */
export const STORAGE_FORMAT = 1;

/** 保存形式の版を確かめる。初めて開く DO と、版の印がまだない DO には現在の版を書く。 */
export function checkStorageFormat(b: Backend, table: string, what: string): void {
  const have = b.exec(`SELECT v FROM ${table} WHERE k = 'format'`)[0]?.v as number | undefined;
  if (have !== undefined && have > STORAGE_FORMAT) {
    throw new Error(
      `storage format too new: this ${what} was written by a newer cf-d-infinity (format ${have}); this code understands up to ${STORAGE_FORMAT}. ` +
      `Deploy the newer version again; an older release must not open this data.`,
    );
  }
  if (have !== STORAGE_FORMAT) {
    b.exec(`INSERT INTO ${table}(k, v) VALUES ('format', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, STORAGE_FORMAT);
  }
}

export class SqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlError";
  }
}
