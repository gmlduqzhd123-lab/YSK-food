// 기존 자료 · CSV 호환 · ID/URL/좌표 정규화 및 공용·개인 스키마 검증기
import { PUBLIC_SCHEMA_VERSION, PERSONAL_SCHEMA_VERSION, SOURCE_APP } from '../config.js';

export const ENTITY_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,79}$/;
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_DATETIME_OFFSET_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
export const TIME_HHMM_REGEX = /^([01]\d|2[0-4]):([0-5]\d)$/;

export const KOREA_BOUNDS = {
  minLat: 32.0,
  maxLat: 39.5,
  minLng: 123.0,
  maxLng: 132.5
};

const YES_NO_UNKNOWN = new Set(['yes', 'no', 'unknown']);

/**
 * 영구 문자열 ID 형식 검사 (영문 소문자·숫자로 시작, 1~80자 영문 소문자·숫자·밑줄·하이픈)
 */
export function isValidEntityId(id) {
  return typeof id === 'string' && ENTITY_ID_REGEX.test(id);
}

/**
 * 숫자/빈값을 0으로 오인하지 않는 엄격한 좌표 유효성 검사
 */
export function isValidCoordinate(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return (
    lat >= KOREA_BOUNDS.minLat &&
    lat <= KOREA_BOUNDS.maxLat &&
    lng >= KOREA_BOUNDS.minLng &&
    lng <= KOREA_BOUNDS.maxLng
  );
}

/**
 * 지도 표시·범위 계산·좌표 길찾기에 사용할 수 있는 장소인지 검사
 */
export function isMappablePlace(place) {
  if (!place || typeof place !== 'object') return false;
  if (place.location && typeof place.location === 'object') {
    const { lat, lng, status } = place.location;
    if (status === 'unverified' || status === 'invalid') return false;
    return isValidCoordinate(lat, lng);
  }
  return isValidCoordinate(place.lat, place.lng);
}

export function getPlaceCoords(place) {
  if (!isMappablePlace(place)) return null;
  if (place.location && typeof place.location === 'object') {
    return { lat: place.location.lat, lng: place.location.lng };
  }
  return { lat: place.lat, lng: place.lng };
}

/**
 * 외부 링크·이미지 URL 검증 (http/https만 허용, javascript:/data: 등 차단)
 */
export function sanitizeHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * 전화번호 링크 정규화 (숫자와 +, -만 허용, 최소 7자리 숫자)
 */
export function sanitizeTelHref(rawPhone) {
  if (typeof rawPhone !== 'string') return null;
  const cleaned = rawPhone.replace(/[^\d+-]/g, '');
  const digitsOnly = cleaned.replace(/\D/g, '');
  if (digitsOnly.length < 7 || digitsOnly.length > 15) return null;
  return `tel:${cleaned}`;
}

/**
 * 빈 문자열·공백을 null로 정규화한 뒤 안전 정수 검사
 */
export function parseSafeNonNegativeInt(val) {
  if (val === null || val === undefined) return { value: null, valid: true };
  if (typeof val === 'string') {
    if (val.trim() === '') return { value: null, valid: true };
    if (!/^-?\d+(\.\d+)?$/.test(val.trim())) return { value: null, valid: false, reason: 'NOT_A_NUMBER' };
    val = Number(val.trim());
  }
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    return { value: null, valid: false, reason: 'NON_FINITE' };
  }
  if (!Number.isInteger(val)) {
    return { value: null, valid: false, reason: 'FLOAT_NOT_ALLOWED' };
  }
  if (val < 0) {
    return { value: null, valid: false, reason: 'NEGATIVE_NOT_ALLOWED' };
  }
  if (!Number.isSafeInteger(val)) {
    return { value: null, valid: false, reason: 'UNSAFE_INTEGER' };
  }
  return { value: val, valid: true };
}

/**
 * 따옴표·쉼표·줄바꿈이 들어간 칸도 처리하는 CSV 파서 (기존 파서 재사용)
 */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text || '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const CITY_TO_REGION_CODE = {
  '여수': 'jn-yeosu',
  '여수시': 'jn-yeosu',
  '순천': 'jn-suncheon',
  '순천시': 'jn-suncheon',
  '광양': 'jn-gwangyang',
  '광양시': 'jn-gwangyang',
  '보성': 'jn-boseong',
  '보성군': 'jn-boseong',
  '고흥': 'jn-goheung',
  '고흥군': 'jn-goheung',
  '해남': 'jn-haenam',
  '해남군': 'jn-haenam',
  '목포': 'jn-mokpo',
  '목포시': 'jn-mokpo',
  '광주 동구': 'gj-donggu',
  '동구': 'gj-donggu',
  '광주 서구': 'gj-seogu',
  '전주': 'jb-jeonju',
  '전주시': 'jb-jeonju',
  '군산': 'jb-gunsan',
  '군산시': 'jb-gunsan',
  '제주': 'jj-jeju',
  '제주시': 'jj-jeju',
  '서귀포': 'jj-seogwipo',
  '서귀포시': 'jj-seogwipo',
  '강릉': 'gw-gangneung',
  '강릉시': 'gw-gangneung',
  '춘천': 'gw-chuncheon',
  '춘천시': 'gw-chuncheon',
  '경주': 'gb-gyeongju',
  '경주시': 'gb-gyeongju',
  '서울 종로구': 'seoul-jongno',
  '종로구': 'seoul-jongno',
  '부산 해운대구': 'busan-haeundae',
  '해운대구': 'busan-haeundae'
};

export function resolveRegionCodeFromInput(regionOrCity, regionsList = []) {
  if (!regionOrCity) return null;
  const raw = String(regionOrCity).trim();
  if (!raw) return null;
  if (CITY_TO_REGION_CODE[raw]) return CITY_TO_REGION_CODE[raw];
  for (const reg of regionsList) {
    if (reg.regionCode === raw || reg.name === raw || reg.fullName === raw) {
      return reg.regionCode;
    }
    if (Array.isArray(reg.aliases) && reg.aliases.includes(raw)) {
      return reg.regionCode;
    }
  }
  if (isValidEntityId(raw)) return raw;
  return null;
}

/**
 * 구형·신규 CSV를 검증하고 영구 ID 식당 목록으로 변환한다.
 * - 행 번호(i + 1)로 영구 ID를 자동 생성하지 않는다.
 * - id 열이 없으면 legacyAliases에서 유일하게 매칭되는 기존 식당만 호환 연결한다.
 * - 매칭되지 않는 신규 행에 영구 ID가 없으면 오류로 기록한다.
 */
