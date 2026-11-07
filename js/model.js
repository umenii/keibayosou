// 予想エンジン
// 過去のレース結果を日付順にたどり、各レースの「その時点で分かっていた情報」だけから
// 特徴量を作る。それを使って重みを学習し、出走馬ごとの勝率・複勝率・期待値を出す。

export const FEATURES = [
  { key: 'form', label: '近走成績', w: 0.25 },
  { key: 'last3f', label: '上がりの脚', w: 0.15 },
  { key: 'dist', label: '距離適性', w: 0.12 },
  { key: 'course', label: 'コース実績', w: 0.08 },
  { key: 'cond', label: '馬場適性', w: 0.05 },
  { key: 'jockey', label: '騎手', w: 0.12 },
  { key: 'trainer', label: '厩舎', w: 0.05 },
  { key: 'post', label: '枠の有利不利', w: 0.04 },
  { key: 'market', label: 'オッズ(人気)', w: 1.0 },
  { key: 'body', label: '馬体重の増減', w: 0.08 },
  { key: 'rest', label: 'ローテーション', w: 0.05 },
  { key: 'exp', label: 'キャリア', w: 0.03 },
  { key: 'paddock', label: 'パドック', w: 0.15 },
  { key: 'paper', label: '新聞の印', w: 0.2 },
];
export const DEFAULT_WEIGHTS = Object.fromEntries(FEATURES.map((f) => [f.key, f.w]));
const F = FEATURES.length;

const PADDOCK_SCORE = { A: 2, B: 1, C: 0, D: -1, E: -2 };
const MARK_SCORE = { '◎': 5, '○': 3, '〇': 3, '▲': 2, '△': 1, '☆': 1.5, '★': 1.5, '注': 0.5 };

export const isFinished = (race) => race.entries.some((e) => e.finish >= 1);
const runners = (race) => race.entries.filter((e) => !e.scratched);
const valid = (x) => typeof x === 'number' && isFinite(x);
const sortKey = (r) => `${r.date}_${String(r.raceNo).padStart(2, '0')}_${r.id}`;
const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86400000;
const offGoing = (c) => (c === '重' || c === '不良' ? 'off' : 'good');
const distBand = (d) => Math.round((d || 0) / 400);

function smooth(sum, n, prior, k) { return (sum + prior * k) / (n + k); }

// ---------------- 状態（日付順に積み上げる統計） ----------------
class State {
  constructor() {
    this.horse = new Map();   // 馬名 → 過去走の配列
    this.jockey = new Map();  // 騎手 → { n, win, top3 }
    this.trainer = new Map();
    this.post = new Map();    // 競馬場|芝ダ|距離帯|内外 → { n, top3 }
  }

  featuresFor(race) {
    const rs = runners(race);
    const field = rs.length;
    // 人気がなければオッズから補う
    const oddsList = rs.map((e) => e.odds).filter(valid);
    const raw = rs.map((e) => {
      const hist = mergePastRuns(this.horse.get(e.horse) || [], e.pastRuns, race.date);
      const recent = hist.slice(-5).reverse();
      const decay = [1, 0.8, 0.6, 0.5, 0.4];
      let ws = 0, form = 0;
      recent.forEach((h, i) => { form += h.fs * decay[i]; ws += decay[i]; });
      form = ws ? form / ws : 0.42;
      const overall = hist.length ? hist.reduce((s, h) => s + h.fs, 0) / hist.length : 0.42;

      const l3 = recent.filter((h) => valid(h.l3s));
      const last3f = l3.length ? l3.reduce((s, h) => s + h.l3s, 0) / l3.length : 0.45;

      let ds = 0, dn = 0;
      for (const h of hist) {
        if (h.surface !== race.surface) continue;
        const gap = Math.abs(h.distance - race.distance);
        const w = gap <= 200 ? 1 : gap <= 400 ? 0.5 : 0;
        ds += h.fs * w; dn += w;
      }
      const dist = smooth(ds, dn, overall, 2);

      const cs = hist.filter((h) => h.venue === race.venue && h.surface === race.surface);
      const course = smooth(cs.reduce((s, h) => s + h.fs, 0), cs.length, overall, 2);

      const og = offGoing(race.condition);
      const cd = hist.filter((h) => offGoing(h.condition) === og);
      const cond = smooth(cd.reduce((s, h) => s + h.fs, 0), cd.length, overall, 2);

      const j = this.jockey.get(e.jockey) || { n: 0, win: 0, top3: 0 };
      const jockey = smooth(j.top3, j.n, 0.21, 30) + smooth(j.win, j.n, 0.07, 30);
      const t = this.trainer.get(e.trainer) || { n: 0, win: 0, top3: 0 };
      const trainer = smooth(t.top3, t.n, 0.21, 30);

      const pk = postKey(race, e, field);
      const p = this.post.get(pk) || { n: 0, top3: 0 };
      const post = smooth(p.top3, p.n, Math.min(1, 3 / Math.max(field, 3)), 40);

      // オッズ → 市場の見ている勝率（の対数）。オッズがなければ人気から推定、どちらもなければ横並び
      let market = Math.log(1 / Math.max(field, 1));
      if (valid(e.odds) && e.odds > 0) market = Math.log(0.8 / e.odds);
      else if (valid(e.pop)) market = Math.log(0.8 / popToOdds(e.pop, field));
      else if (oddsList.length) market = Math.log(0.8 / Math.max(...oddsList));

      const body = valid(e.bodyDiff) ? -Math.max(0, Math.abs(e.bodyDiff) - 6) / 10 : 0;

      let rest = 0;
      if (hist.length) {
        const d = daysBetween(hist[hist.length - 1].date, race.date);
        if (d > 180) rest = -1; else if (d > 90) rest = -0.4; else if (d < 14) rest = -0.3;
      }
      const exp = Math.log1p(hist.length);

      const paddock = paddockScore(e);
      const paper = paperScore(e);

      return [form, last3f, dist, course, cond, jockey, trainer, post, market, body, rest, exp, paddock, paper];
    });
    return standardize(raw);
  }

