// 카카오맵 정기 재확인: 모든 식당의 카카오맵 장소 상세를 다시 읽어
//   (1) 장소 페이지가 사라졌는지(폐업·삭제 추정), 영업 표시가 아닌지
//   (2) 영업시간이 지금 자료와 달라졌는지
//   (3) 단체석·룸 표시가 지금 자료와 달라졌는지
// 를 확인하고, 확인된 식당 목록(confirmed)과 바뀐 점만 결과 파일에 적는다.
//
//   node tools/kakao-recheck.mjs [--out tools/kakao-recheck-latest.json] [--summary 요약.md] [--limit N]
//
// - 빌드 도구는 missing 식당을 공개 자료에서 빼고, 바뀐 영업시간·단체석 표시를 반영하며,
//   confirmed 식당의 단체정보 확인일을 재확인 날짜로 바꾼다 (6개월이 지나 '재확인 권장'이 한꺼번에 붙지 않도록).
// - 처음부터 있던 여수·순천·광양 166곳은 자동으로 빼지 않고 legacyMissing에만 적는다(사람이 확인).
// - 응답 실패가 20%를 넘거나, 바뀐 곳이 지나치게 많으면(20% 초과: 카카오맵 형식 변경 의심)
//   결과 파일을 바꾸지 않고 실패로 끝낸다.
// - GitHub Actions(.github/workflows/kakao-recheck.yml)가 한 달에 한 번 실행해 PR을 만든다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpeningHoursFromLegacy, expandStoredRegionDataset } from '../assets/releases/v2.0.0/js/data/normalize.js';
import { parseKakaoFacilities, parseKakaoOpenHours } from './kakao-place-parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT_PATH = path.resolve(ROOT_DIR, argValue('--out', 'tools/kakao-recheck-latest.json'));
const SUMMARY_PATH = argValue('--summary', null);
const LIMIT = Number(argValue('--limit', '0')) || 0;
const CONCURRENCY = 6;
const MAX_ERROR_RATE = 0.2;
const MAX_CHANGE_RATE = 0.2;

const isLegacyId = id => /^ysk-r-\d+$/.test(String(id));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function loadRestaurants() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data/manifest.json'), 'utf8'));
  const list = [];
  for (const meta of Object.values(manifest.regionFiles || {})) {
    const stored = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, meta.path), 'utf8'));
    for (const r of expandStoredRegionDataset(stored).restaurants) list.push(r);
  }
  return list;
}

async function fetchPanel(kakaoPlaceId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://place-api.map.kakao.com/places/panel3/${kakaoPlaceId}`, {
        headers: { pf: 'web', Referer: 'https://place.map.kakao.com/', 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
      });
      if (res.status === 404) return { status: 'missing' };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const status = body.summary?.status;
      return { status: status === 'Y' ? 'ok' : 'not_open', kakaoStatus: status ?? null, body };
    } catch (err) {
      await sleep(1500 * (attempt + 1));
      if (attempt === 2) return { status: 'error', error: String(err.message || err).slice(0, 80) };
    }
  }
  return { status: 'error' };
}

// 라스트오더는 비교에서 뺀 요일별 영업 구간
const intervalsKey = oh => JSON.stringify((oh?.weeklyIntervals || []).map(iv => [iv.day, iv.startTime, iv.endTime, iv.endDayOffset]));

function compare(rest, body) {
  const changes = {};
  const hours = parseKakaoOpenHours(body.open_hours);
  if (hours) {
    const next = buildOpeningHoursFromLegacy(hours.hours, hours.closed);
    if (rest.openingHours?.status === 'unknown' || intervalsKey(next) !== intervalsKey(rest.openingHours)) {
      changes.hours = hours;
    }
  }
  const fac = parseKakaoFacilities(body);
  const gp = rest.groupProfile || {};
  const curGroup = gp.availability === 'yes';
  const curRoom = gp.room?.privateRoom === 'yes';
  if (fac.group !== curGroup || fac.room !== curRoom) changes.facility = { group: fac.group, room: fac.room };
  return changes;
}

