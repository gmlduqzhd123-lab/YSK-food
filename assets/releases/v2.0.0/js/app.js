// 앱 초기화(1회 실행 보장), 단일 라우터·popstate 연결, 모드·지역·단체 조건·비교·내 행사·제보·운영 도구 UI 통합, 대기 서비스 워커 협업(AC41)
import {
  APP_BASE,
  APP_MODES,
  APP_VERSION,
  EVENT_PRESETS,
  MAX_COMPARE_COUNT,
  PAGE_SIZE,
  REGION_COLORS,
  resolveAppUrl
} from './config.js';
import {
  csvToPlaces,
  isMappablePlace,
  isValidCoordinate,
  validateBackupEnvelope,
  validateRegionDataset
} from './data/normalize.js';
import { DatasetRepository } from './data/repository.js';
import { buildPlannedMealWindow, formatHoursSummary, getOpenStatus } from './domain/hours.js';
import { evaluateMealPlanCost } from './domain/budget.js';
import {
  copyMealPlanToDate,
  evaluateMealPlanStatus,
  evaluateMealWaves,
  generateRestaurantInquiryText
} from './domain/schedule.js';
import { filterAndClassifyRestaurants } from './domain/search.js';
import {
  PersonalStorageManager,
  buildShareEnvelope,
  detectPublicDataChangesAgainstSnapshot,
  loadAndMigrateUiState,
  migrateLegacyGeoCache,
  saveUiState
} from './storage.js';
import { MapController } from './ui/map.js';
import {
  computePaginatedSlice,
  createGroupMatchBadge,
  createMapOverlayDom,
  createOpenStatusBadge,
  createPlaceActionButtons,
  getRegionColor,
  renderCandidateComparisonContent,
  renderPlaceDetailContent
} from './ui/list.js';
import {
  addCandidateToMealPlan,
  buildTeacherPrintViewDom,
  createNewPersonalEvent,
  recordCandidateQuote,
  recordMealConfirmation,
  selectMealPlanCandidate,
  verifyOfflineReadiness
} from './ui/event.js';
import {
  buildPublicQrSvg,
  buildPublicShareUrl,
  buildVerifiedReportDraft,
  parseRouteFromUrl
} from './ui/share.js';

let appInitialized = false;

export class YskFoodApp {
  constructor() {
    this.repository = new DatasetRepository({ appBase: APP_BASE });
    this.storageManager = new PersonalStorageManager();

    this.state = {
      mode: 'general', // 'general' | 'school' | 'athlete'
      presetId: '',
      regionCode: 'all',
      category: 'all',
      query: '',
      favOnly: false,
      openOnly: false,
      includeNeedsCheck: true,
      sortBy: 'default',
      selectedId: null, // 항상 문자열 영구 ID 또는 null
      compareIds: [],   // 최대 3개 문자열 영구 ID
      visibleLimit: PAGE_SIZE,
      referencePoint: null, // { lat, lng, label, type }
      groupCriteria: {
        studentCount: '',
        staffCount: '',
        otherCount: '',
        budgetPerPersonKRW: '',
        busCount: '',
        busParkingRequired: false,
        seatingPolicy: 'simultaneous_required',
        visitDate: '',
        startTime: '',
        endTime: '',
        endNextDay: false,
        privateRoomRequired: false,
        earlyBreakfastRequired: false,
        lunchboxRequired: false
      },
      hasUnsavedEventEdits: false
    };

    this.uiState = loadAndMigrateUiState(null).state;
    this.favoriteIds = new Set(this.uiState.favoriteIds || []);

    this.currentRestaurants = [];
    this.currentVenues = [];
    this.currentVisitRecords = [];
    this.currentSources = [];
    this.lastFilterResult = null;
    this.personalEvents = [];
    this.activeEventId = null;

    this.panelMode = 'half';
    this.mobileQuery = window.matchMedia('(max-width: 767px)');
    this.searchDebounceTimer = null;
    this.lastFocusedElement = null;
    this.waitingServiceWorker = null;

    this.mapController = new MapController({
      onSelectPlace: (placeId, fromList) => this.selectPlace(placeId, fromList),
      onCloseOverlay: () => this.clearSelection(),
      createOverlayDom: (place, onClose) =>
        createMapOverlayDom(place, onClose, this.getPlaceActionHandlers(), {
          favoriteIds: this.favoriteIds,
          compareIds: this.state.compareIds
        })
    });
  }

  async init() {
    if (appInitialized) return;
    appInitialized = true;

    this.bindStaticDomEvents();
    this.setupMinuteOpenBadgeRefresh();
    this.registerServiceWorkerWithVersionGuard();

    // 1) 개인 행사 로드 (지도 SDK와 완전 독립)
    try {
      this.personalEvents = await this.storageManager.listEvents();
      if (this.personalEvents.length > 0) {
        this.activeEventId = this.personalEvents[0].id;
      }
      this.updatePersonalEventHeaderBadge();
    } catch {
      this.personalEvents = [];
    }

    // 2) 공용 코어 색인 로드 및 구형 즐겨찾기·위치 캐시 1회 이전
    const coreRes = await this.repository.loadCoreBundle();
    if (coreRes.bundle?.legacyAliases) {
      const migRes = loadAndMigrateUiState(coreRes.bundle.legacyAliases);
      this.uiState = migRes.state;
      this.favoriteIds = new Set(this.uiState.favoriteIds || []);
      migrateLegacyGeoCache(coreRes.bundle.legacyAliases);
    }

    this.renderRegionSelector();
    this.renderLegend();

    // 3) 초기 URL 라우팅 해석 및 지역 데이터 로드 (지도 SDK 완료를 기다리지 않고 목록 먼저 표시!)
    await this.applyRouteFromLocation({ isInitialLoad: true, fromPopstate: false });

    // 4) 비동기 지도 SDK 초기화 (지연되거나 실패해도 목록·검색·행사 기능은 계속 동작 - AC06, AC38)
    this.initMapAsync();
  }

  async initMapAsync(forceRetry = false) {
    const mapContainer = document.getElementById('map');
    if (!mapContainer) return;

    if (forceRetry) {
      this.mapController.loadSdk({ forceRetry: true });
    }

    const res = await this.mapController.initMap(mapContainer);
    if (!res.ready) {
      this.renderMapErrorState(mapContainer);
      return;
    }

    const locateBtn = document.getElementById('locate-btn');
    const legendEl = document.getElementById('legend');
    if (locateBtn) locateBtn.hidden = false;
    if (legendEl) legendEl.hidden = false;

    if (this.lastFilterResult) {
      this.mapController.syncMarkers(this.lastFilterResult.combinedList);
      const regMeta = this.repository.getRegionMeta(this.state.regionCode);
      this.mapController.fitToPlaces(this.lastFilterResult.combinedList, regMeta);
      if (this.state.selectedId) {
        const selectedPlace = this.currentRestaurants.find(p => String(p.id) === String(this.state.selectedId));
        this.mapController.focusPlaceById(this.state.selectedId, selectedPlace, false);
      }
    }
  }

  renderMapErrorState(container) {
    const locateBtn = document.getElementById('locate-btn');
    const legendEl = document.getElementById('legend');
    if (locateBtn) locateBtn.hidden = true;
    if (legendEl) legendEl.hidden = true;

    container.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'map-error';
    box.setAttribute('role', 'alert');

    const title = document.createElement('strong');
    title.textContent = '지도를 불러오지 못했어요 😢';
    const desc = document.createElement('span');
    desc.textContent = '인터넷 연결이나 도메인 설정을 확인해 주세요. 지도가 없어도 왼쪽 목록 검색·전화·즐겨찾기·후보 비교·내 행사 관리는 모두 정상 이용할 수 있어요.';
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.textContent = '지도 다시 시도';
    retryBtn.addEventListener('click', () => this.initMapAsync(true));

    box.append(title, desc, retryBtn);
    container.appendChild(box);
  }

  getPlaceActionHandlers() {
    return {
      onToggleFavorite: place => this.toggleFavorite(place),
      onToggleCompare: place => this.toggleCompareCandidate(place),
      onAddToEvent: place => this.handleAddPlaceToActiveEvent(place),
      onOpenDetailModal: place => this.openPlaceDetailModal(place),
      onSharePlace: place => this.shareSinglePlace(place)
    };
  }

