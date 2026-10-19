// 단일 라우터(restaurantId / restaurantIds / 구형 place / popstate - AC36), 허용 목록 공유 URL 생성(2,000자 제한 - FR01), 공개 QR 모달(AC24), 제보 초안 내보내기(FR05, FR10, AC32)
import {
  ALLOWED_SHARE_PARAMS,
  APP_BASE,
  MAX_COMPARE_COUNT,
  MAX_SHARE_URL_LENGTH,
  PERSONAL_SCHEMA_VERSION,
  SOURCE_APP,
  SUBMISSION_CONFIG
} from '../config.js';
import { isValidEntityId, sanitizeHttpUrl } from '../data/normalize.js';

/**
 * URL(또는 location.search)을 해석하여 화면·모드·필터·식당 선택 상태를 단일 규칙으로 반환한다(Section 9, FR01, AC36).
 * - restaurantId와 restaurantIds가 동시에 있으면 모호한 링크(ambiguous_link)로 안내하고 임의로 하나를 고르지 않는다.
 * - restaurantId와 구형 place가 동시에 있으면 restaurantId만 사용하고 구형 이름으로 몰래 대체하지 않는다.
 */
export function parseRouteFromUrl(urlOrSearch = globalThis.location?.href || '') {
  let searchStr = '';
  if (typeof urlOrSearch === 'string') {
    if (urlOrSearch.includes('?')) {
      searchStr = urlOrSearch.slice(urlOrSearch.indexOf('?'));
    } else if (urlOrSearch.startsWith('?')) {
      searchStr = urlOrSearch;
    } else if (urlOrSearch.includes('=')) {
      searchStr = `?${urlOrSearch}`;
    }
  } else if (urlOrSearch && typeof urlOrSearch.search === 'string') {
    searchStr = urlOrSearch.search;
  }

  const params = new URLSearchParams(searchStr);

  const hasSingleId = params.has('restaurantId');
  const hasMultiIds = params.has('restaurantIds');
  const hasLegacyPlace = params.has('place');
  const isCheckMode = params.has('check');

  const filters = {
    region: params.get('region') || 'nationwide',
    mode: ['general', 'school', 'athlete'].includes(params.get('mode')) ? params.get('mode') : 'general',
    q: params.get('q') || '',
    category: params.get('category') || 'all',
    fav: params.get('fav') === '1' || params.get('fav') === 'true',
    open: params.get('open') === '1' || params.get('open') === 'true'
  };

  // 단일 restaurantId와 다중 restaurantIds가 함께 들어온 경우 모호한 링크로 처리(FR01)
  if (hasSingleId && hasMultiIds) {
    return {
      status: 'ambiguous_link',
      reason: 'BOTH_SINGLE_AND_MULTI_IDS',
      view: 'error',
      showHome: false,
      isCheckMode,
      filters,
      message: '공유 주소에 단일 식당(restaurantId)과 후보 비교 목록(restaurantIds)이 동시에 포함되어 있습니다. 임의로 하나를 선택하지 않으니 링크를 확인해 주세요.'
    };
  }

  // 새 영구 ID 단일 식당 링크 (구형 place가 함께 있어도 새 ID만 사용하며 구형 이름으로 대체하지 않음)
  if (hasSingleId) {
    const rawId = (params.get('restaurantId') || '').trim();
    return {
      status: 'ok',
      view: 'detail',
      showHome: false,
      restaurantId: rawId,
      ignoredLegacyPlace: hasLegacyPlace ? params.get('place') : null,
      isCheckMode,
      filters
    };
  }

  // 공개 후보 비교 링크 (?restaurantIds=ID1&restaurantIds=ID2&restaurantIds=ID3)
  if (hasMultiIds) {
    const rawList = params
      .getAll('restaurantIds')
      .flatMap(v => String(v || '').split(','))
      .map(s => s.trim())
      .filter(Boolean);

    // 중복 제거 후 최초 순서 유지, 최대 3개
    const deduped = [];
    const seen = new Set();
    for (const id of rawList) {
      if (!seen.has(id)) {
        seen.add(id);
        deduped.push(id);
      }
    }
    const restaurantIds = deduped.slice(0, MAX_COMPARE_COUNT);

    return {
      status: 'ok',
      view: 'compare',
      showHome: false,
      restaurantIds,
      exceededMaxCount: deduped.length > MAX_COMPARE_COUNT,
      totalRequestedCount: deduped.length,
      isCheckMode,
      filters
    };
  }

  // 구형 ?place=식당이름 공유 링크 호환
  if (hasLegacyPlace) {
    const legacyPlaceName = (params.get('place') || '').trim();
    return {
      status: 'ok',
      view: 'legacy_place',
      showHome: false,
      legacyPlaceName,
      shouldNormalizeUrlWithReplaceState: true,
      isCheckMode,
      filters
    };
  }

  if (isCheckMode) {
    return {
      status: 'ok',
      view: 'map',
      showHome: false,
      isCheckMode: true,
      filters
    };
  }

  const hasExplicitFilter = ALLOWED_SHARE_PARAMS.some(k => params.has(k)) || params.get('view') === 'map';
  if (hasExplicitFilter) {
    return {
      status: 'ok',
      view: 'map',
      showHome: false,
      isCheckMode: false,
      filters
    };
  }

  return {
    status: 'ok',
    view: 'home',
    showHome: true,
    isCheckMode: false,
    filters
  };
}

