// src/routes/api-jobs.js — Job 관리 라우트 (목록, 실행, 중지, 상태)
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { root } from '../utils/config.js';
import { stateClients, logClients, unifiedClients, broadcastLog } from '../utils/sse.js';
import { scheduledJobNames } from '../state/schedule-state.js';
import { state, unregisterRunningJob } from '../state/running-jobs.js';
import { runJob } from '../runners/job-runner.js';

const router = Router();

// Job 목록
router.get('/jobs', (req, res) => {
  const dir = path.join(root, 'jobs');
  try {
    if (!fs.existsSync(dir)) return res.json([]);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const items = [];
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if (!j.name || !j.type) {
          console.warn(`[JOBS] Skipping ${f}: missing required field (name/type)`);
          continue;
        }
        items.push({
          file: f,
          name: j.name,
          type: j.type,
          collection: j.collection,
          environment: j.environment || null,
          reporters: j.reporters || ['cli', 'htmlextra', 'junit', 'json'],
          extra: j.extra || []
        });
      } catch (err) {
        console.warn(`[JOBS] Skipping ${f}: invalid job file — ${err.message}`);
      }
    }
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 현재 실행 중인 Job 목록 (runId 단위 — 동시 실행 지원)
router.get('/running', (req, res) => {
  const runningList = [];
  for (const [runId, info] of state.runningJobs) {
    runningList.push({
      runId,
      job: info.jobName,
      startAt: info.startTime,
      type: info.type,
      elapsed: Math.round((Date.now() - info.startTs) / 1000),
      hasPid: !!(info.proc && info.proc.pid),
      fromSchedule: scheduledJobNames.has(info.jobName)
    });
  }
  res.json({ ok: true, running: runningList, count: runningList.length });
});

// Job 중지 — 이름으로 매칭되는 모든 run을 중지 (동시 실행 중인 같은 이름 전부)
router.post('/stop/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  console.log(`[API] Stop request for job: ${name}`);

  const matches = [];
  for (const [runId, info] of state.runningJobs) {
    if (info.jobName === name) matches.push({ runId, info });
  }

  if (matches.length === 0) {
    return res.status(404).json({ ok: false, reason: 'not_running', message: `Job '${name}'이(가) 실행 중이 아닙니다.` });
  }

  for (const { runId, info } of matches) {
    if (info.proc && !info.proc.killed) {
      try {
        info.proc.kill('SIGTERM');
        console.log(`[API] Sent SIGTERM to job: ${name} (runId=${runId}, PID: ${info.proc.pid})`);
        broadcastLog(`[STOPPED] ${name} - 사용자에 의해 중지됨`, 'SYSTEM');
      } catch (e) {
        console.error(`[API] Failed to kill process for ${name} (runId=${runId}):`, e.message);
        try { info.proc.kill('SIGKILL'); } catch (e2) { /* ignore */ }
      }
    }
    unregisterRunningJob(runId);
  }

  broadcastLog(`[EXECUTION_COMPLETE] ${name}`, 'SYSTEM');
  broadcastLog(`[JOB_FINISHED] ${name} with code -1 (stopped)`, 'SYSTEM');

  res.json({ ok: true, message: `Job '${name}'이(가) 중지되었습니다. (${matches.length}개 run)`, stopped: matches.length });
});

// 서버 상태 확인
router.get('/status', (req, res) => {
  res.json({
    running: state.running,
    timestamp: new Date().toISOString(),
    scheduleQueue: {
      length: state.scheduleQueue.length,
      items: state.scheduleQueue.map(item => ({
        jobName: item.jobName,
        timestamp: item.timestamp,
        retryCount: item.retryCount,
        waitingTime: Date.now() - item.timestamp
      })),
      processing: state.scheduleQueue.length > 0
    },
    clients: {
      state: stateClients.size,
      log: logClients.size,
      unified: unifiedClients.size
    }
  });
});

// Diagnostic test endpoints
router.get('/test', (req, res) => {
  console.log(`[TEST] Test endpoint called at ${new Date().toISOString()}`);
  res.json({ status: 'ok', timestamp: new Date().toISOString(), message: 'Server is responding' });
});

router.post('/test', (req, res) => {
  console.log(`[TEST POST] Test POST endpoint called at ${new Date().toISOString()}`);
  console.log(`[TEST POST] Headers:`, req.headers);
  console.log(`[TEST POST] Body:`, req.body);
  res.json({ status: 'ok', method: 'POST', timestamp: new Date().toISOString(), message: 'POST is working' });
});

// Job 실행 (GET 방식, 백그라운드 비동기 실행)
router.get('/run/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  console.log(`[API] GET /api/run/${name} - Job execution request received`);

  try {
    // 수동 실행은 "같은 이름이 실행 중이면" 차단 (스케줄은 server.js 에서 별도 처리)
    const existingMatches = [];
    for (const [rid, info] of state.runningJobs) {
      if (info.jobName === name) existingMatches.push({ rid, info });
    }
    if (existingMatches.length > 0) {
      const first = existingMatches[0];
      const runningTime = Date.now() - first.info.startTs;
      const timeoutLimit = state.batchMode ? 30000 : 10000;
      if (runningTime > timeoutLimit) {
        console.log(`[API] Job ${name} running too long (${runningTime}ms), forcing cleanup of ${existingMatches.length} run(s)`);
        for (const { rid } of existingMatches) unregisterRunningJob(rid);
        broadcastLog(`[SYSTEM] Forced cleanup of stale job ${name} (${runningTime}ms)`, 'SYSTEM');
      } else {
        console.log(`[API] Job execution rejected - same job already running: ${name}`);
        return res.status(400).json({ ok: false, reason: 'already_running' });
      }
    }

    let jobPath = path.join(root, 'jobs', `${name}.json`);
    let actualJobName = name;

    if (!fs.existsSync(jobPath)) {
      const jobsDir = path.join(root, 'jobs');
      const jobFiles = fs.readdirSync(jobsDir).filter(f => f.endsWith('.json'));

      let foundJob = null;
      for (const file of jobFiles) {
        try {
          const jobData = JSON.parse(fs.readFileSync(path.join(jobsDir, file), 'utf-8'));
          if (jobData.name === name) {
            foundJob = file;
            actualJobName = file.replace('.json', '');
            break;
          }
        } catch (e) { /* ignore */ }
      }

      if (foundJob) {
        jobPath = path.join(jobsDir, foundJob);
        console.log(`[API] Job found by internal name: ${name} -> ${foundJob}`);
      } else {
        console.log(`[API] Job execution rejected - job file not found: ${jobPath}`);
        return res.status(400).json({ ok: false, reason: 'job_not_found' });
      }
    }

    res.json({ ok: true, message: `잡 '${name}'이(가) 시작되었습니다.` });

    runJob(actualJobName)
      .then(result => {
        console.log(`[API] Job ${name} completed`);
      })
      .catch(error => {
        console.error(`[JOB ERROR] ${name}:`, error);
      });
  } catch (error) {
    console.error(`[API ERROR] Unexpected error in /api/run/${name}:`, error);
    try {
      res.status(500).json({ ok: false, reason: 'server_error', error: error.message });
    } catch (resError) {
      console.error(`[API ERROR] Failed to send error response:`, resError);
    }
  }
});

export default router;
