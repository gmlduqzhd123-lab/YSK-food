// 전국 맛집 지도 서비스 워커 (v2.0.0)
// - 버전별 앱 껍데기 및 전이 의존 자산 묶음 캐시(ysk-food-app-v2.0.0)
// - 페이지 이동(navigate) 요청에만 index.html 대체 응답 허용, JSON/JS/CSS/이미지 요청에 HTML 대체 응답 절대 금지(AC26)
// - 버전 경로 자산 및 쿼리 요청에 ignoreSearch: true 미사용(Section 9)
// - 열린 탭이 사용 중인 버전 캐시 보존 및 미저장 편집 중 강제 활성화 방지(AC41)
// - 같은 출처(gmlduqzhd123-lab.github.io)의 다른 앱 캐시 보존(AC31)

const APP_VERSION = 'v2.0.0';
const DATASET_VERSION = '2026.10.1';
const APP_CACHE_NAME = `ysk-food-app-${APP_VERSION}`;
const DATA_CACHE_NAME = `ysk-food-data-${DATASET_VERSION}`;
// 이 앱이 관리하는 캐시 접두어 (기존 ysk-food-v* 및 신규 ysk-food-app-*, ysk-food-data-*)
const MANAGED_CACHE_PREFIX = 'ysk-food-';

// asset-manifest.json과 동일한 진입 파일 + 전이 의존 파일 전체 목록
const APP_SHELL_AND_DEPS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './ys-install.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './assets/releases/v2.0.0/asset-manifest.json',
  './assets/releases/v2.0.0/css/app.css',
  './assets/releases/v2.0.0/css/print.css',
  './assets/releases/v2.0.0/js/app.js',
  './assets/releases/v2.0.0/js/config.js',
  './assets/releases/v2.0.0/js/storage.js',
  './assets/releases/v2.0.0/js/data/normalize.js',
  './assets/releases/v2.0.0/js/data/repository.js',
  './assets/releases/v2.0.0/js/domain/hours.js',
  './assets/releases/v2.0.0/js/domain/budget.js',
  './assets/releases/v2.0.0/js/domain/schedule.js',
  './assets/releases/v2.0.0/js/domain/search.js',
  './assets/releases/v2.0.0/js/ui/map.js',
  './assets/releases/v2.0.0/js/ui/list.js',
  './assets/releases/v2.0.0/js/ui/event.js',
  './assets/releases/v2.0.0/js/ui/share.js'
];

// 클라이언트 탭별 상태 기록 (clientId -> { appVersion, hasUnsavedEdits })
const clientStatuses = new Map();

/**
 * 요청이 문서 이동(navigation) 요청인지 판별한다(AC26).
 */
function isNavigationRequest(request) {
  if (!request) return false;
  if (request.mode === 'navigate') return true;
  const dest = request.destination || '';
  if (dest === 'document') return true;
  return false;
}

/**
 * 요청 경로가 비문서 정적 자산(.json, .js, .mjs, .css, 이미지 등)인지 판별한다(AC26).
 */
function isNonDocumentAssetPath(pathname) {
  return /\.(json|js|mjs|css|png|jpg|jpeg|gif|svg|webp|ico|webmanifest|woff2?)$/i.test(String(pathname || ''));
}

/**
 * 캐시 키 정리 대상 여부를 판별한다(AC31, AC41).
 * - ysk-food- 로 시작하지 않는 타 프로젝트 캐시는 절대 건드리지 않는다.
 * - 현재 활성 버전 캐시 및 열린 클라이언트 탭이 참조 중인 버전 캐시는 보존한다.
 */
function shouldDeleteCacheKey(cacheKey, activeVersions = new Set([APP_VERSION]), activeDataVersions = new Set([DATASET_VERSION])) {
  const key = String(cacheKey || '');
  if (!key.startsWith(MANAGED_CACHE_PREFIX)) {
    return false;
  }
  if (key === APP_CACHE_NAME || key === DATA_CACHE_NAME) {
    return false;
  }
  for (const ver of activeVersions) {
    if (key === `ysk-food-app-${ver}`) return false;
  }
  for (const dVer of activeDataVersions) {
    if (key === `ysk-food-data-${dVer}`) return false;
  }
  return true;
}

/**
 * 새 서비스 워커가 즉시 활성화(skipWaiting)해도 안전한지 판별한다(AC41).
 * - 열린 클라이언트가 0개이거나,
 * - 사용자가 명시적으로 승인(approvedByUser)했고 미저장 편집 중인 탭이 없을 때만 true
 */
function canActivateWaitingWorker({ clientCount = 0, approvedByUser = false, anyUnsavedEdits = false } = {}) {
  if (anyUnsavedEdits) return false;
  if (clientCount === 0) return true;
  return Boolean(approvedByUser);
}

/**
 * 응답이 해당 요청에 대해 캐시 저장 가능한 정상 응답인지 검증한다(AC26).
 * 비문서 요청(.json, .js, .css 등)에 대해 text/html 이 반환된 경우 캐시 오염을 차단한다.
 */
function isCacheableValidResponse(request, response) {
  if (!response || !response.ok || response.status !== 200) return false;
  const url = new URL(request.url);
  const contentType = (response.headers && response.headers.get && response.headers.get('content-type')) || '';
  if (!isNavigationRequest(request) && isNonDocumentAssetPath(url.pathname)) {
    if (contentType.toLowerCase().includes('text/html')) {
      return false;
    }
  }
  return true;
}

