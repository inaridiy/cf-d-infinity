// 分散プロトコルの共有型。docs/design.md の用語に対応する。
export type Ts = number;
import type { Interval } from "./routing";
import type { Tuple } from "./value";

/**
 * SQLite の値。JS の型が SQLite の格納の型である (docs/design-values.md の「値の型と符号」)。bigint は INTEGER (-2^63 から 2^63 - 1)、
 * number は REAL (整数の値でも REAL)、string は TEXT、Uint8Array は BLOB、null は NULL。
 */
export type Value = null | bigint | number | string | Uint8Array;
/**
 * ドライバが返す値と、内部の表の値。数は number である。DO の SQLite のドライバは INTEGER と REAL を区別せずに JS の数で返す
 * (2^53 を超える INTEGER は丸める)。内部の表 (`__meta`、`__intents` など) の整数は 2^53 に収まるので、number で持つ。
 */
export type Plain = null | number | string | Uint8Array;
export type Row = Record<string, Value>;
/** 内部の表の 1 行。 */
export type PlainRow = Record<string, Plain>;

/** シャードをまたぐ UNIQUE を守る index。一意でない index は、各シャードのローカル index になるので、ここには入らない。 */
export interface GlobalIndexDef {
  name: string;
  table: string; // 内部表 __gidx_<name>
  columns: string[];
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
  /** 列の型親和性。 */
  affinity: Record<string, Affinity>;
  /** 照合順序を宣言した列。 */
  collated: string[];
  /** 列の照合順序。 */
  collation: Record<string, string>;
  /** シャード内の UNIQUE (shard key を含むもの)。部分 index (WHERE 付き) の列も含む。 */
  uniques: string[][];
  /**
   * 条件付きの UNIQUE index (WHERE 付き) がある。条件の列を書き換えると、UNIQUE の列に触らなくても、行が index に入り、
   * UNIQUE の検査が別の行を読む。どの列が条件に関わるかは追わないので、UPDATE は別の行を読み得るものとして扱う。
   */
  partialUnique?: boolean;
  /**
   * DEFAULT のある列。INSERT で値を省いた列に何が入るかを知るのに使う。ここにない列は、省くと NULL になる。
   * この項目のない古い表定義では、省いた列の値は分からないものとして扱う。
   */
  defaults?: string[];
  /**
   * 出来上がった index だけが入る。既存の行から作っている最中の index は、その遷移の prepare の ddl にあり、commit までは表定義に
   * 入らないので、計画からは見えない。作っている間の書き込みの禁止は、表定義の印ではなく、スナップショットの開いている遷移
   * (src/catalog.ts の Snapshot.open の fence) である。
   */
  globalIndexes: GlobalIndexDef[];
}

export type Affinity = "INTEGER" | "REAL" | "NUMERIC" | "TEXT" | "BLOB";

/**
 * 1 行の変更。before/after はその行全体のイメージで、null は不在を表す。イメージは、表定義の列の順に並べた要素のタプル
 * (src/value.ts) で、列名は持たない。PRIMARY KEY のない表は、先頭に rowid を置く (src/shard/rows.ts の imageColumns)。
 */
export interface Change {
  table: string;
  pk: string; // pk 値のキー文字列
  sk: string; // shard key 値のキー文字列
  before: Tuple | null;
  after: Tuple | null;
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
   * 読み手の範囲表で、宛先のシャードが持つ範囲である。token の区間の組で表す (src/routing.ts の Interval)。
   * いまは、shard key を絞らない span に付ける。
   * span が覆うのは、表のうちこの範囲に載る行である。
   * 範囲表が古いと、その一部はすでに別のシャードへ移っている。
   * シャードは手放した範囲と重なれば NotOwner を返し、読み手に範囲表を取り直させる。
   * 区間の境目を shard key のブロックの中に置くようになると、shard key で絞る span にも付ける
   * (docs/design-subslots.md の「宛先と claim」)。
   */
  claim?: Interval[];
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
  /**
   * 結果の列名。Worker が、文を自分の SQLite でコンパイルして取る (Db.compiled)。シャードは、読みの文を、この数の列の型つきの読みに
   * 包み (src/value.ts の typedReadSql)、応答の列名にもこれを使う。書き込みの文では、利用者の RETURNING の列名である (Worker が
   * RETURNING の項を要素の式に書き換えて送るので、書き換える前の文から取る)。RETURNING のない書き込みは空である。
   */
  columns: string[];
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
  /**
   * maxBytes を超えたときに、拒否せずに over を返す。Worker は、集める予算の合計を、溢れたシャードへ配り直して読み直す
   * (ReadScope.scan、計画書の不変条件 13)。
   */
  budgeted?: boolean;
  /** 悲観的な DML。最新の状態で実行し、変更行のロックを取る。 */
  lock?: LockOwner;
  /** 読み取りでロックを取る行。BEGIN IMMEDIATE の主キー読みに使う。 */
  lockRows?: { table: string; pk: string }[];
  /**
   * 要求を計画した表定義の epoch (Worker のスナップショットの Catalog.schema。表定義が最後に変わった epoch)。シャードは、自分の
   * スナップショットの表定義の epoch と等しいことを確かめる。大きければ Meta の列を適用してから確かめ直し、小さければ古い計画として断る
   * (docs/design-catalog-epoch.md の「要求ごとの確かめ」)。
   */
  schema: number;
  /**
   * 要求を計画した Worker のスナップショットの epoch (Catalog.epoch)。シャードは、これが自分の epoch より大きく、要求の行が自分の
   * スナップショットでは自分のものでないときに、Meta の列を適用してから所有を確かめ直す。等しいことは求めない。範囲表だけが進んだ
   * epoch は、動いていない行の要求を古くしない (M21 の pinnedSurvives)。
   */
  epoch: number;
}

