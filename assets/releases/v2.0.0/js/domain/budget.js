// 예산 계산, 주문 수량·단가·추가비용·할인 안전 정수 검증, 숙소 식비 처리, 3개 후보 견적 비교
import { parseSafeNonNegativeInt } from '../data/normalize.js';

/**
 * 숫자 입력을 빈 문자열 -> null 정규화 후 0 이상 안전 정수로 검증한다(AC13, AC51).
 */
export function normalizeIntegerInput(raw, allowNull = true) {
  if (raw === null || raw === undefined) {
    return allowNull
      ? { valid: true, value: null }
      : { valid: false, value: null, code: 'REQUIRED_INTEGER', message: '값을 입력해 주세요.' };
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return allowNull
      ? { valid: true, value: null }
      : { valid: false, value: null, code: 'REQUIRED_INTEGER', message: '값을 입력해 주세요.' };
  }
  const parsed = parseSafeNonNegativeInt(raw);
  if (!parsed.valid) {
    const msgMap = {
      NEGATIVE_NOT_ALLOWED: '음수는 입력할 수 없습니다.',
      FLOAT_NOT_ALLOWED: '소수는 입력할 수 없으며 원/명 단위 정수만 허용됩니다.',
      UNSAFE_INTEGER: '안전 정수 범위(Number.MAX_SAFE_INTEGER)를 초과했습니다.',
      NOT_A_NUMBER: '숫자 형식이 아닙니다.',
      NON_FINITE: '유한한 숫자가 아닙니다.'
    };
    return {
      valid: false,
      value: null,
      code: parsed.reason || 'INVALID_INTEGER',
      message: msgMap[parsed.reason] || '유효하지 않은 정수입니다.'
    };
  }
  return { valid: true, value: parsed.value };
}

function safeAdd(a, b) {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum < 0) return null;
  return sum;
}

function safeMultiply(a, b) {
  const prod = a * b;
  if (!Number.isSafeInteger(prod) || prod < 0) return null;
  return prod;
}

/**
 * 끼니별 식사 대상(diners) 인원 합계 계산 (회차 좌석 합계와 분리 - AC47)
 */
export function calculateDinersSummary(diners = []) {
  const errors = [];
  const byGroup = {};
  let totalDiners = 0;

  if (!Array.isArray(diners)) {
    return { valid: false, totalDiners: 0, byGroup: {}, errors: ['식사 대상(diners) 목록이 배열이 아닙니다.'] };
  }

  diners.forEach((d, idx) => {
    const countRes = normalizeIntegerInput(d?.count, false);
    if (!countRes.valid) {
      errors.push(`식사 대상[${idx}] (${d?.label || d?.groupId || '집단'}): ${countRes.message}`);
      return;
    }
    const nextTotal = safeAdd(totalDiners, countRes.value);
    if (nextTotal === null) {
      errors.push('식사 대상 총인원이 안전 정수 범위를 초과했습니다.');
      return;
    }
    totalDiners = nextTotal;
    const key = d.groupId || d.role || `group-${idx}`;
    byGroup[key] = {
      groupId: key,
      role: d.role || 'student',
      label: d.label || key,
      count: countRes.value,
      budgetPerPersonKRW: d.budgetPerPersonKRW ?? null
    };
  });

  return {
    valid: errors.length === 0,
    totalDiners,
    byGroup,
    errors
  };
}

/**
 * 외부 식당 주문 작성안(orderDraft) 또는 견적(Quote)의 금액을 계산한다(FR08, AC12, AC13, AC51).
 * - 수량 0인 주문 행은 작성안에는 유지하되 비용 합산과 미확정 판정에서 제외한다.
 * - 수량 > 0 이고 단가가 null(미확인)이면 confirmedSubtotal에는 더하지 않고 총액 미확정(isTotalConfirmed = false)으로 표시한다.
 * - 할인 금액은 명시한 적용 대상의 확인된 금액을 초과할 수 없으며, 음수 결과를 0원으로 임의 보정하지 않고 저장 차단(valid = false)한다.
 */
