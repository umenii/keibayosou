import { VENUES, CENTER_LABEL, venueName, findVenueByName, MAX_RACES } from './venues.js';
import * as store from './store.js';
import { csvToRaces, racesToCSV, COLUMNS, parseCSV, normDate, normSurface, parseTime } from './csv.js';
import { FEATURES, DEFAULT_WEIGHTS, predictRace, backtest, learnAll, isFinished } from './model.js';
import { makeDemo } from './demo.js';
import * as ai from './ai.js';
import * as remote from './remote.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const valid = (x) => typeof x === 'number' && isFinite(x);
const fmt = (x, d = 1) => (valid(x) ? x.toFixed(d) : '—');
const pct = (x, d = 1) => (valid(x) ? `${(x * 100).toFixed(d)}%` : '—');
const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

// ---------------- 状態 ----------------
const S = Object.assign({
  center: 'JRA', venue: 'tokyo', date: today(), raceNo: 1, mode: 'hit', tab: 'card',
  weights: { ...DEFAULT_WEIGHTS }, apiKey: '', ghRepo: '', ghToken: '', ghAuto: true, aiModel: ai.DEFAULT_MODEL, aiEffort: 'medium',
}, store.loadSettings());
S.weights = { ...DEFAULT_WEIGHTS, ...S.weights };
let race = null;        // 表示中のレース
let allCache = null;    // 全レース（読み込み済みなら）
let learnedWeights = null;

const save = () => store.saveSettings(S);
const aiSettings = () => ({ apiKey: S.apiKey, model: S.aiModel, effort: S.aiEffort });

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.tm); toast.tm = setTimeout(() => t.classList.remove('on'), ms);
}

async function getAll(force) {
  if (!allCache || force) allCache = await store.allRaces();
  return allCache;
}
const invalidate = () => { allCache = null; };

// ---------------- レース選択 ----------------
function renderSelector() {
  $$('#centerSeg button').forEach((b) => b.classList.toggle('on', b.dataset.center === S.center));
  const vs = VENUES[S.center];
  if (!vs.some((v) => v.id === S.venue)) S.venue = vs[0].id;
  $('#venueSel').innerHTML = vs.map((v) => `<option value="${v.id}"${v.id === S.venue ? ' selected' : ''}>${v.name}</option>`).join('');
  $('#dateInp').value = S.date;
}

async function renderRaceBtns() {
  const all = await getAll();
  const day = all.filter((r) => r.date === S.date && r.center === S.center && r.venue === S.venue);
  const byNo = new Map(day.map((r) => [r.raceNo, r]));
  $('#raceBtns').innerHTML = Array.from({ length: MAX_RACES }, (_, i) => {
    const n = i + 1, r = byNo.get(n);
    const cls = [n === S.raceNo ? 'on' : '', r ? (isFinished(r) ? 'done' : 'has') : ''].join(' ');
    return `<button type="button" class="${cls}" data-race="${n}">${n}R</button>`;
  }).join('');
}

async function loadRace() {
  const id = store.raceId(S.date, S.center, S.venue, S.raceNo);
  race = (await store.getRace(id)) || {
    id, date: S.date, center: S.center, venue: S.venue, raceNo: S.raceNo, name: '',
    surface: S.center === 'NAR' ? 'ダ' : '芝', distance: 1600, condition: '良', raceClass: '', entries: [], isNew: true,
  };
  renderTitle();
  renderCard();
  renderPaddockTargets();
  $('#predictOut').innerHTML = '';
  $('#paperResult').innerHTML = '';
  $('#paddockResult').innerHTML = renderPaddockNotes();
  await renderRaceBtns();
  if (S.tab === 'data') renderData();
  // 集めたデータを自動で読み込む
  if (S.ghAuto && remote.isConfigured(S) && needsRemote(race.date)) {
    await loadRemoteDate(race.date, { quiet: true });
  }
}

// ---------------- 無料データ（GitHub） ----------------
const remoteLoaded = new Map(); // 日付 → 読み込んだ時刻
function needsRemote(date) {
  const t = remoteLoaded.get(date);
  // 今日・明日は 10 分ごと、それ以外は 1 回だけ
  return !t || (date >= today() && Date.now() - t > 10 * 60 * 1000);
}
function ghStatus(html) { $('#ghStatus').innerHTML = html; }

async function loadRemoteDate(date, { quiet } = {}) {
  if (!remote.isConfigured(S)) {
    if (!quiet) { toast('設定タブで GitHub のリポジトリとトークンを入力してください'); switchTab('settings'); }
    return 0;
  }
  ghStatus(`<span class="spin"></span>${date} のデータを読み込み中…`);
  try {
    const races = await remote.loadDate(S, date);
    remoteLoaded.set(date, Date.now());
    if (!races.length) {
      ghStatus(`${date} のデータはまだありません。${date >= today() ? '出馬表は前日〜当日朝に集まります。「今すぐ集める」も使えます。' : '「過去データ」タブの「過去の結果を集める」で集められます。'}`);
      return 0;
    }
    await store.mergeRaces(races);
    invalidate();
    const shown = races.find((r) => r.id === race.id);
    if (shown) {
      race = await store.getRace(race.id);
      renderTitle(); renderCard(); renderPaddockTargets();
    }
    await renderRaceBtns();
    const upd = races.map((r) => r.remoteUpdated).filter(Boolean).sort().pop() || '';
    ghStatus(`${date}：${races.length} レースを読み込みました${upd ? `（${upd.replace('T', ' ').slice(0, 16)} 時点）` : ''}`);
    if (S.tab === 'data') renderData();
    return races.length;
  } catch (e) {
    ghStatus(`エラー：${escapeHTML(e.message)}`);
    return 0;
  }
}