export interface LockOwner {
  txn: string;
  /** 開始時刻。古い取引が優先される (wound-wait)。 */
  start: Ts;
  /**
   * autocommit の書き込みの待ち手である。シャードが自分で付け、値はその書き込みに発行した時刻である。Worker は付けない。
   * 同じ開始時刻なら、autocommit はどの取引よりも若い (src/shard/kernel.ts の older)。
   */
  auto?: Ts;
}

export interface ExecRes {
  /** 悲観的な DML が読んだ時刻 F。 */
  F?: Ts;
  columns: string[];
  values: Value[][];
  changes: Change[];
  /**
   * 書き込みの文が変更した行の数。SQLite の changes() の値である。
   * changes の長さとは違うことがある。REPLACE が消した行は、変更としては捕捉するが、SQLite は数えない。
   * 無ければ、changes の長さと同じである。
   */
  count?: number;
  /**
   * 書き込みの文が入れた行 (表と主キーのキー文字列)。SQLite が入れた順である。捕捉が記録する (src/shard/rows.ts の capturedChanges)。
   * REPLACE が消してから入れた行を含み、UPSERT の DO UPDATE で更新しただけの行と、OR IGNORE が入れなかった行は含まない。
   * Worker は、文の結果の lastInsertRowid をこれだけから決める (src/client/db.ts の lastInsertRowid)。読みにはない。
   */
  inserted?: Pick<Change, "table" | "pk">[];
  T: Ts;
  hlc: Ts;
  epoch: number;
  /** 読みの結果のバイト数 (src/shard/core.ts の sizeOf で数える)。maxBytes を指定した読みで返す。 */
  bytes?: number;
  /** budgeted の読みが maxBytes を超えた。values は空である。 */
  over?: boolean;
  /**
   * 文が SQLite のエラーで失敗した (制約の違反など)。例外にせず、読んだ時刻と一緒に結果として返す。
   * 失敗した文も、状態を読んでいる (「同じ主キーの行がある」など)。取引は、その読みも commit で検証しなければならない。
   * 例外にすると、呼び出し側は読んだ時刻を知れず、読んだ範囲を記録できない。
   */
  error?: string;
}

