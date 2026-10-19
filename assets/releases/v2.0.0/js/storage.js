// localStorage 단일 이전(AC43), IndexedDB revision 낙관적 동시성 트랜잭션(AC45), 백업·복원 원자성(AC22, AC46), 사본 개인 ID 전체 재매핑(AC44), 허용 목록 공유 직렬화(AC23, AC55), 스냅샷 보존(AC20)
import {
  IDB_NAME,
  IDB_VERSION,
  LEGACY_FAV_STORAGE_KEY,
  LEGACY_GEO_CACHE_KEY,
  GEO_CACHE_KEY_V2,
  PERSONAL_SCHEMA_VERSION,
  SOURCE_APP,
  UI_STORAGE_KEY
} from './config.js';
import {
  isValidCoordinate,
  isValidEntityId,
  validateBackupEnvelope,
  validatePersonalEventObject,
  validateShareEnvelope
} from './data/normalize.js';

let idCounter = 1;
export function generatePersonalId(prefix = 'p') {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36);
  const seq = (idCounter++).toString(36);
  return `${prefix}-${ts}-${seq}-${rand}`.toLowerCase().slice(0, 78);
}

/**
 * 기본 UI 상태 구조(ysk-food-ui-v2)
 */
export function createDefaultUiState() {
  return {
    schemaVersion: PERSONAL_SCHEMA_VERSION,
    favoriteIds: [],
    settings: {
      mode: 'general',
      recentRegions: ['all'],
      includeNeedsCheck: true,
      sortBy: 'default'
    },
    unresolvedFavorites: [],
    migrationState: {
      completed: false,
      migratedAt: null,
      sourceKey: LEGACY_FAV_STORAGE_KEY
    }
  };
}

/**
 * 구형 즐겨찾기(ysk-food-favorites)를 ysk-food-ui-v2로 1회 원자적 이전한다(Section 8.4, AC02, AC43).
 * - 원본 ysk-food-favorites는 삭제하지 않고 보존한다.
 * - migrationState.completed === true 이면 다음 실행에서 구형 원본을 다시 합산하지 않는다(삭제한 즐겨찾기 부활 방지).
 * - 저장 실패 시 완료 표시를 남기지 않는다.
 */
export function loadAndMigrateUiState(legacyAliases = null, storage = globalThis.localStorage) {
  const fallbackState = createDefaultUiState();
  if (!storage) {
    return { persisted: false, state: fallbackState, error: new Error('localStorage를 사용할 수 없습니다.') };
  }

  let existingV2 = null;
  try {
    const rawV2 = storage.getItem(UI_STORAGE_KEY);
    if (rawV2) {
      existingV2 = JSON.parse(rawV2);
    }
  } catch {
    existingV2 = null;
  }

  // 이미 이전이 완료된 상태면 구형 원본을 다시 읽거나 합산하지 않는다(AC43)
  if (existingV2 && existingV2.migrationState?.completed === true) {
    return {
      persisted: true,
      alreadyMigrated: true,
      state: {
        schemaVersion: PERSONAL_SCHEMA_VERSION,
        favoriteIds: Array.isArray(existingV2.favoriteIds) ? existingV2.favoriteIds : [],
        settings: { ...fallbackState.settings, ...(existingV2.settings || {}) },
        unresolvedFavorites: Array.isArray(existingV2.unresolvedFavorites) ? existingV2.unresolvedFavorites : [],
        migrationState: existingV2.migrationState
      }
    };
  }

  // 구형 ysk-food-favorites 읽기
  let legacyItems = [];
  try {
    const rawLegacy = storage.getItem(LEGACY_FAV_STORAGE_KEY);
    if (rawLegacy) {
      const parsed = JSON.parse(rawLegacy);
      if (Array.isArray(parsed)) legacyItems = parsed;
    }
  } catch {
    legacyItems = [];
  }

  const favoriteIdsSet = new Set(Array.isArray(existingV2?.favoriteIds) ? existingV2.favoriteIds : []);
  const unresolvedList = Array.isArray(existingV2?.unresolvedFavorites) ? [...existingV2.unresolvedFavorites] : [];
  const seenUnresolvedKeys = new Set(unresolvedList.map(u => u.legacyKey));

  // 별칭 색인이 아직 없는데 구형 항목이 있는 경우 이전 완료로 표시하지 않고 보류한다
  if (legacyItems.length > 0 && !legacyAliases) {
    return {
      persisted: false,
      alreadyMigrated: false,
      state: existingV2 || fallbackState,
      deferredReason: 'LEGACY_ALIASES_NOT_LOADED'
    };
  }

  for (const item of legacyItems) {
    const key = String(item || '').trim();
    if (!key) continue;

    if (isValidEntityId(key) && key.startsWith('ysk-r-')) {
      favoriteIdsSet.add(key);
      continue;
    }

    const candidates =
      legacyAliases?.favoriteKeys?.[key] ||
      legacyAliases?.placeNames?.[key] ||
      [];

    if (candidates.length === 1 && isValidEntityId(candidates[0])) {
      favoriteIdsSet.add(candidates[0]);
    } else if (!seenUnresolvedKeys.has(key)) {
      seenUnresolvedKeys.add(key);
      unresolvedList.push({
        legacyKey: key,
        reason: candidates.length > 1 ? 'ambiguous' : 'no_match',
        candidateIds: [...candidates],
        recordedAt: new Date().toISOString()
      });
    }
  }

  const nextState = {
    schemaVersion: PERSONAL_SCHEMA_VERSION,
    favoriteIds: [...favoriteIdsSet],
    settings: { ...fallbackState.settings, ...(existingV2?.settings || {}) },
    unresolvedFavorites: unresolvedList,
    migrationState: {
      completed: true,
      migratedAt: new Date().toISOString(),
      sourceKey: LEGACY_FAV_STORAGE_KEY
    }
  };

  try {
    const serialized = JSON.stringify(nextState);
    storage.setItem(UI_STORAGE_KEY, serialized);
    const verifyRead = storage.getItem(UI_STORAGE_KEY);
    if (verifyRead !== serialized) {
      throw new Error('localStorage 쓰기 검증 실패');
    }
    return { persisted: true, alreadyMigrated: false, state: nextState };
  } catch (err) {
    // 저장 실패 시 완료 표시를 남기지 않는다(AC43)
    const uncompletedState = {
      ...nextState,
      migrationState: {
        completed: false,
        migratedAt: null,
        sourceKey: LEGACY_FAV_STORAGE_KEY
      }
    };
    return { persisted: false, alreadyMigrated: false, state: uncompletedState, error: err };
  }
}