$('#ghLoadBtn').addEventListener('click', () => { remoteLoaded.delete(S.date); loadRemoteDate(S.date); });

async function triggerAndWait(params, label, statusFn) {
  if (!remote.isConfigured(S)) { toast('設定タブで GitHub のリポジトリとトークンを入力してください'); switchTab('settings'); return; }
  try {
    await remote.triggerCollect(S, params);
    statusFn(`<span class="spin"></span>${label}を GitHub に頼みました。数分〜十数分かかります（終わったら自動で読み込みます）…`);
  } catch (e) {
    statusFn(`エラー：${escapeHTML(e.message)}。トークンに「Actions：読み取りと書き込み」の権限が必要です。`);
    return;
  }
  // 終わるまで 30 秒ごとに確認（最大 40 分）
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 15000));
  while (Date.now() - started < 40 * 60 * 1000) {
    let run = null;
    try { run = await remote.lastRun(S); } catch { /* 権限がなければ確認しない */ }
    if (!run) break;
    if (run.status === 'completed') {
      statusFn(run.conclusion === 'success' ? `${label}が終わりました。` : `${label}が失敗しました（<a href="${run.url}" target="_blank" rel="noopener">記録を見る</a>）`);
      return run.conclusion === 'success';
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
  statusFn(`${label}の状況を確認できませんでした。しばらくしてから「最新データを読み込む」を押してください。`);
  return false;
}

$('#ghCollectBtn').addEventListener('click', async () => {
  const d = S.date;
  const ok = await triggerAndWait({ dates: d, horses: true }, `${d} の収集`, ghStatus);
  if (ok) { remoteLoaded.delete(d); await loadRemoteDate(d); }
});

$('#ghAllBtn').addEventListener('click', async () => {
  if (!remote.isConfigured(S)) { toast('設定タブで GitHub のリポジトリとトークンを入力してください'); switchTab('settings'); return; }
  const st = (h) => { $('#ghAllStatus').innerHTML = h; };
  try {
    const idx = await remote.loadIndex(S);
    const dates = Object.keys(idx.dates || {}).sort();
    let n = 0;
    for (let i = 0; i < dates.length; i++) {
      st(`<span class="spin"></span>${dates[i]} を読み込み中（${i + 1}/${dates.length}）…`);
      const races = await remote.loadDate(S, dates[i]);
      if (races.length) { await store.mergeRaces(races); n += races.length; }
      remoteLoaded.set(dates[i], Date.now());
    }
    invalidate();
    st(`${dates.length} 日分・${n} レースを読み込みました`);
    renderData(); loadRace();
  } catch (e) { st(`エラー：${escapeHTML(e.message)}`); }
});

$('#ghBackfillBtn').addEventListener('click', async () => {
  const from = $('#ghFrom').value, to = $('#ghTo').value || from;
  if (!from) { toast('集める期間の開始日を選んでください'); return; }
  const days = (new Date(to) - new Date(from)) / 86400000 + 1;
  if (days < 1 || days > 20) { toast('一度に集められるのは 20 日分までです'); return; }
  if (!confirm(`${from}〜${to}（${days} 日）の結果を Yahoo!スポーツナビ 競馬から集めます。サイトに負担をかけないようゆっくり集めるので、1 日分あたり 2〜4 分かかります。よろしいですか？`)) return;
  const st = (h) => { $('#ghAllStatus').innerHTML = h; };
  const ok = await triggerAndWait({ from, to, horses: false }, `${from}〜${to} の収集`, st);
  if (ok) $('#ghAllBtn').click();
});

function renderTitle() {
  const n = race.entries.filter((e) => !e.scratched).length;
  $('#raceTitle').innerHTML = `<b>${CENTER_LABEL[race.center]}・${venueName(race.center, race.venue)} ${race.raceNo}R</b>
    <span>${escapeHTML(race.name || '')}</span>
    <span>${race.surface}${race.distance || ''}m・${race.condition}</span>
    <span>${n ? `${n}頭` : '出走表なし'}</span>${race.startTime ? `<span>${escapeHTML(race.startTime)} 発走</span>` : ''}${isFinished(race) ? '<span class="tag">結果あり</span>' : ''}
    ${(race.sources || []).filter((u) => /^https?:/.test(u)).slice(0, 2).map((u) => `<a class="src" href="${escapeHTML(u)}" target="_blank" rel="noopener">出典</a>`).join('')}`;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveRace, 400);
}
async function saveRace() {
  clearTimeout(saveTimer);
  if (!race || (race.isNew && !race.entries.length)) return;
  delete race.isNew;
  race.entries.sort((a, b) => (a.no || 99) - (b.no || 99));
  await store.putRace(race);
  invalidate();
  renderTitle();
  renderRaceBtns();
}

// ---------------- 出走表 ----------------
const COLS = [
  ['frame', 'num', 2], ['no', 'num', 2], ['horse', 'text', 0], ['sexAge', 'text', 3], ['weight', 'num', 3],
  ['jockey', 'text', 5], ['trainer', 'text', 5], ['bodyWeight', 'num', 3], ['bodyDiff', 'num', 3],
  ['odds', 'num', 4], ['pop', 'num', 2], ['marks', 'text', 5], ['paddock', 'pad', 0], ['finish', 'fin', 2],
];

function cellValue(e, k) {
  if (k === 'finish' && e.scratched) return '取';
  const v = e[k];
  return v == null || (typeof v === 'number' && isNaN(v)) ? '' : v;
}

