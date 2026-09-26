// 여순광 맛집 지도 서비스 워커: 홈 화면 추가(설치)를 지원하고, 한 번 열어 본 화면은 인터넷이 약해도 뜨게 한다.
// 지도 타일·카카오 SDK는 저장하지 않으므로 지도 자체는 인터넷이 있어야 보인다.
// index.html이나 아이콘을 바꾸면 CACHE_VERSION을 올려야 예전 캐시가 정리된다.
const CACHE_VERSION = 'ysk-food-v10';
const APP_SHELL = [
    './',
    './index.html',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL)));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    // 우리 사이트 파일: 새 버전을 먼저 받아 오고, 인터넷이 없으면 저장해 둔 것을 보여준다
    // cache: 'no-cache' → 브라우저 HTTP 캐시(GitHub Pages는 10분)를 쓰지 말고 서버에 바뀌었는지 확인
    // (페이지 이동 요청은 옵션을 붙여 복사할 수 없어서 주소로 다시 요청)
    if (url.origin === self.location.origin) {
        event.respondWith(
            fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' })
                .then(response => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => caches.match(request, { ignoreSearch: true })
                    .then(cached => cached || caches.match('./index.html')))
        );
        return;
    }

    // 글꼴(Pretendard): 한 번 받으면 저장해 두고 재사용
    if (url.hostname === 'cdn.jsdelivr.net') {
        event.respondWith(
            caches.match(request).then(cached => cached || fetch(request).then(response => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
                }
                return response;
            }))
        );
    }
    // 카카오 지도·구글 시트는 항상 최신 데이터를 받도록 브라우저에 맡긴다
});