  /**
   * URL 라우터 적용 (초기 진입 & popstate 공통 호출 - Section 9, AC36)
   */
  async applyRouteFromLocation({ isInitialLoad = false, fromPopstate = false } = {}) {
    const route = parseRouteFromUrl(window.location.href);
    const homeEl = document.getElementById('home');

    // 필터 복원
    if (route.filters) {
      this.state.mode = route.filters.mode || 'general';
      this.state.regionCode = route.filters.region || 'all';
      this.state.category = route.filters.category || 'all';
      this.state.query = route.filters.q || '';
      this.state.favOnly = Boolean(route.filters.fav);
      this.state.openOnly = Boolean(route.filters.open);
      this.syncFilterControlsFromState();
    }

    // 1) 모호한 링크(restaurantId와 restaurantIds가 동시에 있는 경우 - FR01)
    if (route.status === 'ambiguous_link') {
      if (homeEl) homeEl.hidden = true;
      await this.loadSelectedRegionData(this.state.regionCode);
      this.applyFilters(false);
      this.showBannerAlert(route.message, 'warn');
      return;
    }

    // 2) 단일 식당 영구 ID 링크 (?restaurantId=...)
    if (route.view === 'detail' && route.restaurantId) {
      if (homeEl) homeEl.hidden = true;
      const res = await this.repository.resolveRestaurantById(route.restaurantId);

      if (res.status === 'found' && res.restaurant) {
        if (this.state.regionCode !== 'all' && this.state.regionCode !== res.regionCode) {
          this.state.regionCode = res.regionCode;
        }
        await this.loadSelectedRegionData(this.state.regionCode);
        this.applyFilters(false);
        this.selectPlace(res.restaurant.id, true, { skipHistoryPush: true });
        this.openPlaceDetailModal(res.restaurant);

        if (isInitialLoad || route.ignoredLegacyPlace) {
          const cleanShare = buildPublicShareUrl({
            restaurantId: res.restaurant.id,
            region: this.state.regionCode,
            mode: this.state.mode
          });
          if (cleanShare.valid) {
            history.replaceState({ yskView: 'detail', restaurantId: res.restaurant.id }, '', cleanShare.url);
          }
        }
        return;
      }

      // ID 미등록 / 공개자료 제거 / 색인 실패 / 지역 실패 / 오프라인 미저장 구분 표시(FR01, AC40)
      await this.loadSelectedRegionData(this.state.regionCode);
      this.applyFilters(false);
      this.showBannerAlert(res.message || `식당(${route.restaurantId})을 열 수 없습니다 (${res.status}).`, 'warn');
      return;
    }

    // 3) 공개 후보 비교 링크 (?restaurantIds=ID1&restaurantIds=ID2...)
    if (route.view === 'compare' && Array.isArray(route.restaurantIds)) {
      if (homeEl) homeEl.hidden = true;
      await this.loadSelectedRegionData(this.state.regionCode);
      const resolvedList = await this.repository.resolveMultipleRestaurantsByIds(route.restaurantIds);
      const foundPlaces = resolvedList.filter(r => r.status === 'found' && r.restaurant).map(r => r.restaurant);
      this.state.compareIds = foundPlaces.map(p => String(p.id));
      this.updateCompareBarUi();
      this.applyFilters(false);

      if (route.exceededMaxCount) {
        this.showToast(`후보 비교는 최대 ${MAX_COMPARE_COUNT}곳까지 지원하여 앞의 3곳만 표시합니다.`);
      }
      this.openCandidateCompareModal(foundPlaces);
      return;
    }

    // 4) 구형 ?place=식당이름 링크 호환 및 정규화(Section 8.6, AC02)
    if (route.view === 'legacy_place' && route.legacyPlaceName) {
      if (homeEl) homeEl.hidden = true;
      await this.loadSelectedRegionData(this.state.regionCode);
      const aliasRes = this.repository.resolveLegacyPlaceName(route.legacyPlaceName);

      if (aliasRes.status === 'resolved' && aliasRes.restaurantId) {
        const cleanUrl = buildPublicShareUrl({ restaurantId: aliasRes.restaurantId });
        if (cleanUrl.valid && !fromPopstate) {
          history.replaceState({ yskView: 'detail', restaurantId: aliasRes.restaurantId }, '', cleanUrl.url);
        }
        const restRes = await this.repository.resolveRestaurantById(aliasRes.restaurantId);
        this.applyFilters(false);
        if (restRes.status === 'found' && restRes.restaurant) {
          this.selectPlace(restRes.restaurant.id, true, { skipHistoryPush: true });
        }
        return;
      }

      if (aliasRes.status === 'ambiguous') {
        this.applyFilters(false);
        this.openAmbiguousLegacyPlaceModal(route.legacyPlaceName, aliasRes.candidates);
        return;
      }

      this.applyFilters(false);
      this.showBannerAlert(`구형 공유 링크('${route.legacyPlaceName}')와 일치하는 식당을 찾지 못했어요.`, 'warn');
      return;
    }

    // 5) 홈 화면 또는 일반 지도 화면
    await this.loadSelectedRegionData(this.state.regionCode);
    this.applyFilters(true);
    this.renderHomeStats();

    if (route.showHome) {
      if (homeEl) {
        homeEl.hidden = false;
        homeEl.scrollTop = 0;
      }
      if (isInitialLoad && !fromPopstate) {
        history.replaceState({ yskView: 'home' }, '', window.location.href);
      }
    } else {
      if (homeEl) homeEl.hidden = true;
      if (isInitialLoad && !fromPopstate) {
        history.replaceState({ yskView: 'map' }, '', window.location.href);
      }
      if (route.isCheckMode) {
        this.showCoordinateCheckReport();
      }
    }
  }

  /**
   * 선택 지역 데이터 로드 및 상태 반영(AC07, AC08, AC39)
   */
  async loadSelectedRegionData(regionCode) {
    const res = await this.repository.selectRegion(regionCode);
    if (res.stale) return res; // 경합으로 폐기된 이전 요청 무시(AC07)

    this.currentRestaurants = res.restaurants || [];
    this.currentVenues = res.venues || [];
    this.currentVisitRecords = res.visitRecords || [];
    this.currentSources = res.sources || [];

    this.renderCategoryButtons();
    this.renderReferencePointSelector();
    this.renderRegionDatasetStatusBanner(res);

    const openFilterBtn = document.getElementById('open-filter');
    if (openFilterBtn) {
      openFilterBtn.hidden = false;
    }

    return res;
  }

  renderRegionDatasetStatusBanner(regionRes) {
    const banner = document.getElementById('dataset-status-banner');
    if (!banner) return;

    const regMeta = this.repository.getRegionMeta(this.state.regionCode);
    const totalCount = this.currentRestaurants.length;
    const unverifiedCoordCount = this.currentRestaurants.filter(p => !isMappablePlace(p)).length;
    const groupVerifiedCount = this.currentRestaurants.filter(p => p.groupProfile?.availability === 'yes').length;

    if (regionRes.status === 'region_error' || regionRes.status === 'offline_unsaved') {
      banner.hidden = false;
      banner.className = 'status-banner error';
      banner.textContent = `⚠️ ${regionRes.errorMessage}`;
      return;
    }

    if (regionRes.usingFallbackBundle) {
      banner.hidden = false;
      banner.className = 'status-banner warn';
      banner.textContent = `ℹ️ 최신 자료 묶음이 불완전하여 이전 정상 버전(${regionRes.datasetVersion}, 확인일: ${String(regionRes.generatedAt || '').slice(0, 10)})을 표시합니다.`;
      return;
    }

    banner.hidden = false;
    banner.className = 'status-banner info';
    const regTitle = regMeta ? `${regMeta.sidoName || ''} ${regMeta.name}`.trim() : '여수·순천·광양 전체';
    banner.textContent = `📍 ${regTitle}: 등록 ${totalCount}곳 · 지도 위치 확인 ${totalCount - unverifiedCoordCount}곳 (좌표 미확인 ${unverifiedCoordCount}곳) · 단체 수용 확인 ${groupVerifiedCount}곳 · 최근 갱신 2026-10-18`;
  }

  showBannerAlert(message, level = 'warn') {
    const banner = document.getElementById('dataset-status-banner');
    if (!banner) {
      this.showToast(message);
      return;
    }
    banner.hidden = false;
    banner.className = `status-banner ${level}`;
    banner.textContent = message;
  }

  /**
   * 필터·단체 조건 적용 및 목록·지도 갱신
   */
  applyFilters(fitMap = false) {
    const gc = this.state.groupCriteria;
    let mealWindow = null;
    if (gc.visitDate && gc.startTime && gc.endTime) {
      const mw = buildPlannedMealWindow({
        date: gc.visitDate,
        startTime: gc.startTime,
        endTime: gc.endTime,
        endNextDay: gc.endNextDay
      });
      if (mw.valid) mealWindow = mw;
    }

    const result = filterAndClassifyRestaurants(
      this.currentRestaurants,
      {
        regionCode: this.state.regionCode,
        city: 'all',
        category: this.state.category,
        query: this.state.query,
        favOnly: this.state.favOnly,
        openOnly: this.state.openOnly,
        favoriteIds: this.favoriteIds,
        referencePoint: this.state.referencePoint,
        sortBy: this.state.sortBy,
        includeNeedsCheck: this.state.includeNeedsCheck,
        groupCriteria: {
          ...gc,
          mealWindow
        }
      },
      this.currentVisitRecords
    );

    this.lastFilterResult = result;

    if (this.mapController.isReady()) {
      this.mapController.syncMarkers(result.combinedList);
      if (fitMap) {
        const regMeta = this.repository.getRegionMeta(this.state.regionCode);
        this.mapController.fitToPlaces(result.combinedList, regMeta);
      }
    }

    const visibleIdSet = new Set(result.combinedList.map(p => String(p.id)));
    if (this.state.selectedId && !visibleIdSet.has(String(this.state.selectedId))) {
      this.clearSelection();
    }

    this.renderPlaceList(result);
  }