export function csvToPlaces(text, options = {}) {
  const { legacyAliases = null, regions = [] } = options;
  const cleanedText = String(text || '').replace(/^\uFEFF/, '');
  const parsedRows = parseCSV(cleanedText);
  if (!parsedRows.length) {
    return { valid: false, places: [], errors: [{ rowNumber: 0, code: 'EMPTY_CSV', message: 'CSV 내용이 비어 있습니다.' }] };
  }
  const [header, ...rows] = parsedRows;
  const keys = header.map(h => h.trim().toLowerCase());
  const places = [];
  const errors = [];
  const seenIds = new Set();

  rows.forEach((cols, idx) => {
    const rowNumber = idx + 2;
    if (cols.every(c => !String(c || '').trim())) return;

    const r = {};
    keys.forEach((k, j) => { r[k] = (cols[j] || '').trim(); });

    const name = r.name || '';
    const city = r.city || r.region || '';
    const regionCode = r.regioncode || r.region_code || resolveRegionCodeFromInput(city, regions);

    if (!name || (!city && !regionCode)) {
      errors.push({
        rowNumber,
        name,
        city,
        code: 'MISSING_NAME_OR_REGION',
        message: `${rowNumber}행: 식당 이름(name)과 지역(city/regionCode)은 필수입니다.`
      });
      return;
    }

    if (!regionCode) {
      errors.push({
        rowNumber,
        name,
        city,
        code: 'UNKNOWN_REGION',
        message: `${rowNumber}행 (${name}): 알 수 없는 지역 표기('${city}')입니다.`
      });
      return;
    }

    let permanentId = r.id || '';
    if (permanentId && /^\d+$/.test(permanentId)) {
      const mapped = legacyAliases?.legacyNumericIds?.[permanentId] || `ysk-r-${permanentId}`;
      permanentId = mapped;
    }

    if (!permanentId && legacyAliases) {
      const favKey = `${city}:${name}`;
      const byFavKey = legacyAliases.favoriteKeys?.[favKey];
      if (Array.isArray(byFavKey) && byFavKey.length === 1) {
        permanentId = byFavKey[0];
      } else if (Array.isArray(byFavKey) && byFavKey.length > 1) {
        errors.push({
          rowNumber,
          name,
          city,
          code: 'AMBIGUOUS_LEGACY_ALIAS',
          message: `${rowNumber}행 (${city} ${name}): 동일 별칭 후보가 여러 개(${byFavKey.join(', ')})이므로 명시적 영구 ID(id 열)가 필요합니다.`
        });
        return;
      } else {
        const byName = legacyAliases.placeNames?.[name];
        if (Array.isArray(byName) && byName.length === 1) {
          permanentId = byName[0];
        }
      }
    }

    if (!permanentId) {
      errors.push({
        rowNumber,
        name,
        city,
        code: 'MISSING_PERMANENT_ID',
        message: `${rowNumber}행 (${city} ${name}): 신규 식당 행에는 영구 ID(id 열, 예: ysk-r-210)가 필수입니다.`
      });
      return;
    }

    if (!isValidEntityId(permanentId)) {
      errors.push({
        rowNumber,
        id: permanentId,
        name,
        city,
        code: 'INVALID_ID_FORMAT',
        message: `${rowNumber}행 (${name}): 잘못된 ID 형식('${permanentId}')입니다. 영문 소문자·숫자로 시작하는 1~80자여야 합니다.`
      });
      return;
    }

    if (seenIds.has(permanentId)) {
      errors.push({
        rowNumber,
        id: permanentId,
        name,
        city,
        code: 'DUPLICATE_ID',
        message: `${rowNumber}행 (${name}): 중복된 식당 ID('${permanentId}')입니다.`
      });
      return;
    }
    seenIds.add(permanentId);

    const hasLat = r.lat !== undefined && r.lat !== '';
    const hasLng = r.lng !== undefined && r.lng !== '';
    const latNum = hasLat ? Number(r.lat) : null;
    const lngNum = hasLng ? Number(r.lng) : null;

    if ((hasLat || hasLng) && !isValidCoordinate(latNum, lngNum)) {
      errors.push({
        rowNumber,
        id: permanentId,
        name,
        city,
        code: 'INVALID_COORDINATES',
        message: `${rowNumber}행 (${name}): 위도·경도(${r.lat}, ${r.lng})가 유효 범위 밖이거나 잘못되었습니다.`
      });
      return;
    }

    if (r.link && !sanitizeHttpUrl(r.link)) {
      errors.push({
        rowNumber,
        id: permanentId,
        name,
        city,
        code: 'INVALID_LINK_URL',
        message: `${rowNumber}행 (${name}): 허용되지 않는 상세 링크 URL('${r.link}')입니다.`
      });
      return;
    }

    if (r.image && !sanitizeHttpUrl(r.image)) {
      errors.push({
        rowNumber,
        id: permanentId,
        name,
        city,
        code: 'INVALID_IMAGE_URL',
        message: `${rowNumber}행 (${name}): 허용되지 않는 이미지 URL('${r.image}')입니다.`
      });
      return;
    }

    const restaurant = normalizeLegacyPlaceToRestaurant({
      id: permanentId,
      name,
      city: city || regionCode,
      regionCode,
      address: r.address || `${city || regionCode} (상세 주소 미확인)`,
      category: r.category || '기타',
      menu: r.menu || '',
      lat: latNum,
      lng: lngNum,
      link: r.link || '',
      hours: r.hours || '',
      closed: r.closed || '',
      price: r.price || '',
      phone: r.phone || '',
      image: r.image || '',
      note: r.note || ''
    });

    places.push(restaurant);
  });

  return {
    valid: errors.length === 0 && places.length > 0,
    places,
    errors
  };
}

/**
 * 기존 hours/closed 문자열을 보존하면서 해석 가능한 주간 영업 구간으로 변환한다.
 * 불명확한 격주 휴무나 공휴일은 추정하여 확정하지 않고 원문을 보존한다.
 */
const LEGACY_DAY_CHARS = '일월화수목금토';
// 기존 getDay() 0(일)~6(토) -> PRD 요일 1(월)~7(일)
function jsDayToIsoDay(jsDay) {
  return jsDay === 0 ? 7 : jsDay;
}

const ISO_WEEK_ORDER = [1, 2, 3, 4, 5, 6, 7];

export function parseLegacyDaysToIso(spec) {
  if (!spec) return null;
  const trimmed = String(spec).trim();
  if (!trimmed) return null;
  if (trimmed.includes('평일')) return [1, 2, 3, 4, 5];
  if (trimmed.includes('주말')) return [6, 7];
  const range = /([일월화수목금토])\s*[~-]\s*([일월화수목금토])/.exec(trimmed);
  if (range) {
    const fromIso = jsDayToIsoDay(LEGACY_DAY_CHARS.indexOf(range[1]));
    const toIso = jsDayToIsoDay(LEGACY_DAY_CHARS.indexOf(range[2]));
    const fromIdx = ISO_WEEK_ORDER.indexOf(fromIso);
    const toIdx = ISO_WEEK_ORDER.indexOf(toIso);
    if (fromIdx <= toIdx) {
      return ISO_WEEK_ORDER.slice(fromIdx, toIdx + 1);
    }
    return [...ISO_WEEK_ORDER.slice(fromIdx), ...ISO_WEEK_ORDER.slice(0, toIdx + 1)];
  }
  const days = [...trimmed]
    .map(ch => LEGACY_DAY_CHARS.indexOf(ch))
    .filter(d => d >= 0)
    .map(jsDayToIsoDay);
  return days.length ? [...new Set(days)] : null;
}

