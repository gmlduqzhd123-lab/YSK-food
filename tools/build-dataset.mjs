import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildOpeningHoursFromLegacy,
  compactRestaurantForStorage,
  expandStoredRestaurant,
  normalizeLegacyPlaceToRestaurant,
  validateDatasetBundleCrossReferences
} from '../assets/releases/v2.0.0/js/data/normalize.js';
import {
  DEFAULT_DATASET_VERSION,
  PUBLIC_SCHEMA_VERSION,
  SEOUL_GU_REGIONS,
  GYEONGGI_CITY_REGIONS,
  splitMetroRegionCode
} from '../assets/releases/v2.0.0/js/config.js';
import {
  NATIONWIDE_EXTRA_REGIONS,
  NATIONWIDE_VENUES_BY_REGION
} from './nationwide-elementary-data.mjs';
import { classifyMenuPriceBasis } from './menu-price-basis.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// 전국 초등학교 단체활동 식당 1000곳 조사(2026-10-19) 중 카카오맵에서 영업을 확인한 식당
// (영업 표시·요일별 영업시간·최근 6개월 리뷰·전화번호를 모두 확인한 곳만 수록, 단체 수용은 미확인)
const KAKAO_VERIFIED_1000 = JSON.parse(fs.readFileSync(path.join(__dirname, 'century-guide-1000.json'), 'utf8'));
const KAKAO_CHECK_SOURCE_ID = 'src-kakao-check-20261019';

// 연락처 있는 전국 식당 1,000곳(전국맛집가이드, 2026-10-20) 중 카카오맵에서 영업을 확인한 식당 (같은 기준으로 확인)
const KOFOOD_GUIDE_1000 = JSON.parse(fs.readFileSync(path.join(__dirname, 'kofood-guide-1000.json'), 'utf8'));
// 초등학생 동반 전국 식당 3,000곳(착한가격업소·브랜드 매장·지자체 맛집) 중 카카오맵에서 위치를 찾고 폐업 표시가 없는 식당
// (영업시간·리뷰가 없어도 수록하며, 엑셀의 메뉴 가격을 1인 예산 비교에 쓴다)
const GOODPRICE_3000 = JSON.parse(fs.readFileSync(path.join(__dirname, 'goodprice-3000.json'), 'utf8'));
// 초등학생·초등교사 맞춤 전국 맛집 1,000곳 (8대 식사 카테고리 균형 분류 및 연락처 필수 검증, 2026-10-27)
const ELEM_TEACHER_1000 = JSON.parse(fs.readFileSync(path.join(__dirname, 'elem-teacher-1000.json'), 'utf8'));
// 초등학생·초등교사 맞춤 전국 맛집 2차 1,000곳 (2026-10-27)
const ELEM_TEACHER_2000 = JSON.parse(fs.readFileSync(path.join(__dirname, 'elem-teacher-2000.json'), 'utf8'));

// 카카오맵 장소 상세의 편의시설·좌석 옵션(단체석·룸·주차·예약·포장 등, 일부 AI 요약 포함) 수집 결과
const KAKAO_FACILITIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'kakao-facilities-20261019.json'), 'utf8'));
const FACILITY_SOURCE_ID = 'src-kakao-facility-20261019';

/**
 * 카카오맵 편의시설 정보를 단체 식사 항목에 옮긴다.
 * 좌석 수·동시 수용 인원·대형버스 진입은 카카오맵에 없으므로 비워 둔다(전화 확인).
 */
function applyKakaoFacilities(rest) {
  const earlier = KAKAO_FACILITIES.facilities[rest.id] || KOFOOD_GUIDE_1000.facilities?.[rest.id] || GOODPRICE_3000.facilities?.[rest.id] || ELEM_TEACHER_1000.facilities?.[rest.id] || ELEM_TEACHER_2000.facilities?.[rest.id];
  const refreshed = KAKAO_REFRESH.places[rest.id]?.facilities;
  if (!earlier && !refreshed) return;
  // 먼저 모은 정보를 우선하고, 재수집에서 새로 확인된 항목(단체석·주차 등)을 더한다
  const f = { ...(refreshed || {}), ...(earlier || {}) };
  for (const key of ['group', 'room', 'parking', 'freeParking', 'reserve', 'takeout', 'kidChair', 'wheelchair']) {
    if (refreshed?.[key]) f[key] = true;
  }
  const gp = rest.groupProfile;
  if (f.group) {
    gp.availability = 'yes';
    gp.seatTypes = ['단체석', ...(f.room ? ['룸'] : [])];
  }
  if (f.room) gp.room.privateRoom = 'yes';
  if (f.reserve) gp.preOrder.leadTimeNote = '예약 가능 (단체 인원·메뉴는 전화로 확인)';
  if (f.takeout) {
    gp.lunchbox.availability = 'yes';
    gp.lunchbox.handlingNotes = '포장 가능 (단체 도시락 수량은 전화로 확인)';
  }
  if (f.parking) {
    gp.parking.walkingNotes = `${f.freeParking ? '무료 주차' : '주차 가능'}${f.parkingNote ? ` · ${f.parkingNote}` : ''} (승용차 기준, 대형버스는 전화 확인)`;
  }
  const access = [f.wheelchair ? '휠체어 이용 가능' : null, f.kidChair ? '유아의자 있음' : null].filter(Boolean);
  if (access.length) gp.accessibility.entryNote = access.join(' · ');
  const sourceId = earlier ? FACILITY_SOURCE_ID : REFRESH_SOURCE_ID;
  gp.checkedAt = earlier ? KAKAO_FACILITIES.checkedAt : KAKAO_REFRESH.checkedAt;
  if (!gp.evidenceRefs.includes(sourceId)) gp.evidenceRefs.push(sourceId);
  if (earlier && refreshed && !gp.evidenceRefs.includes(REFRESH_SOURCE_ID)) gp.evidenceRefs.push(REFRESH_SOURCE_ID);
}

