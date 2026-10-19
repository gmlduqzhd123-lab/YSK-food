// 공개 지도 설정 · 자료 경로 · 제보 전달 안내 · 버전 상수
export const APP_VERSION = 'v2.0.0';
export const DEFAULT_DATASET_VERSION = '2026.10.1';
export const PUBLIC_SCHEMA_VERSION = 2;
export const PERSONAL_SCHEMA_VERSION = 1;
export const SOURCE_APP = 'ysk-food';

export const KAKAO_APP_KEY = '445297c316aa9c088ff6c8c40cc341fa';
export const KAKAO_SDK_URL = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_APP_KEY}&libraries=services,clusterer&autoload=false`;
export const KAKAO_SDK_TIMEOUT_MS = 8000;

export const LEGACY_FAV_STORAGE_KEY = 'ysk-food-favorites';
export const UI_STORAGE_KEY = 'ysk-food-ui-v2';
export const LEGACY_GEO_CACHE_KEY = 'ysk-food-places-v1';
export const GEO_CACHE_KEY_V2 = 'ysk-food-geo-cache-v2';

export const IDB_NAME = 'ysk-food-personal-db';
export const IDB_VERSION = 1;

export const PAGE_SIZE = 50;
export const MAX_COMPARE_COUNT = 3;
export const MAX_SHARE_URL_LENGTH = 2000;
export const STALE_DAYS_THRESHOLD = 180;

export const DEFAULT_CENTER = { lat: 36.2000, lng: 127.8000 };
export const DEFAULT_LEVEL = 12;
export const SINGLE_PLACE_LEVEL = 5;
export const MY_POS_LEVEL = 6;
export const CLUSTER_MIN_LEVEL = 6;

// 남한 범위 (제주 포함). 지도는 이 범위가 한 화면에 들어오는 단계까지만 축소되고, 이 범위 밖으로는 옮겨지지 않는다
export const SOUTH_KOREA_VIEW_BOUNDS = { sw: { lat: 33.1, lng: 126.0 }, ne: { lat: 38.6, lng: 129.6 } };

// 남한 바깥(북한·중국·일본)을 흐리게 덮을 때 뚫어 둘 남한 영역 (해안·섬을 넉넉히 포함한 대략적인 경계, [위도, 경도])
export const SOUTH_KOREA_MASK_HOLE = [
  [37.62, 124.4], [37.72, 126.1], [37.76, 126.62], [37.95, 126.68], [38.1, 127.1], [38.3, 127.6],
  [38.32, 128.1], [38.62, 128.32], [38.64, 128.7], [38.64, 132.2], [36.4, 132.2], [35.35, 129.85],
  [34.88, 129.2], [34.5, 128.95], [33.8, 128.55], [32.8, 127.9], [32.8, 124.4]
];

export const REGION_COLORS = {
  'seoul-jongno': '#2563eb',
  'gyeonggi-suwon': '#3b82f6',
  'incheon-junggu': '#0284c7',
  'gw-gangneung': '#0d9488',
  'gw-chuncheon': '#14b8a6',
  'daejeon-yuseong': '#7c3aed',
  'cn-gongju': '#8b5cf6',
  'gb-gyeongju': '#d97706',
  'daegu-junggu': '#ea580c',
  'busan-haeundae': '#0891b2',
  'gn-tongyeong': '#06b6d4',
  'jb-jeonju': '#16a34a',
  'gj-donggu': '#15803d',
  'jn-mokpo': '#2563eb',
  'jn-goheung': '#059669',
  'jn-boseong': '#65a30d',
  'jj-jeju': '#f97316',
  'jn-yeosu': '#1e88e5',
  'jn-suncheon': '#43a047',
  'jn-gwangyang': '#fb8c00',
  'seoul-etc': '#2563eb',
  'gyeonggi-etc': '#3b82f6',
  'incheon-etc': '#0284c7',
  'gw-etc': '#0d9488',
  'cb-all': '#7c3aed',
  'cn-etc': '#8b5cf6',
  'daejeon-etc': '#7c3aed',
  'sejong': '#6d28d9',
  'jb-etc': '#16a34a',
  'gj-etc': '#15803d',
  'jn-etc': '#059669',
  'gb-etc': '#d97706',
  'daegu-etc': '#ea580c',
  'gn-etc': '#06b6d4',
  'busan-etc': '#0891b2',
  'ulsan': '#0e7490',
  '서울 종로': '#2563eb',
  '수원·용인': '#3b82f6',
  '인천': '#0284c7',
  '강릉': '#0d9488',
  '춘천': '#14b8a6',
  '대전 유성': '#7c3aed',
  '공주·부여': '#8b5cf6',
  '경주': '#d97706',
  '대구': '#ea580c',
  '부산 해운대': '#0891b2',
  '통영·거제': '#06b6d4',
  '전주': '#16a34a',
  '광주 동구': '#15803d',
  '목포': '#2563eb',
  '고흥군': '#059669',
  '제주': '#f97316',
  '여수': '#1e88e5',
  '순천': '#43a047',
  '광양': '#fb8c00'
};
export const DEFAULT_MARKER_COLOR = '#475569';

export const REGION_GROUPS = {
  nationwide: {
    code: 'nationwide',
    label: '전국 전체 (초등 체험학습·수학여행·선수단)',
    shortLabel: '전국 전체',
    regionCodes: null, // 모든 등록 지역
    center: { lat: 36.25, lng: 127.85, zoomLevel: 12 },
    bounds: { sw: { lat: 33.20, lng: 126.10 }, ne: { lat: 38.30, lng: 129.60 } }
  },
  'seoul-metro': {
    code: 'seoul-metro',
    label: '서울·수도권 (서울·경기·인천)',
    shortLabel: '서울·수도권',
    regionCodes: ['seoul-jongno', 'gyeonggi-suwon', 'incheon-junggu', 'seoul-etc', 'gyeonggi-etc', 'incheon-etc'],
    center: { lat: 37.45, lng: 127.02, zoomLevel: 11 },
    bounds: { sw: { lat: 36.96, lng: 126.43 }, ne: { lat: 37.95, lng: 127.60 } }
  },
  'gw-all': {
    code: 'gw-all',
    label: '강원권',
    shortLabel: '강원',
    regionCodes: ['gw-gangneung', 'gw-chuncheon', 'gw-etc'],
    center: { lat: 37.70, lng: 128.28, zoomLevel: 11 },
    bounds: { sw: { lat: 37.13, lng: 127.26 }, ne: { lat: 38.27, lng: 129.29 } }
  },
  'cc-all': {
    code: 'cc-all',
    label: '대전·세종·충청권',
    shortLabel: '대전·충청',
    regionCodes: ['daejeon-yuseong', 'cn-gongju', 'daejeon-etc', 'sejong', 'cb-all', 'cn-etc'],
    center: { lat: 36.63, lng: 127.31, zoomLevel: 11 },
    bounds: { sw: { lat: 36.07, lng: 126.37 }, ne: { lat: 37.19, lng: 128.26 } }
  },
  'gb-all': {
    code: 'gb-all',
    label: '대구·경북권',
    shortLabel: '대구·경북',
    regionCodes: ['gb-gyeongju', 'daegu-junggu', 'gb-etc', 'daegu-etc'],
    center: { lat: 36.35, lng: 128.72, zoomLevel: 11 },
    bounds: { sw: { lat: 35.59, lng: 127.97 }, ne: { lat: 37.11, lng: 129.47 } }
  },
  'pk-all': {
    code: 'pk-all',
    label: '부산·울산·경남권',
    shortLabel: '부산·울산·경남',
    regionCodes: ['busan-haeundae', 'gn-tongyeong', 'busan-etc', 'gn-etc', 'ulsan'],
    center: { lat: 35.21, lng: 128.66, zoomLevel: 11 },
    bounds: { sw: { lat: 34.77, lng: 127.93 }, ne: { lat: 35.65, lng: 129.38 } }
  },
  'honam-west': {
    code: 'honam-west',
    label: '광주·전북·전남 (여수·순천·광양 외)',
    shortLabel: '전북·광주·전남',
    regionCodes: ['jb-jeonju', 'gj-donggu', 'jn-mokpo', 'jn-goheung', 'jb-etc', 'gj-etc', 'jn-etc'],
    center: { lat: 35.23, lng: 127.00, zoomLevel: 11 },
    bounds: { sw: { lat: 34.40, lng: 126.33 }, ne: { lat: 36.06, lng: 127.66 } }
  },
  all: {
    code: 'all',
    label: '전남 동부 (여수·순천·광양)',
    shortLabel: '여수·순천·광양',
    regionCodes: ['jn-yeosu', 'jn-suncheon', 'jn-gwangyang'],
    center: { lat: 34.85, lng: 127.60, zoomLevel: 9 },
    bounds: { sw: { lat: 34.60, lng: 127.30 }, ne: { lat: 35.12, lng: 127.82 } }
  }
};

export const APP_MODES = [
  { id: 'general', label: '일반 맛집', shortLabel: '일반', desc: '전국 지역·메뉴별 맛집과 영업시간 탐색' },
  { id: 'school', label: '학교 단체식사', shortLabel: '학교행사', desc: '초등학교 선생님·초등학생 현장체험학습·수학여행 맞춤 식사 (술집·카페 자동 제외)' },
  { id: 'athlete', label: '선수단 식사', shortLabel: '선수단', desc: '초등 스포츠클럽·전국소년체전·전지훈련 영양 식사 (술집·카페 자동 제외)' }
];

export const EVENT_PRESETS = {
  field_trip: {
    id: 'field_trip',
    label: '현장체험학습 (초등)',
    mode: 'school',
    seatingPolicy: 'simultaneous_required',
    providerType: 'restaurant',
    highlightFields: ['simultaneousCapacity', 'busEntry', 'busParkingSpaces', 'servingMinutes'],
    guideText: '초등학생·선생님 동시 착석 인원, 대형버스 승하차 위치, 안 매운 어린이 맞춤 메뉴(돈가스·불고기·떡갈비·백반)를 우선 추천합니다.'
  },
  retreat: {
    id: 'retreat',
    label: '수련활동',
    mode: 'school',
    seatingPolicy: 'simultaneous_required',
    providerType: 'lodging',
    highlightFields: ['providerType', 'simultaneousCapacity', 'busParkingSpaces'],
    guideText: '외부 식당 식사와 수련원·숙소 제공 식사(숙박비 포함 또는 별도 식비)를 구분해 관리합니다.'
  },
  school_trip: {
    id: 'school_trip',
    label: '수학여행 (초등)',
    mode: 'school',
    seatingPolicy: 'simultaneous_required',
    providerType: 'restaurant',
    highlightFields: ['simultaneousCapacity', 'mealWaves', 'busParkingSpaces', 'preOrder'],
    guideText: '경주·서울·수원·강릉·전주·제주 등 수학여행지별 대형버스 주차와 초등학생 맞춤 반상·돈가스·떡갈비 식당을 우선 추천합니다.'
  },
  school_sports_club: {
    id: 'school_sports_club',
    label: '학교스포츠클럽대회',
    mode: 'athlete',
    seatingPolicy: 'waves_allowed',
    providerType: 'restaurant',
    highlightFields: ['earlyBreakfast', 'lunchbox', 'mealWaves', 'venueDistance'],
    guideText: '경기장 기준 거리, 경기 시간 변경 시 재확인, 도시락 수령 및 선수단 영양 식사(불고기·갈비탕·설렁탕·돈가스)를 우선 추천합니다.'
  },
  national_youth_sports: {
    id: 'national_youth_sports',
    label: '전국소년체육대회',
    mode: 'athlete',
    seatingPolicy: 'waves_allowed',
    providerType: 'restaurant',
    highlightFields: ['earlyBreakfast', 'lunchbox', 'mealWaves', 'venueDistance'],
    guideText: '초등부·중등부 선수단 경기장 인근의 이른 아침식사(조식)·도시락 및 단백질 보충 식사(갈비탕·불고기·삼계탕·떡갈비)를 우선 추천합니다.'
  },
  national_sports_festival: {
    id: 'national_sports_festival',
    label: '전국체육대회',
    mode: 'athlete',
    seatingPolicy: 'waves_allowed',
    providerType: 'restaurant',
    highlightFields: ['earlyBreakfast', 'lunchbox', 'mealWaves', 'venueDistance'],
    guideText: '개최지 경기장 기준점 설정과 이른 조식·도시락·선수단 회차 배정을 지원합니다.'
  },
  national_sports: {
    id: 'national_sports',
    label: '전국체전',
    mode: 'athlete',
    seatingPolicy: 'waves_allowed',
    providerType: 'restaurant',
    highlightFields: ['earlyBreakfast', 'lunchbox', 'mealWaves', 'venueDistance'],
    guideText: '개최 연도·종목·경기장별 기준점 설정과 이른 조식·도시락·선수단 회차 배정을 지원합니다.'
  },
  other_tournament: {
    id: 'other_tournament',
    label: '기타 체육대회',
    mode: 'athlete',
    seatingPolicy: 'waves_allowed',
    providerType: 'restaurant',
    highlightFields: ['earlyBreakfast', 'lunchbox', 'mealWaves', 'venueDistance'],
    guideText: '종목별 경기 일정과 대진 변경에 따른 식사 시간 재확인 및 포장 전환을 관리합니다.'
  },
  training_camp: {
    id: 'training_camp',
    label: '수련활동·전지훈련',
    mode: 'athlete',
    seatingPolicy: 'simultaneous_required',
    providerType: 'restaurant',
    highlightFields: ['earlyBreakfast', 'multiDay', 'RepeatVisit', 'budget'],
    guideText: '연속 날짜의 조식·중식·석식 일정을 생성하고 식단·인원·단가를 날짜별로 복사·관리합니다.'
  }
};

export const SUBMISSION_CONFIG = {
  configured: false,
  deliveryChannel: null,
  guideMessage: '현재 온라인 자동 제출 경로가 설정되지 않았습니다. 작성한 제보·이용 기록 초안은 브라우저에 저장되며, JSON 파일로 내보내어 운영자에게 전달해 주세요. (내보내기 완료가 공용 지도 즉시 반영을 뜻하지 않습니다.)'
};

export const ALLOWED_SHARE_PARAMS = [
  'restaurantId',
  'restaurantIds',
  'region',
  'mode',
  'q',
  'category',
  'fav',
  'open'
];

/**
 * 앱 루트 URL(/YSK-food/ 등)을 한 번 결정한다.
 * index.html?restaurantId=... 진입이나 하위 경로에서도 동일한 APP_BASE를 반환한다.
 */
export function resolveAppBase(loc = globalThis.location) {
  if (!loc || !loc.origin) return 'https://gmlduqzhd123-lab.github.io/YSK-food/';
  let pathname = loc.pathname || '/';
  // 모듈 경로(/assets/releases/...)나 /tools/, /tests/ 등이 포함된 경우 상위 루트로 정규화
  const assetIdx = pathname.indexOf('/assets/releases/');
  if (assetIdx >= 0) {
    pathname = pathname.slice(0, assetIdx + 1);
  }
  if (pathname.endsWith('/index.html')) {
    pathname = pathname.slice(0, -'index.html'.length);
  } else if (!pathname.endsWith('/')) {
    const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
    if (lastSegment.includes('.')) {
      pathname = pathname.slice(0, pathname.lastIndexOf('/') + 1);
    } else {
      pathname = pathname + '/';
    }
  }
  return new URL(pathname, loc.origin).href;
}

export const APP_BASE = resolveAppBase();

export function resolveAppUrl(relativePath, base = APP_BASE) {
  const clean = String(relativePath || '').replace(/^(\.\/|\/)+/, '');
  return new URL(clean, base).href;
}