export function saveUiState(uiState, storage = globalThis.localStorage) {
  if (!storage) {
    return { persisted: false, error: new Error('localStorage를 사용할 수 없습니다.') };
  }
  try {
    const serialized = JSON.stringify(uiState);
    storage.setItem(UI_STORAGE_KEY, serialized);
    if (storage.getItem(UI_STORAGE_KEY) !== serialized) {
      throw new Error('localStorage 검증 불일치');
    }
    return { persisted: true };
  } catch (err) {
    return { persisted: false, error: err };
  }
}

/**
 * 구형 위치 캐시(ysk-food-places-v1)를 식당 ID·주소 검증 상태와 대조해 이전한다(Section 8.7).
 * 무조건 신뢰하지 않고 좌표 범위가 유효한 경우에만 cached 상태로 보조 보관한다.
 */
export function migrateLegacyGeoCache(legacyAliases = null, storage = globalThis.localStorage) {
  if (!storage || !legacyAliases) return { migratedCount: 0, reviewNeeded: [] };
  let rawCache = {};
  try {
    rawCache = JSON.parse(storage.getItem(LEGACY_GEO_CACHE_KEY) || '{}');
  } catch {
    return { migratedCount: 0, reviewNeeded: [] };
  }

  const v2Cache = {};
  const reviewNeeded = [];
  let migratedCount = 0;

  for (const [legacyKey, entry] of Object.entries(rawCache)) {
    const candidates = legacyAliases.favoriteKeys?.[legacyKey] || [];
    if (candidates.length !== 1) {
      reviewNeeded.push({ legacyKey, reason: 'ambiguous_or_unmatched_id' });
      continue;
    }
    const restId = candidates[0];
    if (entry && !entry.miss && isValidCoordinate(Number(entry.lat), Number(entry.lng))) {
      v2Cache[restId] = {
        restaurantId: restId,
        lat: Number(entry.lat),
        lng: Number(entry.lng),
        link: entry.link || null,
        phone: entry.phone || null,
        status: 'cached',
        migratedFrom: legacyKey,
        checkedAt: entry.t ? new Date(entry.t).toISOString() : null
      };
      migratedCount++;
    } else {
      reviewNeeded.push({ legacyKey, restaurantId: restId, reason: 'invalid_or_missing_coords' });
    }
  }

  try {
    storage.setItem(GEO_CACHE_KEY_V2, JSON.stringify(v2Cache));
  } catch {
    // 저장 차단 시 무시
  }
  return { migratedCount, reviewNeeded, v2Cache };
}

/**
 * 식당 선택 시 개인 행사에 보존할 스냅샷(RestaurantSnapshot)을 생성한다(FR09, AC20).
 */
export function createRestaurantSnapshot(restaurant, candidateId, datasetVersion = 'unknown', sources = []) {
  const relevantEvidenceIds = new Set([
    ...(restaurant.groupProfile?.evidenceRefs || []),
    ...(restaurant.openingHours?.evidenceRefs || []),
    ...((restaurant.menus || []).flatMap(m => m.evidenceRefs || [])),
    ...((restaurant.officialDesignations || []).flatMap(d => d.evidenceRefs || []))
  ]);

  const matchedSources = (sources || [])
    .filter(s => relevantEvidenceIds.has(s.id))
    .map(s => ({
      id: s.id,
      kind: s.kind,
      checkedAt: s.checkedAt || null,
      attribution: s.attribution || null,
      url: s.url || null
    }));

  return {
    candidateId,
    restaurantId: restaurant.id,
    datasetVersion: datasetVersion || 'unknown',
    capturedAt: new Date().toISOString(),
    name: restaurant.name,
    branchName: restaurant.branchName || null,
    address: restaurant.address || '',
    phone: restaurant.phone || null,
    selectedMenus: structuredClone(restaurant.menus || []),
    publicFacts: {
      groupProfile: structuredClone(restaurant.groupProfile || {}),
      openingHours: structuredClone(restaurant.openingHours || {}),
      officialDesignations: structuredClone(restaurant.officialDesignations || []),
      location: structuredClone(restaurant.location || { lat: null, lng: null, status: 'unverified' }),
      sources: matchedSources
    }
  };
}

/**
 * 공개 데이터 변경·삭제가 개인 후보 스냅샷에 미치는 차이를 감지한다(AC20).
 * 스냅샷이나 확정 견적을 덮어쓰지 않고 재확인 안내만 생성한다.
 */
export function detectPublicDataChangesAgainstSnapshot(snapshot, publicResolution) {
  if (!snapshot) return { hasDiff: false, diffs: [] };

  if (!publicResolution || publicResolution.status === 'removed') {
    return {
      hasDiff: true,
      removedFromPublic: true,
      diffs: ['공개 데이터에서 제외(폐업·삭제)된 식당입니다.'],
      message: '이 식당은 최신 공개 자료에서 제외되었습니다. 저장된 스냅샷·견적은 그대로 보존되며, 식당 영업 여부를 직접 재확인해 주세요.'
    };
  }

  if (publicResolution.status !== 'found' || !publicResolution.restaurant) {
    return {
      hasDiff: false,
      removedFromPublic: false,
      diffs: [],
      message: '현재 공개 데이터를 확인할 수 없어 저장된 스냅샷 기준으로 표시합니다.'
    };
  }

  const pub = publicResolution.restaurant;
  const diffs = [];

  // 메뉴 가격 변경 확인
  const snapMenusById = new Map((snapshot.selectedMenus || []).map(m => [m.id, m]));
  for (const pubMenu of pub.menus || []) {
    const snapMenu = snapMenusById.get(pubMenu.id);
    if (snapMenu && snapMenu.priceKRW !== pubMenu.priceKRW) {
      diffs.push(
        `메뉴 '${pubMenu.name}' 공용 단가 변경: 스냅샷(${snapMenu.priceKRW ?? '미확인'}원) → 최신 공용(${pubMenu.priceKRW ?? '미확인'}원)`
      );
    }
  }

  // 단체 동시 수용 인원 변경 확인
  const snapCap = snapshot.publicFacts?.groupProfile?.simultaneousCapacity ?? null;
  const pubCap = pub.groupProfile?.simultaneousCapacity ?? null;
  if (snapCap !== pubCap) {
    diffs.push(`동시 수용 인원 변경: 스냅샷(${snapCap ?? '미확인'}명) → 최신 공용(${pubCap ?? '미확인'}명)`);
  }

  // 전화번호·주소 변경 확인
  if ((snapshot.phone || null) !== (pub.phone || null)) {
    diffs.push(`전화번호 변경: 스냅샷(${snapshot.phone || '미등록'}) → 최신 공용(${pub.phone || '미등록'})`);
  }

  return {
    hasDiff: diffs.length > 0,
    removedFromPublic: false,
    diffs,
    message: diffs.length > 0
      ? '공용 식당 자료가 변경되었습니다. 내 행사의 견적·스냅샷은 덮어쓰지 않고 보존됩니다. 변경 사항을 확인하세요.'
      : null
  };
}