function renderCard() {
  $('#raceName').value = race.name || '';
  $('#raceSurface').value = race.surface || '芝';
  $('#raceDist').value = race.distance || '';
  $('#raceCond').value = race.condition || '良';
  const tb = $('#entryTable tbody');
  tb.innerHTML = race.entries.map((e, i) => `<tr data-i="${i}" class="${e.scratched ? 'scr' : ''} f${e.frame || ''}">${COLS.map(([k, t, sz]) => {
    if (t === 'pad') {
      return `<td><select data-k="paddock"><option value=""></option>${['A', 'B', 'C', 'D', 'E'].map((g) => `<option${e.paddock === g ? ' selected' : ''}>${g}</option>`).join('')}</select>${valid(e.aiPaddock) ? `<small class="ai" title="${escapeHTML(e.aiComment || '')}">AI${e.aiPaddock}</small>` : ''}</td>`;
    }
    const cls = k === 'horse' ? 'w-name' : '';
    return `<td class="${cls}"><input data-k="${k}" value="${escapeHTML(cellValue(e, k))}" ${t !== 'text' ? 'inputmode="decimal"' : ''} ${sz ? `size="${sz}"` : ''}></td>`;
  }).join('')}<td><button type="button" class="icon" data-del="${i}" aria-label="削除">✕</button></td></tr>`).join('')
    || `<tr><td colspan="15" class="empty">出走表がありません。「＋ 1 頭追加」で入力するか、表の貼り付け・新聞の写真から取り込んでください。</td></tr>`;
}

$('#entryTable').addEventListener('input', (ev) => {
  const inp = ev.target.closest('[data-k]');
  if (!inp) return;
  const i = Number(inp.closest('tr').dataset.i);
  const e = race.entries[i];
  const k = inp.dataset.k;
  const v = inp.value.trim();
  if (k === 'finish') {
    e.scratched = /取|除|消/.test(v) || undefined;
    e.finish = e.scratched ? NaN : num(v);
    inp.closest('tr').classList.toggle('scr', !!e.scratched);
  } else if (['horse', 'sexAge', 'jockey', 'trainer', 'marks', 'paddock'].includes(k)) e[k] = v;
  else e[k] = num(v);
  scheduleSave();
});
$('#entryTable').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-del]');
  if (!b) return;
  race.entries.splice(Number(b.dataset.del), 1);
  renderCard(); scheduleSave();
});
const num = (v) => { const s = String(v ?? '').replace(/[＋+]/g, '').replace(/[０-９．－]/g, (d) => (d === '－' ? '-' : String.fromCharCode(d.charCodeAt(0) - 0xfee0))).trim(); return s === '' ? NaN : Number(s); };

for (const [id, k, conv] of [['#raceName', 'name', String], ['#raceSurface', 'surface', String], ['#raceDist', 'distance', Number], ['#raceCond', 'condition', String]]) {
  $(id).addEventListener('input', () => { race[k] = conv($(id).value); scheduleSave(); });
}

$('#addRowBtn').addEventListener('click', () => {
  const nos = race.entries.map((e) => e.no).filter(valid);
  const no = nos.length ? Math.max(...nos) + 1 : 1;
  race.entries.push({ no, frame: NaN, horse: '', jockey: '', trainer: '' });
  renderCard();
  const rows = $$('#entryTable tbody tr');
  rows[rows.length - 1]?.querySelector('[data-k="horse"]')?.focus();
  scheduleSave();
});

$('#delRaceBtn').addEventListener('click', async () => {
  if (!confirm('このレースのデータを削除しますか？')) return;
  await store.deleteRace(race.id);
  invalidate();
  toast('削除しました');
  loadRace();
});