  /**
   * 50개 단위 목록 렌더링 + 조건 충족 / 추가 확인 필요 구분 표시(FR03, Section 9, AC30, AC35)
   */
  renderPlaceList(filterResult) {
    const countEl = document.getElementById('panel-count');
    const sortNoteEl = document.getElementById('sort-note');
    const ul = document.getElementById('place-list');
    if (!ul) return;

    const { combinedList, counts, hasGroupCriteria } = filterResult;
    const pageSlice = computePaginatedSlice(combinedList, this.state.visibleLimit);

    if (countEl) {
      countEl.textContent = hasGroupCriteria
        ? `후보 ${counts.totalMatched}곳 (충족 ${counts.confirmedMet} · 확인필요 ${counts.needsCheck})`
        : `맛집 ${counts.totalMatched}곳 (표시 ${pageSlice.shownCount}곳)`;
    }
    if (sortNoteEl) {
      sortNoteEl.textContent = this.state.referencePoint
        ? `${this.state.referencePoint.label} 기준 직선거리 순`
        : '';
    }

    ul.innerHTML = '';

    // 단체 조건 설정 시 요약 안내 바 표시
    if (hasGroupCriteria) {
      const summaryLi = document.createElement('li');
      summaryLi.className = 'group-filter-summary';
      summaryLi.textContent = `단체 조건 판정: 확인된 조건 충족 ${counts.confirmedMet}곳 · 추가 확인 필요 ${counts.needsCheck}곳 · 필수 불충족 제외 ${counts.excludedUnmet}곳 (일반 조건 비교이며 날짜별 예약 가능 여부는 별도 확인)`;
      ul.appendChild(summaryLi);
    }

    if (combinedList.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'empty';
      if (this.currentRestaurants.length === 0) {
        const regMeta = this.repository.getRegionMeta(this.state.regionCode);
        emptyLi.textContent = `${regMeta?.name || '선택한 지역'}에는 아직 등록된 식당이 없습니다 (0곳). 다른 지역을 선택하거나 [기록·제보]에서 식당을 제보해 주세요.`;
      } else if (this.state.favOnly && this.favoriteIds.size === 0) {
        emptyLi.textContent = '아직 저장한 맛집이 없어요. 식당의 ☆ 저장 버튼을 눌러 보세요.';
      } else {
        emptyLi.textContent = `조건에 맞는 식당이 없습니다.${counts.excludedUnmet > 0 ? ` (필수 조건 불충족으로 ${counts.excludedUnmet}곳 제외됨 — 조건을 완화하거나 교대 식사 허용으로 변경해 보세요.)` : ''}`;
      }
      ul.appendChild(emptyLi);
      return;
    }

    const handlers = this.getPlaceActionHandlers();
    let lastGroupSection = null;

    for (const place of pageSlice.visibleItems) {
      const strId = String(place.id);

      // 단체 조건 검색 시 '확인된 조건 충족'과 '추가 확인 필요' 섹션 머리글 분리(FR03)
      if (hasGroupCriteria && place.groupMatch?.status !== lastGroupSection) {
        lastGroupSection = place.groupMatch?.status;
        const secHead = document.createElement('li');
        secHead.className = 'list-section-divider';
        secHead.textContent = lastGroupSection === 'met'
          ? `✅ 확인된 조건 충족 (${counts.confirmedMet}곳)`
          : `🔍 추가 확인 필요 — 미확인 항목 식당 문의 (${counts.needsCheck}곳)`;
        ul.appendChild(secHead);
      }

      const li = document.createElement('li');
      li.dataset.id = strId; // 문자열 영구 ID 저장
      if (strId === String(this.state.selectedId)) {
        li.classList.add('selected');
      }

      const mainBtn = document.createElement('button');
      mainBtn.type = 'button';
      mainBtn.className = 'place-main';

      if (this.state.referencePoint) {
        const distSpan = document.createElement('span');
        distSpan.className = 'place-dist';
        distSpan.textContent = place.straightDistanceLabel || '거리 미확인';
        mainBtn.appendChild(distSpan);
      }

      const nameRow = document.createElement('div');
      nameRow.className = 'place-name';
      nameRow.style.setProperty('--c', getRegionColor(place.regionCode || place.city));
      nameRow.textContent = place.name;
      mainBtn.appendChild(nameRow);

      const coordTag = isMappablePlace(place) ? '' : ' · 📍좌표 미확인';
      const metaRow = document.createElement('div');
      metaRow.className = 'place-meta';
      metaRow.textContent = `${place.city || place.regionCode} · ${place.category || '기타'}${place.price ? ` · 💰 ${place.price}` : ''}${coordTag}`;
      mainBtn.appendChild(metaRow);

      const hSummary = formatHoursSummary(place);
      if (hSummary) {
        const hoursRow = document.createElement('div');
        hoursRow.className = 'place-hours';
        hoursRow.textContent = hSummary;
        const openBadge = createOpenStatusBadge(place);
        if (openBadge) hoursRow.appendChild(openBadge);
        mainBtn.appendChild(hoursRow);
      }

      if (place.menu) {
        const menuRow = document.createElement('div');
        menuRow.className = 'place-menu';
        menuRow.textContent = `추천: ${place.menu}`;
        mainBtn.appendChild(menuRow);
      }

      // 학교·선수단 모드이거나 단체 조건이 입력된 경우 단체 배지 및 이용 사례 배지 표시
      if (this.state.mode !== 'general' || hasGroupCriteria) {
        const groupRow = document.createElement('div');
        groupRow.className = 'place-group-badges';
        groupRow.appendChild(createGroupMatchBadge(place.groupMatch));
        if (place.visitSummary) {
          const vBadge = document.createElement('span');
          vBadge.className = `badge ${place.visitSummary.hasRepeatVisitBadge ? 'visit-repeat' : 'visit-none'}`;
          vBadge.textContent = place.visitSummary.badgeLabel;
          groupRow.appendChild(vBadge);
        }
        mainBtn.appendChild(groupRow);
      }

      mainBtn.addEventListener('click', () => this.selectPlace(strId, true));
      li.append(
        mainBtn,
        createPlaceActionButtons(place, handlers, {
          favoriteIds: this.favoriteIds,
          compareIds: this.state.compareIds
        })
      );
      ul.appendChild(li);
    }

    // 50개 단위 더 보기 버튼(Section 9, AC30)
    if (pageSlice.hasMore) {
      const moreLi = document.createElement('li');
      moreLi.className = 'more-item-wrap';
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'more-btn';
      moreBtn.textContent = `결과 더 보기 (${pageSlice.shownCount} / ${pageSlice.totalCount}곳 표시 중 · +${Math.min(PAGE_SIZE, pageSlice.remainingCount)}곳)`;
      moreBtn.addEventListener('click', () => {
        this.state.visibleLimit = pageSlice.nextLimit;
        this.renderPlaceList(this.lastFilterResult);
      });
      moreLi.appendChild(moreBtn);
      ul.appendChild(moreLi);
    }

    const noteLi = document.createElement('li');
    noteLi.className = 'hours-note';
    noteLi.textContent = '🕒 등록된 영업시간·단체 수용 조건은 일반 참고 자료입니다. 행사 방문 전 반드시 식당에 전화·문의하여 해당 날짜 예약 가능 여부를 확인하세요.';
    ul.appendChild(noteLi);
  }