export function parseLegacyClosedSpec(closedText) {
  if (!closedText) {
    return { regularClosedDays: [], irregularClosedNote: null, isYearRoundOpen: false };
  }
  const raw = String(closedText).trim();
  if (raw === '연중무휴') {
    return { regularClosedDays: [], irregularClosedNote: null, isYearRoundOpen: true };
  }
  const hasIrregularKeyword = /째|격주|부정기|마지막|명절|연휴|공지|비정기/.test(raw);
  if (hasIrregularKeyword) {
    return { regularClosedDays: [], irregularClosedNote: raw, isYearRoundOpen: false };
  }
  const tokens = raw.split(/[\s,/·]+/).filter(Boolean);
  const regularDays = [];
  for (const token of tokens) {
    const ch = token.charAt(0);
    const idx = LEGACY_DAY_CHARS.indexOf(ch);
    if (idx >= 0) regularDays.push(jsDayToIsoDay(idx));
  }
  return {
    regularClosedDays: [...new Set(regularDays)],
    irregularClosedNote: regularDays.length === 0 ? raw : null,
    isYearRoundOpen: false
  };
}

export function buildOpeningHoursFromLegacy(hoursText, closedText) {
  const rawLegacyText = hoursText ? String(hoursText).trim() : null;
  const rawClosedText = closedText ? String(closedText).trim() : null;
  const { regularClosedDays, irregularClosedNote } = parseLegacyClosedSpec(rawClosedText);

  if (!rawLegacyText) {
    return {
      timezone: 'Asia/Seoul',
      status: 'unknown',
      is24Hours: false,
      weeklyIntervals: [],
      dateOverrides: [],
      groupMealWindows: [],
      rawLegacyText: null,
      rawClosedText,
      regularClosedDays,
      irregularClosedNote,
      evidenceRefs: []
    };
  }

  const parsedSegments = [];
  rawLegacyText.split('/').forEach(segment => {
    const firstDigit = segment.search(/\d/);
    if (firstDigit < 0) return;
    const days = parseLegacyDaysToIso(segment.slice(0, firstDigit).trim());
    for (const m of segment.matchAll(/(\d{1,2}):(\d{2})\s*[-~]\s*(\d{1,2}):(\d{2})/g)) {
      const sh = String(Number(m[1])).padStart(2, '0');
      const sm = m[2];
      const eh = String(Number(m[3])).padStart(2, '0');
      const em = m[4];
      const startMinutes = Number(sh) * 60 + Number(sm);
      const endMinutes = Number(eh) * 60 + Number(em);
      // 00:00~00:00을 명시적인 24시간 표시 없이 24시간으로 해석하지 않는다
      if (startMinutes === 0 && endMinutes === 0 && !/24\s*시간/.test(rawLegacyText)) {
        continue;
      }
      const endDayOffset = endMinutes <= startMinutes && !(eh === '24' && em === '00') ? 1 : 0;
      parsedSegments.push({
        days,
        startTime: `${sh}:${sm}`,
        endTime: `${eh}:${em}`,
        endDayOffset
      });
    }
  });

  if (!parsedSegments.length) {
    return {
      timezone: 'Asia/Seoul',
      status: 'unknown',
      is24Hours: false,
      weeklyIntervals: [],
      dateOverrides: [],
      groupMealWindows: [],
      rawLegacyText,
      rawClosedText,
      regularClosedDays,
      irregularClosedNote,
      evidenceRefs: []
    };
  }

  const weeklyIntervals = [];
  for (let isoDay = 1; isoDay <= 7; isoDay++) {
    if (regularClosedDays.includes(isoDay)) continue;
    const specific = parsedSegments.filter(seg => Array.isArray(seg.days) && seg.days.includes(isoDay));
    const applicable = specific.length ? specific : parsedSegments.filter(seg => !seg.days);
    for (const seg of applicable) {
      weeklyIntervals.push({
        day: isoDay,
        startTime: seg.startTime,
        endTime: seg.endTime,
        endDayOffset: seg.endDayOffset,
        lastOrderTime: null,
        lastOrderDayOffset: null
      });
    }
  }

  return {
    timezone: 'Asia/Seoul',
    status: 'legacy_parsed',
    is24Hours: false,
    weeklyIntervals,
    dateOverrides: [],
    groupMealWindows: [],
    rawLegacyText,
    rawClosedText,
    regularClosedDays,
    irregularClosedNote,
    evidenceRefs: []
  };
}

/**
 * 구형 식당 객체를 PRD v1.1 Restaurant 스키마(schemaVersion 2)로 변환한다.
 * 확인되지 않은 단체 수용·버스·원재료·단가 정보는 모두 명시적 unknown / null로 생성한다.
 */
