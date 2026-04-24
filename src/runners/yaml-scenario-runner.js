import fs from 'fs';
import path from 'path';
import { root, reportsDir, logsDir } from '../utils/config.js';
import { nowInTZString, kstTimestamp } from '../utils/time.js';
import { debugLog, batchLog, matchPattern } from '../utils/debug.js';
import { broadcastState, broadcastLog } from '../utils/sse.js';
import { state, registerRunningJob, unregisterRunningJob, finalizeJobCompletion } from '../state/running-jobs.js';
import { histAppend } from '../services/history-service.js';
import { cleanupOldReports } from '../services/log-manager.js';
import { sendAlert, buildYamlScenarioFailureReport, buildBatchFailureReport } from '../services/alert-integration.js';
import { decodeUrlEncodedContent } from '../utils/crypto.js';
import { generateSimpleBatchReport } from '../services/report-generator.js';
import { getBinaryPath } from './spawn-helpers.js';
import { SClientScenarioEngine, SClientReportGenerator } from '../engine/sclient-engine.js';
import { validateTestsWithYamlData } from '../engine/sclient-test-validator.js';

async function runYamlSClientScenario(jobName, job, collectionPath, paths) {
  console.log(`[YAML] Starting YAML scenario: ${jobName}`);
  console.log(`[YAML] Collection path: ${collectionPath}`);
  console.log(`[YAML] Job timeout: ${job.timeout || 15000}ms`);
  
  const { stdoutPath, stderrPath, txtReport, outStream, errStream, stamp } = paths;
  
  return new Promise(async (resolve) => {
    console.log(`[YAML] Promise wrapper created for ${jobName}`);
    
    try {
      console.log(`[YAML] Importing modules...`);
      
      // YAML 파서와 SClient 엔진 import
      const { SClientYAMLParser } = await import('../engine/simple-yaml-parser.js');
      const { SClientScenarioEngine, SClientReportGenerator } = await import('../engine/sclient-engine.js');
      
      console.log(`[YAML] Modules imported successfully`);
      console.log('[YAML SCENARIO] Loading YAML collection:', collectionPath);
      
      // YAML 파일을 JSON 시나리오로 변환 (변수 치환 포함)
      const yamlContent = fs.readFileSync(collectionPath, 'utf-8');
      const yamlBasePath = path.dirname(path.resolve(collectionPath));
      const scenario = SClientYAMLParser.parseYamlToScenario(yamlContent, yamlBasePath);
      console.log('[YAML SCENARIO] Parsed scenario:', scenario.info.name);
      
      // SClient 바이너리 경로 확인
      const binaryPath = getBinaryPath(job);
      if (!fs.existsSync(binaryPath)) {
        resolve({ started: false, reason: 'binary_not_found', path: binaryPath });
        return;
      }
      
      const startTime = nowInTZString();
      const startTs = Date.now();
      
      const runId = registerRunningJob(jobName, startTime, 'yaml_scenario', null);
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
      console.log(`[YAML] Starting scenario execution with timeout: ${job.timeout || 15000}ms`);
      
      // 시나리오 실행 (타임아웃 적용)
      const scenarioPromise = engine.runScenario(tempScenarioPath);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Scenario execution timeout')), 
                  job.timeout || 15000);
      });
      
      console.log(`[YAML] Promise.race started, waiting for completion...`);
      const scenarioResult = await Promise.race([scenarioPromise, timeoutPromise]);
      console.log(`[YAML] Scenario execution completed, success: ${scenarioResult.success}`);
      
      // 공통 테스트 검증 모듈 적용 - run-yaml.js와 동일한 검증 로직 사용
      try {
        const yamlContent = fs.readFileSync(collectionPath, 'utf8');
        const { load } = await import('js-yaml');
        const yamlData = load(yamlContent);
        const validatedResult = validateTestsWithYamlData(scenarioResult, yamlData);
        console.log(`[YAML] Test validation completed - Updated success: ${validatedResult.success}`);
        
        // 검증 결과로 시나리오 결과 업데이트
        Object.assign(scenarioResult, validatedResult);
      } catch (validateError) {
        console.log(`[YAML] Test validation failed, using original results: ${validateError.message}`);
      }
      
      const endTime = nowInTZString();
      const duration = Math.round((Date.now() - startTs) / 1000);
      console.log(`[YAML] Execution duration: ${duration}s`);
      
      broadcastLog(`[YAML SCENARIO DONE] ${jobName} completed in ${duration}s`, 'SYSTEM');
      
      // Promise resolve를 먼저 실행하여 blocking 방지
      console.log(`[YAML] Preparing result data for immediate resolve`);
      const resultData = { 
        started: true, 
        exitCode: scenarioResult.success ? 0 : 1, 
        success: scenarioResult.success,
        scenarioResult
      };
      
      // 비동기적으로 리포트 생성 및 정리 작업 수행
      console.log(`[YAML] Starting async cleanup operations`);
      setImmediate(async () => {
        console.log(`[YAML] Async cleanup started`);
        try {
          outStream.end();
          errStream.end();
          
          // Newman 스타일 HTML 리포트 생성
          const htmlReport = path.join(reportsDir, `${jobName}_${stamp}.html`);
          
          try {
            // Newman 컨버터 사용하여 Newman 스타일 리포트 생성
            const { SClientToNewmanConverter } = await import('../engine/newman-converter.js');
            const converter = new SClientToNewmanConverter();
            
            console.log(`[BATCH_HTML] Converting ${jobName} to Newman format...`);
            const newmanRun = converter.convertToNewmanRun(scenarioResult);
            console.log(`[BATCH_HTML] Newman run executions:`, (newmanRun.executions || []).length);
            
            console.log(`[BATCH_HTML] Generating Newman style HTML for ${jobName}...`);
            await converter.generateNewmanStyleHTML(newmanRun.run, htmlReport, {
              title: `${jobName} Test Report`,
              browserTitle: `${jobName} Report`
            });
            console.log(`[BATCH_HTML] ✅ Newman style HTML generated successfully for ${jobName}`);
            
          } catch (error) {
            console.warn(`[YAML NEWMAN REPORT] Error generating Newman report: ${error.message}`);
            const htmlContent = SClientReportGenerator.generateHTMLReport(scenarioResult);
            fs.writeFileSync(htmlReport, htmlContent);
          }
          
          // 텍스트 리포트 생성
          const txtContent = SClientReportGenerator.generateTextReport(scenarioResult);
          fs.writeFileSync(txtReport, txtContent);
          
          // 히스토리 저장 (비동기 - 이벤트 루프 블로킹 방지)
          const historyEntry = {
            timestamp: endTime,
            job: jobName,
            type: 'binary', // binary 타입으로 유지
            exitCode: scenarioResult.success ? 0 : 1,
            summary: `${scenarioResult.summary.passed}/${scenarioResult.summary.total} steps passed`,
            report: path.join(reportsDir, `${jobName}_${stamp}.html`),
            stdout: path.basename(stdoutPath),
            stderr: path.basename(stderrPath),
            tags: ['binary', 'yaml', 'scenario'],
            duration: duration,
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
          
          // 히스토리 저장 후 추가 상태 확인 및 초기화
          console.log(`[HIST_SAVE] YAML scenario ${jobName} saved to history, checking state...`);
          if (state.runningJobs.has(runId)) {
            console.log(`[HIST_SAVE] Cleaning up runningJobs for ${jobName} (runId=${runId})`);
            unregisterRunningJob(runId);
          }
          
          // 강화된 History 업데이트 신호
          console.log(`[HISTORY_UPDATE] YAML scenario ${jobName} history updated`);
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

      // Promise를 즉시 resolve
      console.log(`[YAML] Resolving Promise immediately with result:`, resultData);
      resolve(resultData);
      
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
      
      // 통합 완료 처리 함수 사용 (완료를 기다림)
      await finalizeJobCompletion(jobName, 1, false);
      
      resolve({ started: false, reason: 'yaml_scenario_error', error: error.message });
    }
  });
}
// YAML 단일 파일 실행 함수 (state.running 체크 없음)
async function runSingleYamlFile(jobName, job, collectionPath, paths, broadcastJobName) {
  // broadcastJobName: 부모 배치 job 이름 (탭에 표시될 이름). 없으면 jobName 사용
  const logJobName = broadcastJobName || jobName;
  console.log(`[SINGLE_YAML] Starting: ${jobName} (broadcast as: ${logJobName})`);
  
  const { stdoutPath, stderrPath, txtReport, outStream, errStream, stamp } = paths;
  
  return new Promise(async (resolve) => {
    try {
      debugLog(`[SINGLE_YAML] Importing modules for: ${jobName}`);
      // YAML 파서와 SClient 엔진 import
      const { SClientYAMLParser } = await import('../engine/simple-yaml-parser.js');
      const { SClientScenarioEngine, SClientReportGenerator } = await import('../engine/sclient-engine.js');
      debugLog(`[SINGLE_YAML] Modules imported successfully for: ${jobName}`);
      
      debugLog(`[SINGLE_YAML] Reading YAML file: ${collectionPath}`);
      console.log('[SINGLE_YAML] Loading YAML collection:', collectionPath);
      
      // YAML 파일을 JSON 시나리오로 변환 (변수 치환 포함)
      const yamlContent = fs.readFileSync(collectionPath, 'utf-8');
      debugLog(`[SINGLE_YAML] YAML content read, length: ${yamlContent.length} chars`);
      
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
        resolve({ started: false, reason: 'binary_not_found', path: binaryPath });
        return;
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
      console.log('[SINGLE_YAML] Temp scenario written to:', tempScenarioPath);
      
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
      
      // 시나리오 실행
      debugLog(`[SINGLE_YAML] Starting scenario execution for: ${jobName}`);

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
        const { load } = await import('js-yaml');
        const yamlDataForValidation = load(yamlContentForValidation);
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
        try {
          const { SClientToNewmanConverter } = await import('../engine/newman-converter.js');
          const reportPath = path.join(reportsDir, `${jobName}_${stamp}.html`);

          try {
            const converter = new SClientToNewmanConverter();
            const newmanRun = converter.convertToNewmanRun(executionResult);

            await converter.generateNewmanStyleHTML(newmanRun.run, reportPath, {
              title: job.reportOptions?.title || `${jobName} Test Report`,
              browserTitle: job.reportOptions?.browserTitle || `${jobName} Report`
            });

            // 파일이 실제로 생성되었는지 확인
            if (fs.existsSync(reportPath)) {
              finalReportPath = reportPath;
            }

          } catch (htmlError) {
            console.error('[HTML_GENERATION] HTML generation failed:', htmlError.message);

            // 폴백: 기본 HTML 리포트 생성 시도
            try {
              const { SClientReportGenerator } = await import('../engine/sclient-engine.js');
              const fallbackContent = SClientReportGenerator.generateHTMLReport(executionResult);
              fs.writeFileSync(reportPath, fallbackContent);

              if (fs.existsSync(reportPath)) {
                finalReportPath = reportPath;
              }
            } catch (fallbackError) {
              console.error('[HTML_FALLBACK] Fallback generation failed:', fallbackError.message);
            }
          }
        } catch (reportError) {
          debugLog(`[SINGLE_YAML] HTML report generation failed for: ${jobName}`, {
            error: reportError.message,
            stack: reportError.stack
          });
          console.error('[SINGLE_YAML] HTML report generation failed:', reportError);
          
          // 폴백 HTML 생성
          try {
            debugLog(`[SINGLE_YAML] Attempting fallback HTML generation for: ${jobName}`);
            const { SClientReportGenerator } = await import('../engine/sclient-engine.js');
            const fallbackReportPath = path.join(reportsDir, `${jobName}_${stamp}.html`);
            SClientReportGenerator.generateHTMLReport(executionResult, fallbackReportPath, jobName);
            
            // 폴백 파일이 실제로 생성되었는지 확인
            const fallbackExists = fs.existsSync(fallbackReportPath);
            debugLog(`[SINGLE_YAML] Fallback HTML report file exists: ${fallbackExists}`, {
              reportPath: fallbackReportPath,
              fileSize: fallbackExists ? fs.statSync(fallbackReportPath).size : 'N/A'
            });
            
            if (fallbackExists) {
              finalReportPath = fallbackReportPath;
              console.log(`[SINGLE_YAML] Fallback HTML report generated: ${fallbackReportPath}`);
            }
          } catch (fallbackError) {
            debugLog(`[SINGLE_YAML] Fallback HTML generation failed for: ${jobName}`, {
              error: fallbackError.message,
              stack: fallbackError.stack
            });
            console.error('[SINGLE_YAML] Fallback HTML report generation failed:', fallbackError);
          }
        }
      } else {
        debugLog(`[SINGLE_YAML] HTML report generation SKIPPED for: ${jobName} (generateHtmlReport=false)`);
      }
      
      // 완료 로그
      const statusIcon = success ? '✅' : '❌';
      const message = `${statusIcon} ${jobName}: ${success ? 'SUCCESS' : 'FAILED'} (${duration}ms)`;
      broadcastLog(message, logJobName);
      
      // HTML 리포트 생성 완료 후 resolve
      debugLog(`[SINGLE_YAML] Final resolve for: ${jobName}`, {
        success: success,
        duration: duration,
        reportsGenerated: job.generateHtmlReport,
        finalReportPath: finalReportPath
      });
      
      resolve({
        started: true,
        success: success,
        duration: duration,
        startTime: startTime,
        endTime: endTime,
        reportPath: finalReportPath,
        result: executionResult
      });
      
    } catch (error) {
      debugLog(`[SINGLE_YAML] Error in ${jobName}`, {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      console.error(`[SINGLE_YAML] Error in ${jobName}:`, error);
      broadcastLog(`❌ ${jobName}: ERROR - ${error.message}`, logJobName);
      
      const errorResult = {
        started: true,
        success: false,
        error: error.message,
        result: null
      };
      debugLog(`[SINGLE_YAML] Resolving with error result for: ${jobName}`, errorResult);
      resolve(errorResult);
    }
  });
}

// debugLog, batchLog → src/utils/debug.js에서 import

// YAML 디렉토리 배치 실행 함수 (기존 runYamlSClientScenario 방식 재사용)
async function runYamlDirectoryBatch(jobName, job, collectionPath, paths) {
  console.log('🎯🎯🎯 [BATCH_FUNCTION] runYamlDirectoryBatch called! 🎯🎯🎯');
  process.stdout.write('🎯🎯🎯 [BATCH_FUNCTION] runYamlDirectoryBatch called! 🎯🎯🎯\n');
  
  batchLog(`\n🚀 === BATCH FUNCTION ENTRY === 🚀`);
  batchLog(`[BATCH_ENTRY] Function called at: ${new Date().toISOString()}`);
  batchLog(`[BATCH_ENTRY] jobName: ${jobName}`);
  batchLog(`[BATCH_ENTRY] collectionPath: ${collectionPath}`);
  batchLog(`[BATCH_ENTRY] Function parameters received successfully`);
  
  debugLog(`[YAML_BATCH] Starting YAML directory batch: ${jobName}`);
  debugLog(`[YAML_BATCH] Directory path: ${collectionPath}`);
  debugLog(`[YAML_BATCH] Job configuration`, job);
  debugLog(`[YAML_BATCH] Paths configuration`, paths);
  
  // 배치 모드 활성화
  state.batchMode = true;
  console.log(`[YAML_BATCH] Batch mode activated for concurrent file execution`);
  console.log(`[YAML_BATCH] Current state before start:`, state.running);
  
  const { stdoutPath, stderrPath, txtReport, outStream, errStream, stamp } = paths;
  
  try {
    // YAML 파일들 찾기
    const allFiles = fs.readdirSync(collectionPath);
    
    const allYamlFiles = allFiles.filter(file => file.toLowerCase().endsWith('.yaml'));
    debugLog(`[YAML_BATCH] All YAML files found`, allYamlFiles);
    
    // excludePatterns 적용
    let yamlFiles = allYamlFiles;
    if (job.excludePatterns && Array.isArray(job.excludePatterns)) {
      debugLog(`[YAML_BATCH] Applying exclude patterns`, job.excludePatterns);
      yamlFiles = allYamlFiles.filter(file => {
        const filePath = path.join(collectionPath, file);
        const relativePath = path.relative(collectionPath, filePath);
        
        // 각 제외 패턴과 비교
        for (const pattern of job.excludePatterns) {
          if (matchPattern(file, pattern) || matchPattern(relativePath, pattern)) {
            debugLog(`[YAML_BATCH] Excluding file: ${file} (matches pattern: ${pattern})`);
            return false; // 제외
          }
        }
        debugLog(`[YAML_BATCH] Including file: ${file}`);
        return true; // 포함
      });
    }
    debugLog(`[YAML_BATCH] Final YAML files for execution`, yamlFiles);
    
    batchLog(`\n📂 === FILE FILTERING RESULT === 📂`);
    batchLog(`[FILE_FILTER] Total YAML files found: ${allYamlFiles.length}`);
    batchLog(`[FILE_FILTER] After exclude patterns: ${yamlFiles.length}`);
    batchLog(`[FILE_FILTER] Files to process:`, yamlFiles);
    
    if (yamlFiles.length === 0) {
      console.log(`[YAML_BATCH] No YAML files found in ${collectionPath}`);
      batchLog(`[FILE_FILTER] ⚠️ EARLY RETURN: No files to process`);
      return { started: false, reason: 'no_yaml_files', path: collectionPath };
    }
    
    console.log(`[YAML_BATCH] All YAML files found: ${allYamlFiles.length}`);
    allYamlFiles.forEach(file => console.log(`[YAML_BATCH] ALL: ${file}`));
    
    console.log(`[YAML_BATCH] After exclude patterns: ${yamlFiles.length}`);
    yamlFiles.forEach(file => console.log(`[YAML_BATCH] INCLUDED: ${file}`));
    
    const startTime = nowInTZString();
    const startTs = Date.now();

    const runId = registerRunningJob(jobName, startTime, 'yaml_batch', null);
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
      console.log('[YAML_BATCH] Alert sent successfully');
    } catch (alertError) {
      console.error('[YAML_BATCH] Alert sending failed:', alertError.message);
      // 알람 실패는 배치 실행을 중단시키지 않음
    }

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
      
      console.log(`[BATCH_LOOP] About to enter try block for ${fileName}`);
      try {
        console.log('⭐⭐⭐ [TRY_ENTRY] Entered try block successfully! ⭐⭐⭐');
        process.stdout.write('⭐⭐⭐ [TRY_ENTRY] Entered try block successfully! ⭐⭐⭐\n');
        
        // 개별 파일을 위한 paths 생성
        const fileStamp = kstTimestamp();
        console.log('⭐⭐⭐ [TRY_PATHS] Created fileStamp:', fileStamp, '⭐⭐⭐');
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
        
        // 배치 전체 로그에도 기록하기 위한 로그 함수 오버라이드
        const originalLog = console.log;
        const enhancedLog = (...args) => {
          const message = args.join(' ');
          // 개별 파일 로그에 기록
          if (individualOutStream && !individualOutStream.destroyed) {
            individualOutStream.write(message + '\n');
          }
          // 전체 배치 로그에도 기록
          if (outStream && !outStream.destroyed) {
            outStream.write(`[${fileName}] ${message}\n`);
          }
          originalLog(...args);
        };
        
        // runYamlSClientScenario 함수의 핵심 로직을 직접 실행 (state.running 체크 우회)
        console.log(`[BATCH_LOOP] About to call runSingleYamlFile for: ${fileName}`);
        console.log(`[BATCH_LOOP] File paths created:`, {
          stdoutPath: filePaths.stdoutPath,
          stderrPath: filePaths.stderrPath,
          txtReport: filePaths.txtReport
        });
        
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
        debugLog(`[YAML_BATCH] Added result to batch for: ${fileName}`, fileResult);
        
        if (!result.success) {
          overallSuccess = false;
          debugLog(`[YAML_BATCH] File failed, setting overallSuccess to false: ${fileName}`);
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
        
        debugLog(`[YAML_BATCH] Broadcasted result for: ${fileName}`, { statusIcon, success: result.success, stepInfo });
        
        console.log(`[BATCH_LOOP] Completed processing ${fileName} successfully`);
        console.log(`[BATCH_LOOP] Moving to next file...`);
        
      } catch (error) {
        console.error(`[BATCH_LOOP] *** ERROR processing ${fileName} ***`);
        console.error(`[BATCH_LOOP] Error message:`, error.message);
        console.error(`[BATCH_LOOP] Error stack:`, error.stack);
        console.error(`[BATCH_LOOP] Current state when error occurred:`, {
          running: state.running,
          batchMode: state.batchMode,
          fileName: fileName,
          fileIndex: i,
          totalFiles: yamlFiles.length
        });
        
        console.error(`[YAML_BATCH] Error processing ${fileName}:`, error);
        console.error(`[YAML_BATCH] Error stack:`, error.stack);
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
      
      // 각 파일 처리 후 상태 확인
      console.log(`[BATCH_LOOP] === File ${i + 1}/${yamlFiles.length} processing completed ===`);
      console.log(`[BATCH_LOOP] Batch results count: ${batchResults.length}`);
      console.log(`[BATCH_LOOP] Overall success: ${overallSuccess}`);
      console.log(`[BATCH_LOOP] Will continue: ${(i < yamlFiles.length - 1)}`);
      console.log(`[BATCH_LOOP] Current state.running: ${JSON.stringify(state.running)}`);
      console.log(`[BATCH_LOOP] Current state.batchMode: ${state.batchMode}`);
      
      debugLog(`[YAML_BATCH] File ${i + 1}/${yamlFiles.length} processing completed: ${fileName}`, {
        batchResults: batchResults.length,
        overallSuccess,
        willContinue: (i < yamlFiles.length - 1)
      });
      console.log(`[YAML_BATCH] Completed ${i + 1}/${yamlFiles.length}: ${fileName}`);
      
      if (i < yamlFiles.length - 1) {
        console.log(`[BATCH_LOOP] Continuing to next file...`);
      } else {
        console.log(`[BATCH_LOOP] All files processed, exiting loop`);
      }
    }

    console.log(`\n=== [BATCH_LOOP] Loop completed ===`);
    console.log(`[BATCH_LOOP] Final batch results count: ${batchResults.length}`);
    console.log(`[BATCH_LOOP] Final overall success: ${overallSuccess}`);
    console.log(`[BATCH_LOOP] About to proceed to batch completion...`);

    const endTime = nowInTZString();
    const duration = Date.now() - startTs;
    const successFiles = batchResults.filter(r => r.success).length;
    const failedFiles = yamlFiles.length - successFiles;
    const successRate = ((successFiles / yamlFiles.length) * 100).toFixed(1);

    console.log(`[YAML_BATCH] Batch execution completed`);
    console.log(`[YAML_BATCH] Results: ${successFiles}/${yamlFiles.length} files passed (${successRate}%)`);
    
    debugLog(`[YAML_BATCH] Final batch statistics`, {
      totalFiles: yamlFiles.length,
      successFiles: successFiles,
      failedFiles: failedFiles,
      successRate: successRate,
      duration: duration,
      overallSuccess: overallSuccess
    });

    debugLog(`[YAML_BATCH_DEBUG] REACHED BATCH REPORT GENERATION SECTION`);

    // 배치 요약 리포트 생성 - 기본 방식으로 복구
    let batchReportPath = null;
    if (job.generateHtmlReport !== false) {
      try {
        console.log(`[YAML_BATCH] Generating simple batch summary report...`);
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

    // 배치 실행 결과를 히스토리에 저장
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

    const historyEntry = {
      timestamp: endTime,
      job: jobName,
      type: 'binary',
      exitCode: overallSuccess ? 0 : 1,
      summary: `${successFiles}/${yamlFiles.length} files passed (batch)`,
      report: batchReportPath,
      htmlReport: batchReportPath,
      reportPath: batchReportPath,
      stdout: `batch_execution_${new Date().toISOString().split('T')[0]}.log`,
      stderr: `batch_execution_${new Date().toISOString().split('T')[0]}.log`,
      tags: ['binary', 'yaml', 'batch'],
      duration: Math.round(duration / 1000), // ms를 초로 변환
      batchStats: {
        totalFiles: yamlFiles.length,
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
      console.log(`[YAML_BATCH] History saved successfully`);

      // 히스토리 업데이트 신호 브로드캐스트
      broadcastLog(`[HISTORY_UPDATE] Batch job ${jobName} completed and history updated`, 'SYSTEM');
      broadcastState({ history_updated: true });
    } catch (error) {
      console.error(`[YAML_BATCH] Failed to save history:`, error);
    }

    const statusIcon = overallSuccess ? '✅' : '❌';
    console.log(`\n🏁 === BATCH COMPLETION === 🏁`);
    console.log(`[BATCH_COMPLETE] Final results:`, {
      started: finalResult.started,
      success: finalResult.success,
      totalFiles: yamlFiles.length,
      successFiles: successFiles,
      failedFiles: failedFiles,
      duration: finalResult.duration,
      batchReportPath: finalResult.batchReportPath
    });
    console.log(`[BATCH_COMPLETE] About to broadcast completion message`);
    broadcastLog(`[YAML_BATCH COMPLETE] ${jobName} - ${statusIcon} ${successFiles}/${yamlFiles.length} files passed`, jobName);

    state.batchMode = false;
    await finalizeJobCompletion(runId, overallSuccess ? 0 : 1, overallSuccess);

    return finalResult;

  } catch (error) {
    console.error(`[YAML_BATCH] Batch execution error:`, error.message);

    state.batchMode = false;
    await finalizeJobCompletion(jobName, 1, false);

    return {
      started: false,
      reason: 'batch_execution_error',
      error: error.message
    };
  }
}


export { runYamlSClientScenario, runSingleYamlFile, runYamlDirectoryBatch };
