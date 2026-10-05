/* 📲 엽쌤 앱 설치 도우미 (ys-install.js)
 * - 앱으로 열린 상태가 아니면 언제나 <html class="can-install"> 를 붙여 설치 버튼이 보이게 한다.
 * - `.install-btn button` 또는 [data-ys-install] 를 누르면 (앱으로 열린 상태면 [data-ys-install]은 자동으로 숨김)
 *   크롬·엣지·삼성 인터넷: 설치 창을 바로 띄우고,
 *   그 밖(아이폰·카카오톡·PC 사파리 등): 기기에 맞는 설치 방법을 안내한다.
 * - 다른 코드에서는 window.YSInstall.open() 으로 같은 동작을 부를 수 있다.
 */
(function () {
    if (window.YSInstall) return;
    var root = document.documentElement;
    var deferred = null;
    var ua = navigator.userAgent;
    var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var isAndroid = /android/i.test(ua);
    var isKakao = /KAKAOTALK/i.test(ua);
    var isInApp = isKakao || /NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp|; wv\)/i.test(ua);
    var isSamsung = /SamsungBrowser/i.test(ua);
    var isWhale = /Whale/i.test(ua);
    var isIOSSafari = isIOS && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|Whale|NAVER|DaumApps/i.test(ua) && !isInApp;

    function installed() {
        return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    }
    function refresh() { root.classList.toggle('can-install', !installed()); }
    refresh();

    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; refresh(); });
    window.addEventListener('appinstalled', function () {
        deferred = null;
        root.classList.remove('can-install');
        close();
        toast('설치 완료! 홈 화면에서 바로 열 수 있어요 🎉');
    });

    var css = 'html:not(.can-install) [data-ys-install]{display:none!important}' +
        '.ysi-back{position:fixed;inset:0;z-index:2147483100;background:rgba(15,23,42,.6);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;padding:16px;box-sizing:border-box;animation:ysi-fade .18s ease}' +
        '@media (min-width:640px){.ysi-back{align-items:center}}' +
        '.ysi-card{box-sizing:border-box;width:min(100%,440px);max-height:100%;overflow:auto;background:#fff;color:#0f172a;border-radius:22px;padding:22px 20px 18px;font-family:inherit;font-size:16px;line-height:1.6;text-align:left;box-shadow:0 24px 64px rgba(0,0,0,.35);animation:ysi-up .22s cubic-bezier(.2,.8,.2,1)}' +
        '.ysi-card *{box-sizing:border-box}' +
        '.ysi-head{display:flex;align-items:center;gap:12px;margin:0 0 10px}' +
        '.ysi-icon{width:48px;height:48px;border-radius:12px;flex:none;object-fit:cover;background:#f1f5f9}' +
        '.ysi-title{margin:0;font-size:20px;font-weight:800;line-height:1.3;color:#0f172a}' +
        '.ysi-sub{margin:2px 0 0;font-size:14px;color:#64748b}' +
        '.ysi-card ol{margin:10px 0 6px;padding:0 0 0 22px;list-style:decimal outside}' +
        '.ysi-card li{display:list-item;margin:6px 0}' +
        '.ysi-card p{font-size:16px;line-height:1.6;color:#334155}' +
        '.ysi-card b{color:#0f172a}' +
        '.ysi-note{margin:8px 0 0;padding:10px 12px;border-radius:12px;background:#f1f5f9;color:#475569;font-size:14px}' +
        '.ysi-btn{display:block;width:100%;margin:12px 0 0;padding:13px 14px;border:0;border-radius:14px;font:inherit;font-weight:800;font-size:16px;cursor:pointer;text-align:center;text-decoration:none}' +
        '.ysi-primary{background:#2563eb;color:#fff}' +
        '.ysi-ghost{background:#e2e8f0;color:#0f172a}' +
        '.ysi-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483200;background:#0f172a;color:#fff;padding:12px 18px;border-radius:999px;font:inherit;font-weight:700;font-size:15px;box-shadow:0 10px 30px rgba(0,0,0,.3);max-width:calc(100vw - 32px);text-align:center}' +
        '@keyframes ysi-fade{from{opacity:0}}@keyframes ysi-up{from{transform:translateY(16px);opacity:0}}';

    function injectCss() {
        if (document.getElementById('ysi-style') || !document.head) return;
        var s = document.createElement('style');
        s.id = 'ysi-style';
        s.textContent = css;
        document.head.appendChild(s);
    }

    function appName() {
        var m = document.querySelector('meta[name="apple-mobile-web-app-title"]') || document.querySelector('meta[name="application-name"]');
        return (m && m.content) || document.title.split(/[|·—-]/)[0].trim() || '이 앱';
    }
    function appIcon() {
        var l = document.querySelector('link[rel="apple-touch-icon"]') || document.querySelector('link[rel="icon"][sizes]') || document.querySelector('link[rel="icon"]');
        return l ? l.href : '';
    }

    function guide() {
        var here = location.href.split('#')[0];
        if (isKakao) {
            return '<p style="margin:0">카카오톡 안에서 연 화면에서는 앱을 설치할 수 없어요. 아래 버튼으로 ' + (isIOS ? 'Safari' : '인터넷 브라우저') + '에서 다시 열어 주세요.</p>' +
                '<a class="ysi-btn ysi-primary" href="kakaotalk://web/openExternal?url=' + encodeURIComponent(here) + '">' + (isIOS ? 'Safari로 열기' : '브라우저로 열기') + '</a>' +
                '<p class="ysi-note">버튼이 안 되면 카카오톡 화면의 <b>⋮ 메뉴</b>에서 <b>' + (isIOS ? 'Safari로 열기' : '다른 브라우저로 열기') + '</b>를 누른 뒤, 열린 화면에서 <b>📲 앱 설치</b>를 다시 눌러 주세요.</p>';
        }
        if (isInApp) {
            return '<p style="margin:0">이 앱(인앱 브라우저) 안에서는 설치할 수 없어요.</p><ol>' +
                '<li>화면의 <b>⋮ 또는 ⋯ 메뉴</b>를 누르세요.</li>' +
                '<li><b>' + (isIOS ? 'Safari로 열기' : '다른 브라우저로 열기') + '</b>를 누르세요.</li>' +
                '<li>열린 화면에서 <b>📲 앱 설치</b>를 다시 눌러 주세요.</li></ol>';
        }
        if (isIOS) {
            if (!isIOSSafari) {
                return '<p style="margin:0">아이폰·아이패드는 <b>Safari</b>에서 설치하는 것이 가장 확실해요.</p><ol>' +
                    '<li>이 주소를 <b>Safari</b>에서 열어 주세요.</li>' +
                    '<li>아래쪽 <b>공유 버튼 (□↑)</b>을 누르세요.</li>' +
                    '<li><b>홈 화면에 추가</b> → 오른쪽 위 <b>추가</b>를 누르세요.</li></ol>';
            }
            return '<ol>' +
                '<li>Safari 아래쪽(아이패드는 위쪽) <b>공유 버튼 (□↑)</b>을 누르세요.</li>' +
                '<li>목록을 내려 <b>홈 화면에 추가</b>를 누르세요.</li>' +
                '<li>오른쪽 위 <b>추가</b>를 누르면 홈 화면에 아이콘이 생겨요.</li></ol>';
        }
        if (isAndroid) {
            return '<ol>' +
                '<li>브라우저 ' + (isSamsung ? '아래쪽 <b>≡ 메뉴</b>' : '오른쪽 위 <b>⋮ 메뉴</b>') + '를 누르세요.</li>' +
                '<li><b>앱 설치</b> 또는 <b>홈 화면에 추가</b>를 누르세요.</li>' +
                '<li><b>설치(추가)</b>를 누르면 홈 화면에 아이콘이 생겨요.</li></ol>' +
                '<p class="ysi-note">메뉴에 설치 항목이 없으면 <b>크롬</b>이나 <b>삼성 인터넷</b>으로 열어 주세요.</p>';
        }
        if (isWhale) {
            return '<ol><li>오른쪽 위 <b>⋯ 메뉴</b>를 누르세요.</li><li><b>앱 설치</b>(또는 <b>바로가기 만들기</b>)를 누르세요.</li></ol>';
        }
        if (/Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua)) {
            return '<ol><li>Safari 메뉴 막대의 <b>파일</b> 메뉴(또는 공유 버튼)를 누르세요.</li><li><b>Dock에 추가</b>를 누르세요.</li></ol>';
        }
        if (/Firefox/i.test(ua)) {
            return '<p style="margin:0">파이어폭스는 앱 설치를 지원하지 않아요. <b>크롬</b>이나 <b>엣지</b>로 이 주소를 열고 다시 눌러 주세요.</p>';
        }
        return '<ol>' +
            '<li>주소창 오른쪽의 <b>설치 아이콘 (⊕ 또는 🖥️)</b>을 누르세요.</li>' +
            '<li>안 보이면 오른쪽 위 <b>⋮ 메뉴 → 앱 설치</b>(엣지는 <b>⋯ → 앱 → 이 사이트를 앱으로 설치</b>)를 누르세요.</li></ol>' +
            '<p class="ysi-note">이미 설치했다면 바탕화면이나 시작 메뉴에서 열 수 있어요.</p>';
    }

    var back = null, lastFocus = null;
    function close() {
        if (!back) return;
        back.remove();
        back = null;
        document.removeEventListener('keydown', onKey, true);
        if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

    function showGuide() {
        injectCss();
        close();
        lastFocus = document.activeElement;
        var icon = appIcon();
        back = document.createElement('div');
        back.className = 'ysi-back';
        back.innerHTML = '<div class="ysi-card" role="dialog" aria-modal="true" aria-labelledby="ysi-title">' +
            '<div class="ysi-head">' + (icon ? '<img class="ysi-icon" alt="" src="' + icon + '">' : '') +
            '<div><h2 class="ysi-title" id="ysi-title">📲 앱으로 설치하기</h2><p class="ysi-sub"></p></div></div>' +
            guide() +
            '<button type="button" class="ysi-btn ysi-ghost" data-ysi-close>닫기</button></div>';
        back.querySelector('.ysi-sub').textContent = appName() + ' · 홈 화면에서 바로 열려요';
        back.addEventListener('click', function (e) {
            if (e.target === back || (e.target.closest && e.target.closest('[data-ysi-close]'))) close();
        });
        document.body.appendChild(back);
        document.addEventListener('keydown', onKey, true);
        back.querySelector('[data-ysi-close]').focus();
    }

    var toastTimer;
    function toast(msg) {
        if (!document.body) return;
        injectCss();
        var t = document.getElementById('ysi-toast');
        if (!t) { t = document.createElement('div'); t.id = 'ysi-toast'; t.className = 'ysi-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
        t.textContent = msg;
        t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.hidden = true; }, 3000);
    }

    function open() {
        if (deferred) {
            var ev = deferred;
            deferred = null;
            ev.prompt();
            ev.userChoice.then(function (c) { if (c && c.outcome !== 'accepted') deferred = null; }, function () {});
            return;
        }
        showGuide();
    }

    document.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('.install-btn button, [data-ys-install]');
        if (!btn) return;
        e.preventDefault();
        open();
    });

    injectCss();
    window.YSInstall = { open: open, canPrompt: function () { return !!deferred; }, installed: installed };
})();
