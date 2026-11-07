// 競馬場の一覧（中央 = JRA、地方 = NAR）
export const VENUES = {
  JRA: [
    { id: 'sapporo', name: '札幌' }, { id: 'hakodate', name: '函館' },
    { id: 'fukushima', name: '福島' }, { id: 'niigata', name: '新潟' },
    { id: 'tokyo', name: '東京' }, { id: 'nakayama', name: '中山' },
    { id: 'chukyo', name: '中京' }, { id: 'kyoto', name: '京都' },
    { id: 'hanshin', name: '阪神' }, { id: 'kokura', name: '小倉' },
  ],
  NAR: [
    { id: 'obihiro', name: '帯広(ばんえい)' }, { id: 'monbetsu', name: '門別' },
    { id: 'morioka', name: '盛岡' }, { id: 'mizusawa', name: '水沢' },
    { id: 'urawa', name: '浦和' }, { id: 'funabashi', name: '船橋' },
    { id: 'ooi', name: '大井' }, { id: 'kawasaki', name: '川崎' },
    { id: 'kanazawa', name: '金沢' }, { id: 'kasamatsu', name: '笠松' },
    { id: 'nagoya', name: '名古屋' }, { id: 'sonoda', name: '園田' },
    { id: 'himeji', name: '姫路' }, { id: 'kochi', name: '高知' },
    { id: 'saga', name: '佐賀' },
  ],
};

export const CENTER_LABEL = { JRA: '中央', NAR: '地方' };

export function venueName(center, id) {
  const v = (VENUES[center] || []).find((x) => x.id === id);
  return v ? v.name : id;
}

// 名前（「東京」「大井」など）から競馬場を探す。CSV や新聞の読み取りで使う
export function findVenueByName(name) {
  if (!name) return null;
  const n = String(name).trim();
  for (const center of ['JRA', 'NAR']) {
    for (const v of VENUES[center]) {
      if (v.id === n || v.name === n || v.name.startsWith(n) || n.startsWith(v.name.replace(/\(.*\)/, ''))) {
        return { center, id: v.id };
      }
    }
  }
  return null;
}

export const SURFACES = ['芝', 'ダ', '障'];
export const CONDITIONS = ['良', '稍重', '重', '不良'];
export const MAX_RACES = 12;
