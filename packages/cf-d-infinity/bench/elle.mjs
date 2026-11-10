// 取引の履歴が直列化可能かを、実装の内部を見ずに検査する (Jepsen の Elle の list-append 方式)。
//
// 各取引はキーの読み取り ["r", k, list] とリストへの追記 ["a", k, element] を行う。element はキーごとに一意である。
// 読み取りがリスト全体を返すので、最も長い読み取りから各キーの版の順序が分かり、そこから依存関係を組み立てられる。
//   ww: 版の順序で前の追記 → 次の追記
//   wr: 読んだリストの最後の要素を書いた取引 → 読んだ取引
//   rw: 読んだリストの次の要素を書いた取引 ← 読んだ取引 (反依存)
// 依存グラフに閉路があれば、どの直列順序とも矛盾する (G0 / G1c / G2)。
// あわせて、中止した取引の書き込みが見える (G1a)、読み取りどうしの順序が食い違う、確定した追記が最後の読み取りにない、を検出する。
//
// 記録の type は ok (確定)、fail (確定していないことが分かっている)、info (結果が分からない) のどれかである。
// info の取引は、その追記がどこかで読まれていれば確定したとみなす。

/** @typedef {["r", string, string[] | null] | ["a", string, string]} Op */
/** @typedef {{ id: string, type: "ok" | "fail" | "info", ops: Op[] }} Txn */

/**
 * @param {Txn[]} history
 * @param {{ finalReads?: Record<string, string[]>, tolerateUnknown?: boolean }} [opts]
 *   finalReads: 障害を止めて静かになった後に読んだ全キーの値。確定した追記の消失を検査する。
 *   tolerateUnknown: 履歴を回収できなかった呼び出しがあるとき、出どころの分からない要素を異常にしない。
 */
