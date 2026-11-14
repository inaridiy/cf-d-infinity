import { SECOND, physicalToTs, tsToPhysical } from "../hlc";
import { ShardLimit } from "../shard-limits";
import type {
  Change, CommitReq, CommitRes, ExecReq, ExecRes, GroupCursor, LockOwner, Participant, Piece, PiecePayload, PieceWant, PrepareReq,
  PrepareRes, ShardApi, Span, Ts, TxnStatus, Value,
} from "../types";
import { ConflictError, NotOwner, ReadTooOld, SqlError, unprotectedSpans } from "../types";
import type { DdlEntry } from "../meta";
import { blockOf, overlaps, rangeText, sameInterval, type Interval } from "../routing";
import { sleep } from "../runtime";
import { asSqlError, decode, encode, insertRow, selectGroup, setBasedRestore } from "./rows";
import {
  BLOCKED, END, FALLBACK, GROUP_MAX_BYTES, LOCK_WAIT_MS, ORPHAN_AGE_MS, PENDING_UNIQUE, SCHEMA_WAIT_MS, SETTLE_TRIES, ShardKernel,
  TXN_RETAIN_MS, WOUND_DELAY_MS, intervalOf, lockIdOf, pieceOf, posKey,
  type Check, type InFlight, type IncomingRange, type Intent, type Plan, type Rows, type Section, type ShardDeps, type Waiter,
} from "./kernel";

export {
  GROUP_MAX_BYTES, LOG_GEN_MS, LOG_RETAIN_MS, MAX_CLOCK_AHEAD_MS, ORPHAN_AGE_MS, SHARD_MAX_BYTES, SHARD_MAX_ROWS, TXN_RETAIN_MS, lockIdOf,
  type ShardDeps, type SpanEscape,
} from "./kernel";

/** シャード 1 個のプロトコル本体。DO に依存せず、Node の SQLite でも同じコードが動く。 */
export class ShardCore implements ShardApi {
  readonly id: string;
  private k: ShardKernel;

  constructor(deps: ShardDeps) {
    this.id = deps.id;
    this.k = new ShardKernel(deps);
  }

  get epoch(): number {
    return this.k.epoch;
  }
  /** 直近の redrive で失敗した処理の理由。運用の診断に使う。 */
  get lastRedriveErrors(): string[] {
    return this.k.lastRedriveErrors;
  }
  // 試験が、欠陥を注入するときと、状態を確かめるときに覗く。
  private get locks(): ShardKernel["locks"] {
    return this.k.locks;
  }
  private get recentLowWater(): Ts {
    return this.k.recentLowWater;
  }

  /** 進行中の DDL の適用。同時に来た要求は同じ適用を待つ。 */
  private schemaChange: Promise<void> | null = null;

  private pulling = new Map<string, Promise<void>>();

  private async ensureSchema(version: number): Promise<void> {
    // 古い表定義の要求を通すと、新しいグローバル index の更新が漏れる。経路と同じく取り直させる。
    if (version < this.k.schema) throw new NotOwner(`stale schema ${version} < ${this.k.schema}`);
    if (version === this.k.schema) {
      // DDL の適用が intent の決着を待っている間は、古い表定義の新しい要求を受けない。
      // 受けると intent が増え続けて、DDL がいつまでも適用できない。呼び出し側は表定義を取り直して、同じ待ちに合流する。
      if (this.schemaChange) throw new NotOwner(`stale schema ${version}: a schema change is being applied`);
      return;
    }
    await this.reachSchema(version);
    // Meta にある版は全部適用するので、要求の版を通り越していることがある。要求の版が取り消されたときもそうなる。
    // その場合は、この要求が古い。
    await this.ensureSchema(version);
  }

  /**
   * 少なくともこの版まで DDL を適用する。先の版まで進んでもよい。
   * 要求の計画の版を確かめる ensureSchema と違い、増設の手順 (受け入れ、fence、行の受け取り) が使う。
   * そこでは「この版より古くない」ことだけが要る。
   */
  private async reachSchema(version: number, catchUp = false): Promise<void> {
    while (version > this.k.schema) {
      // 追いつくための適用は、移動の途中でも通る。進行中の通常の適用 (移動の途中は断られる) には合流しない。
      if (catchUp && this.schemaChange) {
        await this.schemaChange.catch(() => undefined);
        continue;
      }
      const before = this.k.schema;
      this.schemaChange ??= this.applySchema(catchUp).finally(() => {
        this.schemaChange = null;
      });
      await this.schemaChange;
      if (this.k.schema === before) throw new SqlError(`schema version ${version} is not recorded yet (shard ${this.k.id} is at ${before})`);
    }
  }

  /**
   * Meta から DDL を取り、順に適用する。
   * 先に、このシャードが持つ intent をすべて決着させる。intent の行イメージは DDL より前の表の形なので、
   * 表や列が消えた後では適用できない。確定済みの取引がそうなると、再駆動が永久に失敗する。
   */
  private async applySchema(catchUp = false): Promise<void> {
    // 範囲の移動の途中は適用しない。親と子の版がずれると、運ぶ行と intent の形が受け取る側の表と合わなくなる。
    // 親は intent を決着させないと DDL を適用できず、その決着は子へ転送され、子はその行を受け取れない、という行き詰まりになる。
    // 子が親の版へ追いつく場合 (catchUp) だけは通す。届く行がその版の形だからである。
    if (!catchUp && this.k.moving()) throw new ConflictError(`schema change is waiting for a shard split on ${this.k.id} to finish`);
    if (!this.k.faults.ddlIgnoresIntents) await this.settleAllIntents();
    const { ddl } = await this.k.deps.meta.ddlSince(this.k.schema);
    // 取り消された版と、それを取り消す版。このシャードがまだ適用していなければ、両方とも実行しない。
    const skip = new Set<number>();
    for (const e of ddl) if (e.reverts !== undefined && e.reverts > this.k.schema) skip.add(e.reverts).add(e.version);
    for (const e of ddl) {
      if (e.version <= this.k.schema) continue;
      const skipped = skip.has(e.version);
      try {
        this.k.b.tx(() => {
          if (!skipped) for (const s of e.sql) this.k.b.exec(s);
          this.k.b.exec(`INSERT INTO __ddl(version, entry) VALUES (?, ?)`, e.version, JSON.stringify(skipped ? { ...e, skipped } : e));
        });
      } catch (err) {
        return this.schemaFailed(e, (err as Error).message);
      }
      this.k.schemaStuck = null;
      if (!skipped) this.k.loadDefs(e);
      this.k.schema = e.version;
      // index を公開する版は、時刻を運ぶ。index を使わずに確定した書き込みは、どのシャードのものも、この時刻以下である。
      // ここから先、このシャードで読む文は index を使う。その文が、時刻の順で、それらの書き込みの後ろに来るようにする。
      if (e.at !== undefined && !this.k.faults.publishWithoutClock) this.k.observe(e.at);
      // 変更ログの行イメージは DDL より前の形なので、それより古い T は読み戻せない。
      this.k.ddlFloor = this.k.issue();
      this.k.metaSet("ddl_floor", this.k.ddlFloor);
    }
  }