/**
 * 별도 사본 가져오기 시 모든 개인 객체 ID를 새로 발급하고 내부 참조를 완전히 재연결한다(PRD Section 10, AC44).
 * 공용 식당·시설·메뉴 ID는 그대로 유지한다.
 */
export function remapEventForSeparateCopy(sourceEvent, options = {}) {
  const { resetConfirmationStatus = false, idFactory = generatePersonalId } = options;
  const idMap = new Map();

  const mapId = (oldId, prefix) => {
    if (!oldId) return null;
    if (!idMap.has(oldId)) {
      idMap.set(oldId, idFactory(prefix));
    }
    return idMap.get(oldId);
  };

  // 1단계: 모든 개인 객체의 구 ID -> 신 ID 매핑 테이블 생성
  const newEventId = mapId(sourceEvent.id, 'evt');
  for (const ag of sourceEvent.attendeeGroups || []) {
    mapId(ag.id, 'grp');
  }
  for (const vs of sourceEvent.venueSnapshots || []) {
    if (vs.personalVenueId) mapId(vs.personalVenueId, 'pven');
  }
  for (const mp of sourceEvent.mealPlans || []) {
    mapId(mp.id, 'mp');
    for (const w of mp.waves || []) {
      mapId(w.id, 'wave');
    }
    for (const lc of mp.lodgingConfirmations || []) {
      mapId(lc.id, 'lconf');
    }
    for (const cr of mp.candidateRecords || []) {
      mapId(cr.id, 'cand');
      for (const line of cr.orderDraft?.orderLines || []) {
        mapId(line.id, 'line');
      }
      for (const ch of cr.orderDraft?.charges || []) {
        mapId(ch.id, 'chg');
      }
      for (const dc of cr.orderDraft?.discounts || []) {
        mapId(dc.id, 'dsc');
      }
      for (const q of cr.quoteHistory || []) {
        mapId(q.id, 'quo');
        for (const ql of q.orderLines || []) {
          mapId(ql.id, 'qline');
        }
      }
      for (const conf of cr.confirmationHistory || []) {
        mapId(conf.id, 'conf');
      }
    }
  }

  // 2단계: 매핑 테이블을 이용해 모든 중첩 객체와 내부 참조를 일관되게 치환
  const remapped = structuredClone(sourceEvent);
  remapped.id = newEventId;
  remapped.revision = 1;
  remapped.createdAt = new Date().toISOString();
  remapped.updatedAt = remapped.createdAt;

  remapped.attendeeGroups = (remapped.attendeeGroups || []).map(ag => ({
    ...ag,
    id: idMap.get(ag.id) || ag.id
  }));

  remapped.mealPlans = (remapped.mealPlans || []).map(mp => {
    const newMpId = idMap.get(mp.id);
    const nextMp = {
      ...mp,
      id: newMpId,
      eventId: newEventId,
      diners: (mp.diners || []).map(d => ({
        ...d,
        groupId: idMap.get(d.groupId) || d.groupId
      })),
      waves: (mp.waves || []).map(w => ({
        ...w,
        id: idMap.get(w.id) || w.id,
        allocations: (w.allocations || []).map(a => ({
          ...a,
          groupId: idMap.get(a.groupId) || a.groupId
        }))
      })),
      selectedCandidateId: mp.selectedCandidateId ? (idMap.get(mp.selectedCandidateId) || null) : null,
      backupCandidateIds: (mp.backupCandidateIds || [])
        .map(bId => idMap.get(bId))
        .filter(Boolean),
      lodgingConfirmations: (mp.lodgingConfirmations || []).map(lc => ({
        ...lc,
        id: idMap.get(lc.id) || lc.id,
        mealPlanId: newMpId,
        referenceOnly: resetConfirmationStatus ? true : Boolean(lc.referenceOnly)
      }))
    };

    nextMp.candidateRecords = (mp.candidateRecords || []).map(cr => {
      const newCandId = idMap.get(cr.id);
      const snapshot = cr.restaurantSnapshot
        ? {
            ...structuredClone(cr.restaurantSnapshot),
            candidateId: newCandId,
            // 공용 식당 ID(restaurantId)와 공용 메뉴 ID는 그대로 유지(AC44)
            restaurantId: cr.restaurantId
          }
        : null;

      const orderDraft = {
        orderLines: (cr.orderDraft?.orderLines || []).map(l => ({
          ...l,
          id: idMap.get(l.id) || l.id,
          targetGroupId: l.targetGroupId ? (idMap.get(l.targetGroupId) || l.targetGroupId) : null
          // menuId(공용 메뉴 ID)는 그대로 유지
        })),
        charges: (cr.orderDraft?.charges || []).map(ch => ({
          ...ch,
          id: idMap.get(ch.id) || ch.id
        })),
        discounts: (cr.orderDraft?.discounts || []).map(dc => {
          let targetScope = dc.targetScope || 'total';
          if (targetScope.startsWith('group:')) {
            const oldG = targetScope.slice(6);
            if (idMap.has(oldG)) targetScope = `group:${idMap.get(oldG)}`;
          } else if (targetScope.startsWith('line:')) {
            const oldL = targetScope.slice(5);
            if (idMap.has(oldL)) targetScope = `line:${idMap.get(oldL)}`;
          }
          return {
            ...dc,
            id: idMap.get(dc.id) || dc.id,
            targetScope
          };
        }),
        updatedAt: cr.orderDraft?.updatedAt || remapped.updatedAt
      };

      const quoteHistory = (cr.quoteHistory || []).map(q => ({
        ...q,
        id: idMap.get(q.id) || q.id,
        candidateId: newCandId,
        orderLines: (q.orderLines || []).map(ql => ({
          ...ql,
          id: idMap.get(ql.id) || ql.id,
          targetGroupId: ql.targetGroupId ? (idMap.get(ql.targetGroupId) || ql.targetGroupId) : null
        }))
      }));

      const confirmationHistory = (cr.confirmationHistory || []).map(conf => {
        const nextSnap = conf.conditionsSnapshot ? structuredClone(conf.conditionsSnapshot) : null;
        if (nextSnap) {
          if (Array.isArray(nextSnap.diners)) {
            nextSnap.diners = nextSnap.diners.map(d => ({
              ...d,
              groupId: idMap.get(d.groupId) || d.groupId
            }));
          }
          if (Array.isArray(nextSnap.waves)) {
            nextSnap.waves = nextSnap.waves.map(w => ({
              ...w,
              id: idMap.get(w.id) || w.id
            }));
          }
        }
        return {
          ...conf,
          id: idMap.get(conf.id) || conf.id,
          mealPlanId: newMpId,
          candidateId: newCandId,
          providerId: cr.restaurantId, // 공용 식당 ID 유지
          quoteId: conf.quoteId ? (idMap.get(conf.quoteId) || null) : null,
          referenceOnly: resetConfirmationStatus ? true : Boolean(conf.referenceOnly),
          conditionsSnapshot: nextSnap
        };
      });

      return {
        ...cr,
        id: newCandId,
        mealPlanId: newMpId,
        restaurantId: cr.restaurantId, // 공용 식당 ID 유지
        inquiryStatus: resetConfirmationStatus ? 'none' : (cr.inquiryStatus || 'none'),
        restaurantSnapshot: snapshot,
        orderDraft,
        quoteHistory,
        confirmationHistory
      };
    });

    return nextMp;
  });

  const validationErrors = validatePersonalEventObject(remapped, 'remappedEvent');
  return {
    valid: validationErrors.length === 0,
    errors: validationErrors,
    event: remapped,
    idMap
  };
}