  update(race) {
    const rs = runners(race).filter((e) => valid(e.finish) && e.finish >= 1);
    const field = rs.length;
    if (field < 2) return;
    const l3 = rs.filter((e) => valid(e.last3f) && e.last3f > 0).map((e) => e.last3f).sort((a, b) => a - b);
    for (const e of rs) {
      const fs = 1 - (e.finish - 1) / (field - 1);
      let l3s = NaN;
      if (valid(e.last3f) && e.last3f > 0 && l3.length > 1) l3s = 1 - l3.indexOf(e.last3f) / (l3.length - 1);
      if (!this.horse.has(e.horse)) this.horse.set(e.horse, []);
      this.horse.get(e.horse).push({
        date: race.date, venue: race.venue, surface: race.surface, distance: race.distance,
        condition: race.condition, fs, l3s, finish: e.finish,
      });
      for (const [map, key] of [[this.jockey, e.jockey], [this.trainer, e.trainer]]) {
        if (!key) continue;
        const s = map.get(key) || { n: 0, win: 0, top3: 0 };
        s.n++; if (e.finish === 1) s.win++; if (e.finish <= 3) s.top3++;
        map.set(key, s);
      }
      const pk = postKey(race, e, field);
      const p = this.post.get(pk) || { n: 0, top3: 0 };
      p.n++; if (e.finish <= 3) p.top3++;
      this.post.set(pk, p);
    }
  }

  horseHistory(name) { return this.horse.get(name) || []; }
}

// 新聞の馬柱から読み取った過去走（データベースにない分）を足す
function mergePastRuns(hist, pastRuns, beforeDate) {
  if (!Array.isArray(pastRuns) || !pastRuns.length) return hist;
  const have = new Set(hist.map((h) => h.date));
  const extra = [];
  for (const r of pastRuns) {
    if (!r || !r.date || r.date >= beforeDate || have.has(r.date) || !valid(r.finish)) continue;
    const field = valid(r.field) && r.field > 1 ? r.field : 14;
    extra.push({
      date: r.date, venue: r.venueId || r.venue, surface: r.surface === 'ダ' ? 'ダ' : '芝', distance: r.distance || 0,
      condition: r.condition || '良', fs: Math.max(0, 1 - (r.finish - 1) / (field - 1)), l3s: NaN, finish: r.finish,
    });
  }
  if (!extra.length) return hist;
  return [...hist, ...extra].sort((a, b) => a.date.localeCompare(b.date));
}

function postKey(race, e, field) {
  const pos = field > 1 && valid(e.no) ? (e.no - 1) / (field - 1) : 0.5;
  const zone = pos < 0.25 ? '内' : pos < 0.5 ? '中内' : pos < 0.75 ? '中外' : '外';
  return `${race.venue}|${race.surface}|${distBand(race.distance)}|${zone}`;
}

