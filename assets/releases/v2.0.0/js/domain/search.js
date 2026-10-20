// 전국·지역 필터, 단체 조건 4단계 판정(조건 미설정/충족/확인 필요/불충족), 이용 기록 집계(AC19, AC56), 메뉴·공식 지정 판정(AC17, AC18), 기준점 직선거리 정렬(FR04)
import { REGION_GROUPS, STALE_DAYS_THRESHOLD } from '../config.js';
import { getPlaceCoords, isMappablePlace, parseSafeNonNegativeInt } from '../data/normalize.js';
import { evaluateMealWindowHours, getOpenStatus, getKoreaDateTimeParts } from './hours.js';

/**
 * 두 좌표 사이 직선거리(km) 계산 (기존 Haversine 공식 유지)
 */
export function distanceKm(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lng) || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) {
    return null;
  }
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function formatStraightDistance(km) {
  if (km === null || km === undefined || !Number.isFinite(km)) {
    return '거리 미확인';
  }
  const val = km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;
  return `직선거리 ${val}`;
}

/**
 * 확인일로부터 180일 경과 여부 판정(FR10)
 * 180일 경과는 이용 불가(unmet) 판정이 아니라 안내 표시이다.
 */
export function evaluateDataFreshness(checkedAtStr, referenceDateStr = null) {
  if (!checkedAtStr || typeof checkedAtStr !== 'string') {
    return {
      status: 'unverified',
      label: '확인일 미등록',
      isStale: false,
      daysElapsed: null
    };
  }
  const refStr = (referenceDateStr || getKoreaDateTimeParts(new Date())?.dateStr || '2026-10-19').slice(0, 10);
  const chkStr = checkedAtStr.slice(0, 10);
  const [ry, rm, rd] = refStr.split('-').map(Number);
  const [cy, cm, cd] = chkStr.split('-').map(Number);
  const refMs = Date.UTC(ry, rm - 1, rd);
  const chkMs = Date.UTC(cy, cm - 1, cd);
  if (Number.isNaN(refMs) || Number.isNaN(chkMs)) {
    return { status: 'unverified', label: '확인일 형식 미상', isStale: false, daysElapsed: null };
  }
  const daysElapsed = Math.floor((refMs - chkMs) / (24 * 60 * 60 * 1000));
  if (daysElapsed >= STALE_DAYS_THRESHOLD) {
    return {
      status: 'stale',
      label: `확인 후 180일 경과 (${chkStr} 확인)`,
      shortLabel: '확인 후 180일 경과',
      isStale: true,
      daysElapsed
    };
  }
  return {
    status: 'fresh',
    label: `${chkStr} 확인`,
    shortLabel: `${chkStr} 확인`,
    isStale: false,
    daysElapsed
  };
}

/**
 * 사용자 검색 조건 정규화 (빈값은 0으로 바꾸지 않고 null로 유지 - PRD 6절, AC50)
 */
export function normalizeGroupSearchCriteria(raw = {}) {
  const normInt = val => {
    const r = parseSafeNonNegativeInt(val);
    return r.valid && r.value !== null && r.value > 0 ? r.value : null;
  };

  const studentCount = normInt(raw.studentCount);
  const staffCount = normInt(raw.staffCount);
  const otherCount = normInt(raw.otherCount);
  const explicitTotal = normInt(raw.totalHeadcount);

  const sumParts = (studentCount || 0) + (staffCount || 0) + (otherCount || 0);
  const totalHeadcount = explicitTotal !== null ? explicitTotal : (sumParts > 0 ? sumParts : null);

  const budgetPerPersonKRW = normInt(raw.budgetPerPersonKRW);
  const studentBudgetKRW = normInt(raw.studentBudgetKRW) ?? budgetPerPersonKRW;
  const staffBudgetKRW = normInt(raw.staffBudgetKRW) ?? budgetPerPersonKRW;
  const busCount = normInt(raw.busCount);

  const seatingPolicy = raw.seatingPolicy === 'waves_allowed' ? 'waves_allowed' : 'simultaneous_required';
  const busParkingRequired = Boolean(raw.busParkingRequired);
  const privateRoomRequired = Boolean(raw.privateRoomRequired);
  const earlyBreakfastRequired = Boolean(raw.earlyBreakfastRequired);
  const lunchboxRequired = Boolean(raw.lunchboxRequired);
  // 카카오맵 편의시설 정보로 확인 가능한 조건 (단체석·주차·예약)
  const groupSeatRequired = Boolean(raw.groupSeatRequired);
  const parkingRequired = Boolean(raw.parkingRequired);
  const reservationRequired = Boolean(raw.reservationRequired);
  const mealWindow = raw.mealWindow && raw.mealWindow.valid ? raw.mealWindow : null;

  const hasAnyCriterion = Boolean(
    totalHeadcount !== null ||
    studentBudgetKRW !== null ||
    staffBudgetKRW !== null ||
    busCount !== null ||
    mealWindow !== null ||
    privateRoomRequired ||
    earlyBreakfastRequired ||
    lunchboxRequired ||
    groupSeatRequired ||
    parkingRequired ||
    reservationRequired
  );

  return {
    hasAnyCriterion,
    studentCount,
    staffCount,
    otherCount,
    totalHeadcount,
    budgetPerPersonKRW,
    studentBudgetKRW,
    staffBudgetKRW,
    busCount,
    busParkingRequired,
    seatingPolicy,
    privateRoomRequired,
    earlyBreakfastRequired,
    lunchboxRequired,
    groupSeatRequired,
    parkingRequired,
    reservationRequired,
    mealWindow
  };
}