export function check(history, opts = {}) {
  const anomalies = {};
  const flag = (type, detail) => {
    (anomalies[type] ??= []).length < 5 && anomalies[type].push(detail);
    anomalies[type].count = (anomalies[type].count ?? 0) + 1;
  };
  const K = (k) => String(k);
  const writers = new Map(); // key\0element -> txn
  const writerOf = (key, e) => writers.get(`${K(key)}\0${e}`);
  for (const t of history) {
    const seen = new Set();
    for (const op of t.ops) {
      if (op[0] !== "a") continue;
      const id = `${K(op[1])}\0${op[2]}`;
      if (writers.has(id)) flag("duplicate-append-id", { key: K(op[1]), element: op[2] });
      writers.set(id, t);
      if (seen.has(K(op[1]))) flag("multiple-appends-to-key-in-one-txn", { txn: t.id, key: K(op[1]) });
      seen.add(K(op[1]));
    }
  }

  // 読み取りを外部の読み (自分の追記より前) と内部の読みに分ける。
  const reads = []; // { txn, key, list }
  for (const t of history) {
    if (t.type !== "ok") continue;
    const mine = new Map();
    for (const op of t.ops) {
      if (op[0] === "a") {
        mine.set(K(op[1]), [...(mine.get(K(op[1])) ?? []), op[2]]);
        continue;
      }
      const list = op[2] ?? [];
      const own = mine.get(K(op[1]));
      if (own) {
        // 自分の追記の後の読みは、末尾に自分の追記が順に並ぶはずである。
        const tail = list.slice(list.length - own.length);
        if (tail.join(",") !== own.join(",")) flag("internal", { txn: t.id, key: K(op[1]), list, own });
        reads.push({ txn: t, key: K(op[1]), list: list.slice(0, list.length - own.length), internal: true });
      } else {
        reads.push({ txn: t, key: K(op[1]), list, internal: false });
      }
    }
  }
  if (opts.finalReads) {
    const fin = { id: "final", type: "ok", ops: [] };
    for (const [key, list] of Object.entries(opts.finalReads)) reads.push({ txn: fin, key: K(key), list, internal: false, final: true });
  }

  // 各キーの版の順序 = 最も長い読み取り。ほかの読みはその接頭辞でなければならない。
  const order = new Map();
  for (const r of reads) {
    const cur = order.get(r.key);
    if (!cur || r.list.length > cur.length) order.set(r.key, r.list);
  }
  for (const r of reads) {
    const full = order.get(r.key);
    for (let i = 0; i < r.list.length; i++) {
      if (r.list[i] !== full[i]) {
        flag("incompatible-order", { key: r.key, txn: r.txn.id, read: r.list.slice(0, i + 1), longest: full.slice(0, i + 1) });
        break;
      }
    }
    const dup = r.list.find((e, i) => r.list.indexOf(e) !== i);
    if (dup !== undefined) flag("duplicate-elements", { key: r.key, txn: r.txn.id, element: dup });
  }

  // 要素の出どころ。中止した取引の要素が見えたら G1a、出どころがなければ garbage。
  const committed = new Set(history.filter((t) => t.type === "ok"));
  for (const [key, list] of order) {
    for (const e of list) {
      const w = writerOf(key, e);
      if (!w) {
        if (!opts.tolerateUnknown) flag("garbage-read", { key, element: e });
        continue;
      }
      if (w.type === "fail") flag("G1a-aborted-read", { key, element: e, writer: w.id });
      if (w.type === "info") committed.add(w);
    }
  }

  // 静かになった後の読み取りに、確定した追記がすべて含まれること。
  if (opts.finalReads) {
    for (const t of history) {
      if (t.type !== "ok") continue;
      for (const op of t.ops) {
        if (op[0] !== "a" || !(K(op[1]) in opts.finalReads)) continue;
        if (!opts.finalReads[K(op[1])].includes(op[2])) flag("lost-append", { txn: t.id, key: K(op[1]), element: op[2] });
      }
    }
  }

  // 依存グラフ。
  const nodes = [...committed];
  const index = new Map(nodes.map((t, i) => [t, i]));
  const edges = nodes.map(() => new Map()); // to -> kinds
  const edge = (a, b, kind) => {
    if (!a || !b || a === b || !index.has(a) || !index.has(b)) return;
    const m = edges[index.get(a)];
    m.set(index.get(b), (m.get(index.get(b)) ?? "") + kind);
  };
  for (const [key, list] of order) {
    for (let i = 0; i + 1 < list.length; i++) edge(writerOf(key, list[i]), writerOf(key, list[i + 1]), "w");
  }
  for (const r of reads) {
    if (r.final) continue;
    const full = order.get(r.key);
    if (r.list.length > 0) edge(writerOf(r.key, r.list[r.list.length - 1]), r.txn, "r");
    if (r.list.length < full.length) edge(r.txn, writerOf(r.key, full[r.list.length]), "a");
  }
  const cycles = scc(edges).filter((c) => c.length > 1);
  for (const c of cycles) {
    const inC = new Set(c);
    const kinds = new Set();
    for (const v of c) for (const [to, k] of edges[v]) if (inC.has(to)) for (const ch of k) kinds.add(ch);
    const type = kinds.has("a") ? "G2-anti-dependency-cycle" : kinds.has("r") ? "G1c-cycle" : "G0-write-cycle";
    flag(type, { size: c.length, txns: c.slice(0, 6).map((v) => nodes[v].id) });
  }

  const stats = {
    txns: history.length,
    ok: history.filter((t) => t.type === "ok").length,
    fail: history.filter((t) => t.type === "fail").length,
    info: history.filter((t) => t.type === "info").length,
    infoCommitted: [...committed].filter((t) => t.type === "info").length,
    keys: order.size,
    elements: writers.size,
    edges: edges.reduce((a, m) => a + m.size, 0),
  };
  return { valid: Object.keys(anomalies).length === 0, anomalies, stats };
}

/** 強連結成分 (Tarjan、再帰を使わない版)。 */
function scc(edges) {
  const n = edges.length;
  const idx = new Array(n).fill(-1), low = new Array(n).fill(0), on = new Array(n).fill(false);
  const stack = [], out = [];
  let counter = 0;
  for (let s = 0; s < n; s++) {
    if (idx[s] !== -1) continue;
    const work = [[s, [...edges[s].keys()], 0]];
    idx[s] = low[s] = counter++;
    stack.push(s);
    on[s] = true;
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, succ] = frame;
      if (frame[2] < succ.length) {
        const w = succ[frame[2]++];
        if (idx[w] === -1) {
          idx[w] = low[w] = counter++;
          stack.push(w);
          on[w] = true;
          work.push([w, [...edges[w].keys()], 0]);
        } else if (on[w]) low[v] = Math.min(low[v], idx[w]);
        continue;
      }
      work.pop();
      if (work.length) {
        const p = work[work.length - 1][0];
        low[p] = Math.min(low[p], low[v]);
      }
      if (low[v] === idx[v]) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          on[w] = false;
          comp.push(w);
        } while (w !== v);
        out.push(comp);
      }
    }
  }
  return out;
}
