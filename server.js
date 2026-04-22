// server.js — Express 앱 초기화, 미들웨어, 스케줄 큐, 라우트 마운트, SSE 하트비트
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';

// === 리팩토링 모듈 import ===
import { root, reportsDir, logsDir, readCfg } from './src/utils/config.js';
import { stateClients, logClients, unifiedClients, logBuffer, broadcastLog } from './src/utils/sse.js';
import { state } from './src/state/running-jobs.js';
import { initLogManagement } from './src/services/log-manager.js';
import { initHistoryCache } from './src/services/history-service.js';
import { loadSchedules } from './src/services/schedule-service.js';
import { setupDailyReportScheduler } from './src/services/statistics-service.js';
import { runJob } from './src/runners/job-runner.js';
import cron from 'node-cron';

// === 라우트 모듈 ===
import jobsRouter from './src/routes/api-jobs.js';
import historyRouter from './src/routes/api-history.js';
import streamRouter from './src/routes/api-stream.js';
import scheduleRouter from './src/routes/api-schedule.js';
import alertRouter from './src/routes/api-alert.js';
import statisticsRouter from './src/routes/api-statistics.js';
import debugRouter from './src/routes/api-debug.js';

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
  if (state.scheduleQueue.length === 0) {
    return;
  }
  
  // 큐에서 실행 가능한 job을 모두 꺼내서 동시 실행
  const toRun = [];
  const deferred = [];
  
  for (const item of state.scheduleQueue) {
    if (state.runningJobs.has(item.jobName)) {
      // 같은 이름의 job이 이미 실행 중이면 보류
      item.retryCount++;
      if (item.retryCount < 3) {
        deferred.push(item);
        console.log(`[SCHEDULE] ${item.jobName} already running, deferred (${item.retryCount}/3)`);
      } else {
        console.log(`[SCHEDULE] ${item.jobName} dropped after max retries`);
        broadcastLog(`[SCHEDULE] ${item.jobName} dropped (max retries)`, 'ERROR');
      }
    } else {
      toRun.push(item);
    }
  }
  
  // 큐를 보류된 항목으로 교체
  state.scheduleQueue.length = 0;
  state.scheduleQueue.push(...deferred);
  
  if (toRun.length === 0) {
    // 보류된 항목만 있으면 10초 후 재시도
    if (deferred.length > 0) {
      setTimeout(() => processScheduleQueue(), 10000);
    }
    return;
  }
  
  console.log(`[SCHEDULE] Launching ${toRun.length} job(s) in parallel: ${toRun.map(i => i.jobName).join(', ')}`);
  
  // 모든 job을 동시에 실행 (await 하지 않음 — fire & forget)
  for (const item of toRun) {
    broadcastLog(`[SCHEDULE] Starting ${item.jobName}`, 'SYSTEM');
    runJob(item.jobName, true).then(result => {
      if (!result.started && result.reason === 'already_running') {
        console.log(`[SCHEDULE] ${item.jobName} was already running at launch`);
      } else {
        console.log(`[SCHEDULE] ${item.jobName} launched: ${JSON.stringify(result)}`);
      }
    }).catch(err => {
      console.error(`[SCHEDULE] Error launching ${item.jobName}:`, err);
      broadcastLog(`[SCHEDULE] Error: ${item.jobName} - ${err.message}`, 'ERROR');
    });
  }
  
  // 보류된 항목이 있으면 10초 후 재처리
  if (deferred.length > 0) {
    setTimeout(() => processScheduleQueue(), 10000);
  }
}

// Job 완료 시 보류된 스케줄 큐 재처리 콜백
state._processScheduleQueue = () => processScheduleQueue();

// SSE Heartbeat 통합 (20초마다, 1개로 통합)
setInterval(() => {
  const timestamp = Date.now();
  const heartbeatData = `event: heartbeat\ndata: ${JSON.stringify({ 
    timestamp, 
    clients: stateClients.size + logClients.size + unifiedClients.size 
  })}\n\n`;
  
  // 모든 SSE 클라이언트에게 heartbeat + dead connection 정리
  const allSets = [stateClients, logClients, unifiedClients];
  let cleaned = 0;
  
  for (const clientSet of allSets) {
    const dead = new Set();
    for (const c of clientSet) {
      try {
        if (!c.destroyed && !c.finished) {
          c.write(heartbeatData);
        } else {
          dead.add(c);
        }
      } catch (error) {
        dead.add(c);
      }
    }
    for (const c of dead) { clientSet.delete(c); cleaned++; }
  }
  
  if (cleaned > 0) {
    console.log(`[SSE] Cleaned up ${cleaned} dead connections`);
  }
}, 20000);


// === 라우트 모듈 마운트 ===
app.locals.addToScheduleQueue = addToScheduleQueue;
app.use('/api', jobsRouter);
app.use('/api', historyRouter);
app.use('/api', streamRouter);
app.use('/api', scheduleRouter);
app.use('/api', alertRouter);
app.use('/api', statisticsRouter);
app.use('/api', debugRouter);

loadSchedules(addToScheduleQueue);

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

// 히스토리 인메모리 캐시 초기화 (512MB 파일을 최초 1회만 로드)
initHistoryCache();

// 서버 시작 시 정기 리포트 스케줄러 초기화
setupDailyReportScheduler();

// 로그 관리 스케줄러 초기화 (일별 스플릿 + 7일 이후 압축)
initLogManagement();

// 주간 자동 백업 (매주 일요일 새벽 2시)
cron.schedule('0 2 * * 0', async () => {
  console.log('[BACKUP] 주간 자동 백업 시작...');
  try {
    const { execSync } = await import('child_process');
    execSync('node scripts/auto-backup.js', { 
      cwd: root, 
      stdio: 'inherit',
      timeout: 1800000  // 30분
    });
    console.log('[BACKUP] 주간 자동 백업 완료');
  } catch (err) {
    console.error('[BACKUP] 자동 백업 실패:', err.message);
  }
}, { timezone: 'Asia/Seoul' });

// 일간 history 백업 (매일 새벽 3시)
cron.schedule('0 3 * * *', async () => {
  const { promises: fsp } = await import('fs');
  const srcPath = path.join(root, 'logs', 'history.json');
  const dailyDir = path.join(root, 'logs', 'history_daily');
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const destPath = path.join(dailyDir, `history_${dateStr}.json`);

  try {
    await fsp.access(srcPath);
  } catch {
    console.log('[HIST_BACKUP] history.json 없음, 백업 skip');
    return;
  }

  try {
    await fsp.mkdir(dailyDir, { recursive: true });
    await fsp.copyFile(srcPath, destPath);

    // 복사본 JSON 유효성 검증
    try {
      const content = await fsp.readFile(destPath, 'utf8');
      JSON.parse(content);
    } catch (parseErr) {
      await fsp.unlink(destPath).catch(() => {});
      console.warn(`[HIST_BACKUP] 복사본 JSON 유효성 실패, 삭제: ${parseErr.message}`);
      return;
    }

    console.log(`[HIST_BACKUP] 일간 백업 완료: ${destPath}`);
  } catch (err) {
    console.error('[HIST_BACKUP] 일간 백업 실패:', err.message);
  }
}, { timezone: 'Asia/Seoul' });

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