/**
 * 단일 식당에 대한 단체 조건 일치 판정(FR03, PRD 6절, AC09, AC10, AC50)
 * 반환 상태:
 * - 'unset' (조건 미설정: 인원·예산·시간·버스 등 필수 조건을 하나도 입력하지 않은 경우)
 * - 'met' (확인된 조건 충족: 입력한 모든 필수 조건이 확인된 값으로 충족된 경우)
 * - 'needs_check' (추가 확인 필요: 불충족은 없으나 필수 조건 중 미확인 항목이 있는 경우)
 * - 'unmet' (조건 불충족: 입력한 필수 조건 중 확인된 불충족이 하나라도 있는 경우)
 */
export function evaluateRestaurantGroupMatch(restaurant, rawCriteria = {}, options = {}) {
  const criteria = rawCriteria.hasAnyCriterion !== undefined
    ? rawCriteria
    : normalizeGroupSearchCriteria(rawCriteria);

  const gp = restaurant?.groupProfile || {};
  const freshness = evaluateDataFreshness(gp.checkedAt, options.referenceDateStr);

  // 조건 미설정(AC50): 빈 조건 목록을 모두 충족했다는 이유로 단체 조건 충족 배지를 붙이지 않는다
  if (!criteria.hasAnyCriterion) {
    return {
      status: 'unset',
      statusLabel: '조건 미설정',
      badgeText: null,
      items: [],
      unverifiedReasons: [],
      unmetReasons: [],
      freshness,
      reservationDisclaimer: '일반 수용 정보이며 특정 날짜의 예약 확정 여부가 아닙니다.'
    };
  }

  const items = [];
  const unverifiedReasons = [];
  const unmetReasons = [];

  const recordItem = (key, label, status, detail) => {
    items.push({ key, label, status, detail });
    if (status === 'needs_check') unverifiedReasons.push(`${label}: ${detail}`);
    if (status === 'unmet') unmetReasons.push(`${label}: ${detail}`);
  };

  // 1) 인원 및 좌석 방식(동시 식사 필수 vs 교대 식사 허용 - AC09)
  if (criteria.totalHeadcount !== null) {
    const total = criteria.totalHeadcount;
    const simCap = gp.simultaneousCapacity ?? null;
    const wavesInfo = gp.mealWaves || { availability: 'unknown' };

    if (gp.availability === 'no') {
      recordItem('capacity', '단체 수용', 'unmet', '단체 식사 미수용 식당');
    } else if (simCap === null && gp.availability === 'yes' && (gp.seatTypes || []).includes('단체석')) {
      // 좌석 수는 모르지만 카카오맵에 단체석이 있다고 나온 식당은 인원 조건을 충족으로 본다 (인원은 전화 확인)
      recordItem('capacity', '단체석', 'met', `단체석 있음 · ${total}명 수용은 전화 확인`);
    } else if (criteria.seatingPolicy === 'simultaneous_required') {
      if (simCap === null) {
        recordItem('capacity', '동시 식사 인원', 'needs_check', `요청 ${total}명 · 동시 수용 인원 미확인`);
      } else if (total <= simCap) {
        recordItem('capacity', '동시 식사 인원', 'met', `요청 ${total}명 ≤ 동시 수용 ${simCap}명`);
      } else {
        recordItem('capacity', '동시 식사 인원', 'unmet', `요청 ${total}명 > 동시 수용 ${simCap}명 (동시 식사 필수 불충족)`);
      }
    } else {
      // 교대 식사 허용(waves_allowed)
      if (simCap !== null && total <= simCap) {
        recordItem('capacity', '수용 인원', 'met', `동시 수용 ${simCap}명 이내 (${total}명)`);
      } else if (wavesInfo.availability === 'no') {
        recordItem('capacity', '교대 식사', 'unmet', `동시 수용(${simCap ?? '미상'}명) 초과 및 교대 식사 불가`);
      } else if (wavesInfo.availability === 'unknown' || simCap === null) {
        recordItem('capacity', '교대 식사', 'needs_check', `요청 ${total}명 · 교대 식사 가능 여부 및 회차 조건 미확인`);
      } else {
        const maxWaves = wavesInfo.maxWaves ?? null;
        if (maxWaves !== null && total > simCap * maxWaves) {
          recordItem('capacity', '교대 식사', 'unmet', `최대 ${maxWaves}회차 수용 한도(${simCap * maxWaves}명) 초과`);
        } else if (criteria.mealWindow) {
          const wavesNeeded = Math.ceil(total / simCap);
          const minMeal = wavesInfo.minMealMinutes ?? null;
          const turnaround = wavesInfo.turnaroundMinutes ?? null;
          if (minMeal === null || turnaround === null) {
            recordItem('capacity', '교대 식사 시간', 'needs_check', `${wavesNeeded}회차 예상 · 회차당 식사/전환 시간 미확인`);
          } else {
            const reqMin = wavesNeeded * minMeal + Math.max(0, wavesNeeded - 1) * turnaround;
            if (reqMin <= criteria.mealWindow.durationMinutes) {
              recordItem('capacity', '교대 식사', 'met', `${wavesNeeded}회차 운영 가능 (소요 ${reqMin}분 ≤ 확보 ${criteria.mealWindow.durationMinutes}분)`);
            } else {
              recordItem('capacity', '교대 식사', 'unmet', `${wavesNeeded}회차 소요 ${reqMin}분 > 확보 ${criteria.mealWindow.durationMinutes}분`);
            }
          }
        } else {
          recordItem('capacity', '교대 식사', 'met', `교대 식사 가능 (동시 ${simCap}명 기준 분할)`);
        }
      }
    }
  }

  // 2) 대형버스 진입·주차·승하차 조건
  if (criteria.busCount !== null) {
    const parking = gp.parking || { busEntry: 'unknown', busParkingSpaces: null, dropoff: 'unknown' };
    if (parking.busEntry === 'no' && parking.dropoff === 'no') {
      recordItem('bus', '버스 이용', 'unmet', '대형버스 진입 및 승하차 불가');
    } else if (criteria.busParkingRequired) {
      if (parking.busEntry === 'no' || (parking.busParkingSpaces !== null && parking.busParkingSpaces < criteria.busCount)) {
        recordItem('bus', '버스 주차', 'unmet', `버스 ${criteria.busCount}대 주차 불가 (가능 대수: ${parking.busParkingSpaces ?? 0}대)`);
      } else if (parking.busEntry === 'unknown' || parking.busParkingSpaces === null) {
        recordItem('bus', '버스 주차', 'needs_check', `버스 ${criteria.busCount}대 진입·주차 가능 대수 미확인`);
      } else {
        recordItem('bus', '버스 주차', 'met', `버스 ${parking.busParkingSpaces}대 주차 가능 (요청 ${criteria.busCount}대)`);
      }
    } else {
      if (parking.busEntry === 'yes' && parking.busParkingSpaces !== null && parking.busParkingSpaces >= criteria.busCount) {
        recordItem('bus', '버스 조건', 'met', `버스 진입 및 ${parking.busParkingSpaces}대 주차 가능`);
      } else if (parking.dropoff === 'yes') {
        recordItem('bus', '버스 조건', 'met', `버스 승하차 가능 (${parking.dropoffLocation || '승하차 위치 안내 있음'})`);
      } else {
        recordItem('bus', '버스 조건', 'needs_check', `버스 ${criteria.busCount}대 진입·주차·승하차 가능 여부 미확인`);
      }
    }
  }

  // 3) 1인 예산 및 메뉴 단가 비교 (PRD 6절: 가격 기준·학생/인솔자 대상별 예산·추가 필수 비용 확인)
  if (criteria.studentBudgetKRW !== null || criteria.staffBudgetKRW !== null) {
    const menus = Array.isArray(restaurant?.menus) ? restaurant.menus : [];
    const pricedMenus = menus.filter(m => m.priceKRW !== null && m.priceKRW !== undefined);

    if (pricedMenus.length === 0) {
      recordItem('budget', '1인 예산', 'needs_check', '등록된 메뉴 단가 미확인');
    } else {
      const perPersonMenus = pricedMenus.filter(m => m.priceBasis === 'per_person');
      if (perPersonMenus.length === 0) {
        // 테이블/세트 기준 메뉴는 1인 가격으로 임의 환산하지 않는다
        recordItem('budget', '1인 예산', 'needs_check', '1인 기준 단가 미확인 (세트·테이블 기준 메뉴만 존재)');
      } else {
        const studentLimit = criteria.studentBudgetKRW ?? criteria.staffBudgetKRW;
        const staffLimit = criteria.staffBudgetKRW ?? criteria.studentBudgetKRW;
        const matchingStudentMenus = perPersonMenus.filter(m => m.priceKRW <= studentLimit);
        const matchingStaffMenus = perPersonMenus.filter(m => m.priceKRW <= staffLimit);

        if (matchingStudentMenus.length === 0) {
          recordItem('budget', '1인 예산', 'unmet', `확인된 1인 메뉴 최저가(${Math.min(...perPersonMenus.map(m => m.priceKRW)).toLocaleString()}원)가 예산(${studentLimit.toLocaleString()}원) 초과`);
        } else if ((criteria.staffCount || 0) > 0 && criteria.staffBudgetKRW === null && criteria.budgetPerPersonKRW === null) {
          recordItem('budget', '1인 예산', 'needs_check', '학생 단가만 확인되었으며 인솔자 식사 예산·단가 확인 필요');
        } else if ((criteria.staffCount || 0) > 0 && matchingStaffMenus.length === 0) {
          recordItem('budget', '1인 예산', 'unmet', `인솔자 1인 예산(${staffLimit.toLocaleString()}원) 이내 메뉴 없음`);
        } else if (criteria.privateRoomRequired && gp.room?.roomFeeKRW === null) {
          recordItem('budget', '1인 예산', 'needs_check', '메뉴 단가는 예산 이내이나 별도 공간 추가 비용 미확인');
        } else {
          recordItem('budget', '1인 예산', 'met', `1인 메뉴 단가 충족 (${matchingStudentMenus[0].name} ${matchingStudentMenus[0].priceKRW.toLocaleString()}원)`);
        }
      }
    }
  }

  // 4) 방문 날짜·식사 시간 구간
  if (criteria.mealWindow) {
    const hoursEval = evaluateMealWindowHours(restaurant, criteria.mealWindow, options);
    recordItem('hours', '식사 시간', hoursEval.status, hoursEval.message);
  }

  // 5) 추가 선택 조건(별도 공간, 조식, 도시락)
  if (criteria.privateRoomRequired) {
    const pr = gp.room?.privateRoom || 'unknown';
    if (pr === 'yes') recordItem('privateRoom', '별도 공간', 'met', '단체 별도 공간(룸·단독홀) 보유');
    else if (pr === 'no') recordItem('privateRoom', '별도 공간', 'unmet', '별도 공간 없음');
    else recordItem('privateRoom', '별도 공간', 'needs_check', '별도 공간 유무 미확인');
  }

  if (criteria.earlyBreakfastRequired) {
    const eb = gp.earlyBreakfast?.availability || 'unknown';
    if (eb === 'yes') recordItem('earlyBreakfast', '단체 조식', 'met', `조식 가능 (${gp.earlyBreakfast?.earliestTime || '사전 예약'})`);
    else if (eb === 'no') recordItem('earlyBreakfast', '단체 조식', 'unmet', '이른 조식 제공 불가');
    else recordItem('earlyBreakfast', '단체 조식', 'needs_check', '단체 예약 시 조식 가능 여부 미확인');
  }

  if (criteria.lunchboxRequired) {
    const lb = gp.lunchbox?.availability || 'unknown';
    if (lb === 'yes') recordItem('lunchbox', '단체 도시락·포장', 'met', `도시락·포장 가능 (${gp.lunchbox?.pickupMethod || '사전 주문'})`);
    else if (lb === 'no') recordItem('lunchbox', '단체 도시락·포장', 'unmet', '단체 도시락·포장 불가');
    else recordItem('lunchbox', '단체 도시락·포장', 'needs_check', '단체 도시락 주문 가능 여부 미확인');
  }

  // 6) 카카오맵 편의시설 정보 기반 조건 (정보가 없으면 '확인 필요'로 두고 목록에서 빼지 않는다)
  if (criteria.groupSeatRequired) {
    if (gp.availability === 'yes') recordItem('groupSeat', '단체석', 'met', '단체석 있음 (인원은 전화 확인)');
    else if (gp.availability === 'no') recordItem('groupSeat', '단체석', 'unmet', '단체 식사 미수용');
    else recordItem('groupSeat', '단체석', 'needs_check', '단체석 정보 없음');
  }
  if (criteria.parkingRequired) {
    if (gp.parking?.busEntry === 'yes' || gp.parking?.walkingNotes) recordItem('parking', '주차', 'met', gp.parking?.walkingNotes || '주차 가능');
    else recordItem('parking', '주차', 'needs_check', '주차 정보 없음');
  }
  if (criteria.reservationRequired) {
    if (gp.preOrder?.leadTimeNote) recordItem('reservation', '예약', 'met', gp.preOrder.leadTimeNote);
    else recordItem('reservation', '예약', 'needs_check', '예약 가능 여부 정보 없음');
  }

  let overallStatus = 'met';
  if (unmetReasons.length > 0) {
    overallStatus = 'unmet';
  } else if (unverifiedReasons.length > 0) {
    overallStatus = 'needs_check';
  }

  const statusLabelMap = {
    met: '확인된 조건 충족',
    needs_check: '추가 확인 필요',
    unmet: '조건 불충족'
  };

  return {
    status: overallStatus,
    statusLabel: statusLabelMap[overallStatus],
    badgeText: overallStatus === 'met'
      ? '확인된 조건 충족 (예약 별도 확인)'
      : overallStatus === 'needs_check'
        ? `확인 필요 (${unverifiedReasons.length}건 미확인)`
        : '필수 조건 불충족',
    items,
    unverifiedReasons,
    unmetReasons,
    freshness,
    reservationDisclaimer: '일반 수용 조건 비교 결과이며, 해당 행사 날짜의 빈자리·예약 확정이 아닙니다.'
  };
}

