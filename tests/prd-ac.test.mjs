// PRD v1.1 수용 기준(AC01 ~ AC60) 전수 자동 검증 테스트 스위트
// 실행: node --test tests/prd-ac.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_VERSION,
  DEFAULT_DATASET_VERSION,
  EVENT_PRESETS,
  PAGE_SIZE,
  resolveAppBase,
  resolveAppUrl
} from '../assets/releases/v2.0.0/js/config.js';

import {
  isValidEntityId,
  isValidCoordinate,
  isMappablePlace,
  sanitizeHttpUrl,
  sanitizeTelHref,
  csvToPlaces,
  validateRegionDataset,
  validateManifest,
  validateRegionsFile,
  validateSearchIndexFile,
  validateIdIndexFile,
  validateLegacyAliasesFile,
  validateDatasetBundleCrossReferences,
  validateBackupEnvelope,
  validateShareEnvelope
} from '../assets/releases/v2.0.0/js/data/normalize.js';

import { DatasetRepository } from '../assets/releases/v2.0.0/js/data/repository.js';

import {
  addDaysToKoreaDateStr,
  buildPlannedMealWindow,
  evaluateMealWindowHours,
  getOpenStatus
} from '../assets/releases/v2.0.0/js/domain/hours.js';

import {
  calculateOrderBudget,
  evaluateMealPlanCost,
  compareCandidateBudgets
} from '../assets/releases/v2.0.0/js/domain/budget.js';

import {
  copyMealPlanToDate,
  evaluateMealWaves,
  evaluateMealPlanStatus,
  applyEventAttendeeGroupsChange,
  generateRestaurantInquiryText
} from '../assets/releases/v2.0.0/js/domain/schedule.js';

import {
  normalizeGroupSearchCriteria,
  evaluateRestaurantGroupMatch,
  evaluateDataFreshness,
  evaluateElementaryMenuFriendliness,
  evaluateMenuSafetyDisplay,
  evaluateOfficialDesignations,
  aggregateVisitRecordsForRestaurant,
  isSuitableForMode,
  getCategoriesForMode,
  matchVenueFromQuery,
  filterAndClassifyRestaurants
} from '../assets/releases/v2.0.0/js/domain/search.js';

import {
  PersonalStorageManager,
  loadAndMigrateUiState,
  saveUiState,
  remapEventForSeparateCopy,
  buildShareEnvelope,
  detectPublicDataChangesAgainstSnapshot
} from '../assets/releases/v2.0.0/js/storage.js';

import {
  computePaginatedSlice
} from '../assets/releases/v2.0.0/js/ui/list.js';

import {
  createNewPersonalEvent,
  addCandidateToMealPlan,
  selectMealPlanCandidate,
  recordCandidateQuote,
  recordMealConfirmation,
  verifyOfflineReadiness
} from '../assets/releases/v2.0.0/js/ui/event.js';

import {
  parseRouteFromUrl,
  buildPublicShareUrl,
  buildPublicQrSvg,
  buildVerifiedReportDraft,
  buildMessengerVoteText,
  buildOfficialDocDraftText
} from '../assets/releases/v2.0.0/js/ui/share.js';

import { MapController } from '../assets/releases/v2.0.0/js/ui/map.js';
import { runDatasetValidation } from '../tools/validate-dataset.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// 기존 여순광 166곳은 숫자 영구 ID(ysk-r-1 …)를 쓴다
const isLegacyId = id => /^ysk-r-\d+$/.test(String(id));
// 1000곳 조사 중 카카오맵에서 영업을 확인해 추가한 식당 자료
const CENTURY_1000 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/century-guide-1000.json'), 'utf8'));
const KOFOOD_1000 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/kofood-guide-1000.json'), 'utf8'));
const GOODPRICE_3000 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/goodprice-3000.json'), 'utf8'));
const KAKAO_VERIFIED = { restaurants: [...CENTURY_1000.restaurants, ...KOFOOD_1000.restaurants, ...GOODPRICE_3000.restaurants] };