export function calculateOrderBudget({
  orderLines = [],
  charges = [],
  discounts = [],
  diners = [],
  candidateRestaurantId = null,
  candidateMenus = null
} = {}) {
  const errors = [];
  const warnings = [];
  const lineResults = [];
  const unconfirmedItems = [];

  let confirmedOrderSubtotalKRW = 0;
  let activeLineCount = 0;
  let totalOrderedQuantity = 0;
  const orderedQtyByGroup = {};
  const confirmedAmountByGroup = {};
  const confirmedAmountByLineId = {};

  const validMenuIds = Array.isArray(candidateMenus)
    ? new Set(candidateMenus.map(m => m.id))
    : null;

  for (let i = 0; i < orderLines.length; i++) {
    const line = orderLines[i];
    const lineLabel = line?.menuName || line?.description || `주문항목 #${i + 1}`;

    // 후보 식당의 메뉴 ID가 지정된 경우 해당 후보의 메뉴인지 검증(AC60)
    if (line?.menuId && validMenuIds && !validMenuIds.has(line.menuId)) {
      errors.push(`${lineLabel}: 선택한 후보 식당(${candidateRestaurantId || ''})의 메뉴가 아닙니다 (${line.menuId}).`);
      continue;
    }

    const qtyRes = normalizeIntegerInput(line?.quantity, false);
    if (!qtyRes.valid) {
      errors.push(`${lineLabel} 수량 오류: ${qtyRes.message}`);
      continue;
    }
    const qty = qtyRes.value;

    const priceRes = normalizeIntegerInput(line?.unitPriceKRW, true);
    if (!priceRes.valid) {
      errors.push(`${lineLabel} 단가 오류: ${priceRes.message}`);
      continue;
    }
    const unitPrice = priceRes.value;

    // 수량 0인 행은 작성안에는 보존하되 비용·미확정 판정에서 제외(AC51)
    if (qty === 0) {
      lineResults.push({
        id: line?.id || `line-${i + 1}`,
        targetGroupId: line?.targetGroupId || null,
        menuId: line?.menuId || null,
        menuName: lineLabel,
        unit: line?.unit || '1인분',
        quantity: 0,
        unitPriceKRW: unitPrice,
        lineTotalKRW: 0,
        excludedZeroQty: true,
        priceConfirmed: unitPrice !== null
      });
      continue;
    }

    activeLineCount++;
    const nextQtyTotal = safeAdd(totalOrderedQuantity, qty);
    if (nextQtyTotal === null) {
      errors.push(`${lineLabel}: 주문 수량 합계가 안전 정수 범위를 초과했습니다.`);
      continue;
    }
    totalOrderedQuantity = nextQtyTotal;

    const groupId = line?.targetGroupId || 'all';
    orderedQtyByGroup[groupId] = (orderedQtyByGroup[groupId] || 0) + qty;

    if (unitPrice === null) {
      unconfirmedItems.push({
        kind: 'order_line',
        id: line?.id || `line-${i + 1}`,
        label: lineLabel,
        quantity: qty,
        reason: '단가 미확인'
      });
      lineResults.push({
        id: line?.id || `line-${i + 1}`,
        targetGroupId: line?.targetGroupId || null,
        menuId: line?.menuId || null,
        menuName: lineLabel,
        unit: line?.unit || '1인분',
        quantity: qty,
        unitPriceKRW: null,
        lineTotalKRW: null,
        excludedZeroQty: false,
        priceConfirmed: false
      });
    } else {
      const lineTotal = safeMultiply(qty, unitPrice);
      if (lineTotal === null) {
        errors.push(`${lineLabel}: 금액 곱셈 결과가 안전 정수 범위를 초과했습니다.`);
        continue;
      }
      const nextSub = safeAdd(confirmedOrderSubtotalKRW, lineTotal);
      if (nextSub === null) {
        errors.push(`${lineLabel}: 주문 소계가 안전 정수 범위를 초과했습니다.`);
        continue;
      }
      confirmedOrderSubtotalKRW = nextSub;
      confirmedAmountByGroup[groupId] = (confirmedAmountByGroup[groupId] || 0) + lineTotal;
      if (line?.id) confirmedAmountByLineId[line.id] = lineTotal;

      lineResults.push({
        id: line?.id || `line-${i + 1}`,
        targetGroupId: line?.targetGroupId || null,
        menuId: line?.menuId || null,
        menuName: lineLabel,
        unit: line?.unit || '1인분',
        quantity: qty,
        unitPriceKRW: unitPrice,
        lineTotalKRW: lineTotal,
        excludedZeroQty: false,
        priceConfirmed: true
      });
    }
  }

  // 추가 비용(포장비, 별도 공간 비용 등)
  let confirmedChargesKRW = 0;
  const chargeResults = [];
  for (let i = 0; i < charges.length; i++) {
    const ch = charges[i];
    const chLabel = ch?.label || ch?.type || `추가비용 #${i + 1}`;
    const amtRes = normalizeIntegerInput(ch?.amountKRW, true);
    if (!amtRes.valid) {
      errors.push(`${chLabel} 금액 오류: ${amtRes.message}`);
      continue;
    }
    if (amtRes.value === null) {
      unconfirmedItems.push({
        kind: 'charge',
        id: ch?.id || `charge-${i + 1}`,
        label: chLabel,
        reason: '추가 비용 금액 미확인'
      });
      chargeResults.push({ id: ch?.id || `charge-${i + 1}`, label: chLabel, amountKRW: null, confirmed: false });
    } else {
      const nextCharges = safeAdd(confirmedChargesKRW, amtRes.value);
      if (nextCharges === null) {
        errors.push(`${chLabel}: 추가 비용 합계가 안전 정수 범위를 초과했습니다.`);
        continue;
      }
      confirmedChargesKRW = nextCharges;
      chargeResults.push({ id: ch?.id || `charge-${i + 1}`, label: chLabel, amountKRW: amtRes.value, confirmed: true });
    }
  }

  const confirmedGrossKRW = safeAdd(confirmedOrderSubtotalKRW, confirmedChargesKRW);
  if (confirmedGrossKRW === null) {
    errors.push('확인된 주문 소계와 추가 비용의 합계가 안전 정수 범위를 초과했습니다.');
  }

  // 할인 검증 (명시한 적용 대상의 확인된 금액을 초과할 수 없음 - AC51)
  let confirmedDiscountsKRW = 0;
  const discountResults = [];
  for (let i = 0; i < discounts.length; i++) {
    const dc = discounts[i];
    const dcLabel = dc?.label || `할인 #${i + 1}`;
    const amtRes = normalizeIntegerInput(dc?.amountKRW, false);
    if (!amtRes.valid) {
      errors.push(`${dcLabel} 할인 금액 오류: ${amtRes.message}`);
      continue;
    }
    const dcAmount = amtRes.value;
    const targetScope = dc?.targetScope || 'total';
    let targetConfirmedMax = confirmedGrossKRW ?? 0;

    if (targetScope === 'order_subtotal') {
      targetConfirmedMax = confirmedOrderSubtotalKRW;
    } else if (targetScope === 'charges') {
      targetConfirmedMax = confirmedChargesKRW;
    } else if (targetScope.startsWith('group:')) {
      const gId = targetScope.slice('group:'.length);
      targetConfirmedMax = confirmedAmountByGroup[gId] || 0;
    } else if (targetScope.startsWith('line:')) {
      const lId = targetScope.slice('line:'.length);
      targetConfirmedMax = confirmedAmountByLineId[lId] || 0;
    }

    if (dcAmount > targetConfirmedMax) {
      errors.push(`${dcLabel}: 할인 금액(${dcAmount.toLocaleString()}원)이 적용 대상(${targetScope})의 확인된 금액(${targetConfirmedMax.toLocaleString()}원)을 초과합니다.`);
      continue;
    }

    const nextDiscounts = safeAdd(confirmedDiscountsKRW, dcAmount);
    if (nextDiscounts === null) {
      errors.push(`${dcLabel}: 할인 합계가 안전 정수 범위를 초과했습니다.`);
      continue;
    }
    confirmedDiscountsKRW = nextDiscounts;
    discountResults.push({
      id: dc?.id || `discount-${i + 1}`,
      label: dcLabel,
      targetScope,
      amountKRW: dcAmount
    });
  }

  const netConfirmedKRW = (confirmedGrossKRW ?? 0) - confirmedDiscountsKRW;
  if (netConfirmedKRW < 0) {
    errors.push(`할인 적용 후 합계(${netConfirmedKRW.toLocaleString()}원)가 음수입니다. 임의로 0원으로 보정하지 않으며 저장할 수 없습니다.`);
  }

  // 식사 대상 인원과 주문 수량 대조 알림(FR08)
  const dinersSummary = calculateDinersSummary(diners);
  if (!dinersSummary.valid) {
    errors.push(...dinersSummary.errors);
  } else if (dinersSummary.totalDiners > 0 && activeLineCount > 0) {
    for (const [gId, gInfo] of Object.entries(dinersSummary.byGroup)) {
      if (orderedQtyByGroup[gId] !== undefined && orderedQtyByGroup[gId] !== gInfo.count) {
        warnings.push(`${gInfo.label} 식사 인원(${gInfo.count}명)과 주문 수량(${orderedQtyByGroup[gId]}개)이 다릅니다. 세트·공유 메뉴인지 확인해 주세요.`);
      }
      if (gInfo.budgetPerPersonKRW !== null && gInfo.count > 0 && confirmedAmountByGroup[gId] !== undefined) {
        const groupBudgetLimit = safeMultiply(gInfo.count, gInfo.budgetPerPersonKRW);
        if (groupBudgetLimit !== null && confirmedAmountByGroup[gId] > groupBudgetLimit) {
          warnings.push(`${gInfo.label} 주문 금액(${confirmedAmountByGroup[gId].toLocaleString()}원)이 배정 예산(${groupBudgetLimit.toLocaleString()}원)을 초과합니다.`);
        }
      }
    }
  }

  const isTotalConfirmed = errors.length === 0 && activeLineCount > 0 && unconfirmedItems.length === 0;
  const canCompleteExternalMeal = errors.length === 0 && dinersSummary.totalDiners > 0 && activeLineCount > 0;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    dinersTotal: dinersSummary.totalDiners,
    activeLineCount,
    totalOrderedQuantity,
    confirmedOrderSubtotalKRW,
    confirmedChargesKRW,
    confirmedDiscountsKRW,
    confirmedSubtotalKRW: netConfirmedKRW >= 0 ? netConfirmedKRW : null,
    totalConfirmedKRW: isTotalConfirmed && netConfirmedKRW >= 0 ? netConfirmedKRW : null,
    isTotalConfirmed,
    canCompleteExternalMeal,
    unconfirmedItems,
    lineResults,
    chargeResults,
    discountResults
  };
}

