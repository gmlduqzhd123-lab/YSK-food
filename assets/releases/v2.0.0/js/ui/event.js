// 내 행사(PersonalEvent) 생성·후보 담기·주문안(orderDraft)·견적(Quote)·확인 이력(Confirmation) 관리, 인솔용 인쇄 화면(FR09, AC28), 전이 의존 모듈 포함 오프라인 준비 검증(AC25, AC42)
import { APP_BASE, APP_VERSION, EVENT_PRESETS, resolveAppUrl } from '../config.js';
import { addDaysToKoreaDateStr, buildPlannedMealWindow, getKoreaDateTimeParts } from '../domain/hours.js';
import { calculateDinersSummary, calculateOrderBudget, evaluateMealPlanCost } from '../domain/budget.js';
import {
  evaluateMealPlanStatus,
  evaluateMealWaves,
  evaluateScheduleTransition,
  extractCurrentConditionsFromMealPlan
} from '../domain/schedule.js';
import { createRestaurantSnapshot, generatePersonalId } from '../storage.js';

let confirmationSequenceCounter = 1;

/**
 * 새 개인 행사(PersonalEvent) 기본 객체 생성(FR02, FR09)
 */
export function createNewPersonalEvent({
  title = '2026 현장체험학습 단체식사 계획',
  eventType = 'field_trip',
  startDate = '2026-10-23',
  dayCount = 1,
  studentCount = 80,
  staffCount = 6,
  otherCount = 0,
  studentBudgetKRW = 10000,
  staffBudgetKRW = 12000,
  busCount = 2,
  idFactory = generatePersonalId
} = {}) {
  const eventId = idFactory('evt');
  const nowIso = new Date().toISOString();
  const preset = EVENT_PRESETS[eventType] || EVENT_PRESETS.field_trip;

  const dates = [];
  for (let i = 0; i < Math.max(1, Number(dayCount || 1)); i++) {
    dates.push(addDaysToKoreaDateStr(startDate, i));
  }

  const studentGroupId = idFactory('grp');
  const staffGroupId = idFactory('grp');
  const attendeeGroups = [
    {
      id: studentGroupId,
      role: 'student',
      label: preset.mode === 'athlete' ? '선수' : '학생',
      count: Number(studentCount || 0),
      budgetPerPersonKRW: studentBudgetKRW ?? null
    },
    {
      id: staffGroupId,
      role: 'staff',
      label: preset.mode === 'athlete' ? '지도자·감독' : '인솔교사',
      count: Number(staffCount || 0),
      budgetPerPersonKRW: staffBudgetKRW ?? null
    }
  ];

  if (Number(otherCount || 0) > 0) {
    attendeeGroups.push({
      id: idFactory('grp'),
      role: 'other',
      label: '기타 인원(기사님 등)',
      count: Number(otherCount),
      budgetPerPersonKRW: staffBudgetKRW ?? null
    });
  }

  // 전지훈련(training_camp) 또는 다일 행사는 날짜별 기본 끼니 틀을 생성(FR02)
  const mealPlans = [];
  const slots = eventType === 'training_camp' || dates.length > 1
    ? [
        { slot: 'breakfast', label: '조식', start: '07:30', end: '08:30' },
        { slot: 'lunch', label: '중식', start: '12:00', end: '13:10' },
        { slot: 'dinner', label: '석식', start: '18:00', end: '19:10' }
      ]
    : [{ slot: 'lunch', label: '중식', start: '12:00', end: '13:10' }];

  for (const d of dates) {
    for (const s of slots) {
      mealPlans.push(
        createMealPlanForEvent({
          eventId,
          date: d,
          mealSlot: s.slot,
          label: `${d} ${s.label}`,
          startTime: s.start,
          endTime: s.end,
          attendeeGroups,
          providerType: 'restaurant',
          seatingPolicy: preset.seatingPolicy,
          busCount,
          idFactory
        })
      );
    }
  }

  return {
    id: eventId,
    revision: 1,
    title: String(title || '새 행사 식사 계획').trim(),
    eventType,
    dates,
    attendeeGroups,
    venueSnapshots: [],
    mealPlans,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

/**
 * 행사 내 개별 끼니(MealPlan) 생성
 */
export function createMealPlanForEvent({
  eventId,
  date = '2026-10-23',
  mealSlot = 'lunch',
  label = '중식',
  startTime = '12:00',
  endTime = '13:00',
  endNextDay = false,
  attendeeGroups = [],
  providerType = 'restaurant',
  costTreatment = null,
  seatingPolicy = 'simultaneous_required',
  busCount = null,
  idFactory = generatePersonalId
} = {}) {
  const mealPlanId = idFactory('mp');
  const windowRes = buildPlannedMealWindow({ date, startTime, endTime, endNextDay });
  const effectiveCostTreatment = costTreatment || (providerType === 'lodging' ? 'included_in_lodging' : 'separate');

  const diners = attendeeGroups.map(g => ({
    groupId: g.id,
    role: g.role || 'student',
    label: g.label || g.id,
    count: Number(g.count || 0),
    budgetPerPersonKRW: g.budgetPerPersonKRW ?? null
  }));

  return {
    id: mealPlanId,
    eventId,
    revision: 1,
    date,
    mealSlot,
    label,
    plannedStart: windowRes.valid ? windowRes.plannedStart : `${date}T12:00:00+09:00`,
    plannedEnd: windowRes.valid ? windowRes.plannedEnd : `${date}T13:00:00+09:00`,
    endNextDay: Boolean(endNextDay),
    serviceMode: 'dine_in',
    busCount: busCount !== undefined ? busCount : null,
    diners,
    customAdjustedDiners: false,
    providerType,
    costTreatment: effectiveCostTreatment,
    lodgingSnapshot: providerType === 'lodging'
      ? { venueId: 'lodging-default', name: '행사 숙소 식당', address: '', phone: null }
      : null,
    lodgingCost: providerType === 'lodging' && effectiveCostTreatment === 'separate'
      ? { totalKRW: null, checkedAt: null, conditionsSnapshot: null, notes: null }
      : null,
    lodgingConfirmations: [],
    candidateRecords: [],
    selectedCandidateId: null,
    backupCandidateIds: [],
    seatingPolicy,
    waves: [],
    travelLegs: [],
    specialRequests: []
  };
}

/**
 * 끼니(MealPlan)에 외부 식당 후보(CandidateRecord)를 추가하고 스냅샷을 저장한다(FR09, AC20, AC34, AC60).
 * 선택 후보를 바꾸어도 이전 후보의 orderDraft·quoteHistory·confirmationHistory를 새 후보에 승계하지 않는다.
 */
export function addCandidateToMealPlan(mealPlan, restaurant, options = {}) {
  const {
    datasetVersion = '2026.10.1',
    sources = [],
    selectAsPrimary = true,
    idFactory = generatePersonalId
  } = options;

  const existing = (mealPlan.candidateRecords || []).find(c => c.restaurantId === restaurant.id);
  if (existing) {
    if (selectAsPrimary) {
      mealPlan.selectedCandidateId = existing.id;
    }
    return { candidateRecord: existing, alreadyExists: true };
  }

  const candidateId = idFactory('cand');
  const snapshot = createRestaurantSnapshot(restaurant, candidateId, datasetVersion, sources);

  // 해당 후보 식당 고유의 기본 주문 작성안(orderDraft) 생성 (다른 후보의 메뉴나 단가를 복사하지 않음 - AC60)
  const firstMenu = (restaurant.menus || [])[0] || null;
  const orderLines = (mealPlan.diners || []).map(d => ({
    id: idFactory('line'),
    targetGroupId: d.groupId,
    menuId: firstMenu ? firstMenu.id : null,
    menuName: firstMenu ? firstMenu.name : (restaurant.menu || '기본 식사 메뉴'),
    unit: '1인분',
    quantity: Number(d.count || 0),
    unitPriceKRW: firstMenu && firstMenu.priceKRW !== null ? firstMenu.priceKRW : null
  }));

  const candidateRecord = {
    id: candidateId,
    mealPlanId: mealPlan.id,
    restaurantId: restaurant.id,
    restaurantSnapshot: snapshot,
    inquiryStatus: 'none',
    orderDraft: {
      orderLines,
      charges: [],
      discounts: [],
      updatedAt: new Date().toISOString()
    },
    quoteHistory: [],
    confirmationHistory: []
  };

  if (!Array.isArray(mealPlan.candidateRecords)) {
    mealPlan.candidateRecords = [];
  }
  mealPlan.candidateRecords.push(candidateRecord);

  if (selectAsPrimary || !mealPlan.selectedCandidateId) {
    if (mealPlan.selectedCandidateId && mealPlan.selectedCandidateId !== candidateId) {
      if (!mealPlan.backupCandidateIds.includes(mealPlan.selectedCandidateId)) {
        mealPlan.backupCandidateIds.push(mealPlan.selectedCandidateId);
      }
    }
    mealPlan.selectedCandidateId = candidateId;
  } else if (!mealPlan.backupCandidateIds.includes(candidateId)) {
    mealPlan.backupCandidateIds.push(candidateId);
  }

  return { candidateRecord, alreadyExists: false };
}

/**
 * 선택 후보 전환(AC34, AC60):
 * 후보 A에서 후보 B로 바꾸면 B가 selectedCandidateId가 되며,
 * A의 견적·확인 이력·orderDraft는 A에 그대로 보존되고 B에 확정 상태나 메뉴·단가가 승계되지 않는다.
 */
export function selectMealPlanCandidate(mealPlan, candidateId) {
  const target = (mealPlan.candidateRecords || []).find(c => c.id === candidateId);
  if (!target) {
    return { switched: false, reason: 'CANDIDATE_NOT_FOUND' };
  }
  const prevId = mealPlan.selectedCandidateId;
  mealPlan.selectedCandidateId = candidateId;
  mealPlan.backupCandidateIds = (mealPlan.backupCandidateIds || []).filter(id => id !== candidateId);
  if (prevId && prevId !== candidateId && !mealPlan.backupCandidateIds.includes(prevId)) {
    mealPlan.backupCandidateIds.push(prevId);
  }
  return {
    switched: true,
    selectedCandidate: target,
    statusEvaluation: evaluateMealPlanStatus(mealPlan)
  };
}

/**
 * 후보 식당의 현재 작성안(orderDraft)을 기반으로 새 견적 이력(Quote)을 추가한다(PRD 7절, AC34).
 * 이전 견적을 덮어쓰지 않고 새 Quote를 추가한다.
 */
export function recordCandidateQuote(mealPlan, candidateId, quoteOptions = {}) {
  const candidate = (mealPlan.candidateRecords || []).find(c => c.id === candidateId);
  if (!candidate) return { recorded: false, reason: 'CANDIDATE_NOT_FOUND' };

  const idFactory = quoteOptions.idFactory || generatePersonalId;
  const quoteId = idFactory('quo');
  const draft = candidate.orderDraft || { orderLines: [], charges: [], discounts: [] };

  const newQuote = {
    id: quoteId,
    candidateId: candidate.id,
    mealPlanRevision: mealPlan.revision || 1,
    quotedAt: quoteOptions.quotedAt || getKoreaDateTimeParts(new Date())?.isoDateTime || new Date().toISOString(),
    validUntil: quoteOptions.validUntil || null,
    orderLines: structuredClone(draft.orderLines || []),
    charges: structuredClone(draft.charges || []),
    discounts: structuredClone(draft.discounts || []),
    paymentNotes: quoteOptions.paymentNotes || null,
    documentNotes: quoteOptions.documentNotes || null
  };

  if (!Array.isArray(candidate.quoteHistory)) candidate.quoteHistory = [];
  candidate.quoteHistory.push(newQuote);
  return { recorded: true, quote: newQuote };
}

/**
 * 식사 계획에 대한 조건 확인 / 예약 확정 / 취소 이력(Confirmation)을 기록한다(FR09, AC14, AC52, AC59).
 * - quoteId는 null을 허용한다(견적 없이 날짜·인원·메뉴만 예약 확인한 경우 - AC59).
 * - 외부 식당 식사를 조건 확인·예약 확정으로 기록하려면 실제 식사 인원 > 0 및 유효한 주문 항목이 있어야 한다(FR08).
 */
export function recordMealConfirmation(mealPlan, input = {}) {
  const {
    candidateId = mealPlan.selectedCandidateId,
    kind = 'reservation', // 'conditions' | 'reservation' | 'cancellation'
    quoteId = null,
    checkedAt = null,
    method = 'phone',
    notes = null,
    confirmedPriceKRW = undefined,
    idFactory = generatePersonalId
  } = input;

  const isLodging = mealPlan.providerType === 'lodging';
  const dinersSummary = calculateDinersSummary(mealPlan.diners || []);

  if (kind !== 'cancellation' && dinersSummary.totalDiners <= 0) {
    return {
      recorded: false,
      code: 'ZERO_DINERS_NOT_ALLOWED_FOR_CONFIRMATION',
      message: '식사 인원이 0명인 초안 상태에서는 조건 확인이나 예약 확정으로 전환할 수 없습니다.'
    };
  }

  const nowIso = getKoreaDateTimeParts(new Date())?.isoDateTime || new Date().toISOString();
  const effectiveCheckedAt = checkedAt || nowIso;
  const seq = confirmationSequenceCounter++;

  if (isLodging) {
    const snap = extractCurrentConditionsFromMealPlan(mealPlan, null);
    if (confirmedPriceKRW !== undefined) snap.confirmedPriceKRW = confirmedPriceKRW;

    const conf = {
      id: idFactory('lconf'),
      mealPlanId: mealPlan.id,
      providerType: 'lodging',
      providerId: mealPlan.lodgingSnapshot?.venueId || 'lodging-default',
      candidateId: null,
      quoteId: null,
      mealPlanRevision: mealPlan.revision || 1,
      kind,
      status: kind === 'cancellation' ? 'cancelled' : 'confirmed',
      referenceOnly: false,
      checkedAt: effectiveCheckedAt,
      recordedAt: nowIso,
      sequence: seq,
      method,
      conditionsSnapshot: snap,
      notes
    };
    if (!Array.isArray(mealPlan.lodgingConfirmations)) mealPlan.lodgingConfirmations = [];
    mealPlan.lodgingConfirmations.push(conf);
    if (mealPlan.lodgingCost && mealPlan.costTreatment === 'separate') {
      mealPlan.lodgingCost.conditionsSnapshot = {
        date: mealPlan.date,
        totalDiners: dinersSummary.totalDiners,
        totalKRW: mealPlan.lodgingCost.totalKRW
      };
    }
    return {
      recorded: true,
      confirmation: conf,
      statusEvaluation: evaluateMealPlanStatus(mealPlan)
    };
  }

  const candidate = (mealPlan.candidateRecords || []).find(c => c.id === candidateId);
  if (!candidate) {
    return { recorded: false, code: 'CANDIDATE_NOT_FOUND', message: '확인 이력을 기록할 후보 식당을 찾을 수 없습니다.' };
  }

  // 외부 식당 완료 조건 검사(FR08): 유효 주문 수량 > 0 필요
  if (kind !== 'cancellation') {
    const budgetCalc = calculateOrderBudget({
      orderLines: candidate.orderDraft?.orderLines || [],
      charges: candidate.orderDraft?.charges || [],
      discounts: candidate.orderDraft?.discounts || [],
      diners: mealPlan.diners || []
    });
    if (!budgetCalc.canCompleteExternalMeal) {
      return {
        recorded: false,
        code: 'INVALID_OR_EMPTY_ORDER',
        message: '외부 식당을 조건 확인·예약 확정으로 기록하려면 실제 식사 인원과 1개 이상의 유효한 메뉴 주문 수량이 있어야 합니다.',
        errors: budgetCalc.errors
      };
    }
  }

  // quoteId가 지정된 경우 해당 후보의 견적인지 검증
  if (quoteId !== null) {
    const hasQuote = (candidate.quoteHistory || []).some(q => q.id === quoteId);
    if (!hasQuote) {
      return {
        recorded: false,
        code: 'QUOTE_NOT_IN_CANDIDATE',
        message: '연결하려는 견적(quoteId)이 해당 후보 식당의 견적 이력에 존재하지 않습니다.'
      };
    }
  }

  const snap = extractCurrentConditionsFromMealPlan(mealPlan, candidate);
  if (confirmedPriceKRW !== undefined) {
    snap.confirmedPriceKRW = confirmedPriceKRW;
  }

  const conf = {
    id: idFactory('conf'),
    mealPlanId: mealPlan.id,
    providerType: 'restaurant',
    providerId: candidate.restaurantId,
    candidateId: candidate.id,
    quoteId: quoteId ?? null,
    mealPlanRevision: mealPlan.revision || 1,
    kind,
    status: kind === 'cancellation' ? 'cancelled' : 'confirmed',
    referenceOnly: false,
    checkedAt: effectiveCheckedAt,
    recordedAt: nowIso,
    sequence: seq,
    method,
    conditionsSnapshot: snap,
    notes
  };

  if (!Array.isArray(candidate.confirmationHistory)) candidate.confirmationHistory = [];
  candidate.confirmationHistory.push(conf);

  return {
    recorded: true,
    confirmation: conf,
    statusEvaluation: evaluateMealPlanStatus(mealPlan)
  };
}

/**
 * 오프라인 준비 완료 검증(FR09, Section 9, AC25, AC42)
 * - 1) 개인 행사 저장 트랜잭션 완료 확인
 * - 2) asset-manifest.json에 선언된 해당 앱 버전의 엔트리·직접 및 간접(전이) 의존 모듈·화면/인쇄 CSS·설치 도우미 전체 캐시 성공 확인
 * - 필수 모듈이 단 하나라도 실패하면 미완료(ready: false)로 반환한다.
 */
export async function verifyOfflineReadiness({
  storageManager,
  eventToSave = null,
  appBase = APP_BASE,
  appVersion = APP_VERSION,
  cacheStorage = globalThis.caches,
  fetchFn = globalThis.fetch?.bind(globalThis)
} = {}) {
  // 1) 행사 저장 트랜잭션 확인
  if (eventToSave && storageManager) {
    const saveRes = await storageManager.saveEvent(eventToSave, eventToSave.revision);
    if (!saveRes.saved) {
      return {
        ready: false,
        status: 'event_save_failed',
        missingAssets: [],
        message: `개인 행사 저장이 완료되지 않아 오프라인 준비를 마칠 수 없습니다: ${saveRes.message || saveRes.status}`
      };
    }
  }

  const manifestRelPath = `assets/releases/${appVersion}/asset-manifest.json`;
  const manifestUrl = resolveAppUrl(manifestRelPath, appBase);

  let assetManifest;
  try {
    const res = await fetchFn(manifestUrl, { credentials: 'same-origin' });
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status}`);
    assetManifest = await res.json();
  } catch (err) {
    return {
      ready: false,
      status: 'manifest_load_failed',
      missingAssets: [manifestRelPath],
      message: '앱 필수 자산 목록(asset-manifest.json)을 확인하지 못해 오프라인 준비가 미완료되었습니다.'
    };
  }

  const requiredAssets = Array.isArray(assetManifest?.requiredAssets) ? assetManifest.requiredAssets : [];
  if (requiredAssets.length === 0) {
    return {
      ready: false,
      status: 'empty_asset_manifest',
      missingAssets: [],
      message: '필수 자산 목록이 비어 있습니다.'
    };
  }

  const missingAssets = [];
  const verifiedAssets = [];
  const cacheName = `ysk-food-app-${appVersion}`;

  for (const relPath of requiredAssets) {
    const fullUrl = resolveAppUrl(relPath, appBase);
    let cachedOk = false;

    if (cacheStorage) {
      try {
        const cache = await cacheStorage.open(cacheName);
        let match = await cache.match(fullUrl);
        if (!match) {
          const netRes = await fetchFn(fullUrl, { credentials: 'same-origin' });
          if (netRes && netRes.ok) {
            const textPreview = await netRes.clone().text();
            // JS/CSS/JSON 자산 자리에 HTML 대체 응답이 들어온 경우 캐시 실패로 처리(AC26, AC42)
            const isHtmlFallback =
              !relPath.endsWith('.html') &&
              relPath !== './' &&
              (textPreview.trim().startsWith('<!DOCTYPE') || textPreview.trim().startsWith('<html'));
            if (!isHtmlFallback) {
              await cache.put(fullUrl, netRes.clone());
              match = netRes;
            }
          }
        }
        if (match && match.ok) {
          cachedOk = true;
        }
      } catch {
        cachedOk = false;
      }
    }

    if (cachedOk) {
      verifiedAssets.push(relPath);
    } else {
      missingAssets.push(relPath);
    }
  }

  if (missingAssets.length > 0) {
    return {
      ready: false,
      status: 'incomplete_assets',
      verifiedCount: verifiedAssets.length,
      totalRequiredCount: requiredAssets.length,
      missingAssets,
      message: `필수 앱 모듈·자산 중 ${missingAssets.length}개(${missingAssets.slice(0, 3).join(', ')})가 캐시되지 않아 오프라인 준비가 미완료되었습니다.`
    };
  }

  return {
    ready: true,
    status: 'ready',
    verifiedCount: verifiedAssets.length,
    totalRequiredCount: requiredAssets.length,
    missingAssets: [],
    limitationsNotice: '저장한 일정·식당 주소·연락처·견적·인솔 인쇄 화면은 오프라인에서 열람할 수 있습니다. (단, 지도 타일·실시간 교통·외부 길찾기·전화 연결은 네트워크 및 통신망이 필요합니다.)',
    message: `오프라인 준비 완료 (필수 모듈·스타일 ${verifiedAssets.length}개 및 행사 스냅샷 검증 완료)`
  };
}

/**
 * 인솔교사·지도자용 인쇄 화면 DOM 생성(FR09, AC28)
 * 표 머리글·날짜·식당·연락처·대체 식당이 페이지 밖으로 잘리지 않게 구성한다.
 */
export function buildTeacherPrintViewDom(personalEvent) {
  const wrap = document.createElement('div');
  wrap.className = 'print-sheet';

  const title = document.createElement('h2');
  title.className = 'print-title';
  title.textContent = `📋 인솔용 단체식사 일정표 — ${personalEvent.title}`;
  wrap.appendChild(title);

  const groupSummary = (personalEvent.attendeeGroups || [])
    .map(g => `${g.label}: ${g.count}명`)
    .join(' / ');
  const meta = document.createElement('p');
  meta.className = 'print-meta';
  meta.textContent = `행사 기간: ${(personalEvent.dates || []).join(', ')} · 인원 구성: ${groupSummary} · 출력 시각: ${
    getKoreaDateTimeParts(new Date())?.dateStr || ''
  }`;
  wrap.appendChild(meta);

  const table = document.createElement('table');
  table.className = 'print-table';
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th scope="col">날짜·구분·시간</th>
      <th scope="col">선택 식당·숙소 (주소·연락처)</th>
      <th scope="col">인원·회차·메뉴·견적</th>
      <th scope="col">확인 상태·버스·대체 식당</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const mp of personalEvent.mealPlans || []) {
    const tr = document.createElement('tr');
    const statusEval = evaluateMealPlanStatus(mp);
    const costEval = evaluateMealPlanCost(mp);
    const dinersSummary = calculateDinersSummary(mp.diners || []);
    const selectedCand = (mp.candidateRecords || []).find(c => c.id === mp.selectedCandidateId);
    const backups = (mp.candidateRecords || []).filter(c => (mp.backupCandidateIds || []).includes(c.id));

    const tdTime = document.createElement('td');
    const startHHMM = (mp.plannedStart || '').split('T')[1]?.slice(0, 5) || '';
    const endHHMM = (mp.plannedEnd || '').split('T')[1]?.slice(0, 5) || '';
    tdTime.textContent = `${mp.date} (${mp.label || mp.mealSlot})\n${startHHMM} ~ ${endHHMM}`;

    const tdPlace = document.createElement('td');
    if (mp.providerType === 'lodging') {
      const lSnap = mp.lodgingSnapshot || {};
      tdPlace.textContent = `[숙소 제공] ${lSnap.name || '숙소 식당'}\n주소: ${lSnap.address || '미입력'}\n전화: ${lSnap.phone || '미입력'}`;
    } else if (selectedCand) {
      const rSnap = selectedCand.restaurantSnapshot || {};
      tdPlace.textContent = `${rSnap.name || selectedCand.restaurantId}\n주소: ${rSnap.address || '미확인'}\n전화: ${rSnap.phone || '미등록'}`;
    } else {
      tdPlace.textContent = '선택된 식당 없음';
    }

    const tdOrder = document.createElement('td');
    const wavesInfo = evaluateMealWaves({
      diners: mp.diners || [],
      waves: mp.waves || []
    });
    const menuSummary = selectedCand
      ? (selectedCand.orderDraft?.orderLines || [])
          .filter(l => Number(l.quantity || 0) > 0)
          .map(l => `${l.menuName} ${l.quantity}${l.unit || '인분'}`)
          .join(', ')
      : mp.providerType === 'lodging'
        ? '숙소 식단'
        : '-';
    tdOrder.textContent = `식사 인원: ${dinersSummary.totalDiners}명 (회차: ${wavesInfo.waveCount}회차, 최대 착석 ${wavesInfo.maxWaveSeated}석)\n메뉴: ${menuSummary || '-'}\n비용: ${costEval.displayLabel}`;

    const tdStatus = document.createElement('td');
    const backupNames = backups.map(b => `${b.restaurantSnapshot?.name || b.restaurantId}(${b.restaurantSnapshot?.phone || '전화미상'})`).join(', ') || '미지정';
    const busNotes = selectedCand?.restaurantSnapshot?.publicFacts?.groupProfile?.parking?.dropoffLocation || (mp.busCount ? `버스 ${mp.busCount}대` : '버스 정보 없음');
    tdStatus.textContent = `상태: ${statusEval.statusLabel} (${statusEval.amountStatusLabel})\n버스·승하차: ${busNotes}\n대체 후보: ${backupNames}`;

    tr.append(tdTime, tdPlace, tdOrder, tdStatus);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}
