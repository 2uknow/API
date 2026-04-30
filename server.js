// server.js — Express 앱 초기화, 미들웨어, 스케줄 큐, 라우트 마운트, SSE 하트비트
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// === 리팩토링 모듈 import ===
import { root, reportsDir, logsDir, readCfg } from './src/utils/config.js';
import { stateClients, logClients, unifiedClients, broadcastLog, broadcastState, recentLogHistory } from './src/utils/sse.js';
import { state, stateEvents } from './src/state/running-jobs.js';
import { initLogManagement } from './src/services/log-manager.js';
import { initHistoryCache } from './src/services/history-service.js';
import { injectNewmanReportMobileStyles } from './src/services/newman-report-mobile.js';
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
  // /reports/ 와 /logs/ 는 한 번 생성되면 immutable 한 정적 자원이라
  // Cloudflare edge 캐싱이 가능하도록 전역 no-cache 를 덮지 않는다.
  // (express.static 의 setHeaders 에서 별도로 public 캐시 헤더를 부여)
  const isCacheableStatic = req.path.startsWith('/reports/') || req.path.startsWith('/logs/');

  if (!isCacheableStatic) {
    // 강력한 캐시 비활성화
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Last-Modified', new Date().toUTCString());
  }
  
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

// 정적 파일 서빙
// /reports/*.html 요청 시 모바일 친화 CSS를 lazy inject (멱등성 보장)
// 옛 리포트도 모바일에서 잘 보이도록. 첫 요청 시 1회 inject 후 정적 서빙으로 위임.
//
// 처리 완료 경로를 인메모리 Set 에 기록 → 같은 파일 재요청 시 readFile 자체를 skip.
// 14k 파일 풀 등록되어도 절대경로 문자열만 들어가므로 ~2MB 수준이라 무시 가능.
const injectedReportsCache = new Set();
app.use('/reports', async (req, res, next) => {
  try {
    const decoded = decodeURIComponent(req.path);
    if (!decoded.toLowerCase().endsWith('.html')) return next();
    const filePath = path.join(reportsDir, decoded.replace(/^\/+/, ''));
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(reportsDir))) return next();
    // 이미 처리한 파일이면 readFile/writeFile 비용 없이 즉시 통과
    if (injectedReportsCache.has(resolved)) return next();
    if (fs.existsSync(resolved)) {
      // 멱등성: 이미 marker 있으면 inject 함수가 즉시 skip
      await injectNewmanReportMobileStyles(resolved);
      injectedReportsCache.add(resolved);
    }
  } catch (e) {
    console.warn('[reports lazy-inject] skip:', e.message);
  }
  next();
});
// 리포트는 한 번 생성되면 immutable — Cloudflare edge 캐시가 5분/1시간 보유
// (timestamp 가 파일명에 들어가므로 같은 URL 이 다른 내용을 가리킬 일 없음)
app.use('/reports', express.static(reportsDir, {
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  }
}));
// /logs/ 는 stdout 이 진행 중에 append 될 수 있어 보수적으로 짧은 캐시 + revalidate
app.use('/logs', express.static(logsDir, {
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=30, must-revalidate');
  }
}));

// 로그 뷰어 — stdout/stderr .log 파일을 HTML wrapper 로 감싸 뒤로가기 버튼 제공.
// 직접 /logs/xxx.log 를 새 탭으로 열면 닫기 외엔 대시보드로 돌아갈 방법이 없어
// history 테이블 stdout 링크는 이쪽으로 우회시킨다.
app.get('/log-viewer', (req, res) => {
  const fileName = String(req.query.file || '').replace(/^\/+/, '');
  const autoScroll = req.query.autoScroll === '1';
  if (!fileName) return res.status(400).send('file query required');

  const resolved = path.resolve(logsDir, fileName);
  if (!resolved.startsWith(path.resolve(logsDir))) return res.status(403).send('forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('log not found');

  let body;
  try {
    body = fs.readFileSync(resolved, 'utf-8');
  } catch (e) {
    return res.status(500).send('read failed: ' + e.message);
  }

  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<title>Log: ${fileName}</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0f172a; color: #e2e8f0; }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px;
    background: rgba(15, 23, 42, 0.95);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid #334155;
  }
  .back-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    background: #4f46e5; color: white; border: none; border-radius: 6px;
    font-size: 0.9rem; font-weight: 500; cursor: pointer; text-decoration: none;
  }
  .back-btn:hover { background: #4338ca; }
  .file-name { font-size: 0.85rem; color: #94a3b8; word-break: break-all; }
  pre {
    margin: 0; padding: 14px;
    white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere;
    font-size: 0.82rem; line-height: 1.5;
  }
  @media (max-width: 767px) {
    .toolbar { padding: 8px 10px; }
    .back-btn { padding: 6px 10px; font-size: 0.85rem; }
    .file-name { font-size: 0.75rem; }
    pre { padding: 10px; font-size: 0.75rem; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <a href="#" class="back-btn" onclick="if(history.length>1){history.back();return false;}return true;" data-fallback="/">← 뒤로</a>
    <span class="file-name">${fileName}</span>
  </div>
  <pre>${escaped}</pre>
${autoScroll ? '<script>window.scrollTo(0, document.body.scrollHeight);</script>' : ''}
<script>
  // history 가 없으면 대시보드로
  document.querySelector('.back-btn').addEventListener('click', function(e){
    if (history.length <= 1) { window.location.href = '/'; e.preventDefault(); }
  });
</script>
</body>
</html>`);
});
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

