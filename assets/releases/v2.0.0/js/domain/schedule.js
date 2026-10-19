// 회차 좌석·시간 계산(AC11, AC47), 동선·일정 충돌, 확인 이력 상태 머신(AC14, AC52, AC53, AC59), 후보 전환(AC34, AC60), 다일 일정 복사(FR07)
import { addDaysToKoreaDateStr, buildPlannedMealWindow, getKoreaDateTimeParts } from './hours.js';
import { calculateDinersSummary, calculateOrderBudget } from './budget.js';

/**
 * 회차(waves) 착석 인원·소요시간과 실제 식사 인원(diners)·주문 수량(orderedQuantity)을 분리해 검증한다(AC11, AC47).
 */
export function evaluateMealWaves({
  diners = [],
  waves = [],
  orderedQuantity = null,
  availableWindowMinutes = null,
  turnaroundMinutes = 0,
  simultaneousCapacity = null,
  seatingPolicy = 'simultaneous_required',
  keepClassesTogether = false,
  classGroups = []
} = {}) {
  const dinersSummary = calculateDinersSummary(diners);
  const totalDiners = dinersSummary.totalDiners;

  // 회차 분할이 없는 경우(단일 동시 식사)
  if (!Array.isArray(waves) || waves.length === 0) {
    const capacityMet = simultaneousCapacity === null
      ? 'unknown'
      : totalDiners <= simultaneousCapacity
        ? 'met'
        : 'unmet';

    return {
      waveCount: 1,
      dinersTotal: totalDiners,
      orderedQuantity: orderedQuantity ?? totalDiners,
      waveSeatCounts: [totalDiners],
      maxWaveSeated: totalDiners,
      sumWaveSeats: totalDiners,
      totalRequiredMinutes: null,
      availableWindowMinutes,
      exceededMinutes: 0,
      timeStatus: 'ok',
      capacityStatus: capacityMet,
      shortfallSeats: simultaneousCapacity !== null && totalDiners > simultaneousCapacity
        ? totalDiners - simultaneousCapacity
        : 0,
      classSplitViolation: false,
      warnings: []
    };
  }

  const waveSeatCounts = [];
  let maxWaveSeated = 0;
  let sumWaveSeats = 0;
  let sumWaveDurationMinutes = 0;
  const warnings = [];

  waves.forEach((w, idx) => {
    let seatsInWave = 0;
    if (Array.isArray(w.allocations)) {
      for (const alloc of w.allocations) {
        seatsInWave += Number(alloc.seatedCount || 0);
      }
    } else if (typeof w.seatedCount === 'number') {
      seatsInWave = w.seatedCount;
    }
    waveSeatCounts.push(seatsInWave);
    if (seatsInWave > maxWaveSeated) maxWaveSeated = seatsInWave;
    sumWaveSeats += seatsInWave;

    const dur = Number(w.durationMinutes ?? (Number(w.servingMinutes || 0) + Number(w.eatingMinutes || 0)) ?? 0);
    sumWaveDurationMinutes += dur;
  });

  const gapCount = Math.max(0, waves.length - 1);
  const gapTotal = gapCount * Number(turnaroundMinutes || 0);
  const totalRequiredMinutes = sumWaveDurationMinutes + gapTotal;

  let exceededMinutes = 0;
  let timeStatus = 'ok';
  if (typeof availableWindowMinutes === 'number' && availableWindowMinutes > 0 && totalRequiredMinutes > 0) {
    if (totalRequiredMinutes > availableWindowMinutes) {
      exceededMinutes = totalRequiredMinutes - availableWindowMinutes;
      timeStatus = 'exceeded';
      warnings.push(`확보 시간(${availableWindowMinutes}분) 대비 전체 회차 소요시간(${totalRequiredMinutes}분)이 ${exceededMinutes}분 초과됩니다.`);
    }
  }

  // 좌석 수용 조건 판정
  let capacityStatus = 'unknown';
  let shortfallSeats = 0;
  if (seatingPolicy === 'simultaneous_required' && waves.length > 1) {
    capacityStatus = 'unmet';
    warnings.push('동시 식사 필수 조건에서는 여러 회차 분할 식사를 충족으로 인정하지 않습니다.');
  } else if (simultaneousCapacity !== null) {
    if (maxWaveSeated <= simultaneousCapacity) {
      capacityStatus = 'met';
    } else {
      capacityStatus = 'unmet';
      shortfallSeats = maxWaveSeated - simultaneousCapacity;
      warnings.push(`회차 최대 착석 인원(${maxWaveSeated}명)이 식당 동시 수용 인원(${simultaneousCapacity}석)을 ${shortfallSeats}석 초과합니다.`);
    }
  }

  // 반별 함께 식사 조건 검사 (인원만으로 반을 자동 분할하지 않음)
  let classSplitViolation = false;
  if (keepClassesTogether && Array.isArray(classGroups) && classGroups.length > 0) {
    for (const cg of classGroups) {
      if (simultaneousCapacity !== null && cg.count > simultaneousCapacity) {
        classSplitViolation = true;
        warnings.push(`${cg.name || cg.id}(${cg.count}명)은 반별 함께 식사 조건이나 동시 수용(${simultaneousCapacity}석)을 초과합니다.`);
      }
      if (cg.assignedWaves && cg.assignedWaves.length > 1) {
        classSplitViolation = true;
        warnings.push(`${cg.name || cg.id} 인원이 여러 회차로 나뉘어 있어 반별 함께 식사 조건에 위배됩니다.`);
      }
    }
  }

  return {
    waveCount: waves.length,
    dinersTotal: totalDiners,
    // 회차 좌석 합계(예: 51+51=102)로 주문 수량(96)을 절대 덮어쓰지 않는다(AC47)
    orderedQuantity: orderedQuantity !== null && orderedQuantity !== undefined ? orderedQuantity : totalDiners,
    waveSeatCounts,
    maxWaveSeated,
    sumWaveSeats,
    totalRequiredMinutes,
    availableWindowMinutes,
    exceededMinutes,
    timeStatus,
    capacityStatus,
    shortfallSeats,
    classSplitViolation,
    warnings
  };
}

