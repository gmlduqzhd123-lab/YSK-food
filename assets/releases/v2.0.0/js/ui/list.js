// 50개 단위 목록 페이지네이션(AC30), 문자열 영구 ID 선택(Number 변환 제거 - AC35), 조건 충족/확인 필요 분리 표시(FR03), 선택 시 지연 상세 DOM 생성, 3개 후보 비교(FR03/FR08)
import {
  DEFAULT_MARKER_COLOR,
  MAX_COMPARE_COUNT,
  PAGE_SIZE,
  REGION_COLORS
} from '../config.js';
import {
  isMappablePlace,
  sanitizeHttpUrl,
  sanitizeTelHref
} from '../data/normalize.js';
import { formatHoursSummary, getOpenStatus } from '../domain/hours.js';
import {
  evaluateDataFreshness,
  evaluateMenuSafetyDisplay,
  evaluateOfficialDesignations
} from '../domain/search.js';
import { buildKakaoRouteUrl } from './map.js';

export function getRegionColor(regionOrCity) {
  return REGION_COLORS[regionOrCity] || DEFAULT_MARKER_COLOR;
}

function el(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

export function createOpenStatusBadge(place, now = new Date()) {
  const status = getOpenStatus(place, now);
  if (status === null) return null;
  const badge = el('span', `badge ${status ? 'open' : 'closed'}`, status ? '영업 중' : '영업 종료');
  return badge;
}

export function createGroupMatchBadge(groupMatch) {
  if (!groupMatch || groupMatch.status === 'unset') {
    return el('span', 'badge group-unset', '단체 조건 미설정');
  }
  if (groupMatch.status === 'met') {
    return el('span', 'badge group-met', '확인된 조건 충족');
  }
  if (groupMatch.status === 'needs_check') {
    return el('span', 'badge group-check', `추가 확인 필요 (${groupMatch.unverifiedReasons.length}건)`);
  }
  return el('span', 'badge group-unmet', '필수 조건 불충족');
}

/**
 * 식당 카드 및 오버레이 공통 액션 버튼 묶음 생성 (길찾기, 상세보기, 전화, 즐겨찾기, 비교 담기, 행사 담기, 공유)
 * URL과 전화번호는 모두 허용 형식 검증을 거친다(AC32, AC37).
 */
export function createPlaceActionButtons(place, handlers = {}, state = {}) {
  const box = el('div', handlers.containerClass || 'place-links');
  const strId = String(place.id);
  const favSet = state.favoriteIds instanceof Set ? state.favoriteIds : new Set(state.favoriteIds || []);
  const compareList = Array.isArray(state.compareIds) ? state.compareIds : [];

  // 1) 길찾기 / 카카오맵 검색 (mappablePlaces 기준)
  const mappable = isMappablePlace(place);
  const routeHref = sanitizeHttpUrl(buildKakaoRouteUrl(place));
  if (routeHref) {
    const routeLink = el('a', 'link', mappable ? '길찾기' : '카카오맵에서 찾기');
    routeLink.href = routeHref;
    routeLink.target = '_blank';
    routeLink.rel = 'noopener noreferrer';
    box.appendChild(routeLink);
  }

  // 2) 상세보기 링크
  const safePlaceLink = sanitizeHttpUrl(place.link || place.mapLinks?.kakaoPlaceUrl);
  if (safePlaceLink) {
    const detailLink = el('a', 'link sub', '카카오 상세');
    detailLink.href = safePlaceLink;
    detailLink.target = '_blank';
    detailLink.rel = 'noopener noreferrer';
    box.appendChild(detailLink);
  }

  // 3) 전화번호 링크
  const safeTel = sanitizeTelHref(place.phone);
  if (safeTel) {
    const telLink = el('a', 'link sub', '📞 전화');
    telLink.href = safeTel;
    box.appendChild(telLink);
  }

  // 4) 즐겨찾기 (문자열 영구 ID)
  const isFav = favSet.has(strId);
  const favBtn = el('button', `link sub fav${isFav ? ' on' : ''}`, isFav ? '★ 저장됨' : '☆ 저장');
  favBtn.type = 'button';
  favBtn.dataset.favId = strId;
  favBtn.setAttribute('aria-pressed', String(isFav));
  favBtn.addEventListener('click', e => {
    e.stopPropagation();
    handlers.onToggleFavorite?.(place);
  });
  box.appendChild(favBtn);

  // 5) 후보 비교 담기 (최대 3곳)
  const inCompare = compareList.includes(strId);
  const cmpBtn = el('button', `link sub compare-btn${inCompare ? ' on' : ''}`, inCompare ? '✓ 비교함' : '+ 비교');
  cmpBtn.type = 'button';
  cmpBtn.dataset.compareId = strId;
  cmpBtn.setAttribute('aria-pressed', String(inCompare));
  cmpBtn.addEventListener('click', e => {
    e.stopPropagation();
    handlers.onToggleCompare?.(place);
  });
  box.appendChild(cmpBtn);

  // 6) 내 행사에 담기
  if (handlers.onAddToEvent) {
    const addEvBtn = el('button', 'link sub event-add-btn', '📋 행사에 담기');
    addEvBtn.type = 'button';
    addEvBtn.addEventListener('click', e => {
      e.stopPropagation();
      handlers.onAddToEvent(place);
    });
    box.appendChild(addEvBtn);
  }

  // 7) 식당 상세 모달 열기
  if (handlers.onOpenDetailModal) {
    const infoBtn = el('button', 'link sub detail-btn', '단체·상세정보');
    infoBtn.type = 'button';
    infoBtn.addEventListener('click', e => {
      e.stopPropagation();
      handlers.onOpenDetailModal(place);
    });
    box.appendChild(infoBtn);
  }

  // 8) 공유
  if (handlers.onSharePlace) {
    const shareBtn = el('button', 'link sub share', '공유');
    shareBtn.type = 'button';
    shareBtn.addEventListener('click', e => {
      e.stopPropagation();
      handlers.onSharePlace(place);
    });
    box.appendChild(shareBtn);
  }

  return box;
}

/**
 * 선택 시 지연 생성되는 지도 커스텀 오버레이 DOM(Section 9)
 */
export function createMapOverlayDom(place, onClose, handlers = {}, state = {}) {
  const wrap = el('div', 'wrap');

  const safeImg = sanitizeHttpUrl(place.image);
  if (safeImg) {
    const img = document.createElement('img');
    img.className = 'photo';
    img.src = safeImg;
    img.alt = `${place.name} 사진`;
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());
    wrap.appendChild(img);
  }

  const info = el('div', 'info');
  const closeBtn = el('button', 'close', '✖');
  closeBtn.type = 'button';
  closeBtn.title = '닫기';
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.addEventListener('click', e => {
    e.stopPropagation();
    onClose?.();
  });
  info.appendChild(closeBtn);

  const titleText = place.branchName && !place.name.includes(place.branchName)
    ? `${place.name} (${place.branchName})`
    : place.name;
  info.appendChild(el('div', 'title', titleText));

  const metaParts = [place.city, place.category, place.price ? `💰 ${place.price}` : null].filter(Boolean);
  info.appendChild(el('div', 'meta', metaParts.join(' · ')));

  if (place.menu) {
    info.appendChild(el('div', 'desc', `추천: ${place.menu}`));
  }

  const hText = formatHoursSummary(place);
  if (hText) {
    const hoursRow = el('div', 'hours', hText);
    const badge = createOpenStatusBadge(place);
    if (badge) hoursRow.appendChild(badge);
    info.appendChild(hoursRow);
  }

  if (place.note) {
    info.appendChild(el('div', 'note', `💬 ${place.note}`));
  }

  info.appendChild(createPlaceActionButtons(place, { ...handlers, containerClass: 'links' }, state));
  wrap.appendChild(info);
  return wrap;
}