export interface PrepareReq {
  txn: string;
  T: Ts;
  writes: Change[];
  spans: Span[];
  anchor: string;
  /** 取引の表定義の epoch と、取引のスナップショットの epoch (ExecReq と同じ)。 */
  schema: number;
  epoch: number;
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
  /** 取引の表定義の epoch と、取引のスナップショットの epoch (ExecReq と同じ)。参加者への prepare も、これを運ぶ。 */
  schema: number;
  epoch: number;
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
  /**
   * 表を消す前の確認 (mode guard の遷移)。schema の表定義の epoch (その遷移の prepare。表の書き込み禁止) を適用した後で、spans に
   * from より後の変更も intent もないかを答える。from は、取引がその範囲を読んだ時刻である。読みの要求が時刻を運ぶので、
   * このシャードは from を見ている。
   */
  unchanged(req: { spans: Span[]; from: Ts; schema: number }): Promise<{ ok: boolean; reason?: string }>;
  /**
   * 表定義の遷移の prepare を適用したかを答える (docs/design-catalog-epoch.md の「Worker」)。epoch は prepare の epoch で、シャードは
   * そこまで Meta の列を適用し (fence の表の intent を決着させ、以後その表への書き込みを断る)、mode が trial なら、書き込みを止めた表に
   * 文を試して巻き戻し、SQLite が通したかを返す。その遷移が自分のスナップショットでもう開いていなければ (先に abort が記録された)、
   * ok: false を返す。進める側は、範囲表の全シャードの ok を集めてから、Meta に commit を記録させる。
   * early は欠陥のスイッチ checkBeforePrepare (Worker の側) だけが付ける。列を適用せずに、いまの表で試す (M21 の m21_red_trial_early)。
   */
  prepared(req: { epoch: number; early?: true }): Promise<{ ok: boolean; reason?: string }>;
  /** pieces は移動先への転送で使う。未到着ならその piece を先に引き取る。 */
  finalize(req: { txn: string; c: Ts; pieces?: Piece[] }): Promise<void>;
  abort(req: { txn: string; pieces?: Piece[] }): Promise<void>;
  queryTxn(req: { txn: string; pushTo: Ts }): Promise<TxnStatus>;
  status(req: { txn: string }): Promise<TxnStatus>;
  flush(req: { upTo?: Ts }): Promise<FlushRes>;
  // 範囲の移動の要求は、範囲を token の区間 (Interval) で運ぶ。
  // いまのシャードは、両端が slot の境目にある区間の移動だけを受ける (ShardCore の wholeSlotsOnly)。
  // 移動は Meta の列の move-start で始まる (docs/design-catalog-epoch.md の段 4)。親は move-start を適用すると、その区間の書き込みを
  // 断り (fence)、子は適用すると受け取り始め、自分で移動を進める。子から親への要求 (listGroups、pull、finishMove) は move-start の
  // epoch を運び、親は、その epoch まで列を適用してから答える (M21 の PULL_AT_EPOCH)。
  /** 終わっていない範囲の移動。 */
  moves(req: Record<string, never>): Promise<{ outgoing: (Interval & { to: string })[]; incoming: (Interval & { from: string })[] }>;
  /** 範囲にあるグループを列挙する。列挙するのはグループで、piece ではない。 */
  listGroups(req: Interval & { limit: number; cursor?: GroupCursor | null; epoch?: number }): Promise<{ groups: string[]; cursor: GroupCursor | null }>;
  /**
   * 区間 [start, end) の fence から、piece を子へ渡す。want は、グループごとに、子が欲しい piece を位置で指す。
   * いまは、どの piece もグループの全体なので、子は `{ g, from: null }` だけを送る。
   */
  pull(req: Interval & { want: PieceWant[]; to: string; maxBytes: number; epoch?: number }): Promise<PiecePayload[]>;
  ack(req: { pieces: Piece[] }): Promise<void>;
  /**
   * 子が移動を終えるまで進める (docs/design-catalog-epoch.md の決めたこと 4)。epoch は移動の move-start の epoch で、子はそこまで列を
   * 適用し (受け取り始め)、全グループを引き取り (drain)、親の finishMove で時計を受け取り、受け取り終えた印を付け、Meta に move-end を
   * 記録させる。子が自分で (move-start を適用した後の仕事と alarm で) 進めている最中なら、それに合流する。運んだ数を返す。
   */
  drain(req: Interval & { epoch: number }): Promise<{ groups: number; rows: number; bytes: number }>;
  /**
   * 範囲を渡し終えた印を付ける。返す m は、このシャードがその範囲について発行した、どの時刻よりも大きい。
   * 受け取る側の finishIncoming に渡す。
   */
  finishMove(req: Interval & { epoch?: number }): Promise<{ m: Ts }>;
  /** 範囲を受け取り終えた印を付ける。時計を m まで進めてから、届かなかったグループ (渡す側に行がなかった) を受け持ち始める。 */
  finishIncoming(req: Interval & { m: Ts }): Promise<void>;
  metrics(req: Record<string, never>): Promise<ShardMetrics>;
  /** このシャードが健全かを運用者に見せるための状態。 */
  health(req: Record<string, never>): Promise<ShardHealth>;
  /** 表の行を主キーの順に返す。論理エクスポートに使う。 */
  exportRows(req: { table: string; after: Value[] | null; limit: number; skip?: number }): Promise<{ columns: string[]; rows: Value[][]; pk: number[] }>;
  /** 取引の rollback でロックを手放す。届かなくても TTL で消える。 */
  unlock(req: { txn: string }): Promise<void>;
  /**
   * 表定義の epoch schema まで、Meta の列を適用する。DDL を確定した側は、書き込みの禁止を早く解くために、全シャードへ適用させてから
   * 完了を返す (正しさには要らない。次の要求が適用させる)。epoch があれば、範囲の記録もその epoch まで適用する。
   */
  syncSchema(req: { schema: number; epoch?: number }): Promise<{ moving: boolean }>;
  /** 現在の HLC を返す。複数シャードの読み取りの T を決めるのに使う。 */
  now(req: Record<string, never>): Promise<Ts>;
}

