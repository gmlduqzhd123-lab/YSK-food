// 운영자용 정적 데이터셋 무결성·스키마·체크섬·교차 참조 검증 CLI 도구(FR10, AC25, AC27, AC34, AC57, AC58)
// 실행 방법: node tools/validate-dataset.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  validateManifest,
  validateRegionsFile,
  validateSearchIndexFile,
  validateIdIndexFile,
  validateLegacyAliasesFile,
  validateRegionDataset,
  validateDatasetBundleCrossReferences
} from '../assets/releases/v2.0.0/js/data/normalize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function runDatasetValidation(rootDir = ROOT) {
  const errors = [];
  const warnings = [];

  const manifestPath = path.join(rootDir, 'data', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { valid: false, errors: ['data/manifest.json 파일이 없습니다.'], warnings };
  }

  const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const mVal = validateManifest(manifest);
  if (!mVal.valid) {
    errors.push(...mVal.errors);
  }

  const dsVersion = manifest.datasetVersion;

  const loadAndVerifyFile = (relPath) => {
    const absPath = path.join(rootDir, relPath);
    if (!fs.existsSync(absPath)) {
      errors.push(`필수 데이터 파일 누락: ${relPath}`);
      return null;
    }
    const raw = fs.readFileSync(absPath, 'utf8');
    const actualHash = sha256Hex(raw);
    const expectedHash = manifest.checksums?.[relPath];
    if (!expectedHash) {
      errors.push(`매니페스트 checksums에 항목 누락: ${relPath}`);
    } else if (actualHash !== expectedHash) {
      errors.push(`${relPath} 체크섬 불일치 (기대: ${expectedHash}, 실제: ${actualHash})`);
    }
    return JSON.parse(raw);
  };

  const regionsFile = loadAndVerifyFile(manifest.regionsPath || `data/releases/${dsVersion}/regions.json`);
  const searchIndex = loadAndVerifyFile(manifest.searchIndexPath || `data/releases/${dsVersion}/search-index.json`);
  const idIndex = loadAndVerifyFile(manifest.idIndexPath || `data/releases/${dsVersion}/id-index.json`);
  const legacyAliases = loadAndVerifyFile(manifest.legacyAliasesPath || `data/releases/${dsVersion}/legacy-aliases.json`);

  if (regionsFile) {
    const rVal = validateRegionsFile(regionsFile, dsVersion);
    if (!rVal.valid) errors.push(...rVal.errors);
  }
  if (searchIndex) {
    const sVal = validateSearchIndexFile(searchIndex, dsVersion);
    if (!sVal.valid) errors.push(...sVal.errors);
  }
  if (idIndex) {
    const iVal = validateIdIndexFile(idIndex, dsVersion);
    if (!iVal.valid) errors.push(...iVal.errors);
  }
  if (legacyAliases) {
    const lVal = validateLegacyAliasesFile(legacyAliases, dsVersion);
    if (!lVal.valid) errors.push(...lVal.errors);
  }

  const regionDatasets = {};
  let totalRestaurants = 0;

  if (regionsFile && Array.isArray(regionsFile.regions)) {
    for (const reg of regionsFile.regions) {
      const regRelPath = reg.datasetPath || manifest.regionFiles?.[reg.regionCode]?.path;
      const regData = loadAndVerifyFile(regRelPath);
      if (regData) {
        const regVal = validateRegionDataset(regData, reg.regionCode, dsVersion);
        if (!regVal.valid) errors.push(...regVal.errors);
        regionDatasets[reg.regionCode] = regData;
        totalRestaurants += (regData.restaurants || []).length;
      }
    }
  }

  if (regionsFile && searchIndex && idIndex && legacyAliases) {
    const crossVal = validateDatasetBundleCrossReferences({
      manifest,
      regionsFile,
      searchIndex,
      idIndex,
      legacyAliases,
      regionDatasets
    });
    if (!crossVal.valid) {
      errors.push(...crossVal.errors);
    }
  }

  // 예제 픽스처(schemas/example-region.fixture.json) 검증(AC27)
  const fixturePath = path.join(rootDir, 'schemas', 'example-region.fixture.json');
  if (fs.existsSync(fixturePath)) {
    const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const fixVal = validateRegionDataset(fixtureData, 'example-region', 'example-v1');
    if (!fixVal.valid) {
      errors.push(...fixVal.errors.map(e => `[예제 픽스처] ${e}`));
    }
  } else {
    errors.push('schemas/example-region.fixture.json 파일이 없습니다.');
  }

  return {
    valid: errors.length === 0,
    datasetVersion: dsVersion,
    regionCount: Object.keys(regionDatasets).length,
    totalRestaurants,
    errors,
    warnings
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const res = runDatasetValidation();
  if (res.valid) {
    console.log(`✅ 데이터셋 검증 완료: 버전 ${res.datasetVersion} · 지역 ${res.regionCount}개 · 총 식당 ${res.totalRestaurants}곳 · 오류 0건`);
    process.exit(0);
  } else {
    console.error(`❌ 데이터셋 검증 실패: 오류 ${res.errors.length}건`);
    for (const err of res.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
}
