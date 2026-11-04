// 식당이 적은 지역을 카카오맵 지역 검색으로 보강하는 도구 (2026-11 지역 보강 1~6차에 쓴 절차를 정리)
//
//   node tools/region-boost.mjs --config 보강설정.json --work 작업폴더 --out tools/region-boost-N-YYYYMMDD.json \
//        --id-prefix ysk-r-q --label 7차 [--checked-at 2026-12-01] [--step search|details|select|all]
//
// 보강 설정(JSON) 예:
//   { "seoul-gangbuk": { "target": 100, "areas": ["서울 강북구", "수유동"], "pat": "^서울(특별시)? 강북구", "full": true } }
//   - target: 이 지역의 목표 식당 수 (지금 수가 이보다 적을 때만 검색)
//   - areas: 검색어 앞에 붙일 지역 이름들, pat: 주소가 이 지역인지 가리는 정규식
//   - full: true면 검색 키워드를 많이(41개)·3쪽까지, 아니면 10개·2쪽까지 검색
//
// 단계 (작업 폴더에 중간 결과를 남기므로 끊겨도 이어서 할 수 있다):
//   1) search : 지역×키워드로 카카오맵 검색 → 이미 있는 식당(카카오 ID·전화번호·이름)과 술집·카페 등 업종 제외 → candidates.json
//   2) details: 지역마다 리뷰 많은 후보를 필요한 수의 4배까지 장소 상세를 받음 → details.jsonl (이어 받기 가능)
//   3) select : 기준을 모두 만족하는 곳만 남겨 단체석 있는 곳·리뷰 많은 곳 순으로 필요한 수만큼 고름 → --out 파일
//      기준: 카카오맵 영업 표시, 요일별 영업시간, 최근 6개월 안 리뷰, 전화번호, 메뉴 가격(1천~30만 원)
//
// 결과 파일은 빌드 도구(tools/build-dataset.mjs)의 REGION_BOOST_FILES에 이름을 더하면 반영된다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandStoredRegionDataset } from '../assets/releases/v2.0.0/js/data/normalize.js';
import { compactFacilities, parseKakaoFacilities, parseKakaoOpenHours } from './kakao-place-parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CONFIG_PATH = arg('--config');
const WORK_DIR = arg('--work');
const OUT_PATH = arg('--out');
const ID_PREFIX = arg('--id-prefix');
const LABEL = arg('--label', '보강');
const STEP = arg('--step', 'all');
const CHECKED_AT = arg('--checked-at', new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10));
if (!CONFIG_PATH || !WORK_DIR || (STEP !== 'search' && STEP !== 'details' && (!OUT_PATH || !ID_PREFIX))) {
  console.error('사용법: node tools/region-boost.mjs --config 설정.json --work 작업폴더 --out 결과.json --id-prefix ysk-r-q --label 7차');
  process.exit(1);
}
fs.mkdirSync(WORK_DIR, { recursive: true });
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const work = name => path.join(WORK_DIR, name);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const KEYWORDS_FULL = ['고기집', '해물탕', '족발', '샤브샤브', '초밥', '짬뽕', '냉면', '막국수', '순두부', '추어탕', '감자탕', '아구찜', '갈비탕', '곰탕', '정식', '쌈밥정식', '닭볶음탕', '찜닭', '파스타', '돈까스', '맛집', '한식', '백반', '한정식', '돈가스', '국밥', '칼국수', '중식', '불고기', '갈비', '닭갈비', '삼계탕', '비빔밥', '생선구이', '분식', '쌈밥', '보리밥', '오리', '설렁탕', '떡갈비', '단체'];
const KEYWORDS_SHORT = ['맛집', '한식', '백반', '한정식', '돈가스', '국밥', '칼국수', '갈비', '중식', '단체'];
// 초등 단체 식사에 맞지 않는 업종
const EXCLUDED_CATEGORY = /술집|호프|요리주점|이자카야|포장마차|카페|간식|제과|베이커리|디저트|아이스크림|패스트푸드|뷔페|도시락|샐러드|와인|칵테일|바\b/;
// 1인 가격 비교에 쓰지 않는 메뉴 (음료·추가·사리 등)
const SKIP_MENU = /공기밥|공깃밥|음료|사이다|콜라|소주|맥주|막걸리|와인|하이볼|사케|주류|추가|사리|포장|배달|토핑|소스|곱빼기|생수|커피|에이드|주스|아메리카노|라떼/;