  /**
   * このシャードの行では DDL を適用できなかった。重複のある列への UNIQUE index や、既存の行が CHECK に反する ADD COLUMN で起きる。
   * 放置すると、このシャードは全要求を断り続ける。Meta に取り消しを求め、取り消す版ごと読み飛ばして先へ進む。
   */
  private async schemaFailed(e: DdlEntry, message: string): Promise<void> {
    const reverted = await this.k.deps.meta.revokeDdl(e.version, message).catch(() => null);
    if (reverted === null) {
      this.k.schemaStuck = { version: e.version, message };
      throw new SqlError(`schema change ${e.version} cannot be applied on shard ${this.k.id}: ${message}`);
    }
    return this.applySchema(true);
  }

  /**
   * 持っている intent を、anchor に尋ねて全部決着させる。進行中の取引は終わるまで待つ。
   * 待っている間、新しい prepare は ensureSchema が断るので、intent は増えない。
   */
  private async settleAllIntents(): Promise<void> {
    // 待ちは実時間のタイマーなので、期限も実時間で測る。
    const deadline = this.k.rt.now() + SCHEMA_WAIT_MS;
    for (;;) {
      const pending = this.k.b.exec(`SELECT DISTINCT txn, anchor FROM __intents`) as unknown as Intent[];
      if (pending.length === 0) return;
      for (const i of pending) {
        const res = await this.ask(i.anchor, i.txn, 0);
        if (res.status === "committed") await this.finalize({ txn: i.txn, c: res.c });
        else if (res.status === "aborted") await this.abort({ txn: i.txn });
      }
      if ((this.k.b.exec(`SELECT count(*) n FROM __intents`)[0]!.n as number) === 0) return;
      if (this.k.rt.now() > deadline) {
        throw new ConflictError("schema change is waiting for transactions on this shard to finish");
      }
      await sleep(this.k.rt, 5);
    }
  }

  /** await の前に呼ぶ。未着のグループを引き取る。 */
  private async ensureArrived(sks: string[]): Promise<void> {
    const wanted = sks.filter((g) => this.k.incomingIn(this.k.areaOf(g)) && !this.k.arrived.has(g));
    if (wanted.length) await this.pullGroups(wanted);
  }

  async beginIncoming(req: Interval & { from: string; slot: string }): Promise<{ schema: number }> {
    this.k.wholeSlotsOnly(req);
    const range = intervalOf(req);
    const same = () => this.k.incoming.some((x) => sameInterval(x, range) && x.from_id === req.from);
    if (same()) return { schema: this.k.schema };
    // Meta が分割に渡した枠を示す。枠がある間、Meta は新しい版を記録しない (specs/m15_maintenance_slot.qnt)。
    // 受け取り始める版は、枠を取ったときの Meta の版である。分割を進める側が先に読んだ版は使わない。間に記録された版を、
    // 親だけが先に適用していると、子が親より古い版で受け取り始め、子へ移った行を読めなくなる。
    const { version } = await this.k.deps.meta.startSplit(req.slot, { parent: req.from, child: this.k.id, ...range });
    await this.reachSchema(version);
    if (same()) return { schema: this.k.schema };
    // 重なる範囲を別の親から受け取ると、どちらの行が正しいのか決められない。送り出し中のシャードも子にしない。
    const clash = this.k.incomingIn(range);
    if (clash) throw new SqlError(`shard ${this.k.id} is already receiving ${rangeText(clash)} from ${clash.from_id}`);
    if (this.k.fenced.some((f) => !f.done)) throw new ConflictError(`shard ${this.k.id} is still handing a range over; it cannot receive one until that finishes`);
    this.k.b.exec(`INSERT INTO __incoming(lo, hi, from_id) VALUES (?, ?, ?)`, range.start, range.end, req.from);
    this.k.incoming.push({ ...range, from_id: req.from });
    await this.k.b.sync();
    return { schema: this.k.schema };
  }

  async fence(req: Interval & { to: string; schema?: number; slot: string }): Promise<void> {
    this.k.wholeSlotsOnly(req);
    const range = intervalOf(req);
    const same = () => this.k.fenced.some((x) => sameInterval(x, range) && x.to === req.to);
    if (same()) return;
    // 子の表定義の版まで追いついてから fence する。子が先の版にいると、親の古い形の行と intent を子が受け取れない。
    // 移動の間は、親も子も DDL を適用しない (applySchema)。
    // 親が先の版にいるなら、そのままでよい。子は、行を受け取るときに親の版まで追いつく。
    await this.k.deps.meta.checkSplit(req.slot, { parent: this.k.id, child: req.to, ...range });
    if (req.schema !== undefined) await this.reachSchema(req.schema);
    if (same()) return;
    // 同じ範囲を 2 つの子へ送り出すと、行が両方へ分かれ、範囲表はどちらか片方しか指さない。
    const clash = this.k.fencedIn(range);
    if (clash) throw new SqlError(`${rangeText(clash)} of shard ${this.k.id} ${clash.done ? "were moved" : "are being moved"} to ${clash.to}`);
    // 受け取り中のシャードは、まだ届いていない行を持っていない。その範囲を送り出すと、届いていない行が取り残される。
    if (this.k.incoming.length > 0) throw new ConflictError(`shard ${this.k.id} is still receiving a range; it cannot be split until that finishes`);
    this.k.b.exec(`INSERT INTO __fenced(lo, hi, "to") VALUES (?, ?, ?)`, range.start, range.end, req.to);
    this.k.fenced.push({ ...range, to: req.to, done: 0 });
    await this.k.b.sync();
  }

  /**
   * piece を子へ渡す。m を確定してから応答するので、再送しても同じ m になる。
   * 親は ack まで行を保持する。子が受け取る前に落ちても再送で取り戻せるからである。
   *
   * 要求は、区間 [start, end) で fence を名指しする。区間の境目をブロックの中に置くと、同じグループが別々の fence に
   * 入り得るからである。
   * いまは、どの piece もグループの全体である (区間は端から端まで)。1 通に収まらないグループを主キーの順の区間に切るのは、
   * 後の段で足す (docs/design-subslots.md の「piece の pull」)。
   */
  async pull(req: Interval & { want: PieceWant[]; to: string; maxBytes: number }): Promise<PiecePayload[]> {
    const fence = this.k.fenced.find((x) => sameInterval(x, req));
    const out: PiecePayload[] = [];
    let bytes = 0;
    for (const w of req.want) {
      const g = w.g;
      // 続きの位置からの要求は、グループを分けて運ぶようになってから受ける。
      if ("from" in w && w.from !== null) throw new SqlError(`pull of group ${g} from a position: a group is still moved as one piece`);
      const f = fence && overlaps(fence, blockOf(g)) ? fence : undefined;
      const known0 = this.k.moved.get(g);
      if (known0 && known0.to !== req.to) throw new NotOwner(known0.to);
      if (!f) throw new SqlError(`pull of unfenced group ${g}`);
      // fence の宛先でないシャードには渡さない。渡すと、行が範囲表の指さないシャードへ行く。
      if (f.to !== req.to) throw new NotOwner(f.to);
      const rows = [...this.k.defs.values()].flatMap((def) =>
        selectGroup(this.k.b, def, g).map((row) => ({ table: def.name, row })),
      );
      const intents = this.k.faults.dropIntentsOnMove ? [] : this.k.b.exec(`SELECT * FROM __intents WHERE sk = ?`, g);
      const size = encode(rows).length + encode(intents).length;
      // 1 グループは 1 回の RPC で運ぶ。RPC の上限 (32 MiB) を超える大きさは運べないので、はっきり断る。
      // 断らないと、運べないまま再試行を続け、原因が見えない。
      if (size > GROUP_MAX_BYTES) {
        throw new SqlError(`group too large to move: shard key ${g} holds ${size} bytes (limit ${GROUP_MAX_BYTES}); this split cannot finish`);
      }
      if (out.length > 0 && bytes + size > req.maxBytes) break;
      bytes += size;
      let known = this.k.moved.get(g);
      if (!known) {
        known = { m: this.k.issue(), to: req.to, acked: false };
        this.k.moved.set(g, known);
        this.k.b.tx(() => {
          this.k.b.exec(
            `INSERT INTO __moved(g, lo, hi, "after", up_to, m, dest) VALUES (?, ?, ?, ?, ?, ?, ?)`, g, f.start, f.end, END, END, known!.m, req.to,
          );
          for (const i of intents) {
            this.k.b.exec(
              `INSERT OR IGNORE INTO __moved_txn(txn, g, lo, "after", dest) VALUES (?, ?, ?, ?, ?)`, i.txn as string, g, f.start, END, req.to,
            );
          }
        });
      }
      out.push({ g, range: intervalOf(f), after: null, upTo: null, m: known.m, rows, intents, schema: this.k.schema });
    }
    await this.k.b.sync();
    return out;
  }