/**
 * 식사 종료·승하차 및 집결 준비·이동시간과 다음 일정 시작 시각의 충돌 검사(PRD 6절, FR04)
 * 이동시간이 없으면 충돌 없음으로 확정하지 않고 '시간 검토 미완료'로 남긴다.
 */
export function evaluateScheduleTransition({
  mealEndMinutes,
  dropoffAndAssemblyMinutes = 0,
  travelMinutes = null,
  nextActivityStartMinutes = null
} = {}) {
  if (nextActivityStartMinutes === null || nextActivityStartMinutes === undefined) {
    return {
      status: 'no_next_activity',
      label: '후속 일정 미입력',
      conflictMinutes: 0
    };
  }
  if (travelMinutes === null || travelMinutes === undefined || travelMinutes === '') {
    return {
      status: 'incomplete_review',
      label: '시간 검토 미완료 (이동시간 미확인)',
      conflictMinutes: null
    };
  }
  const readyAt = Number(mealEndMinutes) + Number(dropoffAndAssemblyMinutes || 0) + Number(travelMinutes);
  if (readyAt > Number(nextActivityStartMinutes)) {
    const diff = readyAt - Number(nextActivityStartMinutes);
    return {
      status: 'conflict',
      label: `다음 일정과 ${diff}분 충돌`,
      conflictMinutes: diff,
      readyAtMinutes: readyAt
    };
  }
  return {
    status: 'ok',
    label: `다음 일정 전 ${Number(nextActivityStartMinutes) - readyAt}분 여유`,
    conflictMinutes: 0,
    marginMinutes: Number(nextActivityStartMinutes) - readyAt,
    readyAtMinutes: readyAt
  };
}