// 表の貼り付け
$('#pasteBtn').addEventListener('click', () => { $('#pasteText').value = ''; $('#pasteDlg').showModal(); });
$('#pasteDlg').addEventListener('close', () => {
  if ($('#pasteDlg').returnValue !== 'ok') return;
  const text = $('#pasteText').value.trim();
  if (!text) return;
  // 日付・競馬場・R の列がなければ、今選んでいるレースとして読む
  const rows = parseCSV(text);
  const head = rows[0].map((h) => h.trim());
  const extra = [];
  if (!head.some((h) => /日付|date/i.test(h))) extra.push(['日付', race.date]);
  if (!head.some((h) => /競馬場|venue|^場/i.test(h))) extra.push(['競馬場', venueName(race.center, race.venue)]);
  if (!head.some((h) => /^R$|レース$|レース番号|raceNo/i.test(h))) extra.push(['R', race.raceNo]);
  const lines = rows.map((r, i) => [...r, ...extra.map(([h, v]) => (i === 0 ? h : v))].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
  const parsed = csvToRaces(lines.join('\n'));
  const mine = parsed.find((r) => r.id === race.id) || parsed[0];
  if (!mine || !mine.entries.length) { toast('取り込めませんでした。1 行目に「馬番」「馬名」などの列名を入れてください'); return; }
  mergeEntries(mine.entries);
  if (mine.distance) race.distance = mine.distance;
  renderCard(); saveRace(); renderPaddockTargets();
  toast(`${mine.entries.length} 頭を取り込みました`);
});

// 既存の出走表に（馬番で）重ねる
function mergeEntries(list, target = race) {
  const byNo = new Map(target.entries.map((e) => [e.no, e]));
  for (const n of list) {
    const clean = Object.fromEntries(Object.entries(n).filter(([, v]) => v !== '' && v != null
      && !(typeof v === 'number' && isNaN(v)) && !(Array.isArray(v) && !v.length)));
    const old = byNo.get(n.no) || target.entries.find((e) => e.horse && e.horse === n.horse);
    if (old) Object.assign(old, clean);
    else target.entries.push({ ...clean });
  }
  target.entries.sort((a, b) => (a.no || 99) - (b.no || 99));
}

// AI が読み取った内容（新聞の写真・Web）をレースに反映する
function applyExtracted(target, d) {
  const r = d.race || {};
  if (r.name) target.name = r.name;
  if (r.raceClass) target.raceClass = r.raceClass;
  if (r.surface) target.surface = normSurface(r.surface);
  if (num(r.distance)) target.distance = num(r.distance);
  if (r.condition) target.condition = r.condition;
  if (r.startTime) target.startTime = r.startTime;
  const list = (d.entries || []).map((e) => {
    const fin = String(e.finish ?? '');
    const out = {
      no: num(e.no), frame: num(e.frame), horse: e.horse || '', sexAge: e.sexAge || '', weight: num(e.weight),
      jockey: e.jockey || '', trainer: e.trainer || '', odds: num(e.odds), pop: num(e.pop), marks: e.marks || '',
      bodyWeight: num(e.bodyWeight), bodyDiff: num(e.bodyDiff),
      finish: num(fin), time: parseTime(e.time), last3f: num(e.last3f), placeOdds: num(e.placeOdds),
      pastRuns: (e.pastRuns || []).map((p) => ({
        ...p, date: normDate(p.date), venueId: findVenueByName(p.venue)?.id, surface: normSurface(p.surface),
        distance: num(p.distance), finish: num(p.finish), field: num(p.field), pop: num(p.pop),
        last3f: num(p.last3f), last3fRank: num(p.last3fRank),
      })).filter((p) => p.date),
    };
    if (/取|除|止|消/.test(fin)) out.scratched = true;
    return out;
  }).filter((e) => valid(e.no) || e.horse);
  mergeEntries(list, target);
  return list.length;
}

// ---------------- 新聞の写真 ----------------
let paperBlocks = [];
$('#paperFiles').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  if (!files.length) return;
  $('#paperStatus').textContent = '準備中…';
  try {
    paperBlocks = await ai.filesToBlocks(files);
    $('#paperThumbs').innerHTML = paperBlocks.map((b) => `<img src="${b.thumb}" alt="">`).join('');
    $('#paperRunBtn').disabled = false;
    $('#paperStatus').textContent = `${paperBlocks.length} 枚`;
  } catch (e) { $('#paperStatus').textContent = e.message; }
  ev.target.value = '';
});

let paperData = null;
$('#paperRunBtn').addEventListener('click', async () => {
  const btn = $('#paperRunBtn');
  btn.disabled = true;
  $('#paperStatus').innerHTML = '<span class="spin"></span>読み取り中…（30 秒〜数分）';
  try {
    const hint = `${CENTER_LABEL[race.center]} ${venueName(race.center, race.venue)} ${race.date} ${race.raceNo}R`;
    paperData = await ai.readNewspaper(aiSettings(), paperBlocks.map((b) => b.block), hint);
    $('#paperStatus').textContent = '読み取りました。内容を確認して反映してください';
    renderPaperResult();
  } catch (e) {
    $('#paperStatus').textContent = `エラー：${e.message}`;
  } finally { btn.disabled = false; }
});

function renderPaperResult() {
  const d = paperData;
  if (!d || !Array.isArray(d.entries)) { $('#paperResult').innerHTML = '<p class="hint">出走表が見つかりませんでした。</p>'; return; }
  const r = d.race || {};
  const vg = findVenueByName(r.venue);
  const mismatch = (vg && vg.id !== race.venue) || (r.raceNo && r.raceNo !== race.raceNo) || (r.date && normDate(r.date) !== race.date);
  $('#paperResult').innerHTML = `
    <div class="ocr-head">読み取り結果：${escapeHTML(r.venue || '?')} ${escapeHTML(r.raceNo || '?')}R ${escapeHTML(r.name || '')} ${escapeHTML(r.surface || '')}${escapeHTML(r.distance || '')}m ${escapeHTML(r.condition || '')}</div>
    ${mismatch ? '<p class="warn">選んでいるレース（上の表示）と、写真のレースが違うようです。反映先を確認してください。</p>' : ''}
    <div class="table-wrap"><table class="mini"><thead><tr><th>枠</th><th>番</th><th>馬名</th><th>性齢</th><th>斤量</th><th>騎手</th><th>オッズ</th><th>人気</th><th>印</th><th>過去走</th></tr></thead><tbody>
    ${d.entries.map((e) => `<tr><td>${escapeHTML(e.frame ?? '')}</td><td>${escapeHTML(e.no ?? '')}</td><td>${escapeHTML(e.horse ?? '')}</td><td>${escapeHTML(e.sexAge ?? '')}</td><td>${escapeHTML(e.weight ?? '')}</td><td>${escapeHTML(e.jockey ?? '')}</td><td>${escapeHTML(e.odds ?? '')}</td><td>${escapeHTML(e.pop ?? '')}</td><td>${escapeHTML(e.marks ?? '')}</td><td>${(e.pastRuns || []).length}</td></tr>`).join('')}
    </tbody></table></div>
    ${d.notes ? `<p class="hint">メモ：${escapeHTML(d.notes)}</p>` : ''}
    <div class="btn-row"><button type="button" class="primary" id="paperApplyBtn">このレースに反映</button></div>`;
  $('#paperApplyBtn').addEventListener('click', applyPaper);
}

function applyPaper() {
  const n = applyExtracted(race, paperData);
  renderCard(); renderTitle(); renderPaddockTargets(); saveRace();
  toast(`${n} 頭を反映しました`);
  switchTab('card');
}

