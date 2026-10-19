// Asia/Seoul 기준 날짜·영업시간·브레이크타임·심야 영업·마지막 주문·단체 특별 식사 시간 판정
import { ISO_DATE_REGEX, TIME_HHMM_REGEX, buildOpeningHoursFromLegacy } from '../data/normalize.js';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY_NAMES = ['', '월', '화', '수', '목', '금', '토', '일'];

/**
 * 기기 현지 시간대와 무관하게 Asia/Seoul(UTC+09:00) 기준 시각 요소를 추출한다(AC16).
 */
export function getKoreaDateTimeParts(input = new Date()) {
  const dateObj = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(dateObj.getTime())) return null;

  const kstMs = dateObj.getTime() + KST_OFFSET_MS;
  const kstDate = new Date(kstMs);

  const year = kstDate.getUTCFullYear();
  const month = kstDate.getUTCMonth() + 1;
  const day = kstDate.getUTCDate();
  const jsWeekday = kstDate.getUTCDay(); // 0(일)~6(토)
  const isoDay = jsWeekday === 0 ? 7 : jsWeekday; // 1(월)~7(일)
  const hours = kstDate.getUTCHours();
  const minutes = kstDate.getUTCMinutes();
  const seconds = kstDate.getUTCSeconds();

  const dateStr = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  return {
    year,
    month,
    day,
    isoDay,
    dayLabel: ISO_DAY_NAMES[isoDay],
    hours,
    minutes,
    seconds,
    totalMinutes: hours * 60 + minutes,
    dateStr,
    timeStr,
    isoDateTime: `${dateStr}T${timeStr}:${String(seconds).padStart(2, '0')}+09:00`
  };
}

export function parseHHMMToMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

