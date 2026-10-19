// 전국 초등학교 현장체험학습·수학여행·전국소년체육대회 권역별 지역 정의와 기준점(체험처·박물관·경기장) 데이터
// (예전에 함께 있던 '초등·선수단 맞춤 식당' 88곳은 카카오맵에 없는 식당이어서 2026-10-19에 삭제함)

export const NATIONWIDE_EXTRA_REGIONS = [
  {
    regionCode: 'gyeonggi-suwon',
    parentCode: 'gyeonggi',
    sidoName: '경기도',
    level: 'sigungu',
    name: '수원·용인',
    shortName: '수원·용인',
    aliases: ['수원', '수원시', '용인', '용인시', '경기 수원', '경기도 수원시', '수원화성'],
    center: { lat: 37.2859, lng: 127.0153, zoomLevel: 8 },
    bounds: { sw: { lat: 37.20, lng: 126.95 }, ne: { lat: 37.35, lng: 127.22 } }
  },
  {
    regionCode: 'incheon-junggu',
    parentCode: 'incheon',
    sidoName: '인천광역시',
    level: 'sigungu',
    name: '인천 중구·송도',
    shortName: '인천',
    aliases: ['인천', '인천 중구', '송도', '개항장', '인천광역시 중구'],
    center: { lat: 37.4738, lng: 126.6215, zoomLevel: 8 },
    bounds: { sw: { lat: 37.38, lng: 126.58 }, ne: { lat: 37.52, lng: 126.68 } }
  },
  {
    regionCode: 'gw-chuncheon',
    parentCode: 'gw',
    sidoName: '강원특별자치도',
    level: 'sigungu',
    name: '춘천시',
    shortName: '춘천',
    aliases: ['춘천', '춘천시', '강원 춘천', '강원특별자치도 춘천시'],
    center: { lat: 37.8813, lng: 127.7298, zoomLevel: 8 },
    bounds: { sw: { lat: 37.80, lng: 127.65 }, ne: { lat: 37.95, lng: 127.82 } }
  },
  {
    regionCode: 'daejeon-yuseong',
    parentCode: 'daejeon',
    sidoName: '대전광역시',
    level: 'sigungu',
    name: '대전 유성구',
    shortName: '대전 유성',
    aliases: ['대전', '유성', '유성구', '대전 유성구', '대전광역시 유성구', '국립중앙과학관'],
    center: { lat: 36.3756, lng: 127.3765, zoomLevel: 8 },
    bounds: { sw: { lat: 36.32, lng: 127.30 }, ne: { lat: 36.42, lng: 127.42 } }
  },
  {
    regionCode: 'cn-gongju',
    parentCode: 'cn',
    sidoName: '충청남도',
    level: 'sigungu',
    name: '공주·부여',
    shortName: '공주·부여',
    aliases: ['공주', '공주시', '부여', '부여군', '충남 공주', '충청남도 공주시'],
    center: { lat: 36.4565, lng: 127.1192, zoomLevel: 8 },
    bounds: { sw: { lat: 36.26, lng: 126.88 }, ne: { lat: 36.52, lng: 127.20 } }
  },
  {
    regionCode: 'daegu-junggu',
    parentCode: 'daegu',
    sidoName: '대구광역시',
    level: 'sigungu',
    name: '대구 중구·수성구',
    shortName: '대구',
    aliases: ['대구', '대구 중구', '대구 수성구', '대구광역시'],
    center: { lat: 35.8685, lng: 128.5986, zoomLevel: 8 },
    bounds: { sw: { lat: 35.81, lng: 128.54 }, ne: { lat: 35.91, lng: 128.68 } }
  },
  {
    regionCode: 'gn-tongyeong',
    parentCode: 'gn',
    sidoName: '경상남도',
    level: 'sigungu',
    name: '통영·거제',
    shortName: '통영·거제',
    aliases: ['통영', '통영시', '거제', '거제시', '경남 통영', '경상남도 통영시'],
    center: { lat: 34.8544, lng: 128.4332, zoomLevel: 8 },
    bounds: { sw: { lat: 34.78, lng: 128.36 }, ne: { lat: 34.92, lng: 128.65 } }
  }
];

