// 写真・動画の読み取り（Claude API）
// 競馬新聞の写真から出走表と印を読み取り、パドックの写真・動画から馬の状態を評価する。
// API キーはこの端末のブラウザ内（localStorage）にだけ保存され、Anthropic の API にだけ送られる。

let sdkPromise = null;
function loadSDK() {
  // ビルド不要で使えるよう、公式 SDK を ES モジュールとして読み込む
  if (!sdkPromise) sdkPromise = import('https://esm.sh/@anthropic-ai/sdk@latest').then((m) => m.default || m.Anthropic);
  return sdkPromise;
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

// 料金の目安（100 万トークンあたりのドル。入力 / 出力）
const PRICE = {
  'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20], 'claude-fable-5-1': [10, 50],
};
const YEN_PER_USD = 150;

export function costYen(model, usage) {
  const [pi, po] = PRICE[model] || PRICE[DEFAULT_MODEL];
  const usd = (usage.input * pi + usage.output * po) / 1e6 + usage.searches * 0.01;
  return Math.round(usd * YEN_PER_USD * 10) / 10;
}

function newUsage() { return { input: 0, output: 0, searches: 0 }; }
function addUsage(u, r) {
  const x = r.usage || {};
  u.input += (x.input_tokens || 0) + (x.cache_read_input_tokens || 0) + (x.cache_creation_input_tokens || 0);
  u.output += x.output_tokens || 0;
  u.searches += x.server_tool_use?.web_search_requests || 0;
}

// Claude に 1 回問い合わせる。Web 検索・取得を使うときは tools を渡す。
// サーバー側のツールが長引くと pause_turn で返るので、続きを頼む
async function ask({ apiKey, model, effort }, content, system, { tools, usage } = {}) {
  if (!apiKey) throw new Error('設定タブで Anthropic の API キーを入力してください');
  const Anthropic = await loadSDK();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const messages = [{ role: 'user', content }];
  const u = usage || newUsage();
  for (let turn = 0; turn < 6; turn++) {
    const res = await client.beta.messages.stream({
      model: model || DEFAULT_MODEL,
      max_tokens: 32000,
      output_config: { effort: effort || 'medium' },
      // 安全上の理由で断られたときは、サーバー側で別モデルに切り替えて続行する
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      ...(tools ? { tools } : {}),
      messages,
    }).finalMessage();
    addUsage(u, res);
    if (res.stop_reason === 'refusal') throw new Error('AI が処理を断りました');
    if (res.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: res.content });
      continue;
    }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return parseJSON(text);
  }
  throw new Error('時間がかかりすぎたため中断しました');
}

function parseJSON(text) {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  const body = fences.length ? fences[fences.length - 1][1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start < 0 || end < start) throw new Error('AI の返答を読み取れませんでした');
  return JSON.parse(body.slice(start, end + 1));
}

// ---- 画像の準備 ----
const MAX_EDGE = 1568;

function canvasToBlock(canvas) {
  const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } };
}

function drawScaled(src, w, h, maxEdge = MAX_EDGE) {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export async function imageFileToBlock(file, maxEdge) {
  const bmp = await createImageBitmap(file);
  const c = drawScaled(bmp, bmp.width, bmp.height, maxEdge);
  bmp.close?.();
  return { block: canvasToBlock(c), thumb: c.toDataURL('image/jpeg', 0.6) };
}

// 動画から等間隔に count 枚のフレームを切り出す
export function videoFileToBlocks(file, count = 6, maxEdge = 1024) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    const out = [];
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('動画を読み込めませんでした')); };
    v.onloadedmetadata = async () => {
      try {
        const dur = v.duration || 1;
        for (let i = 0; i < count; i++) {
          const t = Math.min(dur - 0.05, (dur * (i + 0.5)) / count);
          await new Promise((res) => { v.onseeked = res; v.currentTime = t; });
          const c = drawScaled(v, v.videoWidth, v.videoHeight, maxEdge);
          out.push({ block: canvasToBlock(c), thumb: c.toDataURL('image/jpeg', 0.5) });
        }
        URL.revokeObjectURL(url);
        resolve(out);
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
  });
}

export async function filesToBlocks(files, framesPerVideo = 6) {
  const out = [];
  for (const f of files) {
    if (f.type.startsWith('video/')) out.push(...await videoFileToBlocks(f, framesPerVideo));
    else out.push(await imageFileToBlock(f));
  }
  return out;
}

