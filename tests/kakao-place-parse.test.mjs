// 카카오맵 장소 상세 해석 규칙 검증 (정기 재확인·지역 보강 도구 공용)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactFacilities, parseKakaoFacilities, parseKakaoOpenHours } from '../tools/kakao-place-parse.mjs';

const day = (label, on) => (on ? { day_of_the_week_desc: `${label}(11/2)`, on_days: on } : { day_of_the_week_desc: `${label}(11/2)`, off_days_desc: '휴무일' });
const week = days => ({ week_from_today: { week_periods: [{ days }] } });

test('요일별 영업시간을 앱의 영업시간 원문으로 바꾼다 (브레이크타임·휴무·라스트오더)', () => {
  const lunchDinner = { start_end_time_desc: '11:00 ~ 21:00', break_times_desc: ['15:00 ~ 17:00 브레이크타임'], last_order_times_desc: ['20:30 라스트오더'] };
  const r = parseKakaoOpenHours(week([day('월', lunchDinner), day('화', lunchDinner), day('수', lunchDinner), day('목', lunchDinner), day('금', lunchDinner),
    day('토', { start_end_time_desc: '11:00 ~ 15:00' }), day('일', null)]));
  assert.equal(r.hours, '월~금 11:00-15:00 17:00-21:00 / 토 11:00-15:00');
  assert.equal(r.closed, '일');
  assert.equal(r.lastOrder.월, '20:30');

  const everyday = { start_end_time_desc: '10:00 ~ 22:00' };
  assert.deepEqual(parseKakaoOpenHours(week(['월', '화', '수', '목', '금', '토', '일'].map(d => day(d, everyday)))), { hours: '매일 10:00-22:00', closed: '연중무휴', lastOrder: {} });
  // 7일 정보가 다 없거나 24시간이면 해석하지 않는다
  assert.equal(parseKakaoOpenHours(week([day('월', everyday)])), null);
  assert.equal(parseKakaoOpenHours(week(['월', '화', '수', '목', '금', '토', '일'].map(d => day(d, { start_end_time_desc: '00:00 ~ 24:00' })))), null);
});

test('편의시설·좌석 옵션 표시에서 단체석·룸·주차 등을 읽는다', () => {
  const panel = {
    place_add_info: {
      ai_mate: { store_facility_icons: [{ text: '주차가능' }, { text: '예약가능' }], store_infos: [{ title: '주차', summary: '가게 앞 10대 주차 가능' }] },
      full_detail_infos: [{ title: '좌석 옵션', items: [{ icon: { text: '단체석' }, contents: [{ label: '단체석' }] }, { icon: { text: '프라이빗룸' }, contents: [] }] }],
      simple_detail_infos: [{ text: '유아의자' }]
    }
  };
  const f = parseKakaoFacilities(panel);
  assert.equal(f.group, true);
  assert.equal(f.room, true);
  assert.equal(f.parking, true);
  assert.equal(f.reserve, true);
  assert.equal(f.kidChair, true);
  assert.equal(f.takeout, false);
  assert.deepEqual(compactFacilities(f), { group: true, room: true, parking: true, reserve: true, kidChair: true, parkingNote: '가게 앞 10대 주차 가능' });
  // '주차장없음'이 있으면 주차 불가로 본다
  assert.equal(parseKakaoFacilities({ place_add_info: { ai_mate: { store_facility_icons: [{ text: '주차가능' }, { text: '주차장없음' }] } } }).parking, false);
  // AI 요약의 좌석 옵션(하위 목록)도 읽는다
  assert.equal(parseKakaoFacilities({ ai_mate: { bottom_sheet: { sheets: [{ title: '제공 서비스', list: [{ title: '좌석 옵션', keywords: ['단체석'] }] }] } } }).group, true);
});

test('정기 재확인 사람 확인 결과 파일 형식', async () => {
  const fs = await import('node:fs');
  const review = JSON.parse(fs.readFileSync(new URL('../tools/kakao-recheck-review.json', import.meta.url), 'utf8'));
  assert.equal(typeof review.decisions, 'object');
  for (const [id, d] of Object.entries(review.decisions)) {
    assert.match(id, /^ysk-r-/, `${id}: 식당 ID 형식`);
    assert.ok(['remove', 'keep'].includes(d.action), `${id}: action은 remove 또는 keep`);
    assert.match(String(d.checkedAt || ''), /^\d{4}-\d{2}-\d{2}$/, `${id}: checkedAt 날짜`);
    assert.ok(String(d.reason || '').trim(), `${id}: reason 필요`);
  }
});