/**
 * 교사·지도자의 이용 기록 집계 및 '반복 이용 사례 있음' 배지 판정(FR05, AC19, AC56)
 * - 초안(isLocalDraft), 미검토(reviewStatus !== 'approved'), 미동의(publicConsent !== true), 미래 방문일 제외
 * - duplicateGroupId가 있는 기록만 동일 실제 방문으로 묶고, 값이 없으면 기록 ID를 유지(같은 날짜·학교명만으로 자동 합산 금지)
 * - 하루 식사를 2개 배식 회차로 나눈 기록에 동일 duplicateGroupId(또는 동일 visitSessionKey+운영자 확인)가 부여된 경우 1회 방문으로 집계
 * - 최근 12개월 검토된 실제 방문 3건 이상 & 서로 다른 방문일 2일 이상일 때만 '반복 이용 사례 있음' 표시
 */
export function aggregateVisitRecordsForRestaurant(visitRecords = [], restaurantId, referenceDateStr = null) {
  const refDate = (referenceDateStr || getKoreaDateTimeParts(new Date())?.dateStr || '2026-10-19').slice(0, 10);
  const [ry, rm, rd] = refDate.split('-').map(Number);
  const windowStartMs = Date.UTC(ry - 1, rm - 1, rd);
  const windowStartDate = new Date(windowStartMs).toISOString().slice(0, 10);

  const matchingRaw = (visitRecords || []).filter(r => r && r.restaurantId === restaurantId);
  let excludedDraftOrUnreviewedCount = 0;

  const approvedRecords = [];
  for (const rec of matchingRaw) {
    if (
      rec.isLocalDraft === true ||
      rec.reviewStatus !== 'approved' ||
      rec.publicConsent !== true ||
      !rec.visitDate ||
      rec.visitDate > refDate
    ) {
      excludedDraftOrUnreviewedCount++;
      continue;
    }
    approvedRecords.push(rec);
  }

  // 운영자가 확인한 duplicateGroupId가 있을 때만 하나로 묶고, 없으면 개별 기록 ID로 유지(AC19, AC56)
  const uniqueVisitsMap = new Map();
  for (const rec of approvedRecords) {
    const dedupKey = rec.duplicateGroupId && String(rec.duplicateGroupId).trim()
      ? `dup:${String(rec.duplicateGroupId).trim()}`
      : `id:${rec.id}`;

    if (!uniqueVisitsMap.has(dedupKey)) {
      uniqueVisitsMap.set(dedupKey, {
        dedupKey,
        visitDate: rec.visitDate,
        mealSlot: rec.mealSlot || 'lunch',
        visitSessionKey: rec.visitSessionKey || null,
        eventType: rec.eventType,
        groupSize: rec.groupSize,
        menuSummary: rec.menuSummary,
        unitPriceKRW: rec.unitPriceKRW ?? null,
        serviceMinutes: rec.serviceMinutes ?? null,
        busNotes: rec.busNotes || null,
        reviewedAt: rec.reviewedAt || null,
        sourceType: rec.sourceType || 'user_report_verified',
        records: [rec]
      });
    } else {
      uniqueVisitsMap.get(dedupKey).records.push(rec);
    }
  }

  const allVerifiedVisits = Array.from(uniqueVisitsMap.values()).sort(
    (a, b) => b.visitDate.localeCompare(a.visitDate)
  );

  const recent12mVisits = allVerifiedVisits.filter(
    v => v.visitDate >= windowStartDate && v.visitDate <= refDate
  );

  const recent12mDistinctDates = new Set(recent12mVisits.map(v => v.visitDate)).size;
  const hasRepeatVisitBadge = recent12mVisits.length >= 3 && recent12mDistinctDates >= 2;

  return {
    restaurantId,
    referenceDate: refDate,
    aggregationWindow: `${windowStartDate} ~ ${refDate} (최근 12개월)`,
    policyDescription: '최근 12개월 내 운영자 검토를 마친 실제 단체 방문 3건 이상 · 서로 다른 방문일 2일 이상 기준 (교사 자격 인증이나 교육청 공식 추천이 아님)',
    totalVerifiedVisits: allVerifiedVisits.length,
    recent12mVisitCount: recent12mVisits.length,
    recent12mDistinctDates,
    excludedDraftOrUnreviewedCount,
    hasRepeatVisitBadge,
    badgeLabel: hasRepeatVisitBadge
      ? '반복 이용 사례 있음'
      : allVerifiedVisits.length > 0
        ? `검토된 이용 사례 ${allVerifiedVisits.length}건`
        : '이용 사례 미등록',
    verifiedVisits: allVerifiedVisits
  };
}