// ---- 競馬新聞の読み取り ----
const PAPER_SYSTEM = `あなたは競馬新聞（馬柱・出馬表）を正確に書き起こすアシスタントです。
写真に写っている文字だけを使い、読めない値は null にしてください。推測で埋めないでください。
返答は JSON だけを出力してください。`;

export async function readNewspaper(settings, blocks, hint) {
  const content = [
    ...blocks,
    { type: 'text', text: `この競馬新聞の写真から、1 レース分の出走表と、記者の予想印を読み取ってください。
${hint ? `参考情報: ${hint}\n` : ''}
次の形の JSON で返してください。
{
  "race": { "date": "YYYY-MM-DD または null", "venue": "競馬場名 または null", "raceNo": 数値 または null,
            "name": "レース名", "surface": "芝|ダ|障", "distance": 数値, "condition": "良|稍重|重|不良 または null" },
  "entries": [
    { "no": 馬番, "frame": 枠番, "horse": "馬名", "sexAge": "牡3 など", "weight": 斤量,
      "jockey": "騎手", "trainer": "調教師", "odds": 予想オッズまたは単勝オッズ(なければ null), "pop": 人気(なければ null),
      "marks": "記者ごとの印を左から順に並べた文字列。◎○▲△☆注 を使い、印なしは -（例: \\"◎○-△\\"）",
      "pastRuns": [ { "date": "YYYY-MM-DD", "venue": "競馬場", "surface": "芝|ダ", "distance": 数値, "condition": "良など",
                      "finish": 着順, "field": 頭数, "pop": 人気, "last3f": 上がり3F秒, "last3fRank": 上がり順位 } ] }
  ],
  "notes": "読み取りで自信がない箇所や、写真から分かる補足（短く）"
}
pastRuns は馬柱に過去走が載っている場合だけ、読める範囲で入れてください。` },
  ];
  return ask(settings, content, PAPER_SYSTEM);
}

// ---- パドック評価 ----
const PADDOCK_SYSTEM = `あなたは競馬のパドック解説者です。写真・動画のフレームから見える馬の状態だけを評価します。
見えない点は推測しないでください。返答は JSON だけを出力してください。`;

const CRITERIA = `評価の観点: 毛ヅヤ・皮膚の張り、トモ（後躯）の張りと踏み込み、歩様の力強さとリズム、
首の使い方、落ち着き（入れ込み・チャカつき・テンション）、発汗（首・股間の白い汗）、腹回り（太め・細め）、耳の向き・目つき。`;

// horses: [{ no, horse }]  画像に写っている馬を、ゼッケン番号で見分けて評価する
export async function evaluatePaddock(settings, blocks, horses, target) {
  const list = horses.map((h) => `${h.no}番 ${h.horse}`).join('、');
  const content = [
    ...blocks,
    { type: 'text', text: `${target ? `この画像は ${target.no}番 ${target.horse} のパドックの様子です。` : `パドックの写真・動画のフレームです。出走馬: ${list}。ゼッケンの番号で馬を見分けてください。`}
${CRITERIA}
写っている馬ごとに、次の形の JSON 配列で返してください（番号が判別できない馬は含めない）。
[ { "no": 馬番, "score": 1〜5 の整数（5=非常に良い、3=普通、1=不安あり）,
    "good": ["良い点（短く）"], "bad": ["気になる点（短く）"], "comment": "ひとことコメント" } ]` },
  ];
  const r = await ask(settings, content, PADDOCK_SYSTEM);
  return Array.isArray(r) ? r : (r.horses || [r]);
}

// ---- Web からレース情報を取得 ----
export const DEFAULT_WEB_DOMAINS = ['netkeiba.com', 'jra.go.jp', 'keiba.go.jp'];

// netkeiba の競馬場コード（URL の候補を作るため）
const NK_JRA = { sapporo: '01', hakodate: '02', fukushima: '03', niigata: '04', tokyo: '05', nakayama: '06', chukyo: '07', kyoto: '08', hanshin: '09', kokura: '10' };
const NK_NAR = { obihiro: '65', monbetsu: '30', morioka: '35', mizusawa: '36', urawa: '42', funabashi: '43', ooi: '44', kawasaki: '45', kanazawa: '46', kasamatsu: '47', nagoya: '48', sonoda: '50', himeji: '51', kochi: '54', saga: '55' };

