// 지역·색인 로드, 버전·체크섬 묶음 검증, 경합 방지(AC07), 구버전 폴백(AC39), ID 상태 구분(AC40)
import { APP_BASE, REGION_GROUPS, resolveAppUrl } from '../config.js';
import {
  validateManifest,
  validateRegionsFile,
  validateSearchIndexFile,
  validateIdIndexFile,
  validateLegacyAliasesFile,
  validateRegionDataset,
  hydrateRestaurantForUi,
  isValidEntityId
} from './normalize.js';

/**
 * UTF-8 문자열의 SHA-256 hex 계산 (브라우저 SubtleCrypto 및 Node crypto 모두 지원)
 */
export async function computeSha256Hex(text) {
  const str = String(text ?? '');
  if (globalThis.crypto?.subtle) {
    const encoded = new TextEncoder().encode(str);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  const nodeCrypto = await import('node:crypto');
  return nodeCrypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

export class DatasetRepository {
  constructor(options = {}) {
    this.appBase = options.appBase || APP_BASE;
    this.fetchFn = options.fetchFn || globalThis.fetch?.bind(globalThis);
    this.isOfflineFn = options.isOfflineFn || (() => typeof navigator !== 'undefined' && navigator.onLine === false);

    // 버전별 검증 완료된 묶음 캐시: datasetVersion -> { manifest, regionsFile, searchIndex, idIndex, legacyAliases, regions: Map<regionCode, regionData> }
    this.bundles = new Map();
    this.activeDatasetVersion = null;
    this.previousCompleteVersion = null;
    this.activeRegionSeq = 0;
    this.currentRegionCode = null;
    this.currentRegionData = null;
  }

  /**
   * 이전 정상 데이터 묶음을 등록(오프라인/캐시 폴백 테스트 및 런타임 폴백용)
   */
  registerValidatedBundle(bundle) {
    if (!bundle || !bundle.manifest?.datasetVersion) return;
    const ver = bundle.manifest.datasetVersion;
    const regionsMap = bundle.regions instanceof Map
      ? bundle.regions
      : new Map(Object.entries(bundle.regions || {}));
    this.bundles.set(ver, {
      manifest: bundle.manifest,
      regionsFile: bundle.regionsFile,
      searchIndex: bundle.searchIndex,
      idIndex: bundle.idIndex,
      legacyAliases: bundle.legacyAliases,
      regions: regionsMap
    });
    if (!this.previousCompleteVersion) {
      this.previousCompleteVersion = ver;
    }
  }

  async fetchJsonVerified(relativePath, expectedChecksum = null) {
    const url = resolveAppUrl(relativePath, this.appBase);
    let response;
    try {
      response = await this.fetchFn(url, { credentials: 'same-origin' });
    } catch (err) {
      const offline = this.isOfflineFn();
      const error = new Error(offline ? `오프라인 미저장: ${relativePath}` : `네트워크 요청 실패: ${relativePath}`);
      error.code = offline ? 'OFFLINE_UNSAVED' : 'NETWORK_ERROR';
      error.cause = err;
      throw error;
    }

    if (!response || !response.ok) {
      const offline = this.isOfflineFn() || response?.status === 503 || response?.status === 504;
      const error = new Error(`HTTP 오류 (${response?.status || 'unknown'}): ${relativePath}`);
      error.code = offline ? 'OFFLINE_UNSAVED' : 'HTTP_ERROR';
      error.status = response?.status;
      throw error;
    }

    const contentType = response.headers?.get?.('content-type') || '';
    const rawText = await response.text();

    // HTML 대체 응답이 JSON 대신 반환된 경우(AC26) 즉시 차단
    if (contentType.includes('text/html') || rawText.trim().startsWith('<!DOCTYPE') || rawText.trim().startsWith('<html')) {
      const error = new Error(`JSON 응답 대신 HTML이 반환되었습니다: ${relativePath}`);
      error.code = 'HTML_FALLBACK_REJECTED';
      throw error;
    }

    if (expectedChecksum) {
      const actualChecksum = await computeSha256Hex(rawText);
      if (actualChecksum !== expectedChecksum) {
        const error = new Error(`체크섬 불일치: ${relativePath} (기대: ${expectedChecksum.slice(0, 12)}…, 실제: ${actualChecksum.slice(0, 12)}…)`);
        error.code = 'CHECKSUM_MISMATCH';
        throw error;
      }
    }

    try {
      return JSON.parse(rawText);
    } catch (err) {
      const error = new Error(`JSON 파싱 실패: ${relativePath}`);
      error.code = 'INVALID_JSON';
      error.cause = err;
      throw error;
    }
  }

  /**
   * 매니페스트와 코어 색인 묶음(regions, search-index, id-index, legacy-aliases)을 동일 datasetVersion으로 로드 및 검증한다.
   */
  async loadCoreBundle() {
    try {
      const manifest = await this.fetchJsonVerified('data/manifest.json');
      const vMan = validateManifest(manifest);
      if (!vMan.valid) {
        const err = new Error(`매니페스트 검증 실패: ${vMan.errors.join('; ')}`);
        err.code = 'SCHEMA_ERROR';
        throw err;
      }

      const dsVersion = manifest.datasetVersion;
      const checksums = manifest.checksums || {};

      const [regionsFile, searchIndex, idIndex, legacyAliases] = await Promise.all([
        this.fetchJsonVerified(manifest.regionsPath, checksums[manifest.regionsPath]),
        this.fetchJsonVerified(manifest.searchIndexPath, checksums[manifest.searchIndexPath]),
        this.fetchJsonVerified(manifest.idIndexPath, checksums[manifest.idIndexPath]),
        this.fetchJsonVerified(manifest.legacyAliasesPath, checksums[manifest.legacyAliasesPath])
      ]);

      const checks = [
        ['regions', validateRegionsFile(regionsFile, dsVersion)],
        ['search-index', validateSearchIndexFile(searchIndex, dsVersion)],
        ['id-index', validateIdIndexFile(idIndex, dsVersion)],
        ['legacy-aliases', validateLegacyAliasesFile(legacyAliases, dsVersion)]
      ];

      for (const [name, check] of checks) {
        if (!check.valid) {
          const err = new Error(`${name} 버전·스키마 검증 실패: ${check.errors.join('; ')}`);
          err.code = 'VERSION_OR_SCHEMA_MISMATCH';
          throw err;
        }
      }

      const existing = this.bundles.get(dsVersion);
      const bundle = {
        manifest,
        regionsFile,
        searchIndex,
        idIndex,
        legacyAliases,
        regions: existing?.regions || new Map()
      };
      this.bundles.set(dsVersion, bundle);
      if (this.activeDatasetVersion && this.activeDatasetVersion !== dsVersion) {
        this.previousCompleteVersion = this.activeDatasetVersion;
      }
      this.activeDatasetVersion = dsVersion;

      return {
        status: 'ok',
        usingFallbackBundle: false,
        datasetVersion: dsVersion,
        generatedAt: manifest.generatedAt,
        bundle
      };
    } catch (err) {
      // 코어 묶음이 불완전하거나 버전 불일치일 때 이전 완전한 묶음이 있으면 폴백(AC39)
      const fallbackBundle = this.getFallbackBundle();
      if (fallbackBundle) {
        this.activeDatasetVersion = fallbackBundle.manifest.datasetVersion;
        return {
          status: 'fallback',
          usingFallbackBundle: true,
          datasetVersion: fallbackBundle.manifest.datasetVersion,
          generatedAt: fallbackBundle.manifest.generatedAt,
          fallbackReason: err.message,
          bundle: fallbackBundle
        };
      }
      return {
        status: this.isOfflineFn() || err.code === 'OFFLINE_UNSAVED' ? 'offline_unsaved' : 'index_error',
        usingFallbackBundle: false,
        error: err
      };
    }
  }

  getFallbackBundle(requiredRegionCode = null) {
    for (const [, b] of this.bundles.entries()) {
      if (!b.manifest || !b.regionsFile || !b.searchIndex || !b.idIndex || !b.legacyAliases) continue;
      if (requiredRegionCode && !b.regions.has(requiredRegionCode)) continue;
      return b;
    }
    return null;
  }

  getActiveBundle() {
    if (!this.activeDatasetVersion) return null;
    return this.bundles.get(this.activeDatasetVersion) || null;
  }

  getRegionsList() {
    const bundle = this.getActiveBundle();
    return bundle?.regionsFile?.regions || [];
  }

  getAllLoadedVenues() {
    const bundle = this.getActiveBundle();
    if (!bundle) return [];
    const seen = new Set();
    const venues = [];
    for (const rData of bundle.regions.values()) {
      for (const v of rData.venues || []) {
        if (v?.id && !seen.has(v.id)) {
          seen.add(v.id);
          venues.push(v);
        }
      }
    }
    return venues;
  }

  getRegionMeta(regionCode) {
    if (REGION_GROUPS[regionCode]) {
      const g = REGION_GROUPS[regionCode];
      return {
        regionCode: g.code,
        sidoName: '',
        name: g.label,
        shortName: g.shortLabel,
        center: g.center,
        bounds: g.bounds
      };
    }
    return this.getRegionsList().find(r => r.regionCode === regionCode) || null;
  }

  /**
   * 특정 지역의 공용 자료 파일을 현재 datasetVersion으로 읽고 검증한다.
   * 새 색인과 구버전 지역 파일을 절대 섞지 않는다(AC39).
   */
  async fetchRegionDatasetForBundle(bundle, regionCode) {
    if (!bundle) {
      const err = new Error('활성 데이터 묶음이 없습니다.');
      err.code = 'INDEX_NOT_LOADED';
      throw err;
    }

    if (bundle.regions.has(regionCode)) {
      return {
        regionData: bundle.regions.get(regionCode),
        datasetVersion: bundle.manifest.datasetVersion,
        usingFallbackBundle: false
      };
    }

    const regionFileMeta = bundle.manifest.regionFiles?.[regionCode];
    if (!regionFileMeta || !regionFileMeta.path) {
      const err = new Error(`매니페스트에 등록되지 않은 지역 코드입니다: ${regionCode}`);
      err.code = 'UNREGISTERED_REGION';
      throw err;
    }

    const expectedHash = bundle.manifest.checksums?.[regionFileMeta.path] || regionFileMeta.checksum || null;
    const data = await this.fetchJsonVerified(regionFileMeta.path, expectedHash);
    const vReg = validateRegionDataset(data, regionCode, bundle.manifest.datasetVersion);
    if (!vReg.valid) {
      const err = new Error(`지역 자료(${regionCode}) 검증 실패: ${vReg.errors.join('; ')}`);
      err.code = 'REGION_SCHEMA_MISMATCH';
      throw err;
    }

    bundle.regions.set(regionCode, data);
    return {
      regionData: data,
      datasetVersion: bundle.manifest.datasetVersion,
      usingFallbackBundle: false
    };
  }

  /**
   * 사용자가 선택한 지역('nationwide' 전국 전체, 권역 묶음, 'all' 여순광 묶음, 또는 개별 시·군·구 코드)을 로드한다.
   * - 요청 경합(AC07) 발생 시 늦게 도착한 이전 요청은 폐기한다.
   * - 선택 지역 JSON 실패 시 다른 지역 캐시를 현재 지역으로 표시하지 않는다(AC08).
   * - 새 묶음의 지역 파일이 실패했을 때 같은 지역을 포함한 이전 완전한 묶음이 있으면 묶음 전체를 이전 버전으로 일관되게 전환한다(AC39).
   */
  async selectRegion(regionCode) {
    const requestSeq = ++this.activeRegionSeq;
    let bundle = this.getActiveBundle();
    if (!bundle) {
      const coreRes = await this.loadCoreBundle();
      if (requestSeq !== this.activeRegionSeq) {
        return { stale: true, regionCode };
      }
      if (!coreRes.bundle) {
        return {
          stale: false,
          status: coreRes.status,
          regionCode,
          restaurants: [],
          venues: [],
          errorMessage: '전국 색인 자료를 불러오지 못했습니다.'
        };
      }
      bundle = coreRes.bundle;
    }

    let targetCodes;
    if (regionCode === 'nationwide') {
      targetCodes = (bundle.regionsFile.regions || []).map(r => r.regionCode);
    } else if (REGION_GROUPS[regionCode]?.regionCodes) {
      targetCodes = REGION_GROUPS[regionCode].regionCodes;
    } else {
      targetCodes = [regionCode];
    }

    try {
      const loadedResults = await Promise.all(
        targetCodes.map(code => this.fetchRegionDatasetForBundle(bundle, code))
      );
      const loadedRegions = loadedResults.map(res => res.regionData);

      if (requestSeq !== this.activeRegionSeq) {
        return { stale: true, regionCode };
      }

      const combinedRestaurants = [];
      const combinedVenues = [];
      const combinedVisitRecords = [];
      const combinedSources = [];

      for (const rData of loadedRegions) {
        const regMeta = bundle.regionsFile.regions.find(rg => rg.regionCode === rData.regionCode);
        for (const rest of rData.restaurants) {
          combinedRestaurants.push(hydrateRestaurantForUi(rest, regMeta));
        }
        combinedVenues.push(...(rData.venues || []));
        combinedVisitRecords.push(...(rData.visitRecords || []));
        combinedSources.push(...(rData.sources || []));
      }

      this.currentRegionCode = regionCode;
      this.currentRegionData = {
        regionCode,
        datasetVersion: bundle.manifest.datasetVersion,
        generatedAt: bundle.manifest.generatedAt,
        usingFallbackBundle: false,
        restaurants: combinedRestaurants,
        venues: combinedVenues,
        visitRecords: combinedVisitRecords,
        sources: combinedSources
      };

      return {
        stale: false,
        status: 'ok',
        ...this.currentRegionData
      };
    } catch (err) {
      if (requestSeq !== this.activeRegionSeq) {
        return { stale: true, regionCode };
      }

      // 같은 지역을 모두 포함한 이전의 완전한 데이터 묶음이 있는지 확인 (새 색인과 구 지역 파일을 섞지 않고 묶음 전체 전환)
      const fallbackBundle = targetCodes.every(c => this.getFallbackBundle(c))
        ? this.getFallbackBundle(targetCodes[0])
        : null;

      if (fallbackBundle && fallbackBundle.manifest.datasetVersion !== bundle.manifest.datasetVersion) {
        this.activeDatasetVersion = fallbackBundle.manifest.datasetVersion;
        const combinedRestaurants = [];
        const combinedVenues = [];
        const combinedVisitRecords = [];
        const combinedSources = [];
        for (const code of targetCodes) {
          const rData = fallbackBundle.regions.get(code);
          const regMeta = fallbackBundle.regionsFile.regions.find(rg => rg.regionCode === code);
          for (const rest of rData.restaurants) {
            combinedRestaurants.push(hydrateRestaurantForUi(rest, regMeta));
          }
          combinedVenues.push(...(rData.venues || []));
          combinedVisitRecords.push(...(rData.visitRecords || []));
          combinedSources.push(...(rData.sources || []));
        }

        this.currentRegionCode = regionCode;
        this.currentRegionData = {
          regionCode,
          datasetVersion: fallbackBundle.manifest.datasetVersion,
          generatedAt: fallbackBundle.manifest.generatedAt,
          usingFallbackBundle: true,
          fallbackReason: err.message,
          restaurants: combinedRestaurants,
          venues: combinedVenues,
          visitRecords: combinedVisitRecords,
          sources: combinedSources
        };

        return {
          stale: false,
          status: 'fallback',
          ...this.currentRegionData
        };
      }

      // 실패 시 다른 지역의 캐시 자료를 현재 지역 자료처럼 표시하지 않는다(AC08)
      const isOffline = this.isOfflineFn() || err.code === 'OFFLINE_UNSAVED';
      this.currentRegionCode = regionCode;
      this.currentRegionData = null;

      return {
        stale: false,
        status: isOffline ? 'offline_unsaved' : 'region_error',
        regionCode,
        datasetVersion: bundle.manifest.datasetVersion,
        usingFallbackBundle: false,
        restaurants: [],
        venues: [],
        visitRecords: [],
        sources: [],
        error: err,
        errorMessage: isOffline
          ? '오프라인 상태이며 선택한 지역의 자료가 이 기기에 저장되어 있지 않습니다.'
          : `선택한 지역(${regionCode}) 자료를 불러오지 못했습니다. 다른 지역 자료로 대체 표시하지 않습니다.`
      };
    }
  }

  /**
   * 전역 ID 색인을 통해 식당 ID의 상태(active / removed / unregistered / index_error / region_error / offline_unsaved)를 정확히 판별하고 로드한다(FR01, AC40).
   */
  async resolveRestaurantById(restaurantId) {
    if (!isValidEntityId(restaurantId)) {
      return { status: 'unregistered', id: String(restaurantId || ''), message: '유효하지 않은 식당 ID 형식입니다.' };
    }

    let bundle = this.getActiveBundle();
    if (!bundle) {
      const coreRes = await this.loadCoreBundle();
      if (!coreRes.bundle) {
        return {
          status: coreRes.status === 'offline_unsaved' ? 'offline_unsaved' : 'index_error',
          id: restaurantId,
          message: coreRes.status === 'offline_unsaved'
            ? '오프라인 상태여서 전역 식당 색인을 확인할 수 없습니다.'
            : '전역 식당 색인을 불러오지 못했습니다. (폐업·삭제로 단정하지 않습니다.)'
        };
      }
      bundle = coreRes.bundle;
    }

    const idxKey = `restaurant:${restaurantId}`;
    const idxEntry = bundle.idIndex.entries?.[idxKey];

    if (!idxEntry) {
      return {
        status: 'unregistered',
        id: restaurantId,
        datasetVersion: bundle.manifest.datasetVersion,
        message: '등록되지 않은 식당 ID입니다.'
      };
    }

    if (idxEntry.status === 'removed') {
      return {
        status: 'removed',
        id: restaurantId,
        regionCode: idxEntry.regionCode,
        removedAt: idxEntry.removedAt || null,
        reason: idxEntry.reason || '공개 자료에서 제외된 식당입니다.',
        datasetVersion: bundle.manifest.datasetVersion,
        message: `공개 자료에서 제외된 식당입니다 (${idxEntry.reason || '운영자 검토 제외'}).`
      };
    }

    try {
      const { regionData } = await this.fetchRegionDatasetForBundle(bundle, idxEntry.regionCode);
      const rawRest = regionData.restaurants.find(r => r.id === restaurantId);
      if (!rawRest) {
        return {
          status: 'region_error',
          id: restaurantId,
          regionCode: idxEntry.regionCode,
          message: '색인에 등록된 식당을 지역 파일에서 찾지 못했습니다.'
        };
      }
      const regMeta = bundle.regionsFile.regions.find(rg => rg.regionCode === idxEntry.regionCode);
      const restaurant = hydrateRestaurantForUi(rawRest, regMeta);
      return {
        status: 'found',
        id: restaurantId,
        regionCode: idxEntry.regionCode,
        datasetVersion: bundle.manifest.datasetVersion,
        restaurant,
        regionData,
        regionMeta: regMeta
      };
    } catch (err) {
      const isOffline = this.isOfflineFn() || err.code === 'OFFLINE_UNSAVED';
      return {
        status: isOffline ? 'offline_unsaved' : 'region_error',
        id: restaurantId,
        regionCode: idxEntry.regionCode,
        error: err,
        message: isOffline
          ? `오프라인 상태이며 해당 지역(${idxEntry.regionCode}) 자료가 기기에 저장되지 않았습니다.`
          : `해당 지역(${idxEntry.regionCode}) 자료를 불러오지 못했습니다. 네트워크 오류는 폐업·삭제가 아닙니다.`
      };
    }
  }

  /**
   * 여러 지역의 즐겨찾기 또는 후보 비교 ID 목록을 지역별로 묶어 효율적으로 조회한다(FR01, AC40).
   * 불러오지 못한 항목도 결과 배열에 상태를 남겨 호출자가 즐겨찾기를 삭제하지 않게 한다.
   */
  async resolveMultipleRestaurantsByIds(restaurantIds = []) {
    const uniqueIds = [];
    const seen = new Set();
    for (const id of restaurantIds) {
      const strId = String(id || '').trim();
      if (!strId || seen.has(strId)) continue;
      seen.add(strId);
      uniqueIds.push(strId);
    }

    const results = [];
    for (const id of uniqueIds) {
      const res = await this.resolveRestaurantById(id);
      results.push(res);
    }
    return results;
  }

  /**
   * 타 지역의 시설(Venue)이 참조하는 EventReference도 전역 ID 색인에서 소유 지역을 찾아 동일 datasetVersion으로 해석한다(AC57).
   */
  async resolveEventReferenceById(eventRefId) {
    if (!isValidEntityId(eventRefId)) {
      return { status: 'unregistered', id: String(eventRefId || '') };
    }
    let bundle = this.getActiveBundle();
    if (!bundle) {
      const coreRes = await this.loadCoreBundle();
      if (!coreRes.bundle) return { status: 'index_error', id: eventRefId };
      bundle = coreRes.bundle;
    }
    const idxEntry = bundle.idIndex.entries?.[`eventRef:${eventRefId}`];
    if (!idxEntry) {
      return { status: 'unregistered', id: eventRefId };
    }
    if (idxEntry.status === 'removed') {
      return { status: 'removed', id: eventRefId, regionCode: idxEntry.regionCode };
    }
    try {
      const { regionData } = await this.fetchRegionDatasetForBundle(bundle, idxEntry.regionCode);
      const eventRef = (regionData.eventReferences || []).find(er => er.id === eventRefId);
      if (!eventRef) {
        return { status: 'region_error', id: eventRefId, regionCode: idxEntry.regionCode };
      }
      return {
        status: 'found',
        id: eventRefId,
        regionCode: idxEntry.regionCode,
        datasetVersion: bundle.manifest.datasetVersion,
        eventReference: eventRef
      };
    } catch (err) {
      const isOffline = this.isOfflineFn() || err.code === 'OFFLINE_UNSAVED';
      return {
        status: isOffline ? 'offline_unsaved' : 'region_error',
        id: eventRefId,
        regionCode: idxEntry.regionCode,
        error: err
      };
    }
  }

  /**
   * 전국 경량 검색 색인(search-index.json)에서 이름·지점명·메뉴·주소·지역·메모 키워드를 검색한다.
   */
  searchNationwideIndex(query, regionCode = 'all') {
    const bundle = this.getActiveBundle();
    if (!bundle || !bundle.searchIndex?.entries) return [];
    const q = String(query || '').trim().toLowerCase();
    return bundle.searchIndex.entries.filter(entry => {
      if (regionCode && regionCode !== 'all' && entry.regionCode !== regionCode) {
        return false;
      }
      if (!q) return true;
      const haystack = [
        entry.name,
        entry.branchName,
        entry.regionName,
        entry.shortRegionName,
        ...(entry.categories || []),
        entry.menuSummary,
        entry.address,
        entry.note
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  /**
   * 구형 ?place=식당이름 링크를 legacy-aliases.json에서 찾는다(Section 8.6 & AC02).
   * 후보가 1개면 resolved, 여러 개면 ambiguous(주소·지점 선택 목록 제공), 0개면 unresolved.
   */
  resolveLegacyPlaceName(placeName) {
    const bundle = this.getActiveBundle();
    const cleaned = String(placeName || '').trim();
    if (!cleaned || !bundle?.legacyAliases) {
      return { status: 'unresolved', name: cleaned, candidateIds: [] };
    }
    const candidates = bundle.legacyAliases.placeNames?.[cleaned] || [];
    if (candidates.length === 1) {
      return { status: 'resolved', name: cleaned, restaurantId: candidates[0], candidateIds: candidates };
    }
    if (candidates.length > 1) {
      const details = candidates.map(id => {
        const entry = bundle.searchIndex?.entries?.find(e => e.id === id);
        return entry || { id, name: cleaned, regionName: '지역 미상', address: '' };
      });
      return { status: 'ambiguous', name: cleaned, candidateIds: candidates, candidates: details };
    }
    return { status: 'unresolved', name: cleaned, candidateIds: [] };
  }
}