/**
 * 학생 메뉴 항목 및 원재료·조리 과정 답변 표시 정보 구성(FR06, AC17)
 * 메뉴 이름·맵기 조절 가능 여부만으로 알레르기·식사 안전을 자동 판정하지 않는다.
 */
export function evaluateMenuSafetyDisplay(menu) {
  const triLabel = val => (val === 'yes' ? '가능' : val === 'no' ? '불가' : '미확인');
  const ing = menu?.ingredientResponse || { status: 'unknown', answerText: null, cookingProcessNote: null, checkedAt: null };
  const hasIngredientAnswer = ing.status === 'answered' && Boolean(ing.answerText);

  return {
    menuId: menu?.id || null,
    name: menu?.name || '',
    priceText: menu?.priceKRW !== null && menu?.priceKRW !== undefined
      ? `${Number(menu.priceKRW).toLocaleString()}원 (${menu.priceBasis === 'per_person' ? '1인 기준' : menu.priceBasis === 'per_table' ? '테이블 기준' : menu.priceBasis === 'per_set' ? '세트 기준' : '기준 미확인'})`
      : '가격 미확인',
    studentPortionLabel: `학생용 양 조절: ${triLabel(menu?.studentPortion)}`,
    spiceAdjustmentLabel: `맵기 조절: ${triLabel(menu?.spiceAdjustment)}`,
    extraRiceLabel: `추가 밥 제공: ${triLabel(menu?.extraRice)}`,
    altMenuInquiryLabel: `대체 메뉴 문의: ${triLabel(menu?.altMenuInquiry)}`,
    ingredientStatus: hasIngredientAnswer ? 'answered' : 'unknown',
    ingredientLabel: hasIngredientAnswer
      ? `식당 원재료·조리 답변: ${ing.answerText}${ing.cookingProcessNote ? ` (${ing.cookingProcessNote})` : ''} [${ing.checkedAt || '확인일 미상'}]`
      : '원재료·조리 과정 답변: 미확인',
    autoSafetyJudgment: null, // 자동 안전 판정 생성 금지(AC17)
    safetyNotice: '특정 재료 제외나 맵기 조절 가능 여부만으로 전체 알레르기 안전이 보장되지 않으므로 방문 전 식당과 직접 재확인하세요.'
  };
}

