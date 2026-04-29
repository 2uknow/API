// server.js — Express 앱 초기화, 미들웨어, 스케줄 큐, 라우트 마운트, SSE 하트비트
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';

// === 리팩토링 모듈 import ===
import { root, reportsDir, logsDir, readCfg } from './src/utils/config.js';
import { stateClients, logClients, unifiedClients, broadcastLog, broadcastState, recentLogHistory } from './src/utils/sse.js';
import { state, stateEvents } from './src/state/running-jobs.js';
import { initLogManagement } from './src/services/log-manager.js';
import { initHistoryCache } from './src/services/history-service.js';
import { loadSchedules } from './src/services/schedule-service.js';
import { setupDailyReportScheduler } from './src/services/statistics-service.js';
import { initDiskMonitor } from './src/services/disk-monitor.js';
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
  
  // 브라우저 호환성 + 보안 헤더 (외부 노출 환경 대비)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

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
    const safeHeaders = { ...req.headers };
    if (safeHeaders.authorization) safeHeaders.authorization = '***';
    if (safeHeaders.cookie) safeHeaders.cookie = '***';
    console.log(`[REQUEST] Headers:`, JSON.stringify(safeHeaders, null, 2));
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
  
  // 스케줄 실행은 동시 실행 허용 — 같은 이름이 실행 중이어도 바로 런치
  // (runId 기반 상태 관리로 여러 run이 독립적으로 추적됨)
  const toRun = [...state.scheduleQueue];
  state.scheduleQueue.length = 0;

  if (toRun.length === 0) return;
  
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
  
}

// state 이벤트 구독 — SSE 브리지 + 스케줄 큐 재처리 + 로그 버퍼 정리
// running-jobs.js는 emit만 담당, 실제 SSE/스케줄/로그 효과는 여기서 수행
stateEvents.on('running-jobs-changed', (payload) => {
  broadcastState(payload);
});

stateEvents.on('log', ({ line, jobName }) => {
  broadcastLog(line, jobName);
});

stateEvents.on('job-finalized', () => {
  if (state.scheduleQueue.length > 0) {
    setTimeout(() => processScheduleQueue(), 2000);
  }
});

stateEvents.on('all-jobs-done', () => {
  recentLogHistory.length = 0;
  console.log('[FINALIZE] All jobs done - log history cleared');
});

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
    console.log(`[MONITOR] Running Jobs: ${state.runningJobs.size}`);
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

// 디스크 사용량 모니터링 초기화 (임계값 초과 시 네이버 웍스 알람)
initDiskMonitor();

// ── 백업 cron: 자식 프로세스를 detached/unref로 분리해 PM2 라이프사이클과 독립 ──
//   - cron callback은 즉시 리턴 → 서버 메인 흐름 안 막음
//   - 자식 stdout/stderr는 별도 로그 파일로 → PM2 로그 truncate에 영향 없음
//   - PM2 cron_restart(04:00)에 자식 프로세스가 같이 죽지 않음
function spawnDetachedBackup(label, scriptRelPath, logFileName) {
  return async () => {
    const { spawn } = await import('child_process');
    const fs = await import('fs');
    const logPath = path.join(root, 'logs', logFileName);
    const startedAt = new Date().toISOString();

    try {
      const out = fs.openSync(logPath, 'a');
      const err = fs.openSync(logPath, 'a');

      // 트리거 흔적을 무조건 별도 로그에 먼저 남김
      fs.writeSync(out, `\n===== [${startedAt}] ${label} cron triggered =====\n`);

      const child = spawn(process.execPath, [scriptRelPath], {
        cwd: root,
        detached: true,
        stdio: ['ignore', out, err],
        windowsHide: true,
      });
      child.unref();
      fs.closeSync(out);
      fs.closeSync(err);

      console.log(`[${label}] cron triggered → PID ${child.pid} 분리 실행 (log: ${logPath})`);
    } catch (e) {
      console.error(`[${label}] spawn 실패:`, e.message);
      try { fs.appendFileSync(logPath, `[${startedAt}] spawn 실패: ${e.message}\n`); } catch (_) {}
    }
  };
}

// 주간 자동 백업 (매주 일요일 새벽 2시)
cron.schedule(
  '0 2 * * 0',
  spawnDetachedBackup('BACKUP', 'scripts/auto-backup.js', 'auto-backup.log'),
  { timezone: 'Asia/Seoul' }
);

// 일간 history 백업 (매일 새벽 3시)
cron.schedule(
  '0 3 * * *',
  spawnDetachedBackup('HIST_BACKUP', 'scripts/history-backup.js', 'history-backup.log'),
  { timezone: 'Asia/Seoul' }
);

// 등록 시점 흔적 — 서버 재시작 시 cron이 실제로 등록됐는지 확인용
console.log('[CRON] 백업 스케줄 등록: 주간(일 02:00) + 일간(매일 03:00) [Asia/Seoul]');

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

