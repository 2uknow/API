// server.js (알람 시스템 개선 + 성능 최적화 버전)
import express from 'express';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  sendTextMessage,
  sendFlexMessage,
  buildDailyReportText,
  buildDailyReportFlex
} from './alert.js';

// === 리팩토링 모듈 import ===
import { root, cfgPath, reportsDir, logsDir, readCfg } from './src/utils/config.js';
import { nowInTZString } from './src/utils/time.js';
import { stateClients, logClients, unifiedClients, logBuffer, recentLogHistory, sseHeaders, broadcastState, broadcastLog } from './src/utils/sse.js';
import { state, registerRunningJob, unregisterRunningJob, broadcastRunningJobs } from './src/state/running-jobs.js';
import { histRead } from './src/services/history-service.js';
import { initLogManagement } from './src/services/log-manager.js';
import { schedules, loadSchedules, saveSchedules, processSchedule } from './src/services/schedule-service.js';
import { getTodayStatsInternal, setupDailyReportScheduler } from './src/services/statistics-service.js';
import { runJob } from './src/runners/job-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

// 전역 캐시 비활성화 설정
app.disable('etag'); // ETag 완전 비활성화
app.set('view cache', false); // 뷰 캐시 비활성화

// 모든 요청에 대해 캐시 비활성화 헤더 설정
app.use((req, res, next) => {
  // 강력한 캐시 비활성화
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Last-Modified', new Date().toUTCString());
  
  // CORS 헤더 (로컬 개발 환경을 위한)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Last-Event-ID');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // 브라우저 호환성을 위한 추가 헤더
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  
  // OPTIONS 요청 처리 (CORS preflight)
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  
  next();
});

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware to log all requests
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url} - ${new Date().toISOString()}`);
  if (req.url.startsWith('/api/run/')) {
    console.log(`[REQUEST] Critical API call detected: ${req.method} ${req.url}`);
    console.log(`[REQUEST] Headers:`, JSON.stringify(req.headers, null, 2));
  }
  next();
});



// 스케줄 큐 관리 함수들
function addToScheduleQueue(jobName) {
  const queueItem = {
    jobName,
    timestamp: Date.now(),
    retryCount: 0
  };
  
  // 이미 큐에 있는 작업인지 확인
  const existing = state.scheduleQueue.find(item => item.jobName === jobName);
  if (existing) {
    console.log(`[SCHEDULE QUEUE] Job ${jobName} already in queue, skipping`);
    return false;
  }
  
  state.scheduleQueue.push(queueItem);
  console.log(`[SCHEDULE QUEUE] Added ${jobName} to queue. Queue length: ${state.scheduleQueue.length}`);
  broadcastLog(`[SCHEDULE QUEUE] ${jobName} queued for execution`, 'SYSTEM');
  
  // 큐 처리 시작
  processScheduleQueue();
  return true;
}

async function processScheduleQueue() {
  if (state.processingQueue) {
    console.log(`[SCHEDULE QUEUE] Already processing queue, returning`);
    return;
  }
  
  if (state.scheduleQueue.length === 0) {
    console.log(`[SCHEDULE QUEUE] Queue is empty`);
    return;
  }
  
  // 실행 중인 작업이 있으면 대기
  if (state.running && !state.batchMode) {
    console.log(`[SCHEDULE QUEUE] Job ${state.running.job} is running, waiting...`);
    setTimeout(() => processScheduleQueue(), 5000); // 5초 후 재시도
    return;
  }
  
  state.processingQueue = true;
  const queueItem = state.scheduleQueue.shift(); // 큐에서 첫 번째 작업 가져오기
  
  console.log(`[SCHEDULE QUEUE] Processing queued job: ${queueItem.jobName}`);
  broadcastLog(`[SCHEDULE QUEUE] Processing ${queueItem.jobName}`, 'SYSTEM');
  
  try {
    const result = await runJob(queueItem.jobName, true);
    
    if (!result.started && result.reason === 'already_running') {
      // 여전히 실행 중이면 다시 큐에 넣고 재시도
      queueItem.retryCount++;
      
      if (queueItem.retryCount < 3) { // 최대 3번 재시도
        console.log(`[SCHEDULE QUEUE] Job ${queueItem.jobName} still running, requeuing (attempt ${queueItem.retryCount}/3)`);
        state.scheduleQueue.unshift(queueItem); // 큐 앞쪽에 다시 넣기
        setTimeout(() => {
          state.processingQueue = false;
          processScheduleQueue();
        }, 10000); // 10초 후 재시도
      } else {
        console.log(`[SCHEDULE QUEUE] Job ${queueItem.jobName} max retries exceeded, dropping`);
        broadcastLog(`[SCHEDULE QUEUE] ${queueItem.jobName} dropped after max retries`, 'ERROR');
        state.processingQueue = false;
        processScheduleQueue(); // 다음 큐 아이템 처리
      }
    } else {
      console.log(`[SCHEDULE QUEUE] Job ${queueItem.jobName} execution result:`, result);
      state.processingQueue = false;
      
      // 작업 완료 후 다음 큐 처리
      setTimeout(() => processScheduleQueue(), 1000);
    }
  } catch (error) {
    console.error(`[SCHEDULE QUEUE] Error processing ${queueItem.jobName}:`, error);
    broadcastLog(`[SCHEDULE QUEUE] Error processing ${queueItem.jobName}: ${error.message}`, 'ERROR');
    state.processingQueue = false;
    
    // 에러 발생 시에도 다음 큐 처리
    setTimeout(() => processScheduleQueue(), 5000);
  }
}

// processScheduleQueue 완료 후 콜백 설정
state._onJobComplete = () => processScheduleQueue();

// SSE Heartbeat 전송 (5초마다)
setInterval(() => {
  const heartbeatData = JSON.stringify({ 
    type: 'heartbeat', 
    timestamp: new Date().toISOString() 
  });
  
  // State 클라이언트들에게 heartbeat 전송
  for (const client of stateClients) {
    try {
      client.write(`data: ${heartbeatData}\n\n`);
    } catch (err) {
      console.log('[SSE] State heartbeat 전송 실패, 클라이언트 제거');
      stateClients.delete(client);
    }
  }
  
  // Log 클라이언트들에게 heartbeat 전송
  for (const client of logClients) {
    try {
      client.write(`data: ${heartbeatData}\n\n`);
    } catch (err) {
      console.log('[SSE] Log heartbeat 전송 실패, 클라이언트 제거');
      logClients.delete(client);
    }
  }
}, 5000);

// API: jobs
app.get('/api/jobs', (req,res)=>{
  const dir = path.join(root, 'jobs');
  try{
    if (!fs.existsSync(dir)) return res.json([]);
    const files = fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
    const items = [];
    for (const f of files){
      try{
        const j = JSON.parse(fs.readFileSync(path.join(dir,f),'utf-8'));
        if (!j.name || !j.type) continue;
        items.push({
          file: f,
          name: j.name,
          type: j.type,
          collection: j.collection,
          environment: j.environment || null,
          reporters: j.reporters || ['cli','htmlextra','junit','json'],
          extra: j.extra || []
        });
      } catch {}
    }
    res.json(items);
  }catch(e){ res.status(500).json({ error:e.message }); }
});

// 상태 강제 초기화 API (디버깅 및 응급 상황용)
app.post('/api/reset-state', (req, res) => {
  console.log('[API] Force reset state requested');
  const previousState = state.running;
  
  // 모든 실행 중인 job 정리
  for (const [jobName, info] of state.runningJobs) {
    if (info.proc && !info.proc.killed) {
      try { info.proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
    }
  }
  state.runningJobs.clear();
  state.running = null;
  state.batchMode = false;
  broadcastRunningJobs();
  broadcastLog('[SYSTEM] State forcefully reset by user', 'SYSTEM');
  
  res.json({ 
    ok: true, 
    message: 'State reset successfully',
    previousState: previousState
  });
  
  console.log('[API] State reset completed, previous state:', previousState);
});

// 현재 실행 중인 Job 목록 API
app.get('/api/running', (req, res) => {
  const runningList = [];
  for (const [name, info] of state.runningJobs) {
    runningList.push({
      job: name,
      startAt: info.startTime,
      type: info.type,
      elapsed: Math.round((Date.now() - info.startTs) / 1000),
      hasPid: !!(info.proc && info.proc.pid)
    });
  }
  res.json({ ok: true, running: runningList, count: runningList.length });
});

// 특정 Job 중지 API
app.post('/api/stop/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  console.log(`[API] Stop request for job: ${name}`);
  
  const jobInfo = state.runningJobs.get(name);
  if (!jobInfo) {
    return res.status(404).json({ ok: false, reason: 'not_running', message: `Job '${name}'이(가) 실행 중이 아닙니다.` });
  }
  
  // 프로세스 종료
  if (jobInfo.proc && !jobInfo.proc.killed) {
    try {
      jobInfo.proc.kill('SIGTERM');
      console.log(`[API] Sent SIGTERM to job: ${name} (PID: ${jobInfo.proc.pid})`);
      broadcastLog(`[STOPPED] ${name} - 사용자에 의해 중지됨`, 'SYSTEM');
    } catch (e) {
      console.error(`[API] Failed to kill process for ${name}:`, e.message);
      // 강제 kill 시도
      try { jobInfo.proc.kill('SIGKILL'); } catch (e2) { /* ignore */ }
    }
  }
  
  // Map에서 제거 & 상태 업데이트
  unregisterRunningJob(name);
  broadcastLog(`[EXECUTION_COMPLETE] ${name}`, 'SYSTEM');
  broadcastLog(`[JOB_FINISHED] ${name} with code -1 (stopped)`, 'SYSTEM');
  
  res.json({ ok: true, message: `Job '${name}'이(가) 중지되었습니다.` });
});

// 현재 서버 상태 확인 API
app.get('/api/status', (req, res) => {
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
      processing: state.processingQueue
    },
    clients: {
      state: stateClients.size,
      log: logClients.size,
      unified: unifiedClients.size
    }
  });
});

app.get('/api/history', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const size = parseInt(req.query.size) || 20;
  const searchQuery = req.query.search || '';
  const jobFilter = req.query.job || '';
  const rangeFilter = req.query.range || '';
  const statusFilter = req.query.status || ''; // 'success', 'failed', or ''
  const dateFrom = req.query.dateFrom || '';   // 'YYYY-MM-DD'
  const dateTo = req.query.dateTo || '';       // 'YYYY-MM-DD'

  let history = histRead();

  // 필터링 로직
  if (searchQuery || jobFilter || rangeFilter || statusFilter || dateFrom || dateTo) {
    const now = Date.now();

    function inRange(ts) {
      if (!rangeFilter) return true;
      const t = Date.parse(ts.replace(' ', 'T') + '+09:00');
      if (rangeFilter === '24h') return (now - t) <= (24 * 3600 * 1000);
      if (rangeFilter === '7d') return (now - t) <= (7 * 24 * 3600 * 1000);
      return true;
    }

    function inDateRange(ts) {
      if (!dateFrom && !dateTo) return true;
      const dateStr = ts.split(' ')[0]; // 'YYYY-MM-DD'
      if (dateFrom && dateStr < dateFrom) return false;
      if (dateTo && dateStr > dateTo) return false;
      return true;
    }

    function matchStatus(exitCode) {
      if (!statusFilter) return true;
      if (statusFilter === 'success') return exitCode === 0;
      if (statusFilter === 'failed') return exitCode !== 0;
      return true;
    }

    history = history.filter(r => {
      const jobMatch = !jobFilter || r.job === jobFilter;
      const rangeMatch = inRange(r.timestamp);
      const dateRangeMatch = inDateRange(r.timestamp);
      const statusMatch = matchStatus(r.exitCode);

      // 검색어 매칭 - job, summary, status(exitCode 기반) 모두 검색
      let searchMatch = true;
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const status = r.exitCode === 0 ? 'success' : 'failed';
        const searchTarget = ((r.job || '') + ' ' + (r.summary || '') + ' ' + status).toLowerCase();
        searchMatch = searchTarget.includes(query);
      }

      return jobMatch && rangeMatch && dateRangeMatch && statusMatch && searchMatch;
    });
  }
  
  // 페이징
  const total = history.length;
  const totalPages = Math.ceil(total / size);
  const startIndex = (page - 1) * size;
  const endIndex = startIndex + size;
  const rawItems = history.slice().reverse().slice(startIndex, endIndex);

  // history.json의 필드를 API 응답 형식으로 변환
  const items = rawItems.map(item => ({
    ...item,
    report: item.reportPath || item.report || '',
    htmlReport: item.reportPath || item.htmlReport || '',
    duration: item.duration || 0
  }));

  // 응답 구조 수정 - 클라이언트가 기대하는 형태로
  res.json({
    items,
    total,           // ← 추가
    page,            // ← 추가  
    size,            // ← 추가
    totalPages,      // ← 추가
    hasNext: page < totalPages,
    hasPrev: page > 1,
    pagination: {    // ← 기존 구조도 유지 (하위호환)
      page,
      size,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    },
    running: state.running
  });
});
// SSE 엔드포인트들 (최적화된 버전)
// SSE 엔드포인트 개선
app.get('/api/stream/state', (req, res) => {
  sseHeaders(res);
  stateClients.add(res);
  
  console.log(`[SSE] State client connected: ${stateClients.size} total`);
  
  // 초기 상태 전송
  const last = histRead().at(-1) || null;
  res.write(`event: state\ndata: ${JSON.stringify({ 
    running: state.running, 
    last,
    scheduleQueue: {
      length: state.scheduleQueue.length,
      processing: state.processingQueue
    },
    serverTime: Date.now()
  })}\n\n`);
  
  // 연결 종료 처리
  req.on('close', () => {
    stateClients.delete(res);
    console.log(`[SSE] State client disconnected: ${stateClients.size} remaining`);
  });
  
  req.on('error', (error) => {
    console.log(`[SSE] State client error: ${error.message}`);
    stateClients.delete(res);
  });
  
  // 연결 유지를 위한 즉시 핑
  setTimeout(() => {
    if (!res.destroyed && !res.finished) {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch (e) {
        stateClients.delete(res);
      }
    }
  }, 1000);
});

app.get('/api/stream/logs', (req, res) => {
  sseHeaders(res);
  logClients.add(res);
  
  console.log(`[SSE] Log client connected: ${logClients.size} total`);
  
  // 연결 종료 처리
  req.on('close', () => {
    logClients.delete(res);
    console.log(`[SSE] Log client disconnected: ${logClients.size} remaining`);
  });
  
  req.on('error', (error) => {
    console.log(`[SSE] Log client error: ${error.message}`);
    logClients.delete(res);
  });
  
  // 연결 유지를 위한 즉시 핑
  setTimeout(() => {
    if (!res.destroyed && !res.finished) {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch (e) {
        logClients.delete(res);
      }
    }
  }, 1000);
});

// 통합 SSE 엔드포인트 (단일 연결로 state + logs 모두 제공)

app.get('/api/stream/unified', (req, res) => {
  sseHeaders(res);
  unifiedClients.add(res);
  
  console.log(`[SSE] Unified client connected: ${unifiedClients.size} total`);
  
  // 연결 종료 처리
  req.on('close', () => {
    unifiedClients.delete(res);
    console.log(`[SSE] Unified client disconnected: ${unifiedClients.size} remaining`);
  });
  
  req.on('error', (error) => {
    console.log(`[SSE] Unified client error: ${error.message}`);
    unifiedClients.delete(res);
  });
  
  // 즉시 현재 상태 전송
  setTimeout(() => {
    if (!res.destroyed && !res.finished) {
      try {
        // 현재 상태 전송 (runningJobs 포함)
        const runningJobsList = [];
        for (const [jobName, info] of state.runningJobs) {
          runningJobsList.push({
            job: jobName,
            startAt: info.startTime,
            type: info.type || 'unknown',
            elapsed: Math.round((Date.now() - info.startTs) / 1000)
          });
        }
        
        res.write(`event: state\ndata: ${JSON.stringify({ 
          running: state.running,
          runningJobs: runningJobsList,
          timestamp: Date.now()
        })}\n\n`);
        
        // 실행 중인 Job이 있으면 최근 로그 히스토리 재전송
        if (state.runningJobs.size > 0 && recentLogHistory.length > 0) {
          console.log(`[SSE] Replaying ${recentLogHistory.length} recent logs to new client`);
          for (const logEntry of recentLogHistory) {
            res.write(logEntry);
          }
        }
        
        // 연결 확인 핑
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch (e) {
        unifiedClients.delete(res);
      }
    }
  }, 100);
});

// 더 자주, 더 안정적인 하트비트
setInterval(() => {
  const timestamp = Date.now();
  const heartbeatData = `event: heartbeat\ndata: ${JSON.stringify({ 
    timestamp, 
    stateClients: stateClients.size,
    logClients: logClients.size,
    unifiedClients: unifiedClients.size 
  })}\n\n`;
  
  // State 클라이언트 하트비트
  const deadStateClients = new Set();
  for (const c of stateClients) {
    try {
      if (!c.destroyed && !c.finished) {
        c.write(heartbeatData);
        c.flushHeaders?.();
      } else {
        deadStateClients.add(c);
      }
    } catch (error) {
      deadStateClients.add(c);
    }
  }
  
  // Log 클라이언트 하트비트
  const deadLogClients = new Set();
  for (const c of logClients) {
    try {
      if (!c.destroyed && !c.finished) {
        c.write(heartbeatData);
        c.flushHeaders?.();
      } else {
        deadLogClients.add(c);
      }
    } catch (error) {
      deadLogClients.add(c);
    }
  }
  
  // Unified 클라이언트 하트비트
  const deadUnifiedClients = new Set();
  for (const c of unifiedClients) {
    try {
      if (!c.destroyed && !c.finished) {
        c.write(heartbeatData);
        c.flushHeaders?.();
      } else {
        deadUnifiedClients.add(c);
      }
    } catch (error) {
      deadUnifiedClients.add(c);
    }
  }
  
  // 끊어진 연결들 정리
  for (const c of deadStateClients) stateClients.delete(c);
  for (const c of deadLogClients) logClients.delete(c);
  for (const c of deadUnifiedClients) unifiedClients.delete(c);
  
  if (deadStateClients.size > 0 || deadLogClients.size > 0 || deadUnifiedClients.size > 0) {
    console.log(`[SSE] Cleaned up ${deadStateClients.size + deadLogClients.size + deadUnifiedClients.size} dead connections`);
  }
  
}, 15000); // 30초 -> 15초로 단축

// 연결 상태 모니터링 (개발 모드)
if (process.env.NODE_ENV === 'development') {
  setInterval(() => {
    const memUsage = process.memoryUsage();
    console.log(`[MONITOR] Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB`);
    console.log(`[MONITOR] SSE Connections - State: ${stateClients.size}, Log: ${logClients.size}`);
    console.log(`[MONITOR] Log Buffer: ${logBuffer.length} pending`);
    console.log(`[MONITOR] Running Jobs: ${state.running ? 1 : 0}`);
  }, 30000);
}
// Schedules

app.get('/api/schedule',(req,res)=>{ 
  res.json([...schedules.entries()].map(([name,{cronExpr}])=>({name,cronExpr})));
});

app.post('/api/schedule',(req,res)=>{ 
  try {
    let name, cronExpr;
    
    // Content-Type에 따라 다르게 처리
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('application/json')) {
      // JSON 방식
      ({ name, cronExpr } = req.body);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      // Form-data 방식
      name = req.body.name;
      cronExpr = req.body.cronExpr;
    } else {
      // 기존 방식 (raw body 읽기)
      let body=''; 
      req.on('data',c=>body+=c); 
      req.on('end',()=>{ 
        try{ 
          ({ name, cronExpr } = JSON.parse(body||'{}')); 
          processSchedule(name, cronExpr, res, addToScheduleQueue);
        }catch(e){ 
          res.status(400).json({message:'invalid body'});
        } 
      });
      return; // early return으로 나머지 코드 실행 방지
    }
    
    processSchedule(name, cronExpr, res, addToScheduleQueue);
    
  } catch(e) {
    console.error('[SCHEDULE API ERROR]', e);
    res.status(500).json({message: 'Server error: ' + e.message});
  }
});

app.delete('/api/schedule/:name',(req,res)=>{ 
  const {name}=req.params; 
  const it=schedules.get(name); 
  if(it){ 
    it.task.stop(); 
    schedules.delete(name); 
    saveSchedules(); 
  } 
  res.json({ok:true});
});

loadSchedules(addToScheduleQueue);

// spawn
// 오늘 날짜 통계 API 엔드포인트 추가
app.get('/api/statistics/today', (req, res) => {
  try {
    const history = histRead();
    
    // 한국 시간 기준으로 오늘 날짜 계산 (올바른 방법)
    const now = new Date();
    const todayStr = new Intl.DateTimeFormat('sv-SE', { 
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now); // YYYY-MM-DD 형식
    
    console.log(`[STATS] Today (KST): ${todayStr}, Server time: ${now.toISOString()}`);
    console.log(`[STATS] Total history items: ${history.length}`);
    
    // 오늘 실행된 이력만 필터링 (한국 시간 기준)
    const todayHistory = history.filter(item => {
      if (!item.timestamp) return false;
      
      try {
        // timestamp 형식: "2024-12-25 14:30:45" (한국 시간)
        let itemDateStr;
        
        if (item.timestamp.includes('T')) {
          // ISO 형식인 경우 (UTC 시간을 KST로 변환)
          const itemDate = new Date(item.timestamp);
          itemDateStr = new Intl.DateTimeFormat('sv-SE', { 
            timeZone: 'Asia/Seoul',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
          }).format(itemDate);
        } else {
          // "YYYY-MM-DD HH:mm:ss" 형식인 경우 (이미 한국 시간)
          itemDateStr = item.timestamp.split(' ')[0];
        }
        
        const isToday = itemDateStr === todayStr;
        if (isToday) {
          console.log(`[STATS] Today item found: ${item.timestamp} -> ${itemDateStr} (job: ${item.job}, exitCode: ${item.exitCode})`);
        }
        
        return isToday;
      } catch (error) {
        console.log(`[STATS] Invalid timestamp format: ${item.timestamp}`);
        return false;
      }
    });
    
    console.log(`[STATS] Today's filtered items: ${todayHistory.length}`);
    
    if (todayHistory.length === 0) {
      return res.json({
        totalExecutions: 0,
        successRate: 0,
        avgResponseTime: 0,
        failedTests: 0,
        lastExecution: null
      });
    }
    
    // 통계 계산 (오늘 데이터만 사용)
    const totalExecutions = todayHistory.length;
    const successfulExecutions = todayHistory.filter(item => item.exitCode === 0).length;
    const failedTests = totalExecutions - successfulExecutions;
    const successRate = totalExecutions > 0 ? Math.round((successfulExecutions / totalExecutions) * 100) : 0;
    
    console.log(`[STATS] Today's calculations:`);
    console.log(`  - Total executions: ${totalExecutions}`);
    console.log(`  - Successful: ${successfulExecutions}`);
    console.log(`  - Failed: ${failedTests}`);
    console.log(`  - Success rate: ${successRate}%`);
    
    // Newman JSON 리포트에서 평균 응답 시간 계산
    let avgResponseTime = 0;
    const validResponseTimes = [];
    
    todayHistory.forEach(item => {
      // detailedStats에서 Newman/Binary의 avgResponseTime 사용 (우선순위 1)
      if (item.detailedStats && item.detailedStats.avgResponseTime > 0) {
        validResponseTimes.push(item.detailedStats.avgResponseTime);
      }
      // newmanStats가 있고 timings 정보가 있는 경우 (우선순위 2)
      else if (item.newmanStats && item.newmanStats.timings && item.newmanStats.timings.responseAverage > 0) {
        validResponseTimes.push(item.newmanStats.timings.responseAverage);
      }
      // duration 사용 (newman, binary 모두 포함)
      else if (item.duration && item.duration > 0) {
        validResponseTimes.push(item.duration * 1000);
      }
    });
    
    if (validResponseTimes.length > 0) {
      const totalResponseTime = validResponseTimes.reduce((sum, time) => sum + time, 0);
      avgResponseTime = Math.round(totalResponseTime / validResponseTimes.length);
    }
    
    // 마지막 실행 정보 - Newman 통계 포함
    let lastExecution = null;
    if (todayHistory.length > 0) {
      const lastItem = todayHistory[0];
      lastExecution = {
        timestamp: lastItem.timestamp,
        job: lastItem.job,
        exitCode: lastItem.exitCode,
        duration: lastItem.duration,
        responseTime: lastItem.detailedStats?.avgResponseTime || 
                     lastItem.newmanStats?.timings?.responseAverage || 
                     (lastItem.duration ? lastItem.duration * 1000 : null)
      };
    }
    
    res.json({
      totalExecutions,
      successRate,
      avgResponseTime, // 이제 Newman의 실제 응답 시간 (밀리초)
      failedTests,
      lastExecution,
      debug: {
        todayKST: todayStr,
        serverTime: now.toISOString(),
        totalHistoryCount: history.length,
        todayHistoryCount: todayHistory.length,
        validResponseTimes: validResponseTimes.length,
        sampleResponseTimes: validResponseTimes.slice(0, 3), // 디버깅용 샘플
        sampleTimestamps: todayHistory.slice(0, 3).map(item => item.timestamp) // 오늘 데이터 확인용
      }
    });
    
  } catch (error) {
    console.error('[STATISTICS ERROR]', error);
    res.status(500).json({ 
      error: error.message,
      totalExecutions: 0,
      successRate: 0,
      avgResponseTime: 0,
      failedTests: 0,
      lastExecution: null
    });
  }
});
// Diagnostic endpoint to test HTTP responses
app.get('/api/test', (req, res) => {
  console.log(`[TEST] Test endpoint called at ${new Date().toISOString()}`);
  res.json({ status: 'ok', timestamp: new Date().toISOString(), message: 'Server is responding' });
});