export const NATIONWIDE_VENUES_BY_REGION = {
  'seoul-jongno': [
    {
      id: 'venue-seoul-gyeongbokgung',
      name: '경복궁·국립고궁박물관',
      type: 'attraction',
      typeLabel: '현장체험학습지·박물관',
      regionCode: 'seoul-jongno',
      address: '서울특별시 종로구 사직로 161',
      location: { lat: 37.5796, lng: 126.9770, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-seoul-history-museum',
      name: '서울역사박물관·광화문광장',
      type: 'attraction',
      typeLabel: '현장체험학습지·박물관',
      regionCode: 'seoul-jongno',
      address: '서울특별시 종로구 새문안로 55',
      location: { lat: 37.5704, lng: 126.9706, status: 'verified' },
      eventRefs: []
    }
  ],
  'gyeonggi-suwon': [
    {
      id: 'venue-suwon-hwaseong',
      name: '수원화성 행궁·박물관',
      type: 'attraction',
      typeLabel: '현장체험학습지·유적지',
      regionCode: 'gyeonggi-suwon',
      address: '경기도 수원시 팔달구 정조로 825',
      location: { lat: 37.2827, lng: 127.0136, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-suwon-stadium',
      name: '수원종합운동장',
      type: 'stadium',
      typeLabel: '운동장·체육관',
      regionCode: 'gyeonggi-suwon',
      address: '경기도 수원시 장안구 경수대로 893',
      location: { lat: 37.2978, lng: 127.0113, status: 'verified' },
      eventRefs: []
    }
  ],
  'incheon-junggu': [
    {
      id: 'venue-incheon-openport',
      name: '인천개항장 역사문화의거리·박물관',
      type: 'attraction',
      typeLabel: '현장체험학습지·박물관',
      regionCode: 'incheon-junggu',
      address: '인천광역시 중구 신포로23번길 89',
      location: { lat: 37.4731, lng: 126.6218, status: 'verified' },
      eventRefs: []
    }
  ],
  'gw-gangneung': [
    {
      id: 'venue-gangneung-ojukheon',
      name: '강릉 오죽헌·시립박물관',
      type: 'attraction',
      typeLabel: '수학여행·체험학습지',
      regionCode: 'gw-gangneung',
      address: '강원특별자치도 강릉시 율곡로3139번길 24',
      location: { lat: 37.7792, lng: 128.8795, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-gangneung-stadium',
      name: '강릉종합운동장',
      type: 'stadium',
      typeLabel: '운동장·체육관',
      regionCode: 'gw-gangneung',
      address: '강원특별자치도 강릉시 종합운동장길 69',
      location: { lat: 37.7736, lng: 128.8975, status: 'verified' },
      eventRefs: []
    }
  ],
  'gw-chuncheon': [
    {
      id: 'venue-chuncheon-museum',
      name: '국립춘천박물관',
      type: 'attraction',
      typeLabel: '현장체험학습지·박물관',
      regionCode: 'gw-chuncheon',
      address: '강원특별자치도 춘천시 우석로 70',
      location: { lat: 37.8639, lng: 127.7524, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-chuncheon-songam',
      name: '춘천송암스포츠타운',
      type: 'stadium',
      typeLabel: '운동장·체육관',
      regionCode: 'gw-chuncheon',
      address: '강원특별자치도 춘천시 스포츠타운길 136',
      location: { lat: 37.8554, lng: 127.6908, status: 'verified' },
      eventRefs: []
    }
  ],
  'daejeon-yuseong': [
    {
      id: 'venue-daejeon-science',
      name: '국립중앙과학관',
      type: 'attraction',
      typeLabel: '현장체험학습지·과학관',
      regionCode: 'daejeon-yuseong',
      address: '대전광역시 유성구 대덕대로 481',
      location: { lat: 36.3758, lng: 127.3766, status: 'verified' },
      eventRefs: []
    }
  ],
  'cn-gongju': [
    {
      id: 'venue-gongju-museum',
      name: '국립공주박물관·무령왕릉',
      type: 'attraction',
      typeLabel: '수학여행·역사유적지',
      regionCode: 'cn-gongju',
      address: '충청남도 공주시 관광단지길 34',
      location: { lat: 36.4658, lng: 127.1125, status: 'verified' },
      eventRefs: []
    }
  ],
  'gb-gyeongju': [
    {
      id: 'venue-gyeongju-museum',
      name: '국립경주박물관·대릉원',
      type: 'attraction',
      typeLabel: '수학여행·역사유적지',
      regionCode: 'gb-gyeongju',
      address: '경상북도 경주시 일정로 186',
      location: { lat: 35.8294, lng: 129.2280, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-gyeongju-bulguksa',
      name: '경주 불국사',
      type: 'attraction',
      typeLabel: '수학여행·역사유적지',
      regionCode: 'gb-gyeongju',
      address: '경상북도 경주시 불국로 385',
      location: { lat: 35.7901, lng: 129.3320, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-gyeongju-stadium',
      name: '경주황성공원 시민운동장',
      type: 'stadium',
      typeLabel: '운동장·체육관',
      regionCode: 'gb-gyeongju',
      address: '경상북도 경주시 원화로 476',
      location: { lat: 35.8617, lng: 129.2108, status: 'verified' },
      eventRefs: []
    }
  ],
  'daegu-junggu': [
    {
      id: 'venue-daegu-modern-alley',
      name: '대구 근대역사관·경상감영공원',
      type: 'attraction',
      typeLabel: '현장체험학습지·박물관',
      regionCode: 'daegu-junggu',
      address: '대구광역시 중구 경상감영길 67',
      location: { lat: 35.8719, lng: 128.5916, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-daegu-stadium',
      name: '대구스타디움',
      type: 'stadium',
      typeLabel: '운동장·체육관',
      regionCode: 'daegu-junggu',
      address: '대구광역시 수성구 유니버시아드로 180',
      location: { lat: 35.8297, lng: 128.6902, status: 'verified' },
      eventRefs: []
    }
  ],
  'busan-haeundae': [
    {
      id: 'venue-busan-science',
      name: '국립부산과학관·해운대해수욕장',
      type: 'attraction',
      typeLabel: '현장체험학습지·과학관',
      regionCode: 'busan-haeundae',
      address: '부산광역시 기장군 기장읍 동부산관광6로 59',
      location: { lat: 35.2044, lng: 129.2127, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-busan-bexco',
      name: '벡스코·시립미술관 체험학습장',
      type: 'attraction',
      typeLabel: '현장체험학습지·전시관',
      regionCode: 'busan-haeundae',
      address: '부산광역시 해운대구 APEC로 55',
      location: { lat: 35.1691, lng: 129.1360, status: 'verified' },
      eventRefs: []
    }
  ],
  'gn-tongyeong': [
    {
      id: 'venue-tongyeong-yisunsin',
      name: '통영 이순신공원·삼도수군통제영',
      type: 'attraction',
      typeLabel: '수학여행·역사유적지',
      regionCode: 'gn-tongyeong',
      address: '경상남도 통영시 멘데해안길 205',
      location: { lat: 34.8535, lng: 128.4408, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-tongyeong-stadium',
      name: '통영공설운동장',
      type: 'stadium',
      typeLabel: '운동장·체육관',
      regionCode: 'gn-tongyeong',
      address: '경상남도 통영시 북신공원길 61',
      location: { lat: 34.8628, lng: 128.4310, status: 'verified' },
      eventRefs: []
    }
  ],
  'jb-jeonju': [
    {
      id: 'venue-jeonju-hanok',
      name: '전주한옥마을·경기전',
      type: 'attraction',
      typeLabel: '수학여행·현장체험학습지',
      regionCode: 'jb-jeonju',
      address: '전북특별자치도 전주시 완산구 태조로 44',
      location: { lat: 35.8151, lng: 127.1530, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-jeonju-museum',
      name: '국립전주박물관',
      type: 'attraction',
      typeLabel: '현장체험학습지·박물관',
      regionCode: 'jb-jeonju',
      address: '전북특별자치도 전주시 완산구 쑥고개로 249',
      location: { lat: 35.8012, lng: 127.0897, status: 'verified' },
      eventRefs: []
    }
  ],
  'gj-donggu': [
    {
      id: 'venue-gwangju-acc',
      name: '국립아시아문화전당 어린이문화원',
      type: 'attraction',
      typeLabel: '초등 현장체험학습지',
      regionCode: 'gj-donggu',
      address: '광주광역시 동구 문화전당로 38',
      location: { lat: 35.1468, lng: 126.9203, status: 'verified' },
      eventRefs: []
    }
  ],
  'jn-mokpo': [
    {
      id: 'venue-mokpo-maritime',
      name: '국립해양유물전시관·목포자연사박물관',
      type: 'attraction',
      typeLabel: '초등 현장체험학습지·박물관',
      regionCode: 'jn-mokpo',
      address: '전라남도 목포시 남농로 136',
      location: { lat: 34.7931, lng: 126.4232, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-mokpo-stadium',
      name: '목포종합경기장',
      type: 'stadium',
      typeLabel: '운동장·체육관',
      regionCode: 'jn-mokpo',
      address: '전라남도 목포시 대양로 386',
      location: { lat: 34.8286, lng: 126.4161, status: 'verified' },
      eventRefs: []
    }
  ],
  'jn-goheung': [
    {
      id: 'venue-goheung-naro',
      name: '고흥 나로우주센터 우주과학관',
      type: 'attraction',
      typeLabel: '초등 현장체험학습지·과학관',
      regionCode: 'jn-goheung',
      address: '전라남도 고흥군 봉래면 하반로 490',
      location: { lat: 34.4426, lng: 127.5284, status: 'verified' },
      eventRefs: []
    }
  ],
  'jj-jeju': [
    {
      id: 'venue-jeju-museum',
      name: '국립제주박물관·사라봉공원',
      type: 'attraction',
      typeLabel: '수학여행·체험학습지',
      regionCode: 'jj-jeju',
      address: '제주특별자치도 제주시 일주동로 17',
      location: { lat: 33.5133, lng: 126.5489, status: 'verified' },
      eventRefs: []
    },
    {
      id: 'venue-jeju-stadium',
      name: '제주종합경기장',
      type: 'stadium',
      typeLabel: '운동장·체육관',
      regionCode: 'jj-jeju',
      address: '제주특별자치도 제주시 서광로2길 24',
      location: { lat: 33.4975, lng: 126.5142, status: 'verified' },
      eventRefs: []
    }
  ]
};
