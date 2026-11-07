// CSV の読み書き。1 行 = 1 頭（レースごとにまとめて取り込む）
import { findVenueByName } from './venues.js';
import { raceId } from './store.js';

// 列名（日本語・英語どちらでも可）
export const COLUMNS = [
  ['date', '日付'], ['center', '区分'], ['venue', '競馬場'], ['raceNo', 'R'],
  ['raceName', 'レース名'], ['surface', '芝ダ'], ['distance', '距離'], ['condition', '馬場'],
  ['raceClass', 'クラス'], ['no', '馬番'], ['frame', '枠'], ['horse', '馬名'],
  ['sexAge', '性齢'], ['weight', '斤量'], ['jockey', '騎手'], ['trainer', '調教師'],
  ['bodyWeight', '馬体重'], ['bodyDiff', '増減'], ['odds', '単勝'], ['pop', '人気'],
  ['finish', '着順'], ['time', 'タイム'], ['last3f', '上り'], ['placeOdds', '複勝'],
];

const ALIASES = (() => {
  const m = {};
  for (const [k, ja] of COLUMNS) { m[k.toLowerCase()] = k; m[ja] = k; }
  Object.assign(m, {
    'レース': 'raceNo', 'レース番号': 'raceNo', 'race': 'raceNo', '場': 'venue', '場所': 'venue',
    'コース': 'surface', '馬場状態': 'condition', '枠番': 'frame', '単勝オッズ': 'odds',
    '上がり': 'last3f', '上り3f': 'last3f', '上がり3f': 'last3f', '着': 'finish', '中央地方': 'center',
    '複勝オッズ': 'placeOdds', '体重': 'bodyWeight',
  });
  return m;
})();

export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const sep = text.split('\n')[0].includes('\t') ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const num = (v) => {
  if (v == null) return NaN;
  const s = String(v).replace(/[，,]/g, '').replace(/[０-９．]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).trim();
  if (s === '') return NaN;
  return Number(s);
};

export function normDate(s) {
  const m = String(s || '').match(/(\d{4})\D?(\d{1,2})\D?(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

export function normCenter(s, venueGuess) {
  const t = String(s || '').trim().toUpperCase();
  if (t === 'JRA' || t === '中央') return 'JRA';
  if (t === 'NAR' || t === '地方') return 'NAR';
  return venueGuess ? venueGuess.center : 'JRA';
}

export function normSurface(s) {
  const t = String(s || '');
  if (t.includes('障')) return '障';
  if (t.includes('ダ') || t.toLowerCase().startsWith('d')) return 'ダ';
  return '芝';
}

// "12.3" / "1:34.5" を秒に
export function parseTime(s) {
  const t = String(s || '').trim();
  if (!t) return NaN;
  const m = t.match(/^(\d+)[:.](\d{1,2})\.(\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 10;
  return num(t);
}

// CSV テキスト → レースの配列
export function csvToRaces(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => ALIASES[h.trim().toLowerCase()] || ALIASES[h.trim()] || null);
  const races = new Map();
  for (const r of rows.slice(1)) {
    const o = {};
    head.forEach((k, i) => { if (k) o[k] = (r[i] ?? '').trim(); });
    const vg = findVenueByName(o.venue);
    const date = normDate(o.date);
    const raceNo = num(String(o.raceNo || '').replace(/R$/i, ''));
    if (!date || !vg || !raceNo) continue;
    const center = normCenter(o.center, vg);
    const id = raceId(date, center, vg.id, raceNo);
    if (!races.has(id)) {
      races.set(id, {
        id, date, center, venue: vg.id, raceNo, name: o.raceName || '',
        surface: normSurface(o.surface), distance: num(o.distance) || 0,
        condition: o.condition || '良', raceClass: o.raceClass || '', entries: [],
      });
    }
    const finishStr = String(o.finish || '');
    races.get(id).entries.push({
      no: num(o.no), frame: num(o.frame), horse: o.horse || '', sexAge: o.sexAge || '',
      weight: num(o.weight), jockey: o.jockey || '', trainer: o.trainer || '',
      bodyWeight: num(o.bodyWeight), bodyDiff: num(String(o.bodyDiff || '').replace('+', '')),
      odds: num(o.odds), pop: num(o.pop), finish: num(finishStr),
      scratched: /取|除|中止/.test(finishStr) || undefined,
      time: parseTime(o.time), last3f: num(o.last3f), placeOdds: num(o.placeOdds),
    });
  }
  for (const r of races.values()) r.entries.sort((a, b) => a.no - b.no);
  return [...races.values()];
}

const esc = (v) => {
  if (v == null || (typeof v === 'number' && isNaN(v))) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function racesToCSV(races, venueNameFn) {
  const lines = [COLUMNS.map((c) => c[1]).join(',')];
  for (const r of races) {
    for (const e of r.entries) {
      const row = {
        ...e, date: r.date, center: r.center === 'JRA' ? '中央' : '地方', venue: venueNameFn(r.center, r.venue),
        raceNo: r.raceNo, raceName: r.name, surface: r.surface, distance: r.distance,
        condition: r.condition, raceClass: r.raceClass, finish: e.scratched ? '取消' : e.finish,
      };
      lines.push(COLUMNS.map(([k]) => esc(row[k])).join(','));
    }
  }
  return lines.join('\n');
}
