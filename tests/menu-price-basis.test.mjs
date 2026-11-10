// 카카오맵 메뉴판 가격의 1인/세트 기준 추정 규칙 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMenuPriceBasis } from '../tools/menu-price-basis.mjs';

const cases = [
  // 최소 주문 안내는 1인 가격
  ['소갈비찜 (1인분)(2인부터)', 28000, 'per_person'],
  ['콩나물 제육 백반 (2인이상)', 10000, 'per_person'],
  ['C코스 (2人이상/1인가격)', 39000, 'per_person'],
  ['맑은 버섯 칼국수(2인부터)', 10000, 'per_person'],
  // 명시적 1인
  ['생갈비 (1인분)', 80000, 'per_person'],
  ['한정식 한상 (1인) (점심)', 25000, 'per_person'],
  // 여러 명 세트·코스
  ['어부해산물 한정식 (2인)', 100000, 'per_set'],
  ['감자튀김 (2-3인분)', 5900, 'per_set'],
  // 나눠 먹는 요리
  ['깐풍기', 25000, 'per_set'],
  ['유산슬', 32000, 'per_set'],
  ['탕수육 (소)', 9000, 'per_set'],
  ['감자탕', 31000, 'per_set'],
  ['해물파전', 15000, 'per_set'],
  ['모듬생선구이', 30000, 'per_set'],
  ['후라이드', 20000, 'per_set'],
  // 나눠 먹는 요리 이름이 들어간 한 그릇 음식
  ['치킨마요덮밥', 7500, 'per_person'],
  ['명동진보쌈 정식', 14000, 'per_person'],
  // 크기 표시: 한 그릇 음식은 1인, 그 밖은 접시
  ['냉콩칼국수(여름)(소)', 7000, 'per_person'],
  ['한우곰탕 (특)', 11000, 'per_person'],
  ['물만두(중)', 8000, 'per_set'],
  ['엄마손 보쌈 (소)', 14000, 'per_set'],
  // 고기 1인분 무게
  ['대패삼겹살(200g)', 13000, 'per_person'],
  ['LA갈비(150g)', 14000, 'per_person'],
  // 수량 묶음
  ['고기만두(1판)(8개)', 5000, 'per_set'],
  ['표고버섯전(한접시)', 10000, 'per_set'],
  ['[판매1위]돈&쫄면매운맛', 14900, 'per_person'],
  // 1인 세트와 단품
  ['이순신버거 (세트)', 8500, 'per_person'],
  ['고구마치즈롤까스세트', 14000, 'per_person'],
  ['두부전골', 13000, 'per_person'],
  ['꼬리곰탕', 25000, 'per_person'],
  ['극상 장어덮밥', 33000, 'per_person'],
  ['돈까스', 9500, 'per_person'],
  // 인원 범위 표시는 나눠 먹는 접시
  ['불쭈차돌철판(2인~3인)', 37000, 'per_set'],
  // 곁들이·안주 (1인 가격 비교에 쓰지 않는다)
  ['부추전', 7000, 'per_set'],
  ['녹두빈대떡', 11000, 'per_set'],
  ['도토리묵', 10000, 'per_set'],
  ['찐만두', 6000, 'per_set'],
  ['마르게리따피자', 17500, 'per_set'],
  ['뿔소라무침', 18000, 'per_set'],
  ['어묵', 4000, 'per_person'],
  ['만두국', 8000, 'per_person'],
  ['순대국밥', 9000, 'per_person'],
  ['묵사발', 8000, 'per_person'],
  // 한 그릇 음식 (파스타·샐러드·갈비탕·점심 특선)
  ['바질크림새우스파스타', 15300, 'per_person'],
  ['아몬드치킨샐러드', 15500, 'per_person'],
  ['갈비탕(특)', 15000, 'per_person'],
  ['런치A세트-샤브샤브(전각)', 16900, 'per_person'],
  ['꼬막무침밥상', 23000, 'per_person'],
  // 이름에 단서가 없는 고가 메뉴는 세트로 본다
  ['한우 모둠구이', 89000, 'per_set'],
  ['스페셜', 45000, 'per_set']
];

test('메뉴 이름·금액으로 1인/세트 가격 기준을 추정한다', () => {
  for (const [name, price, expected] of cases) {
    assert.equal(classifyMenuPriceBasis(name, price), expected, `${name} ${price}원`);
  }
});