/**
 * 끼니(MealPlan)의 비용 처리(외부 식당 vs 숙소 제공 included_in_lodging / separate / unknown)를 계산한다(AC49).
 */
export function evaluateMealPlanCost(mealPlan) {
  if (!mealPlan || typeof mealPlan !== 'object') {
    return { valid: false, status: 'invalid', errors: ['유효하지 않은 식사 계획입니다.'] };
  }

  const dinersSummary = calculateDinersSummary(mealPlan.diners || []);
  const providerType = mealPlan.providerType || 'restaurant';
  const costTreatment = mealPlan.costTreatment || (providerType === 'lodging' ? 'included_in_lodging' : 'separate');

  if (providerType === 'lodging') {
    if (costTreatment === 'included_in_lodging') {
      return {
        valid: dinersSummary.valid,
        providerType: 'lodging',
        costTreatment: 'included_in_lodging',
        displayLabel: '숙박비 포함 (별도 식비 합산 제외)',
        isFree: false,
        separateCostKRW: null,
        addToSeparateMealTotal: false,
        budgetReviewComplete: dinersSummary.totalDiners > 0,
        needsReconfirmAmount: false,
        errors: dinersSummary.errors
      };
    }

    if (costTreatment === 'unknown') {
      return {
        valid: dinersSummary.valid,
        providerType: 'lodging',
        costTreatment: 'unknown',
        displayLabel: '숙소 식비 포함 여부 미확인 (총예산 검토 미완료)',
        isFree: false,
        separateCostKRW: null,
        addToSeparateMealTotal: false,
        budgetReviewComplete: false,
        needsReconfirmAmount: true,
        errors: dinersSummary.errors
      };
    }

    // 별도 식비를 청구하는 숙소 식사(costTreatment === 'separate')
    const lodgingCost = mealPlan.lodgingCost || {};
    const totalRes = normalizeIntegerInput(lodgingCost.totalKRW, true);
    const errors = [...dinersSummary.errors];
    if (!totalRes.valid) errors.push(`숙소 별도 식비 오류: ${totalRes.message}`);

    // 견적 당시 조건 스냅샷과 현재 인원·날짜 비교
    let needsReconfirmAmount = false;
    if (lodgingCost.conditionsSnapshot) {
      const snap = lodgingCost.conditionsSnapshot;
      if (snap.date && snap.date !== mealPlan.date) needsReconfirmAmount = true;
      if (typeof snap.totalDiners === 'number' && snap.totalDiners !== dinersSummary.totalDiners) {
        needsReconfirmAmount = true;
      }
    }

    const confirmedTotal = totalRes.value;
    return {
      valid: errors.length === 0,
      providerType: 'lodging',
      costTreatment: 'separate',
      displayLabel: confirmedTotal !== null
        ? `숙소 별도 식비 ${confirmedTotal.toLocaleString()}원${needsReconfirmAmount ? ' (조건 변경·금액 재확인 필요)' : ''}`
        : '숙소 별도 식비 미확정',
      isFree: confirmedTotal === 0,
      separateCostKRW: confirmedTotal,
      perPersonDerivedKRW: null, // 단가가 없는 숙소 총액을 인원수로 나누어 1인 단가로 확정하지 않는다
      addToSeparateMealTotal: confirmedTotal !== null,
      budgetReviewComplete: confirmedTotal !== null && !needsReconfirmAmount && dinersSummary.totalDiners > 0,
      needsReconfirmAmount,
      errors
    };
  }

  // 외부 식당(providerType === 'restaurant')
  const selectedCandidate = (mealPlan.candidateRecords || []).find(
    c => c.id === mealPlan.selectedCandidateId
  );

  if (!selectedCandidate) {
    return {
      valid: dinersSummary.valid,
      providerType: 'restaurant',
      costTreatment: 'separate',
      displayLabel: '선택된 후보 식당 없음',
      separateCostKRW: null,
      addToSeparateMealTotal: false,
      budgetReviewComplete: false,
      errors: dinersSummary.errors
    };
  }

  const orderDraft = selectedCandidate.orderDraft || { orderLines: [], charges: [], discounts: [] };
  const budgetRes = calculateOrderBudget({
    orderLines: orderDraft.orderLines || [],
    charges: orderDraft.charges || [],
    discounts: orderDraft.discounts || [],
    diners: mealPlan.diners || [],
    candidateRestaurantId: selectedCandidate.restaurantId,
    candidateMenus: selectedCandidate.restaurantSnapshot?.selectedMenus || null
  });

  return {
    valid: budgetRes.valid,
    providerType: 'restaurant',
    costTreatment: 'separate',
    displayLabel: budgetRes.isTotalConfirmed
      ? `확정 소계 ${budgetRes.totalConfirmedKRW.toLocaleString()}원`
      : `확인된 소계 ${(budgetRes.confirmedSubtotalKRW ?? 0).toLocaleString()}원 (미확인 ${budgetRes.unconfirmedItems.length}건 · 총액 미확정)`,
    separateCostKRW: budgetRes.confirmedSubtotalKRW,
    totalConfirmedKRW: budgetRes.totalConfirmedKRW,
    isTotalConfirmed: budgetRes.isTotalConfirmed,
    addToSeparateMealTotal: budgetRes.confirmedSubtotalKRW !== null,
    budgetReviewComplete: budgetRes.isTotalConfirmed && budgetRes.canCompleteExternalMeal,
    budgetDetail: budgetRes,
    errors: budgetRes.errors
  };
}