// 카카오맵 장소 상세 재수집(2026-11-02): 영업시간·메뉴판 가격·편의시설·좌석 옵션
const KAKAO_REFRESH = JSON.parse(fs.readFileSync(path.join(__dirname, 'kakao-refresh-20261102.json'), 'utf8'));
// 식당 100곳 미만 지역 보강(2026-11-03): 카카오맵 지역 검색 후 영업 표시·영업시간·최근 6개월 리뷰·전화번호·메뉴 가격을 확인한 식당
// 1차: 100곳 미만 지역, 2차: 시·군·구 150곳·도/광역시 기타 250곳 목표, 3차: 수학여행·체험학습 인기 지역과 서울·경기·부산, 4차: 도·광역시 기타 지역과 대도시 확대, 5차: 수학여행·체험학습 지역과 시·구 단위 지역 확대
const REGION_BOOST_FILES = ['region-boost-20261103.json', 'region-boost-2-20261103.json', 'region-boost-3-20261103.json', 'region-boost-4-20261103.json', 'region-boost-5-20261103.json'];
const REGION_BOOST = { restaurants: [], places: {} };
for (const file of REGION_BOOST_FILES) {
  const batch = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  REGION_BOOST.restaurants.push(...batch.restaurants);
  Object.assign(REGION_BOOST.places, batch.places);
}
Object.assign(KAKAO_REFRESH.places, REGION_BOOST.places);
// 메뉴판 가격의 1인/세트 기준은 메뉴 이름·금액 규칙(tools/menu-price-basis.mjs)으로 다시 판정한다
for (const place of Object.values(KAKAO_REFRESH.places)) {
  for (const m of place.menus || []) m.priceBasis = classifyMenuPriceBasis(m.name, m.priceKRW);
}
const REFRESH_SOURCE_ID = 'src-kakao-refresh-20261102';
// 매달 정기 재확인 결과(tools/kakao-recheck.mjs, GitHub Actions) — 장소 페이지가 사라진 식당 목록
const KAKAO_RECHECK_PATH = path.join(__dirname, 'kakao-recheck-latest.json');
const KAKAO_RECHECK = fs.existsSync(KAKAO_RECHECK_PATH) ? JSON.parse(fs.readFileSync(KAKAO_RECHECK_PATH, 'utf8')) : { missing: {} };
const normMenuName = s => String(s || '').replace(/\s+|\(.*?\)/g, '');

/**
 * 비어 있는 영업시간과 메뉴 가격을 카카오맵 재수집 결과로 채운다.
 * 이미 있는 영업시간·가격은 바꾸지 않는다.
 */
function applyKakaoRefresh(rest) {
  const e = KAKAO_REFRESH.places[rest.id];
  if (!e || e.notFound) return;
  if (!rest.mapLinks.kakaoPlaceId && e.kakaoPlaceId) {
    rest.mapLinks.kakaoPlaceId = e.kakaoPlaceId;
    rest.mapLinks.kakaoPlaceUrl = `https://place.map.kakao.com/${e.kakaoPlaceId}`;
  }
  if (rest.openingHours.status === 'unknown' && e.hours) {
    const oh = buildOpeningHoursFromLegacy(e.hours, e.closed);
    if (oh.status !== 'unknown') {
      const dayChars = ['', '월', '화', '수', '목', '금', '토', '일'];
      for (const iv of oh.weeklyIntervals) {
        const lo = e.lastOrder?.[dayChars[iv.day]];
        // 라스트오더는 그날 마지막 영업 구간에만 붙인다
        const isLast = !oh.weeklyIntervals.some(o => o.day === iv.day && o.startTime > iv.startTime);
        if (lo && isLast) {
          iv.lastOrderTime = lo;
          iv.lastOrderDayOffset = lo < iv.startTime ? 1 : 0;
        }
      }
      oh.evidenceRefs = [REFRESH_SOURCE_ID];
      rest.openingHours = oh;
    }
  }
  const hasPrice = rest.menus.some(m => m.priceKRW !== null && m.priceKRW !== undefined);
  if (!hasPrice && e.menus?.length) {
    const used = new Set();
    for (const m of rest.menus) {
      const key = normMenuName(m.name);
      const free = e.menus.filter(k => !used.has(k.name) && key);
      // 이름이 똑같은 메뉴, 그다음 이름을 포함하는 1인 메뉴, 마지막으로 이름을 포함하는 메뉴 순으로 고른다
      const hit = free.find(k => normMenuName(k.name) === key)
        || free.find(k => k.priceBasis === 'per_person' && normMenuName(k.name).includes(key))
        || free.find(k => normMenuName(k.name).includes(key));
      if (!hit) continue;
      used.add(hit.name);
      Object.assign(m, { priceKRW: hit.priceKRW, priceBasis: hit.priceBasis, checkedAt: KAKAO_REFRESH.checkedAt, evidenceRefs: [REFRESH_SOURCE_ID] });
    }
    // 이름이 맞는 메뉴가 없으면 카카오맵 메뉴판의 1인 메뉴를 최대 5개 덧붙인다
    if (!rest.menus.some(m => m.priceBasis === 'per_person' && m.priceKRW !== null)) {
      const extra = e.menus.filter(k => !used.has(k.name) && k.priceBasis === 'per_person').slice(0, 5);
      extra.forEach((k, i) => {
        rest.menus.push({
          ...rest.menus[0],
          id: `${rest.id}-kmenu-${i + 1}`,
          name: k.name,
          priceKRW: k.priceKRW,
          priceBasis: k.priceBasis,
          servingUnitText: null,
          minOrder: null,
          studentPortion: 'unknown',
          spiceAdjustment: 'unknown',
          extraRice: 'unknown',
          altMenuInquiry: 'unknown',
          ingredientResponse: { status: 'unknown', answerText: null, cookingProcessNote: null, checkedAt: null },
          checkedAt: KAKAO_REFRESH.checkedAt,
          evidenceRefs: [REFRESH_SOURCE_ID]
        });
      });
    }
    const cheapest = rest.menus.filter(m => m.priceBasis === 'per_person' && m.priceKRW !== null).sort((a, b) => a.priceKRW - b.priceKRW)[0];
    if (cheapest && !rest.rawPriceText) rest.rawPriceText = `${cheapest.priceKRW.toLocaleString('ko-KR')}원 (${cheapest.name})`;
  }
}
const LIST_SOURCES = {
  백년가게: {
    id: 'src-centuryshop-2022',
    url: 'https://github.com/yeodusung-ux/korea-restaurant-certs/blob/main/build/baengnyeon_2022.csv',
    attribution: '2022 백년가게 공개 명부'
  },
  블루리본: {
    id: 'src-blueribbon-list',
    url: 'https://github.com/yeodusung-ux/korea-restaurant-certs/blob/main/build/guide_blue.csv',
    attribution: '블루리본 명단 (2차 공개자료)'
  },
  레드가이드: {
    id: 'src-redguide-list',
    url: 'https://github.com/yeodusung-ux/korea-restaurant-certs/blob/main/build/guide_red.csv',
    attribution: '레드가이드 명단 (2차 공개자료)'
  },
  착한가격업소: {
    id: 'src-goodprice-mois',
    url: 'https://www.data.go.kr',
    attribution: '행정안전부 착한가격업소 현황 (2026-09-30)'
  },
  브랜드매장: {
    id: 'src-brand-store',
    url: 'https://www.kukinamu.com',
    attribution: '브랜드 공식 매장안내 (메뉴·가격은 브랜드 공통, 지점별 확인)'
  },
  지자체맛집: {
    id: 'src-local-gov-guide',
    url: 'https://www.daejeon.go.kr',
    attribution: '지자체 공식 맛집 안내 (대전의 맛·울산 큰애기맛집·강원 으뜸음식점 등)'
  },
  전국맛집가이드: {
    id: 'src-kofood-guide',
    url: 'https://www.kofood.net',
    attribution: '전국맛집가이드 음식별 목록 (연락처 있는 전국 식당 1,000곳, 2026-10-20 조회)'
  },
  카카오맵지역보강: {
    id: 'src-kakao-region-boost-20261103',
    url: 'https://map.kakao.com',
    attribution: '카카오맵 지역 검색 보강 (식당 적은 지역, 영업·영업시간·최근 6개월 리뷰·연락처·메뉴 가격 확인, 2026-11-03)'
  },
  '초등·교사선정맛집': {
    id: 'src-elem-teacher-1000',
    url: 'https://map.kakao.com',
    attribution: '초등학생·초등교사 현장체험·단체식사 추천 1,000곳 (카카오맵 영업·연락처 확인, 2026-10-27)'
  }
};

