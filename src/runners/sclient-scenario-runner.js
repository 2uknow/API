import fs from 'fs';
import path from 'path';
import { root, reportsDir, logsDir } from '../utils/config.js';
import { nowInTZString, kstTimestamp } from '../utils/time.js';
import { broadcastState, broadcastLog } from '../utils/sse.js';
import { state, registerRunningJob, finalizeJobCompletion } from '../state/running-jobs.js';
import { histAppend } from '../services/history-service.js';
import { sendAlert } from '../services/alert-integration.js';
import { getBinaryPath } from './spawn-helpers.js';
import { SClientScenarioEngine, SClientReportGenerator } from '../engine/sclient-engine.js';

async function runSClientScenarioJob(jobName, job) {
  const stamp = kstTimestamp();
  const logPath = path.join(logsDir, `scenario_${jobName}_${stamp}.log`);
  const reportPath = path.join(reportsDir, `scenario_${jobName}_${stamp}.json`);
  const htmlReportPath = path.join(reportsDir, `scenario_${jobName}_${stamp}.html`);
  const txtReportPath = path.join(reportsDir, `scenario_${jobName}_${stamp}.txt`);

  try {
    // 컬렉션 파일 읽기
    const collectionPath = path.resolve(root, job.collection);
    if (!fs.existsSync(collectionPath)) {
      return { started: false, reason: 'collection_not_found', path: collectionPath };
    }

    const startTime = nowInTZString();
    const startTs = Date.now();

    const runId = registerRunningJob(jobName, startTime, 'sclient_scenario', null);
    broadcastLog(`[SCENARIO START] ${jobName} - ${collectionPath}`, jobName);

    // 시작 알람
    await sendAlert('start', {
      jobName,
      startTime,
      collection: job.collection,
      type: 'sclient_scenario'
    });

    // SClient 시나리오 엔진 초기화
    const binaryPath = getBinaryPath(job) || path.join(root, 'binaries', 'windows', 'SClient.exe');
    const engine = new SClientScenarioEngine({
      binaryPath,
      timeout: job.timeout || 30000,
      encoding: job.encoding || 'cp949'
    });

    // 실시간 이벤트 핸들링
    engine.on('log', (data) => {
      broadcastLog(`[SCENARIO] ${data.message}`, jobName);
    });

    engine.on('step-start', (data) => {
      broadcastLog(`[STEP START] ${data.name}`, jobName);
      broadcastState({
        running: {
          ...state.running,
          currentStep: data.name,
          stepProgress: `${data.step || 0}/${data.total || 0}`
        }
      });
    });

    engine.on('step-end', (data) => {
      broadcastLog(`[STEP END] ${data.name} - Duration: ${data.duration}ms, Exit: ${data.exitCode}`, jobName);
    });

    engine.on('step-error', (data) => {
      broadcastLog(`[STEP ERROR] ${data.name} - ${data.error}`, jobName);
    });

    // 시나리오 실행
    const scenarioResult = await engine.runScenario(collectionPath);

    const endTime = nowInTZString();
    const duration = Math.round((Date.now() - startTs) / 1000);

    // Newman 리포트 생성
    const basePath = path.join(reportsDir, `scenario_${jobName}_${stamp}`);
    const reportResults = await engine.generateMultipleReports(
      scenarioResult,
      basePath,
      ['htmlextra', 'json', 'junit']
    );

    // 기존 텍스트 리포트도 생성 (호환성)
    const txtReport = SClientReportGenerator.generateTextReport(scenarioResult);
    fs.writeFileSync(txtReportPath, txtReport);
    fs.writeFileSync(logPath, engine.logs.join('\n'));

    // 리포트 경로 업데이트
    const finalHtmlReportPath = reportResults.htmlextra?.path || htmlReportPath;
    const finalJsonReportPath = reportResults.json?.path || reportPath;

    const success = scenarioResult.success;

    // 통합 완료 처리 함수 사용 (완료를 기다림)
    await finalizeJobCompletion(runId, success ? 0 : 1, success);

    // 완료 알람
    await sendAlert(success ? 'success' : 'error', {
      jobName,
      collection: job.collection,
      duration,
      endTime,
      totalRequests: scenarioResult.summary.total,
      passedRequests: scenarioResult.summary.passed,
      failedRequests: scenarioResult.summary.failed,
      type: 'sclient_scenario',
      reportPath: finalHtmlReportPath
    });

    const historyEntry = {
      job: jobName,
      type: 'sclient_scenario',
      startTime,
      endTime,
      duration,
      success,
      collection: job.collection,
      totalRequests: scenarioResult.summary.total,
      passedRequests: scenarioResult.summary.passed,
      failedRequests: scenarioResult.summary.failed
    };

    await histAppend(historyEntry);

    broadcastState({ history_updated: true });

    return { started: true, success, result: scenarioResult };

  } catch (error) {
    console.error('[SCENARIO ERROR]', error);

    // 통합 완료 처리 함수 사용 (완료를 기다림)
    await finalizeJobCompletion(jobName, 1, false);

    await sendAlert('error', {
      jobName,
      error: error.message,
      type: 'sclient_scenario'
    });

    return { started: false, reason: 'execution_error', error: error.message };
  }
}

export { runSClientScenarioJob };
