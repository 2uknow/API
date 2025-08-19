// server.js (완전 복원된 알람 시스템)
import express from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import cron from 'node-cron';
import morgan from 'morgan';

// 알람 시스템 import
import { 
  sendTextMessage, 
  sendFlexMessage, 
  buildBasicRunStatusFlex,
  buildBasicStatusText,
  buildRunStatusFlex,
  testWebhookConnection
} from './alert.js';

// 경로 및 기본 설정
const root = process.cwd();
const logsDir = path.join(root, 'logs');
const reportsDir = path.join(root, 'reports');
const configDir = path.join(root, 'config');

// 디렉토리 생성
[logsDir, reportsDir, configDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Express 앱 설정
const app = express();
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 전역 상태
const state = { running: null };
const schedules = new Map();
const stateClients = new Set();
const logClients = new Set();

// SSE 최적화 설정
const BATCH_SIZE = 10;
const BATCH_TIMEOUT = 20; // ms
let logBuffer = [];
let broadcastTimeoutId = null;

// 설정 읽기 함수
function readConfig() {
  const configPath = path.join(configDir, 'settings.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (error) {
    console.warn('설정 파일 읽기 실패:', error.message);
  }
  return { 
    site_port: 3000,
    run_event_alert: true,
    alert_on_start: true,
    alert_on_success: true,
    alert_on_error: true,
    alert_method: 'flex'
  };
}

// 히스토리 읽기/쓰기 함수
function readHistory() {
  const histPath = path.join(logsDir, 'history.json');
  try {
    if (fs.existsSync(histPath)) {
      const data = JSON.parse(fs.readFileSync(histPath, 'utf-8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (error) {
    console.warn('히스토리 파일 읽기 실패:', error.message);
  }
  return [];
}

function writeHistory(history) {
  const histPath = path.join(logsDir, 'history.json');
  try {
    const trimmed = history.slice(-500);
    fs.writeFileSync(histPath, JSON.stringify(trimmed, null, 2));
  } catch (error) {
    console.error('히스토리 저장 실패:', error.message);
  }
}

// 현재 시간 (한국 시간)
function getCurrentTimeString() {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

// SSE 헤더 설정
function setSseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });
}

// 상태 브로드캐스트
function broadcastState(payload) {
  const data = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
  
  const deadClients = new Set();
  for (const client of stateClients) {
    try {
      if (!client.destroyed && !client.finished) {
        client.write(data);
        client.flushHeaders?.();
      } else {
        deadClients.add(client);
      }
    } catch (error) {
      deadClients.add(client);
    }
  }
  
  deadClients.forEach(client => stateClients.delete(client));
}

// 로그 브로드캐스트 (배치 처리)
function broadcastLog(line) {
  logBuffer.push(line);
  
  if (logBuffer.length >= BATCH_SIZE || !broadcastTimeoutId) {
    flushLogBuffer();
  } else if (!broadcastTimeoutId) {
    broadcastTimeoutId = setTimeout(flushLogBuffer, BATCH_TIMEOUT);
  }
}

function flushLogBuffer() {
  if (logBuffer.length === 0) return;
  
  const batch = logBuffer.splice(0, BATCH_SIZE);
  const data = batch.map(line => 
    `event: log\ndata: ${JSON.stringify({ line, timestamp: Date.now() })}\n\n`
  ).join('');
  
  const deadClients = new Set();
  for (const client of logClients) {
    try {
      if (!client.destroyed && !client.finished) {
        client.write(data);
        client.flushHeaders?.();
      } else {
        deadClients.add(client);
      }
    } catch (error) {
      deadClients.add(client);
    }
  }
  
  deadClients.forEach(client => logClients.delete(client));
  
  if (broadcastTimeoutId) {
    clearTimeout(broadcastTimeoutId);
    broadcastTimeoutId = null;
  }
}

// Newman 결과 파싱 및 요약 생성
function parseNewmanResult(jsonReportPath) {
  try {
    if (!fs.existsSync(jsonReportPath)) {
      return { summary: 'JSON 리포트 없음', stats: null, detailedStats: null };
    }
    
    const jsonData = JSON.parse(fs.readFileSync(jsonReportPath, 'utf-8'));
    const run = jsonData.run;
    
    if (!run || !run.stats) {
      return { summary: 'JSON 리포트 파싱 실패', stats: null, detailedStats: null };
    }
    
    const stats = run.stats;
    const failures = run.failures || [];
    
    // 상세 통계 계산
    const totalRequests = stats.requests?.total || 0;
    const failedRequests = stats.requests?.failed || 0;
    const totalAssertions = stats.assertions?.total || 0;
    const failedAssertions = stats.assertions?.failed || 0;
    const totalTests = stats.testScripts?.total || 0;
    const failedTests = stats.testScripts?.failed || 0;
    
    const totalExecuted = totalRequests + totalAssertions + totalTests;
    const totalFailed = failedRequests + failedAssertions + failedTests;
    const successRate = totalExecuted > 0 ? Math.round(((totalExecuted - totalFailed) / totalExecuted) * 100) : 0;
    
    // 평균 응답시간
    const avgResponseTime = run.timings?.responseAverage || 0;
    
    // 상세 실패 정보
    const detailedFailures = failures.map(failure => ({
      testName: failure.source?.name || 'Unknown Test',
      error: failure.error?.message || 'Unknown Error',
      source: failure.source
    }));
    
    // 요약 생성
    let summary;
    if (totalFailed === 0) {
      summary = `✅ 모든 테스트 통과 (요청 ${totalRequests}건, 검증 ${totalAssertions}건, 테스트 ${totalTests}건)`;
    } else {
      const failureParts = [];
      if (failedRequests > 0) failureParts.push(`요청 ${failedRequests}건 실패`);
      if (failedAssertions > 0) failureParts.push(`검증 ${failedAssertions}건 실패`);
      if (failedTests > 0) failureParts.push(`테스트 ${failedTests}건 실패`);
      summary = `❌ ${failureParts.join(', ')} (총 요청 ${totalRequests}건, 검증 ${totalAssertions}건, 테스트 ${totalTests}건)`;
    }
    
    return {
      summary,
      stats: {
        requests: stats.requests || {},
        assertions: stats.assertions || {},
        testScripts: stats.testScripts || {},
        iterations: stats.iterations || {}
      },
      detailedStats: {
        totalExecuted,
        totalFailed,
        successRate,
        avgResponseTime,
        totalDuration: run.timings?.responseTotal || 0
      },
      detailedFailures
    };
  } catch (error) {
    console.error('Newman 결과 파싱 오류:', error);
    return { summary: 'JSON 리포트 파싱 오류', stats: null, detailedStats: null };
  }
}

// 알람 전송 함수
async function sendAlert(type, data) {
  const config = readConfig();
  
  if (!config.run_event_alert) return;
  
  const alertSettings = {
    start: config.alert_on_start,
    success: config.alert_on_success,
    error: config.alert_on_error
  };
  
  if (!alertSettings[type]) return;

  try {
    let result;
    
    if (config.alert_method === 'flex') {
      const flexMessage = buildRunStatusFlex(type, data);
      result = await sendFlexMessage(flexMessage);
    } else {
      const textMessage = buildBasicStatusText(type, data);
      result = await sendTextMessage(textMessage);
    }
    
    if (result.ok) {
      console.log(`[ALERT] ${type} 알람 전송 성공`);
    } else {
      console.error(`[ALERT] ${type} 알람 전송 실패:`, result);
    }
  } catch (error) {
    console.error('[ALERT] 알람 시스템 오류:', error.message);
  }
}

// 작업 실행 함수 (핵심 로직)
async function runJob(jobName) {
  if (state.running) {
    return { started: false, reason: 'already_running' };
  }

  const jobPath = path.join(root, 'jobs', `${jobName}.json`);
  if (!fs.existsSync(jobPath)) {
    return { started: false, reason: 'job_not_found' };
  }
  
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));
  } catch (error) {
    return { started: false, reason: 'invalid_job_config' };
  }
  
  if (job.type !== 'newman') {
    return { started: false, reason: 'unsupported_type' };
  }

  // 파일 경로 검증
  const collection = path.resolve(root, job.collection);
  const environment = job.environment ? path.resolve(root, job.environment) : undefined;
  
  if (!fs.existsSync(collection)) {
    return { started: false, reason: 'collection_not_found' };
  }
  
  if (environment && !fs.existsSync(environment)) {
    return { started: false, reason: 'environment_not_found' };
  }

  // 실행 준비
  const timestamp = getCurrentTimeString();
  const reportName = `${jobName}_${Date.now()}`;
  const reportPath = path.join(reportsDir, `${reportName}.html`);
  const jsonReportPath = path.join(reportsDir, `${reportName}.json`);
  const stdoutPath = path.join(logsDir, `${reportName}_stdout.log`);

  // Newman 명령어 구성
  const reporters = job.reporters?.length ? job.reporters : ['cli', 'htmlextra', 'json'];
  const args = [
    'run', collection,
    '--reporters', reporters.join(','),
    '--reporter-htmlextra-export', reportPath,
    '--reporter-json-export', jsonReportPath,
    '--reporter-htmlextra-title', `${job.name} Report`,
    '--reporter-htmlextra-titleSize', '4',
    '--color', 'on'
  ];

  if (environment) {
    args.push('--environment', environment);
  }

  if (job.extra?.length) {
    args.push(...job.extra);
  }

  // 상태 업데이트
  state.running = { job: jobName, startTime: Date.now() };
  broadcastState({ running: state.running });

  // 알람 데이터 준비
  const alertData = {
    jobName: job.name,
    collection: path.basename(collection),
    environment: environment ? path.basename(environment) : null,
    startTime: timestamp
  };

  // 시작 알람 전송
  await sendAlert('start', alertData);

  // Newman 프로세스 실행
  const startTime = Date.now();
  const process = spawn('newman', args, { 
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' }
  });

  const stdoutStream = fs.createWriteStream(stdoutPath);
  
  // 실시간 로그 처리
  process.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdoutStream.write(chunk);
    
    text.split('\n').forEach(line => {
      if (line.trim()) {
        broadcastLog(line.trim());
      }
    });
  });

  process.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stdoutStream.write(chunk);
    broadcastLog(`[ERROR] ${text.trim()}`);
  });

  // 프로세스 완료 처리
  process.on('close', async (exitCode) => {
    stdoutStream.end();
    
    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000);
    const endTimeString = getCurrentTimeString();
    
    // Newman 결과 파싱
    const parseResult = parseNewmanResult(jsonReportPath);
    
    // 히스토리 업데이트
    const historyEntry = {
      timestamp,
      job: jobName,
      exitCode,
      duration,
      summary: parseResult.summary,
      report: fs.existsSync(reportPath) ? reportPath : null,
      jsonReport: fs.existsSync(jsonReportPath) ? jsonReportPath : null,
      stdout: path.basename(stdoutPath),
      stats: parseResult.stats,
      detailedStats: parseResult.detailedStats
    };

    const history = readHistory();
    history.push(historyEntry);
    writeHistory(history);

    // 상태 리셋
    state.running = null;
    broadcastState({ running: null, last: historyEntry });

    // 완료 알람 데이터 준비
    const completionAlertData = {
      ...alertData,
      duration,
      endTime: endTimeString,
      exitCode,
      newmanStats: parseResult.stats,
      detailedStats: parseResult.detailedStats,
      detailedFailures: parseResult.detailedFailures,
      errorSummary: exitCode !== 0 ? parseResult.summary : null,
      reportPath: historyEntry.report
    };

    // 완료 알람 전송
    const alertType = exitCode === 0 ? 'success' : 'error';
    await sendAlert(alertType, completionAlertData);

    console.log(`[JOB COMPLETED] ${jobName} - 종료코드: ${exitCode}, 소요시간: ${duration}초`);
  });

  return { started: true };
}