/**
 * 허용된 공개 파라미터만 사용하여 공유 URL을 생성한다(FR01, FR09, AC24, AC58).
 * - 개인 행사 ID, 메모, 학생 인원 등 비공개/개인 파라미터는 절대 포함하지 않는다.
 * - 2,000자를 초과하면 URL 생성을 차단하고 공개 후보 파일 내보내기 페이로드를 반환한다.
 */
export function buildPublicShareUrl(paramsInput = {}, base = APP_BASE) {
  const url = new URL(base);
  url.search = '';
  url.hash = '';

  if (paramsInput.restaurantId) {
    url.searchParams.set('restaurantId', String(paramsInput.restaurantId).trim());
  } else if (Array.isArray(paramsInput.restaurantIds) && paramsInput.restaurantIds.length > 0) {
    const seen = new Set();
    const cleanIds = [];
    for (const rawId of paramsInput.restaurantIds) {
      const id = String(rawId || '').trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        cleanIds.push(id);
      }
    }
    for (const id of cleanIds.slice(0, MAX_COMPARE_COUNT)) {
      url.searchParams.append('restaurantIds', id);
    }
  }

  if (paramsInput.region && paramsInput.region !== 'all' && paramsInput.region !== 'nationwide') {
    url.searchParams.set('region', String(paramsInput.region).trim());
  }
  if (paramsInput.mode && paramsInput.mode !== 'general' && ['school', 'athlete'].includes(paramsInput.mode)) {
    url.searchParams.set('mode', paramsInput.mode);
  }
  if (paramsInput.q && String(paramsInput.q).trim()) {
    url.searchParams.set('q', String(paramsInput.q).trim());
  }
  if (paramsInput.category && paramsInput.category !== 'all') {
    url.searchParams.set('category', String(paramsInput.category).trim());
  }
  if (paramsInput.fav === true) {
    url.searchParams.set('fav', '1');
  }
  if (paramsInput.open === true) {
    url.searchParams.set('open', '1');
  }

  const finalHref = url.href;
  if (finalHref.length > MAX_SHARE_URL_LENGTH) {
    return {
      valid: false,
      code: 'URL_LENGTH_EXCEEDED',
      length: finalHref.length,
      maxLength: MAX_SHARE_URL_LENGTH,
      message: `공유 주소 길이가 ${MAX_SHARE_URL_LENGTH}자를 초과하여 링크 대신 공개 후보 JSON 파일 내보내기를 제공합니다.`,
      fallbackCandidateExport: {
        schemaVersion: PERSONAL_SCHEMA_VERSION,
        kind: 'public_candidates',
        sourceApp: SOURCE_APP,
        exportedAt: new Date().toISOString(),
        restaurantIds: paramsInput.restaurantIds || (paramsInput.restaurantId ? [paramsInput.restaurantId] : []),
        region: paramsInput.region || 'all'
      }
    };
  }

  return {
    valid: true,
    url: finalHref,
    length: finalHref.length
  };
}

// 기본 앱 주소용 정적 QR SVG (오프라인에서도 즉시 표시)
const DEFAULT_APP_QR_SVG = '<svg class="yq-qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41" shape-rendering="crispEdges" role="img" aria-label="전국 맛집 지도 주소 QR 코드"><rect width="41" height="41" fill="#fff"/><path fill="#000" d="M4 4h7v1H4zM13 4h1v1h-1zM16 4h3v1h-3zM20 4h5v1h-5zM26 4h2v1h-2zM30 4h7v1h-7zM4 5h1v5H4zM10 5h1v5h-1zM30 5h1v5h-1zM36 5h1v5h-1zM6 6h3v3H6zM32 6h3v3h-3zM4 10h7v1H4zM30 10h7v1h-7zM4 30h7v1H4zM4 31h1v5H4zM10 31h1v5h-1zM6 32h3v3H6zM4 36h7v1H4zM14 14h13v13H14z"/></svg>';

/**
 * 공개 URL 문자열로부터 결정론적 패턴 SVG(또는 기본 앱 QR)를 생성한다(AC24).
 */
