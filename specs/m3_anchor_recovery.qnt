// M3: anchor 主導 2PC の presumed abort と障害回復 (design.md「障害時の決着」)
//
// anchor 1 個、参加者 2 個、Worker 1 個、取引 1 件。メッセージは集合で表し、遅延・重複を許す。
// anchor は durable な record (NoRec / Committed / Aborted = tombstone) と in-memory の in-flight 登録を持つ。
// record は「書いたが未確定 (pending)」→ sync で確定、の 2 段。anchor の restart で in-memory と pending が消える。
//
// invariants:
//   atomicApply:          参加者が本体へ適用したなら record は Committed (確定済み)
//   noMixedOutcome:       適用した参加者と intent を捨てた参加者が同時に存在しない
//   committedRecoverable: record が Committed なら全参加者が intent を保持しているか適用済み (tombstone と矛盾しない)
//   responseConsistent:   Worker への応答と record が一致する
// red: sync() 前に phase 2 と応答を送る。
module m3_core {
  const RED_EARLY_P2: bool   // record 確定前に phase 2 / 応答を送る (output gate が DO 間 RPC に効くと仮定した実装)

  pure val PARTS = Set(1, 2)

  type RecState = NoRec | Committed | Aborted
  type PState = PNone | Intent | Applied | Dropped
  type Resp = Waiting | RespCommitted | RespAborted | Unknown

  var started: bool          // Worker の commit 要求が anchor に届いた
  var inflight: bool         // anchor の in-memory 登録
  var acked: Set[int]        // anchor の in-memory ack 集合
  var pending: RecState           // 書いたが未確定の record
  var record: RecState            // durable な record
  var prepMsgs: Set[int]     // prepare 送信中 (参加者 id)
  var ackMsgs: Set[int]      // ack 送信中
  var p2Msgs: Set[int]       // phase 2 (commit) 送信中
  var abortMsgs: Set[int]    // abort 送信中
  var pstate: int -> PState
  var resp: Resp
  var restarts: int          // witness 用

  action init = all {
    started' = false, inflight' = false, acked' = Set(), pending' = NoRec, record' = NoRec,
    prepMsgs' = Set(), ackMsgs' = Set(), p2Msgs' = Set(), abortMsgs' = Set(),
    pstate' = PARTS.mapBy(_ => PNone), resp' = Waiting, restarts' = 0
  }