// 人気から大まかなオッズを推定（人気だけ分かっているとき用）
function popToOdds(pop, field) {
  const table = [2.8, 4.8, 7, 9.5, 13, 17, 22, 28, 36, 45, 55, 70, 85, 100, 120, 150, 180, 220];
  return table[Math.min(pop, table.length) - 1] * Math.max(1, field / 14) ** 0.3;
}

export function paddockScore(e) {
  const vals = [];
  if (e.paddock && PADDOCK_SCORE[e.paddock] != null) vals.push(PADDOCK_SCORE[e.paddock]);
  if (valid(e.aiPaddock)) vals.push((e.aiPaddock - 3)); // AI は 1〜5
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

export function paperScore(e) {
  const marks = String(e.marks || '').replace(/\s/g, '');
  if (!marks) return 0;
  let s = 0, n = 0;
  for (const ch of marks) {
    if (ch === '-' || ch === '－' || ch === '・') { n++; continue; }
    if (MARK_SCORE[ch] != null) { s += MARK_SCORE[ch]; n++; }
  }
  return n ? s / n : 0;
}

const MARKET = FEATURES.findIndex((f) => f.key === 'market');

// レース内で平均 0・ばらつき 1 にそろえる。
// オッズだけは「市場が見ている勝率の対数」のまま使う（重み 1 ならオッズ通りの確率になる）
function standardize(raw) {
  const n = raw.length;
  const out = raw.map((r) => r.slice());
  for (let k = 0; k < F; k++) {
    let m = 0; for (const r of raw) m += r[k]; m /= n || 1;
    if (k === MARKET) { for (const r of out) r[k] -= m; continue; }
    let v = 0; for (const r of raw) v += (r[k] - m) ** 2; v /= n || 1;
    const sd = Math.sqrt(v);
    for (const r of out) r[k] = sd > 1e-9 ? (r[k] - m) / sd : 0;
  }
  return out;
}

// ---------------- 確率計算 ----------------
function softmax(scores) {
  const mx = Math.max(...scores);
  const ex = scores.map((s) => Math.exp(s - mx));
  const sum = ex.reduce((a, b) => a + b, 0);
  return ex.map((x) => x / sum);
}

const wVec = (weights) => FEATURES.map((f) => weights[f.key] ?? f.w);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// Harville 方式で 1〜3 着の組み合わせ確率を出す
export function harville(p) {
  const n = p.length;
  const top2 = new Array(n).fill(0), top3 = new Array(n).fill(0);
  const quinella = {}, wide = {}, trio = {};
  const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const pij = p[i] * p[j] / Math.max(1e-9, 1 - p[i]);
      top2[i] += pij; top2[j] += pij;
      quinella[pairKey(i, j)] = (quinella[pairKey(i, j)] || 0) + pij;
      for (let k = 0; k < n; k++) {
        if (k === i || k === j) continue;
        const pijk = pij * p[k] / Math.max(1e-9, 1 - p[i] - p[j]);
        top3[i] += pijk; top3[j] += pijk; top3[k] += pijk;
        for (const [a, b] of [[i, j], [i, k], [j, k]]) wide[pairKey(a, b)] = (wide[pairKey(a, b)] || 0) + pijk;
        const t = [i, j, k].sort((a, b) => a - b).join('-');
        trio[t] = (trio[t] || 0) + pijk;
      }
    }
  }
  return { top2, top3, quinella, wide, trio };
}

// 1〜3 着の組（順不同）が条件を満たす確率
export function probTop3(p, pred) {
  const n = p.length;
  let total = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (j === i) continue;
    const pij = p[i] * p[j] / Math.max(1e-9, 1 - p[i]);
    for (let k = 0; k < n; k++) {
      if (k === i || k === j) continue;
      if (pred([i, j, k])) total += pij * p[k] / Math.max(1e-9, 1 - p[i] - p[j]);
    }
  }
  return total;
}

// ---------------- 状態の構築 ----------------
// beforeDate より前に終わったレースだけで状態を作る
export function buildState(allRaces, beforeDate, excludeId) {
  const st = new State();
  const done = allRaces.filter((r) => r.id !== excludeId && r.date < beforeDate && isFinished(r))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  for (const r of done) st.update(r);
  return st;
}