/**
 * 공식 지정 정보(위생등급·안심식당 등)의 유효·만료·취소·동명업소 모호 상태 구분(FR06, AC18)
 */
export function evaluateOfficialDesignations(restaurant, referenceDateStr = null) {
  const refDate = (referenceDateStr || getKoreaDateTimeParts(new Date())?.dateStr || '2026-10-19').slice(0, 10);
  const rawList = Array.isArray(restaurant?.officialDesignations) ? restaurant.officialDesignations : [];

  const items = rawList.map(d => {
    const isRevoked = Boolean(d.revokedAt) || d.status === 'revoked';
    const isExpired = Boolean(d.validTo && d.validTo < refDate) || d.status === 'expired';
    const isAmbiguousMatch = d.addressMatchStatus && d.addressMatchStatus !== 'matched';

    let effectiveStatus = 'active';
    let badgeAllowed = true;
    let statusLabel = '유효 지정';

    if (isRevoked) {
      effectiveStatus = 'revoked';
      badgeAllowed = false;
      statusLabel = `지정 취소 (${d.revokedAt || '취소됨'})`;
    } else if (isExpired) {
      effectiveStatus = 'expired';
      badgeAllowed = false;
      statusLabel = `지정 기간 만료 (${d.validTo} 종료)`;
    } else if (isAmbiguousMatch || d.status !== 'active') {
      effectiveStatus = 'unverified_match';
      badgeAllowed = false;
      statusLabel = '상호·주소 대조 검토 중 (유효 배지 제외)';
    }

    return {
      ...d,
      effectiveStatus,
      badgeAllowed,
      statusLabel
    };
  });

  const validDesignations = items.filter(i => i.badgeAllowed);
  return {
    hasValidDesignation: validDesignations.length > 0,
    validDesignations,
    allDesignations: items,
    separationNotice: '공식 지정 유효 여부와 학교·선수단 단체식사 수용 조건은 별개의 정보입니다.'
  };
}

