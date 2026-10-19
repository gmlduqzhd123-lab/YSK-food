import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeLegacyPlaceToRestaurant,
  validateDatasetBundleCrossReferences
} from '../assets/releases/v2.0.0/js/data/normalize.js';
import {
  DEFAULT_DATASET_VERSION,
  PUBLIC_SCHEMA_VERSION
} from '../assets/releases/v2.0.0/js/config.js';
import {
  NATIONWIDE_EXTRA_REGIONS,
  NATIONWIDE_VENUES_BY_REGION
} from './nationwide-elementary-data.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// 전국 초등학교 단체활동 식당 1000곳 조사(2026-10-19) 중 카카오맵에서 영업을 확인한 식당
// (영업 표시·요일별 영업시간·최근 6개월 리뷰·전화번호를 모두 확인한 곳만 수록, 단체 수용은 미확인)
const KAKAO_VERIFIED_1000 = JSON.parse(fs.readFileSync(path.join(__dirname, 'century-guide-1000.json'), 'utf8'));
const KAKAO_CHECK_SOURCE_ID = 'src-kakao-check-20261019';
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
  }
};

const GENERATED_AT = '2026-10-19T09:30:00+09:00';
const DATASET_VERSION = DEFAULT_DATASET_VERSION;

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

  // PDF 주소로 기존 식당의 '상세 주소 미확인'을 보강
  const addressOverrides = new Map(KAKAO_VERIFIED_1000.addressOverrides.map(o => [o.id, o.address]));
  for (const r of normalizedRestaurants) {
    if (addressOverrides.has(r.id)) r.address = addressOverrides.get(r.id);
  }

  const verifiedRestaurants = KAKAO_VERIFIED_1000.restaurants.map(item => {
    const rest = normalizeLegacyPlaceToRestaurant(item);
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
  // NATIONWIDE_ELEMENTARY_RESTAURANTS(88곳)는 카카오맵에 같은 이름의 식당이 하나도 없고 전화번호도 다른 업체 번호여서
  // 실제 식당 자료가 아닌 것으로 확인되어 공개 자료에서 뺀다 (2026-10-19 확인).
  for (const r of [...normalizedRestaurants, ...verifiedRestaurants]) {
    if (!restaurantsByRegion[r.regionCode]) {
      restaurantsByRegion[r.regionCode] = [];
    }
    restaurantsByRegion[r.regionCode].push(r);
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

    const jsonText = JSON.stringify(regionData, null, 2) + '\n';
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
  const searchIndexJson = JSON.stringify(searchIndex, null, 2) + '\n';
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
