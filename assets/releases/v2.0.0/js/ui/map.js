// 비차단 Kakao Maps SDK 로더(타임아웃·재시도·중복 방지 - AC38), mappablePlaces 공통 좌표 검증(0/1/다수 범위 - AC37), 시·군·구/지점명 주소 매칭(AC05), 지연 상세 오버레이 생성
import {
  CLUSTER_MIN_LEVEL,
  DEFAULT_CENTER,
  DEFAULT_LEVEL,
  DEFAULT_MARKER_COLOR,
  KAKAO_SDK_TIMEOUT_MS,
  KAKAO_SDK_URL,
  MY_POS_LEVEL,
  REGION_COLORS,
  SINGLE_PLACE_LEVEL
} from '../config.js';
import { getPlaceCoords, isMappablePlace, isValidCoordinate } from '../data/normalize.js';

/**
 * 전달된 장소 배열에서 위치가 검증되었고 위도·경도가 유효 범위 내 유한 숫자인 항목만 추출한다(Section 9, AC37).
 * null, undefined, '', 0, NaN, status='unverified'는 모두 제외된다.
 */
export function filterMappablePlaces(places = []) {
  if (!Array.isArray(places)) return [];
  return places.filter(p => isMappablePlace(p));
}

/**
 * 표시할 식당 목록의 유효 좌표 개수(0개 / 1개 / 다수)에 따른 지도 범위 조정 계획을 계산한다(Section 9, AC37).
 * - 유효 좌표 0개: 빈 LatLngBounds를 만들지 않고 선택 지역의 기본 중심·레벨을 유지한다.
 * - 유효 좌표 1개: 단일 장소 확대 레벨(SINGLE_PLACE_LEVEL)과 해당 좌표를 사용한다.
 * - 유효 좌표 2개 이상: 유효 좌표들로만 구성된 bounds 범위를 사용한다.
 */
export function computeFitBoundsPlan(places = [], regionMeta = null) {
  const mappable = filterMappablePlaces(places);
  const fallbackCenter = regionMeta?.center && isValidCoordinate(regionMeta.center.lat, regionMeta.center.lng)
    ? { lat: regionMeta.center.lat, lng: regionMeta.center.lng, level: regionMeta.center.zoomLevel || DEFAULT_LEVEL }
    : { lat: DEFAULT_CENTER.lat, lng: DEFAULT_CENTER.lng, level: DEFAULT_LEVEL };

  if (mappable.length === 0) {
    return {
      mode: 'region_default',
      validCount: 0,
      center: { lat: fallbackCenter.lat, lng: fallbackCenter.lng },
      level: fallbackCenter.level,
      coordinates: []
    };
  }

  const coords = mappable.map(p => getPlaceCoords(p)).filter(Boolean);
  if (coords.length === 1) {
    return {
      mode: 'single',
      validCount: 1,
      center: { lat: coords[0].lat, lng: coords[0].lng },
      level: SINGLE_PLACE_LEVEL,
      coordinates: coords
    };
  }

  return {
    mode: 'bounds',
    validCount: coords.length,
    center: null,
    level: null,
    coordinates: coords
  };
}

/**
 * 카카오맵 길찾기 URL 생성 (mappablePlaces 검사를 동일하게 적용 - Section 9, AC37)
 */
export function buildKakaoRouteUrl(place) {
  const coords = getPlaceCoords(place);
  const name = String(place?.name || '').trim();
  const regionName = String(place?.city || place?.regionCode || '').trim();
  if (coords) {
    return `https://map.kakao.com/link/to/${encodeURIComponent(name)},${coords.lat},${coords.lng}`;
  }
  const query = [regionName, name, place?.branchName].filter(Boolean).join(' ');
  return `https://map.kakao.com/link/search/${encodeURIComponent(query)}`;
}

const normalizeCompact = s => String(s || '').replace(/\s+/g, '').toLowerCase();

/**
 * 시·군·구, 광역시 구, 특별자치도, 지점명, 외부 장소 ID를 모두 고려한 장소 검색 결과 대조(Section 2, AC05)
 * 기존 `city + '시'` 하드코딩 가정을 제거한다.
 */