/**
 * 공유 사본(ShareEnvelope) 미리보기 및 허용 목록 직렬화 생성(FR09, AC23, AC55)
 * - 원본 복제 후 숨기는 방식을 쓰지 않고 선택한 필드로만 새 객체를 조립한다.
 * - 내부 메모(internalMemo, notes, paymentNotes, documentNotes, contactMemo)는 기본 제외한다.
 * - 확인 이력은 포함하고 견적 이력을 제외한 경우 quoteId를 null로 정규화하고 참고 안내를 남긴다.
 * - 미리보기(previewObject)와 실제 내보내기 JSON(envelope)의 범위가 100% 일치한다.
 */
export function buildShareEnvelope(sourceEvent, selection = {}) {
  const {
    includeSchedule = true,
    includeCandidates = true,
    includeOrderAndAmounts = true,
    includePublicContacts = true,
    includeQuoteHistory = false,
    includeConfirmationHistory = false,
    includeInternalMemos = false
  } = selection;

  // 유효한 공유 스키마로 만들 수 없는 선택 조합 검사(PRD 7절)
  if (!includeCandidates && (includeOrderAndAmounts || includeQuoteHistory || includeConfirmationHistory)) {
    return {
      valid: false,
      code: 'INVALID_SHARE_SELECTION',
      errors: ['주문·금액·견적·확인 이력을 공유하려면 후보 식당 포함(includeCandidates)을 함께 선택해야 합니다.']
    };
  }

  const selectedFields = Object.entries({
    includeSchedule,
    includeCandidates,
    includeOrderAndAmounts,
    includePublicContacts,
    includeQuoteHistory,
    includeConfirmationHistory,
    includeInternalMemos
  })
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k);

  // 허용된 필드만 골라 새 객체 생성 (중첩 메모 철저히 제외)
  const eventCopy = {
    id: sourceEvent.id,
    revision: sourceEvent.revision || 1,
    title: sourceEvent.title,
    eventType: sourceEvent.eventType || 'field_trip',
    dates: includeSchedule ? structuredClone(sourceEvent.dates || []) : [],
    attendeeGroups: (sourceEvent.attendeeGroups || []).map(ag => ({
      id: ag.id,
      role: ag.role || 'student',
      label: ag.label || ag.id,
      count: Number(ag.count || 0),
      budgetPerPersonKRW: includeOrderAndAmounts ? (ag.budgetPerPersonKRW ?? null) : null
    })),
    venueSnapshots: includeSchedule
      ? (sourceEvent.venueSnapshots || []).map(vs => ({
          id: vs.id,
          name: vs.name,
          type: vs.type,
          regionCode: vs.regionCode,
          address: vs.address,
          location: structuredClone(vs.location || null)
        }))
      : [],
    mealPlans: [],
    createdAt: sourceEvent.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (includeInternalMemos && sourceEvent.internalMemo) {
    eventCopy.internalMemo = sourceEvent.internalMemo;
  }

  eventCopy.mealPlans = (sourceEvent.mealPlans || []).map(mp => {
    const mpCopy = {
      id: mp.id,
      eventId: sourceEvent.id,
      revision: mp.revision || 1,
      date: mp.date,
      mealSlot: mp.mealSlot || 'lunch',
      label: mp.label || '',
      plannedStart: includeSchedule ? mp.plannedStart : null,
      plannedEnd: includeSchedule ? mp.plannedEnd : null,
      diners: (mp.diners || []).map(d => ({
        groupId: d.groupId,
        role: d.role || 'student',
        label: d.label || d.groupId,
        count: Number(d.count || 0),
        budgetPerPersonKRW: includeOrderAndAmounts ? (d.budgetPerPersonKRW ?? null) : null
      })),
      providerType: mp.providerType || 'restaurant',
      costTreatment: mp.costTreatment || 'separate',
      lodgingSnapshot: mp.lodgingSnapshot
        ? {
            venueId: mp.lodgingSnapshot.venueId || null,
            name: mp.lodgingSnapshot.name || '',
            address: mp.lodgingSnapshot.address || '',
            phone: includePublicContacts ? (mp.lodgingSnapshot.phone || null) : null
          }
        : null,
      lodgingCost: mp.lodgingCost && includeOrderAndAmounts
        ? {
            totalKRW: mp.lodgingCost.totalKRW ?? null,
            checkedAt: mp.lodgingCost.checkedAt || null,
            conditionsSnapshot: structuredClone(mp.lodgingCost.conditionsSnapshot || null),
            ...(includeInternalMemos && mp.lodgingCost.notes ? { notes: mp.lodgingCost.notes } : {})
          }
        : null,
      lodgingConfirmations: includeConfirmationHistory
        ? (mp.lodgingConfirmations || []).map(lc => ({
            id: lc.id,
            mealPlanId: mp.id,
            providerType: 'lodging',
            providerId: lc.providerId,
            candidateId: null,
            quoteId: null,
            mealPlanRevision: lc.mealPlanRevision || 1,
            kind: lc.kind,
            status: lc.status,
            referenceOnly: true, // 공유 사본에서는 항상 참고 이력으로 표시
            checkedAt: lc.checkedAt,
            recordedAt: lc.recordedAt,
            sequence: lc.sequence || 1,
            method: lc.method || 'phone',
            conditionsSnapshot: structuredClone(lc.conditionsSnapshot || {}),
            ...(includeInternalMemos && lc.notes ? { notes: lc.notes } : {})
          }))
        : [],
      candidateRecords: [],
      selectedCandidateId: includeCandidates ? (mp.selectedCandidateId || null) : null,
      backupCandidateIds: includeCandidates ? [...(mp.backupCandidateIds || [])] : [],
      seatingPolicy: mp.seatingPolicy || 'simultaneous_required',
      waves: includeSchedule
        ? (mp.waves || []).map(w => ({
            id: w.id,
            startTime: w.startTime || null,
            endTime: w.endTime || null,
            durationMinutes: w.durationMinutes ?? null,
            allocations: structuredClone(w.allocations || [])
          }))
        : [],
      travelLegs: includeSchedule
        ? (mp.travelLegs || []).map(tl => ({
            fromName: tl.fromName || '',
            toName: tl.toName || '',
            travelMinutes: tl.travelMinutes ?? null,
            checkedAt: tl.checkedAt || null
          }))
        : []
    };

    if (includeInternalMemos && mp.internalMemo) {
      mpCopy.internalMemo = mp.internalMemo;
    }

    if (includeCandidates) {
      mpCopy.candidateRecords = (mp.candidateRecords || []).map(cr => {
        const snap = cr.restaurantSnapshot;
        const cleanSnapshot = snap
          ? {
              candidateId: cr.id,
              restaurantId: cr.restaurantId,
              datasetVersion: snap.datasetVersion || 'unknown',
              capturedAt: snap.capturedAt,
              name: snap.name,
              branchName: snap.branchName || null,
              address: snap.address || '',
              phone: includePublicContacts ? (snap.phone || null) : null,
              selectedMenus: includeOrderAndAmounts ? structuredClone(snap.selectedMenus || []) : [],
              publicFacts: structuredClone(snap.publicFacts || {})
            }
          : null;

        const cleanOrderDraft = includeOrderAndAmounts
          ? {
              orderLines: (cr.orderDraft?.orderLines || []).map(l => ({
                id: l.id,
                targetGroupId: l.targetGroupId || null,
                menuId: l.menuId || null,
                menuName: l.menuName || l.description || '',
                unit: l.unit || '1인분',
                quantity: Number(l.quantity || 0),
                unitPriceKRW: l.unitPriceKRW ?? null
              })),
              charges: (cr.orderDraft?.charges || []).map(ch => ({
                id: ch.id,
                label: ch.label || '',
                amountKRW: ch.amountKRW ?? null
              })),
              discounts: (cr.orderDraft?.discounts || []).map(dc => ({
                id: dc.id,
                label: dc.label || '',
                targetScope: dc.targetScope || 'total',
                amountKRW: dc.amountKRW ?? 0
              })),
              updatedAt: cr.orderDraft?.updatedAt || new Date().toISOString()
            }
          : { orderLines: [], charges: [], discounts: [], updatedAt: new Date().toISOString() };

        const cleanQuotes = includeQuoteHistory
          ? (cr.quoteHistory || []).map(q => ({
              id: q.id,
              candidateId: cr.id,
              mealPlanRevision: q.mealPlanRevision || 1,
              quotedAt: q.quotedAt,
              validUntil: q.validUntil || null,
              orderLines: structuredClone(q.orderLines || []),
              charges: structuredClone(q.charges || []),
              discounts: structuredClone(q.discounts || []),
              ...(includeInternalMemos && q.paymentNotes ? { paymentNotes: q.paymentNotes } : {}),
              ...(includeInternalMemos && q.documentNotes ? { documentNotes: q.documentNotes } : {})
            }))
          : [];

        // 확인 이력은 포함하지만 견적 이력을 제외한 경우 quoteId를 null로 정규화하여 끊긴 참조 방지(PRD 7절, AC55)
        const cleanConfirmations = includeConfirmationHistory
          ? (cr.confirmationHistory || []).map(conf => {
              const normalizedQuoteId = includeQuoteHistory ? (conf.quoteId || null) : null;
              const confObj = {
                id: conf.id,
                mealPlanId: mp.id,
                providerType: conf.providerType || 'restaurant',
                providerId: cr.restaurantId,
                candidateId: cr.id,
                quoteId: normalizedQuoteId,
                mealPlanRevision: conf.mealPlanRevision || 1,
                kind: conf.kind,
                status: conf.status,
                referenceOnly: true, // 공유 사본 내보내기 시 참고용으로 명시
                checkedAt: conf.checkedAt,
                recordedAt: conf.recordedAt,
                sequence: conf.sequence || 1,
                method: conf.method || 'phone',
                conditionsSnapshot: structuredClone(conf.conditionsSnapshot || {})
              };
              if (!includeQuoteHistory && conf.quoteId) {
                confObj.quoteExcludedNotice = '공유 시 견적 이력이 제외되어 연결된 견적 참조(quoteId)가 생략되었습니다.';
              }
              if (includeInternalMemos && conf.notes) {
                confObj.notes = conf.notes;
              }
              return confObj;
            })
          : [];

        const candObj = {
          id: cr.id,
          mealPlanId: mp.id,
          restaurantId: cr.restaurantId,
          restaurantSnapshot: cleanSnapshot,
          inquiryStatus: 'none',
          orderDraft: cleanOrderDraft,
          quoteHistory: cleanQuotes,
          confirmationHistory: cleanConfirmations
        };
        if (includeInternalMemos && cr.internalMemo) {
          candObj.internalMemo = cr.internalMemo;
        }
        return candObj;
      });
    }

    return mpCopy;
  });

  const envelope = {
    schemaVersion: PERSONAL_SCHEMA_VERSION,
    kind: 'share',
    exportedAt: new Date().toISOString(),
    sourceApp: SOURCE_APP,
    selectedFields,
    eventCopy
  };

  const validation = validateShareEnvelope(envelope);
  if (!validation.valid) {
    return {
      valid: false,
      code: 'SHARE_SCHEMA_INVALID',
      errors: validation.errors
    };
  }

  return {
    valid: true,
    selectedFields,
    preview: structuredClone(envelope),
    envelope,
    serializedJson: JSON.stringify(envelope, null, 2)
  };
}

