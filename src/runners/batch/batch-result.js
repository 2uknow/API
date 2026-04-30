// src/runners/batch/batch-result.js — 배치 실행 결과 집계 + 히스토리 엔트리 빌드 (순수 함수)
import { debugLog } from '../../utils/debug.js';
import { nowInTZString } from '../../utils/time.js';

/**
 * 배치 실행 결과 통계 계산 + 완료 로그 출력.
 * @param {Array} batchResults 파일별 결과 배열 (success 필드 필수)
 * @param {number} totalFiles 전체 파일 수
 * @param {number} startTs 배치 시작 타임스탬프 (Date.now())
 * @param {boolean} overallSuccess 배치 전체 성공 여부
 * @returns {{ endTime: string, duration: number, successFiles: number, failedFiles: number, successRate: string }}
 */
export function computeBatchStats(batchResults, totalFiles, startTs, overallSuccess) {
  const endTime = nowInTZString();
  const duration = Date.now() - startTs;
  const successFiles = batchResults.filter(r => r.success).length;
  const failedFiles = totalFiles - successFiles;
  const successRate = ((successFiles / totalFiles) * 100).toFixed(1);

  console.log(`[YAML_BATCH] Batch execution completed`);
  console.log(`[YAML_BATCH] Results: ${successFiles}/${totalFiles} files passed (${successRate}%)`);

  debugLog(`[YAML_BATCH] Final batch statistics`, {
    totalFiles: totalFiles,
    successFiles: successFiles,
    failedFiles: failedFiles,
    successRate: successRate,
    duration: duration,
    overallSuccess: overallSuccess
  });

  return { endTime, duration, successFiles, failedFiles, successRate };
}

/**
 * 배치 실행 결과를 히스토리 엔트리로 변환 (순수 함수).
 * batchResults는 요약 형태로 축소하여 JSON.stringify 크기 제한 문제 방지.
 */
export function buildBatchHistoryEntry({
  jobName,
  runId,
  endTime,
  duration,
  batchResults,
  totalFiles,
  successFiles,
  failedFiles,
  successRate,
  batchReportPath,
  overallSuccess,
  stamp,
}) {
  // batchResults를 요약 정보만 포함하도록 축소 (JSON.stringify 크기 제한 문제 방지)
  const batchResultsSummary = batchResults.map(r => ({
    fileName: r.fileName,
    success: r.success,
    duration: r.duration,
    summary: r.summary ? {
      total: r.summary.total,
      passed: r.summary.passed,
      failed: r.summary.failed
    } : null
  }));

  return {
    timestamp: endTime,
    job: jobName,
    runId: runId,
    type: 'binary',
    exitCode: overallSuccess ? 0 : 1,
    summary: `${successFiles}/${totalFiles} files passed (batch)`,
    report: batchReportPath,
    htmlReport: batchReportPath,
    reportPath: batchReportPath,
    // 부모 배치 stdout/stderr (개별 파일 상세 로그가 tee 되어 있어 풍부) 을 가리킨다.
    // 과거에는 batch_execution_YYYY-MM-DD.log (batchLog 누적 파일) 를 가리켰는데,
    // 그 파일은 [BATCH_ENTRY]/[FILE_FILTER] 같은 디버그 로그만 들어 있어 가독성이 매우 낮았다.
    stdout: stamp ? `stdout_${jobName}_${stamp}.log` : `batch_execution_${new Date().toISOString().split('T')[0]}.log`,
    stderr: stamp ? `stderr_${jobName}_${stamp}.log` : `batch_execution_${new Date().toISOString().split('T')[0]}.log`,
    tags: ['binary', 'yaml', 'batch'],
    duration: Math.round(duration / 1000), // ms를 초로 변환 (호환용 유지)
    durationMs: duration,
    batchStats: {
      totalFiles: totalFiles,
      successFiles: successFiles,
      failedFiles: failedFiles,
      successRate: parseFloat(successRate),
      results: batchResultsSummary // 요약 정보만 저장
    },
    detailedStats: {
      totalSteps: batchResults.reduce((sum, r) => sum + (r.summary?.total || 0), 0),
      passedSteps: batchResults.reduce((sum, r) => sum + (r.summary?.passed || 0), 0),
      failedSteps: batchResults.reduce((sum, r) => sum + (r.summary?.failed || 0), 0),
      avgResponseTime: Math.round(batchResults.reduce((sum, r) => {
        const fileDuration = r.duration || 0;
        const total = r.summary?.total || 1;
        return sum + (total > 0 ? fileDuration / total : 0);
      }, 0) / Math.max(batchResults.length, 1)),
      totalDuration: duration,
      successRate: parseFloat(successRate)
    }
  };
}
