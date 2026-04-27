import fs from 'fs';
import path from 'path';
import { root, reportsDir } from '../utils/config.js';
import { nowInTZString } from '../utils/time.js';
import { debugLog, batchLog } from '../utils/debug.js';
import { filterYamlFiles } from './batch/file-filter.js';
import { computeBatchStats, buildBatchHistoryEntry } from './batch/batch-result.js';
import { executeBatchFiles } from './batch/batch-executor.js';
import { broadcastState, broadcastLog } from '../utils/sse.js';
import { state, registerRunningJob, unregisterRunningJob, finalizeJobCompletion } from '../state/running-jobs.js';
import { histAppend } from '../services/history-service.js';
import { cleanupOldReports } from '../services/log-manager.js';
import { sendAlert, buildYamlScenarioFailureReport, buildBatchFailureReport } from '../services/alert-integration.js';
import { decodeUrlEncodedContent } from '../utils/crypto.js';
import { generateSimpleBatchReport } from '../services/report-generator.js';
import { getBinaryPath } from './spawn-helpers.js';
import { SClientScenarioEngine, SClientReportGenerator } from '../engine/sclient-engine.js';
import { SClientYAMLParser } from '../engine/simple-yaml-parser.js';
import { SClientToNewmanConverter } from '../engine/newman-converter.js';
import { validateTestsWithYamlData } from '../engine/sclient-test-validator.js';
import { load as yamlLoad } from 'js-yaml';

// Newman 스타일 HTML 리포트 생성. 실패 시 SClientReportGenerator 기본 생성기로 폴백.
// 반환값: 성공 시 reportPath, 실패 시 null.
async function generateYamlHtmlReport(scenarioResult, reportPath, options = {}) {
  const {
    title = 'Test Report',
    browserTitle = 'Test Report',
    logPrefix = '[HTML]'
  } = options;

  try {
    const converter = new SClientToNewmanConverter();
    const newmanRun = converter.convertToNewmanRun(scenarioResult);
    await converter.generateNewmanStyleHTML(newmanRun.run, reportPath, { title, browserTitle });
    if (fs.existsSync(reportPath)) {
      console.log(`${logPrefix} ✅ Newman style HTML generated: ${path.basename(reportPath)}`);
      return reportPath;
    }
    return null;
  } catch (error) {
    console.warn(`${logPrefix} Newman report failed, falling back: ${error.message}`);
    try {
      const content = SClientReportGenerator.generateHTMLReport(scenarioResult);
      fs.writeFileSync(reportPath, content);
      if (fs.existsSync(reportPath)) {
        console.log(`${logPrefix} ✅ Fallback HTML generated: ${path.basename(reportPath)}`);
        return reportPath;
      }
      return null;
    } catch (fallbackError) {
      console.error(`${logPrefix} Fallback also failed: ${fallbackError.message}`);
      return null;
    }
  }
}