/**
 * 50개 단위 페이지네이션 계획 계산(Section 9, AC30)
 * 전국이나 대량 후보에서도 한 번에 모든 DOM을 생성하지 않고 visibleLimit 단위로 끊어 생성한다.
 */
export function computePaginatedSlice(items = [], currentLimit = PAGE_SIZE) {
  const totalCount = Array.isArray(items) ? items.length : 0;
  const effectiveLimit = Math.max(PAGE_SIZE, Number(currentLimit || PAGE_SIZE));
  const visibleItems = (items || []).slice(0, effectiveLimit);
  return {
    totalCount,
    shownCount: visibleItems.length,
    hasMore: totalCount > visibleItems.length,
    remainingCount: Math.max(0, totalCount - visibleItems.length),
    nextLimit: effectiveLimit + PAGE_SIZE,
    visibleItems
  };
}

/**
 * 식당 상세 모달/패널 내용을 지연 생성한다(FR03, FR05, FR06, FR10, AC17, AC18).
 */
export function renderPlaceDetailContent(place, sources = [], handlers = {}) {
  const container = el('div', 'detail-modal-body');
  const gp = place.groupProfile || {};
  const freshness = evaluateDataFreshness(gp.checkedAt);
  const designations = place.designationSummary || evaluateOfficialDesignations(place);
  const visitSummary = place.visitSummary || {
    badgeLabel: '이용 사례 미등록',
    totalVerifiedVisits: 0,
    verifiedVisits: [],
    aggregationWindow: '-',
    policyDescription: '최근 12개월 내 운영자 검토를 마친 실제 단체 방문 3건 이상 · 서로 다른 방문일 2일 이상 기준'
  };

  // 상단 요약 헤더
  const header = el('div', 'detail-head');
  const title = el('h3', 'detail-title', place.name);
  header.appendChild(title);
  const subMeta = el(
    'p',
    'detail-sub',
    `${place.city || place.regionCode} · ${place.category || '기타'} · 주소: ${place.address || '상세 주소 미확인'} · ${
      isMappablePlace(place) ? '지도 위치 확인됨' : '지도 좌표 미확인 (목록·전화·행사 담기 가능)'
    }`
  );
  header.appendChild(subMeta);

  const badgeRow = el('div', 'detail-badges');
  badgeRow.appendChild(createGroupMatchBadge(place.groupMatch));
  const freshBadge = el(
    'span',
    `badge ${freshness.isStale ? 'stale-warn' : 'fresh-info'}`,
    `단체정보: ${freshness.label}`
  );
  badgeRow.appendChild(freshBadge);

  const visitBadge = el(
    'span',
    `badge ${visitSummary.hasRepeatVisitBadge ? 'visit-repeat' : 'visit-none'}`,
    visitSummary.badgeLabel
  );
  badgeRow.appendChild(visitBadge);
  header.appendChild(badgeRow);
  container.appendChild(header);

  // 예약 확정 아님 주의 문구(FR03, AC10)
  const disclaimer = el(
    'div',
    'detail-notice',
    '⚠️ 표시된 단체 수용·영업시간 정보는 일반 참고 자료이며, 특정 행사 날짜의 빈자리나 예약 확정을 뜻하지 않습니다. 식당과 직접 문의 후 내 행사에 확인 내역을 기록하세요.'
  );
  container.appendChild(disclaimer);

  // 1) 단체 수용·버스·시설 조건 표(FR03)
  const groupSec = el('section', 'detail-section');
  groupSec.appendChild(el('h4', '', '🚌 단체 식사 및 버스·시설 조건'));
  const triText = v => (v === 'yes' ? '가능' : v === 'no' ? '불가' : '미확인');
  const numText = (v, unit) => (v !== null && v !== undefined ? `${v}${unit}` : '미확인');

  const grid = el('div', 'detail-grid');
  const rows = [
    ['단체 수용 여부', gp.availability === 'yes' && (gp.seatTypes || []).includes('단체석')
      ? `단체석 있음${(gp.seatTypes || []).includes('룸') ? ' · 룸' : ''} (인원은 전화 확인)`
      : triText(gp.availability)],
    ['총 좌석 수', numText(gp.totalSeats, '석')],
    ['동시 식사 가능 인원', numText(gp.simultaneousCapacity, '명')],
    ['교대(회차) 식사', `${triText(gp.mealWaves?.availability)}${gp.mealWaves?.turnaroundMinutes ? ` (전환 ${gp.mealWaves.turnaroundMinutes}분)` : ''}`],
    ['별도 공간(룸/홀)', `${triText(gp.room?.privateRoom)}${gp.room?.roomFeeKRW !== null && gp.room?.roomFeeKRW !== undefined ? ` (비용 ${gp.room.roomFeeKRW.toLocaleString()}원)` : ''}`],
    ['사전 주문 조건', `${triText(gp.preOrder?.required)}${gp.preOrder?.leadTimeNote ? ` (${gp.preOrder.leadTimeNote})` : ''}`],
    ['주차', gp.parking?.walkingNotes || '미확인'],
    ['대형버스 진입', triText(gp.parking?.busEntry)],
    ['버스 주차 가능 대수', numText(gp.parking?.busParkingSpaces, '대')],
    ['버스 승하차만 가능', `${triText(gp.parking?.dropoff)}${gp.parking?.dropoffLocation ? ` (${gp.parking.dropoffLocation})` : ''}`],
    ['하차 후 도보 거리', numText(gp.parking?.walkingDistanceMeters, 'm')],
    ['단체 조식 제공', `${triText(gp.earlyBreakfast?.availability)}${gp.earlyBreakfast?.earliestTime ? ` (${gp.earlyBreakfast.earliestTime}부터)` : ''}`],
    ['단체 도시락·포장', `${triText(gp.lunchbox?.availability)}${gp.lunchbox?.minOrderQty ? ` (최소 ${gp.lunchbox.minOrderQty}개)` : ''}${gp.lunchbox?.handlingNotes && !gp.lunchbox?.minOrderQty ? ` · ${gp.lunchbox.handlingNotes}` : ''}`],
    ['예약', gp.preOrder?.leadTimeNote || '미확인'],
    ['출입·계단·화장실', [gp.accessibility?.stairs, gp.accessibility?.entryNote, gp.accessibility?.restroom].filter(Boolean).join(' / ') || '미확인'],
    ['단체정보 확인일', freshness.label]
  ];

  for (const [k, v] of rows) {
    const item = el('div', 'detail-kv');
    item.appendChild(el('span', 'kv-k', k));
    item.appendChild(el('strong', 'kv-v', v));
    grid.appendChild(item);
  }
  groupSec.appendChild(grid);
  container.appendChild(groupSec);

  // 2) 학생 메뉴 및 원재료·맵기·양 조절 정보(FR06, AC17)
  const menuSec = el('section', 'detail-section');
  menuSec.appendChild(el('h4', '', '🍚 메뉴 · 단가 기준 · 원재료 답변'));
  const menus = Array.isArray(place.menus) ? place.menus : [];
  if (menus.length === 0) {
    menuSec.appendChild(el('p', 'detail-empty', '등록된 세부 메뉴 정보가 없습니다.'));
  } else {
    const menuList = el('ul', 'detail-menu-list');
    for (const m of menus) {
      const mInfo = evaluateMenuSafetyDisplay(m);
      const li = el('li', 'detail-menu-item');
      const top = el('div', 'menu-top');
      top.appendChild(el('strong', '', mInfo.name));
      top.appendChild(el('span', 'menu-price', mInfo.priceText));
      li.appendChild(top);

      const opts = el(
        'div',
        'menu-opts',
        `${mInfo.studentPortionLabel} · ${mInfo.spiceAdjustmentLabel} · ${mInfo.extraRiceLabel} · ${mInfo.altMenuInquiryLabel}`
      );
      li.appendChild(opts);
      li.appendChild(el('div', 'menu-ing', mInfo.ingredientLabel));
      menuList.appendChild(li);
    }
    menuSec.appendChild(menuList);
    menuSec.appendChild(
      el('p', 'detail-sub-note', '※ 메뉴 이름이나 맵기 조절 가능 여부만으로 알레르기·식사 안전성을 자동 판정하지 않습니다. 학생 알레르기 항목은 식당에 직접 문의해 개인 행사 계획에 기록하세요.')
    );
  }
  container.appendChild(menuSec);

  // 3) 공식 위생·안심 지정 정보(FR06, AC18)
  const desigSec = el('section', 'detail-section');
  desigSec.appendChild(el('h4', '', '🏛️ 공식 지정 정보 (위생등급·안심식당 등)'));
  desigSec.appendChild(el('p', 'detail-sub-note', designations.separationNotice));
  if (designations.allDesignations.length === 0) {
    desigSec.appendChild(el('p', 'detail-empty', '연결된 공식 지정 정보가 없습니다 (미등록).'));
  } else {
    const dList = el('ul', 'detail-desig-list');
    for (const d of designations.allDesignations) {
      const li = el(
        'li',
        `desig-item ${d.badgeAllowed ? 'desig-valid' : 'desig-invalid'}`,
        `[${d.statusLabel}] ${d.agency || '기관'} · ${d.designationType || '지정'} (번호: ${d.designationNumber || '-'}, 기간: ${d.validFrom || '?'} ~ ${d.validTo || '상시'}, 확인일: ${d.checkedAt || '미상'})`
      );
      dList.appendChild(li);
    }
    desigSec.appendChild(dList);
  }
  container.appendChild(desigSec);

  // 4) 교사·지도자 실제 이용 기록 근거(FR05, AC19, AC56)
  const visitSec = el('section', 'detail-section');
  visitSec.appendChild(el('h4', '', '🏫 학교·선수단 실제 이용 기록 및 집계 근거'));
  visitSec.appendChild(
    el('p', 'detail-sub-note', `집계 정책: ${visitSummary.policyDescription} (집계 구간: ${visitSummary.aggregationWindow})`)
  );
  if (visitSummary.verifiedVisits.length === 0) {
    visitSec.appendChild(el('p', 'detail-empty', '현재 검토 완료된 공개 이용 사례가 없습니다 (이용 사례 미등록).'));
  } else {
    const vList = el('ul', 'detail-visit-list');
    for (const v of visitSummary.verifiedVisits) {
      const li = el(
        'li',
        'visit-item',
        `• ${v.visitDate} (${v.mealSlot || '식사'}) · 인원 ${v.groupSize || '?'}명 · 메뉴: ${v.menuSummary || '-'}${
          v.unitPriceKRW ? ` · 당시 단가 ${v.unitPriceKRW.toLocaleString()}원` : ''
        }${v.serviceMinutes ? ` · 배식·식사 ${v.serviceMinutes}분` : ''} [검토일: ${v.reviewedAt || '-'}]`
      );
      vList.appendChild(li);
    }
    visitSec.appendChild(vList);
  }
  container.appendChild(visitSec);

  // 5) 자료 출처 및 확인일(FR10)
  const srcSec = el('section', 'detail-section');
  srcSec.appendChild(el('h4', '', '📌 자료 출처 및 확인일'));
  const refSet = new Set([
    ...(gp.evidenceRefs || []),
    ...(place.openingHours?.evidenceRefs || [])
  ]);
  // 전국 보기에서는 지역마다 같은 출처가 들어 있으므로 출처 ID 기준으로 한 번씩만 보여 준다
  const seenSourceIds = new Set();
  const matchedSources = (sources || [])
    .filter(s => refSet.has(s.id) || sources.length <= 2)
    .filter(s => (seenSourceIds.has(s.id) ? false : (seenSourceIds.add(s.id), true)));
  if (matchedSources.length === 0) {
    srcSec.appendChild(el('p', 'detail-empty', '기본 등록 자료 (확인일: 2026-10-18)'));
  } else {
    for (const s of matchedSources) {
      srcSec.appendChild(
        el('p', 'detail-source-row', `• ${s.attribution || s.id} · 확인일: ${s.checkedAt || '미상'} · 범위: ${s.usageTerms || '일반 정보'}`)
      );
    }
  }
  container.appendChild(srcSec);

  return container;
}