const digits = s => String(s || '').replace(/\D/g, '');
const normName = s => String(s || '').replace(/\s+|\(.*?\)/g, '');

async function getJson(url, headers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return { status: 404 };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: 200, body: await res.json() };
    } catch {
      await sleep(1500 * (attempt + 1));
    }
  }
  return { status: -1 };
}

async function pool(items, concurrency, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }));
}

/** 지금 자료의 식당 (중복 확인용)과 지역별 식당 수 */
function loadExisting() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data/manifest.json'), 'utf8'));
  const list = [];
  for (const meta of Object.values(manifest.regionFiles || {})) {
    const stored = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, meta.path), 'utf8'));
    for (const r of expandStoredRegionDataset(stored).restaurants) list.push(r);
  }
  const counts = {};
  for (const r of list) counts[r.regionCode] = (counts[r.regionCode] || 0) + 1;
  return { list, counts };
}

const needOf = (counts, code) => Math.max(0, (CONFIG[code].target || 0) - (counts[code] || 0));

async function stepSearch() {
  const { list, counts } = loadExisting();
  fs.writeFileSync(work('counts.json'), JSON.stringify(counts));
  const kakaoIds = new Set(list.map(r => r.mapLinks?.kakaoPlaceId).filter(Boolean));
  const phones = new Set(list.map(r => digits(r.phone)).filter(Boolean));
  const names = new Set(list.map(r => `${r.regionCode}|${normName(r.name)}`));
  const jobs = [];
  for (const [code, cfg] of Object.entries(CONFIG)) {
    if (!needOf(counts, code)) continue;
    for (const area of cfg.areas) {
      for (const kw of cfg.full ? KEYWORDS_FULL : KEYWORDS_SHORT) {
        for (const page of cfg.full ? [1, 2, 3] : [1, 2]) jobs.push({ code, q: `${area} ${kw}`, page });
      }
    }
  }
  console.log(`[search] 검색 ${jobs.length}건`);
  const candidates = {};
  await pool(jobs, 6, async job => {
    const url = `https://search.map.kakao.com/mapsearch/map.daum?${new URLSearchParams({ q: job.q, msFlag: 'A', sort: '0', page: String(job.page) })}`;
    const res = await getJson(url, { Referer: 'https://map.kakao.com/' });
    const pattern = new RegExp(CONFIG[job.code].pat);
    for (const p of res.body?.place || []) {
      const address = p.new_address || p.address || '';
      if (!pattern.test(address) || p.cate_name_depth1 !== '음식점') continue;
      const cate = [p.cate_name_depth2, p.cate_name_depth3, p.last_cate_name].filter(Boolean).join(' ');
      if (EXCLUDED_CATEGORY.test(cate) || EXCLUDED_CATEGORY.test(p.name)) continue;
      if (!p.tel || kakaoIds.has(p.confirmid) || phones.has(digits(p.tel)) || names.has(`${job.code}|${normName(p.name)}`)) continue;
      candidates[p.confirmid] ||= {
        kid: p.confirmid, regionCode: job.code, name: p.name, tel: p.tel, address,
        lat: p.lat, lng: p.lon, cate2: p.cate_name_depth2, cate3: p.cate_name_depth3, reviews: Number(p.reviewCount) || 0
      };
    }
  });
  fs.writeFileSync(work('candidates.json'), JSON.stringify(candidates));
  console.log(`[search] 후보 ${Object.keys(candidates).length}곳`);
}

function extractDetail(body) {
  const dates = [];
  if (body.blog_review?.last_registered_at) dates.push(body.blog_review.last_registered_at.slice(0, 10));
  for (const rv of body.kakaomap_review?.reviews || []) {
    for (const [k, v] of Object.entries(rv)) if (k.endsWith('_at') && typeof v === 'string' && v.length >= 10) dates.push(v.slice(0, 10));
  }
  return {
    status: body.summary?.status ?? null,
    category: body.summary?.category?.name ?? null,
    lastReview: dates.length ? dates.sort().at(-1) : null,
    hours: parseKakaoOpenHours(body.open_hours),
    facilities: parseKakaoFacilities(body),
    menus: (body.menu?.menus?.items || []).slice(0, 20).map(m => ({ name: m.name, price: m.price }))
  };
}

