// 카카오맵 장소 상세(panel3) 응답에서 영업시간·편의시설을 읽는 공용 함수
// (2026-11-02 재수집에 쓴 규칙과 같다: 요일별 영업시간·브레이크타임·라스트오더, 단체석·룸 등 좌석 옵션)

const DAYS = '월화수목금토일';

/** 'HH:MM' 문자열 비교용 */
const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function formatDays(chars) {
  const idx = [...new Set(chars)].map(c => DAYS.indexOf(c)).sort((a, b) => a - b);
  if (idx.length === 7) return '매일';
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (idx.length >= 3 && contiguous) return `${DAYS[idx[0]]}~${DAYS[idx[idx.length - 1]]}`;
  return idx.map(i => DAYS[i]).join('');
}

/**
 * 요일별 영업 정보를 앱의 영업시간 원문 형식으로 바꾼다.
 * 예: { hours: '월~금 11:00-15:00 17:00-21:00 / 토 11:00-15:00', closed: '일', lastOrder: { 월: '20:30' } }
 * 7일 정보가 다 없거나 24시간 등 해석할 수 없는 형식이면 null
 */
export function parseKakaoOpenHours(openHours) {
  const entries = [];
  for (const wp of openHours?.week_from_today?.week_periods || []) {
    for (const d of wp.days || []) entries.push({ ch: String(d.day_of_the_week_desc || ' ')[0], od: d.on_days || null });
  }
  return parseDayEntries(entries);
}

/**
 * 카카오맵 '기본 영업시간'(open_hours.all)으로 정기 영업시간을 읽는다.
 * 오늘부터 7일 정보(week_from_today)와 달리 이번 주 임시휴무가 섞이지 않는다.
 * 기본 영업시간 목록에 없는 요일은 정기 휴무로 본다. 정보가 없거나 해석할 수 없으면 null
 */
export function parseKakaoRegularHours(openHours) {
  const periods = openHours?.all?.periods || [];
  const basic = periods.find(p => p.period_title === '기본 영업시간');
  if (!basic || !(basic.days || []).length) return null;
  const byDay = new Map();
  for (const d of basic.days) {
    const label = String(d.day_of_the_week || '').trim();
    const chars = label === '매일' ? [...DAYS] : DAYS.includes(label) && label.length === 1 ? [label] : null;
    if (!chars || !d.on_days) return null;
    for (const ch of chars) byDay.set(ch, d.on_days);
  }
  return parseDayEntries([...DAYS].map(ch => ({ ch, od: byDay.get(ch) || null })));
}

function parseDayEntries(entries) {
  const byTime = new Map();
  const closed = [];
  const lastOrder = {};
  for (const { ch, od } of entries) {
    if (!DAYS.includes(ch)) continue;
    if (!od) {
      closed.push(ch);
      continue;
    }
    const m = /^(\d\d):(\d\d) ~ (\d\d):(\d\d)$/.exec(od.start_end_time_desc || '');
    if (!m) return null;
    const start = `${m[1]}:${m[2]}`;
    const end = `${m[3]}:${m[4]}`;
    if ((start === '00:00' && end === '00:00') || (start === '00:00' && end === '24:00')) return null;
    let segs = [[start, end]];
    for (const bt of od.break_times_desc || []) {
      const b = /^(\d\d:\d\d) ~ (\d\d:\d\d)/.exec(bt);
      if (!b) continue;
      const next = [];
      for (const [a, z] of segs) {
        if (toMin(a) < toMin(b[1]) && toMin(b[2]) < toMin(z)) next.push([a, b[1]], [b[2], z]);
        else next.push([a, z]);
      }
      segs = next;
    }
    const key = segs.map(([a, z]) => `${a}-${z}`).join(' ');
    if (!byTime.has(key)) byTime.set(key, []);
    byTime.get(key).push(ch);
    for (const lo of od.last_order_times_desc || []) {
      const x = /^(\d\d:\d\d)/.exec(lo);
      if (x) lastOrder[ch] = x[1];
    }
  }
  const counted = [...byTime.values()].reduce((s, v) => s + v.length, 0) + closed.length;
  if (!byTime.size || counted < 7) return null;
  const firstDay = chars => Math.min(...chars.map(c => DAYS.indexOf(c)));
  const hours = [...byTime.entries()]
    .sort((a, b) => firstDay(a[1]) - firstDay(b[1]))
    .map(([key, chars]) => `${formatDays(chars)} ${key}`)
    .join(' / ');
  const closedText = closed.length ? [...closed].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)).join(',') : '연중무휴';
  return { hours, closed: closedText, lastOrder };
}

/** 편의시설·좌석 옵션 표시(아이콘·상세 정보·AI 요약)를 모아 단체석·룸 등 여부를 돌려준다 */
export function parseKakaoFacilities(panel) {
  const words = new Set();
  const pai = panel?.place_add_info || {};
  for (const i of pai.ai_mate?.store_facility_icons || []) if (i.text) words.add(i.text);
  for (const i of pai.simple_detail_infos || []) if (i.text) words.add(i.text);
  for (const grp of pai.full_detail_infos || []) {
    for (const it of grp.items || []) {
      if (it.icon?.text) words.add(it.icon.text);
      for (const c of it.contents || []) if (c.label) words.add(c.label);
    }
  }
  for (const sh of panel?.ai_mate?.bottom_sheet?.sheets || []) {
    const lists = [sh, ...(sh.list || [])];
    for (const l of lists) {
      if (String(l.title || '').includes('좌석')) for (const k of l.keywords || []) words.add(k);
    }
  }
  const all = [...words];
  const parking = (words.has('주차가능') || words.has('주차 가능') || words.has('무료주차')) && !words.has('주차장없음');
  const parkingNote = (pai.ai_mate?.store_infos || []).find(i => i.title === '주차' && i.summary)?.summary;
  return {
    group: words.has('단체석'),
    room: words.has('프라이빗룸') || words.has('룸'),
    parking,
    freeParking: words.has('무료주차') || all.some(w => w.includes('주차') && w.includes('무료')),
    reserve: words.has('예약가능') || words.has('예약 가능'),
    takeout: words.has('포장가능') || words.has('포장 가능'),
    kidChair: words.has('유아의자') || words.has('유아의자 있음'),
    wheelchair: words.has('장애인 시설') || all.some(w => w.includes('휠체어')),
    parkingNote: parking && parkingNote ? String(parkingNote).slice(0, 120) : null
  };
}

/** 빌드 도구용 편의시설 기록: 있는 항목만 남긴다 (예: { group: true, parking: true, parkingNote: '…' }) */
export function compactFacilities(fac) {
  const out = {};
  for (const key of ['group', 'room', 'parking', 'freeParking', 'reserve', 'takeout', 'kidChair', 'wheelchair']) {
    if (fac[key]) out[key] = true;
  }
  if (fac.parkingNote) out.parkingNote = fac.parkingNote;
  return out;
}