// ---------------- パドック ----------------
function renderPaddockTargets() {
  const opts = race.entries.filter((e) => !e.scratched).map((e) => `<option value="${e.no}">${e.no} ${escapeHTML(e.horse)}</option>`).join('');
  $('#paddockTarget').innerHTML = `<option value="all">全頭（パドック全体）</option>${opts}`;
}

let paddockBlocks = [];
$('#paddockFiles').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  if (!files.length) return;
  $('#paddockStatus').innerHTML = '<span class="spin"></span>フレームを切り出し中…';
  try {
    paddockBlocks = await ai.filesToBlocks(files, $('#paddockTarget').value === 'all' ? 8 : 5);
    $('#paddockThumbs').innerHTML = paddockBlocks.map((b) => `<img src="${b.thumb}" alt="">`).join('');
    $('#paddockRunBtn').disabled = false;
    $('#paddockStatus').textContent = `${paddockBlocks.length} 枚`;
  } catch (e) { $('#paddockStatus').textContent = e.message; }
  ev.target.value = '';
});

$('#paddockRunBtn').addEventListener('click', async () => {
  const btn = $('#paddockRunBtn');
  btn.disabled = true;
  $('#paddockStatus').innerHTML = '<span class="spin"></span>評価中…';
  try {
    const horses = race.entries.filter((e) => !e.scratched && e.horse).map((e) => ({ no: e.no, horse: e.horse }));
    const tv = $('#paddockTarget').value;
    const target = tv === 'all' ? null : horses.find((h) => String(h.no) === tv);
    const res = await ai.evaluatePaddock(aiSettings(), paddockBlocks.map((b) => b.block), horses, target);
    let n = 0;
    for (const r of res) {
      const no = target ? target.no : num(r.no);
      const e = race.entries.find((x) => x.no === no);
      if (!e || !valid(num(r.score))) continue;
      e.aiPaddock = Math.max(1, Math.min(5, Math.round(num(r.score))));
      e.aiComment = [r.comment, (r.good || []).length ? `◯ ${(r.good || []).join('、')}` : '', (r.bad || []).length ? `△ ${(r.bad || []).join('、')}` : ''].filter(Boolean).join(' / ');
      n++;
    }
    await saveRace(); renderCard();
    $('#paddockStatus').textContent = n ? `${n} 頭を評価しました` : '評価できる馬が見つかりませんでした';
    $('#paddockResult').innerHTML = renderPaddockNotes();
  } catch (e) {
    $('#paddockStatus').textContent = `エラー：${e.message}`;
  } finally { btn.disabled = false; }
});

function renderPaddockNotes() {
  if (!race) return '';
  const list = race.entries.filter((e) => valid(e.aiPaddock) || e.paddock);
  if (!list.length) return '';
  return `<div class="table-wrap"><table class="mini"><thead><tr><th>番</th><th>馬名</th><th>自分</th><th>AI</th><th>コメント</th></tr></thead><tbody>
    ${list.map((e) => `<tr><td>${e.no}</td><td>${escapeHTML(e.horse)}</td><td>${e.paddock || ''}</td><td>${valid(e.aiPaddock) ? '★'.repeat(e.aiPaddock) : ''}</td><td class="left">${escapeHTML(e.aiComment || '')}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// ---------------- 予想 ----------------
$('#modeSeg').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-mode]');
  if (!b) return;
  S.mode = b.dataset.mode; save(); renderMode();
  if ($('#predictOut').innerHTML) runPredict();
});
function renderMode() { $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode)); }

$('#predictBtn').addEventListener('click', runPredict);