/**
 * 이용 모드(일반 맛집 / 학교 단체식사 / 선수단 식사)별 업종·메뉴 적합성 판정
 * - 초등학교 선생님·초등학생 방문 및 선수단 식사 모드('school' | 'athlete')에서는
 *   포차·술집, 주류 중심 업소, 단순 커피/디저트 카페, 날생선회/술안주 위주 업소를 추천에서 제외한다.
 */
const EXCLUDED_CATEGORIES_FOR_GROUP_MODES = new Set(['포차·술집', '카페·디저트']);
const ALCOHOL_OR_BAR_REGEX = /포차|술집|주점|양조장|호프|이자카야|맥주|소주|와인|막걸리/;
const RAW_FISH_OR_ADULT_MENU_REGEX = /선어회|삼치회|활어회|전어회|물회|사시미|해물삼합|돌문어삼합|딱새우회|낙지탕탕이|흑염소/;

export function isSuitableForMode(place, mode = 'general') {
  if (!place || typeof place !== 'object') return false;
  if (!mode || mode === 'general') return true;

  const categories = Array.isArray(place.categoryIds)
    ? place.categoryIds
    : (place.category ? [place.category] : []);

  // 1) 포차·술집 및 카페·디저트 카테고리 제외
  if (categories.some(c => EXCLUDED_CATEGORIES_FOR_GROUP_MODES.has(c))) {
    return false;
  }

  const nameAndMenu = `${place.name || ''} ${place.menuSummary || ''} ${place.menu || ''}`;

  // 2) 상호나 메뉴에 포차·술집·양조장·주류가 포함된 곳 제외 (예: 41번포차, 교동포차 등)
  if (ALCOHOL_OR_BAR_REGEX.test(nameAndMenu)) {
    return false;
  }

  // 3) 초등학생·선수단 단체 식사에 부적합한 날생선회·술안주 전용 업소 제외
  if (RAW_FISH_OR_ADULT_MENU_REGEX.test(nameAndMenu)) {
    return false;
  }

  // 4) 선수단 식사 모드에서는 간식성 매점 단품 업소 제외
  if (mode === 'athlete' && /매점|꼬마김밥/.test(nameAndMenu)) {
    return false;
  }

  return true;
}

/**
 * 현재 선택된 모드에 적합한 카테고리 버튼 목록 및 추천 순서 반환
 */
const PREFERRED_CATEGORY_ORDER_BY_MODE = {
  school: ['백반·한식', '양식·일식', '고기', '한정식', '국밥·탕', '면', '분식·중식', '닭요리'],
  athlete: ['고기', '백반·한식', '국밥·탕', '닭요리', '한정식', '양식·일식', '면', '분식·중식'],
  general: ['백반·한식', '고기', '양식·일식', '국밥·탕', '한정식', '면', '닭요리', '분식·중식', '해산물', '게장', '짱뚱어·꼬막', '장어', '재첩', '카페·디저트', '포차·술집']
};