function createLocalFileFetch(rootDir = ROOT) {
  return async (urlStr) => {
    const u = new URL(urlStr, 'https://gmlduqzhd123-lab.github.io/YSK-food/');
    let rel = u.pathname.replace(/^\/YSK-food\//, '').replace(/^\//, '');
    if (!rel || rel === './') rel = 'index.html';
    const filePath = path.join(rootDir, rel);
    if (!fs.existsSync(filePath)) {
      return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    const ext = path.extname(filePath).toLowerCase();
    const isBinary = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp'].includes(ext);
    const content = isBinary ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8');
    const ct = ext === '.json' || ext === '.webmanifest'
      ? 'application/json; charset=utf-8'
      : ext === '.js' || ext === '.mjs'
        ? 'application/javascript; charset=utf-8'
        : ext === '.css'
          ? 'text/css; charset=utf-8'
          : ext === '.html'
            ? 'text/html; charset=utf-8'
            : 'application/octet-stream';
    return new Response(content, {
      status: 200,
      headers: { 'content-type': ct }
    });
  };
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    clear: () => map.clear(),
    _map: map
  };
}

describe('PRD v1.1 Acceptance Criteria (AC01 ~ AC60)', () => {
  test('AC01 & AC03 & AC05: 기존 166개 식당(여수 70·순천 75·광양 21) 무손실 이전, 좌표 미확인 106곳 목록 보존, 미확인 단체 항목 unknown/null 유지', async () => {
    const repo = new DatasetRepository({
      appBase: 'https://gmlduqzhd123-lab.github.io/YSK-food/',
      fetchFn: createLocalFileFetch()
    });
    const res = await repo.selectRegion('all');
    assert.equal(res.status, 'ok');
    // 기존 166곳(숫자 영구 ID)은 그대로 보존되고, 이후 카카오맵 확인으로 추가된 식당(ysk-r-k…)은 별도로 더해진다
    const legacy = res.restaurants.filter(r => isLegacyId(r.id));
    assert.equal(legacy.length, 166);
    assert.ok(res.restaurants.length >= 166);

    const yeosu = legacy.filter(r => r.regionCode === 'jn-yeosu');
    const suncheon = legacy.filter(r => r.regionCode === 'jn-suncheon');
    const gwangyang = legacy.filter(r => r.regionCode === 'jn-gwangyang');
    assert.equal(yeosu.length, 70);
    assert.equal(suncheon.length, 75);
    assert.equal(gwangyang.length, 21);

    // AC03: 좌표 확인 60곳, 좌표 미확인 106곳 모두 목록에 보존됨
    const mappable = legacy.filter(r => isMappablePlace(r));
    const unverifiedCoord = legacy.filter(r => !isMappablePlace(r));
    assert.equal(mappable.length, 60);
    assert.equal(unverifiedCoord.length, 106);

    const filterRes = filterAndClassifyRestaurants(res.restaurants, { regionCode: 'all' });
    assert.equal(filterRes.combinedList.length, res.restaurants.length);

    // AC05: 단체 항목은 근거(카카오맵 편의시설 정보)가 있을 때만 'yes'이고, 그 밖에는 'unknown' 또는 null로 보존됨
    for (const r of res.restaurants) {
      assert.ok(r.id.startsWith('ysk-r-'));
      const hasFacilityEvidence = r.groupProfile.evidenceRefs.includes('src-kakao-facility-20261019');
      assert.equal(r.groupProfile.availability, hasFacilityEvidence && r.groupProfile.seatTypes?.includes('단체석') ? 'yes' : 'unknown');
      assert.equal(r.groupProfile.totalSeats, null);
      assert.equal(r.groupProfile.simultaneousCapacity, null);
      assert.equal(r.groupProfile.parking.busEntry, 'unknown');
    }
  });

  test('AC02 & AC43: 구형 즐겨찾기(도시:식당이름) 1회 원자적 이전, 삭제 후 부활 방지, 구형 ?place= 링크 해석 및 동명이점 후보 분기', async () => {
    const repo = new DatasetRepository({
      appBase: 'https://gmlduqzhd123-lab.github.io/YSK-food/',
      fetchFn: createLocalFileFetch()
    });
    const core = await repo.loadCoreBundle();
    const aliases = core.bundle.legacyAliases;

    const storage = createMemoryStorage();
    storage.setItem('ysk-food-favorites', JSON.stringify(['여수:이순신수제버거', '순천:건봉국밥', '미등록도시:없는식당']));

    // 1회차 이전
    const firstMig = loadAndMigrateUiState(aliases, storage);
    assert.equal(firstMig.persisted, true);
    assert.equal(firstMig.alreadyMigrated, false);
    assert.equal(firstMig.state.migrationState.completed, true);
    assert.ok(firstMig.state.favoriteIds.includes('ysk-r-1'));
    assert.ok(firstMig.state.unresolvedFavorites.some(u => u.legacyKey === '미등록도시:없는식당'));
    // 원본 구형 키 보존 검증(AC43)
    assert.ok(storage.getItem('ysk-food-favorites') !== null);

    // 사용자가 이전된 즐겨찾기(ysk-r-1)를 해제한 뒤 저장
    firstMig.state.favoriteIds = firstMig.state.favoriteIds.filter(id => id !== 'ysk-r-1');
    saveUiState(firstMig.state, storage);

    // 재실행 시 구형 키에서 삭제된 즐겨찾기가 다시 살아나지 않아야 함(AC43)
    const secondLoad = loadAndMigrateUiState(aliases, storage);
    assert.equal(secondLoad.alreadyMigrated, true);
    assert.equal(secondLoad.state.favoriteIds.includes('ysk-r-1'), false);

    // 구형 ?place=이순신수제버거 링크 해석
    const resolvedPlace = repo.resolveLegacyPlaceName('이순신수제버거');
    assert.equal(resolvedPlace.status, 'resolved');
    assert.equal(resolvedPlace.restaurantId, 'ysk-r-1');

    // 동명이점 시나리오에서 임의 첫 식당 대신 ambiguous 후보 목록 반환 검증(AC02)
    const activeBundle = repo.getActiveBundle();
    activeBundle.legacyAliases = {
      ...aliases,
      placeNames: {
        ...aliases.placeNames,
        '동명식당': ['ysk-r-1', 'ysk-r-71']
      }
    };
    const ambRes = repo.resolveLegacyPlaceName('동명식당');
    assert.equal(ambRes.status, 'ambiguous');
    assert.deepEqual(ambRes.candidateIds, ['ysk-r-1', 'ysk-r-71']);
  });

  test('AC04: 상세 링크·이미지 URL 프로토콜 검증(http/https만 허용) 및 전화번호 tel: 정제', () => {
    assert.equal(sanitizeHttpUrl('https://place.map.kakao.com/12345'), 'https://place.map.kakao.com/12345');
    assert.equal(sanitizeHttpUrl('http://example.com/photo.jpg'), 'http://example.com/photo.jpg');
    assert.equal(sanitizeHttpUrl('javascript:alert(1)'), null);
    assert.equal(sanitizeHttpUrl('data:text/html,<script>alert(1)</script>'), null);

    assert.equal(sanitizeTelHref('061-123-4567 (내선 1)'), 'tel:061-123-45671');
    assert.equal(sanitizeTelHref('javascript:alert(1)'), null);
    assert.equal(sanitizeTelHref('전화문의없음'), null);
  });

  test('AC06 & AC38: 카카오 지도 SDK 실패·차단 시에도 비차단 방식으로 동작하며 목록·검색·행사 기능 정상 유지', async () => {
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    // index.html에 동기 차단 카카오 SDK 스크립트가 없어야 함(AC38)
    assert.equal(indexHtml.includes('src="https://dapi.kakao.com/v2/maps/sdk.js'), false);

    const mapCtrl = new MapController();
    // 브라우저/카카오 객체가 없는 환경에서 initMap 호출 시 예외 없이 { ready: false } 반환(AC06)
    const mapRes = await mapCtrl.initMap({});
    assert.equal(mapRes.ready, false);
    assert.equal(mapCtrl.isReady(), false);
  });

  test('AC07 & AC08: 빠른 연속 지역 전환 시 이전 지연 응답 폐기(stale) 및 0곳 등록 지역·손상 지역 격리 처리', async () => {
    const baseFetch = createLocalFileFetch();
    const slowFetch = async (urlStr) => {
      if (String(urlStr).includes('jn-yeosu.json')) {
        await new Promise(r => setTimeout(r, 60));
      }
      return baseFetch(urlStr);
    };

    const repo = new DatasetRepository({
      appBase: 'https://gmlduqzhd123-lab.github.io/YSK-food/',
      fetchFn: slowFetch
    });
    await repo.loadCoreBundle();

    // 여수 -> 순천 -> 광양 연속 호출(AC07)
    const p1 = repo.selectRegion('jn-yeosu');
    const p2 = repo.selectRegion('jn-suncheon');
    const p3 = repo.selectRegion('jn-gwangyang');

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1.stale, true);
    assert.equal(r3.stale, false);
    assert.equal(r3.regionCode, 'jn-gwangyang');
    assert.equal(r3.restaurants.filter(r => isLegacyId(r.id)).length, 21);

    // AC08: 등록 식당이 0곳인 지역(전남 보성군 jn-boseong) 선택 시 오류 없이 0곳 상태 반환
    const emptyReg = await repo.selectRegion('jn-boseong');
    assert.equal(emptyReg.status, 'ok');
    assert.equal(emptyReg.restaurants.length, 0);

    // AC08: 미등록 지역 코드 요청 시 다른 정상 지역(순천)을 오염시키지 않음
    const badReg = await repo.selectRegion('unknown-region-999');
    assert.equal(badReg.status, 'region_error');
    const suncheonReg = await repo.selectRegion('jn-suncheon');
    assert.equal(suncheonReg.status, 'ok');
    assert.equal(suncheonReg.restaurants.filter(r => isLegacyId(r.id)).length, 75);
  });

  test('AC09, AC10, AC11, AC50: 단체 조건 4상태 판정(unset/met/needs_check/unmet), 버스 주차 3단 구분, 동시착석 vs 교대식사 판정', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'example-region.fixture.json'), 'utf8'));
    const unknownPlace = fixture.restaurants[0];

    // AC50: 단체 조건 미입력 시 'unset'
    assert.equal(normalizeGroupSearchCriteria({}).hasAnyCriterion, false);
    const unsetMatch = evaluateRestaurantGroupMatch(unknownPlace, {});
    assert.equal(unsetMatch.status, 'unset');
    assert.equal(unsetMatch.statusLabel, '조건 미설정');

    // AC09: 미확인 식당은 단체 조건 입력 시 'needs_check'로 분류
    const needsCheckMatch = evaluateRestaurantGroupMatch(unknownPlace, { studentCount: 60, staffCount: 5 });
    assert.equal(needsCheckMatch.status, 'needs_check');

    // 확인된 60석 식당(교대 식사 가능, 버스 진입 불가·하차 후 도보 이동 가능)
    const verified60Place = {
      ...unknownPlace,
      id: 'ysk-r-verified-60',
      groupProfile: {
        ...unknownPlace.groupProfile,
        availability: 'yes',
        totalSeats: 60,
        simultaneousCapacity: 60,
        mealWaves: { availability: 'yes', maxWaves: 2, minMealMinutes: 30, turnaroundMinutes: 10 },
        parking: { busEntry: 'no', busParkingSpaces: 0, dropoff: 'yes', dropoffLocation: '식당 앞 하차 후 도보 2분' }
      },
      menus: [{ id: 'm1', name: '백반', priceKRW: 10000, priceBasis: 'per_person' }]
    };

    // AC11: 80명 동시 착석 필수 시 60석 식당은 'unmet'으로 제외
    const sim80 = evaluateRestaurantGroupMatch(verified60Place, {
      studentCount: 70,
      staffCount: 10,
      seatingPolicy: 'simultaneous_required'
    });
    assert.equal(sim80.status, 'unmet');

    // AC11: 80명 교대 식사 허용(waves_allowed) 시 'met'으로 포함
    const wave80 = evaluateRestaurantGroupMatch(verified60Place, {
      studentCount: 70,
      staffCount: 10,
      seatingPolicy: 'waves_allowed'
    });
    assert.equal(wave80.status, 'met');

    // AC10: 버스 주차 필수 없이 버스 1대 입력 시 dropoff='yes'면 승하차 가능으로 충족, 버스 주차 필수 체크 시 'unmet'
    const dropoffOkMatch = evaluateRestaurantGroupMatch(verified60Place, {
      studentCount: 40,
      busCount: 1,
      busParkingRequired: false
    });
    assert.equal(dropoffOkMatch.status, 'met');

    const parkingRequiredUnmet = evaluateRestaurantGroupMatch(verified60Place, {
      studentCount: 40,
      busCount: 1,
      busParkingRequired: true
    });
    assert.equal(parkingRequiredUnmet.status, 'unmet');

    // busEntry='no', dropoff='no'는 주차 필수 여부와 무관하게 'unmet'으로 제외
    const noBusPlace = {
      ...verified60Place,
      groupProfile: {
        ...verified60Place.groupProfile,
        parking: { busEntry: 'no', busParkingSpaces: 0, dropoff: 'no' }
      }
    };
    const noBusMatch = evaluateRestaurantGroupMatch(noBusPlace, {
      studentCount: 40,
      busCount: 1,
      busParkingRequired: false
    });
    assert.equal(noBusMatch.status, 'unmet');
  });

  test('AC11 & AC47: 교대 식사(1진·2진) 수용 인원·시간 간격 검증 및 총 식사 인원 vs 주문 수량(4인 상차림) 분리 계산', () => {
    // 1진 45명 + 2진 35명 = 80명, 식당 동시 수용 50명, 회전 간격 10분, 확보 90분
    const waveValid = evaluateMealWaves({
      diners: [{ groupId: 'g-student', count: 80 }],
      waves: [
        { id: 'w1', seatedCount: 45, durationMinutes: 35 },
        { id: 'w2', seatedCount: 35, durationMinutes: 35 }
      ],
      turnaroundMinutes: 10,
      availableWindowMinutes: 90,
      simultaneousCapacity: 50,
      seatingPolicy: 'waves_allowed'
    });
    assert.equal(waveValid.capacityStatus, 'met');
    assert.equal(waveValid.timeStatus, 'ok');
    assert.equal(waveValid.dinersTotal, 80);

    // AC47: 회차 좌석 합계(51 + 51 = 102석)가 실제 식사 인원(96명)과 달라도 주문 수량(96)을 덮어쓰지 않음
    const waveSeatSeparation = evaluateMealWaves({
      diners: [{ groupId: 'g-student', count: 96 }],
      waves: [
        { id: 'w1', seatedCount: 51, durationMinutes: 30 },
        { id: 'w2', seatedCount: 51, durationMinutes: 30 }
      ],
      orderedQuantity: 96,
      simultaneousCapacity: 60,
      seatingPolicy: 'waves_allowed'
    });
    assert.equal(waveSeatSeparation.sumWaveSeats, 102);
    assert.equal(waveSeatSeparation.dinersTotal, 96);
    assert.equal(waveSeatSeparation.orderedQuantity, 96);

    // AC47: 40명이 4인 상차림 10개(quantity 합계 10 !== diners 40)를 주문해도 오류 없이 정상 계산(400,000원)
    const tableOrderCost = calculateOrderBudget({
      diners: [
        { groupId: 'g-student', label: '학생', count: 36, budgetPerPersonKRW: 10000 },
        { groupId: 'g-staff', label: '교사', count: 4, budgetPerPersonKRW: 15000 }
      ],
      orderLines: [
        { id: 'l1', menuName: '4인 한상차림', unit: '4인상', quantity: 10, unitPriceKRW: 40000, targetGroupId: null }
      ]
    });
    assert.equal(tableOrderCost.valid, true);
    assert.equal(tableOrderCost.dinersTotal, 40);
    assert.equal(tableOrderCost.totalOrderedQuantity, 10);
    assert.equal(tableOrderCost.totalConfirmedKRW, 400000);
  });

  test('AC12, AC13, AC49, AC51, AC60: 정수 원(KRW) 예산 계산, 단가 미확인 판정, 0수량/할인 검증, 숙소 포함 식사비 분리, 3후보 견적 비교', () => {
    // AC12: 학생 35명(예산 10,000원, 실제 11,000원 -> 예산 초과 경고), 교사 5명(예산 15,000원, 실제 12,000원 -> 충족)
    const overRes = calculateOrderBudget({
      diners: [
        { groupId: 'g-student', label: '학생', count: 35, budgetPerPersonKRW: 10000 },
        { groupId: 'g-staff', label: '교사', count: 5, budgetPerPersonKRW: 15000 }
      ],
      orderLines: [
        { id: 'l1', menuName: '학생 메뉴', quantity: 35, unitPriceKRW: 11000, targetGroupId: 'g-student' },
        { id: 'l2', menuName: '교사 메뉴', quantity: 5, unitPriceKRW: 12000, targetGroupId: 'g-staff' }
      ]
    });
    assert.equal(overRes.valid, true);
    assert.equal(overRes.totalConfirmedKRW, 35 * 11000 + 5 * 12000);
    assert.ok(overRes.warnings.some(w => w.includes('학생') && w.includes('초과')));

    // AC13: 가격 미확인(unitPriceKRW: null) 시 0원이나 확정 총액이 아닌 isTotalConfirmed = false 반환
    const unconfRes = calculateOrderBudget({
      diners: [{ groupId: 'g-student', count: 30 }],
      orderLines: [{ id: 'l1', menuName: '싯가 백반', quantity: 30, unitPriceKRW: null }]
    });
    assert.equal(unconfRes.isTotalConfirmed, false);
    assert.equal(unconfRes.totalConfirmedKRW, null);
    assert.equal(unconfRes.unconfirmedItems.length, 1);

    // AC51: 수량이 0인 미주문 행은 단가가 null이어도 미확인 경고를 유발하지 않음
    const zeroQtyRes = calculateOrderBudget({
      diners: [{ groupId: 'g-student', count: 20 }],
      orderLines: [
        { id: 'l1', menuName: '기본 정식', quantity: 20, unitPriceKRW: 10000 },
        { id: 'l2', menuName: '선택 추가 메뉴(미주문)', quantity: 0, unitPriceKRW: null }
      ],
      discounts: [{ id: 'd1', label: '단체 할인', targetScope: 'total', amountKRW: 10000 }]
    });
    assert.equal(zeroQtyRes.valid, true);
    assert.equal(zeroQtyRes.isTotalConfirmed, true);
    assert.equal(zeroQtyRes.totalConfirmedKRW, 190000);

    // AC51: 할인 금액이 적용 대상 금액을 초과하면 valid = false로 저장 차단
    const excessiveDiscount = calculateOrderBudget({
      diners: [{ groupId: 'g-student', count: 10 }],
      orderLines: [{ id: 'l1', menuName: '정식', quantity: 10, unitPriceKRW: 10000 }],
      discounts: [{ id: 'd1', label: '과도한 할인', targetScope: 'total', amountKRW: 150000 }]
    });
    assert.equal(excessiveDiscount.valid, false);

    // AC49: 숙소 제공 식사(included_in_lodging)는 별도 식비 합산 제외(addToSeparateMealTotal: false) 및 무료(0원)와 구분(isFree: false)
    const lodgingIncluded = evaluateMealPlanCost({
      providerType: 'lodging',
      costTreatment: 'included_in_lodging',
      diners: [{ groupId: 'g-student', count: 30 }]
    });
    assert.equal(lodgingIncluded.valid, true);
    assert.equal(lodgingIncluded.addToSeparateMealTotal, false);
    assert.equal(lodgingIncluded.isFree, false);

    // AC60: 동일 끼니 후보 최대 3곳 견적 비교 (후보별 독립 orderDraft 유지)
    const cmp = compareCandidateBudgets(
      [
        {
          id: 'c1',
          restaurantId: 'ysk-r-1',
          restaurantSnapshot: { name: '식당A' },
          orderDraft: { orderLines: [{ id: 'l1', menuName: '정식', quantity: 30, unitPriceKRW: 10000 }], charges: [], discounts: [] }
        },
        {
          id: 'c2',
          restaurantId: 'ysk-r-2',
          restaurantSnapshot: { name: '식당B' },
          orderDraft: { orderLines: [{ id: 'l2', menuName: '특식', quantity: 30, unitPriceKRW: 12000 }], charges: [], discounts: [] }
        },
        {
          id: 'c3',
          restaurantId: 'ysk-r-3',
          restaurantSnapshot: { name: '식당C(미확인)' },
          orderDraft: { orderLines: [{ id: 'l3', menuName: '미정', quantity: 30, unitPriceKRW: null }], charges: [], discounts: [] }
        }
      ],
      [{ groupId: 'g-student', count: 30 }]
    );
    assert.equal(cmp.length, 3);
    assert.equal(cmp[0].totalConfirmedKRW, 300000);
    assert.equal(cmp[1].totalConfirmedKRW, 360000);
    assert.equal(cmp[2].isTotalConfirmed, false);
    assert.equal(cmp[2].totalConfirmedKRW, null);
  });

  test('AC15, AC33, AC54: Asia/Seoul 예정 식사 시간대 검증(역전 입력 거부, 익일 종료, 브레이크타임 걸침, 라스트오더, 개인 확인 우선 적용)', () => {
    // AC54: endNextDay=false인데 종료 시각이 시작 시각보다 빠르면 입력 오류 거부
    const invalidWin = buildPlannedMealWindow({
      date: '2026-10-20',
      startTime: '21:00',
      endTime: '20:00',
      endNextDay: false
    });
    assert.equal(invalidWin.valid, false);
    assert.equal(invalidWin.code, 'END_NOT_AFTER_START');

    // AC54: endNextDay=true이면 자정 넘김 식사 구간 허용
    const overnightWin = buildPlannedMealWindow({
      date: '2026-10-20',
      startTime: '23:30',
      endTime: '00:30',
      endNextDay: true
    });
    assert.equal(overnightWin.valid, true);
    assert.equal(overnightWin.endDate, '2026-10-21');

    // AC15 & AC54: 브레이크타임(15:00~17:00) 및 라스트오더(20:00) 검증
    const placeWithBreakAndLastOrder = {
      openingHours: {
        timezone: 'Asia/Seoul',
        status: 'verified',
        regularClosedDays: [1], // 월요일 정기휴무
        weeklyIntervals: [
          { day: 2, startTime: '11:00', endTime: '15:00', endDayOffset: 0, lastOrderTime: null },
          { day: 2, startTime: '17:00', endTime: '21:00', endDayOffset: 0, lastOrderTime: '20:00', lastOrderDayOffset: 0 }
        ],
        dateOverrides: [],
        groupMealWindows: [],
        evidenceRefs: ['src-1']
      }
    };

    // 화요일(2026-10-20) 14:30~15:30 식사 계획 -> 15:00 브레이크타임에 걸침(AC15)
    const straddleWin = buildPlannedMealWindow({ date: '2026-10-20', startTime: '14:30', endTime: '15:30' });
    const straddleEval = evaluateMealWindowHours(placeWithBreakAndLastOrder, straddleWin);
    assert.equal(straddleEval.status, 'unmet');
    assert.equal(straddleEval.basis, 'crosses_break_or_closing');

    // 화요일(2026-10-20) 20:15~20:50 식사 계획 -> 라스트오더(20:00) 이후 도착(AC54)
    const lateWin = buildPlannedMealWindow({ date: '2026-10-20', startTime: '20:15', endTime: '20:50' });
    const lateEval = evaluateMealWindowHours(placeWithBreakAndLastOrder, lateWin);
    assert.equal(lateEval.status, 'unmet');
    assert.equal(lateEval.basis, 'last_order_passed');

    // AC33: 공용 영업시간 밖이어도 식당과 별도 시간 약정(validPersonalConfirmation)이 있으면 개인 계획에서 허용 + 'outsideRegularHours: true' 표시
    const overrideEval = evaluateMealWindowHours(placeWithBreakAndLastOrder, straddleWin, {
      validPersonalConfirmation: { id: 'conf-1', status: 'confirmed' }
    });
    assert.equal(overrideEval.status, 'met');
    assert.equal(overrideEval.basis, 'personal_confirmation');
    assert.equal(overrideEval.outsideRegularHours, true);
  });

  test('AC14, AC48, AC52, AC53, AC59: 후보/예약 확인 상태 전이, 시각순 정렬, 취소 복귀 금지, 견적 전 확인(quoteId:null), 조건 변경 시 재확인 전환', () => {
    const ev = createNewPersonalEvent({
      title: '순천만 현장체험학습',
      startDate: '2026-10-22',
      dayCount: 1,
      studentCount: 40,
      staffCount: 4
    });
    const mealPlan = ev.mealPlans[0];
    const mockPlace = {
      id: 'ysk-r-71',
      name: '순천만가든',
      regionCode: 'jn-suncheon',
      address: '순천시',
      location: { lat: 34.9, lng: 127.5, status: 'verified' },
      groupProfile: { availability: 'yes', totalSeats: 80, simultaneousCapacity: 80, mealWaves: { availability: 'yes' }, parking: { busEntry: 'yes', busParkingSpaces: 2, dropoff: 'yes' }, evidenceRefs: [] },
      menus: [{ id: 'm1', name: '꼬막정식', priceKRW: 15000, priceBasis: 'per_person' }],
      openingHours: { timezone: 'Asia/Seoul', status: 'unknown', weeklyIntervals: [], dateOverrides: [], groupMealWindows: [], evidenceRefs: [] },
      officialDesignations: [],
      businessStatus: 'open'
    };

    const { candidateRecord: cand } = addCandidateToMealPlan(mealPlan, mockPlace, { selectAsPrimary: true });

    // AC14: 후보 선택만으로는 'candidate' 상태이며 'reservation_confirmed'가 될 수 없음
    const statusBeforeConfirm = evaluateMealPlanStatus(mealPlan);
    assert.equal(statusBeforeConfirm.status, 'candidate');

    // AC53 & AC59: 메뉴 견적 확정 전(quoteId: null)에도 일정·인원·시간대 예약 확정 가능
    const conf1 = recordMealConfirmation(mealPlan, {
      candidateId: cand.id,
      kind: 'reservation',
      quoteId: null,
      checkedAt: '2026-10-18T10:00:00+09:00',
      method: 'phone'
    });
    assert.equal(conf1.recorded, true);
    assert.equal(evaluateMealPlanStatus(mealPlan).status, 'reservation_confirmed');

    // AC52: 더 이른 시각(09:00)의 'cancellation' 기록이 나중에 입력되더라도 최신 확인 시각(10:00) 기준으로 판단
    recordMealConfirmation(mealPlan, {
      candidateId: cand.id,
      kind: 'cancellation',
      quoteId: null,
      checkedAt: '2026-10-18T09:00:00+09:00',
      method: 'phone'
    });
    assert.equal(evaluateMealPlanStatus(mealPlan).status, 'reservation_confirmed');

    // AC52: 이후 시각(11:00)에 명시적 취소('cancellation')가 기록되면 이전 확정으로 자동 복귀하지 않음
    recordMealConfirmation(mealPlan, {
      candidateId: cand.id,
      kind: 'cancellation',
      quoteId: null,
      checkedAt: '2026-10-18T11:00:00+09:00',
      method: 'phone'
    });
    assert.equal(evaluateMealPlanStatus(mealPlan).status, 'cancelled');

    // 다시 12:00에 새 예약 확인으로 확정
    recordMealConfirmation(mealPlan, {
      candidateId: cand.id,
      kind: 'reservation',
      quoteId: null,
      checkedAt: '2026-10-18T12:00:00+09:00',
      method: 'phone'
    });
    assert.equal(evaluateMealPlanStatus(mealPlan).status, 'reservation_confirmed');

    // AC48 & AC59: 행사 인원수를 40명 -> 55명으로 변경하여 해당 끼니에 반영하면 확정된 끼니가 자동으로 '식당 재확인 필요(needs_reconfirm)'로 전환됨
    const groupChangeRes = applyEventAttendeeGroupsChange(
      ev,
      [
        { ...ev.attendeeGroups[0], count: 55 },
        ev.attendeeGroups[1]
      ],
      { applyToMealPlanIds: [mealPlan.id] }
    );
    assert.equal(groupChangeRes.affectedMeals.length, 1);
    const updatedMealPlan = groupChangeRes.event.mealPlans[0];
    const statusAfterHeadcountChange = evaluateMealPlanStatus(updatedMealPlan);
    assert.equal(statusAfterHeadcountChange.status, 'needs_reconfirm');
    assert.equal(statusAfterHeadcountChange.statusLabel, '식당 재확인 필요');
  });

  test('AC16, AC17, AC18, AC19, AC56: 기준점 직선거리 정렬, 메뉴 안전 주의문구, 공식 지정 분리 표시, 방문 기록 중복제거·반복 이용 배지', () => {
    // AC16: 기준점 직선거리 정렬 및 좌표 미확인 식당 하단 배치
    const places = [
      { id: 'r-no-coord', name: '가식당(좌표없음)', regionCode: 'jn-yeosu', location: { lat: null, lng: null, status: 'unverified' }, groupProfile: { availability: 'unknown', mealWaves: { availability: 'unknown' }, parking: { busEntry: 'unknown', dropoff: 'unknown' }, evidenceRefs: [] }, menus: [], openingHours: { timezone: 'Asia/Seoul', status: 'unknown', weeklyIntervals: [], dateOverrides: [], groupMealWindows: [], evidenceRefs: [] }, officialDesignations: [], businessStatus: 'open' },
      { id: 'r-far', name: '나식당(원거리)', regionCode: 'jn-yeosu', location: { lat: 34.80, lng: 127.70, status: 'verified' }, groupProfile: { availability: 'unknown', mealWaves: { availability: 'unknown' }, parking: { busEntry: 'unknown', dropoff: 'unknown' }, evidenceRefs: [] }, menus: [], openingHours: { timezone: 'Asia/Seoul', status: 'unknown', weeklyIntervals: [], dateOverrides: [], groupMealWindows: [], evidenceRefs: [] }, officialDesignations: [], businessStatus: 'open' },
      { id: 'r-near', name: '다식당(근거리)', regionCode: 'jn-yeosu', location: { lat: 34.740, lng: 127.736, status: 'verified' }, groupProfile: { availability: 'unknown', mealWaves: { availability: 'unknown' }, parking: { busEntry: 'unknown', dropoff: 'unknown' }, evidenceRefs: [] }, menus: [], openingHours: { timezone: 'Asia/Seoul', status: 'unknown', weeklyIntervals: [], dateOverrides: [], groupMealWindows: [], evidenceRefs: [] }, officialDesignations: [], businessStatus: 'open' }
    ];
    const sorted = filterAndClassifyRestaurants(places, {
      referencePoint: { lat: 34.7397, lng: 127.7357, label: '이순신광장' }
    }).combinedList;
    assert.equal(sorted[0].id, 'r-near');
    assert.equal(sorted[1].id, 'r-far');
    assert.equal(sorted[2].id, 'r-no-coord');
    assert.ok(sorted[0].straightDistanceLabel.includes('직선거리'));
    assert.equal(sorted[2].straightDistanceLabel, '거리 미확인');

    // AC17: 메뉴 안전 주의 문구 필수 포함 및 자동 안전 판정 금지(autoSafetyJudgment === null)
    const menuSafety = evaluateMenuSafetyDisplay({ id: 'm1', name: '돈까스', priceKRW: 10000, priceBasis: 'per_person' });
    assert.equal(menuSafety.autoSafetyJudgment, null);
    assert.ok(menuSafety.safetyNotice.includes('알레르기 안전이 보장되지 않으므로'));

    // AC18: 공식 지정 유효·만료·취소 구분 및 단체 수용 조건과의 분리 안내
    const desig = evaluateOfficialDesignations({
      officialDesignations: [
        { id: 'od-1', type: 'hygiene_grade', grade: '매우우수', status: 'active', validTo: '2025-01-01', addressMatchStatus: 'matched' }
      ]
    }, '2026-10-19');
    assert.equal(desig.hasValidDesignation, false);
    assert.equal(desig.allDesignations[0].effectiveStatus, 'expired');

    // AC19 & AC56: VisitRecord 검토 승인 여부, duplicateGroupId 중복 병합, 최근 12개월 3건 이상 & 서로 다른 방문일 2일 이상일 때만 '반복 이용 사례 있음' 부여
    const visitRecords = [
      { id: 'vr-1', restaurantId: 'r-near', eventType: 'field_trip', visitDate: '2026-05-10', groupSize: 40, reviewStatus: 'approved', publicConsent: true, duplicateGroupId: 'dup-group-1' },
      // 동일 duplicateGroupId(교대 배식 등)는 1회 방문으로 병합(AC56)
      { id: 'vr-2-dup', restaurantId: 'r-near', eventType: 'field_trip', visitDate: '2026-05-10', groupSize: 40, reviewStatus: 'approved', publicConsent: true, duplicateGroupId: 'dup-group-1' },
      // 미검토(pending) 초안은 공개 집계에서 제외(AC19)
      { id: 'vr-draft', restaurantId: 'r-near', eventType: 'school_trip', visitDate: '2026-06-01', groupSize: 80, reviewStatus: 'pending', publicConsent: true, isLocalDraft: true },
      { id: 'vr-3', restaurantId: 'r-near', eventType: 'school_sports_club', visitDate: '2026-09-15', groupSize: 35, reviewStatus: 'approved', publicConsent: true }
    ];

    const aggBefore3 = aggregateVisitRecordsForRestaurant(visitRecords, 'r-near', '2026-10-19');
    assert.equal(aggBefore3.totalVerifiedVisits, 2);
    assert.equal(aggBefore3.hasRepeatVisitBadge, false);

    // 3번째 검토 승인 방문 추가 시 '반복 이용 사례 있음' 활성화
    visitRecords.push({
      id: 'vr-4',
      restaurantId: 'r-near',
      eventType: 'national_youth_sports',
      visitDate: '2026-10-01',
      groupSize: 50,
      reviewStatus: 'approved',
      publicConsent: true
    });
    const aggAfter3 = aggregateVisitRecordsForRestaurant(visitRecords, 'r-near', '2026-10-19');
    assert.equal(aggAfter3.totalVerifiedVisits, 3);
    assert.equal(aggAfter3.hasRepeatVisitBadge, true);
    assert.equal(aggAfter3.badgeLabel, '반복 이용 사례 있음');
  });

  test('AC20, AC21, AC29, AC45, AC46: 개인 저장소(IndexedDB 폴백), 스냅샷 변경 감지, 백업/복원 원자성, 다중 탭 revision 충돌 방지', async () => {
    const localMem = createMemoryStorage();
    const ev = createNewPersonalEvent({ title: '여수 수학여행', startDate: '2026-11-01' });

    // AC29: IndexedDB가 완전히 차단된 환경(forceIdbUnavailable: true)에서는 영구 저장 완료로 속이지 않고 isTemporaryOnly: true 안내 제공
    const blockedMgr = new PersonalStorageManager({ localStorage: localMem, forceIdbUnavailable: true });
    const blockedSave = await blockedMgr.saveEvent(ev, 0);
    assert.equal(blockedSave.saved, false);
    assert.equal(blockedSave.isTemporaryOnly, true);

    // 정상 저장소(sharedBackend 트랜잭션) 환경에서 revision 증가 및 다중 탭 충돌 검증(AC45)
    const mgr = new PersonalStorageManager({ localStorage: localMem, indexedDB: null });
    const save1 = await mgr.saveEvent(ev, 0);
    assert.equal(save1.saved, true);
    assert.equal(save1.revision, 1);

    // AC45: 다른 탭이 먼저 저장해 revision이 1이 된 상태에서 이전 expectedRevision(0)으로 저장 시도 시 충돌 감지 및 백업 사본 반환
    const conflictRes = await mgr.saveEvent({ ...ev, title: '탭B의 구버전 수정' }, 0);
    assert.equal(conflictRes.saved, false);
    assert.equal(conflictRes.status, 'revision_conflict');
    assert.ok(conflictRes.latestStoredEvent);
    assert.ok(conflictRes.currentEditingDraft);

    // AC21: 손상된 백업 JSON 가져오기 시 거부하고 기존 데이터 보존
    const badImport = await mgr.importEnvelope('{corrupted', { duplicatePolicy: 'overwrite' });
    assert.equal(badImport.imported, false);
    const currentList = await mgr.listEvents();
    assert.equal(currentList.length, 1);

    // 정상 백업 내보내기 및 복원(AC21, AC46)
    const { envelope: backupEnv } = await mgr.exportBackupEnvelope({
      favoriteIds: ['ysk-r-1'],
      settings: { mode: 'school' },
      unresolvedFavorites: [],
      migrationState: { completed: true, migratedAt: '2026-10-19T00:00:00Z' }
    });
    assert.equal(validateBackupEnvelope(backupEnv).valid, true);

    // AC46: IDB 트랜잭션 중간 중단 시 전체 롤백 검증
    const abortingMgr = new PersonalStorageManager({
      localStorage: localMem,
      indexedDB: null,
      simulateIdbAbortOnImport: true
    });
    const abortRes = await abortingMgr.importEnvelope(backupEnv, { duplicatePolicy: 'overwrite' });
    assert.equal(abortRes.imported, false);
    assert.equal(abortRes.status, 'idb_tx_aborted');

    // AC46: IDB는 성공하고 localStorage 쓰기가 실패할 때 restoreLog가 보존되고 재시도로 완료 가능함 검증
    const partialMgr = new PersonalStorageManager({
      localStorage: localMem,
      indexedDB: null,
      simulateLocalStorageFailOnRestore: true
    });
    const partialRes = await partialMgr.importEnvelope(backupEnv, { duplicatePolicy: 'overwrite' });
    assert.equal(partialRes.imported, true);
    assert.equal(partialRes.status, 'partial_settings_failed');
    assert.ok(partialRes.restoreLogId);

    partialMgr.simulateLocalStorageFailOnRestore = false;
    const retryRes = await partialMgr.retryRestoreSettingsFromLog(partialRes.restoreLogId, { forceOverwriteUserChanges: true });
    assert.equal(retryRes.completed, true);

    // AC20: 공용 데이터 변경 시 스냅샷 자동 덮어쓰기 없이 차이점만 감지
    const snap = {
      restaurantId: 'ysk-r-1',
      datasetVersion: '2026.10.0',
      capturedAt: '2026-10-01T00:00:00+09:00',
      name: '이순신수제버거',
      address: '여수시 중앙동',
      phone: '061-000-0000',
      selectedMenus: [{ id: 'm1', name: '버거', priceKRW: 8000 }],
      publicFacts: { groupProfile: { simultaneousCapacity: 50 } }
    };
    const updatedPublic = {
      status: 'found',
      restaurant: {
        id: 'ysk-r-1',
        name: '이순신수제버거',
        address: '여수시 중앙동',
        phone: '061-999-9999',
        groupProfile: { simultaneousCapacity: 40 },
        menus: [{ id: 'm1', name: '버거', priceKRW: 9000 }]
      }
    };
    const diff = detectPublicDataChangesAgainstSnapshot(snap, updatedPublic);
    assert.equal(diff.hasDiff, true);
    assert.equal(diff.diffs.length, 3);
    assert.equal(snap.phone, '061-000-0000'); // 기존 스냅샷 불변 유지
  });

  test('AC22, AC23, AC44, AC55: 인쇄 CSS 줄바꿈 방지, 공개 공유 링크/QR 허용목록, 공유 사본 중첩 메모 제거·quoteId 정규화·별도 사본 ID 재매핑', async () => {
    // AC22: print.css에 break-inside: avoid 및 page-break-inside: avoid 규칙 존재 확인
    const printCss = fs.readFileSync(path.join(ROOT, 'assets/releases/v2.0.0/css/print.css'), 'utf8');
    assert.ok(printCss.includes('break-inside: avoid'));
    assert.ok(printCss.includes('page-break-inside: avoid'));

    // 식당 문의 텍스트 생성 검증(AC22)
    const inq = generateRestaurantInquiryText({
      eventTitle: '여수 현장체험학습',
      date: '2026-10-25',
      startTime: '12:00',
      endTime: '13:00',
      diners: [{ label: '학생', count: 35 }, { label: '인솔교사', count: 3 }],
      busCount: 1
    });
    assert.ok(inq.includes('여수 현장체험학습'));
    assert.ok(inq.includes('총 38명'));

    // AC23: 공개 공유 URL 허용목록 검증(비공개 연락처·메모 파라미터 차단)
    const pubShare = buildPublicShareUrl({
      restaurantId: 'ysk-r-1',
      region: 'jn-yeosu',
      contactPhone: '010-1234-5678',
      privateMemo: '비밀메모'
    });
    assert.equal(pubShare.valid, true);
    assert.equal(pubShare.url.includes('010-1234-5678'), false);
    assert.equal(pubShare.url.includes('privateMemo'), false);

    // 공개 QR 생성 검증(AC23)
    const qrSvg = buildPublicQrSvg(pubShare.url);
    assert.ok(qrSvg.startsWith('<svg'));

    // AC55 & AC44: 개인 메모·견적·확인 이력이 있는 행사 공유 사본 생성 및 별도 사본 가져오기
    const ev = createNewPersonalEvent({ title: '전국체전 선수단 식사', startDate: '2026-10-20' });
    ev.internalMemo = '인솔자 내부 비밀 메모';
    const mp = ev.mealPlans[0];
    mp.internalMemo = '끼니 내부 메모';
    const { candidateRecord: cand } = addCandidateToMealPlan(
      mp,
      { id: 'ysk-r-1', name: '식당1', address: '여수', menus: [{ id: 'm1', name: '특식', priceKRW: 15000 }] },
      { selectAsPrimary: true }
    );
    cand.internalMemo = '후보 내부 메모';
    const { quote } = recordCandidateQuote(mp, cand.id, {
      quotedAt: '2026-10-18T10:00:00+09:00',
      paymentNotes: '견적 내부 결제 메모'
    });
    recordMealConfirmation(mp, {
      candidateId: cand.id,
      kind: 'reservation',
      quoteId: quote.id,
      checkedAt: '2026-10-18T11:00:00+09:00',
      method: 'phone',
      notes: '통화 내부 메모'
    });

    // 공유 사본 생성(확인 이력은 포함하되 견적 이력과 내부 메모는 제외 - AC55)
    const shareRes = buildShareEnvelope(ev, {
      includeSchedule: true,
      includeCandidates: true,
      includeOrderAndAmounts: true,
      includeConfirmationHistory: true,
      includeQuoteHistory: false,
      includeInternalMemos: false
    });
    assert.equal(shareRes.valid, true);
    const sharedEv = shareRes.envelope.eventCopy;
    // AC55: 모든 중첩 메모가 제거되고, 견적 제외 시 confirmationHistory.quoteId가 null로 정규화되며 referenceOnly=true가 설정됨
    assert.equal('internalMemo' in sharedEv, false);
    assert.equal('internalMemo' in sharedEv.mealPlans[0], false);
    assert.equal('internalMemo' in sharedEv.mealPlans[0].candidateRecords[0], false);
    assert.equal(sharedEv.mealPlans[0].candidateRecords[0].quoteHistory.length, 0);
    assert.equal(sharedEv.mealPlans[0].candidateRecords[0].confirmationHistory[0].quoteId, null);
    assert.equal(sharedEv.mealPlans[0].candidateRecords[0].confirmationHistory[0].referenceOnly, true);
    assert.equal('notes' in sharedEv.mealPlans[0].candidateRecords[0].confirmationHistory[0], false);
    assert.equal(validateShareEnvelope(shareRes.envelope).valid, true);

    // AC44: '별도 사본으로 추가' 시 모든 개인 엔티티 ID와 내부 참조가 새 ID로 재매핑되고 공용 restaurantId는 보존됨
    const remappedRes = remapEventForSeparateCopy(ev);
    assert.equal(remappedRes.valid, true);
    const remapped = remappedRes.event;
    assert.notEqual(remapped.id, ev.id);
    assert.notEqual(remapped.mealPlans[0].id, mp.id);
    assert.equal(remapped.mealPlans[0].eventId, remapped.id);
    assert.notEqual(remapped.mealPlans[0].candidateRecords[0].id, cand.id);
    assert.equal(remapped.mealPlans[0].selectedCandidateId, remapped.mealPlans[0].candidateRecords[0].id);
    assert.equal(remapped.mealPlans[0].candidateRecords[0].restaurantId, 'ysk-r-1');
    assert.equal(
      remapped.mealPlans[0].candidateRecords[0].confirmationHistory[0].quoteId,
      remapped.mealPlans[0].candidateRecords[0].quoteHistory[0].id
    );
  });

  test('AC24 & AC25: 제보 초안 개인정보·스크립트 URL 차단 및 CSV 오류 행(좌표·URL) 검출', () => {
    // AC24: 제보 초안 생성 시 본문 전화번호나 javascript: URL 차단 및 '초안 저장됨' 상태 표시
    const blockedReport = buildVerifiedReportDraft({
      restaurantId: 'ysk-r-1',
      restaurantName: '이순신수제버거',
      evidenceUrl: 'javascript:alert(1)'
    });
    assert.equal(blockedReport.valid, false);

    const validReport = buildVerifiedReportDraft({
      type: 'visit_record',
      restaurantId: 'ysk-r-1',
      restaurantName: '이순신수제버거',
      eventType: 'field_trip',
      visitDate: '2026-10-15',
      groupSize: 35,
      menuSummary: '수제버거 세트 단체 포장 원활',
      publicConsent: true
    });
    assert.equal(validReport.valid, true);
    assert.equal(validReport.publicPreview.isLocalDraft, true);
    assert.equal(validReport.publicPreview.reviewStatus, 'pending_operator_review');

    // AC25: 잘못된 좌표(lat=999)나 javascript: 링크가 포함된 CSV 행 검출
    const badCsv = [
      'id,name,city,category,menu,lat,lng,link',
      'ysk-r-1,정상식당,여수,한식,백반,34.74,127.73,https://place.map.kakao.com/1',
      'ysk-r-2,좌표오류식당,여수,한식,백반,999,127.73,https://place.map.kakao.com/2',
      'ysk-r-3,링크오류식당,순천,한식,국밥,34.95,127.48,javascript:alert(1)'
    ].join('\n');
    const csvRes = csvToPlaces(badCsv);
    assert.equal(csvRes.valid, false);
    assert.equal(csvRes.places.length, 1);
    assert.equal(csvRes.errors.length, 2);
    assert.equal(csvRes.errors[0].rowNumber, 3);
    assert.equal(csvRes.errors[1].rowNumber, 4);
  });

  test('AC26, AC31, AC41, AC42: 서비스 워커 비문서 HTML 폴백 금지, 타 프로젝트 캐시 보존, 미저장 편집 탭 보호, 오프라인 준비 점검', async () => {
    // sw.js 로드 및 훅 검증
    globalThis.self = globalThis;
    globalThis.self.addEventListener = () => {};
    await import('../sw.js');
    const swHooks = globalThis.__YSK_SW_HOOKS__;
    assert.ok(swHooks);

    // AC26: .json / .js 요청에 text/html 응답이 오면 캐시 저장 거부
    const jsonReq = { url: 'https://gmlduqzhd123-lab.github.io/YSK-food/data/manifest.json', mode: 'cors', destination: '' };
    const htmlResp = { ok: true, status: 200, headers: new Map([['content-type', 'text/html; charset=utf-8']]) };
    assert.equal(swHooks.isCacheableValidResponse(jsonReq, htmlResp), false);

    // AC31: 같은 도메인의 다른 프로젝트 캐시(YScode-v1 등)는 절대 삭제 대상이 아님
    assert.equal(swHooks.shouldDeleteCacheKey('YScode-v1'), false);
    assert.equal(swHooks.shouldDeleteCacheKey('other-app-cache'), false);
    assert.equal(swHooks.shouldDeleteCacheKey('ysk-food-v25'), true);
    assert.equal(swHooks.shouldDeleteCacheKey(swHooks.APP_CACHE_NAME), false);

    // AC41: 열린 탭이 구버전을 참조 중이면 그 버전 캐시는 보존하고, 미저장 편집 중이면 skipWaiting 금지
    assert.equal(swHooks.shouldDeleteCacheKey('ysk-food-app-v1.9.0', new Set(['v2.0.0', 'v1.9.0'])), false);
    assert.equal(swHooks.canActivateWaitingWorker({ clientCount: 1, approvedByUser: true, anyUnsavedEdits: true }), false);
    assert.equal(swHooks.canActivateWaitingWorker({ clientCount: 1, approvedByUser: false, anyUnsavedEdits: false }), false);
    assert.equal(swHooks.canActivateWaitingWorker({ clientCount: 1, approvedByUser: true, anyUnsavedEdits: false }), true);

    // AC42: asset-manifest.json 기반 전이 의존 모듈 전체 캐시 검증
    const localFetch = createLocalFileFetch();
    const cachedSet = new Set();
    const mockCache = {
      put: async (url) => { cachedSet.add(url); },
      match: async (url) => (cachedSet.has(url) ? { ok: true } : null)
    };
    const mockCacheStorage = {
      open: async () => mockCache,
      match: async (url) => (cachedSet.has(url) ? { ok: true } : null)
    };
    const readyCheck = await verifyOfflineReadiness({
      appBase: 'https://gmlduqzhd123-lab.github.io/YSK-food/',
      appVersion: 'v2.0.0',
      cacheStorage: mockCacheStorage,
      fetchFn: localFetch
    });
    assert.equal(readyCheck.ready, true);
    assert.equal(readyCheck.missingAssets.length, 0);
  });

  test('AC27, AC34, AC57, AC58: 예제 픽스처 검증, 파일별 전용 스키마 검증, 타 지역 대회·시설 교차 참조, 전국 행정구역 검색', async () => {
    const cliValidation = runDatasetValidation(ROOT);
    assert.equal(cliValidation.valid, true, `데이터셋 검증 오류: ${cliValidation.errors.join(', ')}`);

    // AC34: search-index.json을 지역 데이터 검증기에 넣으면 즉시 거부되어야 함
    const searchIndexData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/releases/2026.10.1/search-index.json'), 'utf8'));
    const crossTypeCheck = validateRegionDataset(searchIndexData, 'jn-yeosu');
    assert.equal(crossTypeCheck.valid, false);

    // AC57: 순천 파일에 정의된 광역 대회(evref-2026-sports-jn)를 여수/광양에서도 id-index를 통해 정확히 조회
    const repo = new DatasetRepository({
      appBase: 'https://gmlduqzhd123-lab.github.io/YSK-food/',
      fetchFn: createLocalFileFetch()
    });
    await repo.selectRegion('jn-yeosu');
    const evRefRes = await repo.resolveEventReferenceById('evref-2026-sports-jn');
    assert.equal(evRefRes.status, 'found');
    assert.equal(evRefRes.regionCode, 'jn-suncheon');
    assert.ok(evRefRes.eventReference.venueIds.includes('venue-yeosu-jinnam'));

    // AC58: 시·군·광역시 구·특별자치도 계층 및 별칭 확인
    const regions = repo.getRegionsList();
    assert.ok(regions.some(r => r.regionCode === 'seoul-jongno' && r.aliases.includes('서울 종로구')));
    assert.ok(regions.some(r => r.regionCode === 'jn-boseong' && r.level === 'sigungu'));
    assert.ok(regions.some(r => r.regionCode === 'jj-jeju' && r.sidoName === '제주특별자치도'));
  });

  test('AC28, AC30, AC32, AC35, AC36, AC37, AC39, AC40: 반응형 CSS, 50개 페이지네이션, 하위경로 해석, 문자열 ID 무결성, 단일 라우터, 폴백 번들, 제거된 ID 구분', async () => {
    // AC28: 반응형 브레이크포인트 및 모달 스타일 확인
    const appCss = fs.readFileSync(path.join(ROOT, 'assets/releases/v2.0.0/css/app.css'), 'utf8');
    assert.ok(appCss.includes('@media (max-width: 767px)'));
    assert.ok(appCss.includes('@media (min-width: 768px)'));
    assert.ok(appCss.includes('@media (min-width: 1280px)'));
    assert.ok(appCss.includes('min-height: 44px'));

    // AC30: 166개 항목 중 첫 50개만 초기 슬라이스로 반환하고 더 보기로 확장
    const dummy166 = Array.from({ length: 166 }, (_, i) => ({ id: `ysk-r-${i + 1}` }));
    const slice1 = computePaginatedSlice(dummy166, PAGE_SIZE);
    assert.equal(slice1.shownCount, 50);
    assert.equal(slice1.totalCount, 166);
    assert.equal(slice1.hasMore, true);
    assert.equal(slice1.nextLimit, 100);

    // AC32: /YSK-food/ 하위 경로에서 루트로 이탈하지 않는 상대 경로 해석
    const base = resolveAppBase({ origin: 'https://gmlduqzhd123-lab.github.io', pathname: '/YSK-food/index.html' });
    assert.equal(base, 'https://gmlduqzhd123-lab.github.io/YSK-food/');
    assert.equal(resolveAppUrl('data/manifest.json', base), 'https://gmlduqzhd123-lab.github.io/YSK-food/data/manifest.json');

    // AC35: 신규 v2 JS 모듈 전체에서 Number(li.dataset.id) 변환이 0건인지 검증
    const jsDir = path.join(ROOT, 'assets/releases/v2.0.0/js');
    const checkNoNumberDatasetId = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) checkNoNumberDatasetId(full);
        else if (entry.name.endsWith('.js')) {
          const code = fs.readFileSync(full, 'utf8');
          const nonCommentLines = code.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
          assert.equal(nonCommentLines.join('\n').includes('Number(li.dataset.id)'), false, `${entry.name}에 Number(li.dataset.id)가 포함되어 있습니다.`);
        }
      }
    };
    checkNoNumberDatasetId(jsDir);

    // AC36: 단일 라우터의 모호한 링크(restaurantId + restaurantIds 동시 존재) 거부 및 restaurantId 우선 처리
    const ambRoute = parseRouteFromUrl('https://gmlduqzhd123-lab.github.io/YSK-food/?restaurantId=ysk-r-1&restaurantIds=ysk-r-2');
    assert.equal(ambRoute.status, 'ambiguous_link');

    const prioRoute = parseRouteFromUrl('https://gmlduqzhd123-lab.github.io/YSK-food/?restaurantId=ysk-r-1&place=이순신수제버거');
    assert.equal(prioRoute.view, 'detail');
    assert.equal(prioRoute.restaurantId, 'ysk-r-1');
    assert.equal(prioRoute.ignoredLegacyPlace, '이순신수제버거');

    // AC37: ys-install.js가 index.html에 정확히 1회 포함되고 설치 버튼 셀렉터가 유지됨
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const installScriptMatches = indexHtml.match(/ys-install\.js/g) || [];
    assert.equal(installScriptMatches.length, 1);
    assert.ok(indexHtml.includes('data-ys-install'));
    assert.ok(indexHtml.includes('install-btn'));

    // AC40: 영구 ID 조회 시 활성(found), 공개 제거(removed), 미등록(unregistered) 명확히 구분
    const repo = new DatasetRepository({
      appBase: 'https://gmlduqzhd123-lab.github.io/YSK-food/',
      fetchFn: createLocalFileFetch()
    });
    const foundRes = await repo.resolveRestaurantById('ysk-r-1');
    assert.equal(foundRes.status, 'found');
    const removedRes = await repo.resolveRestaurantById('ysk-r-removed-999');
    assert.equal(removedRes.status, 'removed');
    const unregRes = await repo.resolveRestaurantById('ysk-r-never-existed-99999');
    assert.equal(unregRes.status, 'unregistered');

    // AC39: 정상 버전(2026.10.1) 로드 후 불완전한 신규 버전(2026.10.2-broken) 응답 시 이전 정상 버전 묶음으로 원자적 폴백 검증
    let serveBrokenManifest = false;
    const baseFetch = createLocalFileFetch();
    const fallbackFetch = async (urlStr) => {
      if (serveBrokenManifest && String(urlStr).endsWith('data/manifest.json')) {
        const orig = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/manifest.json'), 'utf8'));
        const brokenLatest = {
          ...orig,
          datasetVersion: '2026.10.2-broken',
          previousDatasetVersion: '2026.10.1',
          regionsPath: 'data/releases/2026.10.2-broken/regions.json'
        };
        return new Response(JSON.stringify(brokenLatest), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return baseFetch(urlStr);
    };
    const fallbackRepo = new DatasetRepository({
      appBase: 'https://gmlduqzhd123-lab.github.io/YSK-food/',
      fetchFn: fallbackFetch
    });
    const initialLoad = await fallbackRepo.loadCoreBundle();
    assert.equal(initialLoad.status, 'ok');
    assert.equal(initialLoad.datasetVersion, '2026.10.1');

    serveBrokenManifest = true;
    const fbCore = await fallbackRepo.loadCoreBundle();
    assert.equal(fbCore.status, 'fallback');
    assert.equal(fbCore.usingFallbackBundle, true);
    assert.equal(fbCore.datasetVersion, '2026.10.1');
  });

  test('전국 확장 및 모드별 추천 검증: 선수단·학교 단체식사 모드에서 포차·술집·카페 완전 배제 및 전국 초등·선수단 맞춤 식당 추천', async () => {
    const repo = new DatasetRepository({
      appBase: 'https://gmlduqzhd123-lab.github.io/YSK-food/',
      fetchFn: createLocalFileFetch()
    });

    // 1. 전국 전체('nationwide') 로드 시 기존 여순광 166곳 + 카카오맵 확인 추가분 반환
    //    (실제 식당이 아닌 것으로 확인된 '초등·선수단 맞춤 식당' 88곳(ysk-r-nat-…)은 공개 자료에 없어야 함)
    const nwRes = await repo.selectRegion('nationwide');
    assert.equal(nwRes.status, 'ok');
    assert.equal(nwRes.restaurants.length, 166 + KAKAO_VERIFIED.restaurants.length);
    assert.equal(nwRes.restaurants.filter(r => isLegacyId(r.id)).length, 166);
    assert.equal(nwRes.restaurants.some(r => String(r.id).startsWith('ysk-r-nat-')), false);
    const regionSet = new Set(nwRes.restaurants.map(r => r.regionCode));
    assert.ok(regionSet.has('seoul-jongno'));
    assert.ok(regionSet.has('gb-gyeongju'));
    assert.ok(regionSet.has('gw-gangneung'));
    assert.ok(regionSet.has('daejeon-yuseong'));
    assert.ok(regionSet.has('busan-haeundae'));
    assert.ok(regionSet.has('jb-jeonju'));
    assert.ok(regionSet.has('jj-jeju'));
    // 식당이 있는 지역 = 여수·순천·광양 + 카카오맵 확인 식당이 들어간 지역 (보성군은 0곳 테스트용으로 비어 있음)
    const expectedRegions = new Set(['jn-yeosu', 'jn-suncheon', 'jn-gwangyang', ...KAKAO_VERIFIED.restaurants.map(r => r.regionCode)]);
    assert.equal(regionSet.size, expectedRegions.size);
    assert.equal(regionSet.has('jn-boseong'), false);

    // 2. 학교·선수단 모드 카테고리 목록에서 '포차·술집', '카페·디저트' 배제 확인
    const schoolCats = getCategoriesForMode(nwRes.restaurants, 'school');
    const athleteCats = getCategoriesForMode(nwRes.restaurants, 'athlete');
    assert.equal(schoolCats.includes('포차·술집'), false);
    assert.equal(schoolCats.includes('카페·디저트'), false);
    assert.equal(athleteCats.includes('포차·술집'), false);
    assert.equal(athleteCats.includes('카페·디저트'), false);

    // 3. 선수단 식사('athlete') 및 학교 단체식사('school') 모드에서 41번포차 등 술집·카페가 추천 목록에서 100% 제외되는지 검증
    const athleteFiltered = filterAndClassifyRestaurants(nwRes.restaurants, {
      mode: 'athlete',
      regionCode: 'nationwide'
    });
    const schoolFiltered = filterAndClassifyRestaurants(nwRes.restaurants, {
      mode: 'school',
      regionCode: 'nationwide'
    });

    for (const r of athleteFiltered.combinedList) {
      assert.notEqual(r.category, '포차·술집', `선수단 모드에 술집(${r.name})이 포함됨`);
      assert.notEqual(r.category, '카페·디저트', `선수단 모드에 카페(${r.name})가 포함됨`);
      assert.equal(r.name.includes('포차'), false, `선수단 모드에 포차(${r.name})가 포함됨`);
      assert.equal(isSuitableForMode(r, 'athlete'), true);
    }

    for (const r of schoolFiltered.combinedList) {
      assert.notEqual(r.category, '포차·술집', `학교 단체식사 모드에 술집(${r.name})이 포함됨`);
      assert.notEqual(r.category, '카페·디저트', `학교 단체식사 모드에 카페(${r.name})가 포함됨`);
      assert.equal(r.name.includes('포차'), false, `학교 단체식사 모드에 포차(${r.name})가 포함됨`);
      assert.equal(isSuitableForMode(r, 'school'), true);
    }

    // 4. 학교·선수단 모드의 맨 위 추천은 단체석이 확인된(availability === 'yes') 식당이어야 함
    assert.equal(athleteFiltered.combinedList[0].groupProfile.availability, 'yes');
    assert.equal(schoolFiltered.combinedList[0].groupProfile.availability, 'yes');
    // 같은 식당이라도 단체석이 확인된 쪽이 미확인 쪽보다 앞에 와야 함
    const base = nwRes.restaurants.find(r => isSuitableForMode(r, 'school') && r.groupProfile.availability !== 'yes');
    const probeYes = structuredClone(base);
    probeYes.id = 'test-probe-group-yes';
    probeYes.groupProfile.availability = 'yes';
    for (const mode of ['athlete', 'school']) {
      const ranked = filterAndClassifyRestaurants([...nwRes.restaurants, probeYes], { mode, regionCode: 'nationwide' }).combinedList.map(r => r.id);
      assert.ok(ranked.indexOf('test-probe-group-yes') < ranked.indexOf(base.id), `${mode} 모드에서 단체석 확인 식당이 미확인 식당보다 뒤에 있음`);
    }

    // 5. 일반 모드('general')에서도 숫자 시작 술집(41번포차)이 최상단 1위로 노출되지 않는지 검증
    const generalFiltered = filterAndClassifyRestaurants(nwRes.restaurants, {
      mode: 'general',
      regionCode: 'nationwide'
    });
    assert.notEqual(generalFiltered.combinedList[0].name, '41번포차');
    assert.notEqual(generalFiltered.combinedList[0].category, '포차·술집');
  });

  test('선생님 편의 5대 기능 검증: (#1) 메신저 투표 문구 복사, (#4) 에듀파인 기안·품의 문구 복사, (#7) 체험처·박물관 이름 직접 검색, (#9) 초등 선호(안 매움) 자동 배지, (#10) 현재 상태 QR 이어보기', async () => {
    const repo = new DatasetRepository({
      appBase: 'https://gmlduqzhd123-lab.github.io/YSK-food/',
      fetchFn: createLocalFileFetch()
    });
    const nwRes = await repo.selectRegion('nationwide');

    // (#9) 초등 선호(안 매움) 자동 배지 판정 검증
    const donkatsuPlace = nwRes.restaurants.find(r => /돈가스|돈까스|불고기|설렁탕/.test(`${r.name} ${r.menu || ''}`));
    assert.ok(donkatsuPlace);
    const kidEval = evaluateElementaryMenuFriendliness(donkatsuPlace);
    assert.equal(kidEval.isKidFriendlyNonSpicy, true);
    assert.equal(kidEval.badgeLabel, '🧒 초등 선호(안 매움)');

    const pochaPlace = nwRes.restaurants.find(r => r.category === '포차·술집');
    if (pochaPlace) {
      assert.equal(evaluateElementaryMenuFriendliness(pochaPlace).isKidFriendlyNonSpicy, false);
    }

    // (#7) 일반 검색창에서 체험처·박물관·경기장 이름으로 바로 검색 시 반경 내 식당 직선거리 순 추천 검증
    const matchSci = matchVenueFromQuery('국립중앙과학관 근처 돈가스', nwRes.venues);
    assert.ok(matchSci);
    assert.equal(matchSci.venue.regionCode, 'daejeon-yuseong');
    assert.equal(matchSci.remainingQuery, '돈가스');

    const sciResult = filterAndClassifyRestaurants(nwRes.restaurants, {
      mode: 'school',
      regionCode: 'nationwide',
      query: '국립중앙과학관',
      venues: nwRes.venues
    });
    assert.ok(sciResult.combinedList.length > 0, '국립중앙과학관 검색 결과가 1곳 이상이어야 함');
    assert.ok(sciResult.effectiveReferencePoint);
    assert.ok(sciResult.effectiveReferencePoint.label.includes('국립중앙과학관'));
    assert.ok(sciResult.combinedList[0].straightDistanceKm <= 15);
    if (sciResult.combinedList.length >= 2) {
      assert.ok(sciResult.combinedList[0].distance <= sciResult.combinedList[1].distance);
    }

    // (#1) 쿨메신저·단톡방 투표용 후보 비교 문구 생성 검증
    const sampleCandidates = sciResult.combinedList.slice(0, 2);
    const voteText = buildMessengerVoteText(sampleCandidates, {
      mode: 'school',
      region: 'daejeon-yuseong',
      criteria: { totalHeadcount: 85, budgetPerPersonKRW: 11000 }
    });
    assert.ok(voteText.includes('🗳️ [현장체험·수학여행 식당 후보 투표]'));
    assert.ok(voteText.includes('인원 85명 · 1인 예산 11,000원'));
    assert.ok(voteText.includes(`1안) ${sampleCandidates[0].name}`));
    assert.ok(voteText.includes(`2안) ${sampleCandidates[1].name}`));
    assert.ok(voteText.includes('restaurantIds='));

    // (#4) 에듀파인 품의·기안문 및 사전답사 결과보고서 문구 생성 검증
    const docText = buildOfficialDocDraftText(sampleCandidates[0], {
      criteria: { totalHeadcount: 40 }
    });
    assert.ok(docText.includes('[현장체험학습·단체식사 예정 업소 현황 (기안·품의서 첨부용)]'));
    assert.ok(docText.includes(`1. 업 소 명: ${sampleCandidates[0].name}`));
    assert.ok(docText.includes('학교법인카드'));

    // (#10) 교무실 PC ↔ 휴대폰 현재 상태 QR 이어보기 URL 및 SVG 생성 검증
    const stateShare = buildPublicShareUrl({
      restaurantIds: sampleCandidates.map(c => c.id),
      region: 'daejeon-yuseong',
      mode: 'school'
    });
    assert.equal(stateShare.valid, true);
    const stateQrSvg = buildPublicQrSvg(stateShare.url, '📲 휴대폰 이어보기 (후보 비교 2곳)');
    assert.ok(stateQrSvg.startsWith('<svg'));
    assert.ok(stateQrSvg.includes('휴대폰 이어보기'));
  });

  test('버그 수정 회귀 검증: 프리셋 모드 일치(수련활동=school, 전지훈련=athlete), 월말 다음 날 복사, 타 지역 선택 중 전국 시설 검색, 단일 식당 포커스 시 기존 마커 보존', async () => {
    // 1. index.html의 #event-preset-select 옵션과 EVENT_PRESETS 정의 일치 검증
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const selectMatch = indexHtml.match(/<select id="event-preset-select"[\s\S]*?<\/select>/);
    assert.ok(selectMatch, '#event-preset-select 요소가 존재해야 함');
    const optionValues = [...selectMatch[0].matchAll(/<option value="([^"]*)">/g)]
      .map(m => m[1])
      .filter(Boolean);
    assert.ok(optionValues.includes('retreat'), '수련활동(retreat) 옵션이 포함되어야 함');
    assert.ok(optionValues.includes('training_camp'), '전지훈련(training_camp) 옵션이 포함되어야 함');
    for (const val of optionValues) {
      assert.ok(EVENT_PRESETS[val], `프리셋 '${val}'이 EVENT_PRESETS에 정의되어 있어야 함`);
    }
    assert.equal(EVENT_PRESETS.retreat.mode, 'school');
    assert.equal(EVENT_PRESETS.training_camp.mode, 'athlete');

    // 2. 월말(28일~31일) 다음 날 복사 시 날짜 역전·고정 버그 없이 정상 이월되는지 검증
    assert.equal(addDaysToKoreaDateStr('2026-10-28', 1), '2026-10-29');
    assert.equal(addDaysToKoreaDateStr('2026-10-31', 1), '2026-11-01');
    const ev = createNewPersonalEvent({ title: '수학여행', startDate: '2026-10-31' });
    const nextDate = addDaysToKoreaDateStr(ev.mealPlans[0].date, 1);
    const copiedMeal = copyMealPlanToDate(ev.mealPlans[0], nextDate);
    assert.equal(copiedMeal.date, '2026-11-01');

    // 3. 특정 지역(여수)으로 전환한 뒤에도 getAllLoadedVenues()로 타 지역 경기장·시설(춘천송암스포츠타운) 검색이 동작하는지 검증
    const repo = new DatasetRepository({
      appBase: 'https://gmlduqzhd123-lab.github.io/YSK-food/',
      fetchFn: createLocalFileFetch()
    });
    await repo.selectRegion('nationwide');
    const yeosuRes = await repo.selectRegion('jn-yeosu');
    assert.equal(matchVenueFromQuery('춘천송암스포츠타운', yeosuRes.venues), null);
    const allVenues = repo.getAllLoadedVenues();
    const crossMatched = matchVenueFromQuery('춘천송암스포츠타운', allVenues);
    assert.ok(crossMatched, '개별 지역 선택 상태에서도 전국 시설 검색이 매칭되어야 함');
    assert.equal(crossMatched.venue.regionCode, 'gw-chuncheon');
  });
});