  // 「変更しない」をまとめる補助。各アクションは変える変数だけ上書きする形で書けないので、全列挙する。
  action keepMsgs = all { prepMsgs' = prepMsgs, ackMsgs' = ackMsgs, p2Msgs' = p2Msgs, abortMsgs' = abortMsgs }
  action keepAnchor = all { started' = started, inflight' = inflight, acked' = acked, pending' = pending, record' = record }
  action keepRest = all { pstate' = pstate, resp' = resp, restarts' = restarts }

  // Worker の commit 要求が anchor に届く。anchor は in-flight に登録する
  action start = all {
    not(started),
    started' = true, inflight' = true, acked' = Set(), pending' = pending, record' = record,
    keepMsgs, keepRest
  }

  // runtime の自動 retry で同じ commit 要求が再配送される。restart 後の anchor は初回を覚えていないので受理する
  action redeliverCommit = all {
    started, not(inflight), record == NoRec, pending == NoRec,
    inflight' = true, acked' = Set(),
    started' = started, pending' = pending, record' = record,
    keepMsgs, keepRest
  }

  // anchor が参加者へ prepare を送る (retryable: 重複送信を許す)
  action sendPrepare(p: int): bool = all {
    inflight, not(acked.contains(p)),
    prepMsgs' = prepMsgs.union(Set(p)),
    ackMsgs' = ackMsgs, p2Msgs' = p2Msgs, abortMsgs' = abortMsgs,
    keepAnchor, keepRest
  }

  // 参加者が prepare を受ける。intent を書いて ack。既に Dropped なら ack しない (nack 相当)
  action recvPrepare(p: int): bool = all {
    prepMsgs.contains(p),
    pstate.get(p) != Dropped,
    pstate' = pstate.set(p, if (pstate.get(p) == PNone) Intent else pstate.get(p)),
    ackMsgs' = ackMsgs.union(Set(p)),
    prepMsgs' = prepMsgs.exclude(Set(p)),
    p2Msgs' = p2Msgs, abortMsgs' = abortMsgs,
    keepAnchor, resp' = resp, restarts' = restarts
  }

  // anchor が ack を受ける。in-flight でない、または record が決まっていれば捨てる (遅延 ack)
  action recvAck(p: int): bool = all {
    ackMsgs.contains(p),
    ackMsgs' = ackMsgs.exclude(Set(p)),
    acked' = if (inflight and record == NoRec and pending == NoRec) acked.union(Set(p)) else acked,
    started' = started, inflight' = inflight, pending' = pending, record' = record,
    prepMsgs' = prepMsgs, p2Msgs' = p2Msgs, abortMsgs' = abortMsgs,
    keepRest
  }

  // 全 ack → committed record を書く (未確定)
  action decideCommit = all {
    inflight, acked == PARTS, record == NoRec, pending == NoRec,
    pending' = Committed,
    started' = started, inflight' = inflight, acked' = acked, record' = record,
    keepMsgs, keepRest
  }

  // anchor のタイムアウト: aborted record を書く (未確定)
  action decideAbort = all {
    inflight, record == NoRec, pending == NoRec,
    pending' = Aborted,
    started' = started, inflight' = inflight, acked' = acked, record' = record,
    keepMsgs, keepRest
  }

  // sync(): pending を確定
  action sync = all {
    pending != NoRec,
    record' = pending, pending' = NoRec, inflight' = false,
    started' = started, acked' = acked,
    keepMsgs, keepRest
  }

  pure def visibleCommitted(rec: RecState, pend: RecState): bool =
    rec == Committed or (RED_EARLY_P2 and pend == Committed)

  // Worker へ応答
  action respond = all {
    resp == Waiting,
    any {
      all { visibleCommitted(record, pending), resp' = RespCommitted },
      all { record == Aborted, resp' = RespAborted }
    },
    keepAnchor, keepMsgs, pstate' = pstate, restarts' = restarts
  }

  // 応答が Worker に届かない
  action loseResponse = all {
    resp == Waiting,
    resp' = Unknown,
    keepAnchor, keepMsgs, pstate' = pstate, restarts' = restarts
  }

  // Worker の status 照会 (durable な record だけを見る)
  action workerStatus = all {
    resp == Unknown,
    record != NoRec,
    resp' = if (record == Committed) RespCommitted else RespAborted,
    keepAnchor, keepMsgs, pstate' = pstate, restarts' = restarts
  }

  // phase 2 を送る。green は確定後のみ、red は pending でも送る
  action sendP2(p: int): bool = all {
    visibleCommitted(record, pending),
    p2Msgs' = p2Msgs.union(Set(p)),
    prepMsgs' = prepMsgs, ackMsgs' = ackMsgs, abortMsgs' = abortMsgs,
    keepAnchor, keepRest
  }

  action recvP2(p: int): bool = all {
    p2Msgs.contains(p),
    p2Msgs' = p2Msgs.exclude(Set(p)),
    pstate' = pstate.set(p, if (pstate.get(p) == Intent) Applied else pstate.get(p)),
    prepMsgs' = prepMsgs, ackMsgs' = ackMsgs, abortMsgs' = abortMsgs,
    keepAnchor, resp' = resp, restarts' = restarts
  }

  action sendAbort(p: int): bool = all {
    record == Aborted,
    abortMsgs' = abortMsgs.union(Set(p)),
    prepMsgs' = prepMsgs, ackMsgs' = ackMsgs, p2Msgs' = p2Msgs,
    keepAnchor, keepRest
  }

  action recvAbort(p: int): bool = all {
    abortMsgs.contains(p),
    abortMsgs' = abortMsgs.exclude(Set(p)),
    pstate' = pstate.set(p, if (pstate.get(p) == Intent) Dropped else pstate.get(p)),
    prepMsgs' = prepMsgs, ackMsgs' = ackMsgs, p2Msgs' = p2Msgs,
    keepAnchor, resp' = resp, restarts' = restarts
  }

  // anchor の restart: in-memory (in-flight, ack) と未確定 record が消える
  action anchorRestart = all {
    inflight' = false, acked' = Set(), pending' = NoRec,
    started' = started, record' = record,
    restarts' = restarts + 1,
    keepMsgs, pstate' = pstate, resp' = resp
  }

  // intent を持つ参加者 (または読み手) が anchor に照会する
  //   Committed → 適用、Aborted → intent を捨てる、記録なし & in-flight でない → tombstone を書いて捨てる
  //   記録なし & in-flight → 待つ (何もしない)
  action queryIntent(p: int): bool = all {
    pstate.get(p) == Intent,
    any {
      all {
        record == Committed,
        pstate' = pstate.set(p, Applied),
        record' = record
      },
      all {
        record == Aborted,
        pstate' = pstate.set(p, Dropped),
        record' = record
      },
      all {
        record == NoRec, not(inflight), pending == NoRec,
        record' = Aborted,
        pstate' = pstate.set(p, Dropped)
      }
    },
    started' = started, inflight' = inflight, acked' = acked, pending' = pending,
    keepMsgs, resp' = resp, restarts' = restarts
  }

  action step = any {
    start,
    redeliverCommit,
    { nondet p = oneOf(PARTS) sendPrepare(p) },
    { nondet p = oneOf(PARTS) recvPrepare(p) },
    { nondet p = oneOf(PARTS) recvAck(p) },
    decideCommit,
    decideAbort,
    sync,
    respond,
    loseResponse,
    workerStatus,
    { nondet p = oneOf(PARTS) sendP2(p) },
    { nondet p = oneOf(PARTS) recvP2(p) },
    { nondet p = oneOf(PARTS) sendAbort(p) },
    { nondet p = oneOf(PARTS) recvAbort(p) },
    all { restarts < 2, anchorRestart },
    { nondet p = oneOf(PARTS) queryIntent(p) }
  }

  // ---- 不変条件 -------------------------------------------------------------
  val atomicApply = PARTS.forall(p => pstate.get(p) != Applied or record == Committed)
  val noMixedOutcome = not(PARTS.exists(p => pstate.get(p) == Applied) and PARTS.exists(q => pstate.get(q) == Dropped))
  val committedRecoverable = record != Committed or PARTS.forall(p => pstate.get(p) == Intent or pstate.get(p) == Applied)
  val responseConsistent =
    (resp != RespCommitted or record == Committed) and (resp != RespAborted or record != Committed)
  val recovery = atomicApply and noMixedOutcome and committedRecoverable and responseConsistent

  // witness: 全参加者に適用され、Worker が Committed を受け取る状態に到達できる
  val witnessAllApplied = not(PARTS.forall(p => pstate.get(p) == Applied) and resp == RespCommitted)
  // witness: restart 後に tombstone で決着し、Worker が status 照会で Aborted を知る
  val witnessTombstoneAfterRestart = not(restarts >= 1 and record == Aborted and resp == RespAborted
                                         and PARTS.forall(p => pstate.get(p) == Dropped))
}

module m3_green {
  import m3_core(RED_EARLY_P2 = false).*
  run happyPathTest =
    init.then(start).then(sendPrepare(1)).then(sendPrepare(2))
        .then(recvPrepare(1)).then(recvPrepare(2)).then(recvAck(1)).then(recvAck(2))
        .then(decideCommit).then(sync).then(respond)
        .then(sendP2(1)).then(sendP2(2)).then(recvP2(1)).then(recvP2(2))
        .expect(PARTS.forall(p => pstate.get(p) == Applied) and resp == RespCommitted and recovery)
  // restart 中に遅延 ack が届いても tombstone が勝つ
  run lateAckAfterTombstoneTest =
    init.then(start).then(sendPrepare(1)).then(sendPrepare(2))
        .then(recvPrepare(1)).then(recvPrepare(2)).then(recvAck(1))
        .then(anchorRestart)
        .then(queryIntent(2))
        .expect(record == Aborted and pstate.get(2) == Dropped)
        .then(recvAck(2))
        .expect(acked == Set())
        // tombstone があるので再配送された commit 要求も受理できない (redeliverCommit の guard が偽)
        .expect(not(record == NoRec and pending == NoRec))
        .then(queryIntent(1))
        .then(loseResponse).then(workerStatus)
        .expect(resp == RespAborted and recovery)
}

module m3_red {
  import m3_core(RED_EARLY_P2 = true).*
  // 全 ack → record を書く (未確定) → 確定前に phase 2 を参加者 1 へ送り適用される → anchor restart で record が消える
  // → 参加者 2 が照会: 記録なし & in-flight でない → tombstone → 参加者 2 は intent を捨てる。
  // 参加者 1 は適用済みなのに record は Aborted。
  run counterexampleTest =
    init.then(start).then(sendPrepare(1)).then(sendPrepare(2))
        .then(recvPrepare(1)).then(recvPrepare(2)).then(recvAck(1)).then(recvAck(2))
        .then(decideCommit)
        .expect(pending == Committed and record == NoRec)
        .then(sendP2(1)).then(recvP2(1))
        .expect(pstate.get(1) == Applied)
        .then(anchorRestart)
        .expect(pending == NoRec and record == NoRec)
        .then(queryIntent(2))
        .expect(record == Aborted and pstate.get(2) == Dropped and not(recovery))
}
