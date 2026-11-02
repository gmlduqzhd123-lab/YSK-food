// 카카오맵 메뉴판 가격이 1인 기준(per_person)인지, 여럿이 나눠 먹는 세트·접시 기준(per_set)인지 메뉴 이름과 금액으로 추정한다.
// 카카오맵은 가격 기준을 알려주지 않으므로 추정값이며, 화면에는 '1인 기준'/'세트 기준'으로 표시하고 방문 전 확인을 안내한다.

// 'N인 이상', 'N인부터', '1인 가격' 같은 최소 주문 안내 → 가격은 1인 기준
const MIN_ORDER_NOTE = /\d\s*(인|人)\s*(이상|부터|~)|1\s*(인|人)\s*(가격|기준|분)|1\s*(인|人)\s*\)/;
// 명시적인 1인·1인분
const ONE_PERSON = /(^|[^\d])1\s*(인|人)(분)?($|[^\d이부~])|1인분|1인용|1인상|1인세트|혼밥|1그릇/;
// 2인 이상이 먹는 세트·코스 표시 (최소 주문 안내가 아닌 경우)
const MULTI_PERSON = /([2-9]|1\d)\s*(인|人)(분|용|세트|상|\s*세트)?(?!\s*(이상|부터|~))|가족|패밀리|커플|파티|단체/;
// 크기 표시: (대)(중)(소)(특), 대/중/소 단독, L/M/S, 라지·미디움
const SIZE_MARK = /\((대|중|소|특|大|中|小)\)|(^|\s)(대|중|소|특)(\s|$)|\b(L|M|S)\b|라지|미디움|레귤러/;
// 수량 묶음: 한마리·반마리·N마리·판·접시·kg·근·N개(5개 이상)·N pcs
const BUNDLE = /한\s*마리|반\s*마리|\d\s*마리|kg|\d\s*근|접시|\d\s*판|(^|[^가-힣])판($|[^가-힣매])|([5-9]|\d{2})\s*개|\d+\s*pcs/i;
// 여럿이 나눠 먹는 요리 (1인 표시가 없으면 접시 기준)
const SHARE_DISH = /모듬|모둠|탕수육|깐풍|유산슬|라조|팔보채|양장피|난자완스|고추잡채|유린기|칠리새우|크림새우|깐쇼|보쌈|족발|수육|머리고기|편육|삼합|아구찜|아귀찜|해물찜|갈비찜(?!.*정식)|닭볶음탕|닭도리탕|찜닭|백숙|감자탕|파전|해물전|모둠전|모듬전|전\s*\(|치킨|통닭|후라이드|양념반|반반|강정|회\s*\(|모둠회|모듬회|생선회|활어|물회\s*\(대|코스|오마카세|한상|상차림|세트메뉴|전골\s*\(|샤브샤브\s*\(/;
// 한 그릇 음식: 크기 표시가 있어도 1인 기준으로 본다 (칼국수(소) 등)
const SINGLE_BOWL = /칼국수|수제비|국수|냉면|밀면|쫄면|우동|라면|라멘|소바|짜장|자장|짬뽕|쌀국수|국밥|해장국|곰탕|설렁탕|육개장|순대국|순댓국|뼈해장|덮밥|비빔밥|볶음밥|김밥|백반|정식|돈가스|돈까스|카츠|오므라이스|카레|버거|찌개|뚝배기/;
// 단품에 붙는 세트(음료·감자 포함 1인 세트)
const SINGLE_SET = /세트/;
// 고기 1인분 무게(100~300g)
const GRAM = /(\d{2,4})\s*g/i;

export function classifyMenuPriceBasis(name, priceKRW) {
  const n = String(name || '');
  const price = Number(priceKRW) || 0;

  if (MIN_ORDER_NOTE.test(n)) return 'per_person';
  if (ONE_PERSON.test(n)) return 'per_person';
  if (MULTI_PERSON.test(n)) return 'per_set';

  const gram = GRAM.exec(n);
  if (gram) {
    const g = Number(gram[1]);
    if (g >= 100 && g <= 300 && price < 40000) return 'per_person';
    if (g > 300) return 'per_set';
  }

  if (BUNDLE.test(n)) return 'per_set';
  if (SIZE_MARK.test(n)) return SINGLE_BOWL.test(n) && !SHARE_DISH.test(n) && price < 20000 ? 'per_person' : 'per_set';
  // 나눠 먹는 요리 이름이 들어가도 덮밥·정식·돈가스처럼 한 그릇 음식이면 1인 기준 (치킨마요덮밥, 보쌈 정식 등)
  if (SHARE_DISH.test(n)) return SINGLE_BOWL.test(n) && price < 20000 ? 'per_person' : 'per_set';
  if (SINGLE_SET.test(n)) return price < 20000 ? 'per_person' : 'per_set';
  if (/전골/.test(n)) return price < 20000 ? 'per_person' : 'per_set';
  if (price >= 35000) return 'per_set';
  return 'per_person';
}