export function matchKakaoSearchResult(place, candidates = [], regionMeta = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  // 1) 외부 카카오 장소 ID가 이미 등록되어 있으면 ID 일치 최우선
  const knownKakaoId = place?.mapLinks?.kakaoPlaceId;
  if (knownKakaoId) {
    const exactIdHit = candidates.find(d => String(d.id) === String(knownKakaoId));
    if (exactIdHit && isValidCoordinate(Number(exactIdHit.y), Number(exactIdHit.x))) {
      return {
        lat: Number(exactIdHit.y),
        lng: Number(exactIdHit.x),
        link: String(exactIdHit.place_url || '').replace(/^http:/, 'https:'),
        phone: exactIdHit.phone || null,
        address: exactIdHit.road_address_name || exactIdHit.address_name || null,
        matchedBy: 'kakao_place_id'
      };
    }
  }

  // 2) 시·군·구·특별자치 지역 별칭 토큰 구성 (city + '시' 가정 제거!)
  const regionTokens = new Set();
  if (regionMeta) {
    if (regionMeta.name) regionTokens.add(regionMeta.name);
    if (regionMeta.shortName) regionTokens.add(regionMeta.shortName);
    if (regionMeta.sidoName) regionTokens.add(regionMeta.sidoName);
    for (const alias of regionMeta.aliases || []) {
      regionTokens.add(alias);
    }
  }
  if (place?.city) regionTokens.add(place.city);

  const validCategoryCandidates = candidates.filter(d => {
    const addr = `${d.address_name || ''} ${d.road_address_name || ''}`;
    const regionMatched = regionTokens.size === 0 || Array.from(regionTokens).some(tok => addr.includes(tok));
    const catMatched = !d.category_group_code || d.category_group_code === 'FD6' || d.category_group_code === 'CE7';
    return regionMatched && catMatched;
  });

  const wantName = normalizeCompact(place?.name);
  const wantBranch = normalizeCompact(place?.branchName);

  // 지점명이 있는 경우 이름+지점명 일치 우선
  let hit = validCategoryCandidates.find(d => {
    const got = normalizeCompact(d.place_name);
    if (got === wantName) return true;
    if (wantBranch && got.includes(wantName) && got.includes(wantBranch)) return true;
    return false;
  });

  if (!hit && wantName.length > 2) {
    hit = validCategoryCandidates.find(d => {
      const got = normalizeCompact(d.place_name);
      if (wantBranch && !got.includes(wantBranch)) return false;
      return got.includes(wantName) || wantName.includes(got);
    });
  }

  if (!hit) return null;
  const lat = Number(hit.y);
  const lng = Number(hit.x);
  if (!isValidCoordinate(lat, lng)) return null;

  return {
    lat,
    lng,
    link: String(hit.place_url || '').replace(/^http:/, 'https:'),
    phone: hit.phone || null,
    address: hit.road_address_name || hit.address_name || null,
    matchedBy: 'region_and_name'
  };
}

/**
 * 지도 컨트롤러 (비차단 SDK 로드, 타임아웃·재시도, 중복 지도/리스너 방지, 지연 오버레이 생성)
 */
export class MapController {
  constructor(options = {}) {
    this.container = options.container || null;
    this.onSelectPlace = options.onSelectPlace || (() => {});
    this.onCloseOverlay = options.onCloseOverlay || (() => {});
    this.createOverlayDom = options.createOverlayDom || (() => document.createElement('div'));
    this.sdkUrl = options.sdkUrl || KAKAO_SDK_URL;
    this.sdkTimeoutMs = options.sdkTimeoutMs || KAKAO_SDK_TIMEOUT_MS;

    this.map = null;
    this.clusterer = null;
    this.entries = new Map(); // stringId -> { place, marker, overlay, content }
    this.currentOverlay = null;
    this.referenceOverlay = null;
    this.markerImageCache = new Map();

    this.sdkState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
    this.sdkPromise = null;
    this.mapClickListenerBound = false;
  }

  isReady() {
    return Boolean(this.map && globalThis.kakao?.maps?.LatLng);
  }