  /**
   * 문자열 영구 ID 기반 식당 선택(Section 8.7, AC35)
   * Number(li.dataset.id) 변환을 절대 사용하지 않고 문자열로만 비교한다.
   */
  selectPlace(placeId, fromList = false, options = {}) {
    const strId = String(placeId || '');
    this.state.selectedId = strId;

    document.querySelectorAll('.place-list li[data-id]').forEach(li => {
      li.classList.toggle('selected', String(li.dataset.id) === strId);
    });

    const selectedPlace = this.currentRestaurants.find(p => String(p.id) === strId) || null;
    const listItem = document.querySelector(`.place-list li[data-id="${CSS.escape(strId)}"]`);
    if (listItem && !fromList) {
      listItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else if (listItem && fromList) {
      listItem.scrollIntoView({ block: 'nearest' });
    }

    if (selectedPlace && isMappablePlace(selectedPlace) && this.mapController.isReady()) {
      if (this.mobileQuery.matches && ((this.panelMode === 'list') || (!fromList && this.panelMode === 'map'))) {
        this.setPanelMode('half');
      }
      this.mapController.focusPlaceById(strId, selectedPlace, !fromList);
    } else {
      this.mapController.closeOverlay();
    }

    if (!options.skipHistoryPush) {
      const shareRes = buildPublicShareUrl({
        restaurantId: strId,
        region: this.state.regionCode,
        mode: this.state.mode
      });
      if (shareRes.valid) {
        history.pushState({ yskView: 'detail', restaurantId: strId }, '', shareRes.url);
      }
    }
  }

  clearSelection() {
    this.state.selectedId = null;
    this.mapController.closeOverlay();
    document.querySelectorAll('.place-list li.selected').forEach(li => li.classList.remove('selected'));
  }

  /**
   * 즐겨찾기 토글 (문자열 영구 ID를 ysk-food-ui-v2에 저장 - AC02, AC35, AC43)
   */
  toggleFavorite(place) {
    const strId = String(place.id);
    const isNowFav = !this.favoriteIds.has(strId);
    if (isNowFav) {
      this.favoriteIds.add(strId);
    } else {
      this.favoriteIds.delete(strId);
    }

    this.uiState.favoriteIds = [...this.favoriteIds];
    const saveRes = saveUiState(this.uiState);
    if (!saveRes.persisted) {
      this.showToast('브라우저 저장소 제한으로 이번 방문 동안만 즐겨찾기가 유지됩니다.');
    } else {
      this.showToast(isNowFav ? '즐겨찾기에 추가했어요.' : '즐겨찾기에서 뺐어요.');
    }

    this.applyFilters(false);
  }

  /**
   * 후보 비교함 토글 (최대 3곳 - FR03, FR08)
   */
  toggleCompareCandidate(place) {
    const strId = String(place.id);
    const idx = this.state.compareIds.indexOf(strId);
    if (idx >= 0) {
      this.state.compareIds.splice(idx, 1);
      this.showToast(`'${place.name}' 식당을 비교함에서 뺐어요.`);
    } else {
      if (this.state.compareIds.length >= MAX_COMPARE_COUNT) {
        this.showToast(`후보 비교는 최대 ${MAX_COMPARE_COUNT}곳까지 담을 수 있어요.`);
        return;
      }
      this.state.compareIds.push(strId);
      this.showToast(`'${place.name}' 식당을 비교함에 담았어요 (${this.state.compareIds.length}/${MAX_COMPARE_COUNT}).`);
    }
    this.updateCompareBarUi();
    this.applyFilters(false);
  }

  updateCompareBarUi() {
    const btn = document.getElementById('open-compare-btn');
    if (!btn) return;
    const count = this.state.compareIds.length;
    btn.textContent = `⚖️ 후보 비교 (${count}/${MAX_COMPARE_COUNT})`;
    btn.classList.toggle('active', count > 0);
  }

  updatePersonalEventHeaderBadge() {
    const btn = document.getElementById('open-events-btn');
    if (!btn) return;
    btn.textContent = `📅 내 행사 (${this.personalEvents.length})`;
  }

  /**
   * 식당을 내 행사(PersonalEvent)의 끼니 후보로 담기(FR09)
   */
  async handleAddPlaceToActiveEvent(place) {
    if (this.personalEvents.length === 0) {
      const defaultEv = createNewPersonalEvent({
        title: `${place.city || '현장'} 단체식사 계획`,
        eventType: this.state.presetId || (this.state.mode === 'athlete' ? 'school_sports_club' : 'field_trip')
      });
      const saveRes = await this.storageManager.saveEvent(defaultEv, 0);
      if (saveRes.saved && saveRes.event) {
        this.personalEvents.push(saveRes.event);
        this.activeEventId = saveRes.event.id;
      } else {
        this.personalEvents.push(defaultEv);
        this.activeEventId = defaultEv.id;
      }
    }

    const activeEvent = this.personalEvents.find(e => e.id === this.activeEventId) || this.personalEvents[0];
    if (!activeEvent || !activeEvent.mealPlans?.length) return;

    const targetMeal = activeEvent.mealPlans[0];
    addCandidateToMealPlan(targetMeal, place, {
      datasetVersion: this.repository.activeDatasetVersion || '2026.10.1',
      sources: this.currentSources,
      selectAsPrimary: !targetMeal.selectedCandidateId
    });

    const saveRes = await this.storageManager.saveEvent(activeEvent, activeEvent.revision);
    if (saveRes.saved && saveRes.event) {
      const idx = this.personalEvents.findIndex(e => e.id === activeEvent.id);
      if (idx >= 0) this.personalEvents[idx] = saveRes.event;
      this.showToast(`'${place.name}' 식당을 [${activeEvent.title}] 후보에 저장했어요.`);
    } else if (saveRes.isTemporaryOnly) {
      this.showToast(saveRes.message);
    } else {
      this.showToast(`행사에 담았으나 저장 확인 필요: ${saveRes.message || ''}`);
    }
    this.updatePersonalEventHeaderBadge();
  }

  /**
   * 단일 식당 공유 링크 복사 / 공유 창 열기 (?restaurantId=<영구ID> 사용 - FR01)
   */
  async shareSinglePlace(place) {
    const shareRes = buildPublicShareUrl({
      restaurantId: String(place.id),
      region: place.regionCode || this.state.regionCode
    });
    if (!shareRes.valid) {
      this.showToast(shareRes.message);
      return;
    }
    const url = shareRes.url;
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${place.name} - 전국 맛집 지도`,
          text: `${place.city || ''} ${place.name} (${place.menu || '맛집'})`,
          url
        });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.showToast('식당 고유 ID 공유 링크를 복사했어요.');
    } catch {
      prompt('아래 링크를 복사해 공유하세요.', url);
    }
  }

  // ==========================================================================
  // 모달 공통 관리 (초점 이동·Escape 닫기·초점 복원 - Section 10, AC28)
  // ==========================================================================

  openModal(titleText, bodyNode, footerNodes = []) {
    this.closeModal();
    this.lastFocusedElement = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = 'ysk-modal-backdrop';
    backdrop.id = 'ysk-active-modal';

    const dialog = document.createElement('div');
    dialog.className = 'ysk-modal-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'ysk-modal-title');

    const head = document.createElement('div');
    head.className = 'ysk-modal-head';
    const h2 = document.createElement('h2');
    h2.id = 'ysk-modal-title';
    h2.textContent = titleText;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ysk-modal-close';
    closeBtn.setAttribute('aria-label', '모달 닫기');
    closeBtn.textContent = '✕ 닫기';
    closeBtn.addEventListener('click', () => this.closeModal());
    head.append(h2, closeBtn);

    const content = document.createElement('div');
    content.className = 'ysk-modal-content';
    content.appendChild(bodyNode);

    dialog.append(head, content);

    if (footerNodes.length > 0) {
      const foot = document.createElement('div');
      foot.className = 'ysk-modal-foot';
      footerNodes.forEach(n => foot.appendChild(n));
      dialog.appendChild(foot);
    }

    backdrop.appendChild(dialog);
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) this.closeModal();
    });

    this.modalKeyHandler = e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.closeModal();
      }
    };
    document.addEventListener('keydown', this.modalKeyHandler, true);
    document.body.appendChild(backdrop);
    closeBtn.focus();
  }

  closeModal() {
    const existing = document.getElementById('ysk-active-modal');
    if (existing) existing.remove();
    if (this.modalKeyHandler) {
      document.removeEventListener('keydown', this.modalKeyHandler, true);
      this.modalKeyHandler = null;
    }
    if (this.lastFocusedElement && typeof this.lastFocusedElement.focus === 'function' && document.contains(this.lastFocusedElement)) {
      this.lastFocusedElement.focus();
    }
  }

  openPlaceDetailModal(place) {
    const body = renderPlaceDetailContent(place, this.currentSources, this.getPlaceActionHandlers());
    const qrBtn = document.createElement('button');
    qrBtn.type = 'button';
    qrBtn.className = 'link sub';
    qrBtn.textContent = '📱 이 식당 공개 QR 보기';
    qrBtn.addEventListener('click', () => {
      const shareRes = buildPublicShareUrl({ restaurantId: place.id });
      if (shareRes.valid) {
        this.openPublicQrModal(shareRes.url, `${place.name} (${place.city || place.regionCode})`);
      }
    });

    const addEventBtn = document.createElement('button');
    addEventBtn.type = 'button';
    addEventBtn.className = 'link';
    addEventBtn.textContent = '📋 내 행사에 후보로 담기';
    addEventBtn.addEventListener('click', () => {
      this.handleAddPlaceToActiveEvent(place);
    });

    this.openModal(`${place.name} — 단체·상세 정보`, body, [qrBtn, addEventBtn]);
  }

  async openCandidateCompareModal(placesOverride = null) {
    let places = placesOverride;
    if (!places) {
      const resolved = await this.repository.resolveMultipleRestaurantsByIds(this.state.compareIds);
      places = resolved.filter(r => r.status === 'found' && r.restaurant).map(r => r.restaurant);
    }

    const body = renderCandidateComparisonContent(
      places,
      this.lastFilterResult?.criteria || {},
      {
        onRemoveCompare: id => {
          this.state.compareIds = this.state.compareIds.filter(cid => cid !== String(id));
          this.updateCompareBarUi();
          this.applyFilters(false);
          this.openCandidateCompareModal();
        },
        onAddToEvent: place => this.handleAddPlaceToActiveEvent(place)
      }
    );

    const shareCompareBtn = document.createElement('button');
    shareCompareBtn.type = 'button';
    shareCompareBtn.className = 'link sub';
    shareCompareBtn.textContent = '🔗 비교 후보 링크 복사';
    shareCompareBtn.addEventListener('click', async () => {
      const shareRes = buildPublicShareUrl({ restaurantIds: this.state.compareIds });
      if (!shareRes.valid) {
        this.downloadJsonFile('ysk-food-public-candidates.json', JSON.stringify(shareRes.fallbackCandidateExport, null, 2));
        this.showToast(shareRes.message);
        return;
      }
      try {
        await navigator.clipboard.writeText(shareRes.url);
        this.showToast('비교 후보 공개 링크를 복사했어요.');
      } catch {
        prompt('비교 후보 공개 링크:', shareRes.url);
      }
    });

    const qrCompareBtn = document.createElement('button');
    qrCompareBtn.type = 'button';
    qrCompareBtn.className = 'link sub';
    qrCompareBtn.textContent = '📱 비교 후보 QR 보기';
    qrCompareBtn.addEventListener('click', () => {
      const shareRes = buildPublicShareUrl({ restaurantIds: this.state.compareIds });
      if (shareRes.valid) {
        this.openPublicQrModal(shareRes.url, `후보 식당 ${this.state.compareIds.length}곳 비교`);
      }
    });

    this.openModal('⚖️ 후보 식당 비교 (최대 3곳)', body, [shareCompareBtn, qrCompareBtn]);
  }

  openAmbiguousLegacyPlaceModal(placeName, candidates = []) {
    const wrap = document.createElement('div');
    const p = document.createElement('p');
    p.textContent = `'${placeName}' 이름과 일치하는 식당 후보가 ${candidates.length}곳 있습니다. 지점·지역을 확인해 선택해 주세요.`;
    wrap.appendChild(p);

    const ul = document.createElement('ul');
    ul.className = 'detail-menu-list';
    for (const c of candidates) {
      const li = document.createElement('li');
      li.className = 'detail-menu-item';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link';
      btn.textContent = `${c.name} (${c.regionName || c.regionCode}) — ${c.address || c.id}`;
      btn.addEventListener('click', async () => {
        this.closeModal();
        const urlRes = buildPublicShareUrl({ restaurantId: c.id });
        if (urlRes.valid) {
          history.replaceState({ yskView: 'detail', restaurantId: c.id }, '', urlRes.url);
        }
        await this.applyRouteFromLocation({ isInitialLoad: false, fromPopstate: true });
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    this.openModal('공유 식당 지점 선택', wrap);
  }

  openPublicQrModal(url = APP_BASE, label = '전국 맛집 지도') {
    const box = document.createElement('div');
    box.style.textAlign = 'center';
    const nameP = document.createElement('p');
    nameP.style.fontWeight = '700';
    nameP.textContent = label;
    const svgWrap = document.createElement('div');
    svgWrap.innerHTML = buildPublicQrSvg(url, label);
    const urlP = document.createElement('p');
    urlP.style.wordBreak = 'break-all';
    urlP.style.fontFamily = 'monospace';
    urlP.textContent = url;
    const hint = document.createElement('p');
    hint.className = 'detail-sub-note';
    hint.textContent = '공개 식당 ID와 일반 검색 조건만 포함된 안전한 공개 QR입니다. (개인 행사 메모 미포함)';
    box.append(nameP, svgWrap, urlP, hint);
    this.openModal('📱 카메라로 찍어서 들어와요', box);
  }

  /**
   * 내 행사(PersonalEvent) 관리·견적·확인·인솔 인쇄·백업·공유 사본·오프라인 준비 모달(FR07, FR08, FR09)
   */
  async openPersonalEventsModal() {
    this.personalEvents = await this.storageManager.listEvents();
    const wrap = document.createElement('div');
    wrap.className = 'event-manager-wrap';

    // 상단 액션 바: 새 행사 만들기, 백업 내보내기, 백업/공유 파일 가져오기, 오프라인 준비
    const topBar = document.createElement('div');
    topBar.className = 'event-top-actions';

    const newEvBtn = document.createElement('button');
    newEvBtn.type = 'button';
    newEvBtn.className = 'link';
    newEvBtn.textContent = '➕ 새 행사 계획 만들기';
    newEvBtn.addEventListener('click', async () => {
      const ev = createNewPersonalEvent({
        title: `단체식사 계획 (${this.personalEvents.length + 1})`,
        eventType: this.state.presetId || (this.state.mode === 'athlete' ? 'training_camp' : 'field_trip')
      });
      const res = await this.storageManager.saveEvent(ev, 0);
      if (res.saved && res.event) {
        this.personalEvents.push(res.event);
        this.activeEventId = res.event.id;
      } else {
        this.personalEvents.push(ev);
        this.activeEventId = ev.id;
      }
      this.updatePersonalEventHeaderBadge();
      this.openPersonalEventsModal();
    });

    const backupBtn = document.createElement('button');
    backupBtn.type = 'button';
    backupBtn.className = 'link sub';
    backupBtn.textContent = '💾 전체 백업(JSON) 내보내기';
    backupBtn.addEventListener('click', async () => {
      const { serializedJson } = await this.storageManager.exportBackupEnvelope(this.uiState);
      this.downloadJsonFile(`ysk-food-backup-${new Date().toISOString().slice(0, 10)}.json`, serializedJson);
      this.showToast('복구용 전체 백업 JSON 파일을 내려받았어요.');
    });

    const importLabel = document.createElement('label');
    importLabel.className = 'link sub';
    importLabel.style.cursor = 'pointer';
    importLabel.textContent = '📂 백업·공유 사본 가져오기';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.hidden = true;
    fileInput.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const res = await this.storageManager.importEnvelope(text, { duplicatePolicy: 'separate_copy' });
      if (!res.imported) {
        alert(`가져오기 실패: ${(res.errors || [res.message]).join('\n')}`);
        return;
      }
      this.showToast(res.message || '가져오기를 완료했어요.');
      this.personalEvents = await this.storageManager.listEvents();
      this.updatePersonalEventHeaderBadge();
      this.openPersonalEventsModal();
    });
    importLabel.appendChild(fileInput);

    const offlineBtn = document.createElement('button');
    offlineBtn.type = 'button';
    offlineBtn.className = 'link sub';
    offlineBtn.textContent = '📶 오프라인 열람 준비 확인';
    offlineBtn.addEventListener('click', async () => {
      const activeEv = this.personalEvents.find(e => e.id === this.activeEventId) || null;
      const offRes = await verifyOfflineReadiness({
        storageManager: this.storageManager,
        eventToSave: activeEv
      });
      alert(`${offRes.message}\n\n${offRes.limitationsNotice || ''}`);
    });

    topBar.append(newEvBtn, backupBtn, importLabel, offlineBtn);
    wrap.appendChild(topBar);

    const syncNote = document.createElement('p');
    syncNote.className = 'detail-sub-note';
    syncNote.textContent = 'ℹ️ 개인 행사 자료는 현재 기기·브라우저(IndexedDB)에만 저장되며 계정 동기화나 자동 공개 게시가 되지 않습니다. 다른 기기로 옮기려면 백업 또는 공유 사본 파일을 내보내세요.';
    wrap.appendChild(syncNote);

    if (this.personalEvents.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '아직 만든 행사 계획이 없습니다. 위 [➕ 새 행사 계획 만들기]를 누르거나 식당 목록에서 [📋 행사에 담기]를 눌러 시작해 보세요.';
      wrap.appendChild(empty);
      this.openModal('📅 내 행사 식사 일정·견적 관리', wrap);
      return;
    }

    const activeEvent = this.personalEvents.find(e => e.id === this.activeEventId) || this.personalEvents[0];
    this.activeEventId = activeEvent.id;

    // 행사 선택 탭
    const evSelectRow = document.createElement('div');
    evSelectRow.className = 'event-tabs';
    for (const ev of this.personalEvents) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `filter-btn${ev.id === activeEvent.id ? ' active' : ''}`;
      b.textContent = `${ev.title} (rev.${ev.revision})`;
      b.addEventListener('click', () => {
        this.activeEventId = ev.id;
        this.openPersonalEventsModal();
      });
      evSelectRow.appendChild(b);
    }
    wrap.appendChild(evSelectRow);

    // 현재 행사의 끼니 목록 및 상태 표시
    for (const mp of activeEvent.mealPlans || []) {
      const card = document.createElement('div');
      card.className = 'meal-plan-card';

      const statusEval = evaluateMealPlanStatus(mp);
      const costEval = evaluateMealPlanCost(mp);
      const selectedCand = (mp.candidateRecords || []).find(c => c.id === mp.selectedCandidateId);

      // 공용 데이터 변경 여부 대조(AC20)
      let publicDiffBanner = null;
      if (selectedCand?.restaurantSnapshot) {
        const currentPub = this.currentRestaurants.find(r => r.id === selectedCand.restaurantId);
        const diffCheck = detectPublicDataChangesAgainstSnapshot(
          selectedCand.restaurantSnapshot,
          currentPub ? { status: 'found', restaurant: currentPub } : { status: 'not_in_region' }
        );
        if (diffCheck.hasDiff) {
          publicDiffBanner = document.createElement('div');
          publicDiffBanner.className = 'detail-notice';
          publicDiffBanner.textContent = `⚠️ ${diffCheck.message} (${diffCheck.diffs.join(' / ')})`;
        }
      }

      const head = document.createElement('div');
      head.className = 'meal-card-head';
      head.textContent = `${mp.date} · ${mp.label || mp.mealSlot} (${(mp.plannedStart || '').slice(11, 16)}~${(mp.plannedEnd || '').slice(11, 16)}) — 상태: ${statusEval.statusLabel} · ${costEval.displayLabel}`;
      card.appendChild(head);
      if (publicDiffBanner) card.appendChild(publicDiffBanner);

      const candInfo = document.createElement('p');
      candInfo.className = 'detail-sub';
      candInfo.textContent = mp.providerType === 'lodging'
        ? `제공 방식: 숙소 제공 식사 (${mp.lodgingSnapshot?.name || '숙소'})`
        : selectedCand
          ? `선택 식당: ${selectedCand.restaurantSnapshot?.name || selectedCand.restaurantId} (후보 총 ${(mp.candidateRecords || []).length}곳)`
          : '아직 선택된 식당 후보가 없습니다. 지도·목록에서 식당을 담아 주세요.';
      card.appendChild(candInfo);

      const actionRow = document.createElement('div');
      actionRow.className = 'place-links';

      // 문의 문구 복사(FR07)
      const copyInqBtn = document.createElement('button');
      copyInqBtn.type = 'button';
      copyInqBtn.className = 'link sub';
      copyInqBtn.textContent = '📋 식당 문의 문구 복사';
      copyInqBtn.addEventListener('click', async () => {
        const text = generateRestaurantInquiryText({
          eventTitle: activeEvent.title,
          date: mp.date,
          startTime: (mp.plannedStart || '').slice(11, 16),
          endTime: (mp.plannedEnd || '').slice(11, 16),
          diners: mp.diners,
          orderLines: selectedCand?.orderDraft?.orderLines || [],
          busCount: mp.busCount
        });
        try {
          await navigator.clipboard.writeText(text);
          this.showToast('식당 문의 문구를 복사했어요.');
        } catch {
          prompt('식당 문의 문구:', text);
        }
      });

      // 예약 확정 기록 버튼
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'link sub';
      confirmBtn.textContent = '✅ 예약 확정 기록';
      confirmBtn.addEventListener('click', async () => {
        const recRes = recordMealConfirmation(mp, { kind: 'reservation', quoteId: null, method: 'phone' });
        if (!recRes.recorded) {
          alert(recRes.message);
          return;
        }
        const saveRes = await this.storageManager.saveEvent(activeEvent, activeEvent.revision);
        if (saveRes.saved && saveRes.event) {
          const idx = this.personalEvents.findIndex(e => e.id === activeEvent.id);
          if (idx >= 0) this.personalEvents[idx] = saveRes.event;
        }
        this.openPersonalEventsModal();
      });

      // 다음 날짜로 끼니 복사(FR07)
      const copyDayBtn = document.createElement('button');
      copyDayBtn.type = 'button';
      copyDayBtn.className = 'link sub';
      copyDayBtn.textContent = '📆 다음 날로 식단·인원 복사';
      copyDayBtn.addEventListener('click', async () => {
        const nextDate = `${mp.date.slice(0, 8)}${String(Math.min(28, Number(mp.date.slice(8, 10)) + 1)).padStart(2, '0')}`;
        const copiedMeal = copyMealPlanToDate(mp, nextDate);
        activeEvent.mealPlans.push(copiedMeal);
        if (!activeEvent.dates.includes(nextDate)) activeEvent.dates.push(nextDate);
        const saveRes = await this.storageManager.saveEvent(activeEvent, activeEvent.revision);
        if (saveRes.saved && saveRes.event) {
          const idx = this.personalEvents.findIndex(e => e.id === activeEvent.id);
          if (idx >= 0) this.personalEvents[idx] = saveRes.event;
        }
        this.showToast(`${nextDate} 날짜로 식단·인원을 복사했어요 (예약 확인 상태는 미확인으로 분리됨).`);
        this.openPersonalEventsModal();
      });

      actionRow.append(copyInqBtn, confirmBtn, copyDayBtn);
      card.appendChild(actionRow);
      wrap.appendChild(card);
    }

    // 하단 버튼: 공유용 사본 내보내기(내부 메모 기본 제외 미리보기 - AC23, AC55), 인솔용 인쇄 화면(AC28)
    const shareCopyBtn = document.createElement('button');
    shareCopyBtn.type = 'button';
    shareCopyBtn.className = 'link sub';
    shareCopyBtn.textContent = '📤 공유용 사본 내보내기 (내부 메모 제외 미리보기)';
    shareCopyBtn.addEventListener('click', () => {
      const shareBuild = buildShareEnvelope(activeEvent, {
        includeSchedule: true,
        includeCandidates: true,
        includeOrderAndAmounts: true,
        includePublicContacts: true,
        includeQuoteHistory: false,
        includeConfirmationHistory: true,
        includeInternalMemos: false
      });
      if (!shareBuild.valid) {
        alert(shareBuild.errors.join('\n'));
        return;
      }
      this.downloadJsonFile(`ysk-food-share-${activeEvent.id}.json`, shareBuild.serializedJson);
      this.showToast('내부 메모를 제외한 공유용 사본 JSON을 내보냈어요.');
    });

    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.className = 'link';
    printBtn.textContent = '🖨️ 인솔용 일정표 인쇄 / PDF 저장';
    printBtn.addEventListener('click', () => {
      this.triggerTeacherPrintView(activeEvent);
    });

    this.openModal('📅 내 행사 식사 일정·견적 관리', wrap, [shareCopyBtn, printBtn]);
  }

  triggerTeacherPrintView(personalEvent) {
    let printRoot = document.getElementById('teacher-print-root');
    if (!printRoot) {
      printRoot = document.createElement('section');
      printRoot.id = 'teacher-print-root';
      printRoot.className = 'print-only-section';
      document.body.appendChild(printRoot);
    }
    printRoot.innerHTML = '';
    printRoot.appendChild(buildTeacherPrintViewDom(personalEvent));
    window.print();
  }

  /**
   * 이용 기록 · 식당 제보 초안 작성 및 내보내기 모달(FR05, FR10, AC19, AC32)
   */
  openReportDraftModal() {
    const form = document.createElement('form');
    form.className = 'report-draft-form';
    form.innerHTML = `
      <p class="detail-sub-note">⚠️ 작성한 내용은 현재 브라우저에만 초안으로 저장되며, 공개 이용 건수에 즉시 합산되지 않습니다. 학생 이름·얼굴·연락처·개별 건강정보는 절대 입력하지 마세요.</p>
      <div class="form-row">
        <label>식당 이름 <input type="text" name="restaurantName" required placeholder="예: 이순신수제버거"></label>
      </div>
      <div class="form-row">
        <label>방문일 <input type="date" name="visitDate" value="2026-10-18"></label>
        <label>끼니 구분
          <select name="mealSlot">
            <option value="breakfast">조식</option>
            <option value="lunch" selected>중식</option>
            <option value="dinner">석식</option>
          </select>
        </label>
      </div>
      <div class="form-row">
        <label>단체 인원(명) <input type="number" name="groupSize" min="1" step="1" placeholder="예: 85"></label>
        <label>당시 1인 단가(원) <input type="number" name="unitPriceKRW" min="0" step="100" placeholder="예: 10000"></label>
      </div>
      <div class="form-row">
        <label>주문 메뉴 및 배식·버스 이용 메모 <input type="text" name="menuSummary" placeholder="예: 돈가스 정식, 버스 2대 하차 후 도보 3분"></label>
      </div>
      <div class="form-row">
        <label>참고 링크(선택, http/https만 허용) <input type="url" name="evidenceUrl" placeholder="https://place.map.kakao.com/..."></label>
      </div>
      <div class="form-row">
        <label><input type="checkbox" name="publicConsent" checked> 운영자 검토 후 익명 단체 이용 기록으로 공개하는 것에 동의합니다 (학교명은 기본 비공개)</label>
      </div>
      <div id="report-draft-status" class="detail-notice" hidden></div>
    `;

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'link';
    exportBtn.textContent = '📥 초안 저장 및 제보 JSON 파일 내보내기';
    exportBtn.addEventListener('click', async () => {
      const fd = new FormData(form);
      const draftRes = buildVerifiedReportDraft({
        type: 'visit_record',
        restaurantId: this.state.selectedId || 'unlinked-place',
        restaurantName: fd.get('restaurantName'),
        visitDate: fd.get('visitDate'),
        mealSlot: fd.get('mealSlot'),
        groupSize: fd.get('groupSize'),
        unitPriceKRW: fd.get('unitPriceKRW'),
        menuSummary: fd.get('menuSummary'),
        evidenceUrl: fd.get('evidenceUrl'),
        publicConsent: fd.get('publicConsent') === 'on'
      });

      const statusBox = form.querySelector('#report-draft-status');
      statusBox.hidden = false;
      if (!draftRes.valid) {
        statusBox.textContent = `❌ 입력 오류: ${draftRes.errors.join(' / ')}`;
        return;
      }

      await this.storageManager.saveDraft({
        type: 'visit_record',
        payload: draftRes.publicPreview
      });
      statusBox.textContent = `✅ ${draftRes.statusLabel}`;
      this.downloadJsonFile(`ysk-food-report-draft-${Date.now()}.json`, draftRes.serializedJson);
    });

    this.openModal('✍️ 단체 이용 기록 · 식당 수정 제보 작성', form, [exportBtn]);
  }

  /**
   * 운영자용 데이터 검증·변환·비교 로컬 도구 모달(FR10, Section 4)
   */
  openOperatorDataToolModal() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <p class="detail-sub-note">🛠️ 운영자 로컬 검증 도구입니다. 구형·신규 CSV 또는 지역 JSON을 검증하고 기존 자료와의 변경점을 비교합니다. 오류 행이 있으면 정상 배포 자료를 덮어쓰지 않고 원인을 안내합니다. (공개 페이지에서 저장소 쓰기 권한을 수행하지 않습니다.)</p>
      <textarea id="op-tool-input" rows="7" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px" placeholder="CSV 내용(id,name,city,category,menu,lat,lng,link) 또는 지역 JSON을 붙여넣으세요."></textarea>
      <div id="op-tool-result" class="detail-notice" style="margin-top:10px;white-space:pre-wrap">검증할 데이터를 입력한 뒤 [검증 실행]을 눌러 주세요.</div>
    `;

    const validateBtn = document.createElement('button');
    validateBtn.type = 'button';
    validateBtn.className = 'link';
    validateBtn.textContent = '🔍 데이터 스키마·영구 ID 검증 실행';
    validateBtn.addEventListener('click', () => {
      const raw = wrap.querySelector('#op-tool-input').value.trim();
      const out = wrap.querySelector('#op-tool-result');
      if (!raw) {
        out.textContent = '데이터가 비어 있습니다.';
        return;
      }
      if (raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw);
          const vRes = validateRegionDataset(parsed);
          out.textContent = vRes.valid
            ? `✅ 지역 JSON 스키마 검증 통과! (지역: ${parsed.regionCode}, 식당: ${parsed.restaurants.length}곳)`
            : `❌ 스키마 검증 실패 (${vRes.errors.length}건):\n• ${vRes.errors.join('\n• ')}`;
        } catch (err) {
          out.textContent = `❌ JSON 파싱 오류: ${err.message}`;
        }
      } else {
        const bundle = this.repository.getActiveBundle();
        const csvRes = csvToPlaces(raw, {
          legacyAliases: bundle?.legacyAliases || null,
          regions: this.repository.getRegionsList()
        });
        out.textContent = csvRes.valid
          ? `✅ CSV 변환·검증 통과! (정상 식당 ${csvRes.places.length}곳)`
          : `⚠️ CSV 검증 오류 ${csvRes.errors.length}건 (정상 행 ${csvRes.places.length}곳 — 오류 해결 전 배포 중단):\n• ${csvRes.errors.map(e => e.message).join('\n• ')}`;
      }
    });

