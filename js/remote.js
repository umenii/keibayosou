// 無料のデータ取得：GitHub の非公開リポジトリ（keiba）の data/ を読む。
// データは GitHub Actions（tools/collect.py）が Yahoo!スポーツナビ 競馬から 1 日 3 回集めている。
// 読み取りには、そのリポジトリだけを読める GitHub のトークン（Fine-grained token）が要る。

const API = 'https://api.github.com';

// スマホのキーボードで紛れやすい違い（全角文字・先頭の大文字・空白）を直す
export function cleanToken(t) {
  return String(t || '').normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]+/g, '')
    .replace(/^github_pat_/i, 'github_pat_').replace(/^gh([pousr])_/i, (m, c) => `gh${c.toLowerCase()}_`);
}
export function cleanRepo(r) {
  return String(r || '').normalize('NFKC').replace(/\s+/g, '')
    .replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
}
function cfg(s) {
  return { repo: cleanRepo(s.ghRepo), token: cleanToken(s.ghToken) };
}

export function isConfigured(s) {
  const { repo, token } = cfg(s);
  return /^[\w.-]+\/[\w.-]+$/.test(repo) && token.length > 10;
}

async function gh(s, path, opts = {}) {
  const { repo, token } = cfg(s);
  // iPad・iPhone の Safari でも通るよう、送るヘッダーは最小限にする（キャッシュ指定や独自ヘッダーを付けない）
  let res;
  try {
    res = await fetch(`${API}/repos/${repo}${path}`, {
      method: opts.method || 'GET',
      body: opts.body,
      headers: {
        Accept: opts.accept || (opts.method === 'POST' ? 'application/vnd.github+json' : 'application/vnd.github.raw+json'),
        Authorization: `Bearer ${token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (e) {
    throw new Error(`GitHub に接続できませんでした（${e.message}）。通信状況と、トークンに余計な文字が入っていないか確認してください`);
  }
  if (res.status === 404 && !opts.method) return null;
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* 本文なし */ }
    const msg = {
      401: 'トークンが正しくないか、期限切れです',
      403: 'トークンにこの操作の権限がありません（Contents：Read-only が必要。「今すぐ集める」は Actions：Read and write も必要）',
      404: 'リポジトリが見つかりません（「umenii/keiba」の綴りと、トークンの対象リポジトリに keiba を選んだか確認）',
    }[res.status] || 'GitHub のエラー';
    throw new Error(`${msg} [${res.status}${detail ? ` ${detail}` : ''}]`);
  }
  return res;
}

async function json(s, path) {
  const res = await gh(s, `/contents/${path}`);
  return res ? res.json() : null;
}

export async function loadIndex(s) {
  return (await json(s, 'data/index.json')) || { dates: {} };
}

// 1 日分のレース（アプリの形式）
export async function loadDate(s, date) {
  const d = await json(s, `data/races/${date}.json`);
  if (!d) return [];
  return (d.races || []).map(toApp);
}

function toApp(r) {
  return {
    id: r.id, date: r.date, center: r.center, venue: r.venue, raceNo: r.raceNo,
    name: [r.name, r.grade].filter(Boolean).join(' '), raceClass: r.raceClass || '',
    surface: r.surface || '芝', distance: r.distance || 0, condition: r.condition || '良',
    startTime: r.startTime || '', weather: r.weather || '',
    sources: r.source ? [r.source] : [], remote: true, remoteUpdated: r.updated || '',
    entries: (r.entries || []).map((e) => ({
      no: e.no, frame: e.frame, horse: e.horse || '', sexAge: e.sexAge || '', weight: e.weight,
      jockey: e.jockey || '', trainer: e.trainer || '', bodyWeight: e.bodyWeight, bodyDiff: e.bodyDiff,
      odds: e.odds, pop: e.pop, finish: e.finish, scratched: e.scratched || undefined,
      time: parseTime(e.time), last3f: e.last3f, placeOdds: e.placeOdds,
      pastRuns: e.pastRuns && e.pastRuns.length ? e.pastRuns : undefined,
    })),
  };
}

function parseTime(t) {
  const m = String(t || '').match(/^(?:(\d+):)?(\d{1,2})\.(\d)$/);
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) + Number(m[3]) / 10 : undefined;
}

// 今すぐ集める（GitHub Actions を手動で動かす）。トークンに Actions の書き込み権限が要る
export async function triggerCollect(s, { dates = '', from = '', to = '', horses = true } = {}) {
  await gh(s, '/actions/workflows/collect.yml/dispatches', {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { dates, from, to, horses: String(horses) } }),
  });
}

// 直近の収集の状況
export async function lastRun(s) {
  const res = await gh(s, '/actions/workflows/collect.yml/runs?per_page=1', { accept: 'application/vnd.github+json' });
  const d = res ? await res.json() : null;
  const r = d && d.workflow_runs && d.workflow_runs[0];
  return r ? { status: r.status, conclusion: r.conclusion, at: r.updated_at, url: r.html_url } : null;
}