  /**
   * 비차단 Kakao SDK 로더(타임아웃·재시도 지원, 중복 스크립트 및 중복 초기화 방지 - AC38)
   */
  loadSdk({ forceRetry = false } = {}) {
    if (globalThis.kakao?.maps?.LatLng) {
      this.sdkState = 'ready';
      return Promise.resolve({ ready: true });
    }

    if (this.sdkPromise && !forceRetry) {
      return this.sdkPromise;
    }

    this.sdkState = 'loading';
    this.sdkPromise = new Promise((resolve) => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!result.ready) {
          this.sdkState = 'error';
          this.sdkPromise = null;
        } else {
          this.sdkState = 'ready';
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ ready: false, reason: 'TIMEOUT', message: '지도 SDK 응답 시간이 초과되었습니다.' });
      }, this.sdkTimeoutMs);

      const activateKakaoMaps = () => {
        if (globalThis.kakao?.maps?.LatLng) {
          finish({ ready: true });
          return;
        }
        if (globalThis.kakao?.maps?.load) {
          try {
            globalThis.kakao.maps.load(() => {
              finish({ ready: Boolean(globalThis.kakao?.maps?.LatLng) });
            });
          } catch (err) {
            finish({ ready: false, reason: 'LOAD_EXCEPTION', error: err });
          }
          return;
        }
        finish({ ready: false, reason: 'KAKAO_UNDEFINED' });
      };

      if (globalThis.kakao?.maps) {
        activateKakaoMaps();
        return;
      }

      if (typeof document === 'undefined') {
        finish({ ready: false, reason: 'NO_DOCUMENT' });
        return;
      }

      const existingScript = document.querySelector('script[data-ysk-kakao-sdk]');
      if (existingScript && forceRetry) {
        existingScript.remove();
      } else if (existingScript && !forceRetry) {
        existingScript.addEventListener('load', activateKakaoMaps, { once: true });
        existingScript.addEventListener('error', () => finish({ ready: false, reason: 'SCRIPT_ERROR' }), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.async = true;
      script.dataset.yskKakaoSdk = '1';
      script.src = this.sdkUrl;
      script.addEventListener('load', activateKakaoMaps, { once: true });
      script.addEventListener('error', () => finish({ ready: false, reason: 'SCRIPT_ERROR' }), { once: true });
      document.head.appendChild(script);
    });

    return this.sdkPromise;
  }

  /**
   * 지도 인스턴스를 단 한 번만 생성하고, 재시도 시에도 중복 생성하지 않는다(AC38).
   */
  async initMap(container = this.container) {
    this.container = container;
    if (!this.container) return { ready: false, reason: 'NO_CONTAINER' };

    if (this.map && globalThis.kakao?.maps?.LatLng) {
      return { ready: true, map: this.map, reused: true };
    }

    const sdkRes = await this.loadSdk();
    if (!sdkRes.ready) {
      return sdkRes;
    }

    try {
      const errBox = this.container.querySelector('.map-error');
      if (errBox) errBox.remove();

      if (!this.map) {
        this.map = new kakao.maps.Map(this.container, {
          center: new kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
          level: DEFAULT_LEVEL
        });
      }

      if (!this.clusterer && kakao.maps.MarkerClusterer) {
        try {
          this.clusterer = new kakao.maps.MarkerClusterer({
            map: this.map,
            averageCenter: true,
            minLevel: CLUSTER_MIN_LEVEL
          });
        } catch {
          this.clusterer = null;
        }
      }

      if (!this.mapClickListenerBound) {
        kakao.maps.event.addListener(this.map, 'click', () => {
          this.closeOverlay();
          this.onCloseOverlay();
        });
        this.mapClickListenerBound = true;
      }

      return { ready: true, map: this.map, reused: false };
    } catch (err) {
      this.sdkState = 'error';
      return { ready: false, reason: 'MAP_INIT_EXCEPTION', error: err };
    }
  }

  getMarkerImage(regionOrCity) {
    const color = REGION_COLORS[regionOrCity] || DEFAULT_MARKER_COLOR;
    if (!this.markerImageCache.has(color)) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42"><path d="M15 1C7.3 1 1 7.2 1 14.9 1 25.3 15 41 15 41s14-15.7 14-26.1C29 7.2 22.7 1 15 1z" fill="${color}" stroke="white" stroke-width="2"/><circle cx="15" cy="15" r="5.5" fill="white"/></svg>`;
      const img = new kakao.maps.MarkerImage(
        'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
        new kakao.maps.Size(30, 42),
        { offset: new kakao.maps.Point(15, 42) }
      );
      this.markerImageCache.set(color, img);
    }
    return this.markerImageCache.get(color);
  }

  /**
   * 현재 표시 대상 장소의 마커를 동기화한다.
   * - mappablePlaces 검증을 통과한 장소만 마커를 생성하며, 상세 오버레이 DOM은 선택 시 지연 생성한다(Section 9).
   */
  syncMarkers(places = []) {
    if (!this.isReady()) return { markerCount: 0 };

    // 기존 마커 정리
    if (this.clusterer) {
      this.clusterer.clear();
    } else {
      for (const entry of this.entries.values()) {
        entry.marker.setMap(null);
      }
    }

    const mappable = filterMappablePlaces(places);
    const activeMarkers = [];

    for (const place of mappable) {
      const strId = String(place.id);
      const coords = getPlaceCoords(place);
      if (!coords) continue;

      let entry = this.entries.get(strId);
      if (!entry) {
        const position = new kakao.maps.LatLng(coords.lat, coords.lng);
        const marker = new kakao.maps.Marker({
          position,
          title: place.name,
          image: this.getMarkerImage(place.regionCode || place.city)
        });
        kakao.maps.event.addListener(marker, 'click', () => {
          this.onSelectPlace(strId, false);
        });
        entry = { place, marker, overlay: null, content: null, position };
        this.entries.set(strId, entry);
      } else {
        entry.place = place;
      }
      activeMarkers.push(entry.marker);
    }

    if (this.clusterer) {
      this.clusterer.addMarkers(activeMarkers);
    } else {
      activeMarkers.forEach(m => m.setMap(this.map));
    }

    return { markerCount: activeMarkers.length };
  }

  /**
   * 유효 좌표 개수(0개 / 1개 / 다수)에 맞춰 안전하게 지도 범위를 조정한다(AC37).
   */
  fitToPlaces(places = [], regionMeta = null) {
    if (!this.isReady()) return { applied: false };
    const plan = computeFitBoundsPlan(places, regionMeta);

    if (plan.mode === 'region_default' || plan.mode === 'single') {
      this.map.setLevel(plan.level);
      this.map.setCenter(new kakao.maps.LatLng(plan.center.lat, plan.center.lng));
      return { applied: true, mode: plan.mode, validCount: plan.validCount };
    }

    const bounds = new kakao.maps.LatLngBounds();
    for (const c of plan.coordinates) {
      bounds.extend(new kakao.maps.LatLng(c.lat, c.lng));
    }
    // 휴대폰에서 지도가 작게 보일 때는 여백도 줄여야 범위가 제대로 맞춰진다
    const h = this.container?.clientHeight || 0;
    if (h > 0 && h < 320) {
      const pad = Math.max(8, Math.round(h * 0.1));
      this.map.setBounds(bounds, pad + 8, 16, pad, 16);
    } else {
      this.map.setBounds(bounds, 60, 40, 40, 40);
    }
    return { applied: true, mode: 'bounds', validCount: plan.validCount };
  }

  /**
   * 선택된 식당(문자열 영구 ID)의 오버레이를 지연 생성하여 지도에 표시한다(AC35, AC37).
   */
  focusPlaceById(placeId, placeObj = null, smooth = true) {
    const strId = String(placeId || '');
    if (!this.isReady()) return { focused: false, reason: 'MAP_NOT_READY' };

    let entry = this.entries.get(strId);
    if (!entry && placeObj && isMappablePlace(placeObj)) {
      this.syncMarkers([placeObj]);
      entry = this.entries.get(strId);
    }

    if (!entry || !isMappablePlace(entry.place)) {
      this.closeOverlay();
      return { focused: false, reason: 'PLACE_NOT_MAPPABLE' };
    }

    if (this.currentOverlay) {
      this.currentOverlay.setMap(null);
      this.currentOverlay = null;
    }

    // 선택 시 상세 오버레이 DOM 지연 생성
    entry.content = this.createOverlayDom(entry.place, () => this.closeOverlay());
    entry.overlay = new kakao.maps.CustomOverlay({
      content: entry.content,
      position: entry.position,
      clickable: true,
      zIndex: 3
    });

    entry.overlay.setMap(this.map);
    this.currentOverlay = entry.overlay;

    if (this.map.getLevel() > SINGLE_PLACE_LEVEL) {
      this.map.setLevel(SINGLE_PLACE_LEVEL);
    }
    if (smooth && this.map.panTo) {
      this.map.panTo(entry.position);
    } else {
      this.map.setCenter(entry.position);
    }

    return { focused: true, id: strId };
  }

  closeOverlay() {
    if (this.currentOverlay) {
      this.currentOverlay.setMap(null);
      this.currentOverlay = null;
    }
  }

  /**
   * 기준점(현재 위치 / 체험처 / 경기장 / 숙소) 마커 표시(FR04)
   */
  setReferencePointMarker(refPoint) {
    if (!this.isReady()) return;
    if (this.referenceOverlay) {
      this.referenceOverlay.setMap(null);
      this.referenceOverlay = null;
    }
    if (!refPoint || !isValidCoordinate(refPoint.lat, refPoint.lng)) return;

    const pos = new kakao.maps.LatLng(refPoint.lat, refPoint.lng);
    const dot = document.createElement('div');
    dot.className = 'my-pos';
    dot.title = refPoint.label || '기준점';
    this.referenceOverlay = new kakao.maps.CustomOverlay({
      content: dot,
      position: pos,
      zIndex: 2
    });
    this.referenceOverlay.setMap(this.map);
  }

  relayout() {
    if (this.isReady() && this.map.relayout) {
      this.map.relayout();
    }
  }
}