// 테스트 및 외부 검증용 훅 노출
self.__YSK_SW_HOOKS__ = {
  APP_VERSION,
  DATASET_VERSION,
  APP_CACHE_NAME,
  DATA_CACHE_NAME,
  MANAGED_CACHE_PREFIX,
  APP_SHELL_AND_DEPS,
  isNavigationRequest,
  isNonDocumentAssetPath,
  shouldDeleteCacheKey,
  canActivateWaitingWorker,
  isCacheableValidResponse
};

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE_NAME);
      await cache.addAll(APP_SHELL_AND_DEPS);
      // 열린 클라이언트 탭이 하나도 없을 때만 즉시 대기 단계를 건너뛴다(AC41)
      if (self.clients && typeof self.clients.matchAll === 'function') {
        const existingClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (canActivateWaitingWorker({ clientCount: existingClients.length, approvedByUser: false, anyUnsavedEdits: false })) {
          await self.skipWaiting();
        }
      }
    })()
  );
});

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  const clientId = event.source && event.source.id ? event.source.id : 'default';

  if (data.type === 'YSK_CLIENT_STATUS') {
    clientStatuses.set(clientId, {
      appVersion: data.appVersion || APP_VERSION,
      hasUnsavedEdits: Boolean(data.hasUnsavedEdits)
    });
    return;
  }

  if (data.type === 'YSK_APPROVE_ACTIVATE') {
    let anyUnsaved = false;
    for (const st of clientStatuses.values()) {
      if (st.hasUnsavedEdits) anyUnsaved = true;
    }
    if (canActivateWaitingWorker({ clientCount: 1, approvedByUser: true, anyUnsavedEdits: anyUnsaved })) {
      self.skipWaiting();
    }
  }
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const activeAppVersions = new Set([APP_VERSION]);
      const activeDataVersions = new Set([DATASET_VERSION]);

      if (self.clients && typeof self.clients.matchAll === 'function') {
        const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windowClients) {
          const st = clientStatuses.get(client.id);
          if (st && st.appVersion) {
            activeAppVersions.add(st.appVersion);
          }
        }
      }

      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(key => shouldDeleteCacheKey(key, activeAppVersions, activeDataVersions))
          .map(key => caches.delete(key))
      );

      // 열린 탭 중 다른 구버전을 실행 중이거나 미저장 편집 중인 탭이 없을 때만 claim 수행
      let hasOtherVersionOrUnsaved = false;
      for (const st of clientStatuses.values()) {
        if (st.hasUnsavedEdits || (st.appVersion && st.appVersion !== APP_VERSION)) {
          hasOtherVersionOrUnsaved = true;
        }
      }
      if (!hasOtherVersionOrUnsaved && self.clients && typeof self.clients.claim === 'function') {
        await self.clients.claim();
      }
    })()
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // 1) 같은 출처(우리 사이트) 요청 처리
  if (url.origin === self.location.origin) {
    const isNav = isNavigationRequest(request) && !isNonDocumentAssetPath(url.pathname);
    const isDataJson = url.pathname.includes('/data/') && url.pathname.endsWith('.json');
    const targetCacheName = isDataJson ? DATA_CACHE_NAME : APP_CACHE_NAME;

    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
          if (isCacheableValidResponse(request, response)) {
            const copy = response.clone();
            const cache = await caches.open(targetCacheName);
            await cache.put(request, copy);
            return response;
          }
          // 비문서 요청에 잘못된 HTML 응답 등이 온 경우 캐시에서 먼저 찾는다(AC26)
          if (!isNav && response.ok) {
            const cached = await caches.match(request, { ignoreSearch: false });
            if (cached) return cached;
          }
          return response;
        } catch {
          // 버전 경로 자산 및 쿼리 요청에는 ignoreSearch: false(정확 일치)만 사용한다(Section 9)
          const exactCached = await caches.match(request, { ignoreSearch: false });
          if (exactCached) return exactCached;

          // 페이지 이동(navigate) 요청에만 index.html 대체 응답을 허용한다(AC26)
          if (isNav) {
            const shellCached = (await caches.match('./index.html', { ignoreSearch: false })) ||
                                (await caches.match('./', { ignoreSearch: false }));
            if (shellCached) return shellCached;
          }

          // .json / .js / .css / 이미지 등 비문서 요청은 절대 index.html을 반환하지 않고 명시적 503 오류를 반환한다(AC26)
          if (url.pathname.endsWith('.json')) {
            return new Response(
              JSON.stringify({ error: 'OFFLINE_CACHE_MISS', message: '오프라인 상태에서 저장되지 않은 데이터 파일입니다.' }),
              { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
            );
          }
          return new Response('Offline asset unavailable', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      })()
    );
    return;
  }

  // 2) 글꼴(Pretendard): 한 번 받으면 저장해 두고 재사용
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(
      caches.match(request, { ignoreSearch: false }).then(
        cached =>
          cached ||
          fetch(request).then(response => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(APP_CACHE_NAME).then(cache => cache.put(request, copy));
            }
            return response;
          })
      )
    );
  }
});