/**
 * 개인 행사 및 백업·공유 사본 저장소(PersonalStorageManager)
 * - 브라우저 IndexedDB와 메모리/커스텀 트랜잭션 백엔드 모두 지원(IndexedDB 차단 환경 대응 - AC27)
 * - 같은 트랜잭션 내 revision 비교를 통한 두 탭 충돌 방지(AC45)
 * - 백업 가져오기 시 IDB 트랜잭션 원자성 보장 및 localStorage 설정 복원 실패 분리·재시도 지원(AC46)
 */
export class PersonalStorageManager {
  constructor(options = {}) {
    this.storage = options.localStorage !== undefined ? options.localStorage : globalThis.localStorage;
    this.idbFactory = options.indexedDB !== undefined ? options.indexedDB : globalThis.indexedDB;
    this.forceIdbUnavailable = Boolean(options.forceIdbUnavailable);
    this.simulateIdbAbortOnImport = Boolean(options.simulateIdbAbortOnImport);
    this.simulateLocalStorageFailOnRestore = Boolean(options.simulateLocalStorageFailOnRestore);

    // 같은 데이터베이스를 공유하는 탭 간 저장 상태(테스트에서 다중 탭 시뮬레이션 시 공유 가능)
    this.sharedBackend = options.sharedBackend || {
      events: new Map(),
      drafts: new Map(),
      restoreLogs: new Map()
    };
    this.dbPromise = null;
    this.isTemporaryMemoryOnly = false;
  }

