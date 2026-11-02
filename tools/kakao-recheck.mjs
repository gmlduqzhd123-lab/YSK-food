// 카카오맵 정기 재확인: 모든 식당의 카카오맵 장소 페이지가 아직 있는지(폐업·삭제 여부)를 확인한다.
//
//   node tools/kakao-recheck.mjs [--out tools/kakao-recheck-latest.json] [--summary 요약.md] [--limit N]
//
// - 장소 페이지가 없는(404) 식당은 결과 파일의 missing에 적는다. 빌드 도구는 이 목록의 식당을 공개 자료에서 뺀다
//   (단, 처음부터 있던 여수·순천·광양 166곳은 자동으로 빼지 않고 사람이 확인하도록 legacyMissing에만 적는다).
// - 응답 실패가 많으면(20% 초과) 카카오맵 접속 문제로 보고 결과 파일을 바꾸지 않고 실패로 끝낸다.
// - GitHub Actions(.github/workflows/kakao-recheck.yml)가 한 달에 한 번 실행해 바뀐 점이 있으면 PR을 만든다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandStoredRegionDataset } from '../assets/releases/v2.0.0/js/data/normalize.js';

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

const isLegacyId = id => /^ysk-r-\d+$/.test(String(id));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function loadRestaurants() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data/manifest.json'), 'utf8'));
  const list = [];
  for (const meta of Object.values(manifest.regionFiles || {})) {
    const stored = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, meta.path), 'utf8'));
    for (const r of expandStoredRegionDataset(stored).restaurants) {
      list.push({ id: r.id, name: r.name, regionCode: r.regionCode, kakaoPlaceId: r.mapLinks?.kakaoPlaceId || null });
    }
  }
  return list;
}

async function checkPlace(kakaoPlaceId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://place-api.map.kakao.com/places/panel3/${kakaoPlaceId}`, {
        headers: { pf: 'web', Referer: 'https://place.map.kakao.com/', 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
      });
      if (res.status === 404) return { status: 'missing' };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const summary = body.summary || {};
      return { status: summary.status === 'Y' ? 'ok' : 'not_open', kakaoStatus: summary.status ?? null, name: summary.name ?? null };
    } catch (err) {
      await sleep(1500 * (attempt + 1));
      if (attempt === 2) return { status: 'error', error: String(err.message || err).slice(0, 80) };
    }
  }
  return { status: 'error' };
}

async function main() {
  let targets = loadRestaurants();
  if (LIMIT) targets = targets.slice(0, LIMIT);
  const results = new Map();
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const t = targets[next++];
      results.set(t.id, t.kakaoPlaceId ? await checkPlace(t.kakaoPlaceId) : { status: 'no_link' });
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const byStatus = {};
  for (const r of results.values()) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const errorRate = (byStatus.error || 0) / Math.max(1, targets.length);
  console.log(`[kakao-recheck] ${targets.length}곳 확인: ${JSON.stringify(byStatus)}`);
  if (errorRate > MAX_ERROR_RATE) {
    console.error(`[kakao-recheck] 응답 실패 비율 ${(errorRate * 100).toFixed(1)}% — 카카오맵 접속 문제로 보고 결과를 저장하지 않습니다.`);
    process.exit(1);
  }

  const pick = status => targets.filter(t => results.get(t.id).status === status);
  const entry = t => ({ name: t.name, regionCode: t.regionCode, kakaoPlaceId: t.kakaoPlaceId });
  const missing = pick('missing');
  const report = {
    checkedAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
    source: '카카오맵 장소 상세 정기 재확인 (장소 페이지 존재·영업 표시)',
    counts: byStatus,
    // 공개 자료에서 빼는 식당 (카카오맵 장소 페이지 없음)
    missing: Object.fromEntries(missing.filter(t => !isLegacyId(t.id)).map(t => [t.id, entry(t)])),
    // 처음부터 있던 여수·순천·광양 식당은 자동으로 빼지 않고 사람이 확인한다
    legacyMissing: Object.fromEntries(missing.filter(t => isLegacyId(t.id)).map(t => [t.id, entry(t)])),
    // 장소 페이지는 있지만 영업 표시가 아닌 곳 (휴업 등, 사람이 확인)
    notOpen: Object.fromEntries(pick('not_open').map(t => [t.id, { ...entry(t), kakaoStatus: results.get(t.id).kakaoStatus }]))
  };

  // 이전 결과의 missing은 유지한다 (한 번 사라진 장소가 다음 달 일시 오류로 다시 들어오지 않게)
  if (fs.existsSync(OUT_PATH)) {
    const prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    for (const [id, info] of Object.entries(prev.missing || {})) {
      if (!report.missing[id] && results.get(id)?.status !== 'ok') report.missing[id] = info;
    }
  }
  report.missing = Object.fromEntries(Object.entries(report.missing).sort(([a], [b]) => a.localeCompare(b)));
  // 목록이 지난번과 같으면 파일을 그대로 두어, 바뀐 점이 없는 달에는 PR이 생기지 않게 한다
  const lists = r => JSON.stringify([r.missing, r.legacyMissing, r.notOpen]);
  const prevReport = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : null;
  if (!prevReport || lists(prevReport) !== lists(report)) {
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 1) + '\n', 'utf8');
  }

  if (SUMMARY_PATH) {
    const lines = [
      `## 카카오맵 정기 재확인 (${report.checkedAt})`,
      '',
      `- 확인한 식당: ${targets.length}곳 (${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' · ')})`,
      `- 공개 자료에서 빼는 곳(장소 페이지 없음): ${Object.keys(report.missing).length}곳`,
      ...Object.entries(report.missing).map(([id, t]) => `  - ${t.name} (${t.regionCode}, ${id})`),
      `- 사람이 확인할 여수·순천·광양 식당: ${Object.keys(report.legacyMissing).length}곳`,
      ...Object.entries(report.legacyMissing).map(([id, t]) => `  - ${t.name} (${id})`),
      `- 영업 표시가 아닌 곳(휴업 등, 확인 필요): ${Object.keys(report.notOpen).length}곳`,
      ...Object.entries(report.notOpen).slice(0, 30).map(([id, t]) => `  - ${t.name} (${t.regionCode}, ${id}, 상태 ${t.kakaoStatus})`)
    ];
    fs.writeFileSync(SUMMARY_PATH, lines.join('\n') + '\n', 'utf8');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