async function runYamlSClientScenario(jobName, job, collectionPath, paths) {
  console.log(`[YAML] Starting YAML scenario: ${jobName} (timeout=${job.timeout || 15000}ms)`);

  const { stdoutPath, stderrPath, txtReport, outStream, errStream, stamp } = paths;
  let runId = null;

  try {
      console.log('[YAML SCENARIO] Loading YAML collection:', collectionPath);
      
      // YAML 파일을 JSON 시나리오로 변환 (변수 치환 포함)
      const yamlContent = fs.readFileSync(collectionPath, 'utf-8');
      const yamlBasePath = path.dirname(path.resolve(collectionPath));
      const scenario = SClientYAMLParser.parseYamlToScenario(yamlContent, yamlBasePath);
      console.log('[YAML SCENARIO] Parsed scenario:', scenario.info.name);
      
      // SClient 바이너리 경로 확인
      const binaryPath = getBinaryPath(job);
      if (!fs.existsSync(binaryPath)) {
        return { started: false, reason: 'binary_not_found', path: binaryPath };
      }

      const startTime = nowInTZString();
      const startTs = Date.now();

      runId = registerRunningJob(jobName, startTime, 'yaml_scenario', null);
      broadcastLog(`[YAML SCENARIO START] ${jobName} - ${scenario.info.name}`, jobName);
      
      // 시작 알람 전송
      await sendAlert('start', {
        jobName,
        startTime,
        collection: path.basename(collectionPath),
        type: 'yaml_scenario'
      });
      
      // SClient 엔진 초기화
      const engine = new SClientScenarioEngine({
        binaryPath,
        timeout: job.timeout || 30000,
        encoding: job.encoding || 'cp949'
      });
      
      // 실시간 로그 이벤트 연결
      engine.on('log', (data) => {
        outStream.write(data.message + '\n');
        broadcastLog(data.message, jobName);
      });
    
    engine.on('stdout', (data) => {
      outStream.write(data.text);
      const lines = data.text.split(/\r?\n/);
      lines.forEach(line => {
        if (line.trim()) {
          broadcastLog(`[${data.step}] ${line.trim()}`, jobName);
        }
      });
    });
    
    engine.on('stderr', (data) => {
      errStream.write(data.text);
      const lines = data.text.split(/\r?\n/);
      lines.forEach(line => {
        if (line.trim()) {
          broadcastLog(`[${data.step} ERROR] ${line.trim()}`, jobName);
        }
      });
    });
    
    // 임시 시나리오 파일 생성 (SClient 엔진용)
    const tempScenarioPath = path.join(root, 'temp', `scenario_${jobName}_${stamp}.json`);
    const tempDir = path.dirname(tempScenarioPath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    fs.writeFileSync(tempScenarioPath, JSON.stringify(scenario, null, 2));
    
    try {
      // 시나리오 실행 (타임아웃 적용)
      const scenarioPromise = engine.runScenario(tempScenarioPath);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Scenario execution timeout')),
                  job.timeout || 15000);
      });

      const scenarioResult = await Promise.race([scenarioPromise, timeoutPromise]);

      // 공통 테스트 검증 모듈 적용 - run-yaml.js와 동일한 검증 로직 사용
      try {
        const yamlContent = fs.readFileSync(collectionPath, 'utf8');
        const yamlData = yamlLoad(yamlContent);
        const validatedResult = validateTestsWithYamlData(scenarioResult, yamlData);

        // 검증 결과로 시나리오 결과 업데이트
        Object.assign(scenarioResult, validatedResult);
      } catch (validateError) {
        console.warn(`[YAML] Test validation failed, using original results: ${validateError.message}`);
      }

      const endTime = nowInTZString();
      const durationMs = Date.now() - startTs;
      const duration = Math.round(durationMs / 1000);

      broadcastLog(`[YAML SCENARIO DONE] ${jobName} completed in ${duration}s`, 'SYSTEM');

      // Promise resolve를 먼저 실행하여 blocking 방지
      const resultData = {
        started: true,
        exitCode: scenarioResult.success ? 0 : 1,
        success: scenarioResult.success,
        scenarioResult
      };

      // 비동기적으로 리포트 생성 및 정리 작업 수행
      setImmediate(async () => {
        try {
          outStream.end();
          errStream.end();
          
          // Newman 스타일 HTML 리포트 생성
          const htmlReport = path.join(reportsDir, `${jobName}_${stamp}.html`);
          await generateYamlHtmlReport(scenarioResult, htmlReport, {
            title: `${jobName} Test Report`,
            browserTitle: `${jobName} Report`,
            logPrefix: `[BATCH_HTML ${jobName}]`
          });
          
          // 텍스트 리포트 생성
          const txtContent = SClientReportGenerator.generateTextReport(scenarioResult);
          fs.writeFileSync(txtReport, txtContent);
          
          // 히스토리 저장 (비동기 - 이벤트 루프 블로킹 방지)
          const historyEntry = {
            timestamp: endTime,
            job: jobName,
            runId: runId,
            type: 'binary', // binary 타입으로 유지
            exitCode: scenarioResult.success ? 0 : 1,
            summary: `${scenarioResult.summary.passed}/${scenarioResult.summary.total} steps passed`,
            report: path.join(reportsDir, `${jobName}_${stamp}.html`),
            stdout: path.basename(stdoutPath),
            stderr: path.basename(stderrPath),
            tags: ['binary', 'yaml', 'scenario'],
            duration: duration,
            durationMs: durationMs,
            scenarioResult: {
              name: scenario.info.name,
              passed: scenarioResult.summary.passed,
              failed: scenarioResult.summary.failed,
              total: scenarioResult.summary.total,
              success: scenarioResult.success
            },
            // Binary Job의 detailedStats 추가 (평균 응답시간 계산을 위해)
            detailedStats: {
              totalSteps: scenarioResult.summary.total,
              passedSteps: scenarioResult.summary.passed,
              failedSteps: scenarioResult.summary.failed,
              avgResponseTime: scenarioResult.summary.total > 0 ?
                Math.round(scenarioResult.summary.duration / scenarioResult.summary.total) : 0,
              totalDuration: scenarioResult.summary.duration,
              successRate: scenarioResult.summary.total > 0 ?
                Math.round((scenarioResult.summary.passed / scenarioResult.summary.total) * 100) : 0
            }
          };

          await histAppend(historyEntry);
          cleanupOldReports();

          if (state.runningJobs.has(runId)) {
            unregisterRunningJob(runId);
          }

          broadcastLog(`[HISTORY_UPDATE] Job completed and history updated`, 'SYSTEM');
          
          // 지연된 완료 신호 전송 (SSE 완전 전송 보장)
          setTimeout(() => {
            broadcastLog(`[EXECUTION_COMPLETE] ${jobName} - All logs processed`, 'SYSTEM');
          }, 100);
          
          // 알람 데이터 준비
          const alertData = {
            jobName,
            startTime,
            endTime,
            duration,
            exitCode: scenarioResult.success ? 0 : 1,
            collection: path.basename(collectionPath),
            type: 'yaml_scenario',
            scenarioName: scenario.info.name,
            summary: `${scenarioResult.summary.passed}/${scenarioResult.summary.total} steps passed`,
            success: scenarioResult.success,
            reportPath: path.join(reportsDir, `${jobName}_${stamp}.html`),
            detailedStats: {
              totalSteps: scenarioResult.summary.total,
              passedSteps: scenarioResult.summary.passed,
              failedSteps: scenarioResult.summary.failed,
              avgResponseTime: scenarioResult.summary.duration / scenarioResult.summary.total,
              totalDuration: scenarioResult.summary.duration,
              successRate: Math.round((scenarioResult.summary.passed / scenarioResult.summary.total) * 100)
            }
          };
          
          if (!scenarioResult.success) {
            const failedSteps = scenarioResult.steps.filter(step => !step.passed);
            alertData.errorSummary = failedSteps.slice(0, 3).map(step =>
              `${step.name}: ${step.error || 'Test failed'}`
            ).join('; ');
            // Response Body 및 상세 Assertion 실패 정보 포함
            alertData.failureReport = buildYamlScenarioFailureReport(failedSteps);
            // 실패한 step들의 response 정보 추가
            alertData.failedStepDetails = failedSteps.map(step => ({
              name: step.name,
              error: step.error,
              tests: step.tests,
              response: step.response ? {
                body: decodeUrlEncodedContent(step.response.body || ''),
                stdout: decodeUrlEncodedContent(step.response.stdout || ''),
                parsed: step.response.parsed,
                duration: step.response.duration
              } : null
            }));
          }

          // 결과에 따른 알람 전송
          if (scenarioResult.success) {
            await sendAlert('success', alertData);
          } else {
            await sendAlert('error', alertData);
          }

          // 통합 완료 처리 함수 사용 (완료를 기다림)
          await finalizeJobCompletion(runId, scenarioResult.success ? 0 : 1, scenarioResult.success);

          // 임시 파일 정리
          try {
            fs.unlinkSync(tempScenarioPath);
          } catch (err) {
            console.log('[CLEANUP] Failed to remove temp scenario file:', err.message);
          }
        } catch (error) {
          console.error('[ASYNC CLEANUP ERROR]', error);
        }
      });

      // setImmediate 예약 후 즉시 반환 — 나머지 정리는 백그라운드
      return resultData;

    } catch (scenarioError) {
      // 임시 파일 정리
      try {
        fs.unlinkSync(tempScenarioPath);
      } catch (err) {
        // 정리 실패는 무시
      }
      throw scenarioError;
    }

  } catch (error) {
      console.error('[YAML SCENARIO ERROR]', error);
      outStream.end();
      errStream.end();
      
      const endTime = nowInTZString();
      const duration = 0; // 시작 시간 변수가 Promise 내부에 있으므로 0으로 설정
      
      // 에러 리포트 생성
      const errorReport = [
        `YAML Scenario Execution Error`,
        `=============================`,
        `Job: ${jobName}`,
        `Collection: ${collectionPath}`,
        `Error: ${error.message}`,
        `Stack: ${error.stack}`,
        `Time: ${endTime}`
      ].join('\n');
      
      fs.writeFileSync(txtReport, errorReport);
      
      // 에러 알람 전송
      await sendAlert('error', {
        jobName,
        startTime: nowInTZString(),
        endTime,
        duration,
        exitCode: 1,
        collection: path.basename(collectionPath),
        type: 'yaml_scenario',
        errorSummary: error.message,
        failureReport: `YAML Scenario Error:\n${error.message}\n\nStack Trace:\n${error.stack}`
      });
      
      // 통합 완료 처리 함수 사용 (runId 우선, 미등록 에러면 jobName fallback)
      await finalizeJobCompletion(runId || jobName, 1, false);

      return { started: false, reason: 'yaml_scenario_error', error: error.message };
    }
}