  async openDb() {
    if (this.forceIdbUnavailable || !this.idbFactory) {
      this.isTemporaryMemoryOnly = true;
      return null;
    }
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve) => {
      try {
        const req = this.idbFactory.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('events')) {
            db.createObjectStore('events', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('drafts')) {
            db.createObjectStore('drafts', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('restoreLogs')) {
            db.createObjectStore('restoreLogs', { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          this.isTemporaryMemoryOnly = true;
          resolve(null);
        };
        req.onblocked = () => {
          this.isTemporaryMemoryOnly = true;
          resolve(null);
        };
      } catch {
        this.isTemporaryMemoryOnly = true;
        resolve(null);
      }
    });

    return this.dbPromise;
  }

  /**
   * 행사 목록 전체 읽기
   */
  async listEvents() {
    const db = await this.openDb();
    if (!db) {
      return Array.from(this.sharedBackend.events.values()).map(e => structuredClone(e));
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['events'], 'readonly');
      const store = tx.objectStore('events');
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result || []).map(e => structuredClone(e)));
      req.onerror = () => reject(req.error);
    });
  }

  async getEvent(eventId) {
    const db = await this.openDb();
    if (!db) {
      const found = this.sharedBackend.events.get(eventId);
      return found ? structuredClone(found) : null;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['events'], 'readonly');
      const store = tx.objectStore('events');
      const req = store.get(eventId);
      req.onsuccess = () => resolve(req.result ? structuredClone(req.result) : null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * 개인 행사 저장 (단일 readwrite 트랜잭션 내 revision 비교 및 complete 후 완료 반환 - PRD 10절, AC27, AC45)
   */
  async saveEvent(eventToSave, expectedRevision = null) {
    const validationErrors = validatePersonalEventObject(eventToSave, 'event');
    if (validationErrors.length > 0) {
      return {
        saved: false,
        status: 'validation_error',
        errors: validationErrors,
        draftPreserved: structuredClone(eventToSave)
      };
    }

    const baseRev = expectedRevision !== null && expectedRevision !== undefined
      ? Number(expectedRevision)
      : Number(eventToSave.revision || 0);

    const db = await this.openDb();

    // IndexedDB 사용 차단 환경(AC27): 영구 저장 완료로 표시하지 않고 임시 상태 및 백업 내보내기 안내 제공
    if (!db && this.forceIdbUnavailable) {
      return {
        saved: false,
        isTemporaryOnly: true,
        status: 'idb_unavailable',
        message: '이 브라우저 환경에서는 영구 저장소(IndexedDB)가 차단되어 임시 편집 상태로만 유지됩니다. JSON 백업 내보내기로 파일을 저장해 주세요.',
        draftPreserved: structuredClone(eventToSave)
      };
    }

    if (!db) {
      const existing = this.sharedBackend.events.get(eventToSave.id);
      if (existing && Number(existing.revision) !== baseRev) {
        return {
          saved: false,
          status: 'revision_conflict',
          message: `다른 탭에서 먼저 저장된 변경본(revision ${existing.revision})이 있습니다. 덮어쓰지 않고 현재 편집안과 기존 저장본을 모두 보존했습니다.`,
          latestStoredEvent: structuredClone(existing),
          currentEditingDraft: structuredClone(eventToSave)
        };
      }
      const nextRevision = existing ? Number(existing.revision) + 1 : 1;
      const committed = {
        ...structuredClone(eventToSave),
        revision: nextRevision,
        updatedAt: new Date().toISOString()
      };
      this.sharedBackend.events.set(committed.id, committed);
      return {
        saved: true,
        status: 'saved',
        revision: nextRevision,
        event: structuredClone(committed)
      };
    }

    return new Promise((resolve) => {
      const tx = db.transaction(['events'], 'readwrite');
      const store = tx.objectStore('events');
      let conflictPayload = null;
      let committedEvent = null;

      const getReq = store.get(eventToSave.id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing && Number(existing.revision) !== baseRev) {
          conflictPayload = {
            saved: false,
            status: 'revision_conflict',
            message: `다른 탭에서 먼저 저장된 변경본(revision ${existing.revision})이 있습니다.`,
            latestStoredEvent: structuredClone(existing),
            currentEditingDraft: structuredClone(eventToSave)
          };
          tx.abort();
          return;
        }
        const nextRevision = existing ? Number(existing.revision) + 1 : 1;
        committedEvent = {
          ...structuredClone(eventToSave),
          revision: nextRevision,
          updatedAt: new Date().toISOString()
        };
        store.put(committedEvent);
      };

      // 개별 put 요청이 아닌 트랜잭션 complete 이벤트 뒤에만 저장 완료로 처리(PRD 10절)
      tx.oncomplete = () => {
        resolve({
          saved: true,
          status: 'saved',
          revision: committedEvent.revision,
          event: structuredClone(committedEvent)
        });
      };

      tx.onabort = () => {
        if (conflictPayload) {
          resolve(conflictPayload);
        } else {
          resolve({
            saved: false,
            status: 'tx_aborted',
            message: '저장 트랜잭션이 중단되었습니다. 편집 내용은 그대로 유지됩니다.',
            draftPreserved: structuredClone(eventToSave)
          });
        }
      };

      tx.onerror = () => {
        if (!conflictPayload) {
          resolve({
            saved: false,
            status: 'tx_error',
            message: '저장 중 오류가 발생했습니다. 백업 파일 내보내기를 이용해 주세요.',
            error: tx.error,
            draftPreserved: structuredClone(eventToSave)
          });
        }
      };
    });
  }

  /**
   * 충돌 발생 시 현재 편집안을 새 행사 ID를 가진 별도 사본으로 저장(PRD 10절, AC45)
   */
  async saveConflictDraftAsSeparateCopy(editingDraft) {
    const remapped = remapEventForSeparateCopy(editingDraft, { resetConfirmationStatus: false });
    if (!remapped.valid) {
      return { saved: false, status: 'validation_error', errors: remapped.errors };
    }
    remapped.event.title = `${editingDraft.title} (사본)`;
    return this.saveEvent(remapped.event, 0);
  }

  /**
   * 제보·이용 기록 초안(LocalDraft) 저장 및 조회(FR05, FR10)
   * 브라우저 초안은 공용 제보 건수나 공개 후기에 합산하지 않는다.
   */
  async saveDraft(draft) {
    const cleanDraft = {
      id: draft.id && isValidEntityId(draft.id) ? draft.id : generatePersonalId('draft'),
      type: draft.type || 'visit_record',
      payload: structuredClone(draft.payload || {}),
      isLocalDraft: true,
      createdAt: draft.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      exportStatus: draft.exportStatus || 'draft_only'
    };

    const db = await this.openDb();
    if (!db) {
      this.sharedBackend.drafts.set(cleanDraft.id, cleanDraft);
      return { saved: true, draft: structuredClone(cleanDraft) };
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts'], 'readwrite');
      tx.objectStore('drafts').put(cleanDraft);
      tx.oncomplete = () => resolve({ saved: true, draft: structuredClone(cleanDraft) });
      tx.onerror = () => reject(tx.error);
    });
  }

  async listDrafts() {
    const db = await this.openDb();
    if (!db) {
      return Array.from(this.sharedBackend.drafts.values()).map(d => structuredClone(d));
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts'], 'readonly');
      const req = tx.objectStore('drafts').getAll();
      req.onsuccess = () => resolve((req.result || []).map(d => structuredClone(d)));
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * 전체 복구용 백업 파일(BackupEnvelope) 생성(FR09, Section 10)
   */
  async exportBackupEnvelope(uiState = null) {
    const [events, drafts] = await Promise.all([this.listEvents(), this.listDrafts()]);
    const currentUi = uiState || loadAndMigrateUiState(null, this.storage).state;

    const envelope = {
      schemaVersion: PERSONAL_SCHEMA_VERSION,
      kind: 'backup',
      exportedAt: new Date().toISOString(),
      sourceApp: SOURCE_APP,
      events,
      favorites: currentUi.favoriteIds || [],
      settings: currentUi.settings || {},
      drafts,
      unresolvedFavorites: currentUi.unresolvedFavorites || [],
      migrationState: currentUi.migrationState || { completed: true, migratedAt: new Date().toISOString() }
    };

    return {
      envelope,
      serializedJson: JSON.stringify(envelope, null, 2)
    };
  }

  /**
   * 백업(BackupEnvelope) 또는 공유 사본(ShareEnvelope) 가져오기(Section 10, AC22, AC23, AC44, AC46, AC55)
   * - 전체 검증 통과 전에는 기존 데이터를 절대 변경하지 않는다.
   * - 동일 행사 ID가 있을 때 기본 동작은 'separate_copy'(모든 개인 ID 재발급·참조 재연결)이며, 'overwrite'는 명시적 선택 시에만 수행한다.
   * - 공유 사본(kind === 'share')의 모든 확인 이력은 파일 내 값과 무관하게 referenceOnly = true 로 강제 저장한다(AC55).
   * - 개인 행사·초안·복원 작업 기록은 하나의 IDB 트랜잭션에서 원자적으로 저장하고, 중간 abort 시 전체 롤백한다(AC46).
   * - IDB 성공 후 localStorage 쓰기 실패 시 '행사 복원 완료·설정 복원 미완료'를 반환하고 복원 작업 기록으로 재시도를 지원한다(AC46).
   */
  async importEnvelope(rawInput, options = {}) {
    const {
      duplicatePolicy = 'separate_copy', // 'separate_copy' | 'overwrite' | 'ask'
      idFactory = generatePersonalId
    } = options;

    let data = rawInput;
    if (typeof rawInput === 'string') {
      try {
        data = JSON.parse(rawInput);
      } catch {
        return {
          imported: false,
          status: 'invalid_json',
          errors: ['유효한 JSON 파일이 아닙니다. 기존 저장 내용은 변경되지 않았습니다.']
        };
      }
    }

    if (!data || typeof data !== 'object') {
      return {
        imported: false,
        status: 'invalid_object',
        errors: ['파일 형식이 올바르지 않습니다.']
      };
    }

    // 공유 사본(ShareEnvelope) 가져오기 처리
    if (data.kind === 'share') {
      const vShare = validateShareEnvelope(data);
      if (!vShare.valid) {
        return {
          imported: false,
          status: 'schema_error',
          errors: vShare.errors
        };
      }

      const existing = await this.getEvent(data.eventCopy.id);
      if (existing && duplicatePolicy === 'ask') {
        return {
          imported: false,
          status: 'duplicate_conflict_prompt',
          duplicateEventIds: [data.eventCopy.id],
          message: '동일한 행사 ID가 이미 존재합니다. 별도 사본으로 가져올지 기존 행사를 대체할지 선택해 주세요.'
        };
      }

      // 공유 사본은 모든 확인 이력을 referenceOnly = true 로 강제하고 새 독립 계획으로 만든다(AC23, AC55)
      let eventToStore;
      if (!existing && duplicatePolicy === 'overwrite') {
        eventToStore = structuredClone(data.eventCopy);
      } else if (duplicatePolicy === 'overwrite') {
        eventToStore = structuredClone(data.eventCopy);
        eventToStore.revision = Number(existing.revision || 1) + 1;
      } else {
        const remapped = remapEventForSeparateCopy(data.eventCopy, {
          resetConfirmationStatus: true,
          idFactory
        });
        if (!remapped.valid) {
          return { imported: false, status: 'remap_error', errors: remapped.errors };
        }
        eventToStore = remapped.event;
      }

      // 파일 안의 referenceOnly 값과 무관하게 모든 확인 기록을 referenceOnly = true 로 강제(PRD 7절, AC55)
      for (const mp of eventToStore.mealPlans || []) {
        for (const lc of mp.lodgingConfirmations || []) {
          lc.referenceOnly = true;
        }
        for (const cr of mp.candidateRecords || []) {
          cr.inquiryStatus = 'none';
          for (const conf of cr.confirmationHistory || []) {
            conf.referenceOnly = true;
          }
        }
      }

      const saveRes = await this.saveEvent(eventToStore, existing && duplicatePolicy === 'overwrite' ? existing.revision : 0);
      return {
        imported: saveRes.saved,
        kind: 'share',
        status: saveRes.saved ? 'imported_share' : saveRes.status,
        event: saveRes.event
      };
    }

    // 복구용 백업(BackupEnvelope) 가져오기 처리
    const vBackup = validateBackupEnvelope(data);
    if (!vBackup.valid) {
      return {
        imported: false,
        status: 'schema_error',
        errors: vBackup.errors
      };
    }

    const existingEvents = await this.listEvents();
    const existingIds = new Set(existingEvents.map(e => e.id));
    const duplicateIds = data.events.filter(e => existingIds.has(e.id)).map(e => e.id);

    if (duplicateIds.length > 0 && duplicatePolicy === 'ask') {
      return {
        imported: false,
        status: 'duplicate_conflict_prompt',
        duplicateEventIds: duplicateIds,
        message: `동일한 행사 ID(${duplicateIds.join(', ')})가 이미 있습니다. 별도 복사를 기본으로 권장하며, 덮어쓰려면 차이를 확인 후 선택해 주세요.`
      };
    }

    const eventsToPersist = [];
    for (const ev of data.events) {
      if (existingIds.has(ev.id) && duplicatePolicy === 'separate_copy') {
        const remapped = remapEventForSeparateCopy(ev, {
          resetConfirmationStatus: false, // 본인 백업의 사본 복사는 확인 이력 보존
          idFactory
        });
        if (!remapped.valid) {
          return { imported: false, status: 'remap_error', errors: remapped.errors };
        }
        eventsToPersist.push(remapped.event);
      } else {
        eventsToPersist.push(structuredClone(ev));
      }
    }

    const draftsToPersist = (data.drafts || []).map(d => structuredClone(d));
    const restoreLogId = idFactory('rlog');
    const restoreLogRecord = {
      id: restoreLogId,
      createdAt: new Date().toISOString(),
      uiPayload: {
        schemaVersion: PERSONAL_SCHEMA_VERSION,
        favoriteIds: [...data.favorites],
        settings: structuredClone(data.settings || {}),
        unresolvedFavorites: structuredClone(data.unresolvedFavorites || []),
        migrationState: structuredClone(data.migrationState || { completed: true, migratedAt: new Date().toISOString() })
      },
      settingsApplied: false
    };

    const db = await this.openDb();

    // 1) 단일 IDB 트랜잭션에서 events, drafts, restoreLogs 원자적 저장(AC46)
    if (!db) {
      if (this.simulateIdbAbortOnImport) {
        return {
          imported: false,
          status: 'idb_tx_aborted',
          message: 'IndexedDB 저장 트랜잭션이 중단되어 모든 행사·초안 변경이 롤백되었습니다.'
        };
      }
      for (const ev of eventsToPersist) {
        this.sharedBackend.events.set(ev.id, structuredClone(ev));
      }
      for (const dr of draftsToPersist) {
        this.sharedBackend.drafts.set(dr.id, structuredClone(dr));
      }
      this.sharedBackend.restoreLogs.set(restoreLogId, structuredClone(restoreLogRecord));
    } else {
      const idbSuccess = await new Promise((resolve) => {
        const tx = db.transaction(['events', 'drafts', 'restoreLogs'], 'readwrite');
        const evStore = tx.objectStore('events');
        const drStore = tx.objectStore('drafts');
        const logStore = tx.objectStore('restoreLogs');

        for (const ev of eventsToPersist) evStore.put(ev);
        for (const dr of draftsToPersist) drStore.put(dr);
        logStore.put(restoreLogRecord);

        if (this.simulateIdbAbortOnImport) {
          tx.abort();
          return;
        }

        tx.oncomplete = () => resolve(true);
        tx.onabort = () => resolve(false);
        tx.onerror = () => resolve(false);
      });

      if (!idbSuccess) {
        return {
          imported: false,
          status: 'idb_tx_aborted',
          message: 'IndexedDB 저장 트랜잭션이 중단되어 중간 저장 없이 롤백되었습니다.'
        };
      }
    }

    // 2) IDB 트랜잭션 완료 후 localStorage(ysk-food-ui-v2) 반영(AC46)
    try {
      if (this.simulateLocalStorageFailOnRestore) {
        throw new Error('Simulated localStorage quota failure');
      }
      const saveUiRes = saveUiState(restoreLogRecord.uiPayload, this.storage);
      if (!saveUiRes.persisted) {
        throw saveUiRes.error || new Error('localStorage 반영 실패');
      }
      restoreLogRecord.settingsApplied = true;
      if (!db) {
        this.sharedBackend.restoreLogs.set(restoreLogId, structuredClone(restoreLogRecord));
      }
      return {
        imported: true,
        kind: 'backup',
        status: 'complete',
        message: '행사·초안·즐겨찾기·설정이 모두 복원되었습니다.',
        restoredEvents: eventsToPersist,
        restoreLogId
      };
    } catch (err) {
      return {
        imported: true,
        kind: 'backup',
        status: 'partial_settings_failed',
        message: '행사 복원 완료 · 설정 복원 미완료 (작업 기록이 보존되어 재시도할 수 있습니다)',
        restoredEvents: eventsToPersist,
        restoreLogId,
        error: err
      };
    }
  }

  /**
   * 설정 복원 미완료 시 보존된 복원 작업 기록(restoreLog)으로 재시도(PRD 10절, AC46)
   * 재시도 전 현재 설정과의 차이를 확인하고 후속 사용자 변경을 몰래 덮어쓰지 않는다.
   */
  async retryRestoreSettingsFromLog(restoreLogId, options = { forceOverwriteUserChanges: false }) {
    const db = await this.openDb();
    let logRecord = null;
    if (!db) {
      logRecord = this.sharedBackend.restoreLogs.get(restoreLogId) || null;
    } else {
      logRecord = await new Promise((resolve) => {
        const tx = db.transaction(['restoreLogs'], 'readonly');
        const req = tx.objectStore('restoreLogs').get(restoreLogId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    }

    if (!logRecord) {
      return { completed: false, status: 'log_not_found', message: '복원 작업 기록을 찾을 수 없습니다.' };
    }

    let currentUi = null;
    try {
      const raw = this.storage?.getItem(UI_STORAGE_KEY);
      if (raw) currentUi = JSON.parse(raw);
    } catch {
      currentUi = null;
    }

    const hasDiff = currentUi && JSON.stringify(currentUi.settings) !== JSON.stringify(logRecord.uiPayload.settings);
    if (hasDiff && !options.forceOverwriteUserChanges) {
      return {
        completed: false,
        status: 'settings_diff_detected',
        message: '현재 브라우저 설정과 백업 설정에 차이가 있습니다. 확인 후 적용을 선택해 주세요.',
        currentSettings: currentUi.settings,
        backupSettings: logRecord.uiPayload.settings,
        restoreLogId
      };
    }

    const res = saveUiState(logRecord.uiPayload, this.storage);
    if (!res.persisted) {
      return {
        completed: false,
        status: 'retry_failed',
        message: '설정 복원 재시도에 실패했습니다.',
        error: res.error
      };
    }

    logRecord.settingsApplied = true;
    if (!db) {
      this.sharedBackend.restoreLogs.set(restoreLogId, structuredClone(logRecord));
    }
    return {
      completed: true,
      status: 'complete',
      message: '보존된 작업 기록으로부터 즐겨찾기·설정 복원을 완료했습니다.',
      uiState: structuredClone(logRecord.uiPayload)
    };
  }
}