/**
 * 최대 3곳 후보 식당 비교 표/카드 생성(FR03, FR08)
 */
export function renderCandidateComparisonContent(places = [], criteria = {}, handlers = {}) {
  const wrap = el('div', 'compare-modal-body');
  const limited = places.slice(0, MAX_COMPARE_COUNT);

  if (limited.length === 0) {
    wrap.appendChild(el('p', 'empty', '비교함에 담긴 식당이 없습니다. 식당 목록에서 [+ 비교] 버튼을 눌러 최대 3곳까지 담아 비교해 보세요.'));
    return wrap;
  }

  const headNote = el(
    'p',
    'compare-note',
    `총 ${limited.length}곳 후보 비교 (최대 3곳) · 기준 인원: ${criteria.totalHeadcount ? `${criteria.totalHeadcount}명` : '미설정'} · 1인 예산: ${
      criteria.budgetPerPersonKRW ? `${criteria.budgetPerPersonKRW.toLocaleString()}원` : '미설정'
    }`
  );
  wrap.appendChild(headNote);

  const cardsWrap = el('div', 'compare-cards');
  for (const p of limited) {
    const card = el('div', 'compare-card');
    const gp = p.groupProfile || {};
    const freshness = evaluateDataFreshness(gp.checkedAt);
    const titleRow = el('div', 'compare-card-head');
    titleRow.appendChild(el('strong', '', `${p.name} (${p.city || p.regionCode})`));
    const rmBtn = el('button', 'link sub', '제외');
    rmBtn.type = 'button';
    rmBtn.addEventListener('click', () => handlers.onRemoveCompare?.(p.id));
    titleRow.appendChild(rmBtn);
    card.appendChild(titleRow);

    card.appendChild(createGroupMatchBadge(p.groupMatch));

    const fields = [
      ['직선거리', p.straightDistanceLabel || '거리 미확인'],
      ['대표 메뉴', p.menu || '미확인'],
      ['동시 수용 인원', gp.simultaneousCapacity !== null && gp.simultaneousCapacity !== undefined ? `${gp.simultaneousCapacity}명` : '미확인'],
      ['교대 식사', gp.mealWaves?.availability === 'yes' ? '가능' : gp.mealWaves?.availability === 'no' ? '불가' : '미확인'],
      ['버스 주차·승하차', gp.parking?.busParkingSpaces !== null && gp.parking?.busParkingSpaces !== undefined ? `주차 ${gp.parking.busParkingSpaces}대` : gp.parking?.dropoff === 'yes' ? '승하차 가능' : '미확인'],
      ['영업시간', formatHoursSummary(p) || '미확인'],
      ['이용 사례', p.visitSummary?.badgeLabel || '이용 사례 미등록'],
      ['자료 확인일', freshness.label],
      ['미확인 항목', (p.groupMatch?.unverifiedReasons || []).join(', ') || '필수 미확인 없음']
    ];

    const dl = el('div', 'compare-fields');
    for (const [k, v] of fields) {
      const row = el('div', 'compare-row');
      row.appendChild(el('span', 'cmp-k', k));
      row.appendChild(el('span', 'cmp-v', v));
      dl.appendChild(row);
    }
    card.appendChild(dl);

    if (handlers.onAddToEvent) {
      const addBtn = el('button', 'link', '📋 이 식당을 내 행사에 담기');
      addBtn.type = 'button';
      addBtn.addEventListener('click', () => handlers.onAddToEvent(p));
      card.appendChild(addBtn);
    }
    cardsWrap.appendChild(card);
  }

  wrap.appendChild(cardsWrap);
  return wrap;
}