const GENERATED_AT = '2026-10-19T09:30:00+09:00';
const DATASET_VERSION = DEFAULT_DATASET_VERSION;

// 키 순서와 상관없이 두 JSON 값이 같은지 비교한다
function sameShape(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameShape(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter(k => a[k] !== undefined);
    const kb = Object.keys(b).filter(k => b[k] !== undefined);
    return ka.length === kb.length && ka.every(k => sameShape(a[k], b[k]));
  }
  return a === b;
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function extractFallbackRestaurantsFromGitHead() {
  const indexPath = path.join(ROOT_DIR, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  let match = html.match(/const FALLBACK_RESTAURANTS = (\[[\s\S]*?\]);/);
  if (!match) {
    html = execSync('git show 95f28ea:index.html', { cwd: ROOT_DIR, encoding: 'utf8' });
    match = html.match(/const FALLBACK_RESTAURANTS = (\[[\s\S]*?\]);/);
  }
  if (!match) {
    throw new Error('FALLBACK_RESTAURANTS를 찾지 못했습니다.');
  }
  const fn = new Function(`return ${match[1]};`);
  return fn();
}

const BASE_REGIONS_DEF = [
  {
    regionCode: 'jn-yeosu',
    parentCode: 'jn',
    sidoName: '전라남도',
    level: 'sigungu',
    name: '여수시',
    shortName: '여수',
    aliases: ['여수', '여수시', '전남 여수', '전라남도 여수시'],
    center: { lat: 34.7604, lng: 127.6622, zoomLevel: 8 },
    bounds: { sw: { lat: 34.60, lng: 127.50 }, ne: { lat: 34.88, lng: 127.82 } }
  },
  {
    regionCode: 'jn-suncheon',
    parentCode: 'jn',
    sidoName: '전라남도',
    level: 'sigungu',
    name: '순천시',
    shortName: '순천',
    aliases: ['순천', '순천시', '전남 순천', '전라남도 순천시'],
    center: { lat: 34.9506, lng: 127.4872, zoomLevel: 8 },
    bounds: { sw: { lat: 34.82, lng: 127.30 }, ne: { lat: 35.10, lng: 127.60 } }
  },
  {
    regionCode: 'jn-gwangyang',
    parentCode: 'jn',
    sidoName: '전라남도',
    level: 'sigungu',
    name: '광양시',
    shortName: '광양',
    aliases: ['광양', '광양시', '전남 광양', '전라남도 광양시'],
    center: { lat: 34.9407, lng: 127.6959, zoomLevel: 8 },
    bounds: { sw: { lat: 34.88, lng: 127.55 }, ne: { lat: 35.12, lng: 127.78 } }
  },
  {
    regionCode: 'jn-boseong',
    parentCode: 'jn',
    sidoName: '전라남도',
    level: 'sigungu',
    name: '보성군',
    shortName: '보성군',
    aliases: ['보성', '보성군', '전남 보성', '전라남도 보성군'],
    center: { lat: 34.7715, lng: 127.0800, zoomLevel: 9 },
    bounds: { sw: { lat: 34.65, lng: 126.95 }, ne: { lat: 34.92, lng: 127.28 } }
  },
  {
    regionCode: 'jn-goheung',
    parentCode: 'jn',
    sidoName: '전라남도',
    level: 'sigungu',
    name: '고흥군',
    shortName: '고흥군',
    aliases: ['고흥', '고흥군', '전남 고흥', '전라남도 고흥군'],
    center: { lat: 34.6047, lng: 127.2755, zoomLevel: 9 },
    bounds: { sw: { lat: 34.40, lng: 127.05 }, ne: { lat: 34.78, lng: 127.50 } }
  },
  {
    regionCode: 'jn-mokpo',
    parentCode: 'jn',
    sidoName: '전라남도',
    level: 'sigungu',
    name: '목포시',
    shortName: '목포',
    aliases: ['목포', '목포시', '전남 목포', '전라남도 목포시'],
    center: { lat: 34.8118, lng: 126.3922, zoomLevel: 8 },
    bounds: { sw: { lat: 34.75, lng: 126.32 }, ne: { lat: 34.86, lng: 126.46 } }
  },
  {
    regionCode: 'gj-donggu',
    parentCode: 'gj',
    sidoName: '광주광역시',
    level: 'sigungu',
    name: '광주 동구',
    shortName: '광주 동구',
    aliases: ['동구', '광주 동구', '광주광역시 동구'],
    center: { lat: 35.1461, lng: 126.9231, zoomLevel: 7 },
    bounds: { sw: { lat: 35.08, lng: 126.89 }, ne: { lat: 35.18, lng: 126.99 } }
  },
  {
    regionCode: 'jb-jeonju',
    parentCode: 'jb',
    sidoName: '전북특별자치도',
    level: 'sigungu',
    name: '전주시',
    shortName: '전주',
    aliases: ['전주', '전주시', '전북 전주', '전북특별자치도 전주시', '전라북도 전주시'],
    center: { lat: 35.8242, lng: 127.1480, zoomLevel: 8 },
    bounds: { sw: { lat: 35.75, lng: 127.05 }, ne: { lat: 35.90, lng: 127.25 } }
  },
  {
    regionCode: 'jj-jeju',
    parentCode: 'jj',
    sidoName: '제주특별자치도',
    level: 'sigungu',
    name: '제주 (제주시·서귀포)',
    shortName: '제주',
    aliases: ['제주', '제주시', '제주특별자치도 제주시', '서귀포', '서귀포시', '제주특별자치도'],
    center: { lat: 33.4996, lng: 126.5312, zoomLevel: 9 },
    bounds: { sw: { lat: 33.15, lng: 126.10 }, ne: { lat: 33.58, lng: 126.98 } }
  },
  {
    regionCode: 'gw-gangneung',
    parentCode: 'gw',
    sidoName: '강원특별자치도',
    level: 'sigungu',
    name: '강릉시',
    shortName: '강릉',
    aliases: ['강릉', '강릉시', '강원 강릉', '강원특별자치도 강릉시', '강원도 강릉시'],
    center: { lat: 37.7519, lng: 128.8761, zoomLevel: 8 },
    bounds: { sw: { lat: 37.60, lng: 128.70 }, ne: { lat: 37.90, lng: 129.05 } }
  },
  {
    regionCode: 'gb-gyeongju',
    parentCode: 'gb',
    sidoName: '경상북도',
    level: 'sigungu',
    name: '경주시',
    shortName: '경주',
    aliases: ['경주', '경주시', '경북 경주', '경상북도 경주시'],
    center: { lat: 35.8562, lng: 129.2247, zoomLevel: 8 },
    bounds: { sw: { lat: 35.70, lng: 129.05 }, ne: { lat: 36.05, lng: 129.50 } }
  },
  {
    regionCode: 'seoul-jongno',
    parentCode: 'seoul',
    sidoName: '서울특별시',
    level: 'sigungu',
    name: '서울 종로구',
    shortName: '서울 종로',
    aliases: ['종로', '종로구', '서울 종로구', '서울특별시 종로구'],
    center: { lat: 37.5730, lng: 126.9794, zoomLevel: 7 },
    bounds: { sw: { lat: 37.56, lng: 126.95 }, ne: { lat: 37.63, lng: 127.02 } }
  },
  {
    regionCode: 'busan-haeundae',
    parentCode: 'busan',
    sidoName: '부산광역시',
    level: 'sigungu',
    name: '부산 해운대구',
    shortName: '부산 해운대',
    aliases: ['해운대', '해운대구', '부산 해운대구', '부산광역시 해운대구'],
    center: { lat: 35.1631, lng: 129.1636, zoomLevel: 7 },
    bounds: { sw: { lat: 35.14, lng: 129.11 }, ne: { lat: 35.22, lng: 129.22 } }
  }
];

const REGIONS_DEF = [
  ...BASE_REGIONS_DEF,
  ...NATIONWIDE_EXTRA_REGIONS.filter(er => !BASE_REGIONS_DEF.some(br => br.regionCode === er.regionCode))
];
// 기존 지역에 들지 않는 식당을 담는 시·도 단위 지역
for (const reg of KAKAO_VERIFIED_1000.regions) {
  if (!REGIONS_DEF.some(r => r.regionCode === reg.regionCode)) REGIONS_DEF.push(reg);
}
// 서울(종로 외)·경기(수원·용인 외)는 구·시·군 단위 지역으로 나눈다 (지도 범위는 식당 좌표로 나중에 계산)
for (const [parentCode, children, sidoShort] of [['seoul-etc', SEOUL_GU_REGIONS, '서울'], ['gyeonggi-etc', GYEONGGI_CITY_REGIONS, '경기']]) {
  const at = REGIONS_DEF.findIndex(r => r.regionCode === parentCode);
  const parent = REGIONS_DEF[at];
  const defs = children.map(child => ({
    regionCode: child.regionCode,
    parentCode: parent.parentCode,
    sidoName: parent.sidoName,
    level: 'sigungu',
    name: child.name,
    shortName: child.shortName,
    aliases: [...new Set([child.name, child.shortName, `${sidoShort} ${child.name}`, `${parent.sidoName} ${child.name}`])],
    center: parent.center,
    bounds: parent.bounds
  }));
  REGIONS_DEF.splice(at, 1, ...defs);
}
const SPLIT_REGION_CODES = new Set([...SEOUL_GU_REGIONS, ...GYEONGGI_CITY_REGIONS].map(r => r.regionCode));

// 식당 좌표로 지역의 지도 중심·범위를 정한다 (좌표가 한 곳뿐이어도 보이도록 여유를 둔다)
function fitRegionToRestaurants(reg, restaurants) {
  const pts = restaurants.filter(r => r.location?.lat && r.location?.lng).map(r => [r.location.lat, r.location.lng]);
  if (!pts.length) return;
  const lats = pts.map(p => p[0]).sort((a, b) => a - b);
  const lngs = pts.map(p => p[1]).sort((a, b) => a - b);
  // 멀리 떨어진 한두 곳 때문에 범위가 커지지 않게 양 끝 2%는 뺀다
  const cut = arr => [arr[Math.floor((arr.length - 1) * 0.02)], arr[Math.ceil((arr.length - 1) * 0.98)]];
  const [s, n] = cut(lats);
  const [w, e] = cut(lngs);
  const pad = 0.01;
  const round = v => Math.round(v * 1000) / 1000;
  reg.bounds = { sw: { lat: round(s - pad), lng: round(w - pad) }, ne: { lat: round(n + pad), lng: round(e + pad) } };
  const span = Math.max(n - s, e - w);
  reg.center = { lat: round((s + n) / 2), lng: round((w + e) / 2), zoomLevel: span < 0.06 ? 6 : span < 0.12 ? 7 : span < 0.25 ? 8 : 9 };
}

const BASE_VENUES_BY_REGION = {
  'jn-yeosu': [
    {
      id: 'venue-yeosu-expo',
      name: '여수세계박람회장',
      type: 'attraction',
      typeLabel: '체험시설·관광지',
      regionCode: 'jn-yeosu',
      address: '전라남도 여수시 박람회길 1',
      location: { lat: 34.7495, lng: 127.7475, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-yeosu-jinnam',
      name: '여수 진남종합운동장 (진남체육공원)',
      type: 'stadium',
      typeLabel: '운동장·체육관',
      regionCode: 'jn-yeosu',
      address: '전라남도 여수시 진남체육관길 74',
      location: { lat: 34.7616, lng: 127.7275, status: 'verified' },
      eventRefs: ['evref-2026-sports-jn']
    }
  ],
  'jn-suncheon': [
    {
      id: 'venue-suncheon-garden',
      name: '순천만국가정원',
      type: 'attraction',
      typeLabel: '체험시설·관광지',
      regionCode: 'jn-suncheon',
      address: '전라남도 순천시 국가정원1호길 47',
      location: { lat: 34.9286, lng: 127.4988, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-suncheon-wetland',
      name: '순천만습지 자연생태공원',
      type: 'attraction',
      typeLabel: '체험시설·관광지',
      regionCode: 'jn-suncheon',
      address: '전라남도 순천시 순천만길 513-25',
      location: { lat: 34.8858, lng: 127.5094, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-suncheon-palma',
      name: '순천팔마종합운동장',
      type: 'stadium',
      typeLabel: '운동장·체육관',
      regionCode: 'jn-suncheon',
      address: '전라남도 순천시 팔마로 100',
      location: { lat: 34.9365, lng: 127.5152, status: 'verified' },
      eventRefs: ['evref-2026-sports-jn', 'evref-2026-club-sc']
    },
    {
      id: 'venue-suncheon-youth',
      name: '순천시청소년수련원',
      type: 'lodging',
      typeLabel: '수련시설·숙소',
      regionCode: 'jn-suncheon',
      address: '전라남도 순천시 서면 청소년수련원길 167',
      location: { lat: 35.0457, lng: 127.4738, status: 'verified' },
      eventRefs: []
    }
  ],
  'jn-gwangyang': [
    {
      id: 'venue-gwangyang-stadium',
      name: '광양공설운동장',
      type: 'stadium',
      typeLabel: '운동장·체육관',
      regionCode: 'jn-gwangyang',
      address: '전라남도 광양시 광양읍 매천로 695-20',
      location: { lat: 34.9844, lng: 127.5761, status: 'verified' },
      eventRefs: ['evref-2026-sports-jn']
    },
    {
      id: 'venue-gwangyang-retreat',
      name: '백운산자연휴양림',
      type: 'lodging',
      typeLabel: '수련시설·숙소',
      regionCode: 'jn-gwangyang',
      address: '전라남도 광양시 옥룡면 백계로 337',
      location: { lat: 35.0537, lng: 127.5974, status: 'verified' },
      eventRefs: []
    }
  ]
};

const VENUES_BY_REGION = {
  ...NATIONWIDE_VENUES_BY_REGION,
  ...BASE_VENUES_BY_REGION
};

const EVENT_REFS_BY_REGION = {
  'jn-suncheon': [
    {
      id: 'evref-2026-sports-jn',
      eventName: '전남 권역 학교체육대회·동계전지훈련',
      editionYear: 2026,
      sport: '육상·축구·배드민턴',
      venueIds: ['venue-yeosu-jinnam', 'venue-suncheon-palma', 'venue-gwangyang-stadium'],
      sourceRef: 'src-legacy-ysk-v1',
      checkedAt: '2026-10-18'
    },
    {
      id: 'evref-2026-club-sc',
      eventName: '전남 학교스포츠클럽 한마당',
      editionYear: 2026,
      sport: '풋살·피구·배구',
      venueIds: ['venue-suncheon-palma'],
      sourceRef: 'src-legacy-ysk-v1',
      checkedAt: '2026-10-18'
    }
  ]
};

function buildDataset() {
  const rawFallback = extractFallbackRestaurantsFromGitHead();
  if (rawFallback.length !== 166) {
    throw new Error(`기대한 166개 식당과 다릅니다: ${rawFallback.length}`);
  }

  const releaseDir = path.join(ROOT_DIR, 'data', 'releases', DATASET_VERSION);
  const regionsDir = path.join(releaseDir, 'regions');
  fs.mkdirSync(regionsDir, { recursive: true });

  const normalizedRestaurants = rawFallback.map(item => {
    const rest = normalizeLegacyPlaceToRestaurant(item);
    rest.groupProfile.evidenceRefs = ['src-legacy-ysk-v1'];
    rest.openingHours.evidenceRefs = ['src-legacy-ysk-v1'];
    return rest;
  });

  // PDF 주소 및 카카오맵 확인 연락처로 기존 식당 보강
  const addressOverrides = new Map([...KAKAO_VERIFIED_1000.addressOverrides, ...(KOFOOD_GUIDE_1000.addressOverrides || []), ...(GOODPRICE_3000.addressOverrides || [])].map(o => [o.id, o.address]));
  const legacyPhones = ELEM_TEACHER_1000.legacyPhones || {};
  for (const r of normalizedRestaurants) {
    if (addressOverrides.has(r.id)) r.address = addressOverrides.get(r.id);
    if ((!r.phone || !String(r.phone).trim()) && legacyPhones[r.id]?.phone) {
      r.phone = legacyPhones[r.id].phone;
      if ((!r.address || r.address.includes('미확인')) && legacyPhones[r.id].address) {
        r.address = legacyPhones[r.id].address;
      }
    }
  }

  const refineElementaryCategory = (item) => {
    if (item.source === '초등·교사선정맛집') return item.category;
    const text = `${item.name || ''} ${item.menu || ''} ${item.priceMenu || ''}`;
    if (/한정식|수라상|정찬|반상/.test(text)) return '한정식';
    if (/삼계탕|닭갈비|백숙|찜닭|닭곰탕|닭한마리|치킨|통닭/.test(text)) return '닭요리';
    if (/불고기|떡갈비|돼지갈비|소갈비|삼겹살|목살|오리불고기|오리구이|숯불갈비/.test(text) && !/갈비탕|갈비만두/.test(text)) return '고기';
    if (/백반|보리밥|비빔밥|쌈밥|생선구이|청국장|된장찌개|김치찌개|순두부|두부전골|가정식/.test(text) && !/돈가스|돈까스|초밥|우동|칼국수|짜장|짬뽕/.test(text)) return '백반·한식';
    return item.category;
  };

  const verifiedRestaurants = [
    ...KAKAO_VERIFIED_1000.restaurants,
    ...KOFOOD_GUIDE_1000.restaurants,
    ...GOODPRICE_3000.restaurants,
    ...ELEM_TEACHER_1000.restaurants,
    ...ELEM_TEACHER_2000.restaurants,
    ...REGION_BOOST.restaurants
  ].map(item => {
    const refinedItem = { ...item, category: refineElementaryCategory(item) };
    const rest = normalizeLegacyPlaceToRestaurant(refinedItem);
    // 엑셀에 적힌 메뉴 가격(1인 메뉴 기준으로 사용, 세트·조건 가격일 수 있음)
    if (item.priceKRW) {
      const target = rest.menus.find(m => m.name === item.priceMenu) || rest.menus[0];
      if (target) {
        target.priceKRW = item.priceKRW;
        target.priceBasis = 'per_person';
      }
      rest.rawPriceText = `${item.priceKRW.toLocaleString('ko-KR')}원${target && target.name ? ` (${target.name})` : ''}`;
    }
    rest.location.checkedAt = '2026-10-19';
    const listSource = LIST_SOURCES[item.source];
    rest.groupProfile.evidenceRefs = [...(listSource ? [listSource.id] : []), KAKAO_CHECK_SOURCE_ID];
    rest.openingHours.evidenceRefs = [KAKAO_CHECK_SOURCE_ID];
    return rest;
  });

  const restaurantsByRegion = {};
  for (const reg of REGIONS_DEF) {
    restaurantsByRegion[reg.regionCode] = [];
  }
  // 연락처(phone) 정보가 없는 업소는 전면 제외한다.
  for (const r of [...normalizedRestaurants, ...verifiedRestaurants]) {
    if (!r.phone || !String(r.phone).trim()) continue;
    // 카카오맵 장소 페이지가 사라진 식당(폐업·삭제 추정)은 뺀다: 2026-11-02 재수집 + 매달 정기 재확인 결과
    if (KAKAO_REFRESH.places[r.id]?.notFound || KAKAO_RECHECK.missing?.[r.id]) continue;
    applyKakaoRefresh(r);
    applyKakaoFacilities(r);
    r.regionCode = splitMetroRegionCode(r.regionCode, r.address);
    if (!restaurantsByRegion[r.regionCode]) {
      restaurantsByRegion[r.regionCode] = [];
    }
    restaurantsByRegion[r.regionCode].push(r);
  }
  for (const reg of REGIONS_DEF) {
    if (SPLIT_REGION_CODES.has(reg.regionCode)) fitRegionToRestaurants(reg, restaurantsByRegion[reg.regionCode] || []);
  }

  const favoriteKeys = {};
  const placeNames = {};
  const legacyNumericIds = {};

  for (const raw of rawFallback) {
    const permId = `ysk-r-${raw.id}`;
    legacyNumericIds[String(raw.id)] = permId;
    const favKey = `${raw.city}:${raw.name}`;
    if (!favoriteKeys[favKey]) favoriteKeys[favKey] = [];
    if (!favoriteKeys[favKey].includes(permId)) favoriteKeys[favKey].push(permId);

    if (!placeNames[raw.name]) placeNames[raw.name] = [];
    if (!placeNames[raw.name].includes(permId)) placeNames[raw.name].push(permId);
  }

  const searchIndexEntries = [];
  const idIndexEntries = {};
  const regionDatasets = {};
  const regionFilesMeta = {};
  const checksums = {};

  for (const reg of REGIONS_DEF) {
    const code = reg.regionCode;
    const restaurants = restaurantsByRegion[code] || [];
    const venues = VENUES_BY_REGION[code] || [];
    const eventReferences = EVENT_REFS_BY_REGION[code] || [];
    const relPath = `data/releases/${DATASET_VERSION}/regions/${code}.json`;

    const sources = [
      {
        id: 'src-legacy-ysk-v1',
        kind: 'operator_curated',
        url: 'https://github.com/gmlduqzhd123-lab/YSK-food',
        obtainedAt: '2026-10-12',
        checkedAt: '2026-10-18',
        factScope: restaurants.slice(0, 5).map(r => ({
          entityId: r.id,
          fieldPath: '/openingHours/rawLegacyText'
        })),
        usageTerms: '엽쌤스쿨 YSK-food 기본 등록 자료 (단체 수용·버스 조건 미검증)',
        attribution: '엽쌤스쿨 여순광 맛집 지도 기본 목록 (95f28ea)'
      }
    ];

    // 1000곳 조사에서 들어온 식당이 있는 지역은 출처(명부·카카오맵 확인)를 함께 적는다
    const facilityRests = restaurants.filter(r => r.groupProfile.evidenceRefs.includes(FACILITY_SOURCE_ID));
    if (facilityRests.length) {
      sources.push({
        id: FACILITY_SOURCE_ID,
        kind: 'map_platform',
        url: 'https://map.kakao.com',
        obtainedAt: KAKAO_FACILITIES.checkedAt,
        checkedAt: KAKAO_FACILITIES.checkedAt,
        factScope: facilityRests.slice(0, 5).map(r => ({ entityId: r.id, fieldPath: '/groupProfile/availability' })),
        usageTerms: '카카오맵 편의시설·좌석 옵션(단체석·룸·주차·예약·포장, 일부 AI 요약) · 좌석 수·대형버스는 미확인, 방문 전 전화 확인',
        attribution: '카카오맵 편의시설 정보 (2026-10-19)'
      });
    }
    const usesRefresh = r => r.groupProfile.evidenceRefs.includes(REFRESH_SOURCE_ID) || r.openingHours.evidenceRefs.includes(REFRESH_SOURCE_ID) || r.menus.some(m => m.evidenceRefs.includes(REFRESH_SOURCE_ID));
    const refreshRests = restaurants.filter(usesRefresh);
    if (refreshRests.length) {
      sources.push({
        id: REFRESH_SOURCE_ID,
        kind: 'map_platform',
        url: 'https://map.kakao.com',
        obtainedAt: KAKAO_REFRESH.checkedAt,
        checkedAt: KAKAO_REFRESH.checkedAt,
        factScope: refreshRests.slice(0, 5).map(r => ({ entityId: r.id, fieldPath: '/openingHours/weeklyIntervals' })),
        usageTerms: '카카오맵 장소 상세의 영업시간·메뉴판 가격·편의시설·좌석 옵션(일부 AI 요약) 재수집 · 메뉴 가격의 1인/세트 기준은 메뉴 이름으로 추정, 방문 전 전화 확인',
        attribution: '카카오맵 장소 상세 재수집 (2026-11-02)'
      });
    }
    const kakaoRests = restaurants.filter(r => r.groupProfile.evidenceRefs.includes(KAKAO_CHECK_SOURCE_ID));
    if (kakaoRests.length) {
      sources.push({
        id: KAKAO_CHECK_SOURCE_ID,
        kind: 'map_platform',
        url: 'https://map.kakao.com',
        obtainedAt: '2026-10-19',
        checkedAt: '2026-10-19',
        factScope: kakaoRests.slice(0, 5).map(r => ({ entityId: r.id, fieldPath: '/openingHours/rawLegacyText' })),
        usageTerms: '카카오맵 장소 정보로 영업 표시·영업시간·최근 6개월 리뷰·전화번호 확인 (단체 수용·학교 이용 미검증)',
        attribution: '카카오맵 영업 확인 (2026-10-19)'
      });
      for (const ls of Object.values(LIST_SOURCES)) {
        const used = kakaoRests.filter(r => r.groupProfile.evidenceRefs.includes(ls.id));
        if (!used.length) continue;
        sources.push({
          id: ls.id,
          kind: 'public_list',
          url: ls.url,
          obtainedAt: '2026-10-19',
          checkedAt: '2026-10-19',
          factScope: used.slice(0, 5).map(r => ({ entityId: r.id, fieldPath: '/name' })),
          usageTerms: '식당 이름·주소 목록 (현재 영업·학교 이용·학생 단체 적합성 증빙 아님)',
          attribution: ls.attribution
        });
      }
    }

    const regionData = {
      schemaVersion: PUBLIC_SCHEMA_VERSION,
      datasetVersion: DATASET_VERSION,
      generatedAt: GENERATED_AT,
      regionCode: code,
      restaurants,
      venues,
      eventReferences,
      visitRecords: [],
      sources
    };

    regionDatasets[code] = regionData;

    // 식당이 많아져 들여쓰기 없이, 기본값(미확인·null)과 같은 항목은 빼고 저장한다 (전국 보기 로딩 크기 줄이기)
    const storedRestaurants = restaurants.map(compactRestaurantForStorage);
    storedRestaurants.forEach((stored, i) => {
      if (!sameShape(expandStoredRestaurant(stored), restaurants[i])) {
        throw new Error(`기본값 생략 저장 후 복원 결과가 원본과 다릅니다: ${restaurants[i].id}`);
      }
    });
    const jsonText = JSON.stringify({ ...regionData, restaurants: storedRestaurants }) + '\n';
    fs.writeFileSync(path.join(ROOT_DIR, relPath), jsonText, 'utf8');
    const hash = sha256Hex(jsonText);
    checksums[relPath] = hash;

    const groupVerifiedCount = restaurants.filter(r => r.groupProfile?.availability === 'yes').length;
    const unverifiedCoordCount = restaurants.filter(r => r.location?.status === 'unverified').length;

    regionFilesMeta[code] = {
      regionCode: code,
      path: relPath,
      restaurantCount: restaurants.length,
      groupVerifiedCount,
      unverifiedCoordCount,
      updatedAt: kakaoRests.length ? '2026-10-19' : '2026-10-18',
      checksum: hash
    };

    for (const r of restaurants) {
      idIndexEntries[`restaurant:${r.id}`] = {
        kind: 'restaurant',
        id: r.id,
        regionCode: code,
        datasetPath: relPath,
        status: 'active'
      };
      searchIndexEntries.push({
        id: r.id,
        regionCode: code,
        name: r.name,
        branchName: r.branchName,
        regionName: reg.name,
        shortRegionName: reg.shortName,
        categories: r.categoryIds,
        menuSummary: r.menuSummary || r.menus.map(m => m.name).join(', '),
        address: r.address,
        note: r.note || '',
        hasGroupInfo: r.groupProfile?.availability !== 'unknown',
        hasVerifiedCoords: r.location?.status === 'verified'
      });
    }

    for (const v of venues) {
      idIndexEntries[`venue:${v.id}`] = {
        kind: 'venue',
        id: v.id,
        regionCode: code,
        datasetPath: relPath,
        status: 'active'
      };
    }

    for (const er of eventReferences) {
      idIndexEntries[`eventRef:${er.id}`] = {
        kind: 'eventRef',
        id: er.id,
        regionCode: code,
        datasetPath: relPath,
        status: 'active'
      };
    }
  }

  // 공개 자료에서 제거된 ID 상태 구분을 위한 제거 이력 항목(AC40 검증 지원)
  idIndexEntries['restaurant:ysk-r-removed-999'] = {
    kind: 'restaurant',
    id: 'ysk-r-removed-999',
    regionCode: 'jn-yeosu',
    datasetPath: `data/releases/${DATASET_VERSION}/regions/jn-yeosu.json`,
    status: 'removed',
    removedAt: '2026-09-15',
    reason: '폐업 확인으로 공개 목록에서 제외됨'
  };

  const regionsFilePath = `data/releases/${DATASET_VERSION}/regions.json`;
  const regionsFile = {
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    datasetVersion: DATASET_VERSION,
    generatedAt: GENERATED_AT,
    regions: REGIONS_DEF.map(reg => ({
      ...reg,
      datasetPath: `data/releases/${DATASET_VERSION}/regions/${reg.regionCode}.json`,
      stats: {
        totalRestaurants: regionFilesMeta[reg.regionCode].restaurantCount,
        groupVerifiedCount: regionFilesMeta[reg.regionCode].groupVerifiedCount,
        unverifiedCoordCount: regionFilesMeta[reg.regionCode].unverifiedCoordCount,
        updatedAt: regionFilesMeta[reg.regionCode].updatedAt
      }
    }))
  };
  const regionsJson = JSON.stringify(regionsFile, null, 2) + '\n';
  fs.writeFileSync(path.join(ROOT_DIR, regionsFilePath), regionsJson, 'utf8');
  checksums[regionsFilePath] = sha256Hex(regionsJson);

  const searchIndexPath = `data/releases/${DATASET_VERSION}/search-index.json`;
  const searchIndex = {
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    datasetVersion: DATASET_VERSION,
    generatedAt: GENERATED_AT,
    entries: searchIndexEntries
  };
  const searchIndexJson = JSON.stringify(searchIndex) + '\n';
  fs.writeFileSync(path.join(ROOT_DIR, searchIndexPath), searchIndexJson, 'utf8');
  checksums[searchIndexPath] = sha256Hex(searchIndexJson);

  const idIndexPath = `data/releases/${DATASET_VERSION}/id-index.json`;
  const idIndex = {
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    datasetVersion: DATASET_VERSION,
    generatedAt: GENERATED_AT,
    entries: idIndexEntries
  };
  const idIndexJson = JSON.stringify(idIndex, null, 2) + '\n';
  fs.writeFileSync(path.join(ROOT_DIR, idIndexPath), idIndexJson, 'utf8');
  checksums[idIndexPath] = sha256Hex(idIndexJson);

  const legacyAliasesPath = `data/releases/${DATASET_VERSION}/legacy-aliases.json`;
  const legacyAliases = {
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    datasetVersion: DATASET_VERSION,
    generatedAt: GENERATED_AT,
    favoriteKeys,
    placeNames,
    legacyNumericIds
  };
  const legacyAliasesJson = JSON.stringify(legacyAliases, null, 2) + '\n';
  fs.writeFileSync(path.join(ROOT_DIR, legacyAliasesPath), legacyAliasesJson, 'utf8');
  checksums[legacyAliasesPath] = sha256Hex(legacyAliasesJson);

  const manifestPath = 'data/manifest.json';
  const manifest = {
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    datasetVersion: DATASET_VERSION,
    previousDatasetVersion: null,
    generatedAt: GENERATED_AT,
    regionsPath: regionsFilePath,
    regionFiles: regionFilesMeta,
    searchIndexPath,
    idIndexPath,
    legacyAliasesPath,
    checksums,
    changeSummary: '기존 여수(70)·순천(75)·광양(21) 총 166개 식당을 영구 ID(ysk-r-*) 및 schemaVersion 2 지역 분할 구조로 이전'
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(ROOT_DIR, manifestPath), manifestJson, 'utf8');

  const checkResult = validateDatasetBundleCrossReferences({
    manifest,
    regionsFile,
    searchIndex,
    idIndex,
    legacyAliases,
    regionDatasets
  });

  if (!checkResult.valid) {
    console.error('데이터 번들 검증 실패:', checkResult.errors);
    process.exit(1);
  }

  console.log(`[build-dataset] 완료: datasetVersion=${DATASET_VERSION}, 총 식당=${searchIndexEntries.length}곳, 지역=${REGIONS_DEF.length}개`);
}

buildDataset();