async function stepDetails() {
  const candidates = JSON.parse(fs.readFileSync(work('candidates.json'), 'utf8'));
  const counts = JSON.parse(fs.readFileSync(work('counts.json'), 'utf8'));
  const done = new Set();
  if (fs.existsSync(work('details.jsonl'))) {
    for (const line of fs.readFileSync(work('details.jsonl'), 'utf8').split('\n')) if (line) done.add(JSON.parse(line).kid);
  }
  const byRegion = {};
  for (const c of Object.values(candidates)) (byRegion[c.regionCode] ||= []).push(c);
  const targets = [];
  for (const [code, list] of Object.entries(byRegion)) {
    list.sort((a, b) => b.reviews - a.reviews);
    targets.push(...list.slice(0, Math.max(40, needOf(counts, code) * 4)).filter(c => !done.has(c.kid)));
  }
  console.log(`[details] 장소 상세 ${targets.length}곳 (이미 받은 곳 ${done.size}곳)`);
  const out = fs.openSync(work('details.jsonl'), 'a');
  await pool(targets, 8, async c => {
    const res = await getJson(`https://place-api.map.kakao.com/places/panel3/${c.kid}`, { pf: 'web', Referer: 'https://place.map.kakao.com/', Accept: 'application/json' });
    const rec = { kid: c.kid, code: res.status, ...(res.body ? extractDetail(res.body) : {}) };
    fs.writeSync(out, JSON.stringify(rec) + '\n');
    await sleep(150);
  });
  fs.closeSync(out);
}

const SIDO = [[/^전남광주통합특별시 (\S+구)/, '광주'], [/^(?:전남광주통합특별시|전라남도|전남) (\S+)/, '전남'], [/^(?:광주광역시|광주) (\S+)/, '광주'],
  [/^(?:전북특별자치도|전라북도|전북) (\S+)/, '전북'], [/^(?:강원특별자치도|강원도|강원) (\S+)/, '강원'], [/^(?:경상북도|경북) (\S+)/, '경북'],
  [/^(?:경상남도|경남) (\S+)/, '경남'], [/^(?:충청남도|충남) (\S+)/, '충남'], [/^(?:충청북도|충북) (\S+)/, '충북'], [/^(?:부산광역시|부산) (\S+)/, '부산'],
  [/^(?:대구광역시|대구) (\S+)/, '대구'], [/^(?:울산광역시|울산) (\S+)/, '울산'], [/^(?:대전광역시|대전) (\S+)/, '대전'], [/^(?:인천광역시|인천) (\S+)/, '인천'],
  [/^(?:서울특별시|서울) (\S+)/, '서울'], [/^(?:경기도|경기) (\S+)/, '경기'], [/^제주특별자치도 (\S+)/, '제주'], [/^세종특별자치시/, '세종']];
function cityOf(address) {
  for (const [pattern, sido] of SIDO) {
    const m = pattern.exec(address);
    if (m) return m[1] ? `${sido} ${m[1]}` : sido;
  }
  return address.split(' ')[0];
}
const CATEGORY_RULES = [['한정식', /한정식/], ['장어', /장어/], ['게장', /게장/], ['면', /칼국수|국수|냉면|우동|라멘|쌀국수|막국수|밀면|수제비/],
  ['국밥·탕', /국밥|해장국|곰탕|설렁탕|감자탕|순대|추어|탕/], ['닭요리', /닭|삼계|치킨/], ['고기', /육류|고기|갈비|삼겹|불고기|소고기|돼지|오리|구이/],
  ['분식·중식', /중식|중국|분식|김밥|떡볶이|만두|짜장|짬뽕/], ['양식·일식', /일식|돈까스|돈가스|양식|초밥|경양식|이탈리|파스타|스테이크|카레|우동|버거/],
  ['해산물', /해물|생선|회|조개|해산물|아구|아귀|복어|대게|낙지|주꾸미|쭈꾸미/]];