async function runPredict() {
  await saveRace();
  const all = await getAll();
  const hist = all.filter((r) => r.date < race.date && isFinished(r)).length;
  const pr = predictRace(race, all, S.weights, S.mode);
  if (!pr) { $('#predictOut').innerHTML = '<p class="hint">出走表に 2 頭以上入力してください。</p>'; return; }
  $('#predictStatus').textContent = `参考にした過去レース：${hist} 件${hist < 50 ? '（少ないため精度は低め。過去データを増やしてください）' : ''}`;
  const rows = pr.rows.slice().sort((a, b) => (a.e.no || 0) - (b.e.no || 0));
  const markOrder = { '◎': 0, '○': 1, '▲': 2, '△': 3, '☆': 4 };
  const ranked = pr.rows.filter((r) => r.mark).sort((a, b) => markOrder[a.mark] - markOrder[b.mark] || b.p - a.p);
  const maxP = Math.max(...pr.rows.map((r) => r.p));
  const res = isFinished(race);
  $('#predictOut').innerHTML = `
    <div class="marks">${ranked.map((r) => `<div class="mk m-${markClass(r.mark)}"><b>${r.mark}</b><span class="no f${r.e.frame || ''}">${r.e.no}</span>${escapeHTML(r.e.horse)}<small>${pct(r.p)}${valid(r.odds) ? ` / ${r.odds}倍` : ''}</small></div>`).join('')}</div>
    <div class="table-wrap"><table class="pred">
      <thead><tr><th>印</th><th>番</th><th class="left">馬名</th><th>勝率</th><th>3着内率</th><th>人気</th><th>単勝</th><th title="勝率 × 単勝オッズ。1.0 を超えると理屈の上では得">期待値</th><th class="left">プラス材料</th><th class="left">マイナス材料</th>${res ? '<th>着順</th>' : ''}</tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.mark ? 'marked' : ''}${r.longshot ? ' long' : ''}">
        <td class="mk-cell m-${markClass(r.mark)}">${r.mark}</td>
        <td><span class="no f${r.e.frame || ''}">${r.e.no}</span></td>
        <td class="left"><a href="#" data-horse="${escapeHTML(r.e.horse)}">${escapeHTML(r.e.horse)}</a>${r.longshot ? ' <span class="tag ana">穴</span>' : ''}</td>
        <td><div class="bar"><i style="width:${(r.p / maxP) * 100}%"></i><span>${pct(r.p)}</span></div></td>
        <td>${pct(r.p3, 0)}</td><td>${valid(r.pop) ? r.pop : '—'}</td><td>${fmt(r.odds)}</td>
        <td class="${r.ev >= 1 ? 'pos' : ''}">${fmt(r.ev, 2)}</td>
        <td class="left small">${r.plus.join('・')}</td><td class="left small neg">${r.minus.join('・')}</td>
        ${res ? `<td>${r.e.finish || ''}</td>` : ''}</tr>`).join('')}
      </tbody></table></div>
    <h3>買い目の目安（${S.mode === 'ana' ? '穴狙い' : '的中重視'}）</h3>
    <div class="bets">${pr.bets.map((b) => `<div class="bet${b.ana ? ' ana' : ''}"><span class="bt">${b.type}</span><span class="bp">${b.pick}</span><span class="bpr">的中率の目安 ${pct(Math.min(1, b.prob), 0)}${valid(b.ev) ? `・期待値 ${b.ev.toFixed(2)}` : ''}</span></div>`).join('') || '<p class="hint">買い目を出せませんでした</p>'}</div>
    <p class="hint">勝率は過去データから学習した重みで計算した推定値です。期待値はオッズが入っているときだけ出ます（締切前はオッズが変わるので、最新のオッズを入れ直すと正確になります）。「穴」は人気薄（5 番人気以下）なのに能力評価が上位、または期待値が高い馬です。</p>`;
  $('#predictOut').querySelectorAll('[data-horse]').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault(); showHorse(a.dataset.horse, pr);
  }));
}
const markClass = (m) => ({ '◎': 'hon', '○': 'tai', '▲': 'tan', '△': 'ren', '☆': 'ana' }[m] || 'none');

function showHorse(name, pr) {
  const e = race.entries.find((x) => x.horse === name);
  const hist = pr.history(name).slice().reverse();
  const paper = (e?.pastRuns || []).filter((p) => !hist.some((h) => h.date === p.date));
  $('#horseDlgTitle').textContent = name;
  $('#horseDlgBody').innerHTML = `
    ${e?.aiComment ? `<p class="hint">パドック(AI)：${escapeHTML(e.aiComment)}</p>` : ''}
    ${hist.length || paper.length ? `<div class="table-wrap"><table class="mini"><thead><tr><th>日付</th><th>場</th><th>コース</th><th>馬場</th><th>着順</th></tr></thead><tbody>
    ${hist.map((h) => `<tr><td>${h.date}</td><td>${escapeHTML(venueName('JRA', h.venue) !== h.venue ? venueName('JRA', h.venue) : venueName('NAR', h.venue))}</td><td>${h.surface}${h.distance}</td><td>${h.condition}</td><td>${h.finish}</td></tr>`).join('')}
    ${paper.map((h) => `<tr class="paper"><td>${h.date}</td><td>${escapeHTML(h.venue || '')}</td><td>${h.surface || ''}${h.distance || ''}</td><td>${h.condition || ''}</td><td>${h.finish ?? ''}${h.field ? `/${h.field}` : ''}</td></tr>`).join('')}
    </tbody></table></div>${paper.length ? '<p class="hint">色付きの行は新聞・Web から読み取った過去走</p>' : ''}` : '<p class="hint">過去の出走データがありません（初出走、またはデータ未登録）。</p>'}`;
  $('#horseDlg').showModal();
}

// ---------------- 過去データ ----------------
async function renderData() {
  const all = await getAll();
  const done = all.filter(isFinished);
  const horses = new Set(); for (const r of done) for (const e of r.entries) horses.add(e.horse);
  const dates = done.map((r) => r.date).sort();
  const byVenue = {};
  for (const r of done) { const k = `${CENTER_LABEL[r.center]}・${venueName(r.center, r.venue)}`; byVenue[k] = (byVenue[k] || 0) + 1; }
  $('#dataStats').innerHTML = `
    <div class="stat"><b>${done.length}</b><span>結果ありレース</span></div>
    <div class="stat"><b>${all.length - done.length}</b><span>結果待ちレース</span></div>
    <div class="stat"><b>${horses.size}</b><span>頭</span></div>
    <div class="stat"><b>${dates.length ? `${dates[0]}〜${dates[dates.length - 1]}` : '—'}</b><span>期間</span></div>
    <div class="venues">${Object.entries(byVenue).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span>${k} ${v}</span>`).join('')}</div>`;
  const day = all.filter((r) => r.date === S.date).sort((a, b) => a.center.localeCompare(b.center) || a.venue.localeCompare(b.venue) || a.raceNo - b.raceNo);
  $('#dayList').innerHTML = day.length ? `<div class="day-list">${day.map((r) => `<button type="button" data-goto="${r.id}">${CENTER_LABEL[r.center]}・${venueName(r.center, r.venue)} ${r.raceNo}R <small>${r.entries.length}頭${isFinished(r) ? '・結果あり' : ''}</small></button>`).join('')}</div>`
    : `<p class="hint">${S.date} のレースはまだありません。</p>`;
}

$('#dayList').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-goto]');
  if (!b) return;
  const r = (await getAll()).find((x) => x.id === b.dataset.goto);
  if (!r) return;
  Object.assign(S, { center: r.center, venue: r.venue, date: r.date, raceNo: r.raceNo }); save();
  renderSelector(); await loadRace(); switchTab('card');
});

