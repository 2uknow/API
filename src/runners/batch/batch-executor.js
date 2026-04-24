// src/runners/batch/batch-executor.js — YAML 배치 파일 순회 실행기 (타임아웃 + 1회 파일 처리)
import fs from 'fs';
import path from 'path';
import { logsDir, reportsDir } from '../../utils/config.js';
import { kstTimestamp } from '../../utils/time.js';
import { debugLog } from '../../utils/debug.js';
import { broadcastLog } from '../../utils/sse.js';

/**
 * YAML 파일 배열을 순차 실행. 배치 타임아웃 도달 시 남은 파일은 timeout 레코드로 채워 break.
 *
 * @param {Object} params
 * @param {string} params.jobName
 * @param {Object} params.job job 객체 (batchTimeout 필드 사용)
 * @param {string} params.collectionPath
 * @param {string[]} params.yamlFiles filterYamlFiles() 결과
 * @param {number} params.startTs 배치 시작 Date.now()
 * @param {import('stream').Writable} params.outStream 전체 배치 stdout 스트림
 * @param {Function} params.runSingleYamlFile 개별 파일 실행 함수 (DI — 순환 import 회피 목적)
 * @returns {Promise<{ batchResults: Array, batchResultsFull: Array, overallSuccess: boolean }>}
 */