// 学習用データ：日付順に「その時点の特徴量」と結果を並べる
export function buildDataset(allRaces) {
  const st = new State();
  const done = allRaces.filter(isFinished).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const rows = [];
  let i = 0;
  while (i < done.length) {
    // 同じ日のレースは同じ日の結果を見ずに特徴量を作る
    const day = done[i].date;
    const batch = [];
    while (i < done.length && done[i].date === day) batch.push(done[i++]);
    for (const r of batch) {
      const rs = runners(r);
      if (rs.length < 3) continue;
      const X = st.featuresFor(r);
      const winner = rs.findIndex((e) => e.finish === 1);
      if (winner < 0) continue;
      rows.push({ race: r, entries: rs, X });
    }
    for (const r of batch) st.update(r);
  }
  return rows;
}

// ---------------- 学習（勝ち馬の対数尤度を最大化） ----------------
export function train(rows, opts = {}) {
  const iters = opts.iters ?? 300;
  const l2 = opts.l2 ?? 0.02;
  const lr = opts.lr ?? 0.5;
  const w = wVec(opts.init || DEFAULT_WEIGHTS);
  const m = new Array(F).fill(0), v = new Array(F).fill(0);
  const b1 = 0.9, b2 = 0.999;
  const N = rows.length || 1;
  for (let it = 1; it <= iters; it++) {
    const g = new Array(F).fill(0);
    for (const row of rows) {
      const p = softmax(row.X.map((x) => dot(w, x)));
      const top = row.entries.map((e) => (e.finish === 1 ? 1 : 0));
      const top3 = row.entries.map((e) => (e.finish <= 3 ? 1 : 0));
      const t3n = top3.reduce((a, b) => a + b, 0) || 1;
      for (let i = 0; i < row.X.length; i++) {
        // 1 着を重視しつつ、3 着以内にも少し重みを置く
        const target = 0.75 * top[i] + 0.25 * top3[i] / t3n;
        const d = target - p[i];
        for (let k = 0; k < F; k++) g[k] += d * row.X[i][k];
      }
    }
    for (let k = 0; k < F; k++) {
      const grad = g[k] / N - l2 * w[k];
      m[k] = b1 * m[k] + (1 - b1) * grad;
      v[k] = b2 * v[k] + (1 - b2) * grad * grad;
      const mh = m[k] / (1 - b1 ** it), vh = v[k] / (1 - b2 ** it);
      w[k] += lr * 0.1 * mh / (Math.sqrt(vh) + 1e-8);
    }
  }
  return Object.fromEntries(FEATURES.map((f, k) => [f.key, Math.round(w[k] * 1000) / 1000]));
}

// ---------------- 1 レースの予想 ----------------
export function predictFromX(race, entries, X, weights, mode = 'hit') {
  const w = wVec(weights);
  const scores = X.map((x) => dot(w, x));
  const p = softmax(scores);
  // 「能力だけ」の評価（オッズを除く）— 穴馬探しに使う
  const wNoMkt = w.slice(); wNoMkt[MARKET] = 0;
  const pAbility = softmax(X.map((x) => dot(wNoMkt, x)));
  const hv = harville(p);
  const field = entries.length;
  const popRank = rankBy(entries.map((e) => (valid(e.odds) ? e.odds : valid(e.pop) ? popToOdds(e.pop, field) : NaN)), true);
  const abilityRank = rankBy(pAbility, false);

  const rows = entries.map((e, i) => {
    const pop = valid(e.pop) ? e.pop : popRank[i];
    const odds = valid(e.odds) ? e.odds : NaN;
    const ev = valid(odds) ? p[i] * odds : NaN;
    const contrib = FEATURES.map((f, k) => ({ label: f.label, v: w[k] * X[i][k] }))
      .filter((c) => Math.abs(c.v) > 0.05).sort((a, b) => b.v - a.v);
    const plus = contrib.filter((c) => c.v > 0).slice(0, 3).map((c) => c.label);
    const minus = contrib.filter((c) => c.v < 0).slice(-2).reverse().map((c) => c.label);
    const longshot = valid(pop) && pop >= 5 && (abilityRank[i] <= 4 || (valid(ev) && ev >= 1.15)) && p[i] >= 0.03;
    return { i, e, p: p[i], p3: hv.top3[i], pAbility: pAbility[i], pop, odds, ev, plus, minus, longshot, mark: '' };
  });

  // 印を打つ
  let order;
  if (mode === 'ana') {
    // 穴狙い：勝率が一定以上の馬の中から期待値（なければ能力評価）の高い順
    const byValue = rows.filter((r) => r.p >= 0.025).sort((a, b) => valueKey(b) - valueKey(a));
    order = byValue.concat(rows.filter((r) => r.p < 0.025).sort((a, b) => b.p - a.p));
  } else {
    order = rows.slice().sort((a, b) => b.p - a.p);
  }
  ['◎', '○', '▲', '△', '△'].forEach((mk, k) => { if (order[k]) order[k].mark = mk; });
  const star = rows.filter((r) => !r.mark && r.longshot).sort((a, b) => valueKey(b) - valueKey(a))[0];
  if (star) star.mark = '☆';

  return { race, rows, hv, bets: suggestBets(rows, hv, mode), mode };
}

