// src/runners/batch/file-filter.js — YAML 배치 실행용 파일 탐색 + excludePatterns 필터링
import fs from 'fs';
import path from 'path';
import { debugLog, batchLog, matchPattern } from '../../utils/debug.js';

/**
 * collectionPath 하위의 YAML 파일을 찾고 excludePatterns에 매치되지 않는 것만 반환.
 * @param {string} collectionPath 대상 디렉토리 절대 경로
 * @param {string[]|undefined} excludePatterns 글롭/부분 매치 패턴 배열
 * @returns {string[]} 필터링된 YAML 파일명 배열 (디렉토리명 미포함)
 */
export function filterYamlFiles(collectionPath, excludePatterns) {
  const allFiles = fs.readdirSync(collectionPath);

  const allYamlFiles = allFiles.filter(file => file.toLowerCase().endsWith('.yaml'));
  debugLog(`[YAML_BATCH] All YAML files found`, allYamlFiles);

  // excludePatterns 적용
  let yamlFiles = allYamlFiles;
  if (excludePatterns && Array.isArray(excludePatterns)) {
    yamlFiles = allYamlFiles.filter(file => {
      const filePath = path.join(collectionPath, file);
      const relativePath = path.relative(collectionPath, filePath);

      // 각 제외 패턴과 비교
      for (const pattern of excludePatterns) {
        if (matchPattern(file, pattern) || matchPattern(relativePath, pattern)) {
          return false; // 제외
        }
      }
      return true; // 포함
    });
  }

  batchLog(`[FILE_FILTER] ${allYamlFiles.length} found, ${yamlFiles.length} after exclude — files:`, yamlFiles);
  return yamlFiles;
}