// ==================== API 라우트 ====================

// 작업 목록 조회
app.get('/api/jobs', (req, res) => {
  try {
    const jobsDir = path.join(root, 'jobs');
    if (!fs.existsSync(jobsDir)) {
      return res.json([]);
    }
    
    const files = fs.readdirSync(jobsDir).filter(f => f.endsWith('.json'));
    const jobs = [];
    
    for (const file of files) {
      try {
        const jobPath = path.join(jobsDir, file);
        const job = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));
        
        if (job.name && job.type) {
          jobs.push({
            file,
            name: job.name,
            type: job.type,
            collection: job.collection,
            environment: job.environment || null,
            reporters: job.reporters || ['cli', 'htmlextra', 'json'],
            extra: job.extra || []
          });
        }
      } catch (error) {
        console.warn(`작업 파일 파싱 실패: ${file}`, error.message);
      }
    }
    
    res.json(jobs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 작업 실행
app.post('/api/run/:job', async (req, res) => {
  try {
    const jobName = req.params.job;
    const result = await runJob(jobName);
    res.json(result);
  } catch (error) {
    res.status(500).json({ started: false, reason: error.message });
  }
});

// 실행 이력 조회 (페이징 지원)
app.get('/api/history', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const size = parseInt(req.query.size) || 10;
    const searchQuery = req.query.search || '';
    const jobFilter = req.query.job || '';
    const rangeFilter = req.query.range || '';
    
    let history = readHistory();
    
    // 필터링
    if (searchQuery || jobFilter || rangeFilter) {
      const now = Date.now();
      
      function isInRange(timestamp) {
        if (!rangeFilter || !timestamp) return true;
        
        try {
          const time = Date.parse(timestamp.replace(' ', 'T') + '+09:00');
          if (rangeFilter === '24h') return (now - time) <= (24 * 3600 * 1000);
          if (rangeFilter === '7d') return (now - time) <= (7 * 24 * 3600 * 1000);
        } catch (error) {
          return true;
        }
        
        return true;
      }
      
      history = history.filter(record => {
        const jobMatch = !jobFilter || record.job === jobFilter;
        const rangeMatch = isInRange(record.timestamp);
        const searchMatch = !searchQuery || 
          `${record.job || ''} ${record.summary || ''}`.toLowerCase()
            .includes(searchQuery.toLowerCase());
        
        return jobMatch && rangeMatch && searchMatch;
      });
    }
    
    // 페이징
    const total = history.length;
    const totalPages = Math.ceil(total / size);
    const startIndex = (page - 1) * size;
    const endIndex = startIndex + size;
    const items = history.slice().reverse().slice(startIndex, endIndex);
    
    res.json({
      items,
      total,
      page,
      size,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      running: state.running
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SSE 상태 스트림
app.get('/api/stream/state', (req, res) => {
  setSseHeaders(res);
  stateClients.add(res);
  
  console.log(`[SSE] 상태 클라이언트 연결: ${stateClients.size}개`);
  
  const lastHistory = readHistory().at(-1) || null;
  res.write(`event: state\ndata: ${JSON.stringify({ 
    running: state.running, 
    last: lastHistory,
    serverTime: Date.now()
  })}\n\n`);
  
  req.on('close', () => {
    stateClients.delete(res);
    console.log(`[SSE] 상태 클라이언트 연결 해제: ${stateClients.size}개 남음`);
  });
  
  req.on('error', (error) => {
    console.log(`[SSE] 상태 클라이언트 오류: ${error.message}`);
    stateClients.delete(res);
  });
});

// SSE 로그 스트림
app.get('/api/stream/logs', (req, res) => {
  setSseHeaders(res);
  logClients.add(res);
  
  console.log(`[SSE] 로그 클라이언트 연결: ${logClients.size}개`);
  
  req.on('close', () => {
    logClients.delete(res);
    console.log(`[SSE] 로그 클라이언트 연결 해제: ${logClients.size}개 남음`);
  });
  
  req.on('error', (error) => {
    console.log(`[SSE] 로그 클라이언트 오류: ${error.message}`);
    logClients.delete(res);
  });
});

// 스케줄 관리 API
app.get('/api/schedule', (req, res) => {
  const scheduleList = Array.from(schedules.entries()).map(([name, data]) => ({
    name,
    cronExpr: data.cronExpr,
    active: data.task.running,
    lastRun: data.lastRun || null
  }));
  
  res.json(scheduleList);
});

app.post('/api/schedule', (req, res) => {
  try {
    let name, cronExpr;
    
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('application/json')) {
      ({ name, cronExpr } = req.body);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      name = req.body.name;
      cronExpr = req.body.cronExpr;
    } else {
      return res.status(400).json({ message: 'Content-Type을 지정하세요' });
    }
    
    if (!name || !cronExpr) {
      return res.status(400).json({ message: 'name과 cronExpr이 필요합니다' });
    }
    
    let processedCron = cronExpr;
    const parts = cronExpr.split(' ');
    if (parts.length === 6) {
      processedCron = parts.slice(1).join(' ');
      console.log(`[SCHEDULE] ${cronExpr} → ${processedCron} 변환`);
    }
    
    if (!cron.validate(processedCron)) {
      return res.status(400).json({ message: `잘못된 cron 표현식: ${processedCron}` });
    }
    
    if (schedules.has(name)) {
      schedules.get(name).task.stop();
      console.log(`[SCHEDULE] 기존 스케줄 중지: ${name}`);
    }
    
    const task = cron.schedule(processedCron, async () => {
      console.log(`[SCHEDULE] 스케줄 실행: ${name}`);
      schedules.get(name).lastRun = getCurrentTimeString();
      
      const result = await runJob(name);
      if (!result.started) {
        console.error(`[SCHEDULE] 스케줄 실행 실패: ${name} - ${result.reason}`);
      }
    }, {
      scheduled: true,
      timezone: 'Asia/Seoul'
    });
    
    schedules.set(name, {
      task,
      cronExpr: processedCron,
      lastRun: null
    });
    
    console.log(`[SCHEDULE] 새 스케줄 등록: ${name} (${processedCron})`);
    res.json({ message: '스케줄이 등록되었습니다', name, cronExpr: processedCron });
    
  } catch (error) {
    console.error('[SCHEDULE] 스케줄 등록 오류:', error);
    res.status(500).json({ message: `서버 오류: ${error.message}` });
  }
});

app.delete('/api/schedule/:name', (req, res) => {
  try {
    const name = req.params.name;
    
    if (schedules.has(name)) {
      schedules.get(name).task.stop();
      schedules.delete(name);
      console.log(`[SCHEDULE] 스케줄 삭제: ${name}`);
      res.json({ message: '스케줄이 삭제되었습니다' });
    } else {
      res.status(404).json({ message: '스케줄을 찾을 수 없습니다' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// 알람 설정 API
app.get('/api/alert/config', (req, res) => {
  try {
    const config = readConfig();
    res.json({
      webhook_url: config.webhook_url ? '설정됨' : '미설정',
      run_event_alert: config.run_event_alert !== false,
      alert_on_start: config.alert_on_start !== false,
      alert_on_success: config.alert_on_success !== false,
      alert_on_error: config.alert_on_error !== false,
      alert_method: config.alert_method || 'flex'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/alert/config', (req, res) => {
  try {
    const config = readConfig();
    const updates = req.body;
    
    Object.assign(config, updates);
    
    const configPath = path.join(configDir, 'settings.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    
    res.json({ message: '설정이 저장되었습니다' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 알람 테스트
app.post('/api/alert/test', async (req, res) => {
  try {
    const config = readConfig();
    
    if (!config.webhook_url && !process.env.NW_HOOK) {
      return res.status(400).json({ 
        ok: false, 
        message: 'Webhook URL이 설정되지 않았습니다.'
      });
    }

    const testData = {
      jobName: 'TEST_JOB',
      collection: 'test_collection.json',
      environment: 'test_environment.json',
      startTime: getCurrentTimeString(),
      duration: 42,
      exitCode: 0,
      newmanStats: {
        requests: { total: 5, failed: 0 },
        assertions: { total: 10, failed: 0 },
        testScripts: { total: 3, failed: 0 }
      },
      detailedStats: {
        successRate: 100,
        avgResponseTime: 245,
        totalDuration: 2100
      }
    };

    let result;
    if (config.alert_method === 'flex') {
      const flexMessage = buildRunStatusFlex('success', testData);
      result = await sendFlexMessage(flexMessage);
    } else {
      const textMessage = buildBasicStatusText('success', testData);
      result = await sendTextMessage(textMessage);
    }
    
    if (result.ok) {
      res.json({ ok: true, message: '테스트 알람을 전송했습니다' });
    } else {
      res.status(500).json({ ok: false, message: '알람 전송에 실패했습니다', details: result });
    }
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

// 웹훅 연결 테스트
app.post('/api/alert/test-connection', async (req, res) => {
  try {
    const result = await testWebhookConnection();
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== 시스템 관리 ====================

// 하트비트 (30초마다)
setInterval(() => {
  const heartbeat = `event: heartbeat\ndata: ${JSON.stringify({ 
    timestamp: Date.now(),
    stateClients: stateClients.size,
    logClients: logClients.size
  })}\n\n`;
  
  const deadStateClients = new Set();
  for (const client of stateClients) {
    try {
      if (!client.destroyed && !client.finished) {
        client.write(heartbeat);
        client.flushHeaders?.();
      } else {
        deadStateClients.add(client);
      }
    } catch {
      deadStateClients.add(client);
    }
  }
  
  const deadLogClients = new Set();
  for (const client of logClients) {
    try {
      if (!client.destroyed && !client.finished) {
        client.write(heartbeat);
        client.flushHeaders?.();
      } else {
        deadLogClients.add(client);
      }
    } catch {
      deadLogClients.add(client);
    }
  }
  
  deadStateClients.forEach(client => stateClients.delete(client));
  deadLogClients.forEach(client => logClients.delete(client));
  
}, 30000);

// 메모리 모니터링 (개발 모드)
if (process.env.NODE_ENV === 'development') {
  setInterval(() => {
    const memUsage = process.memoryUsage();
    console.log(`[MEMORY] RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB, Heap: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
    console.log(`[CONNECTIONS] State: ${stateClients.size}, Log: ${logClients.size}`);
    console.log(`[BUFFER] Pending logs: ${logBuffer.length}`);
  }, 30000);
}

// 프로세스 종료 시 정리
process.on('SIGINT', () => {
  console.log('\n[SERVER] 서버 종료 중...');
  
  stateClients.forEach(client => {
    try { client.end(); } catch {}
  });
  logClients.forEach(client => {
    try { client.end(); } catch {}
  });
  
  schedules.forEach(({ task }) => {
    try { task.stop(); } catch {}
  });
  
  process.exit(0);
});

// 정적 파일 서빙
app.use('/reports', express.static(reportsDir));
app.use('/logs', express.static(logsDir));
app.use('/', express.static(path.join(root, 'public')));

// 기본 라우트
app.get('/', (req, res) => {
  res.sendFile(path.join(root, 'public', 'index.html'));
});

// 서버 시작
const { site_port = 3000 } = readConfig();
app.listen(site_port, () => {
  console.log(`🚀 [SERVER] http://localhost:${site_port}`);
  console.log(`🔔 [ALERT] 알람 시스템 초기화 완료`);
  console.log(`📡 [SSE] 실시간 스트리밍 준비 완료`);
  console.log(`⚡ [OPTIMIZATION] 성능 최적화 모드 활성화`);
  console.log(`⏰ [SCHEDULE] 스케줄 시스템 준비 완료`);
});