export function addDaysToKoreaDateStr(dateStr, deltaDays) {
  if (!ISO_DATE_REGEX.test(String(dateStr || ''))) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMs = Date.UTC(y, m - 1, d) + deltaDays * DAY_MS;
  const dt = new Date(utcMs);
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function getIsoDayFromKoreaDateStr(dateStr) {
  if (!ISO_DATE_REGEX.test(String(dateStr || ''))) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * 방문 날짜(YYYY-MM-DD)와 시작·종료 시각을 +09:00 오프셋 포함 구간으로 생성·검증한다(AC54).
 * 종료 시각이 시작 시각보다 작거나 같을 때 endNextDay를 명시적으로 선택하지 않으면 거절한다.
 */
export function buildPlannedMealWindow({ date, startTime, endTime, endNextDay = false, orderTime = null }) {
  if (!ISO_DATE_REGEX.test(String(date || ''))) {
    return { valid: false, code: 'INVALID_DATE', message: '방문 날짜는 YYYY-MM-DD 형식이어야 합니다.' };
  }
  const startMin = parseHHMMToMinutes(startTime);
  const endMin = parseHHMMToMinutes(endTime);
  if (startMin === null || endMin === null) {
    return { valid: false, code: 'INVALID_TIME', message: '식사 시작·종료 시각은 HH:MM 형식이어야 합니다.' };
  }

  if (!endNextDay && endMin <= startMin) {
    return {
      valid: false,
      code: 'END_NOT_AFTER_START',
      message: '식사 종료 시각은 시작 시각보다 뒤여야 합니다. 자정을 넘기는 식사라면 익일 종료를 직접 선택해 주세요.'
    };
  }

  const endDate = endNextDay ? addDaysToKoreaDateStr(date, 1) : date;
  const startHHMM = `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`;
  const endHHMM = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;

  const plannedStart = `${date}T${startHHMM}:00+09:00`;
  const plannedEnd = `${endDate}T${endHHMM}:00+09:00`;
  const durationMinutes = (endNextDay ? endMin + 1440 : endMin) - startMin;

  let orderMin = startMin;
  if (orderTime) {
    const parsedOrder = parseHHMMToMinutes(orderTime);
    if (parsedOrder !== null) orderMin = parsedOrder;
  }

  return {
    valid: true,
    date,
    endDate,
    startTime: startHHMM,
    endTime: endHHMM,
    endNextDay: Boolean(endNextDay),
    plannedStart,
    plannedEnd,
    startMinutesOfDay: startMin,
    endMinutesFromDayStart: endNextDay ? endMin + 1440 : endMin,
    orderMinutesFromDayStart: orderMin,
    durationMinutes
  };
}

function ensureOpeningHoursObject(placeOrHours) {
  if (!placeOrHours) return buildOpeningHoursFromLegacy('', '');
  if (placeOrHours.openingHours && typeof placeOrHours.openingHours === 'object') {
    return placeOrHours.openingHours;
  }
  if (placeOrHours.timezone === 'Asia/Seoul' && Array.isArray(placeOrHours.weeklyIntervals)) {
    return placeOrHours;
  }
  return buildOpeningHoursFromLegacy(placeOrHours.hours || '', placeOrHours.closed || '');
}

/**
 * 특정 한국 날짜(YYYY-MM-DD)의 자정(0분)을 기준으로,
 * 전날 시작해 자정을 넘긴 영업 구간과 당일 영업 구간을 절대 분(minute) 구간 배열로 반환한다.
 */
export function getOperatingIntervalsForKoreaDate(place, dateStr) {
  const oh = ensureOpeningHoursObject(place);
  const isoDay = getIsoDayFromKoreaDateStr(dateStr);
  if (!isoDay) return { status: 'unknown', intervals: [], reason: 'INVALID_DATE' };

  const prevDateStr = addDaysToKoreaDateStr(dateStr, -1);
  const prevIsoDay = isoDay === 1 ? 7 : isoDay - 1;

  // 날짜별 예외(dateOverrides) 우선 확인
  const todayOverride = (oh.dateOverrides || []).find(d => d.date === dateStr);
  const prevOverride = (oh.dateOverrides || []).find(d => d.date === prevDateStr);

  // 격주 휴무 등 불명확한 휴무가 해당 요일에 걸려 있는지 확인
  if (oh.irregularClosedNote) {
    const dayChar = ISO_DAY_NAMES[isoDay];
    if (oh.irregularClosedNote.includes(dayChar) || /명절|연휴|부정기|공지/.test(oh.irregularClosedNote)) {
      if (!todayOverride) {
        return {
          status: 'unknown',
          intervals: [],
          reason: 'IRREGULAR_CLOSED_UNKNOWN',
          note: `휴무 조건(${oh.irregularClosedNote}) 확인 필요`
        };
      }
    }
  }

  const intervals = [];

  // 1) 전날(prevDateStr) 시작해 자정을 넘긴 구간(endDayOffset === 1)
  if (!prevOverride || prevOverride.status === 'open') {
    const prevRawIntervals = prevOverride?.intervals?.length
      ? prevOverride.intervals
      : (oh.weeklyIntervals || []).filter(iv => iv.day === prevIsoDay);

    for (const iv of prevRawIntervals) {
      if (iv.endDayOffset !== 1) continue;
      const sMin = parseHHMMToMinutes(iv.startTime);
      const eMin = parseHHMMToMinutes(iv.endTime);
      if (sMin === null || eMin === null) continue;
      if (sMin === 0 && eMin === 0 && !oh.is24Hours) continue;

      let lastOrderAbs = null;
      if (iv.lastOrderTime) {
        const loMin = parseHHMMToMinutes(iv.lastOrderTime);
        if (loMin !== null) {
          const loOffset = iv.lastOrderDayOffset ?? (loMin <= sMin ? 1 : 0);
          lastOrderAbs = (loOffset - 1) * 1440 + loMin;
        }
      }

      intervals.push({
        sourceDay: prevDateStr,
        startAbs: sMin - 1440, // 전날 시각(음수 분)
        endAbs: eMin,          // 당일 새벽 시각(0 ~ eMin)
        lastOrderAbs,
        hasLastOrderInfo: Boolean(iv.lastOrderTime),
        raw: iv
      });
    }
  }

  // 2) 당일 예외 휴무 처리
  if (todayOverride) {
    if (todayOverride.status === 'closed') {
      return {
        status: intervals.length ? 'partial_overnight' : 'closed',
        intervals,
        reason: 'DATE_OVERRIDE_CLOSED',
        note: todayOverride.note || '지정 휴무일'
      };
    }
    if (todayOverride.status === 'unknown') {
      return {
        status: 'unknown',
        intervals,
        reason: 'DATE_OVERRIDE_UNKNOWN',
        note: todayOverride.note || '해당 날짜 영업 여부 미확인'
      };
    }
  }

  // 정기 휴무일 확인
  if (!todayOverride && Array.isArray(oh.regularClosedDays) && oh.regularClosedDays.includes(isoDay)) {
    return {
      status: intervals.length ? 'partial_overnight' : 'closed',
      intervals,
      reason: 'REGULAR_CLOSED_DAY',
      note: `정기 휴무(${ISO_DAY_NAMES[isoDay]}요일)`
    };
  }

  // 명시적 24시간 영업
  if (oh.is24Hours === true) {
    intervals.push({
      sourceDay: dateStr,
      startAbs: 0,
      endAbs: 1440,
      lastOrderAbs: null,
      hasLastOrderInfo: false,
      raw: { day: isoDay, startTime: '00:00', endTime: '24:00', endDayOffset: 0 }
    });
    return { status: 'open', intervals, reason: 'OPEN_24H' };
  }

  const todayRawIntervals = todayOverride?.intervals?.length
    ? todayOverride.intervals
    : (oh.weeklyIntervals || []).filter(iv => iv.day === isoDay);

  if (!todayRawIntervals.length && !intervals.length) {
    return {
      status: 'unknown',
      intervals: [],
      reason: 'NO_INTERVALS_FOR_DAY',
      note: '해당 요일 영업시간 정보 미확인'
    };
  }

  for (const iv of todayRawIntervals) {
    const sMin = parseHHMMToMinutes(iv.startTime);
    const eMin = parseHHMMToMinutes(iv.endTime);
    if (sMin === null || eMin === null) continue;
    // 명시적 is24Hours 없이 00:00~00:00은 24시간으로 해석하지 않는다
    if (sMin === 0 && eMin === 0 && !oh.is24Hours) continue;

    const endOffset = iv.endDayOffset ?? (eMin <= sMin && eMin !== 1440 ? 1 : 0);
    const endAbs = endOffset === 1 ? eMin + 1440 : eMin;

    let lastOrderAbs = null;
    if (iv.lastOrderTime) {
      const loMin = parseHHMMToMinutes(iv.lastOrderTime);
      if (loMin !== null) {
        const loOffset = iv.lastOrderDayOffset ?? (loMin < sMin ? 1 : 0);
        lastOrderAbs = loOffset * 1440 + loMin;
      }
    }

    intervals.push({
      sourceDay: dateStr,
      startAbs: sMin,
      endAbs,
      lastOrderAbs,
      hasLastOrderInfo: Boolean(iv.lastOrderTime),
      raw: iv
    });
  }

  if (!intervals.length) {
    return { status: 'unknown', intervals: [], reason: 'NO_VALID_INTERVALS' };
  }

  return { status: 'open', intervals, reason: 'OK' };
}

/**
 * 현재 시각(Asia/Seoul 기준) 영업 중 여부 판정
 * 반환: true(영업 중), false(영업 종료/휴무), null(미확인)
 */
export function getOpenStatus(place, now = new Date()) {
  const kst = getKoreaDateTimeParts(now);
  if (!kst) return null;

  const oh = ensureOpeningHoursObject(place);
  if (oh.status === 'unknown' && (!oh.weeklyIntervals || oh.weeklyIntervals.length === 0) && !oh.is24Hours) {
    return null;
  }

  const daySchedule = getOperatingIntervalsForKoreaDate(place, kst.dateStr);
  const nowMin = kst.totalMinutes;

  // 전날 심야 영업 또는 당일 구간 중 현재 시각이 [startAbs, endAbs) 안에 있는지 확인
  const matched = daySchedule.intervals.some(iv => nowMin >= iv.startAbs && nowMin < iv.endAbs);
  if (matched) return true;

  if (daySchedule.status === 'unknown') return null;
  return false;
}

/**
 * 방문 예정 식사 구간(mealWindow)이 영업시간·브레이크타임·마지막 주문·단체 특별 식사 시간 조건을 충족하는지 판정한다(AC15, AC33, AC54).
 */
export function evaluateMealWindowHours(place, mealWindow, options = {}) {
  const {
    validPersonalConfirmation = null,
    preOrderConfirmedForEvent = false
  } = options;

  if (!mealWindow || !mealWindow.valid) {
    return {
      status: 'unmet',
      basis: 'invalid_window',
      outsideRegularHours: false,
      lastOrderStatus: 'unverified',
      holidayExceptionNote: '공휴일·임시휴무 예외 일정 미확인',
      message: mealWindow?.message || '유효하지 않은 식사 시간 구간입니다.'
    };
  }

  const oh = ensureOpeningHoursObject(place);
  const daySchedule = getOperatingIntervalsForKoreaDate(place, mealWindow.date);
  const mealStart = mealWindow.startMinutesOfDay;
  const mealEnd = mealWindow.endMinutesFromDayStart;
  const orderMin = mealWindow.orderMinutesFromDayStart ?? mealStart;

  // 일반 영업 구간 하나 안에 시작과 종료가 모두 들어가는지 확인 (브레이크타임 가로지름 방지 - AC15)
  // 시작은 포함(>=), 종료는 영업 종료 시각과 같아도 허용(<=), 단 시작 < 종료
  const matchingRegularInterval = daySchedule.intervals.find(
    iv => mealStart >= iv.startAbs && mealEnd <= iv.endAbs && mealStart < iv.endAbs
  );

  const isWithinRegularHours = Boolean(matchingRegularInterval);

  // 1) 이번 행사 조건과 일치하는 유효한 개인 단체 확인 이력이 있는 경우 (AC33)
  if (validPersonalConfirmation) {
    return {
      status: 'met',
      basis: 'personal_confirmation',
      outsideRegularHours: !isWithinRegularHours,
      lastOrderStatus: 'confirmed_by_event',
      holidayExceptionNote: '이번 행사 식당 직접 확인 반영',
      message: isWithinRegularHours
        ? '이번 행사 단체 식사 시간 확인 완료 (일반 영업시간 내)'
        : '이번 행사 단체 식사 시간 확인 완료 (일반 영업시간 밖 특별 운영 확인)'
    };
  }

  // 2) 일반 영업 구간 내에 들어가는 경우 -> 마지막 주문 시각 검사 (AC54)
  if (matchingRegularInterval) {
    if (matchingRegularInterval.hasLastOrderInfo && matchingRegularInterval.lastOrderAbs !== null && !preOrderConfirmedForEvent) {
      if (orderMin > matchingRegularInterval.lastOrderAbs) {
        return {
          status: 'unmet',
          basis: 'last_order_passed',
          outsideRegularHours: false,
          lastOrderStatus: 'failed',
          holidayExceptionNote: '공휴일·임시휴무 예외 일정 미확인',
          message: '식사 시작(또는 주문 예정 시각)이 해당 영업 구간의 마지막 주문 시각 이후입니다.'
        };
      }
    }

    const hasDateOverride = (oh.dateOverrides || []).some(d => d.date === mealWindow.date && d.status === 'open');
    return {
      status: 'met',
      basis: 'regular_hours',
      outsideRegularHours: false,
      lastOrderStatus: matchingRegularInterval.hasLastOrderInfo ? 'verified' : 'unverified',
      holidayExceptionNote: hasDateOverride ? '해당 날짜 영업 확인됨' : '공휴일·임시휴무 예외 일정 미확인',
      message: matchingRegularInterval.hasLastOrderInfo
        ? '등록된 영업시간 및 마지막 주문 시간 기준 충족 (예외 휴무 별도 확인 권장)'
        : '등록된 일반 영업시간 기준 충족 (마지막 주문 시각 및 예외 휴무 미확인)'
    };
  }

  // 3) 일반 영업시간 밖이나 단체 특별 식사 구간(groupMealWindows) 또는 조식 가능(earlyBreakfast) 정보가 있는 경우
  const groupWindows = oh.groupMealWindows || [];
  const earlyBreakfast = place?.groupProfile?.earlyBreakfast;
  const matchesGroupWindow = groupWindows.some(gw => {
    const gs = parseHHMMToMinutes(gw.startTime);
    const ge = parseHHMMToMinutes(gw.endTime);
    return gs !== null && ge !== null && mealStart >= gs && mealEnd <= ge;
  }) || (
    earlyBreakfast?.availability === 'yes' &&
    earlyBreakfast?.earliestTime &&
     parseHHMMToMinutes(earlyBreakfast.earliestTime) !== null &&
    mealStart >= parseHHMMToMinutes(earlyBreakfast.earliestTime)
  );

  if (matchesGroupWindow) {
    return {
      status: 'needs_check',
      basis: 'group_meal_window_unconfirmed',
      outsideRegularHours: true,
      lastOrderStatus: 'unverified',
      holidayExceptionNote: '식당 사전 예약 확인 필수',
      message: '일반 영업시간 밖이나 단체 조식·특별 식사 가능 안내가 있습니다. 해당 날짜 가능 여부를 식당과 확인해 주세요.'
    };
  }

  // 4) 브레이크타임 가로지름 여부 확인 (AC15)
  const overlapsPartially = daySchedule.intervals.some(
    iv => Math.max(mealStart, iv.startAbs) < Math.min(mealEnd, iv.endAbs)
  );
  if (overlapsPartially) {
    return {
      status: 'unmet',
      basis: 'crosses_break_or_closing',
      outsideRegularHours: true,
      lastOrderStatus: 'unverified',
      holidayExceptionNote: '공휴일·임시휴무 예외 일정 미확인',
      message: '식사 예정 시간이 브레이크타임 또는 영업 종료 시각과 겹칩니다. 별도 단체 확인 없이는 충족으로 판정하지 않습니다.'
    };
  }

  if (daySchedule.status === 'unknown') {
    return {
      status: 'needs_check',
      basis: 'hours_unknown',
      outsideRegularHours: false,
      lastOrderStatus: 'unverified',
      holidayExceptionNote: '영업시간·휴무 미확인',
      message: daySchedule.note || '등록된 영업시간 정보가 없거나 격주·비정기 휴무로 식당 확인이 필요합니다.'
    };
  }

  return {
    status: 'unmet',
    basis: daySchedule.status === 'closed' ? 'closed_day' : 'outside_hours',
    outsideRegularHours: true,
    lastOrderStatus: 'unverified',
    holidayExceptionNote: '공휴일·임시휴무 예외 일정 미확인',
    message: daySchedule.status === 'closed'
      ? `해당 요일·날짜는 휴무(${daySchedule.note || '휴무일'})로 등록되어 있습니다.`
      : '입력한 식사 시간이 등록된 일반 영업시간 밖입니다.'
  };
}

export function formatHoursSummary(place) {
  const oh = ensureOpeningHoursObject(place);
  const rawHours = oh.rawLegacyText || place?.hours || '';
  const rawClosed = oh.rawClosedText || place?.closed || '';
  if (!rawHours && !rawClosed && !oh.is24Hours) return '';
  let text = '🕒 ' + (oh.is24Hours ? '24시간 영업' : (rawHours || '영업시간 정보 미확인'));
  if (rawClosed) {
    text += rawClosed === '연중무휴' ? ' · 연중무휴' : ` (${rawClosed} 휴무)`;
  }
  return text;
}