export function getCategoriesForMode(restaurantsOrMode = [], mode = 'general') {
  if (typeof restaurantsOrMode === 'string') {
    const m = restaurantsOrMode;
    return [...(PREFERRED_CATEGORY_ORDER_BY_MODE[m] || PREFERRED_CATEGORY_ORDER_BY_MODE.general)];
  }
  const restaurants = Array.isArray(restaurantsOrMode) ? restaurantsOrMode : [];
  const suitablePlaces = restaurants.filter(p => isSuitableForMode(p, mode));
  const rawCats = [
    ...new Set(
      suitablePlaces
        .flatMap(p => (Array.isArray(p.categoryIds) ? p.categoryIds : [p.category]))
        .filter(Boolean)
    )
  ].filter(cat => (mode === 'general' ? true : !EXCLUDED_CATEGORIES_FOR_GROUP_MODES.has(cat)));

  const orderList = PREFERRED_CATEGORY_ORDER_BY_MODE[mode] || PREFERRED_CATEGORY_ORDER_BY_MODE.general;
  return rawCats.sort((a, b) => {
    const ia = orderList.indexOf(a);
    const ib = orderList.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b, 'ko');
  });
}

/**
 * 초등학교 선생님·초등학생 및 선수단 모드별 맞춤 추천 우선순위 점수 계산 (높을수록 상단 추천)
 */
export function computeModeRecommendationScore(place, mode = 'general') {
  let score = 0;
  const categories = Array.isArray(place.categoryIds) ? place.categoryIds : [place.category];
  const primaryCat = categories[0] || '';
  const text = `${place.name || ''} ${place.menuSummary || ''} ${place.menu || ''} ${place.note || ''}`;

  // 1) 단체 수용 확인 완료(초등·선수단 맞춤 큐레이션 식당) 최우선
  if (place.groupProfile?.availability === 'yes') {
    score += 300;
  }

  // 2) 지도 좌표가 확인된 식당 우선
  if (isMappablePlace(place)) {
    score += 40;
  }

  if (mode === 'school') {
    // 초등학교 선생님과 초등학생이 가장 선호하는 대표 식사 메뉴 가산점
    if (/돈가스|돈까스|함박스테이크|카레|떡갈비|불고기|수제버거|오므라이스/.test(text)) {
      score += 120;
    } else if (/백반|정식|비빔밥|칼국수|만두|수제비|밀면|냉면|짜장|탕수육|보쌈|삼계탕|간장닭갈비|순살/.test(text)) {
      score += 80;
    }
    const catRank = PREFERRED_CATEGORY_ORDER_BY_MODE.school.indexOf(primaryCat);
    if (catRank !== -1) {
      score += (10 - catRank) * 5;
    }
  } else if (mode === 'athlete') {
    // 초등 선수단 영양·단백질 보충 식사 메뉴 가산점
    if (/불고기|떡갈비|갈비탕|설렁탕|곰탕|삼계탕|백숙|돼지갈비|삼겹살|수육|보쌈|돈가스|돈까스/.test(text)) {
      score += 130;
    } else if (/백반|한정식|국밥|닭갈비|닭구이|오리|칼국수|만두/.test(text)) {
      score += 85;
    }
    if (place.groupProfile?.earlyBreakfast?.availability === 'yes') {
      score += 25;
    }
    const catRank = PREFERRED_CATEGORY_ORDER_BY_MODE.athlete.indexOf(primaryCat);
    if (catRank !== -1) {
      score += (10 - catRank) * 5;
    }
  } else {
    // 일반 모드에서도 포차·술집이나 숫자 시작 상호가 무조건 최상단에 오지 않도록 식사 업종 우선
    if (primaryCat === '포차·술집') {
      score -= 100;
    } else if (/돈가스|돈까스|불고기|떡갈비|백반|한정식|갈비탕|설렁탕|칼국수/.test(text)) {
      score += 50;
    }
  }

  return score;
}

/**
 * 검색·필터·단체 조건 분류·정렬 통합 실행(FR01, FR03, FR04)
 * - 단체 조건이 입력된 경우 결과를 '확인된 조건 충족(confirmedMetList)'과 '추가 확인 필요(needsCheckList)'로 분리한다.
 * - 확인된 필수 조건 불충족(unmet)은 기본 결과에서 제외하되 제외 건수를 반환한다.
 */