function categoryOf(c, d) {
  const text = [d.category, c.cate3, c.cate2, c.name].filter(Boolean).join(' ');
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(text))?.[0] || '백반·한식';
}

function stepSelect() {
  const candidates = JSON.parse(fs.readFileSync(work('candidates.json'), 'utf8'));
  const counts = JSON.parse(fs.readFileSync(work('counts.json'), 'utf8'));
  const details = {};
  for (const line of fs.readFileSync(work('details.jsonl'), 'utf8').split('\n')) if (line) { const d = JSON.parse(line); details[d.kid] = d; }
  // 최근 6개월 리뷰 기준일
  const cutoff = new Date(new Date(`${CHECKED_AT}T00:00:00Z`).getTime() - 183 * 86400000).toISOString().slice(0, 10);
  const reasons = {};
  const reject = why => { reasons[why] = (reasons[why] || 0) + 1; };
  const eligible = {};
  for (const c of Object.values(candidates)) {
    const d = details[c.kid];
    if (!d) continue;
    if (d.code !== 200 || d.status !== 'Y') { reject('영업 표시 없음'); continue; }
    if (!d.hours) { reject('영업시간 없음'); continue; }
    if (!d.lastReview || d.lastReview < cutoff) { reject('최근 6개월 리뷰 없음'); continue; }
    const menus = (d.menus || []).filter(m => m.name && Number.isInteger(m.price) && m.price >= 1000 && m.price <= 300000 && !SKIP_MENU.test(m.name));
    if (!menus.length) { reject('메뉴 가격 없음'); continue; }
    (eligible[c.regionCode] ||= []).push({ c, d, menus });
  }
  const restaurants = [];
  const places = {};
  let n = 0;
  for (const code of Object.keys(eligible).sort()) {
    const need = needOf(counts, code);
    // 단체석 있는 곳 → 리뷰 많은 곳 순
    const picked = eligible[code].sort((a, b) => (b.d.facilities.group - a.d.facilities.group) || (b.c.reviews - a.c.reviews)).slice(0, need);
    console.log(`[select] ${code}: 필요 ${need} · 기준 통과 ${eligible[code].length} · 선택 ${picked.length} (단체석 ${picked.filter(x => x.d.facilities.group).length})`);
    for (const { c, d, menus } of picked) {
      n += 1;
      const id = `${ID_PREFIX}${String(n).padStart(4, '0')}`;
      restaurants.push({
        id, name: c.name, regionCode: code, city: cityOf(c.address), category: categoryOf(c, d),
        menu: menus.slice(0, 3).map(m => m.name).join(', '), lat: c.lat, lng: c.lng,
        link: `https://place.map.kakao.com/${c.kid}`, phone: c.tel, address: c.address, hours: '', closed: '',
        source: '카카오맵지역보강',
        note: `지역 보강(${LABEL}) · 카카오맵 영업·영업시간·최근 6개월 리뷰(최근 ${d.lastReview})·연락처 확인(${CHECKED_AT})`
      });
      const facilities = compactFacilities(d.facilities);
      places[id] = {
        kakaoPlaceId: c.kid, ...d.hours,
        menus: menus.slice(0, 12).map(m => ({ name: m.name, priceKRW: m.price, priceBasis: 'per_person' })),
        ...(Object.keys(facilities).length ? { facilities } : {})
      };
    }
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    checkedAt: CHECKED_AT,
    source: `카카오맵 지역 검색 (${LABEL} 지역 보강): 영업 표시·요일별 영업시간·최근 6개월 리뷰·전화번호·메뉴 가격 확인`,
    restaurants,
    places
  }, null, 1) + '\n');
  console.log(`[select] 모두 ${restaurants.length}곳 → ${OUT_PATH}`, JSON.stringify(reasons));
}

if (STEP === 'search' || STEP === 'all') await stepSearch();
if (STEP === 'details' || STEP === 'all') await stepDetails();
if (STEP === 'select' || STEP === 'all') stepSelect();