/**
 * 확인 이력 비교용 정규화 스냅샷 생성 (배열 순서·행사 제목·내부 메모 무관 - PRD 6절, AC53)
 */
export function normalizeConditionsSnapshot(snapshot = {}) {
  const diners = Array.isArray(snapshot.diners)
    ? snapshot.diners
        .map(d => ({ groupId: String(d.groupId || d.role || ''), count: Number(d.count || 0) }))
        .sort((a, b) => a.groupId.localeCompare(b.groupId))
    : [];

  const menus = Array.isArray(snapshot.menus)
    ? snapshot.menus
        .filter(m => Number(m.quantity || 0) > 0)
        .map(m => ({
          key: String(m.menuId || m.menuName || ''),
          quantity: Number(m.quantity || 0),
          unitPriceKRW: m.unitPriceKRW === undefined ? null : m.unitPriceKRW
        }))
        .sort((a, b) => a.key.localeCompare(b.key))
    : [];

  const waves = Array.isArray(snapshot.waves)
    ? snapshot.waves
        .map((w, i) => ({
          id: String(w.id || `w-${i}`),
          startTime: String(w.startTime || ''),
          endTime: String(w.endTime || ''),
          seatedCount: Array.isArray(w.allocations)
            ? w.allocations.reduce((s, a) => s + Number(a.seatedCount || 0), 0)
            : Number(w.seatedCount || 0)
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];

  const specialRequests = Array.isArray(snapshot.specialRequests)
    ? [...snapshot.specialRequests].map(s => String(s).trim()).filter(Boolean).sort()
    : [];

  return {
    providerType: snapshot.providerType || 'restaurant',
    providerId: String(snapshot.providerId || ''),
    date: String(snapshot.date || ''),
    plannedStart: String(snapshot.plannedStart || ''),
    plannedEnd: String(snapshot.plannedEnd || ''),
    serviceMode: String(snapshot.serviceMode || 'dine_in'),
    diners,
    menus,
    waves,
    busCount: snapshot.busCount === undefined || snapshot.busCount === null ? null : Number(snapshot.busCount),
    confirmedPriceKRW: snapshot.confirmedPriceKRW === undefined ? null : snapshot.confirmedPriceKRW,
    specialRequests
  };
}

export function extractCurrentConditionsFromMealPlan(mealPlan, candidateRecord = null) {
  const isLodging = mealPlan.providerType === 'lodging';
  const providerId = isLodging
    ? (mealPlan.lodgingSnapshot?.venueId || mealPlan.lodgingSnapshot?.name || 'lodging')
    : (candidateRecord?.restaurantId || '');

  const orderLines = isLodging
    ? []
    : (candidateRecord?.orderDraft?.orderLines || []);

  const menus = orderLines
    .filter(l => Number(l.quantity || 0) > 0)
    .map(l => ({
      menuId: l.menuId || null,
      menuName: l.menuName || l.description || '',
      quantity: Number(l.quantity || 0),
      unitPriceKRW: l.unitPriceKRW ?? null
    }));

  return normalizeConditionsSnapshot({
    providerType: mealPlan.providerType || 'restaurant',
    providerId,
    date: mealPlan.date || '',
    plannedStart: mealPlan.plannedStart || '',
    plannedEnd: mealPlan.plannedEnd || '',
    serviceMode: mealPlan.serviceMode || 'dine_in',
    diners: mealPlan.diners || [],
    menus,
    waves: mealPlan.waves || [],
    busCount: mealPlan.busCount ?? null,
    confirmedPriceKRW: isLodging ? (mealPlan.lodgingCost?.totalKRW ?? null) : (mealPlan.confirmedPriceKRW ?? null),
    specialRequests: mealPlan.specialRequests || []
  });
}

export function areConditionsEqual(snapA, snapB) {
  const normA = normalizeConditionsSnapshot(snapA);
  const normB = normalizeConditionsSnapshot(snapB);
  return JSON.stringify(normA) === JSON.stringify(normB);
}

/**
 * 확인 이력(confirmationHistory)을 checkedAt + sequence 순으로 적용해 현재 상태를 계산한다(FR09, AC14, AC52, AC53, AC59).
 * - referenceOnly === true 인 공유 사본 이력은 현재 상태 판정에서 제외한다(AC55).
 * - 취소(cancellation) 이후 예전 확정으로 자동 복귀하지 않는다(AC52).
 * - 견적 유효기간 만료는 예약 취소가 아닌 '견적 만료·금액 재확인'으로 분리 표시한다(AC52).
 * - quoteId === null 인 예약 확인은 '예약 확정'과 '금액 미확정'을 동시에 표시한다(AC59).
 */
export function evaluateMealPlanStatus(mealPlan, nowDateStr = null) {
  const todayKst = nowDateStr || getKoreaDateTimeParts(new Date())?.dateStr || '2026-10-19';
  const isLodging = mealPlan.providerType === 'lodging';

  let activeCandidate = null;
  let rawConfirmations = [];
  let quoteHistory = [];
  let inquiryStatus = 'none';

  if (isLodging) {
    rawConfirmations = Array.isArray(mealPlan.lodgingConfirmations) ? mealPlan.lodgingConfirmations : [];
    inquiryStatus = mealPlan.lodgingInquiryStatus || 'none';
  } else {
    activeCandidate = (mealPlan.candidateRecords || []).find(c => c.id === mealPlan.selectedCandidateId) || null;
    if (!activeCandidate) {
      return {
        status: 'candidate',
        statusLabel: '후보 미선택',
        amountStatus: 'unconfirmed',
        amountStatusLabel: '금액 미확정',
        quoteExpiryStatus: 'none',
        needsReconfirm: false,
        referenceHistoryCount: 0,
        activeConfirmation: null
      };
    }
    rawConfirmations = Array.isArray(activeCandidate.confirmationHistory) ? activeCandidate.confirmationHistory : [];
    quoteHistory = Array.isArray(activeCandidate.quoteHistory) ? activeCandidate.quoteHistory : [];
    inquiryStatus = activeCandidate.inquiryStatus || 'none';
  }

  const referenceOnlyConfirmations = rawConfirmations.filter(c => c && c.referenceOnly === true);
  // referenceOnly !== true 인 본인 직접 확인 기록만 상태 계산에 사용
  const effectiveConfirmations = rawConfirmations
    .filter(c => c && c.referenceOnly !== true)
    .slice()
    .sort((a, b) => {
      const timeCmp = String(a.checkedAt || '').localeCompare(String(b.checkedAt || ''));
      if (timeCmp !== 0) return timeCmp;
      return Number(a.sequence || 0) - Number(b.sequence || 0);
    });

  // 직접 확인 이력이 전혀 없는 경우
  if (effectiveConfirmations.length === 0) {
    const baseStatus = inquiryStatus === 'contacting' ? 'contacting' : 'candidate';
    return {
      status: baseStatus,
      statusLabel: baseStatus === 'contacting' ? '문의 중' : '후보',
      amountStatus: 'unconfirmed',
      amountStatusLabel: '금액 미확정',
      quoteExpiryStatus: 'none',
      needsReconfirm: false,
      referenceHistoryCount: referenceOnlyConfirmations.length,
      activeConfirmation: null
    };
  }

  // 시간순(checkedAt ASC, sequence ASC) 상태 전이 적용
  let currentKind = null;
  let activeConfirmation = null;

  for (const conf of effectiveConfirmations) {
    if (conf.kind === 'cancellation' || conf.status === 'cancelled') {
      currentKind = 'cancelled';
      activeConfirmation = conf;
    } else if (conf.kind === 'reservation' && conf.status === 'confirmed') {
      currentKind = 'reservation_confirmed';
      activeConfirmation = conf;
    } else if (conf.kind === 'conditions' && conf.status === 'confirmed') {
      // 이미 예약 확정된 상태에서 단순 조건 확인이 추가된 경우 예약 확정 유지, 취소 이후면 조건 확인으로 전환
      if (currentKind !== 'reservation_confirmed') {
        currentKind = 'conditions_confirmed';
        activeConfirmation = conf;
      }
    }
  }

  if (currentKind === 'cancelled') {
    return {
      status: 'cancelled',
      statusLabel: '취소',
      amountStatus: 'cancelled',
      amountStatusLabel: '예약 취소됨',
      quoteExpiryStatus: 'none',
      needsReconfirm: false,
      referenceHistoryCount: referenceOnlyConfirmations.length,
      activeConfirmation
    };
  }

  // 현재 계획 조건과 확인 당시 조건 스냅샷 비교
  const currentConditions = extractCurrentConditionsFromMealPlan(mealPlan, activeCandidate);
  const confirmedConditions = activeConfirmation?.conditionsSnapshot
    ? normalizeConditionsSnapshot(activeConfirmation.conditionsSnapshot)
    : currentConditions;

  const conditionsChanged = !areConditionsEqual(confirmedConditions, currentConditions);

  // 견적 연결 및 유효기간 만료 확인(AC52, AC59)
  let linkedQuote = null;
  if (activeConfirmation?.quoteId) {
    linkedQuote = quoteHistory.find(q => q.id === activeConfirmation.quoteId) || null;
  }

  let quoteExpiryStatus = 'none';
  let quoteExpiryLabel = null;
  if (linkedQuote && linkedQuote.validUntil && linkedQuote.validUntil < todayKst) {
    quoteExpiryStatus = 'expired';
    quoteExpiryLabel = '견적 만료·금액 재확인';
  }

  // 금액 확정 여부 계산
  let amountStatus = 'unconfirmed';
  let amountStatusLabel = '금액 미확정';

  if (isLodging) {
    if (mealPlan.costTreatment === 'included_in_lodging') {
      amountStatus = 'included_in_lodging';
      amountStatusLabel = '숙박비 포함';
    } else if (mealPlan.costTreatment === 'separate' && mealPlan.lodgingCost?.totalKRW !== null && mealPlan.lodgingCost?.totalKRW !== undefined) {
      amountStatus = quoteExpiryStatus === 'expired' || conditionsChanged ? 'needs_reconfirm' : 'confirmed';
      amountStatusLabel = amountStatus === 'confirmed' ? '금액 확인됨' : '금액 재확인 필요';
    }
  } else {
    const budgetCalc = calculateOrderBudget({
      orderLines: activeCandidate.orderDraft?.orderLines || [],
      charges: activeCandidate.orderDraft?.charges || [],
      discounts: activeCandidate.orderDraft?.discounts || [],
      diners: mealPlan.diners || []
    });

    if (activeConfirmation?.quoteId === null) {
      // 견적 없이 예약 조건만 확인한 경우(AC59): 예약 상태와 금액 미확정 동시 표시
      amountStatus = budgetCalc.isTotalConfirmed && activeConfirmation?.conditionsSnapshot?.confirmedPriceKRW !== null && activeConfirmation?.conditionsSnapshot?.confirmedPriceKRW !== undefined
        ? 'confirmed'
        : 'unconfirmed';
      amountStatusLabel = amountStatus === 'confirmed' ? '금액 확인됨' : '금액 미확정';
    } else if (quoteExpiryStatus === 'expired') {
      amountStatus = 'expired_reconfirm';
      amountStatusLabel = '견적 만료·금액 재확인';
    } else if (budgetCalc.isTotalConfirmed) {
      amountStatus = conditionsChanged ? 'needs_reconfirm' : 'confirmed';
      amountStatusLabel = conditionsChanged ? '조건 변경·금액 재확인' : '금액 확정';
    }
  }

  if (conditionsChanged) {
    return {
      status: 'needs_reconfirm',
      statusLabel: '식당 재확인 필요',
      previousConfirmedKind: currentKind,
      amountStatus,
      amountStatusLabel,
      quoteExpiryStatus,
      quoteExpiryLabel,
      needsReconfirm: true,
      referenceHistoryCount: referenceOnlyConfirmations.length,
      activeConfirmation
    };
  }

  const finalStatus = currentKind === 'reservation_confirmed' ? 'reservation_confirmed' : 'conditions_confirmed';
  const finalLabel = finalStatus === 'reservation_confirmed' ? '예약 확정' : '조건 확인';

  return {
    status: finalStatus,
    statusLabel: finalLabel,
    amountStatus,
    amountStatusLabel,
    quoteExpiryStatus,
    quoteExpiryLabel,
    needsReconfirm: false,
    referenceHistoryCount: referenceOnlyConfirmations.length,
    activeConfirmation
  };
}

/**
 * 행사 기본 인원(attendeeGroups) 변경 시 기존 끼니에 미칠 영향을 계산하고,
 * 사용자가 명시적으로 선택한 끼니에만 인원을 반영한다(FR02, AC48).
 * 개별 조정된 끼니·주문·견적을 무단으로 덮어쓰지 않는다.
 */
export function applyEventAttendeeGroupsChange(personalEvent, newAttendeeGroups, options = {}) {
  const { applyToMealPlanIds = null } = options;
  const updatedEvent = structuredClone(personalEvent);
  const oldGroupsMap = new Map(
    (personalEvent.attendeeGroups || []).map(g => [g.id, Number(g.count || 0)])
  );

  const affectedMeals = [];
  const preservedMeals = [];

  for (const mp of updatedEvent.mealPlans || []) {
    const matchesOldDefault = (mp.diners || []).every(
      d => oldGroupsMap.has(d.groupId) && oldGroupsMap.get(d.groupId) === Number(d.count || 0)
    ) && !mp.customAdjustedDiners;

    const shouldApply = Array.isArray(applyToMealPlanIds)
      ? applyToMealPlanIds.includes(mp.id)
      : false; // 명시적 선택 없이는 기존 끼니를 자동 덮어쓰지 않는다(AC48)

    if (shouldApply) {
      mp.diners = newAttendeeGroups.map(g => ({
        groupId: g.id,
        role: g.role || 'student',
        label: g.label || g.id,
        count: Number(g.count || 0),
        budgetPerPersonKRW: g.budgetPerPersonKRW ?? null
      }));
      mp.revision = Number(mp.revision || 1) + 1;
      affectedMeals.push({ mealPlanId: mp.id, date: mp.date, label: mp.label || mp.mealSlot });
    } else {
      preservedMeals.push({
        mealPlanId: mp.id,
        date: mp.date,
        label: mp.label || mp.mealSlot,
        isCustomAdjusted: !matchesOldDefault
      });
    }
  }

  updatedEvent.attendeeGroups = structuredClone(newAttendeeGroups);
  return {
    event: updatedEvent,
    affectedMeals,
    preservedMeals
  };
}

/**
 * 다일 전지훈련·대회 일정의 끼니 계획을 다른 날짜로 복사한다(FR07).
 * 메뉴·인원·단가 작성안(orderDraft)은 복사하되, 예약·조건 확인 이력은 복사하지 않아 자동 예약을 방지한다.
 */
export function copyMealPlanToDate(sourceMealPlan, targetDate, idFactory = null) {
  let seq = 1;
  const nextId = prefix => (idFactory ? idFactory(prefix) : `${prefix}-${Date.now()}-${seq++}`);

  const newMealPlanId = nextId('mp');
  const cloned = structuredClone(sourceMealPlan);
  cloned.id = newMealPlanId;
  cloned.revision = 1;
  cloned.date = targetDate;

  // 시작·종료 시각의 날짜 부분 치환
  if (cloned.plannedStart && cloned.plannedStart.includes('T')) {
    const timePart = cloned.plannedStart.split('T')[1];
    cloned.plannedStart = `${targetDate}T${timePart}`;
  }
  if (cloned.plannedEnd && cloned.plannedEnd.includes('T')) {
    const timePart = cloned.plannedEnd.split('T')[1];
    const endDate = cloned.endNextDay ? addDaysToKoreaDateStr(targetDate, 1) : targetDate;
    cloned.plannedEnd = `${endDate}T${timePart}`;
  }

  cloned.lodgingConfirmations = [];
  cloned.lodgingInquiryStatus = 'none';

  const candidateIdMap = new Map();
  cloned.candidateRecords = (cloned.candidateRecords || []).map(cr => {
    const newCandId = nextId('cand');
    candidateIdMap.set(cr.id, newCandId);
    return {
      id: newCandId,
      mealPlanId: newMealPlanId,
      restaurantId: cr.restaurantId,
      restaurantSnapshot: structuredClone(cr.restaurantSnapshot),
      inquiryStatus: 'none',
      orderDraft: {
        orderLines: (cr.orderDraft?.orderLines || []).map(line => ({
          ...line,
          id: nextId('line')
        })),
        charges: (cr.orderDraft?.charges || []).map(ch => ({
          ...ch,
          id: nextId('chg')
        })),
        discounts: (cr.orderDraft?.discounts || []).map(dc => ({
          ...dc,
          id: nextId('dsc')
        })),
        updatedAt: new Date().toISOString()
      },
      quoteHistory: [],
      confirmationHistory: []
    };
  });

  if (cloned.selectedCandidateId && candidateIdMap.has(cloned.selectedCandidateId)) {
    cloned.selectedCandidateId = candidateIdMap.get(cloned.selectedCandidateId);
  }
  cloned.backupCandidateIds = (cloned.backupCandidateIds || [])
    .map(oldId => candidateIdMap.get(oldId))
    .filter(Boolean);

  return cloned;
}

/**
 * 식당 문의용 표준 연락 문구 생성(FR07)
 */
export function generateRestaurantInquiryText({
  eventTitle,
  date,
  startTime,
  endTime,
  diners = [],
  orderLines = [],
  busCount = null,
  serviceMode = 'dine_in',
  specialRequests = []
} = {}) {
  const dinersSummary = calculateDinersSummary(diners);
  const groupText = diners.map(d => `${d.label || d.groupId} ${d.count}명`).join(', ');
  const menuText = orderLines
    .filter(l => Number(l.quantity || 0) > 0)
    .map(l => `${l.menuName || l.description} ${l.quantity}${l.unit || '인분'}`)
    .join(', ');

  const modeLabel = serviceMode === 'takeout_lunchbox' ? '도시락·포장 수령' : '매장 단체 식사';
  const lines = [
    `[단체식사 문의 - ${eventTitle || '학교·선수단 행사'}]`,
    `• 방문 일시: ${date || '미정'} ${startTime || ''}~${endTime || ''}`,
    `• 이용 형태: ${modeLabel}`,
    `• 인원 구성: 총 ${dinersSummary.totalDiners}명 (${groupText || '인원 미입력'})`,
    `• 희망 메뉴: ${menuText || '식당 협의 희망'}`,
    busCount ? `• 차량 조건: 대형버스 ${busCount}대 (진입·주차 또는 승하차 위치 확인 요청)` : null,
    specialRequests.length ? `• 확인 요청: ${specialRequests.join(', ')}` : null,
    `• 문의 사항: 해당 일시 단체 수용 가능 여부, 배식 소요시간, 1인 단가 및 견적서/카드결제 가능 여부 확인 부탁드립니다.`
  ].filter(Boolean);

  return lines.join('\n');
}