export async function executeBatchFiles({
  jobName,
  job,
  collectionPath,
  yamlFiles,
  startTs,
  outStream,
  runSingleYamlFile,
}) {
  // ★ 전체 배치 타임아웃 설정 (기본 30분, job.batchTimeout으로 커스텀 가능)
  const BATCH_TIMEOUT = job.batchTimeout || 30 * 60 * 1000; // 30분
  const batchDeadline = Date.now() + BATCH_TIMEOUT;
  console.log(`[YAML_BATCH] Batch timeout: ${BATCH_TIMEOUT}ms (${Math.round(BATCH_TIMEOUT / 60000)}분)`);

  // 각 YAML 파일을 순차적으로 기존 runYamlSClientScenario 방식으로 처리
  const batchResults = [];  // 히스토리 저장용 (요약만)
  const batchResultsFull = [];  // 알림 전송용 (상세 정보 포함)
  let overallSuccess = true;
  let batchTimedOut = false;

  for (let i = 0; i < yamlFiles.length; i++) {
    // ★ 전체 배치 타임아웃 체크
    if (Date.now() > batchDeadline) {
      const elapsed = Math.round((Date.now() - startTs) / 1000);
      console.error(`[YAML_BATCH] ★ BATCH TIMEOUT after ${elapsed}s - ${i}/${yamlFiles.length} files processed`);
      broadcastLog(`⏰ [BATCH TIMEOUT] 전체 배치 시간 초과 (${elapsed}초 경과, ${i}/${yamlFiles.length} 파일 완료)`, jobName);
      batchTimedOut = true;
      overallSuccess = false;
      // 남은 파일들을 타임아웃으로 기록
      for (let j = i; j < yamlFiles.length; j++) {
        batchResults.push({
          fileName: yamlFiles[j],
          filePath: path.join(collectionPath, yamlFiles[j]),
          success: false,
          duration: 0,
          summary: null,
          error: 'Batch timeout'
        });
        batchResultsFull.push({
          fileName: yamlFiles[j],
          filePath: path.join(collectionPath, yamlFiles[j]),
          success: false,
          result: { success: false, error: 'Batch timeout' }
        });
      }
      break;
    }
    const fileName = yamlFiles[i];
    const filePath = path.join(collectionPath, fileName);

    console.log(`[YAML_BATCH] Processing ${i + 1}/${yamlFiles.length}: ${fileName}`);
    broadcastLog(`📋 [${i + 1}/${yamlFiles.length}] Starting ${fileName}...`, jobName);

    // 진행률 표시
    const progressPercent = Math.round(((i + 1) / yamlFiles.length) * 100);
    broadcastLog(`📊 Batch Progress: ${progressPercent}% (${i + 1}/${yamlFiles.length} files)`, jobName);

    // 전체 배치 로그에도 진행률 기록
    outStream.write(`📊 Batch Progress: ${progressPercent}% (${i + 1}/${yamlFiles.length} files)\n`);

    try {
      // 개별 파일을 위한 paths 생성
      const fileStamp = kstTimestamp();
      const individualOutStream = fs.createWriteStream(path.join(logsDir, `stdout_${jobName}_${fileName}_${fileStamp}.log`), { flags:'a' });
      const individualErrStream = fs.createWriteStream(path.join(logsDir, `stderr_${jobName}_${fileName}_${fileStamp}.log`), { flags:'a' });

      const filePaths = {
        stdoutPath: path.join(logsDir, `stdout_${jobName}_${fileName}_${fileStamp}.log`),
        stderrPath: path.join(logsDir, `stderr_${jobName}_${fileName}_${fileStamp}.log`),
        txtReport: path.join(reportsDir, `${jobName}_${fileName}_${fileStamp}.txt`),
        outStream: individualOutStream,
        errStream: individualErrStream,
        stamp: fileStamp
      };

      // 전체 배치 로그에 개별 파일 시작 로그 기록
      outStream.write(`\n=== [${i + 1}/${yamlFiles.length}] Starting ${fileName} ===\n`);

      const result = await runSingleYamlFile(`${jobName}_${fileName}`, job, filePath, filePaths, jobName);

      // 전체 배치 로그에 개별 파일 완료 로그 기록
      const fileStatusIcon = result.success ? '✅' : '❌';
      const fileStatusText = result.success ? 'SUCCESS' : 'FAILED';
      outStream.write(`=== [${i + 1}/${yamlFiles.length}] ${fileStatusIcon} ${fileName}: ${fileStatusText} (${result.duration}ms) ===\n\n`);

      // 스트림 정리
      individualOutStream.end();
      individualErrStream.end();

      // 알림용: 상세 정보 포함 (에러 메시지 표시에 필요)
      const fileResultFull = {
        fileName,
        filePath,
        success: result.success,
        reportPath: result.reportPath,
        result  // 상세 결과 포함
      };
      batchResultsFull.push(fileResultFull);

      // 히스토리용: 요약 정보만 저장 (파일 크기 절약)
      const fileResult = {
        fileName,
        filePath,
        success: result.success,
        reportPath: result.reportPath,
        duration: result.duration,
        summary: result.scenarioResult?.summary ? {
          total: result.scenarioResult.summary.total,
          passed: result.scenarioResult.summary.passed,
          failed: result.scenarioResult.summary.failed
        } : null
      };
      batchResults.push(fileResult);

      if (!result.success) {
        overallSuccess = false;
      }

      const statusIcon = result.success ? '✅' : '❌';
      const stepInfo = result.scenarioResult?.summary ?
        `${result.scenarioResult.summary.passed}/${result.scenarioResult.summary.total} steps passed` :
        'No steps';
      const message = `${statusIcon} ${fileName}: ${result.success ? 'SUCCESS' : 'FAILED'} (${stepInfo})`;
      console.log(`[YAML_BATCH] ${message}`);
      broadcastLog(message, jobName);

      // 개별 파일 상세 진행 상황 브로드캐스트
      if (result.scenarioResult?.summary) {
        const detailMessage = `[${fileName}] Steps: ${result.scenarioResult.summary.passed}✅ ${result.scenarioResult.summary.failed}❌ Duration: ${result.duration}ms`;
        broadcastLog(detailMessage, jobName);
      }

    } catch (error) {
      console.error(`[YAML_BATCH] Error processing ${fileName}:`, error);
      debugLog(`[YAML_BATCH] Critical error processing file: ${fileName}`, {
        message: error.message,
        stack: error.stack,
        fileName,
        index: i
      });

      batchResults.push({
        fileName,
        filePath,
        success: false,
        result: { success: false, error: error.message }
      });

      overallSuccess = false;
      broadcastLog(`❌ ${fileName}: ERROR - ${error.message}`, jobName);
    }
  }

  return { batchResults, batchResultsFull, overallSuccess };
}