function valueKey(r) { return valid(r.ev) ? r.ev : r.pAbility * Math.max(1, r.pop || 1) * 0.8; }

function rankBy(arr, asc) {
  const idx = arr.map((v, i) => [v, i]).filter(([v]) => valid(v)).sort((a, b) => (asc ? a[0] - b[0] : b[0] - a[0]));
  const out = new Array(arr.length).fill(NaN);
  idx.forEach(([, i], r) => { out[i] = r + 1; });
  return out;
}

function suggestBets(rows, hv, mode) {
  const by = (mk) => rows.filter((r) => r.mark === mk);
  const [hon] = by('◎'), [tai] = by('○'), [tan] = by('▲'), ren = by('△'), [ana] = by('☆');
  const no = (r) => r.e.no;
  const key = (a, b) => (a.i < b.i ? `${a.i}-${b.i}` : `${b.i}-${a.i}`);
  const bets = [];
  if (!hon) return bets;
  bets.push({ type: '単勝', pick: `${no(hon)}`, prob: hon.p, ev: hon.ev });
  bets.push({ type: '複勝', pick: `${no(hon)}`, prob: hon.p3 });
  const partners = [tai, tan, ...ren].filter(Boolean);
  if (partners.length) {
    const pq = partners.slice(0, 3).reduce((s, r) => s + (hv.quinella[key(hon, r)] || 0), 0);
    bets.push({ type: '馬連', pick: `${no(hon)} - ${partners.slice(0, 3).map(no).join('・')}（${Math.min(3, partners.length)}点）`, prob: pq });
    const two = partners.slice(0, 2).map((r) => r.i);
    const pw = probTop3(rows.map((r) => r.p), (t) => t.includes(hon.i) && two.some((x) => t.includes(x)));
    bets.push({ type: 'ワイド', pick: `${no(hon)} - ${partners.slice(0, 2).map(no).join('・')}（${Math.min(2, partners.length)}点）`, prob: pw });
  }
  const second = [tai, tan].filter(Boolean);
  const third = [tai, tan, ...ren, ana].filter(Boolean);
  if (second.length && third.length >= 2) {
    const combos = new Set();
    let pt = 0;
    for (const s of second) for (const t of third) {
      if (s === t) continue;
      const k = [hon.i, s.i, t.i].sort((a, b) => a - b).join('-');
      if (combos.has(k)) continue;
      combos.add(k); pt += hv.trio[k] || 0;
    }
    bets.push({ type: '三連複', pick: `${no(hon)} - ${second.map(no).join('・')} - ${third.map(no).join('・')}（${combos.size}点）`, prob: pt });
  }
  if (ana) {
    bets.push({ type: '穴 単勝', pick: `${no(ana)}`, prob: ana.p, ev: ana.ev, ana: true });
    bets.push({ type: '穴 複勝', pick: `${no(ana)}`, prob: ana.p3, ana: true });
    const mates = [hon, tai].filter(Boolean).map((r) => r.i);
    bets.push({ type: '穴 ワイド', pick: `${no(ana)} - ${[hon, tai].filter(Boolean).map(no).join('・')}`, prob: probTop3(rows.map((r) => r.p), (t) => t.includes(ana.i) && mates.some((x) => t.includes(x))), ana: true });
  }
  if (mode === 'ana') bets.sort((a, b) => (b.ana ? 1 : 0) - (a.ana ? 1 : 0));
  return bets;
}

// 全データで学習（予想に使う重み）
export function learnAll(allRaces, init) {
  const rows = buildDataset(allRaces);
  return rows.length >= 20 ? train(rows, { init }) : null;
}

export function predictRace(race, allRaces, weights, mode) {
  const st = buildState(allRaces, race.date, race.id);
  const entries = runners(race);
  if (entries.length < 2) return null;
  const X = st.featuresFor(race);
  const out = predictFromX(race, entries, X, weights, mode);
  out.history = (name) => st.horseHistory(name);
  return out;
}