function candidateUrls(race, kind, domains) {
  if (!domains.some((d) => 'netkeiba.com'.endsWith(d) || d.endsWith('netkeiba.com'))) return [];
  const ymd = race.date.replace(/-/g, '');
  const rr = String(race.raceNo).padStart(2, '0');
  const page = kind === 'result' ? 'result' : 'shutuba_past';
  if (race.center === 'NAR' && NK_NAR[race.venue]) {
    const id = `${ymd.slice(0, 4)}${NK_NAR[race.venue]}${ymd.slice(4)}${rr}`;
    return [`https://nar.netkeiba.com/race/${page}.html?race_id=${id}`];
  }
  if (race.center === 'JRA' && NK_JRA[race.venue]) {
    return [
      `https://race.netkeiba.com/top/race_list_sub.html?kaisai_date=${ymd}`,
      `（race_id は 年4桁 + 場コード${NK_JRA[race.venue]} + 回2桁 + 日目2桁 + レース番号2桁。一覧ページのリンクで確認）`,
      `https://race.netkeiba.com/race/${page}.html?race_id=<race_id>`,
    ];
  }
  return [];
}

const WEB_SYSTEM = `あなたは競馬のレース情報をウェブページから正確に書き写すアシスタントです。
ページに書かれている値だけを使い、見つからない値は null にしてください。推測で埋めないでください。
ログインが必要なページや有料のページは使わないでください。
作業が終わったら、最後に JSON だけを \`\`\`json のコードブロックで出力してください。`;

// kind: 'card'（出走表と各馬の近走） | 'result'（着順・確定オッズ・払戻）
export async function fetchRaceFromWeb(settings, race, kind, { venueLabel, centerLabel, domains, usage } = {}) {
  const doms = (domains && domains.length ? domains : DEFAULT_WEB_DOMAINS);
  const urls = candidateUrls(race, kind, doms);
  const [y, m, d] = race.date.split('-').map(Number);
  const what = kind === 'result'
    ? 'このレースの結果（全馬の着順・タイム・上がり3F・確定単勝オッズ・人気・馬体重、複勝の払戻）'
    : 'このレースの出馬表（全出走馬）と、各馬の近走成績（馬柱。新しい順に最大5走）';
  const text = `${centerLabel}競馬 ${venueLabel} ${y}年${m}月${d}日 ${race.raceNo}R の${what}を、ウェブで調べて書き写してください。
${urls.length ? `まず次のページを試してください（URL は候補です。開けない・違うレースのときは検索してください）:\n${urls.join('\n')}\n` : ''}
日付・競馬場・レース番号が一致するページだけを使ってください。そのレースが見つからない（開催がない等）ときは "found": false にしてください。

出力する JSON の形:
{
  "found": true,
  "race": { "date": "YYYY-MM-DD", "venue": "競馬場名", "raceNo": 数値, "name": "レース名", "raceClass": "クラス",
            "surface": "芝|ダ|障", "distance": 数値, "condition": "良|稍重|重|不良 または null", "startTime": "HH:MM" },
  "entries": [
    { "no": 馬番, "frame": 枠番, "horse": "馬名", "sexAge": "牡3 など", "weight": 斤量, "jockey": "騎手", "trainer": "調教師",
      "bodyWeight": 馬体重, "bodyDiff": 増減, "odds": 単勝オッズ, "pop": 人気,
${kind === 'result'
    ? `      "finish": 着順（数値。取消・除外・中止は "取消" などの文字）, "time": "1:34.5", "last3f": 上がり3F秒, "placeOdds": 複勝の払戻倍率（3着以内の馬だけ。100円あたりの払戻 ÷ 100） }`
    : `      "pastRuns": [ { "date": "YYYY-MM-DD", "venue": "競馬場名", "surface": "芝|ダ|障", "distance": 数値, "condition": "良など",
                      "finish": 着順, "field": 頭数, "pop": 人気, "jockey": "騎手", "last3f": 上がり3F秒, "last3fRank": 上がり順位 } ] }`}
  ],
  "sources": ["使ったページの URL"],
  "notes": "取れなかった項目など（短く）"
}`;
  const tools = [
    { type: 'web_fetch_20260209', name: 'web_fetch', allowed_domains: doms, max_uses: 8, max_content_tokens: 120000 },
    { type: 'web_search_20260209', name: 'web_search', allowed_domains: doms, max_uses: 4 },
  ];
  return ask(settings, text, WEB_SYSTEM, { tools, usage });
}

export { newUsage };