$('#csvFile').addEventListener('change', async (ev) => {
  let total = 0;
  for (const f of ev.target.files) {
    const buf = await f.arrayBuffer();
    // Shift_JIS の CSV（Excel 由来）にも対応
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('shift_jis').decode(buf);
    const races = csvToRaces(text.replace(/^﻿/, ''));
    total += await store.mergeRaces(races);
  }
  ev.target.value = '';
  invalidate();
  toast(total ? `${total} レースを取り込みました` : '取り込めるレースがありませんでした。列名を確認してください');
  renderData(); loadRace();
});

function download(name, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('#csvExportBtn').addEventListener('click', async () => {
  const all = (await getAll()).sort((a, b) => a.id.localeCompare(b.id));
  download(`keiba-${today()}.csv`, racesToCSV(all, venueName));
});
$('#csvTemplateBtn').addEventListener('click', () => {
  download('keiba-template.csv', `${COLUMNS.map((c) => c[1]).join(',')}\n2026-11-01,中央,東京,11,天皇賞,芝,2000,良,G1,1,1,サンプルホース,牡4,58,騎手名,調教師名,480,+2,3.5,1,2,1:57.8,33.9,1.4\n`);
});
$('#demoBtn').addEventListener('click', async () => {
  if (!confirm('架空の馬・騎手で約 60 日分のデモデータを作ります（東京・京都・大井・園田）。よろしいですか？')) return;
  const races = makeDemo({ days: 60, today: S.date, seed: Date.now() % 100000 });
  await store.putRaces(races);
  invalidate();
  toast(`${races.length} レースのデモデータを作りました`);
  if (!['tokyo', 'kyoto', 'ooi', 'sonoda'].includes(S.venue)) { S.center = 'JRA'; S.venue = 'tokyo'; save(); renderSelector(); }
  renderData(); loadRace();
});
$('#clearBtn').addEventListener('click', async () => {
  if (!confirm('保存されているすべてのレースを削除します。元に戻せません。よろしいですか？')) return;
  await store.clearRaces(); invalidate(); toast('削除しました'); renderData(); loadRace();
});

// ---------------- 検証・学習 ----------------
async function runBacktest(learn) {
  $('#btStatus').innerHTML = '<span class="spin"></span>計算中…';
  $('#applyWBtn').disabled = true;
  await new Promise((r) => setTimeout(r, 30));
  const all = await getAll();
  const t0 = performance.now();
  const bt = backtest(all, S.weights, { learn });
  if (bt.error) { $('#btStatus').textContent = bt.error; $('#btOut').innerHTML = ''; return; }
  $('#btStatus').textContent = `学習 ${bt.nTrain} レース / 検証 ${bt.nTest} レース（${bt.from}〜${bt.to}）・${Math.round(performance.now() - t0)}ms`;
  if (learn) { learnedWeights = bt.weights; $('#applyWBtn').disabled = false; }
  const P = (x) => (valid(x) ? `${x.toFixed(1)}%` : '—');
  const H = bt.hit, A = bt.ana, B = bt.baseline;
  const better = (a, b) => (valid(a) && valid(b) ? (a > b ? 'pos' : a < b ? 'neg' : '') : '');
  $('#btOut').innerHTML = `
    <div class="table-wrap"><table class="bt">
      <thead><tr><th class="left">検証期間の成績</th><th>的中重視</th><th>穴狙い</th><th>1番人気を買う</th></tr></thead>
      <tbody>
        <tr><td class="left">◎の勝率（単勝的中率）</td><td class="${better(H.winRate, B.winRate)}">${P(H.winRate)}</td><td>${P(A.winRate)}</td><td>${P(B.winRate)}</td></tr>
        <tr><td class="left">◎の3着内率（複勝的中率）</td><td class="${better(H.top3Rate, B.top3Rate)}">${P(H.top3Rate)}</td><td>${P(A.top3Rate)}</td><td>${P(B.top3Rate)}</td></tr>
        <tr><td class="left">◎の単勝回収率</td><td class="${better(H.winROI, B.winROI)}">${P(H.winROI)}</td><td>${P(A.winROI)}</td><td>${P(B.winROI)}</td></tr>
        <tr><td class="left">◎の複勝回収率</td><td>${P(H.placeROI)}</td><td>${P(A.placeROI)}</td><td>—</td></tr>
        <tr><td class="left">馬連 ◎-○ 的中率</td><td>${P(H.quinellaRate)}</td><td>${P(A.quinellaRate)}</td><td>—</td></tr>
        <tr><td class="left">三連複（印の馬で）的中率</td><td>${P(H.trioRate)}</td><td>${P(A.trioRate)}</td><td>—</td></tr>
        <tr><td class="left">☆穴馬：対象レース数</td><td>${H.anaN}</td><td>${A.anaN}</td><td>—</td></tr>
        <tr><td class="left">☆穴馬の勝率 / 3着内率</td><td>${P(H.anaWinRate)} / ${P(H.anaTop3Rate)}</td><td>${P(A.anaWinRate)} / ${P(A.anaTop3Rate)}</td><td>—</td></tr>
        <tr><td class="left">☆穴馬の単勝回収率</td><td>${P(H.anaROI)}</td><td>${P(A.anaROI)}</td><td>—</td></tr>
      </tbody></table></div>
    <p class="hint">回収率 100% 超えは利益が出た状態です。検証レース数が少ないと、穴馬の回収率は 1 回の大当たりで大きくぶれます（数百レース以上で判断してください）。</p>
    ${learn ? `<h3>学習した重み</h3><div class="wlist">${FEATURES.map((f) => `<span>${f.label} <b class="${bt.weights[f.key] >= 0 ? 'pos' : 'neg'}">${bt.weights[f.key].toFixed(2)}</b></span>`).join('')}</div>
      <p class="hint">「学習した重みを使う」で予想に反映します（全データで学習し直します）。パドック・新聞の印は、過去データに記録がないと 0 のままです。</p>` : ''}`;
}
$('#btRunBtn').addEventListener('click', () => runBacktest(false));
$('#btLearnBtn').addEventListener('click', () => runBacktest(true));
$('#applyWBtn').addEventListener('click', async () => {
  if (!learnedWeights) return;
  // 検証用には前半だけで学習したが、使うときは全データで学習し直す
  const all = await getAll();
  const w = learnAll(all, S.weights) || learnedWeights;
  // パドック・新聞の印は過去データにないことが多いので、学習で 0 になったら初期値を残す
  for (const k of ['paddock', 'paper']) if (!w[k]) w[k] = S.weights[k] || DEFAULT_WEIGHTS[k];
  S.weights = w; save(); renderWeights();
  toast('学習した重みを予想に使います');
});
$('#resetWBtn').addEventListener('click', () => { S.weights = { ...DEFAULT_WEIGHTS }; save(); renderWeights(); toast('初期値に戻しました'); });

function renderWeights() {
  $('#weightsBox').innerHTML = FEATURES.map((f) => `<label class="wrow"><span>${f.label}</span>
    <input type="range" min="-1" max="2" step="0.01" value="${S.weights[f.key]}" data-w="${f.key}"><output>${Number(S.weights[f.key]).toFixed(2)}</output></label>`).join('');
}
$('#weightsBox').addEventListener('input', (ev) => {
  const r = ev.target.closest('[data-w]');
  if (!r) return;
  S.weights[r.dataset.w] = Number(r.value);
  r.nextElementSibling.textContent = Number(r.value).toFixed(2);
  save();
});

// ---------------- 設定 ----------------
function renderSettings() {
  $('#apiKey').value = S.apiKey || '';
  $('#aiModel').value = S.aiModel;
  $('#aiEffort').value = S.aiEffort;
  $('#ghRepo').value = S.ghRepo || '';
  $('#ghToken').value = S.ghToken || '';
  $('#ghAuto').checked = S.ghAuto !== false;
}
$('#apiKey').addEventListener('change', () => { S.apiKey = $('#apiKey').value.trim(); save(); toast('保存しました'); });
$('#aiModel').addEventListener('change', () => { S.aiModel = $('#aiModel').value; save(); });
$('#aiEffort').addEventListener('change', () => { S.aiEffort = $('#aiEffort').value; save(); });
$('#ghRepo').addEventListener('change', () => { S.ghRepo = $('#ghRepo').value.trim(); save(); remoteLoaded.clear(); });
$('#ghToken').addEventListener('change', () => { S.ghToken = $('#ghToken').value.trim(); save(); remoteLoaded.clear(); toast('保存しました'); });
$('#ghAuto').addEventListener('change', () => { S.ghAuto = $('#ghAuto').checked; save(); });
$('#ghTestBtn').addEventListener('click', async () => {
  S.ghRepo = $('#ghRepo').value.trim(); S.ghToken = $('#ghToken').value.trim(); save();
  const st = $('#ghTestStatus');
  if (!remote.isConfigured(S)) { st.textContent = 'リポジトリ（例 umenii/keiba）とトークンを入力してください'; return; }
  st.innerHTML = '<span class="spin"></span>確認中…';
  try {
    const idx = await remote.loadIndex(S);
    const dates = Object.keys(idx.dates || {}).sort();
    let run = '';
    try { const r = await remote.lastRun(S); if (r) run = `・直近の収集 ${r.at.replace('T', ' ').slice(0, 16)}（${r.conclusion || r.status}）`; } catch { run = '・収集の状況は見られません（Actions の権限なし）'; }
    st.textContent = `接続できました：${dates.length} 日分のデータ${dates.length ? `（${dates[0]}〜${dates[dates.length - 1]}）` : ''}${run}`;
  } catch (e) { st.textContent = `接続できません：${e.message}`; }
});

// ---------------- タブ・選択 ----------------
function switchTab(t) {
  S.tab = t; save();
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $$('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== `tab-${t}`));
  if (t === 'data') renderData();
  if (t === 'predict' && race.entries.length >= 2) runPredict();
}
$('#tabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tab]'); if (b) switchTab(b.dataset.tab); });

$('#centerSeg').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-center]');
  if (!b || b.dataset.center === S.center) return;
  saveRaceIfDirty();
  S.center = b.dataset.center; S.venue = VENUES[S.center][0].id; save();
  renderSelector(); loadRace();
});
$('#venueSel').addEventListener('change', () => { saveRaceIfDirty(); S.venue = $('#venueSel').value; save(); loadRace(); });
$('#dateInp').addEventListener('change', () => { if (!$('#dateInp').value) return; saveRaceIfDirty(); S.date = $('#dateInp').value; save(); loadRace(); });
$('#todayBtn').addEventListener('click', () => { saveRaceIfDirty(); S.date = today(); save(); renderSelector(); loadRace(); });
$('#raceBtns').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-race]');
  if (!b) return;
  saveRaceIfDirty();
  S.raceNo = Number(b.dataset.race); save(); loadRace();
  if (S.tab === 'predict') setTimeout(() => race && race.entries.length >= 2 && runPredict(), 50);
});
function saveRaceIfDirty() { if (saveTimer) saveRace(); }

// ---------------- 起動 ----------------
(async function init() {
  renderSelector(); renderMode(); renderWeights(); renderSettings();
  await loadRace();
  switchTab(S.tab || 'card');
})();