async function main() {
  let targets = loadRestaurants();
  if (LIMIT) targets = targets.slice(0, LIMIT);
  const results = new Map();
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const rest = targets[next++];
      const kid = rest.mapLinks?.kakaoPlaceId;
      if (!kid) {
        results.set(rest.id, { status: 'no_link' });
      } else {
        const res = await fetchPanel(kid);
        const changes = res.status === 'ok' ? compare(rest, res.body) : {};
        results.set(rest.id, { status: res.status, kakaoStatus: res.kakaoStatus, changes });
      }
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const byStatus = {};
  for (const r of results.values()) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const total = Math.max(1, targets.length);
  console.log(`[kakao-recheck] ${targets.length}곳 확인: ${JSON.stringify(byStatus)}`);
  if ((byStatus.error || 0) / total > MAX_ERROR_RATE) {
    console.error(`[kakao-recheck] 응답 실패 비율 ${(((byStatus.error || 0) / total) * 100).toFixed(1)}% — 카카오맵 접속 문제로 보고 결과를 저장하지 않습니다.`);
    process.exit(1);
  }

  const entry = r => ({ name: r.name, regionCode: r.regionCode, kakaoPlaceId: r.mapLinks?.kakaoPlaceId || null });
  const pick = status => targets.filter(t => results.get(t.id).status === status);
  const missing = pick('missing');
  const hoursUpdates = {};
  const facilityUpdates = {};
  for (const t of pick('ok')) {
    const ch = results.get(t.id).changes;
    if (ch.hours) hoursUpdates[t.id] = ch.hours;
    if (ch.facility) facilityUpdates[t.id] = ch.facility;
  }
  const changeRate = Math.max(Object.keys(hoursUpdates).length, Object.keys(facilityUpdates).length) / total;
  if (changeRate > MAX_CHANGE_RATE) {
    console.error(`[kakao-recheck] 바뀐 곳이 ${(changeRate * 100).toFixed(1)}%로 너무 많습니다 — 카카오맵 응답 형식 변경이 의심되어 결과를 저장하지 않습니다.`);
    process.exit(1);
  }

  const report = {
    checkedAt: todayKst(),
    source: '카카오맵 장소 상세 정기 재확인 (장소 페이지 존재·영업 표시·영업시간·단체석/룸 표시)',
    counts: byStatus,
    // 공개 자료에서 빼는 식당 (카카오맵 장소 페이지 없음)
    missing: Object.fromEntries(missing.filter(t => !isLegacyId(t.id)).map(t => [t.id, entry(t)])),
    // 처음부터 있던 여수·순천·광양 식당은 자동으로 빼지 않고 사람이 확인한다
    legacyMissing: Object.fromEntries(missing.filter(t => isLegacyId(t.id)).map(t => [t.id, entry(t)])),
    // 장소 페이지는 있지만 영업 표시가 아닌 곳 (휴업 등, 사람이 확인)
    notOpen: Object.fromEntries(pick('not_open').map(t => [t.id, { ...entry(t), kakaoStatus: results.get(t.id).kakaoStatus }])),
    // 영업 표시와 정보를 확인한 식당 (빌드 도구가 단체정보 확인일을 재확인 날짜로 바꾼다)
    confirmed: pick('ok').map(t => t.id).sort(),
    // 카카오맵과 달라진 영업시간 (원문·휴무·라스트오더)
    hoursUpdates,
    // 카카오맵과 달라진 단체석·룸 표시
    facilityUpdates
  };

  // 이전 결과의 missing은 유지한다 (한 번 사라진 장소가 다음 달 일시 오류로 다시 들어오지 않게)
  if (fs.existsSync(OUT_PATH)) {
    const prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    for (const [id, info] of Object.entries(prev.missing || {})) {
      if (!report.missing[id] && results.get(id)?.status !== 'ok') report.missing[id] = info;
    }
  }
  report.missing = Object.fromEntries(Object.entries(report.missing).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(OUT_PATH, JSON.stringify(report) + '\n', 'utf8');

  if (SUMMARY_PATH) {
    const name = id => targets.find(t => t.id === id)?.name || id;
    const groupOn = Object.entries(facilityUpdates).filter(([, f]) => f.group);
    const groupOff = Object.entries(facilityUpdates).filter(([, f]) => !f.group);
    const lines = [
      `## 카카오맵 정기 재확인 (${report.checkedAt})`,
      '',
      `- 확인한 식당: ${targets.length}곳 (${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' · ')})`,
      `- 확인일을 ${report.checkedAt}로 바꾸는 곳: ${report.confirmed.length}곳`,
      `- 영업시간이 바뀐 곳: ${Object.keys(hoursUpdates).length}곳`,
      `- 단체석 표시가 새로 생긴 곳: ${groupOn.length}곳, 없어진 곳(단체 수용 '미확인'으로 바꿈): ${groupOff.length}곳`,
      `- 공개 자료에서 빼는 곳(장소 페이지 없음): ${Object.keys(report.missing).length}곳`,
      ...Object.entries(report.missing).map(([id, t]) => `  - ${t.name} (${t.regionCode}, ${id})`),
      `- 사람이 확인할 여수·순천·광양 식당: ${Object.keys(report.legacyMissing).length}곳`,
      ...Object.entries(report.legacyMissing).map(([id, t]) => `  - ${t.name} (${id})`),
      `- 영업 표시가 아닌 곳(휴업 등, 확인 필요): ${Object.keys(report.notOpen).length}곳`,
      ...Object.entries(report.notOpen).slice(0, 30).map(([id, t]) => `  - ${t.name} (${t.regionCode}, ${id}, 상태 ${t.kakaoStatus})`),
      '',
      '<details><summary>영업시간이 바뀐 곳 (최대 30곳)</summary>',
      '',
      ...Object.entries(hoursUpdates).slice(0, 30).map(([id, h]) => `- ${name(id)}: ${h.hours} (휴무 ${h.closed})`),
      '',
      '</details>'
    ];
    fs.writeFileSync(SUMMARY_PATH, lines.join('\n') + '\n', 'utf8');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
