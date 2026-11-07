// デモ用の過去データを作る（架空の馬・騎手。仕組みを試すためのもの）
import { VENUES } from './venues.js';
import { raceId } from './store.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const SYL = ['アル', 'ベル', 'カイ', 'ドン', 'エア', 'フジ', 'ゴールド', 'ハナ', 'イチ', 'ジェイ', 'キング', 'ルナ', 'マル', 'ノヴァ', 'オー', 'ピコ', 'クイン', 'リオ', 'サン', 'トウ', 'ウィン', 'ヴィ', 'ワン', 'ユメ', 'ゼン', 'スター', 'ミラ', 'ソラ', 'カゼ', 'ホシ'];
const SUF = ['ブレイブ', 'ランナー', 'フラッシュ', 'ドリーム', 'エース', 'ストーム', 'ハート', 'クラウン', 'ロード', 'ミラクル', 'ビート', 'ウイング', 'ブライト', 'シャイン', 'ダッシュ'];
const LAST = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '松本', '井上', '木村', '林', '清水', '山口', '森', '池田'];

export function makeDemo({ days = 60, seed = 7, today } = {}) {
  const R = rng(seed);
  const gauss = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const pick = (a) => a[Math.floor(R() * a.length)];

  const makePool = (center, n) => Array.from({ length: n }, (_, i) => ({
    name: `${pick(SYL)}${pick(SUF)}${center === 'NAR' ? '' : ''}${i % 7 === 0 ? pick(['', 'II', '']) : ''}`,
    ability: gauss(), turf: gauss() * 0.6, ideal: 1000 + Math.floor(R() * 13) * 100 + (center === 'NAR' ? -200 : 200),
    heavy: gauss() * 0.4, sexAge: `${pick(['牡', '牝', 'セ'])}${3 + Math.floor(R() * 4)}`, bw: 440 + Math.floor(R() * 80),
  }));
  const uniq = (pool) => { const seen = new Set(); for (const h of pool) { let n = h.name; let k = 2; while (seen.has(n)) n = `${h.name}${k++}`; h.name = n; seen.add(n); } return pool; };
  const people = (n, pre) => Array.from({ length: n }, () => ({ name: `${pick(LAST)}${pre}${pick(['', '一', '二', '三', '太', '健', '翔', '大'])}`, skill: gauss() * 0.35 }));

  const setups = [
    { center: 'JRA', venues: ['tokyo', 'kyoto'], horses: uniq(makePool('JRA', 700)), jockeys: people(40, ''), trainers: people(30, '厩') },
    { center: 'NAR', venues: ['ooi', 'sonoda'], horses: uniq(makePool('NAR', 500)), jockeys: people(30, ''), trainers: people(25, '厩') },
  ];

  const races = [];
  const base = today ? new Date(today) : new Date();
  for (let d = days; d >= 0; d--) {
    const dt = new Date(base); dt.setDate(dt.getDate() - d);
    const date = dt.toISOString().slice(0, 10);
    const dow = dt.getDay();
    for (const S of setups) {
      // 中央は土日、地方は平日中心
      const open = S.center === 'JRA' ? dow === 0 || dow === 6 : dow >= 1 && dow <= 5 && R() < 0.6;
      if (!open && d !== 0) continue;
      for (const venue of S.venues) {
        if (S.center === 'NAR' && R() < 0.4 && d !== 0) continue;
        const condition = pick(['良', '良', '良', '稍重', '重', '不良']);
        for (let no = 1; no <= 12; no++) {
          const surface = S.center === 'NAR' ? 'ダ' : (R() < 0.5 ? '芝' : 'ダ');
          const distance = S.center === 'NAR' ? pick([1200, 1400, 1600, 1700, 1800, 2000]) : pick([1200, 1400, 1600, 1800, 2000, 2200, 2400]);
          const field = 8 + Math.floor(R() * 9);
          const chosen = new Set();
          while (chosen.size < field) chosen.add(Math.floor(R() * S.horses.length));
          const hs = [...chosen].map((k) => S.horses[k]);
          const entries = hs.map((h, i) => {
            const j = pick(S.jockeys), t = pick(S.trainers);
            const nb = i + 1;
            const expPerf = h.ability + (surface === '芝' ? h.turf : -h.turf) - Math.abs(distance - h.ideal) / 900
              + j.skill + t.skill * 0.5 + (condition === '重' || condition === '不良' ? h.heavy : 0) - (nb / field) * 0.15;
            const bodyDiff = Math.round(gauss() * 5) * 2;
            const perf = expPerf + gauss() * 1.15 - Math.max(0, Math.abs(bodyDiff) - 8) * 0.05;
            return {
              no: nb, frame: Math.ceil(nb / Math.max(1, field / 8)), horse: h.name, sexAge: h.sexAge, weight: 54 + Math.floor(R() * 5),
              jockey: j.name, trainer: t.name, bodyWeight: h.bw + bodyDiff, bodyDiff, expPerf, perf,
            };
          });
          // 市場の見立て（多少ずれる）→ オッズ
          const belief = entries.map((e) => Math.exp(1.25 * (e.expPerf + gauss() * 0.55)));
          const bs = belief.reduce((a, b) => a + b, 0);
          entries.forEach((e, i) => { e.odds = Math.max(1.1, Math.round((0.8 / (belief[i] / bs)) * 10) / 10); });
          [...entries].sort((a, b) => a.odds - b.odds).forEach((e, i) => { e.pop = i + 1; });
          const isToday = d === 0;
          if (!isToday) {
            [...entries].sort((a, b) => b.perf - a.perf).forEach((e, i) => {
              e.finish = i + 1;
              e.last3f = Math.round((35.5 - e.perf * 0.5 + gauss() * 0.4 + (surface === 'ダ' ? 1.2 : 0)) * 10) / 10;
              if (e.finish <= 3) e.placeOdds = Math.max(1.1, Math.round((1 + (e.odds - 1) / 3.6) * 10) / 10);
            });
          }
          entries.forEach((e) => { delete e.expPerf; delete e.perf; });
          races.push({
            id: raceId(date, S.center, venue, no), date, center: S.center, venue, raceNo: no,
            name: `${no}R ${pick(['未勝利', '1勝クラス', '2勝クラス', '3勝クラス', 'オープン', 'C1', 'B2', 'A1'])}`,
            surface, distance, condition, raceClass: '', entries, demo: true,
          });
        }
      }
    }
  }
  return races;
}

export const DEMO_VENUES = { JRA: VENUES.JRA.filter((v) => ['tokyo', 'kyoto'].includes(v.id)), NAR: VENUES.NAR.filter((v) => ['ooi', 'sonoda'].includes(v.id)) };