export function filterAndClassifyRestaurants(restaurants = [], filterState = {}, visitRecords = []) {
  const {
    mode = 'general',
    regionCode = 'all',
    city = 'all',
    category = 'all',
    query = '',
    favOnly = false,
    openOnly = false,
    favoriteIds = new Set(),
    referencePoint = null, // { lat, lng, label, type }
    sortBy = 'default',    // 'default' | 'distance' | 'price' | 'checkedAt'
    includeNeedsCheck = true,
    groupCriteria = {},
    now = new Date(),
    referenceDateStr = null
  } = filterState;

  const normalizedCriteria = normalizeGroupSearchCriteria(groupCriteria);
  const q = String(query || '').trim().toLowerCase();

  // 권역 묶음 코드('nationwide', 'seoul-metro', 'all' 등) 해석
  const groupDef = REGION_GROUPS[regionCode] || null;
  const allowedRegionSet = groupDef
    ? (groupDef.regionCodes ? new Set(groupDef.regionCodes) : null)
    : (regionCode && regionCode !== 'all' && regionCode !== 'nationwide' ? new Set([regionCode]) : null);

  const allEvaluated = [];
  const confirmedMetList = [];
  const needsCheckList = [];
  const excludedUnmetList = [];

  for (const place of restaurants) {
    // 지역 필터
    if (allowedRegionSet && !allowedRegionSet.has(place.regionCode)) continue;
    if (city !== 'all' && place.city !== city && place.regionCode !== city) continue;

    // 이용 모드별 적합 업종·메뉴 필터 (학교 단체식사·선수단 식사에서 술집·포차·카페·날생선회 자동 제외)
    if (!isSuitableForMode(place, mode)) continue;

    // 종류 필터
    const placeCategories = Array.isArray(place.categoryIds) ? place.categoryIds : [place.category];
    if (category !== 'all' && !placeCategories.includes(category)) continue;

    // 즐겨찾기 필터 (문자열 영구 ID 기준)
    const favSet = favoriteIds instanceof Set ? favoriteIds : new Set(favoriteIds);
    if (favOnly && !favSet.has(place.id)) continue;

    // 영업 중 필터
    if (openOnly && getOpenStatus(place, now) !== true) continue;

    // 검색어(이름·지점명·메뉴·주소·지역·공개 메모)
    if (q) {
      const menuNames = Array.isArray(place.menus) ? place.menus.map(m => m.name).join(' ') : (place.menu || '');
      const haystack = [
        place.name,
        place.branchName,
        place.city,
        place.address,
        ...placeCategories,
        menuNames,
        place.note
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) continue;
    }

    // 기준점 직선거리 계산(FR04)
    let straightDistanceKm = null;
    if (referencePoint && Number.isFinite(referencePoint.lat) && Number.isFinite(referencePoint.lng)) {
      const coords = getPlaceCoords(place);
      if (coords) {
        straightDistanceKm = distanceKm(referencePoint, coords);
      }
    }

    const groupMatch = evaluateRestaurantGroupMatch(place, normalizedCriteria, { referenceDateStr });
    const visitSummary = aggregateVisitRecordsForRestaurant(visitRecords, place.id, referenceDateStr);
    const designationSummary = evaluateOfficialDesignations(place, referenceDateStr);
    const modeScore = computeModeRecommendationScore(place, mode);

    const enriched = {
      ...place,
      distance: straightDistanceKm !== null ? straightDistanceKm : Infinity,
      straightDistanceKm,
      straightDistanceLabel: formatStraightDistance(straightDistanceKm),
      groupMatch,
      visitSummary,
      designationSummary,
      modeScore
    };

    if (groupMatch.status === 'unmet') {
      excludedUnmetList.push(enriched);
      continue;
    }

    if (groupMatch.status === 'needs_check') {
      needsCheckList.push(enriched);
      if (includeNeedsCheck) allEvaluated.push(enriched);
    } else {
      // 'met' 또는 'unset'
      confirmedMetList.push(enriched);
      allEvaluated.push(enriched);
    }
  }

  const minVerifiedPerPersonPrice = p => {
    const perPerson = (p.menus || []).filter(m => m.priceKRW !== null && m.priceBasis === 'per_person');
    if (!perPerson.length) return Infinity;
    return Math.min(...perPerson.map(m => m.priceKRW));
  };

  const sortFn = (a, b) => {
    // 단체 조건이 설정된 경우 '확인된 조건 충족(met)'을 '추가 확인 필요(needs_check)'보다 항상 먼저 배치(PRD 6절)
    if (normalizedCriteria.hasAnyCriterion && a.groupMatch.status !== b.groupMatch.status) {
      if (a.groupMatch.status === 'met') return -1;
      if (b.groupMatch.status === 'met') return 1;
    }
    if (sortBy === 'distance' || referencePoint) {
      if (a.distance !== b.distance) return a.distance - b.distance;
    }
    if (sortBy === 'price') {
      const pa = minVerifiedPerPersonPrice(a);
      const pb = minVerifiedPerPersonPrice(b);
      if (pa !== pb) return pa - pb;
    }
    if (sortBy === 'checkedAt') {
      const ca = a.groupProfile?.checkedAt || '';
      const cb = b.groupProfile?.checkedAt || '';
      if (ca !== cb) return cb.localeCompare(ca);
    }
    // 기본 정렬 시 모드별 초등학생·교사·선수단 추천 적합도 점수 우선 적용
    if (sortBy === 'default' && a.modeScore !== b.modeScore) {
      return b.modeScore - a.modeScore;
    }
    return a.name.localeCompare(b.name, 'ko');
  };

  confirmedMetList.sort(sortFn);
  needsCheckList.sort(sortFn);
  allEvaluated.sort(sortFn);

  return {
    hasGroupCriteria: normalizedCriteria.hasAnyCriterion,
    criteria: normalizedCriteria,
    combinedList: allEvaluated,
    confirmedMetList,
    needsCheckList,
    excludedUnmetList,
    counts: {
      totalMatched: allEvaluated.length,
      confirmedMet: confirmedMetList.length,
      needsCheck: needsCheckList.length,
      excludedUnmet: excludedUnmetList.length,
      mappable: allEvaluated.filter(isMappablePlace).length,
      unverifiedCoords: allEvaluated.filter(p => !isMappablePlace(p)).length
    }
  };
}