export function normalizeLegacyPlaceToRestaurant(raw) {
  const permanentId = typeof raw.id === 'number' || /^\d+$/.test(String(raw.id))
    ? `ysk-r-${raw.id}`
    : String(raw.id);
  const regionCode = raw.regionCode || resolveRegionCodeFromInput(raw.city) || 'unknown-region';
  const hasCoord = isValidCoordinate(raw.lat, raw.lng);

  // 지점명 분리 보조 (원래 이름은 보존하여 기존 링크/별칭 호환 유지)
  let branchName = raw.branchName || null;
  if (!branchName && typeof raw.name === 'string') {
    const branchMatch = /\s+(본점|[^\s]+점)$/.exec(raw.name);
    if (branchMatch) branchName = branchMatch[1];
  }

  const menuNames = String(raw.menu || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const menus = menuNames.map((mName, idx) => ({
    id: `${permanentId}-menu-${idx + 1}`,
    name: mName,
    priceKRW: null,
    priceBasis: 'unknown',
    servingUnitText: null,
    minOrder: null,
    studentPortion: 'unknown',
    spiceAdjustment: 'unknown',
    extraRice: 'unknown',
    altMenuInquiry: 'unknown',
    ingredientResponse: {
      status: 'unknown',
      answerText: null,
      cookingProcessNote: null,
      checkedAt: null
    },
    checkedAt: null,
    evidenceRefs: []
  }));

  const safeLink = sanitizeHttpUrl(raw.link);
  let kakaoPlaceId = null;
  if (safeLink) {
    const m = /place\.map\.kakao\.com\/(\d+)/.exec(safeLink);
    if (m) kakaoPlaceId = m[1];
  }

  return {
    id: permanentId,
    legacyId: typeof raw.id === 'number' ? raw.id : (/^ysk-r-(\d+)$/.test(permanentId) ? Number(permanentId.slice(6)) : null),
    name: String(raw.name || '').trim(),
    branchName,
    regionCode,
    legacyCity: raw.city || null,
    address: raw.address || `${raw.city || ''} (상세 주소 미확인)`.trim(),
    categoryIds: raw.category ? [String(raw.category).trim()] : ['기타'],
    menuSummary: raw.menu ? String(raw.menu).trim() : '',
    rawPriceText: raw.price ? String(raw.price).trim() : null,
    note: raw.note ? String(raw.note).trim() : null,
    phone: raw.phone ? String(raw.phone).trim() : null,
    image: sanitizeHttpUrl(raw.image),
    mapLinks: {
      kakaoPlaceUrl: safeLink,
      kakaoPlaceId
    },
    location: {
      lat: hasCoord ? raw.lat : null,
      lng: hasCoord ? raw.lng : null,
      status: hasCoord ? 'verified' : 'unverified'
    },
    groupProfile: {
      availability: 'unknown',
      totalSeats: null,
      simultaneousCapacity: null,
      mealWaves: {
        availability: 'unknown',
        maxWaves: null,
        turnaroundMinutes: null,
        minMealMinutes: null,
        servingMinutes: null
      },
      room: {
        privateRoom: 'unknown',
        roomFeeKRW: null
      },
      preOrder: {
        required: 'unknown',
        leadTimeNote: null
      },
      earlyBreakfast: {
        availability: 'unknown',
        earliestTime: null,
        note: null
      },
      lunchbox: {
        availability: 'unknown',
        orderDeadline: null,
        pickupTimeWindow: null,
        pickupLocation: null,
        minOrderQty: null,
        unitPriceKRW: null,
        pickupMethod: null,
        handlingNotes: null
      },
      parking: {
        busEntry: 'unknown',
        busParkingSpaces: null,
        dropoff: 'unknown',
        dropoffLocation: null,
        walkingDistanceMeters: null,
        walkingNotes: null
      },
      accessibility: {
        stairs: null,
        entryNote: null,
        restroom: null
      },
      checkedAt: null,
      evidenceRefs: []
    },
    menus,
    openingHours: buildOpeningHoursFromLegacy(raw.hours, raw.closed),
    officialDesignations: [],
    businessStatus: 'open'
  };
}

/**
 * UI 및 기존 코드에서 편리하게 읽을 수 있도록 Restaurant 객체를 보강(hydration)한다.
 * 원본 중첩 필드는 그대로 유지한다.
 */
export function hydrateRestaurantForUi(rest, regionMeta = null) {
  const r = structuredClone(rest);
  if (!r.categoryIds || !Array.isArray(r.categoryIds)) {
    r.categoryIds = r.category ? [r.category] : ['기타'];
  }
  r.category = r.categoryIds[0] || '기타';
  r.city = r.legacyCity || regionMeta?.name || r.regionCode;
  if (!r.menuSummary) {
    r.menuSummary = Array.isArray(r.menus) ? r.menus.map(m => m.name).join(', ') : '';
  }
  r.menu = r.menuSummary;
  r.hours = r.openingHours?.rawLegacyText || '';
  r.closed = r.openingHours?.rawClosedText || '';
  r.link = r.mapLinks?.kakaoPlaceUrl || '';
  r.price = r.rawPriceText || '';
  if (isMappablePlace(r)) {
    r.lat = r.location.lat;
    r.lng = r.location.lng;
  } else {
    r.lat = null;
    r.lng = null;
  }
  return r;
}

// ============================================================================
// 공용 자료 및 개인 파일 스키마 검증기 (운영 도구 & 브라우저 공통 사용)
// ============================================================================

export function validateRegionDataset(data, expectedRegionCode = null, expectedDatasetVersion = null) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['지역 자료 파일이 JSON 객체가 아닙니다.'] };
  }

  // 색인 파일이나 개인 파일이 잘못 전달된 경우 즉시 구분
  if ('entries' in data || 'regionFiles' in data || 'regions' in data || 'favoriteKeys' in data) {
    errors.push('지역 공용 자료 파일 자리에 색인/매니페스트 파일이 전달되었습니다.');
  }

  const requiredTop = [
    'schemaVersion',
    'datasetVersion',
    'generatedAt',
    'regionCode',
    'restaurants',
    'venues',
    'eventReferences',
    'visitRecords',
    'sources'
  ];
  for (const key of requiredTop) {
    if (!(key in data)) errors.push(`필수 최상위 필드 누락: ${key}`);
  }
  if (errors.length) return { valid: false, errors };

  if (data.schemaVersion !== PUBLIC_SCHEMA_VERSION) {
    errors.push(`지원하지 않는 schemaVersion: ${data.schemaVersion} (기대값: ${PUBLIC_SCHEMA_VERSION})`);
  }
  if (typeof data.datasetVersion !== 'string' || !data.datasetVersion.trim()) {
    errors.push('datasetVersion이 비어 있습니다.');
  }
  if (expectedDatasetVersion && data.datasetVersion !== expectedDatasetVersion) {
    errors.push(`datasetVersion 불일치: 파일(${data.datasetVersion}) !== 매니페스트(${expectedDatasetVersion})`);
  }
  if (typeof data.generatedAt !== 'string' || !ISO_DATETIME_OFFSET_REGEX.test(data.generatedAt)) {
    errors.push(`generatedAt 시각 형식이 잘못되었습니다: ${data.generatedAt}`);
  }
  if (!isValidEntityId(data.regionCode)) {
    errors.push(`유효하지 않은 regionCode: ${data.regionCode}`);
  }
  if (expectedRegionCode && data.regionCode !== expectedRegionCode) {
    errors.push(`regionCode 불일치: 파일(${data.regionCode}) !== 요청 지역(${expectedRegionCode})`);
  }

  for (const arrField of ['restaurants', 'venues', 'eventReferences', 'visitRecords', 'sources']) {
    if (!Array.isArray(data[arrField])) {
      errors.push(`${arrField} 필드가 배열이 아닙니다.`);
    }
  }
  if (errors.length) return { valid: false, errors };

  const sourceIds = new Set();
  data.sources.forEach((src, i) => {
    if (!src || !isValidEntityId(src.id)) {
      errors.push(`sources[${i}]: 유효하지 않은 id`);
    } else if (sourceIds.has(src.id)) {
      errors.push(`sources[${i}]: 중복된 출처 ID (${src.id})`);
    } else {
      sourceIds.add(src.id);
    }
    if (src && src.factScope !== undefined) {
      if (!Array.isArray(src.factScope)) {
        errors.push(`sources[${i}].factScope가 배열이 아닙니다.`);
      } else {
        src.factScope.forEach((fsItem, fi) => {
          if (!fsItem || !isValidEntityId(fsItem.entityId) || typeof fsItem.fieldPath !== 'string' || !fsItem.fieldPath.startsWith('/')) {
            errors.push(`sources[${i}].factScope[${fi}]: entityId 또는 fieldPath 형식 오류`);
          }
        });
      }
    }
  });

  const restIds = new Set();
  const requiredRestFields = [
    'id',
    'name',
    'regionCode',
    'address',
    'location',
    'groupProfile',
    'menus',
    'openingHours',
    'officialDesignations',
    'businessStatus'
  ];

  data.restaurants.forEach((r, idx) => {
    const prefix = `restaurants[${idx}]`;
    if (!r || typeof r !== 'object') {
      errors.push(`${prefix}: 객체가 아닙니다.`);
      return;
    }
    for (const req of requiredRestFields) {
      if (!(req in r)) errors.push(`${prefix}: 필수 필드 누락 (${req})`);
    }
    if (!isValidEntityId(r.id)) {
      errors.push(`${prefix}: 잘못된 식당 ID (${r.id})`);
    } else if (restIds.has(r.id)) {
      errors.push(`${prefix}: 중복된 식당 ID (${r.id})`);
    } else {
      restIds.add(r.id);
    }
    if (typeof r.name !== 'string' || !r.name.trim()) {
      errors.push(`${prefix} (${r.id}): 식당 이름이 비어 있습니다.`);
    }
    if (r.regionCode !== data.regionCode) {
      errors.push(`${prefix} (${r.id}): 식당 regionCode(${r.regionCode})가 파일 regionCode(${data.regionCode})와 다릅니다.`);
    }
    if (typeof r.address !== 'string' || !r.address.trim()) {
      errors.push(`${prefix} (${r.id}): 주소(address)가 비어 있습니다.`);
    }

    // location 검증
    if (!r.location || typeof r.location !== 'object') {
      errors.push(`${prefix} (${r.id}): location 객체 누락`);
    } else {
      const { lat, lng, status } = r.location;
      if (!['verified', 'cached', 'unverified'].includes(status)) {
        errors.push(`${prefix} (${r.id}): 잘못된 location.status (${status})`);
      }
      if (lat !== null || lng !== null) {
        if (!isValidCoordinate(lat, lng)) {
          errors.push(`${prefix} (${r.id}): 유효하지 않은 좌표 (${lat}, ${lng})`);
        }
      }
    }

    // groupProfile 검증 (중첩 객체에 restaurantId 중복 저장 금지)
    if (!r.groupProfile || typeof r.groupProfile !== 'object') {
      errors.push(`${prefix} (${r.id}): groupProfile 누락`);
    } else {
      if ('restaurantId' in r.groupProfile) {
        errors.push(`${prefix} (${r.id}): 중첩된 groupProfile에 restaurantId를 중복 저장할 수 없습니다.`);
      }
      if (!YES_NO_UNKNOWN.has(r.groupProfile.availability)) {
        errors.push(`${prefix} (${r.id}): groupProfile.availability 오류`);
      }
      if (r.groupProfile.totalSeats !== null && (!Number.isInteger(r.groupProfile.totalSeats) || r.groupProfile.totalSeats < 0)) {
        errors.push(`${prefix} (${r.id}): groupProfile.totalSeats는 null 또는 0 이상 정수여야 합니다.`);
      }
      if (r.groupProfile.simultaneousCapacity !== null && (!Number.isInteger(r.groupProfile.simultaneousCapacity) || r.groupProfile.simultaneousCapacity < 0)) {
        errors.push(`${prefix} (${r.id}): groupProfile.simultaneousCapacity는 null 또는 0 이상 정수여야 합니다.`);
      }
      if (!r.groupProfile.mealWaves || !YES_NO_UNKNOWN.has(r.groupProfile.mealWaves.availability)) {
        errors.push(`${prefix} (${r.id}): groupProfile.mealWaves.availability 오류`);
      }
      if (!r.groupProfile.parking || !YES_NO_UNKNOWN.has(r.groupProfile.parking.busEntry) || !YES_NO_UNKNOWN.has(r.groupProfile.parking.dropoff)) {
        errors.push(`${prefix} (${r.id}): groupProfile.parking 필수 상태 오류`);
      }
      if (!Array.isArray(r.groupProfile.evidenceRefs)) {
        errors.push(`${prefix} (${r.id}): groupProfile.evidenceRefs가 배열이 아닙니다.`);
      }
    }

    // menus 검증
    if (!Array.isArray(r.menus)) {
      errors.push(`${prefix} (${r.id}): menus가 배열이 아닙니다.`);
    } else {
      r.menus.forEach((m, mi) => {
        if ('restaurantId' in m) {
          errors.push(`${prefix}.menus[${mi}]: 중첩된 Menu에 restaurantId를 중복 저장할 수 없습니다.`);
        }
        if (!isValidEntityId(m.id)) {
          errors.push(`${prefix}.menus[${mi}]: 잘못된 메뉴 ID (${m.id})`);
        }
        if (m.priceKRW !== null && (!Number.isSafeInteger(m.priceKRW) || m.priceKRW < 0)) {
          errors.push(`${prefix}.menus[${mi}]: priceKRW는 null 또는 0 이상 안전 정수여야 합니다.`);
        }
      });
    }

    // openingHours 검증
    if (!r.openingHours || typeof r.openingHours !== 'object') {
      errors.push(`${prefix} (${r.id}): openingHours 누락`);
    } else {
      if ('restaurantId' in r.openingHours) {
        errors.push(`${prefix} (${r.id}): 중첩된 openingHours에 restaurantId를 중복 저장할 수 없습니다.`);
      }
      if (r.openingHours.timezone !== 'Asia/Seoul') {
        errors.push(`${prefix} (${r.id}): openingHours.timezone은 Asia/Seoul이어야 합니다.`);
      }
      if (!Array.isArray(r.openingHours.weeklyIntervals) || !Array.isArray(r.openingHours.dateOverrides) || !Array.isArray(r.openingHours.groupMealWindows) || !Array.isArray(r.openingHours.evidenceRefs)) {
        errors.push(`${prefix} (${r.id}): openingHours 내부 배열 필드 누락`);
      }
    }

    // officialDesignations 검증
    if (!Array.isArray(r.officialDesignations)) {
      errors.push(`${prefix} (${r.id}): officialDesignations가 배열이 아닙니다.`);
    } else {
      r.officialDesignations.forEach((od, oi) => {
        if ('restaurantId' in od) {
          errors.push(`${prefix}.officialDesignations[${oi}]: 중첩된 OfficialDesignation에 restaurantId를 중복 저장할 수 없습니다.`);
        }
      });
    }
  });

  // venues 검증
  const venueIds = new Set();
  data.venues.forEach((v, idx) => {
    if (!v || !isValidEntityId(v.id)) {
      errors.push(`venues[${idx}]: 잘못된 시설 ID`);
    } else if (venueIds.has(v.id)) {
      errors.push(`venues[${idx}]: 중복된 시설 ID (${v.id})`);
    } else {
      venueIds.add(v.id);
    }
    if (v && v.regionCode !== data.regionCode) {
      errors.push(`venues[${idx}] (${v.id}): regionCode 불일치`);
    }
    if (v && !Array.isArray(v.eventRefs)) {
      errors.push(`venues[${idx}] (${v.id}): eventRefs가 배열이 아닙니다.`);
    }
  });

  // eventReferences 검증
  const evRefIds = new Set();
  data.eventReferences.forEach((er, idx) => {
    if (!er || !isValidEntityId(er.id)) {
      errors.push(`eventReferences[${idx}]: 잘못된 대회 참조 ID`);
    } else if (evRefIds.has(er.id)) {
      errors.push(`eventReferences[${idx}]: 중복된 대회 참조 ID (${er.id})`);
    } else {
      evRefIds.add(er.id);
    }
  });

  // visitRecords 검증
  const visitIds = new Set();
  data.visitRecords.forEach((vr, idx) => {
    if (!vr || !isValidEntityId(vr.id)) {
      errors.push(`visitRecords[${idx}]: 잘못된 방문 기록 ID`);
    } else if (visitIds.has(vr.id)) {
      errors.push(`visitRecords[${idx}]: 중복된 방문 기록 ID (${vr.id})`);
    } else {
      visitIds.add(vr.id);
    }
    if (vr && !isValidEntityId(vr.restaurantId)) {
      errors.push(`visitRecords[${idx}]: 잘못된 restaurantId`);
    }
  });

  return { valid: errors.length === 0, errors };
}