// Test POST endpoint
app.post('/api/test', (req, res) => {
  console.log(`[TEST POST] Test POST endpoint called at ${new Date().toISOString()}`);
  console.log(`[TEST POST] Headers:`, req.headers);
  console.log(`[TEST POST] Body:`, req.body);
  res.json({ status: 'ok', method: 'POST', timestamp: new Date().toISOString(), message: 'POST is working' });
});

// GET /api/run/:name (임시로 GET으로 변경)
app.get('/api/run/:name', async (req,res)=>{
  const name = decodeURIComponent(req.params.name);
  console.log(`[API] GET /api/run/${name} - Job execution request received`);

  try {
    if (state.runningJobs.has(name)) {
      const jobInfo = state.runningJobs.get(name);
      const runningTime = Date.now() - jobInfo.startTs;
      
      const timeoutLimit = state.batchMode ? 30000 : 10000;
      if (runningTime > timeoutLimit) {
        console.log(`[API] Job ${name} running too long (${runningTime}ms), forcing cleanup`);
        unregisterRunningJob(name);
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

// 알람 설정 API들
app.get('/api/alert/config', (req, res) => {
  try {
    const config = readCfg();
    res.json({
      run_event_alert: config.run_event_alert || false,
      alert_on_start: config.alert_on_start || false,
      alert_on_success: config.alert_on_success || false,
      alert_on_error: config.alert_on_error || false,
      alert_method: config.alert_method || 'text',
      webhook_url: config.webhook_url ? '설정됨' : '미설정',
      daily_report_enabled: config.daily_report_enabled || false,
      daily_report_times: config.daily_report_times || ['18:00'],
      daily_report_days: config.daily_report_days || [1, 2, 3, 4, 5]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/alert/config', (req, res) => {
  try {
    const currentConfig = readCfg();
    const newConfig = { ...currentConfig, ...req.body };

    const configDir = path.dirname(cfgPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2));

    setupDailyReportScheduler();

    res.json({ ok: true, message: '설정이 저장되었습니다.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/alert/test', async (req, res) => {
  try {
    const config = readCfg();
    
    if (!config.webhook_url) {
      return res.status(400).json({ 
        ok: false, 
        message: 'Webhook URL이 설정되지 않았습니다.' 
      });
    }

    const flexMessage = {
      type: 'flex',
      altText: '[테스트] API 자동화 모니터링 시스템',
      contents: {
        type: 'bubble',
        size: 'kilo',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '🔔 테스트 알람', weight: 'bold', size: 'lg', color: '#1f2937' },
            { type: 'text', text: 'API 자동화 모니터링', size: 'sm', color: '#6b7280', margin: 'xs' }
          ],
          backgroundColor: '#f3f4f6',
          paddingAll: 'lg'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              contents: [
                { type: 'text', text: '✅ 알람 시스템이 정상적으로 작동합니다!', wrap: true, size: 'md' },
                { type: 'text', text: '설정이 올바르게 되어있는지 확인하세요.', wrap: true, size: 'sm', color: '#6b7280', margin: 'md' }
              ]
            }
          ],
          paddingAll: 'lg'
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: nowInTZString(), size:'xs', color:'#888888', align:'end' }
              ]
            }
          ]
        }
      }
    };
    const r = await sendFlexMessage(flexMessage);
    res.status(r.ok ? 200 : 500).json(r);
  }catch(e){
    res.status(500).json({ ok:false, status:0, body:e.message });
  }
});

// 정기 리포트 테스트 발송 API
app.post('/api/alert/daily-report/test', async (req, res) => {
  try {
    const stats = await getTodayStatsInternal();
    const config = readCfg();

    let result;
    if (config.alert_method === 'flex') {
      const flexMsg = buildDailyReportFlex(stats);
      result = await sendFlexMessage(flexMsg);
    } else {
      const textMsg = buildDailyReportText(stats);
      result = await sendTextMessage(textMsg);
    }

    res.json({
      ok: result.ok,
      message: result.ok ? '테스트 리포트가 발송되었습니다.' : '발송 실패',
      stats: stats
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

// 정적 파일 서빙 (캐시 비활성화)
app.use('/reports', express.static(reportsDir, {
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));
app.use('/logs', express.static(logsDir, {
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));
app.use('/', express.static(path.join(root, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('ETag', false);
    }
  }
}));

app.get('/api/debug/sse-status', (req, res) => {
  res.json({
    stateClients: stateClients.size,
    logClients: logClients.size,
    logBuffer: logBuffer.length,
    serverTime: new Date().toISOString()
  });
});

app.get('/api/debug/cache-status', (req, res) => {
  res.json({
    cacheDisabled: true,
    etagDisabled: !app.get('etag'),
    viewCacheDisabled: !app.get('view cache'),
    serverTime: new Date().toISOString(),
    headers: {
      'cache-control': 'no-cache, no-store, must-revalidate',
      'pragma': 'no-cache',
      'expires': '0'
    }
  });
});

app.post('/api/debug/clear-cache', (req, res) => {
  res.json({
    success: true,
    message: '캐시 클리어 신호가 전송되었습니다. 브라우저를 새로고침해주세요.',
    timestamp: new Date().toISOString(),
    instruction: 'Ctrl+F5 또는 Ctrl+Shift+R로 강제 새로고침하세요.'
  });
});

// 네트워크 연결 테스트 엔드포인트
app.get('/test', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json({
    status: 'OK',
    message: '서버 연결 성공!',
    timestamp: new Date().toISOString(),
    clientIP: req.ip || req.connection.remoteAddress,
    userAgent: req.get('User-Agent'),
    serverInfo: {
      nodeVersion: process.version,
      platform: process.platform,
      uptime: process.uptime()
    }
  });
});

// 기본 라우트
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('ETag', false);
  res.sendFile(path.join(root, 'public', 'index.html'));
});

// 프로세스 종료 시 정리
process.on('SIGINT', () => {
  console.log('\n[SERVER] 서버 종료 중...');
  
  for (const c of stateClients) {
    try { c.end(); } catch {}
  }
  for (const c of logClients) {
    try { c.end(); } catch {}
  }
  
  process.exit(0);
});

const cfg = readCfg();
const { site_port = 3000, base_url } = cfg;

// 서버 시작 시 정기 리포트 스케줄러 초기화
setupDailyReportScheduler();

// 로그 관리 스케줄러 초기화 (일별 스플릿 + 7일 이후 압축)
initLogManagement();

app.listen(site_port, '0.0.0.0', () => {
  const displayUrl = base_url || `http://localhost:${site_port}`;
  
  // 네트워크 인터페이스 정보 출력
  import('os').then(os => {
    const interfaces = os.networkInterfaces();
    const ipAddresses = [];
    
    Object.keys(interfaces).forEach(interfaceName => {
      interfaces[interfaceName].forEach(address => {
        if (address.family === 'IPv4' && !address.internal) {
          ipAddresses.push(address.address);
        }
      });
    });
    
    console.log(`[SITE] ${displayUrl}`);
    console.log(`[LOCAL] http://localhost:${site_port}`);
    console.log(`[NETWORK] 서버가 모든 네트워크 인터페이스(0.0.0.0:${site_port})에서 리스닝 중`);
    
    if (ipAddresses.length > 0) {
      console.log(`[IP ACCESS] 다음 IP로 접속 가능:`);
      ipAddresses.forEach(ip => {
        console.log(`  - http://${ip}:${site_port}`);
      });
    }
    
    console.log(`[CACHE] 전역 캐시 비활성화 완료 - 빠른 로딩 지원`);
    console.log(`[CACHE] ETag, 정적 파일 캐시, 브라우저 캐시 모두 비활성화됨`);
    console.log(`[CORS] CORS 헤더 활성화`);
    console.log(`[ALERT] 알람 시스템 초기화 완료`);
    console.log(`[SSE] 실시간 로그 스트리밍 준비 완료`);
    console.log(`[SCHEDULE] 스케줄 시스템 로드 완료`);
  });
});

