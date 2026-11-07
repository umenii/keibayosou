// 保存先：IndexedDB（過去データが多くても入るように）。設定は localStorage
const DB_NAME = 'keiba-yoso';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('races')) {
        const s = db.createObjectStore('races', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction('races', mode);
    const s = t.objectStore('races');
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export function raceId(date, center, venue, raceNo) {
  return `${date}_${center}_${venue}_${String(raceNo).padStart(2, '0')}`;
}

export const getRace = (id) => tx('readonly', (s) => reqP(s.get(id)));
export const putRace = (race) => tx('readwrite', (s) => { s.put(race); });
export const deleteRace = (id) => tx('readwrite', (s) => { s.delete(id); });
export const allRaces = () => tx('readonly', (s) => reqP(s.getAll()));
export const clearRaces = () => tx('readwrite', (s) => { s.clear(); });
export function putRaces(list) {
  return tx('readwrite', (s) => { for (const r of list) s.put(r); });
}

// 同じレースが既にあるときは、既存の情報（新聞の印・パドック評価）を残して結果を上書きする
export async function mergeRaces(list) {
  const existing = new Map((await allRaces()).map((r) => [r.id, r]));
  const merged = list.map((r) => {
    const old = existing.get(r.id);
    if (!old) return r;
    const byNo = new Map(old.entries.map((e) => [e.no, e]));
    return {
      ...old, ...r,
      entries: r.entries.map((e) => {
        const o = byNo.get(e.no) || {};
        return { ...o, ...stripEmpty(e) };
      }),
    };
  });
  await putRaces(merged);
  return merged.length;
}

function stripEmpty(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null && !(typeof v === 'number' && isNaN(v))) out[k] = v;
  return out;
}

// ---- 設定 ----
const SKEY = 'keiba-yoso-settings';
export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; }
}
export function saveSettings(s) {
  localStorage.setItem(SKEY, JSON.stringify(s));
}