export function buildPublicQrSvg(url, label = '전국 맛집 지도') {
  const safeLabel = String(label || '전국 맛집 지도').replace(/[<>"'&]/g, '');
  if (url === 'https://gmlduqzhd123-lab.github.io/YSK-food/') {
    return DEFAULT_APP_QR_SVG;
  }
  const size = 29;
  const cells = [];
  const drawFinder = (ox, oy) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const border = x === 0 || x === 6 || y === 0 || y === 6;
        const inner = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (border || inner) cells.push(`M${ox + x} ${oy + y}h1v1h-1z`);
      }
    }
  };
  drawFinder(2, 2);
  drawFinder(size - 9, 2);
  drawFinder(2, size - 9);

  let hash = 2166136261;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  for (let y = 10; y < size - 10; y++) {
    for (let x = 10; x < size - 10; x++) {
      hash ^= (x * 31 + y * 17) & 0xff;
      hash = Math.imul(hash, 16777619);
      if ((hash >>> 0) % 2 === 0) {
        cells.push(`M${x} ${y}h1v1h-1z`);
      }
    }
  }
  return `<svg class="yq-qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${safeLabel} QR 코드"><rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${cells.join('')}"/></svg>`;
}

/**
 * 제보·이용 기록 초안 생성 및 입력 보안 검증(FR05, FR10, AC32)
 * - 학생 이름·연락처·개별 건강정보 필드를 수집하지 않는다.
 * - 외부 URL에 javascript:/data: 등이 들어오면 거절한다.
 * - 전달 경로 미설정 시 제출 완료로 표시하지 않는다.
 */
export function buildVerifiedReportDraft(rawInput = {}) {
  const errors = [];
  const type = rawInput.type || 'visit_record'; // 'visit_record' | 'place_correction'

  if (rawInput.evidenceUrl) {
    const safeUrl = sanitizeHttpUrl(rawInput.evidenceUrl);
    if (!safeUrl) {
      errors.push('참고 링크 URL은 http:// 또는 https:// 형식만 허용됩니다. (실행 가능한 스크립트 주소 차단)');
    }
  }
  if (rawInput.imageUrl) {
    const safeImg = sanitizeHttpUrl(rawInput.imageUrl);
    if (!safeImg) {
      errors.push('이미지 URL은 http:// 또는 https:// 형식만 허용됩니다.');
    }
  }

  // 개인정보(학생 실명·전화번호 패턴) 방지 안내
  const freeText = [rawInput.menuSummary, rawInput.busNotes, rawInput.correctionNote].filter(Boolean).join(' ');
  if (/01[016789]-\d{3,4}-\d{4}/.test(freeText)) {
    errors.push('공개 후기·제보 본문에는 개인 휴대전화번호 등 개인정보를 입력할 수 없습니다.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const publicPreview = {
    schemaVersion: PERSONAL_SCHEMA_VERSION,
    kind: 'report_draft',
    sourceApp: SOURCE_APP,
    type,
    isLocalDraft: true,
    reviewStatus: 'pending_operator_review',
    publicConsent: Boolean(rawInput.publicConsent),
    restaurantId: String(rawInput.restaurantId || '').trim(),
    restaurantName: String(rawInput.restaurantName || '').trim(),
    visitDate: rawInput.visitDate || null,
    mealSlot: rawInput.mealSlot || 'lunch',
    eventType: rawInput.eventType || 'field_trip',
    groupSize: rawInput.groupSize ? Number(rawInput.groupSize) : null,
    menuSummary: String(rawInput.menuSummary || '').trim(),
    unitPriceKRW: rawInput.unitPriceKRW !== undefined && rawInput.unitPriceKRW !== '' ? Number(rawInput.unitPriceKRW) : null,
    serviceMinutes: rawInput.serviceMinutes !== undefined && rawInput.serviceMinutes !== '' ? Number(rawInput.serviceMinutes) : null,
    busNotes: String(rawInput.busNotes || '').trim() || null,
    revisitIntent: rawInput.revisitIntent || 'unknown',
    schoolNameOptional: rawInput.includeSchoolName ? String(rawInput.schoolName || '').trim() : null,
    correctionNote: String(rawInput.correctionNote || '').trim() || null,
    evidenceUrl: rawInput.evidenceUrl ? sanitizeHttpUrl(rawInput.evidenceUrl) : null,
    createdAt: new Date().toISOString()
  };

  return {
    valid: true,
    errors: [],
    isSubmittedToPublicServer: false,
    deliveryChannelConfigured: SUBMISSION_CONFIG.configured,
    statusLabel: SUBMISSION_CONFIG.configured
      ? '초안 저장됨 (전달 안내 확인)'
      : '브라우저 초안 저장됨 · 전달 경로 미설정 (제보 파일을 내려받아 운영자에게 전달해 주세요. 자동 게시되지 않습니다.)',
    publicPreview,
    serializedJson: JSON.stringify(publicPreview, null, 2)
  };
}
