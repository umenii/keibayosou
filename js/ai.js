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

async function ask({ apiKey, model, effort }, content, system) {
  if (!apiKey) throw new Error('設定タブで Anthropic の API キーを入力してください');
  const Anthropic = await loadSDK();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const res = await client.beta.messages.create({
    model: model || DEFAULT_MODEL,
    max_tokens: 16000,
    output_config: { effort: effort || 'medium' },
    // 安全上の理由で断られたときは、サーバー側で別モデルに切り替えて続行する
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason === 'refusal') throw new Error('AI が読み取りを断りました。別の写真で試してください');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return parseJSON(text);
}

function parseJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
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
                      "finish": 着順, "field": 頭数, "pop": 人気, "last3f": 上がり3F秒 } ] }
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
