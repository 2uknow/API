// src/runners/job-runner.js
// runJob dispatcher — 타입별 러너로 위임.
// 분리된 러너: ./newman-runner.js, ./binary-runner.js,
//              ./yaml-scenario-runner.js, ./sclient-scenario-runner.js
import fs from 'fs';
import path from 'path';
import { root } from '../utils/config.js';
import { markJobAsScheduled } from '../state/schedule-state.js';
import { runNewmanJob } from './newman-runner.js';
import { runBinaryJob } from './binary-runner.js';
import { runSClientScenarioJob } from './sclient-scenario-runner.js';

async function runJob(jobName, fromSchedule = false) {
  console.log(`[RUNJOB] Starting job execution: ${jobName}, fromSchedule: ${fromSchedule}`);

  // 스케줄 실행일 때는 프론트 실시간 로그 억제 표시
  // (runId 기반 상태 관리로 동일 이름 동시 실행이 모두 별도로 추적됨)
  if (fromSchedule) {
    console.log(`[RUNJOB] Schedule execution for: ${jobName}`);
    markJobAsScheduled(jobName);
  }

  const jobPath = path.join(root, 'jobs', `${jobName}.json`);
  if (!fs.existsSync(jobPath)) {
    console.log(`[RUNJOB] Job file not found: ${jobPath}`);
    return { started: false, reason: 'job_not_found' };
  }

  const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));
  console.log(`[RUNJOB] Job loaded, type: ${job.type}`);

  if (!['newman', 'binary', 'sclient_scenario'].includes(job.type)) {
    console.log(`[RUNJOB] Unsupported job type: ${job.type}`);
    return { started: false, reason: 'unsupported_type' };
  }

  if (job.type === 'binary') {
    console.log(`[RUNJOB] Delegating to runBinaryJob: ${jobName}`);
    return await runBinaryJob(jobName, job);
  }

  if (job.type === 'sclient_scenario') {
    return await runSClientScenarioJob(jobName, job);
  }

  // Newman 타입 — 기본 경로
  return await runNewmanJob(jobName, job);
}

export { runJob };