// ---------------- 検証（バックテスト） ----------------
// 古い順に並べ、前半で学習 → 後半で予想して成績を測る（未来の情報を使わない）
export function backtest(allRaces, weights, opts = {}) {
  const rows = buildDataset(allRaces);
  if (rows.length < 20) return { error: '結果の入ったレースが少なすぎます（20 レース以上必要）' };
  const cut = Math.floor(rows.length * (opts.trainRatio ?? 0.7));
  const trainRows = rows.slice(0, cut), testRows = rows.slice(cut);
  const learned = opts.learn ? train(trainRows, { init: weights }) : weights;
  const evalW = (W, mode) => evaluate(testRows, W, mode);
  return {
    nTrain: trainRows.length, nTest: testRows.length,
    from: testRows[0].race.date, to: testRows[testRows.length - 1].race.date,
    weights: learned,
    hit: evalW(learned, 'hit'),
    ana: evalW(learned, 'ana'),
    baseline: baseline(testRows),
    allRows: rows,
  };
}

function evaluate(rows, W, mode) {
  const s = { n: 0, winHit: 0, top3Hit: 0, winBet: 0, winRet: 0, placeBet: 0, placeRet: 0,
    quinellaHit: 0, trioHit: 0, anaN: 0, anaWin: 0, anaTop3: 0, anaRet: 0, anaBet: 0, logloss: 0 };
  for (const row of rows) {
    const pr = predictFromX(row.race, row.entries, row.X, W, mode);
    s.n++;
    const hon = pr.rows.find((r) => r.mark === '◎');
    const tai = pr.rows.find((r) => r.mark === '○');
    const winnerRow = pr.rows.find((r) => r.e.finish === 1);
    if (winnerRow) s.logloss += -Math.log(Math.max(1e-6, winnerRow.p));
    if (hon) {
      if (hon.e.finish === 1) s.winHit++;
      if (hon.e.finish <= 3) s.top3Hit++;
      if (valid(hon.e.odds)) { s.winBet++; if (hon.e.finish === 1) s.winRet += hon.e.odds; }
      // 複勝の払戻が分かるレースだけ回収率に数える
      if (!(hon.e.finish <= 3 && !valid(hon.e.placeOdds))) {
        s.placeBet++;
        if (hon.e.finish <= 3) s.placeRet += hon.e.placeOdds;
      }
      if (tai && hon.e.finish <= 2 && tai.e.finish <= 2) s.quinellaHit++;
      const marked = pr.rows.filter((r) => r.mark).map((r) => r.e.finish);
      if (hon.e.finish <= 3 && marked.filter((f) => f <= 3).length >= 3) s.trioHit++;
    }
    const ana = pr.rows.find((r) => r.mark === '☆');
    if (ana) {
      s.anaN++;
      if (ana.e.finish === 1) s.anaWin++;
      if (ana.e.finish <= 3) s.anaTop3++;
      if (valid(ana.e.odds)) { s.anaBet++; if (ana.e.finish === 1) s.anaRet += ana.e.odds; }
    }
  }
  const pct = (a, b) => (b ? (a / b) * 100 : NaN);
  return {
    races: s.n,
    winRate: pct(s.winHit, s.n), top3Rate: pct(s.top3Hit, s.n),
    winROI: pct(s.winRet, s.winBet), placeROI: pct(s.placeRet, s.placeBet),
    quinellaRate: pct(s.quinellaHit, s.n), trioRate: pct(s.trioHit, s.n),
    anaN: s.anaN, anaWinRate: pct(s.anaWin, s.anaN), anaTop3Rate: pct(s.anaTop3, s.anaN), anaROI: pct(s.anaRet, s.anaBet),
    logloss: s.n ? s.logloss / s.n : NaN,
  };
}

// 比較用：1 番人気を買い続けた場合
function baseline(rows) {
  let n = 0, win = 0, top3 = 0, bet = 0, ret = 0;
  for (const row of rows) {
    const fav = row.entries.filter((e) => valid(e.odds)).sort((a, b) => a.odds - b.odds)[0]
      || row.entries.filter((e) => valid(e.pop)).sort((a, b) => a.pop - b.pop)[0];
    if (!fav) continue;
    n++;
    if (fav.finish === 1) win++;
    if (fav.finish <= 3) top3++;
    if (valid(fav.odds)) { bet++; if (fav.finish === 1) ret += fav.odds; }
  }
  return { races: n, winRate: n ? win / n * 100 : NaN, top3Rate: n ? top3 / n * 100 : NaN, winROI: bet ? ret / bet * 100 : NaN };
}