/**
 * 최대 3개 후보 식당을 동일한 식사 인원 기준으로 비교한다(FR08, AC60).
 * 각 후보의 고유 orderDraft를 사용하며 다른 후보의 메뉴·단가를 승계하지 않는다.
 */
export function compareCandidateBudgets(candidateRecords = [], diners = []) {
  const limited = candidateRecords.slice(0, 3);
  const dinersSummary = calculateDinersSummary(diners);

  return limited.map(candidate => {
    const draft = candidate.orderDraft || { orderLines: [], charges: [], discounts: [] };
    const calc = calculateOrderBudget({
      orderLines: draft.orderLines || [],
      charges: draft.charges || [],
      discounts: draft.discounts || [],
      diners,
      candidateRestaurantId: candidate.restaurantId,
      candidateMenus: candidate.restaurantSnapshot?.selectedMenus || null
    });

    return {
      candidateId: candidate.id,
      restaurantId: candidate.restaurantId,
      restaurantName: candidate.restaurantSnapshot?.name || candidate.restaurantId,
      dinersTotal: dinersSummary.totalDiners,
      confirmedSubtotalKRW: calc.confirmedSubtotalKRW,
      totalConfirmedKRW: calc.totalConfirmedKRW,
      isTotalConfirmed: calc.isTotalConfirmed,
      unconfirmedItems: calc.unconfirmedItems,
      warnings: calc.warnings,
      errors: calc.errors,
      lineResults: calc.lineResults
    };
  });
}