export interface FlushRes {
  flushTs: Ts;
  entries: { commitTs: Ts; txn: string; changes: Change[] }[];
}

/**
 * グループの中の位置。(表の名前, 主キーのキー文字列) で、表の名前の順、表の中は主キーの順に並ぶ。null は端を表す
 * (after では先頭、upTo では末尾)。保存するときは JSON の文字列にする (端は `null`。src/shard/core.ts の posKey)。
 */
export type Pos = [table: string, pk: string] | null;

/**
 * 移動の単位 (docs/design-subslots.md の「piece の切り方」)。グループ g の行のうち、token が fence の区間 range に入り、位置が
 * after より後のものである。位置の区間の終わり (upTo) は、渡す側が最初の pull で決めて記録する。(g, range, after) で 1 つに決まる。
 * 1 通に収まるグループは、after も upTo も null の piece 1 つになる。いまは、どの piece もこの形である。
 */
export interface Piece {
  g: string;
  /** この piece を切り出した fence の、token の区間。受け取る側では、受け取った範囲の区間である。 */
  range: Interval;
  after: Pos;
  /**
   * この piece を運ぶ移動の move-start の epoch。同じグループが、範囲が前の持ち主へ戻るたびに、何度も同じシャードを出入りするので、
   * 送り出しと到着の記録は、移動ごとに分ける (docs/design-refresh-across-move.md の「受け取りの記録を残す期間」)。
   */
  epoch: number;
}

/** 子が欲しい piece。from は、子がそのグループで揃えた位置の続き (null は先頭から)。at は、要求が名指しした行の位置である。 */
export type PieceWant = { g: string; from: Pos } | { g: string; at: Pos };