  private pullGroups(groups: string[]): Promise<void> {
    const waits: Promise<void>[] = [];
    const fresh: string[] = [];
    for (const g of groups) {
      const p = this.pulling.get(g);
      if (p) waits.push(p);
      else fresh.push(g);
    }
    if (fresh.length) {
      const job = this.fetchGroups(fresh).finally(() => {
        for (const g of fresh) this.pulling.delete(g);
      });
      for (const g of fresh) this.pulling.set(g, job);
      waits.push(job);
    }
    return Promise.all(waits).then(() => undefined);
  }

  private async fetchGroups(groups: string[]): Promise<void> {
    // pull は、渡す側の fence を範囲で名指しする。受け取り中の範囲ごとにまとめて送る。
    const byRange = new Map<IncomingRange, string[]>();
    for (const g of groups) {
      const range = this.k.incomingIn(this.k.areaOf(g))!;
      byRange.set(range, [...(byRange.get(range) ?? []), g]);
    }
    for (const [range, list] of byRange) {
      const from = range.from_id;
      let rest = list;
      while (rest.length) {
        const payload = await this.k.deps.peer(from).pull({ ...intervalOf(range), want: rest.map((g) => ({ g, from: null })), to: this.k.id, maxBytes: 1_000_000 });
        await this.receive(payload);
        void this.k.deps.peer(from).ack({ pieces: payload.map(pieceOf) }).catch(() => {});
        const got = new Set(payload.map((p) => p.g));
        rest = rest.filter((g) => !got.has(g));
      }
    }
  }