    this.openModal('🛠️ 데이터 관리 · 스키마 검증 도구', wrap, [validateBtn]);
  }

  downloadJsonFile(filename, content) {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  showCoordinateCheckReport() {
    const missing = this.currentRestaurants
      .filter(p => !isMappablePlace(p))
      .map(p => `${p.city || p.regionCode} ${p.name} (${p.id})`);
    this.showBannerAlert(
      `[점검 모드] 현재 선택 지역 내 좌표 미확인 식당: ${missing.length}곳 (목록에는 정상 보존되며 지도 마커에서만 제외됨)`,
      'info'
    );
  }

  // ==========================================================================
  // 정적 DOM 이벤트 및 필터/홈/모바일 뷰 전환 연결
  // ==========================================================================

  renderRegionSelector() {
    const selectEl = document.getElementById('region-select');
    if (!selectEl) return;
    const regions = this.repository.getRegionsList();
    selectEl.innerHTML = '';

    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = '전남 동부 (여수·순천·광양 166곳)';
    selectEl.appendChild(allOpt);

    for (const reg of regions) {
      const opt = document.createElement('option');
      opt.value = reg.regionCode;
      const count = reg.stats?.totalRestaurants ?? 0;
      opt.textContent = `${reg.sidoName || ''} ${reg.name} (${count}곳)`.trim();
      selectEl.appendChild(opt);
    }
    selectEl.value = this.state.regionCode;
  }

  renderReferencePointSelector() {
    const selectEl = document.getElementById('ref-point-select');
    if (!selectEl) return;
    selectEl.innerHTML = '<option value="">기준점 없음 (이름순)</option>';
    for (const v of this.currentVenues) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `📍 [${v.typeLabel || '시설'}] ${v.name}`;
      selectEl.appendChild(opt);
    }
  }

  renderCategoryButtons() {
    const group = document.getElementById('category-group');
    if (!group) return;
    const categories = [
      ...new Set(
        this.currentRestaurants.flatMap(p => (Array.isArray(p.categoryIds) ? p.categoryIds : [p.category])).filter(Boolean)
      )
    ].sort((a, b) => a.localeCompare(b, 'ko'));

    group.innerHTML = '';
    ['all', ...categories].forEach(cat => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isActive = cat === this.state.category;
      btn.className = `filter-btn category${isActive ? ' active' : ''}`;
      btn.dataset.category = cat;
      btn.setAttribute('aria-pressed', String(isActive));
      btn.textContent = cat === 'all' ? '전체 종류' : cat;
      btn.addEventListener('click', () => {
        this.state.category = cat;
        this.state.visibleLimit = PAGE_SIZE;
        this.renderCategoryButtons();
        this.applyFilters(true);
      });
      group.appendChild(btn);
    });
  }

  renderLegend() {
    const legend = document.getElementById('legend');
    if (!legend) return;
    legend.innerHTML = '';
    for (const [city, color] of [
      ['여수', REGION_COLORS['여수']],
      ['순천', REGION_COLORS['순천']],
      ['광양', REGION_COLORS['광양']]
    ]) {
      const span = document.createElement('span');
      span.style.setProperty('--c', color);
      span.textContent = city;
      legend.appendChild(span);
    }
  }

  renderHomeStats() {
    const byCity = {};
    this.currentRestaurants.forEach(p => {
      const key = p.city || p.regionCode;
      byCity[key] = (byCity[key] || 0) + 1;
    });

    document.querySelectorAll('[data-count-city]').forEach(t => {
      const city = t.dataset.countCity;
      t.textContent = `${city} · ${byCity[city] || 0}곳`;
    });

    const leadEl = document.getElementById('home-lead');
    if (leadEl) {
      leadEl.textContent = `전국 맛집 탐색과 학교행사·선수단 단체식사 준비를 한 곳에서. (여수·순천·광양 ${this.currentRestaurants.length}곳 기본 등록 · 출처·확인일·미확인 항목 투명 제공)`;
    }

    const openCount = this.currentRestaurants.filter(p => getOpenStatus(p) === true).length;
    const liveBtn = document.getElementById('home-live');
    const liveText = document.getElementById('home-live-text');
    if (liveText) liveText.textContent = `지금 영업 중 ${openCount}곳`;
    if (liveBtn) liveBtn.hidden = openCount === 0;

    const catsBox = document.getElementById('home-cats');
    if (catsBox) {
      catsBox.innerHTML = '';
      const HOME_CATS = [
        ['게장', '🦀'], ['해산물', '🐟'], ['국밥·탕', '🍲'], ['고기', '🥩'],
        ['한정식', '🍱'], ['백반·한식', '🍚'], ['닭요리', '🍗'], ['카페·디저트', '☕']
      ];
      HOME_CATS.forEach(([cat, icon]) => {
        const n = this.currentRestaurants.filter(p => p.category === cat).length;
        if (!n) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'home-cat';
        const iconB = document.createElement('b');
        iconB.setAttribute('aria-hidden', 'true');
        iconB.textContent = icon;
        const labelText = document.createTextNode(cat.replace('·디저트', ''));
        const countSpan = document.createElement('span');
        countSpan.textContent = `${n}곳`;
        btn.append(iconB, labelText, countSpan);
        btn.addEventListener('click', () => this.openMapFromHome({ category: cat }));
        catsBox.appendChild(btn);
      });
    }
  }

  async openMapFromHome({ regionCode, city, category, query, openOnly, mode, presetId } = {}) {
    const cityMap = { '여수': 'jn-yeosu', '순천': 'jn-suncheon', '광양': 'jn-gwangyang' };
    if (mode) this.state.mode = mode;
    if (presetId) this.applyPresetSettings(presetId);

    const nextRegion = regionCode || (city && cityMap[city]) || this.state.regionCode || 'all';
    this.state.regionCode = nextRegion;
    this.state.category = category || 'all';
    this.state.query = query || '';
    this.state.openOnly = Boolean(openOnly);
    this.state.favOnly = false;
    this.state.visibleLimit = PAGE_SIZE;

    this.syncFilterControlsFromState();
    await this.loadSelectedRegionData(this.state.regionCode);
    this.applyFilters(true);

    const homeEl = document.getElementById('home');
    if (homeEl) homeEl.hidden = true;

    const urlRes = buildPublicShareUrl({
      region: this.state.regionCode,
      mode: this.state.mode,
      q: this.state.query,
      category: this.state.category,
      open: this.state.openOnly
    });
    if (urlRes.valid) {
      history.pushState({ yskView: 'map' }, '', urlRes.url);
    }
    this.mapController.relayout();
  }

  applyPresetSettings(presetId) {
    const preset = EVENT_PRESETS[presetId];
    if (!preset) return;
    this.state.presetId = presetId;
    this.state.mode = preset.mode;
    // 사용자가 이미 입력한 인원·예산은 덮어쓰지 않고 좌석 기본 정책만 안내에 맞게 설정(FR02)
    this.state.groupCriteria.seatingPolicy = preset.seatingPolicy;
    const guideEl = document.getElementById('preset-guide-note');
    if (guideEl) {
      guideEl.hidden = false;
      guideEl.textContent = `💡 [${preset.label}] ${preset.guideText}`;
    }
  }

  syncFilterControlsFromState() {
    const searchInput = document.getElementById('search');
    if (searchInput) searchInput.value = this.state.query;

    const regionSelect = document.getElementById('region-select');
    if (regionSelect) regionSelect.value = this.state.regionCode;

    document.querySelectorAll('.filter-btn[data-region]').forEach(btn => {
      const active = btn.dataset.region === this.state.regionCode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    document.querySelectorAll('.mode-tab[data-mode]').forEach(btn => {
      const active = btn.dataset.mode === this.state.mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    const groupBar = document.getElementById('group-criteria-bar');
    if (groupBar) {
      groupBar.hidden = this.state.mode === 'general';
    }

    const favBtn = document.getElementById('fav-filter');
    if (favBtn) {
      favBtn.classList.toggle('active', this.state.favOnly);
      favBtn.setAttribute('aria-pressed', String(this.state.favOnly));
    }

    const openBtn = document.getElementById('open-filter');
    if (openBtn) {
      openBtn.classList.toggle('active', this.state.openOnly);
      openBtn.setAttribute('aria-pressed', String(this.state.openOnly));
    }
  }

  setPanelMode(mode) {
    if (this.panelMode === mode) return;
    this.panelMode = mode;
    const panel = document.getElementById('panel');
    if (panel) {
      panel.classList.toggle('mode-map', mode === 'map');
      panel.classList.toggle('mode-list', mode === 'list');
    }
    document.querySelectorAll('.view-switch button').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
    });
  }

  bindStaticDomEvents() {
    // 1) 검색 입력 (짧은 디바운스 적용 - Section 9)
    const searchInput = document.getElementById('search');
    if (searchInput) {
      searchInput.addEventListener('input', e => {
        this.state.query = e.target.value;
        this.state.visibleLimit = PAGE_SIZE;
        clearTimeout(this.searchDebounceTimer);
        this.searchDebounceTimer = setTimeout(() => this.applyFilters(true), 220);
      });
    }

    // 2) 이용 모드 전환 (일반 맛집 / 학교 단체식사 / 선수단 식사 - 모드 전환 시 선택 지역·검색어·담아둔 식당 유지 - FR01)
    document.querySelectorAll('.mode-tab[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.state.mode = btn.dataset.mode;
        this.syncFilterControlsFromState();
        this.applyFilters(false);
      });
    });

    // 3) 행사 프리셋 선택(FR02)
    const presetSelect = document.getElementById('event-preset-select');
    if (presetSelect) {
      presetSelect.addEventListener('change', e => {
        if (e.target.value) {
          this.applyPresetSettings(e.target.value);
          this.syncFilterControlsFromState();
          this.applyFilters(false);
        }
      });
    }

    // 4) 전국 지역 드롭다운 및 빠른 지역 버튼(FR01)
    const regionSelect = document.getElementById('region-select');
    if (regionSelect) {
      regionSelect.addEventListener('change', async e => {
        this.state.regionCode = e.target.value;
        this.state.visibleLimit = PAGE_SIZE;
        this.syncFilterControlsFromState();
        await this.loadSelectedRegionData(this.state.regionCode);
        this.applyFilters(true);
      });
    }

    document.querySelectorAll('.filter-btn[data-region]').forEach(btn => {
      btn.addEventListener('click', async () => {
        this.state.regionCode = btn.dataset.region;
        this.state.visibleLimit = PAGE_SIZE;
        this.syncFilterControlsFromState();
        await this.loadSelectedRegionData(this.state.regionCode);
        this.applyFilters(true);
      });
    });

    // 5) 단체 조건 입력 바 이벤트 연결(FR03)
    const bindCriteriaInput = (id, key, isCheckbox = false) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener(isCheckbox ? 'change' : 'input', () => {
        this.state.groupCriteria[key] = isCheckbox ? el.checked : el.value;
        this.state.visibleLimit = PAGE_SIZE;
        this.applyFilters(false);
      });
    };
    bindCriteriaInput('gc-students', 'studentCount');
    bindCriteriaInput('gc-staff', 'staffCount');
    bindCriteriaInput('gc-budget', 'budgetPerPersonKRW');
    bindCriteriaInput('gc-buses', 'busCount');
    bindCriteriaInput('gc-seating-policy', 'seatingPolicy');
    bindCriteriaInput('gc-visit-date', 'visitDate');
    bindCriteriaInput('gc-start-time', 'startTime');
    bindCriteriaInput('gc-end-time', 'endTime');
    bindCriteriaInput('gc-bus-parking', 'busParkingRequired', true);
    bindCriteriaInput('gc-early-breakfast', 'earlyBreakfastRequired', true);
    bindCriteriaInput('gc-lunchbox', 'lunchboxRequired', true);

    const resetCriteriaBtn = document.getElementById('gc-reset-btn');
    if (resetCriteriaBtn) {
      resetCriteriaBtn.addEventListener('click', () => {
        Object.assign(this.state.groupCriteria, {
          studentCount: '',
          staffCount: '',
          otherCount: '',
          budgetPerPersonKRW: '',
          busCount: '',
          busParkingRequired: false,
          seatingPolicy: 'simultaneous_required',
          visitDate: '',
          startTime: '',
          endTime: '',
          endNextDay: false,
          privateRoomRequired: false,
          earlyBreakfastRequired: false,
          lunchboxRequired: false
        });
        ['gc-students', 'gc-staff', 'gc-budget', 'gc-buses', 'gc-visit-date', 'gc-start-time', 'gc-end-time'].forEach(id => {
          const input = document.getElementById(id);
          if (input) input.value = '';
        });
        ['gc-bus-parking', 'gc-early-breakfast', 'gc-lunchbox'].forEach(id => {
          const chk = document.getElementById(id);
          if (chk) chk.checked = false;
        });
        this.applyFilters(false);
      });
    }

    // 6) 기준점(체험처·경기장·숙소) 선택(FR04)
    const refSelect = document.getElementById('ref-point-select');
    if (refSelect) {
      refSelect.addEventListener('change', e => {
        const venueId = e.target.value;
        if (!venueId) {
          this.state.referencePoint = null;
          this.mapController.setReferencePointMarker(null);
          this.applyFilters(false);
          return;
        }
        const venue = this.currentVenues.find(v => v.id === venueId);
        if (venue && venue.location && isValidCoordinate(venue.location.lat, venue.location.lng)) {
          this.state.referencePoint = {
            lat: venue.location.lat,
            lng: venue.location.lng,
            label: venue.name,
            type: venue.type
          };
          this.mapController.setReferencePointMarker(this.state.referencePoint);
          this.applyFilters(false);
          this.showToast(`'${venue.name}' 기준 직선거리 순으로 정렬했어요.`);
        }
      });
    }

    // 7) 즐겨찾기 / 영업 중 토글
    [['fav-filter', 'favOnly'], ['open-filter', 'openOnly']].forEach(([id, key]) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', () => {
        this.state[key] = !this.state[key];
        btn.classList.toggle('active', this.state[key]);
        btn.setAttribute('aria-pressed', String(this.state[key]));
        this.applyFilters(true);
      });
    });

    // 8) 모바일 보기 전환(지도 / 반반 / 목록)
    document.querySelectorAll('.view-switch button').forEach(btn => {
      btn.addEventListener('click', () => this.setPanelMode(btn.dataset.mode));
    });
    const panelEl = document.getElementById('panel');
    if (panelEl) {
      panelEl.addEventListener('transitionend', e => {
        if (e.propertyName === 'height') this.mapController.relayout();
      });
    }
    window.addEventListener('resize', () => this.mapController.relayout());

    // 9) 내 주변 위치 버튼
    const locateBtn = document.getElementById('locate-btn');
    if (locateBtn) {
      locateBtn.addEventListener('click', () => this.locateCurrentPosition(locateBtn));
    }

    // 10) 상단·하단 기능 모달 버튼 연결 (중복 리스너 없음)
    document.getElementById('open-compare-btn')?.addEventListener('click', () => this.openCandidateCompareModal());
    document.getElementById('open-events-btn')?.addEventListener('click', () => this.openPersonalEventsModal());
    document.getElementById('open-report-btn')?.addEventListener('click', () => this.openReportDraftModal());
    document.getElementById('open-op-tool-btn')?.addEventListener('click', () => this.openOperatorDataToolModal());

    document.addEventListener('click', e => {
      const qrBtn = e.target.closest?.('[data-qr]');
      if (qrBtn) {
        e.preventDefault();
        this.openPublicQrModal(APP_BASE, '전국 맛집 지도');
      }
    });

    // 11) 첫 화면(홈) 상호작용 및 popstate 단일 라우터 연결(AC36)
    document.querySelectorAll('[data-home-open]').forEach(b => {
      b.addEventListener('click', () => this.openMapFromHome({ mode: b.dataset.homeMode || undefined, presetId: b.dataset.homePreset || undefined }));
    });
    document.getElementById('home-live')?.addEventListener('click', () => this.openMapFromHome({ openOnly: true }));
    document.querySelectorAll('.home-pick').forEach(b => {
      b.addEventListener('click', () => this.openMapFromHome({ query: b.dataset.query }));
    });
    document.querySelectorAll('.city-pin').forEach(pin => {
      const go = () => this.openMapFromHome({ city: pin.dataset.city });
      pin.addEventListener('click', go);
      pin.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      });
    });
    document.getElementById('home-search')?.addEventListener('submit', e => {
      e.preventDefault();
      const q = document.getElementById('home-search-input')?.value.trim() || '';
      this.openMapFromHome({ query: q });
    });

    document.querySelector('header h1')?.addEventListener('click', () => {
      const homeEl = document.getElementById('home');
      if (homeEl) {
        this.renderHomeStats();
        homeEl.hidden = false;
        homeEl.scrollTop = 0;
        history.pushState({ yskView: 'home' }, '', APP_BASE);
      }
    });

    // 뒤로·앞으로 가기(popstate) 시 새 이력을 추가하지 않고 동일 라우터로 상태 복원(Section 9, AC36)
    window.addEventListener('popstate', () => {
      this.applyRouteFromLocation({ isInitialLoad: false, fromPopstate: true });
    });
  }

  locateCurrentPosition(btn) {
    if (!navigator.geolocation) {
      this.showToast('이 브라우저는 위치 기능을 지원하지 않아요. 지역·시설 기준점 선택을 이용해 주세요.');
      return;
    }
    btn.disabled = true;
    btn.textContent = '📍 찾는 중…';
    navigator.geolocation.getCurrentPosition(
      pos => {
        btn.disabled = false;
        btn.textContent = '📍 내 주변';
        this.state.referencePoint = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          label: '내 현재 위치',
          type: 'my_pos'
        };
        this.mapController.setReferencePointMarker(this.state.referencePoint);
        this.applyFilters(false);
        this.showToast('내 현재 위치 기준 직선거리 순으로 정렬했어요.');
      },
      err => {
        btn.disabled = false;
        btn.textContent = '📍 내 주변';
        this.showToast(
          err.code === err.PERMISSION_DENIED
            ? '위치 권한이 거부되었어요. 상단에서 지역이나 행사 시설(체험처·경기장·숙소) 기준점을 선택해 검색할 수 있어요.'
            : '현재 위치를 찾지 못했어요.'
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  setupMinuteOpenBadgeRefresh() {
    // 분 단위 및 화면 복귀 시 현재 영업 배지 갱신(PRD 6절)
    setInterval(() => {
      if (!document.hidden && this.lastFilterResult) {
        this.applyFilters(false);
      }
    }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.lastFilterResult) {
        this.applyFilters(false);
      }
    });
  }

  /**
   * 서비스 워커 등록 및 열린 편집 탭 버전 보존·대기 워커 승인 협업(Section 9, AC41)
   */
  registerServiceWorkerWithVersionGuard() {
    if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

    const swUrl = resolveAppUrl('sw.js', APP_BASE);
    navigator.serviceWorker
      .register(swUrl)
      .then(reg => {
        const notifyVersionStatus = worker => {
          worker?.postMessage({
            type: 'YSK_CLIENT_STATUS',
            appVersion: APP_VERSION,
            hasUnsavedEdits: Boolean(this.state.hasUnsavedEventEdits)
          });
        };

        if (reg.active) notifyVersionStatus(reg.active);
        if (reg.waiting) this.promptServiceWorkerUpdate(reg.waiting);

        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              this.promptServiceWorkerUpdate(installing);
            }
          });
        });
      })
      .catch(() => {
        // 오프라인/서비스워커 미지원 시 무시
      });

    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'YSK_QUERY_CLIENT_VERSION') {
        event.source?.postMessage({
          type: 'YSK_CLIENT_STATUS',
          appVersion: APP_VERSION,
          hasUnsavedEdits: Boolean(this.state.hasUnsavedEventEdits)
        });
      }
    });
  }

  promptServiceWorkerUpdate(waitingWorker) {
    this.waitingServiceWorker = waitingWorker;
    const banner = document.getElementById('sw-update-banner');
    if (!banner) return;
    banner.hidden = false;
    const applyBtn = banner.querySelector('[data-sw-apply]');
    if (applyBtn) {
      applyBtn.onclick = () => {
        if (this.state.hasUnsavedEventEdits) {
          this.showToast('편집 중인 행사 내용을 먼저 저장한 뒤 새 버전을 적용해 주세요.');
          return;
        }
        waitingWorker.postMessage({ type: 'YSK_APPROVE_ACTIVATE', appVersion: APP_VERSION });
        banner.hidden = true;
      };
    }
  }

  showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }
}

// DOM 준비 상태를 확인해 단 한 번만 초기화 실행(Section 9)
if (typeof document !== 'undefined') {
  const start = () => {
    const app = new YskFoodApp();
    window.__yskFoodApp = app;
    app.init();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}