// YAML 단일 파일 실행 함수 (state.running 체크 없음)
async function runSingleYamlFile(jobName, job, collectionPath, paths, broadcastJobName) {
  // broadcastJobName: 부모 배치 job 이름 (탭에 표시될 이름). 없으면 jobName 사용
  const logJobName = broadcastJobName || jobName;
  console.log(`[SINGLE_YAML] Starting: ${jobName} (broadcast as: ${logJobName})`);
  
  const { stdoutPath, stderrPath, txtReport, outStream, errStream, stamp } = paths;

  try {
      console.log('[SINGLE_YAML] Loading YAML collection:', collectionPath);

      // YAML 파일을 JSON 시나리오로 변환 (변수 치환 포함)
      const yamlContent = fs.readFileSync(collectionPath, 'utf-8');

      const yamlBasePath = path.dirname(path.resolve(collectionPath));
      const scenario = SClientYAMLParser.parseYamlToScenario(yamlContent, yamlBasePath);
      debugLog(`[SINGLE_YAML] Scenario parsed for: ${jobName}`, {
        name: scenario.info?.name,
        steps: scenario.requests?.length || 0,
        variables: scenario.variables?.length || 0
      });
      console.log('[SINGLE_YAML] Parsed scenario:', scenario.info.name);
      
      // SClient 바이너리 경로 확인
      const binaryPath = getBinaryPath(job);
      if (!fs.existsSync(binaryPath)) {
        return { started: false, reason: 'binary_not_found', path: binaryPath };
      }

      const startTime = nowInTZString();
      const startTs = Date.now();

      // 개별 파일용 로그 브로드캐스트 (logJobName = 부모 배치 job 이름 또는 자기 자신)
      broadcastLog(`[SINGLE_YAML START] ${jobName} - ${scenario.info.name}`, logJobName);
      
      // SClient 엔진 초기화
      const engine = new SClientScenarioEngine({
        binaryPath,
        timeout: job.timeout || 30000,
        encoding: job.encoding || 'cp949'
      });
      
      // 임시 시나리오 파일 생성
      const tempDir = path.join(root, 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempScenarioPath = path.join(tempDir, `scenario_${jobName}_${stamp}.json`);
      fs.writeFileSync(tempScenarioPath, JSON.stringify(scenario, null, 2));

      // 실시간 로그 이벤트 연결 (logJobName 사용하여 부모 탭에 표시)
      engine.on('log', (data) => {
        outStream.write(data.message + '\n');
        broadcastLog(data.message, logJobName);
      });
    
      engine.on('stdout', (data) => {
        outStream.write(data.text);
        const lines = data.text.split(/\r?\n/);
        lines.forEach(line => {
          if (line.trim()) {
            broadcastLog(line.trim(), logJobName);
          }
        });
      });
      
      engine.on('stderr', (data) => {
        errStream.write(data.text);
        const lines = data.text.split(/\r?\n/);
        lines.forEach(line => {
          if (line.trim()) {
            broadcastLog(`[ERROR] ${line.trim()}`, logJobName);
          }
        });
      });
      
      const executionResult = await engine.runScenario(tempScenarioPath);

      debugLog(`[SINGLE_YAML] Scenario execution completed for: ${jobName}`, {
        success: executionResult?.success,
        stepCount: executionResult?.steps?.length || 0,
        totalTests: executionResult?.summary?.total || 0,
        passedTests: executionResult?.summary?.passed || 0
      });

      // 공통 테스트 검증 모듈 적용 - run-yaml.js와 동일한 검증 로직 사용
      try {
        const yamlContentForValidation = fs.readFileSync(collectionPath, 'utf8');
        const yamlDataForValidation = yamlLoad(yamlContentForValidation);
        const validatedExecutionResult = validateTestsWithYamlData(executionResult, yamlDataForValidation);

        // 검증 결과로 실행 결과 업데이트
        Object.assign(executionResult, validatedExecutionResult);
      } catch (validateError) {
        console.warn(`[SINGLE_YAML] Test validation failed, using original results: ${validateError.message}`);
      }

      // 임시 파일 정리
      try {
        if (fs.existsSync(tempScenarioPath)) {
          fs.unlinkSync(tempScenarioPath);
        }
      } catch (cleanupError) {
        console.warn('[SINGLE_YAML] Temp file cleanup failed:', cleanupError.message);
      }

      const endTime = nowInTZString();
      const duration = Date.now() - startTs;

      const success = executionResult && executionResult.success;

      // HTML 리포트 생성
      let finalReportPath = null;

      if (job.generateHtmlReport) {
        const reportPath = path.join(reportsDir, `${jobName}_${stamp}.html`);
        finalReportPath = await generateYamlHtmlReport(executionResult, reportPath, {
          title: job.reportOptions?.title || `${jobName} Test Report`,
          browserTitle: job.reportOptions?.browserTitle || `${jobName} Report`,
          logPrefix: `[SINGLE_YAML ${jobName}]`
        });
      } else {
        debugLog(`[SINGLE_YAML] HTML report generation SKIPPED for: ${jobName} (generateHtmlReport=false)`);
      }
      
      // 완료 로그
      const statusIcon = success ? '✅' : '❌';
      const message = `${statusIcon} ${jobName}: ${success ? 'SUCCESS' : 'FAILED'} (${duration}ms)`;
      broadcastLog(message, logJobName);

      return {
        started: true,
        success: success,
        duration: duration,
        startTime: startTime,
        endTime: endTime,
        reportPath: finalReportPath,
        result: executionResult
      };

  } catch (error) {
    debugLog(`[SINGLE_YAML] Error in ${jobName}`, {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    console.error(`[SINGLE_YAML] Error in ${jobName}:`, error);
    broadcastLog(`❌ ${jobName}: ERROR - ${error.message}`, logJobName);

    return {
      started: true,
      success: false,
      error: error.message,
      result: null
    };
  }
}

// debugLog, batchLog → src/utils/debug.js에서 import

// YAML 디렉토리 배치 실행 함수 (기존 runYamlSClientScenario 방식 재사용)
async function runYamlDirectoryBatch(jobName, job, collectionPath, paths) {
  batchLog(`[BATCH_ENTRY] ${jobName} — ${collectionPath}`);

  // 배치 모드 활성화
  state.batchMode = true;

  const { stdoutPath, stderrPath, txtReport, outStream, errStream, stamp } = paths;
  let runId = null;

  try {
    // YAML 파일 탐색 + excludePatterns 필터링
    const yamlFiles = filterYamlFiles(collectionPath, job.excludePatterns);

    if (yamlFiles.length === 0) {
      console.log(`[YAML_BATCH] No YAML files to process in ${collectionPath}`);
      return { started: false, reason: 'no_yaml_files', path: collectionPath };
    }
    
    const startTime = nowInTZString();
    const startTs = Date.now();

    runId = registerRunningJob(jobName, startTime, 'yaml_batch', null);
    broadcastLog(`[YAML_BATCH START] ${jobName} - ${yamlFiles.length} files`, jobName);
    
    // 전체 배치 로그에 시작 정보 기록
    outStream.write(`\n🚀 === YAML BATCH EXECUTION START ===\n`);
    outStream.write(`Job: ${jobName}\n`);
    outStream.write(`Start Time: ${startTime}\n`);
    outStream.write(`Total Files: ${yamlFiles.length}\n`);
    outStream.write(`Files: ${yamlFiles.join(', ')}\n`);
    outStream.write(`=== EXECUTION LOG ===\n\n`);

    // 시작 알람 전송
    try {
      await sendAlert('start', {
        jobName,
        startTime,
        target: collectionPath,
        fileCount: yamlFiles.length,
        type: 'yaml_batch'
      });
    } catch (alertError) {
      console.error('[YAML_BATCH] Alert sending failed:', alertError.message);
      // 알람 실패는 배치 실행을 중단시키지 않음
    }

    // 배치 파일 순회 실행 (타임아웃 체크 포함). runSingleYamlFile은 DI로 주입(순환 import 회피).
    const { batchResults, batchResultsFull, overallSuccess } = await executeBatchFiles({
      jobName,
      job,
      collectionPath,
      yamlFiles,
      startTs,
      outStream,
      runSingleYamlFile,
    });

    const { endTime, duration, successFiles, failedFiles, successRate } = computeBatchStats(
      batchResults, yamlFiles.length, startTs, overallSuccess
    );

    // 배치 요약 리포트 생성 - 기본 방식으로 복구
    let batchReportPath = null;
    if (job.generateHtmlReport !== false) {
      try {
        batchReportPath = await generateSimpleBatchReport(jobName, {
          startTime,
          endTime,
          duration,
          yamlFiles: yamlFiles.length,
          successFiles,
          failedFiles,
          successRate,
          results: batchResults,
          stamp
        });
        console.log(`[YAML_BATCH] ✅ Batch report generated: ${path.basename(batchReportPath)}`);
      } catch (error) {
        console.error(`[YAML_BATCH] Batch report generation failed:`, error);
        batchReportPath = null;
      }
    }

    const finalResult = {
      started: true,
      success: overallSuccess,
      duration,
      stats: {
        files: yamlFiles.length,
        successFiles,
        failedFiles,
        successRate: parseFloat(successRate)
      },
      results: batchResults,
      batchReportPath
    };

    // 알람 전송 - 실패한 파일들의 상세 정보 포함 (batchResultsFull 사용)
    const failedResultsFull = batchResultsFull.filter(r => !r.success);
    let batchFailureReport = null;
    let batchErrorSummary = null;

    if (failedResultsFull.length > 0) {
      // 실패 요약
      batchErrorSummary = failedResultsFull.slice(0, 3).map(r =>
        `${r.fileName}: ${r.result?.error || 'Failed'}`
      ).join('; ');

      // 상세 실패 리포트 생성 (상세 정보가 포함된 배열 사용)
      batchFailureReport = buildBatchFailureReport(failedResultsFull);
    }

    // 알림용 결과 (상세 정보 포함)
    const alertResult = {
      started: true,
      success: overallSuccess,
      duration,
      stats: finalResult.stats,
      results: batchResultsFull,  // 알림에는 상세 정보 포함된 배열 사용
      batchReportPath
    };

    await sendAlert(overallSuccess ? 'success' : 'error', {
      jobName,
      startTime,
      endTime,
      duration: Math.round(duration / 1000), // 초 단위로 변환
      exitCode: overallSuccess ? 0 : 1,
      collection: path.basename(collectionPath),
      type: 'yaml_batch',
      result: alertResult,  // 알림용 상세 결과 사용
      stats: finalResult.stats,
      totalRequests: yamlFiles.length,
      passedRequests: successFiles,
      failedRequests: failedFiles,
      reportPath: batchReportPath,
      // 실패 정보 추가
      errorSummary: batchErrorSummary,
      failureReport: batchFailureReport,
      // 상세 통계 (sendAlert의 error 타입에서 사용)
      detailedStats: {
        totalSteps: yamlFiles.length,
        passedSteps: successFiles,
        failedSteps: failedFiles,
        successRate: parseFloat(successRate)
      }
    });

    // 배치 실행 결과를 히스토리 엔트리로 변환 (요약 정보로 축소)
    const historyEntry = buildBatchHistoryEntry({
      jobName,
      runId,
      endTime,
      duration,
      batchResults,
      totalFiles: yamlFiles.length,
      successFiles,
      failedFiles,
      successRate,
      batchReportPath,
      overallSuccess,
    });
    
    debugLog(`[YAML_BATCH] Adding batch result to history`, {
      jobName: historyEntry.job,
      summary: historyEntry.summary,
      batchReport: historyEntry.report ? 'Generated' : 'None',
      totalSteps: historyEntry.detailedStats.totalSteps,
      passedSteps: historyEntry.detailedStats.passedSteps
    });
    
    // history 저장 (비동기 - 이벤트 루프 블로킹 방지)
    try {
      await histAppend(historyEntry);

      // 히스토리 업데이트 신호 브로드캐스트
      broadcastLog(`[HISTORY_UPDATE] Batch job ${jobName} completed and history updated`, 'SYSTEM');
      broadcastState({ history_updated: true });
    } catch (error) {
      console.error(`[YAML_BATCH] Failed to save history:`, error);
    }

    const statusIcon = overallSuccess ? '✅' : '❌';
    broadcastLog(`[YAML_BATCH COMPLETE] ${jobName} - ${statusIcon} ${successFiles}/${yamlFiles.length} files passed`, jobName);

    state.batchMode = false;
    await finalizeJobCompletion(runId, overallSuccess ? 0 : 1, overallSuccess);

    return finalResult;

  } catch (error) {
    console.error(`[YAML_BATCH] Batch execution error:`, error.message);

    state.batchMode = false;
    await finalizeJobCompletion(runId || jobName, 1, false);

    return {
      started: false,
      reason: 'batch_execution_error',
      error: error.message
    };
  }
}


export { runYamlSClientScenario, runSingleYamlFile, runYamlDirectoryBatch };