/** 移動する 1 piece 分のデータ。区間 (after, upTo] にある全表の行と未解決の intent である。 */
export interface PiecePayload extends Piece {
  upTo: Pos;
  /** 渡す側がこの piece を手放した時刻。受け取る側は、時計をここまで進める。 */
  m: Ts;
  /** 行は、変更と同じくタプルで運ぶ。 */
  rows: { table: string; row: Tuple }[];
  intents: PlainRow[];
  /** 送り出した親の表定義の epoch。行はこの表定義の形をしている。 */
  schema: number;
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
  /** シャードのスナップショットの表定義の epoch (Catalog.schema と同じ数)。 */
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
  /** 適用に失敗し、取り消せもしなかった DDL。null でなければ、このシャードは要求を受けられない。 */
  schemaError?: string | null;
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

/**
 * SQLite への同期アクセス。DO の ctx.storage と node:sqlite と sql.js で実装する。
 * 入口は 2 つある (docs/design-values.md の「JS の型」)。exec、raw、iterate は内部の表のためのもので、整数の値の number を INTEGER
 * として束縛し、ドライバの値をそのまま返す。query は利用者の表に触る文のためのもので、Value を型ごと束縛する (bigint は INTEGER、
 * number は REAL)。query の結果もドライバの値のままなので、query には、型を印で運ぶ形の文 (型つきの読み、タプル、RETURNING の要素)
 * だけを渡す。
 */
export interface Backend {
  exec(sql: string, ...params: Plain[]): PlainRow[];
  /** 同名の列を潰さないよう、列名と値の配列で返す。 */
  raw(sql: string, ...params: Plain[]): { columns: string[]; values: Plain[][] };
  /**
   * 結果を 1 行ずつ返す。全行を配列にしないので、途中でやめれば残りは読まない。
   * 読み終えるか break するまで、同じ Backend への他の文を挟まないこと。
   */
  iterate(sql: string, ...params: Plain[]): { columns: string[]; rows: Iterable<Plain[]> };
  /**
   * 利用者の表に触る文。値を型ごと束縛し、結果を 1 行ずつ返す (iterate と同じく、読み終えるまで他の文を挟まない)。
   * label は、文の種類ごとの読み書きの行数の集計 (src/worker.ts の rowStats) に使う文面である。包んだ読みは、包む前の文面を渡す。
   */
  query(sql: string, params: readonly Value[], label?: string): { columns: string[]; rows: Iterable<Plain[]> };
  /** fn が throw したら ROLLBACK し、その値を再送出する。 */
  tx<T>(fn: () => T): T;
  /** 保留中の write の永続化を待つ。 */
  sync(): Promise<void>;
  /** データベースのバイト数。 */
  size(): number;
}

/** 検証済みの欠陥を再導入するスイッチ。反例の再現テスト専用で、既定はすべて false。シャードと Meta (meta.ts) が読む。 */
export interface Faults {
  /**
   * Meta の commit が、遷移が開いているかを確かめない (M21 の m21_red_two_exits と m21_red_drop_untied。段 3 まではあった
   * dropAfterExpiry の意味を広げた)。期限切れか取り消しで abort された遷移の遅れた commit も、同じ prepare を開き直して確定する。
   * abort から開き直すまでの間に書かれた行は、index の項目を持たないか (index の作成)、DROP で消える (取引が読んだ表の DROP)。
   */
  commitAfterAbort?: boolean;
  /**
   * Meta の commit が、ok を答えたシャードの集合が範囲表の全シャードを覆うことを確かめない (M21 の m21_red_early_commit、
   * m21_red_trial_missing_ack、m21_red_drop_missing_ack)。Worker の側の同じ名前のスイッチと組で、Worker は 1 つのシャードの
   * prepared を待たない (test/sim.ts の injectedFault が両方に入れる)。
   */
  commitWithoutAcks?: boolean;
  /** Meta が、表定義の遷移が開いている間に、次の prepare を記録する (M21 の m21_red_two_open)。 */
  overlappingTransitions?: boolean;
  /** Meta が、移動が開いている間に、表定義の遷移を開く (prepare を記録する。M21 の m21_red_ddl_during_move)。 */
  ddlDuringMove?: boolean;
  /** Meta が、表定義の遷移が開いている間に、移動を開く (move-start を記録する。M21 の m21_red_move_during_ddl)。 */
  moveDuringDdl?: boolean;
  /** 子が、受け取り終える前に、Meta に move-end を記録させる (M21 の m21_red_end_early)。 */
  endBeforeDrained?: boolean;
  /**
   * 親が、子からの移動の要求 (listGroups、pull、finishMove) が運ぶ move-start の epoch まで列を適用せずに答え、fence の前に頼まれた行を
   * 渡す (M21 の m21_red_pull_unfenced。モデルでは、要求が epoch を運ばない形)。親は、渡した後も、古い範囲表の書き込みを受ける。
   */
  pullWithoutEpoch?: boolean;
  /** autocommit の書き込みが、他の取引の intent との UNIQUE を照合しない (2026-11 のレビューで見つかった欠陥)。 */
  autoIgnoresUniqueIntents?: boolean;
  /**
   * 表定義の記録を、持っている intent を決着させずに適用する (M21 の m21_red_no_drain、_trial_no_drain、_drop_no_drain)。
   * 表や列が消えた後では、確定済みの取引の intent を適用できない。
   */
  ddlIgnoresIntents?: boolean;
  /** DROP の守りの確認 (unchanged) が、決着していない intent を変更として数えない (M21 の m21_red_drop_no_drain の 2 つ目の守り)。 */
  unchangedIgnoresIntents?: boolean;
  /**
   * anchor が、同じ 2PC の ID の実行を 1 つずつにしない。abortIgnoresRecord と合わせると m17_red_resend になる。
   * これだけでは、モデルの m17_red_resend_abort_check_only (確定したのに誤りと答える) は実装に現れない。記録の INSERT が失敗した
   * 実行の誤りを受けた Worker は、anchor に決着を尋ねて (status)、確定と知るからである。
   */
  concurrentDrives?: boolean;
  /**
   * 中止を決めた実行が、確定の記録が残っていても abort を送る。concurrentDrives と合わせると m17_red_resend で、後の実行の中止が、
   * 先に確定した実行の intent を消す。
   */
  abortIgnoresRecord?: boolean;
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
  /**
   * シャードが所有を確かめない。親は fence 後も要求を受理し (__fenced の拒否を外す)、どのシャードも、自分のスナップショットの範囲表で
   * 自分のものでない行の要求を受理する (M21 の m21_red_owner_unchecked。段 2 で意味を広げた)。
   */
  ignoreFence?: boolean;
  /** 親が、移動を終えた範囲を含む全表の読みを受理する。古い範囲表の読み手が、子へ移った行を読み落とす。 */
  staleWideRead?: boolean;
  /** 範囲を受け取り終えるとき、渡した側の時計を受け取らない (2026-11 までの挙動。モデル m5b_red_range)。 */
  finishWithoutClock?: boolean;
  /**
   * 受け取り終えた範囲の床を見ない (2026-11-14 までの挙動。モデル m5b_red_emptied)。渡した側が移動の前に空にしたグループを、
   * 受け取った側が、移動より前の読みの時刻でも「行なし」と答える。
   */
  noRangeFloor?: boolean;
  /**
   * prepare を適用したシャードが、fence の表への書き込みを断らない (M21 の m21_red_no_fence、_trial_no_fence、_drop_no_fence)。
   */
  ignoreTableLock?: boolean;
  /** index を公開する commit を適用するとき、その commit が運ぶ時刻まで時計を進めない (M21 の m21_clock_red_no_clock)。 */
  publishWithoutClock?: boolean;
  /** 検証で F の代わりに T を使う。 */
  validateFromT?: boolean;
  /** 検証の代わりにロックの保持だけを信じる。ロックを失っても検出できない。 */
  trustLocks?: boolean;
  /** anchor が、committed の記録の確定 (sync) を待たずに phase 2 と応答を送る (モデル m3_red)。 */
  phase2BeforeSync?: boolean;
  /** 変更ログの世代を DROP しても logLowWater を上げない。消した commit は、再起動の後の検証から見えなくなる (モデル m8_red_drop)。 */
  dropNoLowWater?: boolean;
  /** anchor の取引記録の GC が、全参加者への phase 2 を終えていない committed の記録も消す (モデル m10_red_gc_undone)。 */
  gcUndone?: boolean;
  /** 分析への flush が、未解決の intent の prepare_ts で flush 時刻を抑えない (resolved ts を使わない。モデル m6_red_resolved)。 */
  flushPastIntents?: boolean;
  /** BEGIN IMMEDIATE のロック読みを、F ではなく T の snapshot で読む。範囲の since は F のまま (モデル m9_red_imm_read_t)。 */
  lockedReadAtT?: boolean;
  /** 悲観の DML とロック読みを、F を発行せずに取引の T で実行し、since も T にする (モデル m9_red_f_is_t。守りの 1 つ目)。 */
  dmlAtT?: boolean;
  /** 悲観の DML とロック読みが、要求の T と因果トークンまで時計を進めない (モデル m9_red_f_is_t。守りの 2 つ目)。 */
  dmlSkipsClock?: boolean;
  /** wound が、prepare 済みの取引の intent も奪って捨てる (モデル m9_red_wound_prepared)。 */
  woundPrepared?: boolean;
  /** prepare が、書く行の他の取引のロックを待つ (モデル m9_red_prepare_waits)。 */
  prepareWaits?: boolean;
  /**
   * シャードの書き込みの守り (kernel.ts の claimed) を外す。シャードは、文が捕捉した変更の行を、持ち主かどうかも、文が宣言した
   * 範囲に入るかどうかも確かめずに受け入れる (2026-11-14 までの挙動)。古い範囲表で計画した複数行の INSERT が、分割で生まれた
   * 2 つのシャードの両方に全部の行を入れる (未解決の問題 35)。
   */
  ignoreWriteClaim?: boolean;
  /**
   * 結果を返す文を型つきの読みに包むとき、`LIMIT -1 OFFSET 0` の囲いを外す (docs/design-values.md の「シャードからの読み」)。
   * SQLite は包んだ文を外の文へ展開し、要素の式が列を参照するたびに、`random()` やサブクエリを評価し直す。typeof と値が別の評価から
   * 来るので、型と値が食い違う (`i` の印に文字列が続いて読めないか、整数が TEXT になる)。
   */
  unfencedRead?: boolean;
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
 * 永続データの形式の変更は、この版ではなく保存の形式の版 (STORAGE_FORMAT) で扱う (docs/storage-format.md)。
 */
// 版 2 (2026-11-13): 値の表現を変えた (整数の値の REAL の印 `{ real }`、INTEGER と REAL の束縛。src/value.ts)。版 1 の要求の数は
// 意味が違うので、受け付けない。値の表現を変えたのに版を上げ忘れていた (Codex の指摘 C5)。test/protocol.test.ts が、
// 値の表現の見本の指紋を版ごとに持ち、表現が変わったのに版が同じなら落ちる。
// 版 3 (2026-11-14): 配置を token の区間にした (docs/design-subslots.md の段 1)。範囲の単位が slot の番号 (4,096 個) から token に
// なり、span の slots を claim (token の区間の組) に替え、pull、ack、finalize、abort がグループの名前ではなく piece を運ぶ。
// 版 2 の要求は、範囲の数の意味も、移動の要求の形も違うので、受け付けない。
// 版 4 (2026-11-14): 行イメージを、列名つきの object から、表定義の列の順のタプルにした (docs/design-values.md の段 2)。
// Change の before と after、PiecePayload の rows、取引が溜める変更の形が変わる。版 3 の要求の行イメージは読めないので、受け付けない。
// 版 5 (2026-11-14): 値を、JS の型が格納の型である形にした (docs/design-values.md の段 3)。INTEGER は bigint、REAL は number で、
// 整数の値の REAL の印 `{ real }` はなくなった。ExecReq に結果の列名 (columns) を足し、シャードは読みを型つきの読みに包んで、
// 型のある値を返す。利用者の RETURNING は Worker が要素の式に書き換えて送る。版 4 の要求の数は意味が違うので、受け付けない。
// 版 6 (2026-11-15): 要求が、Worker のスナップショットの epoch と表定義の epoch を運ぶ (docs/design-catalog-epoch.md の段 2)。
// ExecReq、PrepareReq、CommitReq に epoch を足し、schema の数を DdlEntry.version から表定義の epoch に替えた。syncSchema は
// { schema } を受け、beginIncoming、fence、PiecePayload の schema も表定義の epoch である。版 5 の要求の schema は意味が違うので、
// 受け付けない。
// 版 7 (2026-11-16): 書き込みの応答 (ExecRes) が、文が入れた行 (inserted) を運ぶ。Worker は、文の結果の lastInsertRowid を、これだけから
// 決める (src/client/db.ts の lastInsertRowid)。版 6 のシャードは inserted を返さないので、新しい Worker と話すと、行を入れた文の
// lastInsertRowid が null になる。新旧が混ざらないように、版 6 の要求は受け付けない。
// 版 8 (2026-11-16): 表定義の変更を 2 相にした (docs/design-catalog-epoch.md の段 3)。シャードは Meta の列の prepare、commit、abort を
// 適用し、新しい入口 prepared で prepare を適用したかと試した結果を答える。分割の枠の版 (startSplit の答え) は、表定義の epoch だけになった。
// 版 7 のシャードは prepare の記録を適用できず、版 7 の Worker は Meta の古い入口 (applyDdl) を呼ぶので、版 7 の要求は受け付けない。
// 版 9 (2026-11-16): 範囲の移動を Meta の列の move-start と move-end で進める (docs/design-catalog-epoch.md の段 4)。beginIncoming と
// fence の入口がなくなり、子が自分で移動を進める (drain は move-start の epoch を受け、移動を終えるまで進める)。子から親への
// listGroups、pull、finishMove は move-start の epoch を運ぶ。Piece は移動の epoch を運ぶ。版 8 のシャードは move-start から
// 受け取りを始めず、版 8 の Autoscaler は分割の枠を取るので、版 8 の要求は受け付けない。
export const PROTOCOL_VERSION = 9;
export const MIN_PROTOCOL_VERSION = 9;

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
/**
 * 表定義の変更が、この表への書き込みを止めている。変更が終われば (公開されるか、取り消されれば) 書ける。
 * 何も書かずに断るので、競合と同じくやり直せる。Worker は表定義が変わるのを待ってやり直し、待ち切れなければ、この誤りを利用者へ返す。
 */
export class TableLocked extends ConflictError {
  constructor(table: string, by: string) {
    super(`locked: table ${table} is being changed by a schema change (${by}); retry when it has finished`);
    this.name = "TableLocked";
  }
}
/** TableLocked の誤りか。DO の間ではクラスが落ちるので、メッセージで見分ける。 */
export const isTableLocked = (e: unknown): boolean => /(^|: )locked: table /.test((e as Error)?.message ?? "");
/**
 * シャードの書き込みの守りが、書き込みを断った (src/shard/kernel.ts の claimed)。文が捕捉した変更の行か、取引が確定のときに渡した
 * 変更の行が、このシャードの持ち物でないか、文が宣言した範囲の外にある。何も書かずに断る。
 *
 * 範囲表が古いのではなく、要求の作り方 (Worker の計画か振り分け) の誤りである。範囲表を取り直して同じ計画を送り直しても、
 * 同じ行を書くので、また断られる。だから、やり直してよい誤り (retryable の印、`conflict:`、`not owner:` などの接頭辞) にはしない。
 * 経路の拒否 (NotOwner) と同じに扱うと、Worker は範囲表を取り直して同じ計画を送り直し、送り直した先で同じ行を書く
 * (未解決の問題 35 は、その送り直しで行を 2 つのシャードに入れた)。
 * DO の間ではクラスが落ちるので、Worker はメッセージの接頭辞 `write outside claim: ` で見分ける (isWriteOutsideClaim)。
 */
export class WriteOutsideClaim extends Error {
  constructor(detail: string) {
    super(`write outside claim: ${detail}`);
    this.name = "WriteOutsideClaim";
  }
}
/** WriteOutsideClaim の誤りか。Worker が包み直した誤り (`conflict: write outside claim: ...`) も見分ける。 */
export const isWriteOutsideClaim = (e: unknown): boolean => /(^|: )write outside claim: /.test((e as Error)?.message ?? "");
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

/** 文字列を UTF-8 にしたときのバイト数。DO の上限はバイトで決まるので、文字数 (UTF-16 の単位数) では測れない。 */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      // サロゲートの対は 4 バイトになる。
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Durable Object に保存しているデータの形式の版 (docs/storage-format.md)。内部の表の形や意味を、互換でない形で変えるときに上げる。
 * 新しいコードが書いた DO を古いコードが開くと、黙って壊すおそれがある。版が新しすぎれば起動を拒否する。
 * 上げるときは、古い版から 1 つずつ進める移行を STORAGE_MIGRATIONS に足し、古い版の材料を test/fixtures/storage/ に残す。
 *
 * 版 2 (2026-11-14): 行イメージをタプルにし、捕捉を共有の __cap(seq, tbl, old, new) にした (docs/design-values.md の段 2)。
 * __intents.change と __log_g*.blob の行イメージ、Meta の __ddl が記録する捕捉の trigger の文、__cap の形が変わる。
 * 最初の公開の前なので、版 1 からの移行は書かない (持ち主の決定、2026-11-14)。版 1 のデータは、移行がないと言って起動を拒否する。
 *
 * 版 3 (2026-11-15): Meta の __ddl と __routing を、epoch の列 __epoch(epoch, rec) の 1 表にした (docs/design-catalog-epoch.md の段 1)。
 * __meta の shadow は、版ではなく epoch を持つ。シャードの形式は変わらない。版 2 からの移行は書かない。版 2 の Meta を開くと、
 * 新しいコードは空の列を読み、表定義をなくしたように見えるので、移行がないと言って起動を拒否する。
 *
 * 版 4 (2026-11-15): シャードの __ddl(version, entry) を、Meta の epoch の列の写し __epoch(epoch, rec) にした
 * (docs/design-catalog-epoch.md の段 2)。シャードは表定義と範囲表を、この写しを畳んで作る。Meta の表は変わらないが、版の数は
 * Meta とシャードで 1 つなので、版 3 の Meta も開かない。版 3 からの移行は書かない。版 3 のシャードを開くと、新しいコードは空の写しを
 * 読み、表定義をなくしたように見えるので、移行がないと言って起動を拒否する。
 *
 * 版 5 (2026-11-16): 表定義の変更を 2 相にした (docs/design-catalog-epoch.md の段 3)。Meta とシャードの __epoch の表定義の記録が、
 * 1 つの版を運ぶ commit (DdlEntry) から、prepare、commit (of)、abort の 3 種類になった。Meta の __meta の build_lease は lease
 * (開いている遷移の期限) に、splits の枠の version は schema (表定義の epoch) になった。版 4 からの移行は書かない。版 4 のデータを
 * 開くと、新しいコードは版 4 の commit の記録を畳めないので、移行がないと言って起動を拒否する。
 *
 * 版 6 (2026-11-16): 範囲の移動を Meta の列の move-start と move-end で進める (docs/design-catalog-epoch.md の段 4)。シャードの移動の
 * 記録 (__fenced、__incoming、__moved、__moved_txn、__arrived) に、その移動の move-start の epoch の列を足し、送り出しと到着の
 * 記録を移動ごとにした (__moved と __moved_txn と __arrived の主キーに epoch が入る)。範囲が前の持ち主へ戻ると、同じシャードが同じ
 * 区間と同じグループを何度も受け取り、渡すからである。Meta の __meta の splits (分割の枠) はなくなった。版 5 からの移行は書かない。
 * 版 5 のシャードを開くと、記録の表の形が違うので、移行がないと言って起動を拒否する。
 */
export const STORAGE_FORMAT = 6;

/** 版 n の保存データを版 n + 1 にする移行。鍵は n である。最初の公開の前の形式は持たない (公開前は後方互換を持たない)。 */
const STORAGE_MIGRATIONS: Record<number, (b: Backend) => void> = {};

/** 保存形式の版を確かめる。初めて開く DO には現在の版を書く。古い版なら、移行を順に流す。 */
export function checkStorageFormat(b: Backend, table: string, what: string): void {
  const have = b.exec(`SELECT v FROM ${table} WHERE k = 'format'`)[0]?.v as number | undefined;
  if (have !== undefined && have > STORAGE_FORMAT) {
    throw new Error(
      `storage format too new: this ${what} was written by a newer cf-d-infinity (format ${have}); this code understands up to ${STORAGE_FORMAT}. ` +
      `Deploy the newer version again; an older release must not open this data.`,
    );
  }
  if (have === STORAGE_FORMAT) return;
  b.tx(() => {
    // 版の印がないのは、初めて開く DO である。
    for (let v = have ?? STORAGE_FORMAT; v < STORAGE_FORMAT; v++) {
      const step = STORAGE_MIGRATIONS[v];
      if (!step) throw new Error(`storage format ${v} of this ${what} has no migration to format ${v + 1}`);
      step(b);
    }
    b.exec(`INSERT INTO ${table}(k, v) VALUES ('format', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, STORAGE_FORMAT);
  });
}

export class SqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlError";
  }
}