export function validateManifest(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['매니페스트가 객체가 아닙니다.'] };
  }
  if ('restaurants' in data) {
    errors.push('매니페스트 파일에 지역 식당 배열(restaurants)이 포함될 수 없습니다.');
  }
  const req = [
    'schemaVersion',
    'datasetVersion',
    'generatedAt',
    'regionsPath',
    'regionFiles',
    'searchIndexPath',
    'idIndexPath',
    'legacyAliasesPath',
    'checksums',
    'changeSummary'
  ];
  for (const k of req) {
    if (!(k in data)) errors.push(`매니페스트 필수 필드 누락: ${k}`);
  }
  if (data.schemaVersion !== PUBLIC_SCHEMA_VERSION) {
    errors.push(`매니페스트 schemaVersion 오류: ${data.schemaVersion}`);
  }
  if (typeof data.datasetVersion !== 'string' || !data.datasetVersion.trim()) {
    errors.push('매니페스트 datasetVersion 누락');
  }
  return { valid: errors.length === 0, errors };
}

export function validateRegionsFile(data, expectedDatasetVersion = null) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['regions 파일이 객체가 아닙니다.'] };
  }
  if ('restaurants' in data) {
    errors.push('regions 파일은 restaurants 배열을 포함하지 않습니다.');
  }
  if (data.schemaVersion !== PUBLIC_SCHEMA_VERSION) {
    errors.push(`regions schemaVersion 오류: ${data.schemaVersion}`);
  }
  if (expectedDatasetVersion && data.datasetVersion !== expectedDatasetVersion) {
    errors.push(`regions datasetVersion 불일치: ${data.datasetVersion} !== ${expectedDatasetVersion}`);
  }
  if (!Array.isArray(data.regions) || data.regions.length === 0) {
    errors.push('regions 배열이 비어 있거나 누락되었습니다.');
  } else {
    const codes = new Set();
    data.regions.forEach((reg, idx) => {
      if (!isValidEntityId(reg.regionCode)) {
        errors.push(`regions[${idx}]: 잘못된 regionCode (${reg.regionCode})`);
      } else if (codes.has(reg.regionCode)) {
        errors.push(`regions[${idx}]: 중복된 regionCode (${reg.regionCode})`);
      } else {
        codes.add(reg.regionCode);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

export function validateSearchIndexFile(data, expectedDatasetVersion = null) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['search-index 파일이 객체가 아닙니다.'] };
  }
  if ('restaurants' in data) {
    errors.push('search-index 파일은 restaurants 배열을 요구하지 않습니다.');
  }
  if (data.schemaVersion !== PUBLIC_SCHEMA_VERSION) {
    errors.push(`search-index schemaVersion 오류: ${data.schemaVersion}`);
  }
  if (expectedDatasetVersion && data.datasetVersion !== expectedDatasetVersion) {
    errors.push(`search-index datasetVersion 불일치: ${data.datasetVersion} !== ${expectedDatasetVersion}`);
  }
  if (!Array.isArray(data.entries)) {
    errors.push('search-index entries가 배열이 아닙니다.');
  } else {
    const ids = new Set();
    data.entries.forEach((item, idx) => {
      if (!isValidEntityId(item.id) || !isValidEntityId(item.regionCode)) {
        errors.push(`search-index.entries[${idx}]: 잘못된 id 또는 regionCode`);
      }
      if (ids.has(item.id)) {
        errors.push(`search-index.entries[${idx}]: 중복된 식당 ID (${item.id})`);
      }
      ids.add(item.id);
    });
  }
  return { valid: errors.length === 0, errors };
}

export function validateIdIndexFile(data, expectedDatasetVersion = null) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['id-index 파일이 객체가 아닙니다.'] };
  }
  if ('restaurants' in data) {
    errors.push('id-index 파일은 restaurants 배열을 요구하지 않습니다.');
  }
  if (data.schemaVersion !== PUBLIC_SCHEMA_VERSION) {
    errors.push(`id-index schemaVersion 오류: ${data.schemaVersion}`);
  }
  if (expectedDatasetVersion && data.datasetVersion !== expectedDatasetVersion) {
    errors.push(`id-index datasetVersion 불일치: ${data.datasetVersion} !== ${expectedDatasetVersion}`);
  }
  if (!data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
    errors.push('id-index entries가 맵 객체가 아닙니다.');
  } else {
    for (const [key, entry] of Object.entries(data.entries)) {
      if (!entry || !['restaurant', 'venue', 'eventRef'].includes(entry.kind)) {
        errors.push(`id-index[${key}]: 잘못된 kind`);
      }
      if (!isValidEntityId(entry?.id) || !isValidEntityId(entry?.regionCode)) {
        errors.push(`id-index[${key}]: 잘못된 id 또는 regionCode`);
      }
      if (!['active', 'removed'].includes(entry?.status)) {
        errors.push(`id-index[${key}]: 잘못된 status (${entry?.status})`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateLegacyAliasesFile(data, expectedDatasetVersion = null) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['legacy-aliases 파일이 객체가 아닙니다.'] };
  }
  if ('restaurants' in data) {
    errors.push('legacy-aliases 파일은 restaurants 배열을 요구하지 않습니다.');
  }
  if (data.schemaVersion !== PUBLIC_SCHEMA_VERSION) {
    errors.push(`legacy-aliases schemaVersion 오류: ${data.schemaVersion}`);
  }
  if (expectedDatasetVersion && data.datasetVersion !== expectedDatasetVersion) {
    errors.push(`legacy-aliases datasetVersion 불일치: ${data.datasetVersion} !== ${expectedDatasetVersion}`);
  }
  if (!data.favoriteKeys || typeof data.favoriteKeys !== 'object') {
    errors.push('legacy-aliases.favoriteKeys가 객체가 아닙니다.');
  }
  if (!data.placeNames || typeof data.placeNames !== 'object') {
    errors.push('legacy-aliases.placeNames가 객체가 아닙니다.');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 전체 데이터 묶음(manifest, regions, search-index, id-index, 지역별 파일) 간 참조 무결성 검증
 * - 별도 지역의 시설을 참조하는 EventReference 및 Venue.eventRefs 역참조까지 대조한다.
 */
export function validateDatasetBundleCrossReferences({
  manifest,
  regionsFile,
  searchIndex,
  idIndex,
  legacyAliases,
  regionDatasets
}) {
  const errors = [];
  const vManifest = validateManifest(manifest);
  if (!vManifest.valid) return { valid: false, errors: vManifest.errors };

  const dsVersion = manifest.datasetVersion;
  for (const [label, res] of [
    ['regions', validateRegionsFile(regionsFile, dsVersion)],
    ['searchIndex', validateSearchIndexFile(searchIndex, dsVersion)],
    ['idIndex', validateIdIndexFile(idIndex, dsVersion)],
    ['legacyAliases', validateLegacyAliasesFile(legacyAliases, dsVersion)]
  ]) {
    if (!res.valid) errors.push(...res.errors.map(e => `[${label}] ${e}`));
  }
  if (errors.length) return { valid: false, errors };

  const allRestaurantsById = new Map();
  const allVenuesById = new Map();
  const allEventRefsById = new Map();

  for (const [regionCode, regionData] of Object.entries(regionDatasets || {})) {
    const vReg = validateRegionDataset(regionData, regionCode, dsVersion);
    if (!vReg.valid) {
      errors.push(...vReg.errors.map(e => `[region:${regionCode}] ${e}`));
      continue;
    }
    for (const r of regionData.restaurants) {
      if (allRestaurantsById.has(r.id)) {
        errors.push(`전국 중복 식당 ID 발견: ${r.id}`);
      }
      allRestaurantsById.set(r.id, { regionCode, restaurant: r });
    }
    for (const v of regionData.venues) {
      if (allVenuesById.has(v.id)) {
        errors.push(`전국 중복 시설 ID 발견: ${v.id}`);
      }
      allVenuesById.set(v.id, { regionCode, venue: v });
    }
    for (const er of regionData.eventReferences) {
      if (allEventRefsById.has(er.id)) {
        errors.push(`전국 중복 대회 기록 ID 발견: ${er.id}`);
      }
      allEventRefsById.set(er.id, { regionCode, eventRef: er });
    }
  }

  // search-index와 실제 지역 파일 식당 대조
  for (const entry of searchIndex.entries) {
    const found = allRestaurantsById.get(entry.id);
    if (!found) {
      errors.push(`search-index의 식당 ID(${entry.id})가 실제 지역 파일에 존재하지 않습니다.`);
    } else if (found.regionCode !== entry.regionCode) {
      errors.push(`search-index의 식당(${entry.id}) 지역(${entry.regionCode})이 실제 지역(${found.regionCode})과 다릅니다.`);
    }
    const idxEntry = idIndex.entries[`restaurant:${entry.id}`];
    if (!idxEntry || idxEntry.status !== 'active') {
      errors.push(`search-index의 식당(${entry.id})이 id-index에 active로 등록되어 있지 않습니다.`);
    }
  }

  // id-index active 항목이 실제 지역 파일에 존재하는지 대조, removed 항목이 활성 식당에 남아있지 않은지 대조
  for (const [key, idxEntry] of Object.entries(idIndex.entries)) {
    if (idxEntry.status === 'removed') {
      if (idxEntry.kind === 'restaurant' && allRestaurantsById.has(idxEntry.id)) {
        errors.push(`제거된 식당 ID(${idxEntry.id})가 지역 파일에 활성 식당으로 남아 있거나 재사용되었습니다.`);
      }
      continue;
    }
    if (idxEntry.kind === 'restaurant') {
      const found = allRestaurantsById.get(idxEntry.id);
      if (!found || found.regionCode !== idxEntry.regionCode) {
        errors.push(`id-index[${key}]가 가리키는 지역(${idxEntry.regionCode})에 식당이 없습니다.`);
      }
    } else if (idxEntry.kind === 'venue') {
      const found = allVenuesById.get(idxEntry.id);
      if (!found || found.regionCode !== idxEntry.regionCode) {
        errors.push(`id-index[${key}]가 가리키는 지역(${idxEntry.regionCode})에 시설이 없습니다.`);
      }
    } else if (idxEntry.kind === 'eventRef') {
      const found = allEventRefsById.get(idxEntry.id);
      if (!found || found.regionCode !== idxEntry.regionCode) {
        errors.push(`id-index[${key}]가 가리키는 지역(${idxEntry.regionCode})에 대회 기록이 없습니다.`);
      }
    }
  }

  // 타 지역 포함 Venue.eventRefs <-> EventReference.venueIds 교차 검증
  for (const [venueId, { regionCode, venue }] of allVenuesById.entries()) {
    for (const evRefId of venue.eventRefs || []) {
      const idxEntry = idIndex.entries[`eventRef:${evRefId}`];
      if (!idxEntry || idxEntry.status !== 'active') {
        errors.push(`시설(${venueId}, ${regionCode})이 참조하는 eventRef(${evRefId})가 id-index에 없습니다.`);
        continue;
      }
      const targetEv = allEventRefsById.get(evRefId);
      if (!targetEv) {
        errors.push(`시설(${venueId})이 참조하는 eventRef(${evRefId})가 소유 지역(${idxEntry.regionCode}) 파일에 없습니다.`);
      }
    }
  }

  for (const [evId, { eventRef }] of allEventRefsById.entries()) {
    for (const vId of eventRef.venueIds || []) {
      if (!allVenuesById.has(vId)) {
        errors.push(`대회 기록(${evId})이 참조하는 시설(${vId})이 존재하지 않습니다.`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 개인 백업(BackupEnvelope) 및 공유 사본(ShareEnvelope) 검증
 */
export function validatePersonalEventObject(ev, prefix = 'event') {
  const errors = [];
  if (!ev || typeof ev !== 'object') {
    return [`${prefix}: 행사 객체가 아닙니다.`];
  }
  if (!isValidEntityId(ev.id)) {
    errors.push(`${prefix}: 잘못된 행사 ID (${ev.id})`);
  }
  if (!Number.isSafeInteger(ev.revision) || ev.revision < 1) {
    errors.push(`${prefix}: 잘못된 revision (${ev.revision})`);
  }
  if (typeof ev.title !== 'string' || !ev.title.trim()) {
    errors.push(`${prefix}: 행사 제목이 비어 있습니다.`);
  }
  if (!Array.isArray(ev.dates) || !Array.isArray(ev.attendeeGroups) || !Array.isArray(ev.mealPlans)) {
    errors.push(`${prefix}: dates, attendeeGroups, mealPlans는 배열이어야 합니다.`);
    return errors;
  }

  const groupIds = new Set();
  ev.attendeeGroups.forEach((g, gi) => {
    if (!g || !isValidEntityId(g.id)) {
      errors.push(`${prefix}.attendeeGroups[${gi}]: 잘못된 집단 ID`);
    } else {
      groupIds.add(g.id);
    }
    const parsedCount = parseSafeNonNegativeInt(g?.count);
    if (!parsedCount.valid || parsedCount.value === null) {
      errors.push(`${prefix}.attendeeGroups[${gi}]: 인원수 오류`);
    }
  });

  ev.mealPlans.forEach((mp, mi) => {
    const mpPrefix = `${prefix}.mealPlans[${mi}]`;
    if (!mp || !isValidEntityId(mp.id)) {
      errors.push(`${mpPrefix}: 잘못된 끼니 ID`);
      return;
    }
    if (mp.eventId !== ev.id) {
      errors.push(`${mpPrefix}: eventId(${mp.eventId})가 상위 행사 ID(${ev.id})와 일치하지 않습니다.`);
    }
    if (!ISO_DATE_REGEX.test(mp.date || '')) {
      errors.push(`${mpPrefix}: 잘못된 날짜 (${mp.date})`);
    }
    if (!['restaurant', 'lodging'].includes(mp.providerType)) {
      errors.push(`${mpPrefix}: 잘못된 providerType (${mp.providerType})`);
    }
    if (!['separate', 'included_in_lodging', 'unknown'].includes(mp.costTreatment)) {
      errors.push(`${mpPrefix}: 잘못된 costTreatment (${mp.costTreatment})`);
    }
    if (mp.providerType === 'lodging' && mp.selectedCandidateId !== null) {
      errors.push(`${mpPrefix}: 숙소 제공 식사(lodging)의 selectedCandidateId는 null이어야 합니다.`);
    }

    const candidateMap = new Map();
    if (!Array.isArray(mp.candidateRecords)) {
      errors.push(`${mpPrefix}: candidateRecords가 배열이 아닙니다.`);
    } else {
      mp.candidateRecords.forEach((cr, ci) => {
        const crPrefix = `${mpPrefix}.candidateRecords[${ci}]`;
        if (!cr || !isValidEntityId(cr.id)) {
          errors.push(`${crPrefix}: 잘못된 후보 ID`);
          return;
        }
        if (cr.mealPlanId !== mp.id) {
          errors.push(`${crPrefix}: mealPlanId(${cr.mealPlanId}) 불일치`);
        }
        if (!isValidEntityId(cr.restaurantId)) {
          errors.push(`${crPrefix}: 잘못된 restaurantId (${cr.restaurantId})`);
        }
        const quoteIds = new Set();
        for (const q of cr.quoteHistory || []) {
          if (!q || !isValidEntityId(q.id) || q.candidateId !== cr.id) {
            errors.push(`${crPrefix}: 견적 ID 또는 candidateId 참조 오류`);
          } else {
            quoteIds.add(q.id);
          }
        }
        for (const c of cr.confirmationHistory || []) {
          if (!c || !isValidEntityId(c.id)) {
            errors.push(`${crPrefix}: 확인 이력 ID 오류`);
          }
          if (c.mealPlanId !== mp.id || c.candidateId !== cr.id || c.providerId !== cr.restaurantId) {
            errors.push(`${crPrefix}: 확인 이력 참조(mealPlanId/candidateId/providerId) 불일치`);
          }
          if (c.quoteId !== null && !quoteIds.has(c.quoteId)) {
            errors.push(`${crPrefix}: 확인 이력(${c.id})의 quoteId(${c.quoteId})가 해당 후보의 quoteHistory에 존재하지 않습니다.`);
          }
        }
        candidateMap.set(cr.id, cr);
      });
    }

    if (mp.selectedCandidateId !== null && !candidateMap.has(mp.selectedCandidateId)) {
      errors.push(`${mpPrefix}: selectedCandidateId(${mp.selectedCandidateId})가 candidateRecords에 없습니다.`);
    }
    for (const bId of mp.backupCandidateIds || []) {
      if (!candidateMap.has(bId)) {
        errors.push(`${mpPrefix}: backupCandidateId(${bId})가 candidateRecords에 없습니다.`);
      }
    }
  });

  return errors;
}

export function validateBackupEnvelope(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['백업 파일이 JSON 객체가 아닙니다.'] };
  }
  if (data.sourceApp !== SOURCE_APP) {
    errors.push(`지원하지 않는 sourceApp: ${data.sourceApp}`);
  }
  if (data.kind !== 'backup') {
    errors.push(`백업 파일의 kind가 'backup'이 아닙니다 (${data.kind}).`);
  }
  if (data.schemaVersion !== PERSONAL_SCHEMA_VERSION) {
    errors.push(`지원하지 않는 백업 schemaVersion: ${data.schemaVersion}`);
  }
  const req = ['schemaVersion', 'kind', 'exportedAt', 'sourceApp', 'events', 'favorites', 'settings', 'drafts', 'unresolvedFavorites', 'migrationState'];
  for (const k of req) {
    if (!(k in data)) errors.push(`백업 필수 필드 누락: ${k}`);
  }
  if (errors.length) return { valid: false, errors };

  if (!Array.isArray(data.events) || !Array.isArray(data.favorites) || !Array.isArray(data.drafts) || !Array.isArray(data.unresolvedFavorites)) {
    errors.push('events, favorites, drafts, unresolvedFavorites는 배열이어야 합니다.');
    return { valid: false, errors };
  }

  const eventIds = new Set();
  data.events.forEach((ev, idx) => {
    if (ev?.id && eventIds.has(ev.id)) {
      errors.push(`중복된 행사 ID: ${ev.id}`);
    }
    if (ev?.id) eventIds.add(ev.id);
    errors.push(...validatePersonalEventObject(ev, `events[${idx}]`));
  });

  data.favorites.forEach((favId, i) => {
    if (!isValidEntityId(favId)) {
      errors.push(`favorites[${i}]: 잘못된 식당 ID (${favId})`);
    }
  });

  return { valid: errors.length === 0, errors };
}

export function validateShareEnvelope(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['공유 사본 파일이 JSON 객체가 아닙니다.'] };
  }
  if (data.sourceApp !== SOURCE_APP) {
    errors.push(`지원하지 않는 sourceApp: ${data.sourceApp}`);
  }
  if (data.kind !== 'share') {
    errors.push(`공유 파일의 kind가 'share'가 아닙니다 (${data.kind}).`);
  }
  if (data.schemaVersion !== PERSONAL_SCHEMA_VERSION) {
    errors.push(`지원하지 않는 공유 파일 schemaVersion: ${data.schemaVersion}`);
  }
  if (!Array.isArray(data.selectedFields)) {
    errors.push('selectedFields가 배열이 아닙니다.');
  }
  if (!data.eventCopy || typeof data.eventCopy !== 'object') {
    errors.push('eventCopy 객체가 누락되었습니다.');
  } else {
    errors.push(...validatePersonalEventObject(data.eventCopy, 'eventCopy'));
  }
  return { valid: errors.length === 0, errors };
}