  private async receive(payload: PiecePayload[]): Promise<void> {
    // グループの一部だけの piece は、まだ受け取れない。受け取ると、一部しか届いていないグループを「到着した」と記録してしまう。
    const part = payload.find((p) => p.after !== null || p.upTo !== null);
    if (part) throw new SqlError(`received a part of group ${part.g}: a group is still moved as one piece`);
    // 親の表定義の版まで追いついてから受け取る。子は増設の途中で生まれるので、DDL の「全シャードへの適用」から
    // 漏れることがある。古い版のままだと、届いた行と表の形が合わず、新しい index を保守しない古い計画の書き込みも通る。
    const version = Math.max(0, ...payload.map((p) => p.schema));
    if (!this.k.faults.childKeepsOldSchema) await this.reachSchema(version, true);
    const fresh = payload.filter((p) => !this.k.arrived.has(p.g));
    this.k.b.tx(() => {
      for (const p of fresh) {
        for (const { table, row } of p.rows) insertRow(this.k.b, this.k.def(table), row);
        for (const i of p.intents) {
          this.k.b.exec(
            `INSERT OR IGNORE INTO __intents(tbl, pk, sk, txn, anchor, prepare_ts, change) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            i.tbl ?? null, i.pk ?? null, i.sk ?? null, i.txn ?? null, i.anchor ?? null, i.prepare_ts ?? null, i.change ?? null,
          );
        }
        this.k.b.exec(
          `INSERT OR IGNORE INTO __arrived(g, lo, hi, "after", up_to, m) VALUES (?, ?, ?, ?, ?, ?)`,
          p.g, p.range.start, p.range.end, posKey(p.after), posKey(p.upTo), p.m,
        );
      }
    });
    // 到着の印は挿入と同じ同期区間で付ける。sync の待ちの間に、要求駆動の pull と背景の drain が
    // 同じグループを受け取ると二重に挿入してしまう。応答は output gate が確定まで止めるので安全である。
    for (const p of fresh) {
      this.k.arrived.set(p.g, p.m);
      this.k.maxArrived = Math.max(this.k.maxArrived, p.m);
      this.k.observe(p.m);
    }
    await this.k.b.sync(); // 親が行を消すのは到着の確定後である。
  }

  async drain(req: Interval): Promise<{ groups: number; rows: number; bytes: number }> {
    const range = this.k.incoming.find((x) => sameInterval(x, req));
    if (!range) return { groups: 0, rows: 0, bytes: 0 };
    const parent = this.k.deps.peer(range.from_id);
    // 到着済みのグループの piece。いまは、グループの全体の 1 つである。
    const interval = intervalOf(range);
    const whole = (g: string): Piece => ({ g, range: interval, after: null });
    const total = { groups: 0, rows: 0, bytes: 0 };
    // 親のグループを先頭から順に列挙して運ぶ。最後まで行ったら、もう一度先頭から列挙して、取り残しがないことを確かめる。
    // ack 済みのグループは親から消えているので、2 周目は残る側のグループを読むだけである。
    for (let pass = 0; ; pass++) {
      let cursor: GroupCursor | null | undefined = undefined;
      let moved = 0;
      do {
        const page: { groups: string[]; cursor: GroupCursor | null } = await parent.listGroups({ ...interval, limit: 256, cursor });
        cursor = page.cursor;
        // 受け取り済みで親に ack が届いていないグループは、ack だけを送り直す。
        const done = page.groups.filter((g) => this.k.arrived.has(g));
        if (done.length) await parent.ack({ pieces: done.map(whole) });
        let rest = page.groups.filter((g) => !this.k.arrived.has(g));
        moved += page.groups.length;
        // pull は大きさの上限で途中までしか返さないことがある。残りを取り終えるまで繰り返す。
        while (rest.length) {
          const payload = await parent.pull({ ...interval, want: rest.map((g) => ({ g, from: null })), to: this.k.id, maxBytes: 1_000_000 });
          await this.receive(payload);
          await parent.ack({ pieces: payload.map(pieceOf) });
          total.groups += payload.length;
          for (const p of payload) {
            total.rows += p.rows.length;
            total.bytes += encode(p.rows).length;
          }
          const got = new Set(payload.map((p) => p.g));
          rest = rest.filter((g) => !got.has(g));
        }
      } while (cursor !== null);
      if (moved === 0) return total;
      if (pass > 100) throw new SqlError("drain does not converge");
    }
  }

  /**
   * ロックか intent が空くまで待つ。wound-wait で、若い保持者からは取り上げる。
   * 取り上げられた取引は commit の検証で気付く。prepare 済みの intent は取り上げられないので待つ。
   * prepare 自身はこの待ちに入らない。入ると閉路ができる。
   */
  private waitForRow(key: string, me: LockOwner, deadline: number): Promise<void> {
    const lock = this.k.liveLock(key);
    // 欠陥 woundPrepared は、ロックのない行の intent の持ち主 (prepare 済みの取引) も奪う相手にする。
    // intent に開始時刻はないので、prepare_ts の物理時刻で代える。
    const cut = key.indexOf("\0");
    const intent = !lock && this.k.faults.woundPrepared ? this.k.intentAt(key.slice(0, cut), key.slice(cut + 1)) : undefined;
    const held: LockOwner | undefined = lock ?? (intent && { txn: intent.txn, start: tsToPhysical(intent.prepare_ts) });
    return new Promise((resolve, reject) => {
      const list = this.k.waiters.get(key) ?? [];
      const leave = () => {
        const at = list.indexOf(w);
        if (at >= 0) list.splice(at, 1);
        this.k.rt.cancel(timer);
        this.k.rt.cancel(wound);
        this.k.rt.cancel(expiry);
      };
      const timer = this.k.rt.after(Math.max(1, deadline - this.k.deps.clock.now()), () => {
        leave();
        reject(new ConflictError("lock wait timeout"));
      });
      const wound = held && this.k.older(me, held)
        ? this.k.rt.after(WOUND_DELAY_MS, () => {
            if (intent) {
              if (this.k.intentAt(intent.tbl, intent.pk)?.txn !== intent.txn) return;
              this.k.b.exec(`DELETE FROM __intents WHERE tbl = ? AND pk = ?`, intent.tbl, intent.pk);
            } else {
              if (this.k.locks.get(key)?.txn !== held.txn) return;
              this.k.locks.delete(key);
            }
            leave();
            resolve();
          })
        : undefined;
      // 保持者の Worker が死ぬと誰もロックを解放しない。期限で確かめないと待ち手が眠ったままになる。
      let expiry: unknown;
      const watch = () => {
        const l = this.k.liveLock(key); // 切れていれば wakeNext が先頭を起こす
        if (l) expiry = this.k.rt.after(Math.max(1, l.expires - this.k.deps.clock.now() + 1), watch);
      };
      if (lock) expiry = this.k.rt.after(Math.max(1, lock.expires - this.k.deps.clock.now() + 1), watch);
      const w: Waiter = { ...me, wake: () => { leave(); resolve(); } };
      // 古い取引を先に起こす。同じ開始時刻の間は到着順である。
      const at = list.findIndex((x) => this.k.older(me, x));
      list.splice(at < 0 ? list.length : at, 0, w);
      this.k.waiters.set(key, list);
    });
  }

  /**
   * 欠陥 prepareWaits だけが使う。prepare が、書く行の他の取引のロックが空くのを待つ。prepare の要求に開始時刻はないので、
   * 最も若い待ち手として待ち、wound はしない。期限を過ぎたら待つのをやめ、検証に任せる (ロックが残っていれば abort)。
   */
  private async waitForForeignLocks(txn: string, writes: Pick<Change, "table" | "pk">[]): Promise<void> {
    const deadline = this.k.deps.clock.now() + LOCK_WAIT_MS;
    const me: LockOwner = { txn: lockIdOf(txn), start: Number.MAX_SAFE_INTEGER };
    for (const w of writes) {
      const key = this.k.lockKey(w.table, w.pk);
      for (let l = this.k.liveLock(key); l && l.txn !== me.txn; l = this.k.liveLock(key)) {
        if (this.k.deps.clock.now() >= deadline) return;
        await this.waitForRow(key, me, deadline).catch(() => undefined);
      }
    }
  }

  /**
   * 悲観的な DML。最新の状態 F で実行し、変更行のロックを取る。
   * 先に intent を決着させる。確定済みで未適用の行を読み飛ばすと、T も F も新しいのに見えない commit ができる。
   */
  private async lockedExec(req: ExecReq, me: LockOwner): Promise<ExecRes> {
    const deadline = this.k.deps.clock.now() + LOCK_WAIT_MS;
    // 最新の状態を読むので、読む時刻はない。
    const claim: Rows = { spans: req.spans, writes: [], at: null };
    // 起こされた行。取らずに去るなら次の待ち手を起こす。起こすのは先頭の 1 件だけだからである。
    let woken: string | null = null;
    try {
      for (;;) {
        await this.ensureArrived(this.k.sksOf(req.spans));
        // F はこのシャードが発行する時刻である。取引の T と因果トークンまで時計を進めてから発行するので、F より後の確定は F より大きい
        // (specs/m9_protocol.qnt の m9_red_f_is_t)。
        if (!this.k.faults.dmlSkipsClock) {
          this.k.observe(req.minTs);
          this.k.observe(req.T);
        }
        // 欠陥 dmlAtT は、F を発行せず、取引の T を F として使う。T は別のシャードの時計から来ることがある。
        const atT = this.k.faults.dmlAtT && req.T !== undefined;
        let F = atT ? req.T! : this.k.issue();
        this.k.assertOwned(claim);
        let applied = await this.settleIntents(req.spans, F);
        while (applied) {
          if (!atT) F = this.k.issue();
          applied = await this.settleIntents(req.spans, F);
        }
        // ここから先は await を挟まない。版は確かめ直さない。行ロックや intent の決着を待っている間に DDL が適用されると、この文は
        // 古い計画のまま実行される。文の変更は、取引の確定 (commitLocal、prepare、commit) が版を確かめる。
        const sec = this.k.enter(claim);
        this.k.count("writes", req.spans);
        this.k.renew(me.txn);
        const overlay = (req.overlay ?? []).map((c) => ({ table: c.table, pk: c.pk, image: c.after }));
        let out: { columns: string[]; values: Value[][]; changes: Change[]; count?: number };
        // 欠陥 lockedReadAtT は、ロック読みを T の snapshot で読む (返す F は変えない)。dmlAtT は、F = T の状態で実行する。
        const readAt = atT ? F : this.k.faults.lockedReadAtT && !req.write ? req.T : undefined;
        try {
          out = this.k.rollback(() => {
            if (readAt !== undefined) this.k.restore(this.k.deltaAfter(readAt));
            if (overlay.length) setBasedRestore(this.k.b, (t) => this.k.def(t), overlay);
            return this.k.run(sec, req);
          });
        } catch (e) {
          if (e instanceof ReadTooOld || e instanceof ConflictError || e instanceof NotOwner || e instanceof ShardLimit) throw e;
          // 文は F の状態を読んだうえで失敗した。読んだ時刻を付けて返し、呼び出し側に範囲を記録させる (ExecRes.error)。
          return { columns: [], values: [], changes: [], error: asSqlError(e).message, F, T: req.T ?? F, hlc: this.k.hlc.value, epoch: this.k.epoch };
        }
        const rows = [...out.changes, ...(req.lockRows ?? [])] as Pick<Change, "table" | "pk">[];
        const blocked = this.k.blockedBy(rows, me);
        if (!blocked) {
          for (const c of rows) this.k.grant(this.k.lockKey(c.table, c.pk), me);
          if (woken && this.k.locks.get(woken)?.txn === me.txn) woken = null;
          return { ...out, changes: out.changes.map((c) => ({ ...c, since: F })), F, T: req.T ?? F, hlc: this.k.hlc.value, epoch: this.k.epoch };
        }
        if (woken && woken !== blocked) this.k.wakeNext(woken);
        woken = null;
        if (this.k.deps.clock.now() >= deadline) throw new ConflictError("lock wait timeout");
        await this.waitForRow(blocked, me, deadline);
        woken = blocked;
      }
    } finally {
      if (woken) this.k.wakeNext(woken);
    }
  }

  async syncSchema(req: { version: number }): Promise<{ moving: boolean }> {
    if (req.version > this.k.schema) await this.ensureSchema(req.version);
    return { moving: this.k.moving() };
  }

  private async ask(anchor: string, txn: string, pushTo: Ts): Promise<TxnStatus> {
    return anchor === this.k.id ? this.queryTxn({ txn, pushTo }) : this.k.deps.peer(anchor).queryTxn({ txn, pushTo });
  }

  /**
   * T 以下で確定し得る intent をすべて決着させる。
   * 無視してよいのは commit 時刻が T を超えると確定した intent だけである。
   */
  private async settleIntents(spans: Span[], T: Ts): Promise<Ts> {
    const pushed = new Set<string>();
    // 取引ごとの、この呼び出しで決着させた回数。決着させた後も intent が残ることはある (運ばれた行の到着を待つ、など)。
    // その場合は、イベントループへ制御を返して待ってから、もう 1 度問い合わせる。上限を超えて残るなら、ここでは適用できない
    // (不変条件 2 の症状)。
    const settled = new Map<string, number>();
    // 適用した取引の commit 時刻の最大値。何も適用していなければ 0。
    let applied: Ts = 0;
    for (;;) {
      const pending = this.k.overlapping(spans, T).filter((i) => !pushed.has(i.txn));
      if (pending.length === 0) return applied;
      for (const txn of new Set(pending.map((i) => i.txn))) {
        const intent = pending.find((i) => i.txn === txn)!;
        const tries = settled.get(txn) ?? 0;
        if (tries >= SETTLE_TRIES) {
          // 待たずに問い合わせを繰り返すと止まらない。anchor が自分なら問い合わせも適用も microtask だけで済み、イベントループが回らず、
          // どの時間の制限も効かない (未解決の問題 18)。読みを、理由を付けて失敗させる。
          throw new SqlError(`stuck: transaction ${txn} is decided but its write to ${intent.tbl} cannot be applied on ${this.k.id}`);
        }
        if (tries > 0) await sleep(this.k.rt, Math.min(100, 2 ** tries));
        settled.set(txn, tries + 1);
        if (this.k.faults.readerTimeoutPass) {
          pushed.add(txn);
          continue;
        }
        const res = await this.ask(intent.anchor, txn, T);
        if (res.status === "committed") {
          await this.finalize({ txn, c: res.c });
          applied = Math.max(applied, res.c);
        } else if (res.status === "aborted") await this.abort({ txn });
        else pushed.add(txn);
      }
    }
  }

  /** 時刻 T の状態 (と自分の未 commit write) の上で文を実行し、ROLLBACK する。 */
  async exec(req: ExecReq): Promise<ExecRes> {
    this.k.withinLimits(req);
    await this.ensureSchema(req.schema);
    if (req.lock && (req.write || req.lockRows)) {
      try {
        return await this.lockedExec(req, req.lock);
      } catch (e) {
        if (e instanceof ReadTooOld || e instanceof ConflictError || e instanceof NotOwner || e instanceof ShardLimit) throw e;
        throw asSqlError(e);
      }
    }
    if (req.lock) this.k.renew(req.lock.txn);
    await this.ensureArrived(this.k.sksOf(req.spans));
    this.k.observe(req.minTs);
    let T = req.T ?? this.k.issue();
    this.k.observe(T);
    this.k.assertOwned({ spans: req.spans, writes: [], at: T });
    let applied = await this.settleIntents(req.spans, T);
    // 時刻が未指定の読みは、決着させた取引より後の時刻で読む。先に取った T のままだと、
    // 読み取りの開始前に確定した書き込みが見えない。push した取引の c が新しい T 以下になり得るので、
    // 決着が起きなくなるまで取り直す。
    while (req.T === undefined && applied) {
      T = this.k.issue();
      applied = await this.settleIntents(req.spans, T);
    }
    // T を指定した autocommit の読み (複数シャードの読み) も同じである。T は対象シャードの時計の最大値だが、
    // phase 2 が届いていない参加者の時計は commit 時刻に追いついていない。anchor の時計が進んでいると c > T になり、
    // そのまま T で読むと、開始前に確定して応答まで返った書き込みが見えない。T を取り直させる。
    if (req.T !== undefined && req.realtime && applied > T && !this.k.faults.noRealtimeBump) throw new ReadTooOld(`moved at ${this.k.hlc.value}`);
    // ここから先は await を挟まない。版は確かめ直さない。intent の決着を待っている間に DDL が適用されると、この文は古い計画の
    // まま実行される。取引の文の変更は、取引の確定 (commitLocal、prepare、commit) が版を確かめる。
    const sec = this.k.enter({ spans: req.spans, writes: [], at: T });
    this.k.count(req.write ? "writes" : "reads", req.spans);
    if (req.fresh && req.spans.some((s) => this.k.changedSince(sec, s, T))) {
      throw new ReadTooOld(`moved at ${this.k.hlc.value}`);
    }
    const delta = this.k.deltaAfter(T);
    const overlay = (req.overlay ?? []).map((c) => ({ table: c.table, pk: c.pk, image: c.after }));
    try {
      if (delta.length === 0 && overlay.length === 0 && !req.write) {
        // 差分がなければ本体がそのまま T の状態なので、トランザクションは要らない。
        return { ...this.k.run(sec, req), T, hlc: this.k.hlc.value, epoch: this.k.epoch };
      }
      const out = this.k.rollback(() => {
        this.k.restore(delta);
        if (overlay.length) setBasedRestore(this.k.b, (t) => this.k.def(t), overlay);
        return this.k.run(sec, req);
      });
      return { ...out, T, hlc: this.k.hlc.value, epoch: this.k.epoch };
    } catch (e) {
      if (e instanceof ReadTooOld || e instanceof ConflictError || e instanceof NotOwner || e instanceof ShardLimit) throw e;
      // 文は T の状態を読んだうえで失敗した。読んだ時刻を付けて返し、呼び出し側に範囲を記録させる。
      return { columns: [], values: [], changes: [], error: asSqlError(e).message, T, hlc: this.k.hlc.value, epoch: this.k.epoch };
    }
  }

  /** シングルシャードの autocommit 書き込み。1 回の RPC で完結する。 */
  async execAuto(req: ExecReq): Promise<ExecRes> {
    this.k.withinLimits(req);
    await this.ensureSchema(req.schema);
    await this.ensureArrived(this.k.sksOf(req.spans));
    this.k.observe(req.minTs);
    const now = this.k.issue();
    // 最新の状態に書くので、読む時刻はない。
    const claim: Plan & Rows = { schema: req.schema, spans: req.spans, writes: [], at: null };
    this.k.assertOwned(claim);
    await this.settleIntents(req.spans, now);
    let sec = this.k.enter(claim);
    this.k.count("writes", req.spans);
    // 読む範囲に未決着の intent があると commit 時刻の順序を保証できないので no-wait で返す。
    if (!this.k.faults.ignoreIntentsInValidation && this.k.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) {
      throw new ConflictError("pending intent");
    }
    try {
      if (req.write?.capture && !this.k.faults.triggerCapture) {
        const direct = await this.execDirect(sec, req, claim, now);
        if (direct) return direct;
        // execDirect の応答を受け取るまでに、制御を 1 回手放している (microtask)。ここでは区間に入り直さず、下の下書きは、手放す前の
        // 印で実行する。版は、確定の直前に確かめ直す。持ち主は確かめ直さない。
      }
      let dry = this.k.rollback(() => this.k.run(sec, req));
      // autocommit は取引より若いものとして順番を待つ。待っている間に行が変わるので実行し直す。
      const me: LockOwner = { txn: `auto-${now}`, start: this.k.deps.clock.now() };
      const deadline = this.k.deps.clock.now() + LOCK_WAIT_MS;
      // autocommit はロックを取らないので、起こされたら用が済み次第次の待ち手を起こす。
      const woken = new Set<string>();
      try {
        for (let key = this.k.blockedBy(dry.changes, me); key !== null; key = this.k.blockedBy(dry.changes, me)) {
          await this.waitForRow(key, me, deadline);
          woken.add(key);
          sec = this.k.enter(claim);
          if (this.k.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) throw new ConflictError("pending intent");
          dry = this.k.rollback(() => this.k.run(sec, req));
        }
      } finally {
        for (const key of woken) queueMicrotask(() => this.k.wakeNext(key));
      }
      // 同じ主キーでなくても、他の取引の intent が同じ UNIQUE の値を持っていれば確定できない。
      const pending = this.k.faults.autoIgnoresUniqueIntents ? null : this.k.uniquePending(me.txn, dry.changes);
      if (pending) throw new ConflictError(pending);
      this.k.assertWriteSetFits(sec, dry.changes);
      // 下書きを取った区間の続きで、間に await はない。execDirect が null を返した後の道では、制御を手放した後の確かめ直しは、
      // これだけである。
      this.k.enter({ schema: req.schema });
      const c = this.k.issue();
      if (dry.changes.length) this.k.b.tx(() => this.k.applyAndLog(`auto-${c}`, c, dry.changes));
      return { ...dry, T: c, hlc: this.k.hlc.value, epoch: this.k.epoch };
    } catch (e) {
      if (e instanceof ConflictError || e instanceof NotOwner) throw e;
      throw asSqlError(e);
    }
  }

  /**
   * autocommit の高速経路。文を下書きせずに 1 回だけ実行し、そのまま確定する。
   * ROLLBACK した書き込みも課金されるので、下書きと再適用をやめると 1 行の更新が 6 行から 2 行になる。
   * 行ロックに当たったときだけ ROLLBACK して待つ。捕捉できない形なら null を返し、通常の経路に任せる。
   *
   * execAuto が、同期区間の中で呼ぶ。最初の実行は、その区間の印 (sec) で行う。行ロックを待った後は、同じ claim で区間に入り直す。
   */
  private async execDirect(sec: Section<Check>, req: ExecReq, claim: Plan & Rows, now: Ts): Promise<ExecRes | null> {
    const me: LockOwner = { txn: `auto-${now}`, start: this.k.deps.clock.now() };
    const deadline = this.k.deps.clock.now() + LOCK_WAIT_MS;
    const woken = new Set<string>();
    try {
      for (;;) {
        const hit: { key: string | null } = { key: null };
        const pending: { reason: string | null } = { reason: null };
        let out: { changes: Change[]; c: Ts } | undefined;
        try {
          out = this.k.b.tx(() => {
            const r = this.k.checked(sec, req, () => this.k.runCaptured(req));
            if (!r) throw FALLBACK;
            hit.key = this.k.blockedBy(r.changes, me);
            if (hit.key !== null) throw BLOCKED;
            pending.reason = this.k.faults.autoIgnoresUniqueIntents ? null : this.k.uniquePending(me.txn, r.changes);
            if (pending.reason) throw PENDING_UNIQUE;
            this.k.assertWriteSetFits(sec, r.changes);
            const c = this.k.issue();
            if (r.changes.length) this.k.logChanges(`auto-${c}`, c, r.changes);
            return { changes: r.changes, c };
          });
        } catch (e) {
          if (e === FALLBACK) return null;
          if (e === PENDING_UNIQUE) throw new ConflictError(pending.reason!);
          if (e !== BLOCKED) throw e;
        }
        if (out) return { columns: [], values: [], changes: out.changes, T: out.c, hlc: this.k.hlc.value, epoch: this.k.epoch };
        await this.waitForRow(hit.key!, me, deadline);
        woken.add(hit.key!);
        sec = this.k.enter(claim);
        if (this.k.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) throw new ConflictError("pending intent");
      }
    } finally {
      for (const key of woken) queueMicrotask(() => this.k.wakeNext(key));
    }
  }

  async commitLocal(req: Omit<PrepareReq, "anchor">): Promise<CommitRes> {
    await this.ensureSchema(req.schema);
    await this.ensureArrived(this.k.sksOf(req.spans, req.writes));
    if (this.k.faults.prepareWaits) await this.waitForForeignLocks(req.txn, req.writes);
    // グループの到着を待っている間に DDL が適用されることがある。古い計画のまま書かない。
    // 時計は、版を確かめた後、持ち主を確かめる前に進める。版の古い要求の T は、時計に取り込まない。
    this.k.enter({ schema: req.schema });
    this.k.observe(req.T);
    const sec = this.k.enter({ schema: req.schema, spans: req.spans, writes: req.writes, at: req.T });
    try {
      this.k.assertWriteSetFits(sec, req.writes);
    } catch (e) {
      this.k.releaseLocks(req.txn);
      throw e;
    }
    const reason = this.k.validate(sec, req.txn, req.T, req.writes, req.spans);
    if (reason) {
      this.k.releaseLocks(req.txn); // 失敗した取引のロックを残すと、TTL まで全員が待つ
      return { ok: false, reason };
    }
    const c = this.k.issue();
    if (req.writes.length) this.k.b.tx(() => this.k.applyAndLog(req.txn, c, req.writes));
    this.k.releaseLocks(req.txn);
    this.k.count("writes", req.spans, req.writes);
    return { ok: true, c };
  }

  async prepare(req: PrepareReq): Promise<PrepareRes> {
    await this.ensureSchema(req.schema);
    await this.ensureArrived(this.k.sksOf(req.spans, req.writes));
    if (this.k.faults.prepareWaits) await this.waitForForeignLocks(req.txn, req.writes);
    return this.k.prepareSync(this.k.enter({ schema: req.schema }), req);
  }

  /**
   * 表を消す前の確認 (Db の guardedDrop、specs/m14_rebuild_guard.qnt)。
   * 先に、表を書き込み禁止にする版を適用する。適用の前に intent を全部決着させ、適用の後は、その表への書き込みを断る。
   * だから、ここで変更がなければ、表を消すまで、読んだ範囲は変わらない。
   */
  async unchanged(req: { spans: Span[]; from: Ts; schema: number }): Promise<{ ok: boolean; reason?: string }> {
    let sec: Section<"owned">;
    try {
      await this.ensureSchema(req.schema);
      sec = this.k.enter({ spans: req.spans, writes: [], at: req.from });
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    for (const s of req.spans) {
      if (this.k.changedSince(sec, s, Math.max(req.from, s.since ?? 0))) return { ok: false, reason: `${s.table} changed after it was read` };
      // 版の適用は intent を決着させてから行う (settleAllIntents) が、それに頼らず、決着していない書き込みも変更として数える。
      const hit = this.k.faults.unchangedIgnoresIntents ? undefined : this.k.overlapping([s], Number.MAX_SAFE_INTEGER)[0];
      if (hit) return { ok: false, reason: `${s.table} has a pending write of ${hit.txn}` };
    }
    return { ok: true };
  }

  async commit(req: CommitReq): Promise<CommitRes> {
    await this.ensureSchema(req.schema);
    // 同じ 2PC の ID の実行は 1 つずつにする。同じ中身の COMMIT が 2 つ同時に届くと (再送が元の COMMIT を追い越す)、後の実行の
    // prepare は、先の実行が適用した行に当たって断られ、中止の abort(ID) が先の実行の残りの intent を消した
    // (specs/m17_txn_id_reuse.qnt の m17_red_resend、2026-11-13 の Codex の 2 回目の見直し、指摘 1)。先の実行が終わるのを待って
    // から記録を確かめ、待ち終えてから実行を登録するまで await を挟まない。
    for (let f = this.k.inflight.get(req.txn); f && !this.k.faults.concurrentDrives; f = this.k.inflight.get(req.txn)) await f.settled;
    // 2PC の ID は、取引の ID と続きの中身の指紋である (Txn.commit)。同じ ID の記録があるのは、同じ中身の COMMIT の再送なので、
    // 前の結果を返す。baton の使い回しでできた中身の違う続きは、別の ID の別の 2PC になる。
    const done = this.k.b.exec(`SELECT status, c FROM __txn WHERE txn = ?`, req.txn)[0];
    if (done) return done.status === "committed" ? { ok: true, c: done.c as Ts } : { ok: false, reason: "aborted" };
    // 決着の記録は保持時間の後に消す。消した tombstone の後に同じ取引の COMMIT が届いて確定すると、
    // 中止と判断して intent を無視した読み手と矛盾する (specs/m10_txn_record_gc.qnt の反例)。
    // 保持時間の半分より古い取引の COMMIT を受け付けなければ、消した後に確定することはない。
    if (this.k.deps.clock.now() - tsToPhysical(req.T) > (this.k.deps.txnRetainMs ?? TXN_RETAIN_MS) / 2) {
      return { ok: false, reason: "conflict: transaction older than the commit window" };
    }
    let settle = () => {};
    const settled = new Promise<void>((r) => (settle = r));
    const flight: InFlight = { pushed: 0, decided: false, settled, settle };
    this.k.inflight.set(req.txn, flight);
    try {
      const me = req.participants.find((p) => p.shard === this.k.id);
      if (me) await this.ensureArrived(this.k.sksOf(me.spans, me.writes));
      return await this.drive(req, flight);
    } finally {
      this.k.inflight.delete(req.txn);
      flight.settle();
    }
  }

  private async drive(req: CommitReq, flight: InFlight): Promise<CommitRes> {
    const self = req.participants.find((p) => p.shard === this.k.id);
    if (!self) throw new SqlError("anchor must be a participant");
    let others = req.participants.filter((p) => p.shard !== this.k.id);
    if (this.k.faults.skipReadOnlyPrepare) others = others.filter((p) => p.writes.length > 0);

    const acks = await Promise.all(
      others.map((p) =>
        this.k.deps.peer(p.shard).prepare({
          txn: req.txn, T: req.T, writes: p.writes, spans: p.spans, anchor: this.k.id, schema: req.schema,
        }),
      ),
    );
    const failed = acks.find((a) => !a.ok);
    if (failed && !failed.ok) return this.decideAbort(req, failed.reason);
    const stamps = acks.map((a) => (a as { prepareTs: Ts }).prepareTs);
    if (this.k.faults.prepareWaits) await this.waitForForeignLocks(req.txn, self.writes);

    // ここから c の確定までは await を挟まない。
    // 参加者の応答を待っている間に、この anchor に DDL が適用されていれば、取引は古い表定義で計画されている。
    let plan: Section<"schema">;
    try {
      plan = this.k.enter({ schema: req.schema });
    } catch (e) {
      return this.decideAbort(req, (e as Error).message);
    }
    if (!this.k.faults.anchorNoAbsorb) this.k.observe(Math.max(0, ...stamps, flight.pushed));
    const mine = this.k.prepareSync(plan, {
      txn: req.txn, T: req.T, writes: self.writes, spans: self.spans, anchor: this.k.id, schema: req.schema,
    });
    if (!mine.ok) return this.decideAbort(req, mine.reason);
    const c = this.k.faults.anchorNoAbsorb
      ? Math.max(mine.prepareTs, ...stamps, flight.pushed + 1)
      : mine.prepareTs;
    flight.decided = true;

    const stale = others.flatMap((p, i) => {
      const spans = this.k.faults.predicateProtected
        ? p.spans.filter((s) => !p.writes.some((w) => w.table === s.table))
        : unprotectedSpans(p.spans, p.writes);
      return spans.length > 0 && stamps[i]! < c ? [{ p, spans, from: stamps[i]! }] : [];
    });
    const refreshed = await Promise.all(
      stale.map((s) => this.k.deps.peer(s.p.shard).refresh({ txn: req.txn, spans: s.spans, from: s.from, to: c })),
    );
    const bad = refreshed.find((r) => !r.ok);
    if (bad) return this.decideAbort(req, bad.reason ?? "refresh failed");

    this.k.b.exec(
      `INSERT INTO __txn(txn, status, c, participants, at) VALUES (?, 'committed', ?, ?, ?)`,
      req.txn, c, JSON.stringify(req.participants.map((p) => p.shard)), this.k.deps.clock.now(),
    );
    // record の確定を待ってから phase 2 と応答を送る。先に送ると、確定の前に再起動したとき、記録が消えて
    // 照会した参加者が tombstone を書き、phase 2 を受けた参加者とで決着が割れる (specs/m3_anchor_recovery.qnt の m3_red)。
    if (!this.k.faults.phase2BeforeSync) await this.k.b.sync();
    this.k.deps.scheduleRedrive?.();
    this.spawn(this.phase2(req.txn, c, req.participants));
    return { ok: true, c };
  }

  private decideAbort(req: CommitReq, reason: string): CommitRes {
    this.k.b.exec(`INSERT OR IGNORE INTO __txn(txn, status, done, at) VALUES (?, 'aborted', 1, ?)`, req.txn, this.k.deps.clock.now());
    // 記録が確定のまま残ったなら、同じ ID の別の実行が確定させている。abort を送るとその intent を消すので、送らずにその決着を
    // 答える (同じ ID は同じ中身なので、確定が正しい答えである)。実行を 1 つずつにしてあるので、ここには来ないはずの 2 つ目の守り
    // である (specs/m17_txn_id_reuse.qnt の ABORT_CHECKS)。
    const kept = this.k.decided(req.txn);
    if (kept?.status === "committed" && !this.k.faults.abortIgnoresRecord) return { ok: true, c: kept.c };
    for (const p of req.participants) {
      this.spawn(p.shard === this.k.id ? this.abort({ txn: req.txn }) : this.k.deps.peer(p.shard).abort({ txn: req.txn }));
    }
    return { ok: false, reason };
  }

  private async phase2(txn: string, c: Ts, participants: Pick<Participant, "shard">[]): Promise<void> {
    await this.finalize({ txn, c });
    await Promise.all(
      participants.filter((p) => p.shard !== this.k.id).map((p) => this.k.deps.peer(p.shard).finalize({ txn, c })),
    );
    this.k.b.exec(`UPDATE __txn SET done = 1 WHERE txn = ?`, txn);
  }

  private spawn(p: Promise<unknown>): void {
    const guarded = p.catch(() => {}); // 失敗は redrive が回収する。
    this.k.deps.background?.(guarded);
  }

  async finalize(req: { txn: string; c: Ts; pieces?: Piece[] }): Promise<void> {
    // いまは、どの piece もグループの全体なので、到着はグループの名前で確かめる。
    if (req.pieces) await this.ensureArrived(req.pieces.map((p) => p.g));
    this.k.observe(req.c);
    const rows = this.k.localIntents(req.txn);
    if (rows.length) {
      this.k.b.tx(() => {
        this.k.applyAndLog(req.txn, req.c, rows.map((r) => decode<Change>(r.change)));
        for (const r of rows) this.k.b.exec(`DELETE FROM __intents WHERE tbl = ? AND pk = ?`, r.tbl, r.pk);
      });
    }
    this.k.releaseLocks(req.txn);
    for (const r of rows) this.k.wakeAll(this.k.lockKey(r.tbl, r.pk));
    for (const [dest, pieces] of this.k.forwards(req.txn)) {
      await this.k.deps.peer(dest).finalize({ txn: req.txn, c: req.c, pieces });
    }
  }

  async abort(req: { txn: string; pieces?: Piece[] }): Promise<void> {
    if (req.pieces) await this.ensureArrived(req.pieces.map((p) => p.g));
    this.k.releaseLocks(req.txn);
    for (const r of this.k.localIntents(req.txn)) {
      this.k.b.exec(`DELETE FROM __intents WHERE tbl = ? AND pk = ?`, r.tbl, r.pk);
      this.k.wakeAll(this.k.lockKey(r.tbl, r.pk));
    }
    for (const [dest, pieces] of this.k.forwards(req.txn)) {
      await this.k.deps.peer(dest).abort({ txn: req.txn, pieces });
    }
  }

  async queryTxn(req: { txn: string; pushTo: Ts }): Promise<TxnStatus> {
    const known = this.k.decided(req.txn);
    if (known) return known;
    const flight = this.k.inflight.get(req.txn);
    // push は c の決定前だけ受理する。決定後に受理しても c は動かず、読み手が intent を誤って無視する。
    if (flight && (!flight.decided || this.k.faults.pushAfterDecide)) {
      flight.pushed = Math.max(flight.pushed, req.pushTo);
      return { status: "pushed" };
    }
    if (flight) {
      await flight.settled; // c の決定後は決着まで保留する。
      return this.k.decided(req.txn) ?? { status: "aborted" };
    }
    // 記録がなく in-flight でもない。presumed abort を tombstone で確定させる。
    this.k.b.exec(`INSERT OR IGNORE INTO __txn(txn, status, done, at) VALUES (?, 'aborted', 1, ?)`, req.txn, this.k.deps.clock.now());
    return this.k.decided(req.txn)!;
  }

  async status(req: { txn: string }): Promise<TxnStatus> {
    const flight = this.k.inflight.get(req.txn);
    if (flight) await flight.settled;
    return this.queryTxn({ txn: req.txn, pushTo: 0 });
  }

  async redrive(): Promise<boolean> {
    let more = false;
    const errors: string[] = [];
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        more = true;
        if (errors.length < 10) errors.push(String((e as Error)?.message ?? e).slice(0, 160));
      }
    };
    for (const r of this.k.b.exec(`SELECT txn, c, participants FROM __txn WHERE status = 'committed' AND done = 0`)) {
      const shards = JSON.parse(r.participants as string) as string[];
      await attempt(() => this.phase2(r.txn as string, r.c as Ts, shards.map((shard) => ({ shard }))));
    }
    for (const r of this.k.incoming) await attempt(() => this.drain(intervalOf(r)));
    // 進行中の取引の intent には触れない。anchor がまだ決着を送っている最中かもしれないからである。
    const cutoff = physicalToTs(this.k.deps.clock.now() - ORPHAN_AGE_MS);
    const orphans = this.k.b.exec(`SELECT DISTINCT txn, anchor FROM __intents WHERE prepare_ts < ?`, cutoff) as unknown as Intent[];
    for (const o of orphans) {
      await attempt(async () => {
        const res = await this.ask(o.anchor, o.txn, 0);
        if (res.status === "committed") await this.finalize({ txn: o.txn, c: res.c });
        else if (res.status === "aborted") await this.abort({ txn: o.txn });
      });
    }
    const left = this.k.b.exec(`SELECT (SELECT count(*) FROM __intents) + (SELECT count(*) FROM __txn WHERE status = 'committed' AND done = 0) n`)[0]?.n as number;
    this.k.lastRedriveErrors = errors;
    return more || left > 0 || this.k.incoming.length > 0;
  }

  async moves(req: Parameters<ShardKernel["moves"]>[0]): Promise<ReturnType<ShardKernel["moves"]>> {
    return this.k.moves(req);
  }

  async listGroups(req: Parameters<ShardKernel["listGroups"]>[0]): Promise<ReturnType<ShardKernel["listGroups"]>> {
    return this.k.listGroups(req);
  }

  async ack(req: Parameters<ShardKernel["ack"]>[0]): Promise<ReturnType<ShardKernel["ack"]>> {
    return this.k.ack(req);
  }

  async finishMove(req: Parameters<ShardKernel["finishMove"]>[0]): Promise<ReturnType<ShardKernel["finishMove"]>> {
    return this.k.finishMove(req);
  }

  async finishIncoming(req: Parameters<ShardKernel["finishIncoming"]>[0]): Promise<ReturnType<ShardKernel["finishIncoming"]>> {
    return this.k.finishIncoming(req);
  }

  async health(req: Parameters<ShardKernel["health"]>[0]): Promise<ReturnType<ShardKernel["health"]>> {
    return this.k.health(req);
  }

  async exportRows(req: Parameters<ShardKernel["exportRows"]>[0]): Promise<ReturnType<ShardKernel["exportRows"]>> {
    return this.k.exportRows(req);
  }

  async metrics(req: Parameters<ShardKernel["metrics"]>[0]): Promise<ReturnType<ShardKernel["metrics"]>> {
    return this.k.metrics(req);
  }

  async unlock(req: Parameters<ShardKernel["unlock"]>[0]): Promise<ReturnType<ShardKernel["unlock"]>> {
    return this.k.unlock(req);
  }

  async now(req: Parameters<ShardKernel["now"]>[0]): Promise<ReturnType<ShardKernel["now"]>> {
    return this.k.now(req);
  }

  async refresh(req: Parameters<ShardKernel["refresh"]>[0]): Promise<ReturnType<ShardKernel["refresh"]>> {
    return this.k.refresh(req);
  }

  async flush(req: Parameters<ShardKernel["flush"]>[0]): Promise<ReturnType<ShardKernel["flush"]>> {
    return this.k.flush(req);
  }
}
