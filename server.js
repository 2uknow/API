// server.js (알람 시스템 개선 + 성능 최적화 버전)
import express from 'express';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import cron from 'node-cron';
import { 
  sendTextMessage, 
  sendFlexMessage, 
  buildBasicRunStatusFlex,
  buildBasicStatusText,
  buildRunStatusFlex
} from './alert.js';
import iconv from 'iconv-lite';
import { SClientScenarioEngine, SClientReportGenerator } from './sclient-engine.js';
import { validateTestsWithYamlData } from './sclient-test-validator.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const root       = __dirname;

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


const cfgPath = path.join(root, 'config', 'settings.json');
function readCfg() {
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); }
  catch { return { 
    site_port: 3000, 
    history_keep: 500, 
    report_keep_days: 30, 
    timezone: 'Asia/Seoul', 
    run_mode:'cli', 
    run_event_alert: true,  // 기본값을 true로 변경
    alert_on_start: true,   // 실행 시작 알람
    alert_on_success: true, // 성공 알람
    alert_on_error: true,   // 실패 알람
    alert_method: 'flex'    // 'text' 또는 'flex'
    }; 
  }
}

function nowInTZString(d = new Date()){
  const { timezone = 'Asia/Seoul' } = readCfg();
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  }).formatToParts(d);
  const get = t => (parts.find(p=>p.type===t)?.value||'').padStart(2,'0');
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function kstTimestamp(d = new Date()) {
  const { timezone = 'Asia/Seoul' } = readCfg();
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  }).formatToParts(d);
  const get = t => (parts.find(p=>p.type===t)?.value||'').padStart(2,'0');
  return `${get('year')}-${get('month')}-${get('day')}_${get('hour')}_${get('minute')}_${get('second')}`;
}

// dirs
const reportsDir = path.join(root, 'reports');
const logsDir    = path.join(root, 'logs');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
if (!fs.existsSync(logsDir))    fs.mkdirSync(logsDir,    { recursive: true });

// SSE + history (최적화된 버전)
const state = { 
  runningJobs: new Map(), // jobName -> { startTime, process } 형태로 관리
  batchMode: false, // 배치 모드 플래그 - true일 때는 중복 실행 체크 우회
  scheduleQueue: [], // 스케줄 대기 큐: [{jobName, timestamp, retryCount}]
  processingQueue: false // 큐 처리 중 플래그
};const stateClients = new Set(); 
const logClients = new Set();

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

// 통합 Job 완료 처리 함수
function finalizeJobCompletion(jobName, exitCode, success = null) {
  return new Promise((resolve) => {
    console.log(`[FINALIZE] Starting job completion for ${jobName}, exitCode: ${exitCode}, success: ${success}`);
    
    // 1. 확실한 완료 신호 전송 (다중 신호로 확실성 보장)
    broadcastLog(`[DONE] exit=${exitCode}`, 'SYSTEM');
    broadcastLog(`[EXECUTION_COMPLETE] ${jobName}`, 'SYSTEM');
    broadcastLog(`[JOB_FINISHED] ${jobName} with code ${exitCode}`, 'SYSTEM');
    
    // 2. 상태 초기화 (즉시 + 지연 처리로 이중 보장)
    console.log(`[FINALIZE] Before state reset - current state:`, state.running);
    
    // 즉시 초기화
    state.running = null;
    broadcastState({ running: null });
    
    console.log(`[FINALIZE] Job completion finalized for ${jobName}, final state:`, state.running);
    
    // 3. 히스토리 업데이트 신호 및 완료 (대기 시간 단축)
    setTimeout(() => {
      broadcastLog(`[HISTORY_UPDATE] ${jobName} completed`, 'SYSTEM');
      
      // 최종 확인 후 resolve (대기 시간 단축)
      setTimeout(() => {
        if (state.running && state.running.job === jobName) {
          console.log(`[FINALIZE] Final backup state reset for ${jobName}`);
          state.running = null;
          broadcastState({ running: null });
        }
        console.log(`[FINALIZE] Completion process finished for ${jobName}`);
        
        // 작업 완료 후 스케줄 큐 처리
        setTimeout(() => processScheduleQueue(), 2000);
        
        resolve();
      }, 50);
    }, 100);
  });
}

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

// 로그 버퍼링을 위한 변수들
let logBuffer = [];
let broadcastTimeoutId = null;
const BATCH_SIZE = 10; // 한 번에 보낼 로그 수
const BATCH_INTERVAL = 50; // 배치 전송 간격 (ms)

// SSE 헤더 최적화
function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Last-Event-ID',
    'X-Accel-Buffering': 'no', // nginx용
    'Content-Encoding': 'identity' // 압축 비활성화
  });
  
  // 즉시 연결 확인을 위한 초기 데이터
  res.write('retry: 5000\n');
  res.write('event: connected\n');
  res.write('data: {"status":"connected","timestamp":' + Date.now() + '}\n\n');
  res.flushHeaders?.(); // 즉시 전송
}

// 개선된 상태 브로드캐스트
function broadcastState(payload) {
  const data = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
  
  const deadStateClients = new Set();
  for (const c of stateClients) {
    try {
      if (!c.destroyed && !c.finished) {
        c.write(data);
        c.flushHeaders?.();
      } else {
        deadStateClients.add(c);
      }
    } catch (error) {
      console.log(`[SSE] State client error: ${error.message}`);
      deadStateClients.add(c);
    }
  }
  
  // 통합 클라이언트들에게도 상태 전송
  const deadUnifiedClients = new Set();
  for (const c of unifiedClients) {
    try {
      if (!c.destroyed && !c.finished) {
        c.write(data);
        c.flushHeaders?.();
      } else {
        deadUnifiedClients.add(c);
      }
    } catch (error) {
      console.log(`[SSE] Unified state client error: ${error.message}`);
      deadUnifiedClients.add(c);
    }
  }
  
  // 끊어진 연결 정리
  for (const c of deadStateClients) {
    stateClients.delete(c);
  }
  for (const c of deadUnifiedClients) {
    unifiedClients.delete(c);
  }
}

// 개선된 로그 브로드캐스트 (unified 클라이언트 지원 포함)
function broadcastLog(line, jobName = '') {
  console.log('[BROADCAST DEBUG] Adding to buffer:', line.substring(0, 50), 'jobName:', jobName, 'unifiedClients:', unifiedClients.size);
  const logData = {
    line: line,
    jobName: jobName,
    timestamp: Date.now(),
    type: line.includes('[HISTORY_UPDATE]') ? 'history_update' : 
          line.includes('[DONE]') ? 'execution_done' :
          line.includes('[EXECUTION_COMPLETE]') ? 'execution_complete' : 'log'
  };
  
  const data = `event: log\ndata: ${JSON.stringify(logData)}\n\n`;
  
  // logClients에 전송
  const deadLogClients = new Set();
  let logSuccessCount = 0;
  
  for (const client of logClients) {
    try {
      if (!client.destroyed && !client.finished && client.writable) {
        client.write(data);
        logSuccessCount++;
      } else {
        deadLogClients.add(client);
      }
    } catch (error) {
      deadLogClients.add(client);
    }
  }
  
  // unifiedClients에도 전송
  const deadUnifiedClients = new Set();
  let unifiedSuccessCount = 0;
  
  for (const client of unifiedClients) {
    try {
      if (!client.destroyed && !client.finished && client.writable) {
        console.log('[BROADCAST DEBUG] Sending to unified client');
        client.write(data);
        unifiedSuccessCount++;
      } else {
        deadUnifiedClients.add(client);
      }
    } catch (error) {
      console.log('[BROADCAST DEBUG] Unified client error:', error.message);
      deadUnifiedClients.add(client);
    }
  }
  
  console.log('[BROADCAST DEBUG] Sent to logClients:', logSuccessCount, 'unifiedClients:', unifiedSuccessCount);
  
  // 끊어진 연결 정리
  for (const client of deadLogClients) {
    logClients.delete(client);
  }
  for (const client of deadUnifiedClients) {
    unifiedClients.delete(client);
  }
  
  // 중요 시그널 디버그 로그
  if (line.includes('[HISTORY_UPDATE]') || line.includes('[EXECUTION_COMPLETE]') || line.includes('[BINARY DONE]')) {
    const totalClients = logSuccessCount + unifiedSuccessCount;
    console.log(`[BROADCAST_LOG] ${logData.type} signal sent to ${totalClients} clients: ${line.substring(0, 100)}`);
  }
}

function parseNewmanResult(jsonReportPath) {
  try {
    if (!fs.existsSync(jsonReportPath)) {
      return { summary: 'JSON 리포트 없음', stats: null };
    }
    
    const jsonData = JSON.parse(fs.readFileSync(jsonReportPath, 'utf-8'));
    const run = jsonData.run;
    
    if (!run || !run.stats) {
      return { summary: 'JSON 리포트 파싱 실패', stats: null };
    }
    
    const stats = run.stats;
    const iterations = stats.iterations || {};
    const requests = stats.requests || {};
    const assertions = stats.assertions || {};
    const testScripts = stats.testScripts || {};
    
    // 상세 통계
    const totalIterations = iterations.total || 0;
    const totalRequests = requests.total || 0;
    const failedRequests = requests.failed || 0;
    const totalAssertions = assertions.total || 0;
    const failedAssertions = assertions.failed || 0;
    const totalTests = testScripts.total || 0;
    const failedTests = testScripts.failed || 0;
    
    // 개선된 요약 생성
    const successRequests = totalRequests - failedRequests;
    const successAssertions = totalAssertions - failedAssertions;
    const successTests = totalTests - failedTests;
    
    let summary = '';
    let isAllSuccess = failedRequests === 0 && failedAssertions === 0 && failedTests === 0;
    
    if (isAllSuccess) {
      summary = `✅ 모든 테스트 통과 (요청 ${totalRequests}건, 검증 ${totalAssertions}건, 테스트 ${totalTests}건)`;
    } else {
      const failures = [];
      if (failedRequests > 0) failures.push(`요청 ${failedRequests}건 실패`);
      if (failedAssertions > 0) failures.push(`검증 ${failedAssertions}건 실패`);
      if (failedTests > 0) failures.push(`테스트 ${failedTests}건 실패`);
      
      summary = `❌ ${failures.join(', ')} (총 요청 ${totalRequests}건, 검증 ${totalAssertions}건, 테스트 ${totalTests}건)`;
    }
    
    return {
      summary,
      stats: {
        iterations: { total: totalIterations, failed: 0 },
        requests: { total: totalRequests, failed: failedRequests },
        assertions: { total: totalAssertions, failed: failedAssertions },
        testScripts: { total: totalTests, failed: failedTests }
      }
    };
  } catch (error) {
    console.error('Newman 결과 파싱 오류:', error);
    return { summary: 'JSON 리포트 파싱 오류', stats: null };
  }
}


// 향상된 로그 버퍼 플러시
function flushLogBuffer() {
  if (logBuffer.length === 0) return;
  
  const batch = logBuffer.splice(0, BATCH_SIZE);
  const data = batch.map(line => 
    `event: log\ndata: ${JSON.stringify({ line, at: Date.now() })}\n\n`
  ).join('');
  
  const deadLogClients = new Set();
  for (const c of logClients) {
    try {
      if (!c.destroyed && !c.finished) {
        c.write(data);
        c.flushHeaders?.();
      } else {
        deadLogClients.add(c);
      }
    } catch (error) {
      console.log(`[SSE] Log client error: ${error.message}`);
      deadLogClients.add(c);
    }
  }
  
  // 통합 클라이언트들에게도 로그 전송
  console.log('[FLUSH DEBUG] Sending to unified clients:', unifiedClients.size, 'batch size:', batch.length);
  const deadUnifiedClients = new Set();
  for (const c of unifiedClients) {
    try {
      if (!c.destroyed && !c.finished) {
        console.log('[FLUSH DEBUG] Sending data to unified client');
        c.write(data);
        c.flushHeaders?.();
      } else {
        deadUnifiedClients.add(c);
      }
    } catch (error) {
      console.log(`[SSE] Unified client error: ${error.message}`);
      deadUnifiedClients.add(c);
    }
  }
  
  // 끊어진 연결 정리
  for (const c of deadLogClients) {
    logClients.delete(c);
  }
  for (const c of deadUnifiedClients) {
    unifiedClients.delete(c);
  }
  
  // 다음 배치 스케줄링
  if (logBuffer.length > 0) {
    broadcastTimeoutId = setTimeout(flushLogBuffer, 20);
  } else {
    broadcastTimeoutId = null;
  }
}

function histRead(){ 
  const p=path.join(root,'logs','history.json'); 
  return fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf-8')):[]; 
}

function histWrite(arr){ 
  const p=path.join(root,'logs','history.json'); 
  fs.writeFileSync(p, JSON.stringify(arr,null,2)); 
}

function cleanupOldReports(){ 
  const { report_keep_days=30 }=readCfg(); 
  const maxAge=report_keep_days*24*3600*1000; 
  const now=Date.now(); 
  for (const f of fs.readdirSync(reportsDir)){ 
    const p=path.join(reportsDir,f); 
    const st=fs.statSync(p); 
    if (now-st.mtimeMs>maxAge){ 
      try{ fs.unlinkSync(p);}catch{} 
    } 
  } 
}

async function sendAlert(type, data) {
  const config = readCfg();
  
  // 알람이 비활성화되어 있으면 리턴
  if (!config.run_event_alert) {
    console.log(`[ALERT] Alert disabled: ${type}`);
    return;
  }

  // 각 타입별 알람 설정 확인
  if (type === 'start' && !config.alert_on_start) return;
  if (type === 'success' && !config.alert_on_success) return;
  if (type === 'error' && !config.alert_on_error) return;

  try {
    let result;
    
    if (config.alert_method === 'flex') {
      // Flex 메시지 전송
      const flexData = buildRunStatusFlex(type, data);
      result = await sendFlexMessage(flexData);
    } else {
      // 텍스트 메시지 전송 - 이모티콘 완전 제거
      let message;
      if (type === 'start') {
        message = `API Test Execution Started\nJob: ${data.jobName}\nCollection: ${data.collection}`;
        if (data.environment) {
          message += `\nEnvironment: ${data.environment}`;
        }
        message += `\nTime: ${data.startTime}`;
      } else if (type === 'success') {
        message = `API Test Execution Success\nJob: ${data.jobName}\nCollection: ${data.collection}`;
        if (data.environment) {
          message += `\nEnvironment: ${data.environment}`;
        }
        message += `\nDuration: ${data.duration}s\nEnd Time: ${data.endTime}`;
      } else if (type === 'error') {
        message = `API Test Execution Failed\nJob: ${data.jobName}\nCollection: ${data.collection}`;
        if (data.environment) {
          message += `\nEnvironment: ${data.environment}`;
        }
        message += `\nExit Code: ${data.exitCode}\nDuration: ${data.duration}s\nEnd Time: ${data.endTime}`;
        
        if (data.errorSummary) {
          message += `\nError: ${data.errorSummary}`;
        }
        
        // 상세 실패 리포트 추가
        if (data.failureReport) {
          message += `\n\n=== Failure Summary Report ===\n${data.failureReport}`;
        }
      }
      result = await sendTextMessage(message);
    }

    console.log(`[ALERT] ${type} alert result:`, result);
    
    if (!result.ok) {
      console.error(`[ALERT ERROR] ${type} alert failed:`, result);
    }

  } catch (error) {
    console.error(`[ALERT ERROR] ${type} alert error:`, error);
  }
}

// Newman JSON 리포트 파싱 함수 추가
function parseNewmanJsonReport(jsonReportPath) {
  try {
    if (!fs.existsSync(jsonReportPath)) {
      console.log(`[NEWMAN PARSE] JSON 리포트 파일 없음: ${jsonReportPath}`);
      return null;
    }
    
    const reportData = JSON.parse(fs.readFileSync(jsonReportPath, 'utf-8'));
    const run = reportData.run;
    
    if (!run) {
      console.log('[NEWMAN PARSE] run 데이터 없음');
      return null;
    }
    
    const stats = run.stats || {};
    const timings = run.timings || {};
    const failures = run.failures || [];
    
    // 상세 통계 계산
    const requests = stats.requests || {};
    const assertions = stats.assertions || {};
    const testScripts = stats.testScripts || {};
    
    const result = {
      summary: {
        iterations: stats.iterations || { total: 0, failed: 0 },
        requests: { total: requests.total || 0, failed: requests.failed || 0 },
        testScripts: { total: testScripts.total || 0, failed: testScripts.failed || 0 },
        assertions: { total: assertions.total || 0, failed: assertions.failed || 0 }
      },
      timings: {
        responseAverage: timings.responseAverage || 0,      // 평균 응답시간 (밀리초)
        responseMin: timings.responseMin || 0,              // 최소 응답시간
        responseMax: timings.responseMax || 0,              // 최대 응답시간
        responseTotal: timings.responseTotal || 0,          // 총 응답시간
        started: timings.started || 0,                      // 시작 시간
        completed: timings.completed || 0                   // 완료 시간
      },
      failures: failures.map(failure => ({
        source: failure.source?.name || 'Unknown',
        error: failure.error?.message || 'Unknown error',
        test: failure.error?.test || null,
        at: failure.at || null
      })),
      // 성공률 계산
      successRate: (() => {
        const totalRequests = requests.total || 0;
        const failedRequests = requests.failed || 0;
        const totalAssertions = assertions.total || 0;
        const failedAssertions = assertions.failed || 0;
        const totalTests = testScripts.total || 0;
        const failedTests = testScripts.failed || 0;
        
        const totalItems = totalRequests + totalAssertions + totalTests;
        const failedItems = failedRequests + failedAssertions + failedTests;
        
        if (totalItems === 0) return 100;
        return Math.round(((totalItems - failedItems) / totalItems) * 100);
      })()
    };
    
    console.log(`[NEWMAN PARSE] 성공적으로 파싱됨:`, {
      responseAverage: result.timings.responseAverage,
      successRate: result.successRate,
      totalRequests: result.summary.requests.total,
      failedRequests: result.summary.requests.failed
    });
    
    return result;
  } catch (error) {
    console.error('[NEWMAN PARSE ERROR]', error);
    return null;
  }
}
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
  
  state.running = null;
  broadcastState({ running: null });
  broadcastLog('[SYSTEM] State forcefully reset by user', 'SYSTEM');
  
  res.json({ 
    ok: true, 
    message: 'State reset successfully',
    previousState: previousState
  });
  
  console.log('[API] State reset completed, previous state:', previousState);
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
  
  let history = histRead();
  
  // 필터링 로직은 그대로...
  if (searchQuery || jobFilter || rangeFilter) {
    const now = Date.now();
    
    function inRange(ts) {
      if (!rangeFilter) return true;
      const t = Date.parse(ts.replace(' ', 'T') + '+09:00');
      if (rangeFilter === '24h') return (now - t) <= (24 * 3600 * 1000);
      if (rangeFilter === '7d') return (now - t) <= (7 * 24 * 3600 * 1000);
      return true;
    }
    
    history = history.filter(r => {
      const jobMatch = !jobFilter || r.job === jobFilter;
      const rangeMatch = inRange(r.timestamp);
      const searchMatch = !searchQuery || 
        ((r.job || '') + (r.summary || '')).toLowerCase().includes(searchQuery.toLowerCase());
      
      return jobMatch && rangeMatch && searchMatch;
    });
  }
  
  // 페이징
  const total = history.length;
  const totalPages = Math.ceil(total / size);
  const startIndex = (page - 1) * size;
  const endIndex = startIndex + size;
  const items = history.slice().reverse().slice(startIndex, endIndex);
  
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
const unifiedClients = new Set();

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
        // 현재 상태 전송
        res.write(`event: state\ndata: ${JSON.stringify({ 
          running: state.running,
          timestamp: Date.now()
        })}\n\n`);
        
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
const schedFile=path.join(root,'config','schedules.json'); 
const schedules=new Map();

function loadSchedules(){ 
  if(!fs.existsSync(schedFile))return; 
  try{ 
    const arr=JSON.parse(fs.readFileSync(schedFile,'utf-8')); 
    arr.forEach(({name,cronExpr})=>{ 
      console.log(`[SCHEDULE] Loading: ${name} with cron: ${cronExpr}`);
      
      // 6자리 cron을 5자리로 변환 (초 제거)
      let convertedCron = cronExpr;
      const parts = cronExpr.split(' ');
      if (parts.length === 6) {
        // 6자리인 경우 초를 제거하고 5자리로 변환
        convertedCron = parts.slice(1).join(' ');
        console.log(`[SCHEDULE] Converted ${cronExpr} to ${convertedCron}`);
      }
      
      // node-cron 유효성 검사
      if (!cron.validate(convertedCron)) {
        console.error(`[SCHEDULE ERROR] Invalid cron expression: ${convertedCron}`);
        return;
      }
      
      const task=cron.schedule(convertedCron,()=>{
        console.log(`[SCHEDULE TRIGGER] Triggered job: ${name}`);
        addToScheduleQueue(name);
      },{scheduled:true}); 
      
      schedules.set(name,{cronExpr:convertedCron,task});
      console.log(`[SCHEDULE] Successfully scheduled: ${name}`);
    }); 
  }catch(e){
    console.error('[SCHEDULE ERROR] Failed to load schedules:', e);
  } 
}

function saveSchedules(){ 
  const arr=[...schedules.entries()].map(([name,{cronExpr}])=>({name,cronExpr})); 
  fs.writeFileSync(schedFile, JSON.stringify(arr,null,2)); 
}

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
          processSchedule(name, cronExpr, res);
        }catch(e){ 
          res.status(400).json({message:'invalid body'});
        } 
      });
      return; // early return으로 나머지 코드 실행 방지
    }
    
    processSchedule(name, cronExpr, res);
    
  } catch(e) {
    console.error('[SCHEDULE API ERROR]', e);
    res.status(500).json({message: 'Server error: ' + e.message});
  }
});

// 스케줄 처리 로직을 별도 함수로 분리
function processSchedule(name, cronExpr, res) {
  if(!name||!cronExpr) {
    return res.status(400).json({message:'name/cronExpr 필요'});
  }
  
  console.log(`[SCHEDULE API] Received: ${name} with cron: "${cronExpr}"`);
  console.log(`[SCHEDULE API] Cron length: ${cronExpr.length}`);
  console.log(`[SCHEDULE API] Cron char codes:`, Array.from(cronExpr).map(c => c.charCodeAt(0)));
  
  // 6자리 cron을 5자리로 변환 (초 제거)
  let convertedCron = cronExpr;
  const parts = cronExpr.split(' ');
  if (parts.length === 6) {
    convertedCron = parts.slice(1).join(' ');
    console.log(`[SCHEDULE API] Converted ${cronExpr} to ${convertedCron}`);
  }
  
  // node-cron 유효성 검사
  if (!cron.validate(convertedCron)) {
    console.error(`[SCHEDULE API ERROR] Invalid cron expression: ${convertedCron}`);
    return res.status(400).json({message:`잘못된 cron 표현식: ${convertedCron}`});
  }
  
  // 기존 스케줄 중지
  if(schedules.has(name)) {
    schedules.get(name).task.stop(); 
    console.log(`[SCHEDULE API] Stopped existing schedule: ${name}`);
  }
  
  // 새 스케줄 등록
  const task=cron.schedule(convertedCron,()=>{
    console.log(`[SCHEDULE TRIGGER] Triggered job: ${name}`);
    addToScheduleQueue(name);
  },{scheduled:true}); 
  
  schedules.set(name,{cronExpr:convertedCron,task}); 
  saveSchedules(); 
  
  console.log(`[SCHEDULE API] Successfully scheduled: ${name} with ${convertedCron}`);
  res.json({ok:true, message:`스케줄 등록됨: ${name}`, convertedCron}); 
}

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

loadSchedules();

// spawn
function spawnNewmanCLI(args){
  let cmd, argv;
  if (process.platform === 'win32'){ 
    cmd='cmd.exe'; 
    argv=['/d','/s','/c','npx', ...args]; 
  } else { 
    cmd='/bin/sh'; 
    argv=['-lc', ['npx', ...args].join(' ')]; 
  }
  console.log('[SPAWN]', cmd, argv);
  return spawn(cmd, argv, { cwd: root });
}

// 바이너리 경로 확인 함수
function getBinaryPath(jobConfig) {
  const platform = process.platform;
  
  // 1. 환경변수 우선 사용
  if (process.env.BINARY_PATH) {
    const execName = platform === 'win32' 
      ? jobConfig.executable 
      : jobConfig.executable.replace('.exe', '');
    return path.join(process.env.BINARY_PATH, execName);
  }
  
  // 2. 플랫폼별 설정에서 가져오기
  const config = readCfg();
  const binaryConfig = config.binary_base_path || {};
  
  let basePath;
  if (jobConfig.platforms && jobConfig.platforms[platform]) {
    // Job 파일에 플랫폼별 설정이 있는 경우
    const platformConfig = jobConfig.platforms[platform];
    basePath = platformConfig.path || binaryConfig[platform] || binaryConfig.default || './binaries';
    return path.resolve(root, basePath, platformConfig.executable);
  } else {
    // 기본 설정 사용
    basePath = binaryConfig[platform] || binaryConfig.default || './binaries';
    const execName = platform === 'win32' 
      ? jobConfig.executable 
      : jobConfig.executable.replace('.exe', '');
    return path.resolve(root, basePath, execName);
  }
}

// 바이너리 실행 함수
function spawnBinaryCLI(binaryPath, args = [], options = {}) {
  const platform = process.platform;
  let cmd, argv;
  
  if (platform === 'win32') {
    // Windows: 직접 실행 파일 실행
    if (binaryPath.endsWith('.exe') || binaryPath.endsWith('.bat')) {
      cmd = binaryPath;
      argv = args;
    } else {
      // cmd.exe를 통해 실행
      cmd = 'cmd.exe';
      argv = ['/d', '/s', '/c', binaryPath, ...args];
    }
  } else {
    // Linux/macOS: 직접 실행
    cmd = binaryPath;
    argv = args;
  }
  
  console.log('[BINARY SPAWN]', cmd, argv);
  return spawn(cmd, argv, { 
    cwd: options.cwd || root,
    ...options 
  });
}

// 바이너리 출력 파싱 함수
function parseBinaryOutput(output, parseConfig = {}) {
  const result = {
    success: false,
    summary: '',
    stats: null,
    failures: []
  };
  
  try {
    const lines = output.split('\n').map(line => line.trim()).filter(line => line);
    
    // 성공/실패 패턴 확인
    const successPattern = parseConfig.successPattern || 'SUCCESS|PASSED|OK';
    const failurePattern = parseConfig.failurePattern || 'FAIL|ERROR|EXCEPTION';
    
    const successRegex = new RegExp(successPattern, 'i');
    const failureRegex = new RegExp(failurePattern, 'i');
    
    let hasSuccess = false;
    let hasFailure = false;
    
    for (const line of lines) {
      if (successRegex.test(line)) {
        hasSuccess = true;
        if (!result.summary) result.summary = line;
      }
      if (failureRegex.test(line)) {
        hasFailure = true;
        result.failures.push(line);
        if (!result.summary) result.summary = line;
      }
    }
    
    // 통계 추출 (옵션)
    if (parseConfig.statsPattern) {
      const statsRegex = new RegExp(parseConfig.statsPattern, 'i');
      for (const line of lines) {
        const match = line.match(statsRegex);
        if (match) {
          result.stats = {
            total: parseInt(match[1]) || 0,
            success: parseInt(match[2]) || 0,
            failed: parseInt(match[3]) || 0
          };
          break;
        }
      }
    }
    
    // 최종 성공/실패 판정
    if (hasFailure) {
      result.success = false;
      result.summary = result.summary || 'Execution failed';
    } else if (hasSuccess) {
      result.success = true;
      result.summary = result.summary || 'Execution successful';
    } else {
      // 패턴이 없으면 기본적으로 성공으로 간주
      result.success = true;
      result.summary = 'Execution completed';
    }
    
  } catch (error) {
    console.error('[BINARY PARSE ERROR]', error);
    result.summary = `Parse error: ${error.message}`;
  }
  
  return result;
}
// Newman CLI 출력에서 통계 추출
function parseNewmanCliOutput(stdoutPath) {
  try {
    if (!fs.existsSync(stdoutPath)) {
      return null;
    }
    
    const output = fs.readFileSync(stdoutPath, 'utf-8');
    const lines = output.split('\n');
    
    let stats = {
      requests: { executed: 0, failed: 0 },
      assertions: { executed: 0, failed: 0 },
      iterations: { executed: 0, failed: 0 }
    };
    
    // 테이블에서 통계 추출
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.includes('│') && line.includes('executed') && line.includes('failed')) {
        // 다음 줄부터 통계 데이터
        for (let j = i + 2; j < lines.length; j++) {
          const dataLine = lines[j].trim();
          if (dataLine.includes('└')) break;
          
          if (dataLine.includes('│')) {
            const parts = dataLine.split('│').map(p => p.trim()).filter(p => p);
            if (parts.length >= 3) {
              const [type, executed, failed] = parts;
              const exec = parseInt(executed) || 0;
              const fail = parseInt(failed) || 0;
              
              if (type.includes('requests')) {
                stats.requests = { executed: exec, failed: fail };
              } else if (type.includes('assertions')) {
                stats.assertions = { executed: exec, failed: fail };
              } else if (type.includes('iterations')) {
                stats.iterations = { executed: exec, failed: fail };
              }
            }
          }
        }
        break;
      }
    }
    
    return stats;
  } catch (error) {
    console.error('[NEWMAN CLI PARSE ERROR]', error);
    return null;
  }
}

// Newman 결과 파싱 함수
function parseNewmanOutput(output) {
  const result = {
    iterations: { executed: 0, failed: 0 },
    requests: { executed: 0, failed: 0 },
    assertions: { executed: 0, failed: 0 },
    duration: 0,
    failures: []
  };

  try {
    // 테이블 파싱
    const iterationsMatch = output.match(/│\s*iterations\s*│\s*(\d+)\s*│\s*(\d+)\s*│/);
    if (iterationsMatch) {
      result.iterations.executed = parseInt(iterationsMatch[1]);
      result.iterations.failed = parseInt(iterationsMatch[2]);
    }

    const requestsMatch = output.match(/│\s*requests\s*│\s*(\d+)\s*│\s*(\d+)\s*│/);
    if (requestsMatch) {
      result.requests.executed = parseInt(requestsMatch[1]);
      result.requests.failed = parseInt(requestsMatch[2]);
    }

    const assertionsMatch = output.match(/│\s*assertions\s*│\s*(\d+)\s*│\s*(\d+)\s*│/);
    if (assertionsMatch) {
      result.assertions.executed = parseInt(assertionsMatch[1]);
      result.assertions.failed = parseInt(assertionsMatch[2]);
    }

    // 실행 시간 파싱
    const durationMatch = output.match(/total run duration:\s*([\d.]+)s/);
    if (durationMatch) {
      result.duration = parseFloat(durationMatch[1]);
    }

    // 실패 상세 파싱
    const failureSection = output.match(/# failure detail([\s\S]*?)(?=\n\n|$)/);
    if (failureSection) {
      const failures = failureSection[1].match(/\d+\.\s+.*?(?=\n\d+\.|\n\n|$)/gs);
      if (failures) {
        result.failures = failures.map(failure => {
          const lines = failure.trim().split('\n');
          const title = lines[0].replace(/^\d+\.\s*/, '');
          const details = lines.slice(1).join(' ').trim();
          return { title, details };
        }).slice(0, 5); // 최대 5개까지만
      }
    }
  } catch (error) {
    console.error('[PARSE ERROR]', error);
  }

  return result;
}
// 요약 생성 함수
function generateSummary(newmanResult, exitCode) {
  if (exitCode === 0) {
    // 성공한 경우
    const { requests, assertions } = newmanResult;
    if (requests.executed === 0) {
      return '실행 성공 (요청 없음)';
    }
    
    const requestSummary = requests.failed === 0 
      ? `요청 ${requests.executed}건 모두 성공`
      : `요청 ${requests.executed}건 중 ${requests.executed - requests.failed}건 성공`;
    
    const assertionSummary = assertions.executed > 0
      ? assertions.failed === 0
        ? `검증 ${assertions.executed}건 모두 성공`
        : `검증 ${assertions.executed}건 중 ${assertions.executed - assertions.failed}건 성공`
      : '';

    return assertionSummary ? `${requestSummary}, ${assertionSummary}` : requestSummary;
  } else {
    // 실패한 경우
    const { requests, assertions, failures } = newmanResult;
    
    if (failures.length > 0) {
      const mainFailure = failures[0].title.includes('AssertionError') 
        ? failures[0].title.replace('AssertionError ', '')
        : failures[0].title;
      
      const failureCount = failures.length;
      return failureCount > 1 
        ? `${mainFailure} 외 ${failureCount - 1}건 실패`
        : mainFailure;
    }
    
    if (assertions.failed > 0) {
      return `검증 ${assertions.executed}건 중 ${assertions.failed}건 실패`;
    }
    
    if (requests.failed > 0) {
      return `요청 ${requests.executed}건 중 ${requests.failed}건 실패`;
    }
    
    return `실행 실패 (exit=${exitCode})`;
  }
}
// 개선된 runJob 함수
// 오늘 날짜 통계 API 엔드포인트 추가 - server.js에 추가
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
      // Newman Job만 백업으로 duration 사용 (Binary Job은 전체 실행시간이므로 제외)
      else if (item.type === 'newman' && item.duration && item.duration > 0) {
        validResponseTimes.push(item.duration * 1000); // Newman의 경우만 초를 밀리초로 변환
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
async function runJob(jobName, fromSchedule = false){
  console.log(`[RUNJOB] Starting job execution: ${jobName}, fromSchedule: ${fromSchedule}`);
  
  // 스케줄 실행이 아니고 배치 모드가 아닐 때만 중복 실행 체크
  if (state.running && !state.batchMode && !fromSchedule) {
    console.log(`[RUNJOB] Job rejected - already running: ${state.running.job}`);
    return { started:false, reason:'already_running' };
  }
  
  // 스케줄 실행일 때는 동시 실행 허용
  if (fromSchedule) {
    console.log(`[RUNJOB] Schedule execution - allowing concurrent execution for: ${jobName}`);
  }
  
  // 배치 모드일 때는 중복 실행 허용
  if (state.batchMode) {
    console.log(`[RUNJOB] Batch mode enabled - allowing concurrent execution for: ${jobName}`);
  }

  const jobPath = path.join(root, 'jobs', `${jobName}.json`);
  if (!fs.existsSync(jobPath)) {
    console.log(`[RUNJOB] Job file not found: ${jobPath}`);
    return { started:false, reason:'job_not_found' };
  }
  
  const job = JSON.parse(fs.readFileSync(jobPath,'utf-8'));
  console.log(`[RUNJOB] Job loaded, type: ${job.type}`);
  
  if (!['newman', 'binary', 'sclient_scenario'].includes(job.type)) {
    console.log(`[RUNJOB] Unsupported job type: ${job.type}`);
    return { started:false, reason:'unsupported_type' };
  }

  // 바이너리 타입 처리
  if (job.type === 'binary') {
    console.log(`[RUNJOB] Delegating to runBinaryJob: ${jobName}`);
    return await runBinaryJob(jobName, job);
  }
  
  // SClient 시나리오 타입 처리
  if (job.type === 'sclient_scenario') {
    return await runSClientScenarioJob(jobName, job);
  }

  const collection  = path.resolve(root, job.collection);
  const environment = job.environment ? path.resolve(root, job.environment) : undefined;
  const reporters   = job.reporters?.length ? job.reporters : ['cli','htmlextra','junit','json'];
  const stamp = kstTimestamp();

  const htmlReport = path.join(reportsDir, `${jobName}_${stamp}.html`);
  const junitReport= path.join(reportsDir, `${jobName}_${stamp}.xml`);
  const jsonReport = path.join(reportsDir, `${jobName}_${stamp}.json`);
  const stdoutPath = path.join(logsDir, `stdout_${jobName}_${stamp}.log`);
  const stderrPath = path.join(logsDir, `stderr_${jobName}_${stamp}.log`);
  const cliExport  = path.join(logsDir, `cli_${jobName}_${stamp}.txt`);
  
  const outStream  = fs.createWriteStream(stdoutPath, { flags:'a' });
  const errStream  = fs.createWriteStream(stderrPath, { flags:'a' });

  if (!fs.existsSync(collection)) return { started:false, reason:'collection_not_found' };
  if (environment && !fs.existsSync(environment)) return { started:false, reason:'environment_not_found' };

  const startTime = nowInTZString();
  const startTs = Date.now();

  state.running = { job: jobName, startAt: startTime };
  broadcastState({ running: state.running });
  broadcastLog(`[START] ${jobName}`);

  // 시작 알람 전송
  await sendAlert('start', {
    jobName,
    startTime,
    collection: path.basename(collection),
    environment: environment ? path.basename(environment) : null
  });

  const args = [
    'newman','run', collection,
    '--verbose',
    '-r', reporters.join(','),
    '--reporter-htmlextra-export', htmlReport,
    '--reporter-junit-export',     junitReport,
    '--reporter-json-export',      jsonReport,
    '--reporter-cli-export',       cliExport
  ];
  
  if (environment) args.push('-e', environment);
  if (Array.isArray(job.extra)) args.push(...job.extra);

  return new Promise((resolve)=>{
    const proc = spawnNewmanCLI(args);
    let errorOutput = '';

    proc.stdout.on('data', d => {
      const s = d.toString();
      console.log('[NEWMAN STDOUT]', s.substring(0, 100) + '...');
      outStream.write(s);
      s.split(/\r?\n/).forEach(line => {
        if (line) {
          console.log('[NEWMAN STDOUT LINE]', line.substring(0, 50) + '...');
          broadcastLog(line);
        }
      });
    });
    
    proc.stderr.on('data', d => {
      const s = d.toString();
      console.log('[NEWMAN STDERR]', s.substring(0, 100) + '...');
      errStream.write(s);
      errorOutput += s; // 에러 내용 수집
      s.split(/\r?\n/).forEach(line => {
        if (line) {
          console.log('[NEWMAN STDERR LINE]', line.substring(0, 50) + '...');
          broadcastLog(line);
        }
      });
    });
    


// runJob 함수의 proc.on('close') 부분을 이렇게 개선하세요:

proc.on('close', async (code) => {
  outStream.end(); 
  errStream.end();
  
  const endTime = nowInTZString();
  const duration = Math.round((Date.now() - startTs) / 1000);
  
  broadcastLog(`[DONE] exit=${code}`);

  // Newman JSON 리포트에서 상세 통계 정보 추출
  let summary = `exit=${code}`;
  let newmanStats = null;
  let detailedStats = null;
  let failureDetails = [];
  
  try {
    if (fs.existsSync(jsonReport)) {
      const jsonData = JSON.parse(fs.readFileSync(jsonReport, 'utf-8'));
      const run = jsonData.run;
      
      if (run && run.stats) {
        const stats = run.stats;
        const requests = stats.requests || {};
        const assertions = stats.assertions || {};
        const testScripts = stats.testScripts || {};
        const prerequestScripts = stats.prerequestScripts || {};
        const iterations = stats.iterations || {};
        
        // 기본 Newman 통계
        newmanStats = {
          requests: {
            total: requests.total || 0,
            failed: requests.failed || 0,
            pending: requests.pending || 0
          },
          assertions: {
            total: assertions.total || 0,
            failed: assertions.failed || 0,
            pending: assertions.pending || 0
          },
          testScripts: {
            total: testScripts.total || 0,
            failed: testScripts.failed || 0,
            pending: testScripts.pending || 0
          },
          prerequestScripts: {
            total: prerequestScripts.total || 0,
            failed: prerequestScripts.failed || 0,
            pending: prerequestScripts.pending || 0
          },
          iterations: {
            total: iterations.total || 0,
            failed: iterations.failed || 0,
            pending: iterations.pending || 0
          }
        };
        
        // 상세 통계 계산
        detailedStats = {
          totalExecuted: (requests.total || 0) + (assertions.total || 0) + (testScripts.total || 0),
          totalFailed: (requests.failed || 0) + (assertions.failed || 0) + (testScripts.failed || 0),
          successRate: 0,
          avgResponseTime: run.timings?.responseAverage || 0,
          totalDuration: run.timings?.responseTotal || duration * 1000
        };
        
        if (detailedStats.totalExecuted > 0) {
          detailedStats.successRate = Math.round(((detailedStats.totalExecuted - detailedStats.totalFailed) / detailedStats.totalExecuted) * 100);
        }
        
        // 실패 상세 정보 수집
        if (run.failures && run.failures.length > 0) {
          failureDetails = run.failures.slice(0, 5).map(failure => ({
            test: failure.source?.name || 'Unknown Test',
            error: failure.error?.message || 'Unknown Error',
            assertion: failure.error?.test || null,
            request: failure.source?.request?.name || null
          }));
        }
        
        // Summary 생성: 더 세분화된 정보
        /*
        if (code === 0) {
          // 성공한 경우
          const parts = [];
          
          if (assertions.total > 0) {
            if (assertions.failed === 0) {
              parts.push(`All ${assertions.total} Assertions Passed`);
            } else {
              parts.push(`${assertions.total - assertions.failed}/${assertions.total} Assertions Passed`);
            }
          }
          
          if (requests.total > 0) {
            if (requests.failed === 0) {
              parts.push(`All ${requests.total} Requests Succeeded`);
            } else {
              parts.push(`${requests.total - requests.failed}/${requests.total} Requests Succeeded`);
            }
          }
          
          if (testScripts.total > 0) {
            if (testScripts.failed === 0) {
              parts.push(`All ${testScripts.total} Tests Passed`);
            } else {
              parts.push(`${testScripts.total - testScripts.failed}/${testScripts.total} Tests Passed`);
            }
          }
          
          // 성공률 추가
          if (detailedStats.successRate < 100) {
            parts.push(`Success Rate: ${detailedStats.successRate}%`);
          }
          
          summary = parts.length > 0 ? parts.join(', ') : 'All Tests Completed Successfully';
        } else {
          // 실패한 경우
          const failureParts = [];
          
          if (assertions.failed > 0) {
            failureParts.push(`${assertions.failed}/${assertions.total} Assertions Failed`);
          }
          if (requests.failed > 0) {
            failureParts.push(`${requests.failed}/${requests.total} Requests Failed`);
          }
          if (testScripts.failed > 0) {
            failureParts.push(`${testScripts.failed}/${testScripts.total} Tests Failed`);
          }
          
          if (failureParts.length > 0) {
            summary = failureParts.join(', ');
            // 성공률이 낮으면 추가 정보
            if (detailedStats.successRate < 50) {
              summary += ` (Success Rate: ${detailedStats.successRate}%)`;
            }
          } else {
            // Newman 통계는 있지만 구체적 실패 정보가 없는 경우
            const totalParts = [];
            if (assertions.total > 0) totalParts.push(`${assertions.total} Assertions`);
            if (requests.total > 0) totalParts.push(`${requests.total} Requests`);
            if (testScripts.total > 0) totalParts.push(`${testScripts.total} Tests`);
            
            summary = totalParts.length > 0 ? 
              `Test Failed - ${totalParts.join(', ')} Executed` : 
              `Process Failed (exit=${code})`;
          }
        }
          */
         function generateImprovedSummary(stats, timings, code, failures = []) {
  const requests = stats.requests || {};
  const assertions = stats.assertions || {};
  const testScripts = stats.testScripts || {};
  
  const totalRequests = requests.total || 0;
  const failedRequests = requests.failed || 0;
  const totalAssertions = assertions.total || 0;
  const failedAssertions = assertions.failed || 0;
  const totalTests = testScripts.total || 0;
  const failedTests = testScripts.failed || 0;
  
  const avgResponseTime = timings?.responseAverage || 0;
  
  // 성공한 경우
  if (code === 0) {
    const parts = [];
    
    // 핵심 성공 정보만 간결하게
    if (totalRequests > 0) {
      parts.push(`✅ ${totalRequests} API calls`);
    }
    
    if (totalAssertions > 0) {
      parts.push(`${totalAssertions} validations`);
    }
    
    if (totalTests > 0) {
      parts.push(`${totalTests} tests`);
    }
    
    // 응답시간 추가 (의미있는 값일 때만)
    if (avgResponseTime >= 50) {
      parts.push(`avg ${Math.round(avgResponseTime)}ms`);
    }
    
    return parts.length > 0 ? parts.join(' • ') : '✅ Execution completed';
  }
  
  // 실패한 경우 - 더 상세하고 유용한 정보
  const issues = [];
  const details = [];
  
  if (failedRequests > 0) {
    if (failedRequests === totalRequests) {
      issues.push(`❌ All ${totalRequests} API calls failed`);
    } else {
      issues.push(`❌ ${failedRequests}/${totalRequests} API calls failed`);
      details.push(`${totalRequests - failedRequests} API calls succeeded`);
    }
  }
  
  if (failedAssertions > 0) {
    if (failedAssertions === totalAssertions) {
      issues.push(`⚠️ All ${totalAssertions} validations failed`);
    } else {
      issues.push(`⚠️ ${failedAssertions}/${totalAssertions} validations failed`);
      details.push(`${totalAssertions - failedAssertions} validations passed`);
    }
  }
  
  if (failedTests > 0) {
    if (failedTests === totalTests) {
      issues.push(`🚫 All ${totalTests} tests failed`);
    } else {
      issues.push(`🚫 ${failedTests}/${totalTests} tests failed`);
      details.push(`${totalTests - failedTests} tests passed`);
    }
  }
 
  // 응답시간 정보 (실패해도 유용함)
  if (avgResponseTime >= 100) {
    details.push(`avg ${Math.round(avgResponseTime)}ms`);
  }
  
  // 성공률 계산 및 추가
  const totalItems = totalRequests + totalAssertions + totalTests;
  const failedItems = failedRequests + failedAssertions + failedTests;
  
  if (totalItems > 0) {
    const successRate = Math.round(((totalItems - failedItems) / totalItems) * 100);
    if (successRate > 0) {
      details.push(`${successRate}% success rate`);
    }
  }
  
  // 최종 조합
  if (issues.length === 0) {
    return `❌ Process failed (exit code: ${code})`;
  }
  
  let summary = issues.join(' • ');
  if (details.length > 0) {
    // 가장 중요한 상세 정보 2-3개만 추가
    const importantDetails = details.slice(0, 3);
    summary += ` | ${importantDetails.join(', ')}`;
  }
  
  return summary;
}

// Summary 생성 - 개선된 함수 사용 (failures 정보도 전달)
summary = generateImprovedSummary(stats, run.timings, code, run.failures || []);
      }
    }
  } catch (error) {
    console.error('[NEWMAN STATS PARSE ERROR]', error);
    summary = `Parse Error (exit=${code})`;
  }

  // CLI 출력에서 추가 실패 정보 추출
  let errorSummary = null;
  let failureReport = null;
  let detailedFailures = [];
  
  if (code !== 0) {
  try {
    const output = fs.readFileSync(stdoutPath, 'utf-8');
    
    // # failure detail 섹션 찾기
    const failureDetailMatch = output.match(/# failure detail\s*\n([\s\S]*?)(?=\n# |$)/);
    
    if (failureDetailMatch) {
      const failureSection = failureDetailMatch[1];
      
      // 각 실패 항목 파싱 (1. 2. 3. ... 형태)
      const failureBlocks = failureSection.match(/\d+\.\s+.*?(?=\n\d+\.|\n\n|$)/gs);
      
      if (failureBlocks) {
        detailedFailures = failureBlocks.map((block, index) => {
          const lines = block.trim().split('\n');
          const firstLine = lines[0].replace(/^\d+\.\s*/, ''); // "1. " 부분 제거
          
          // 첫 번째 라인에서 테스트 정보 추출
          let testName = 'Unknown Test';
          let requestName = 'Unknown Request';
          let errorType = 'Error';
          
          // 패턴 매칭으로 정보 추출
          if (firstLine.includes(' | ')) {
            const parts = firstLine.split(' | ');
            if (parts.length >= 2) {
              testName = parts[0].trim();
              requestName = parts[1].trim();
            }
          } else {
            testName = firstLine;
          }
          
          // 에러 타입 확인
          if (firstLine.includes('AssertionError')) {
            errorType = 'Assertion Failed';
          } else if (firstLine.includes('Error')) {
            errorType = 'Request Error';
          }
          
          // 상세 내용 추출 (2번째 줄부터)
          const detailLines = lines.slice(1).filter(line => line.trim().length > 0);
          let errorDetails = '';
          let expectedValue = '';
          let actualValue = '';
          
          detailLines.forEach(line => {
            const trimmedLine = line.trim();
            
            if (trimmedLine.startsWith('expected')) {
              expectedValue = trimmedLine.replace(/^expected\s*/, '');
            } else if (trimmedLine.startsWith('actual')) {
              actualValue = trimmedLine.replace(/^actual\s*/, '');
            } else if (trimmedLine.startsWith('at ')) {
              // Stack trace 정보는 제외
            } else if (trimmedLine.length > 0) {
              if (!errorDetails) {
                errorDetails = trimmedLine;
              }
            }
          });
          
          return {
            index: index + 1,
            testName: testName,
            requestName: requestName,
            errorType: errorType,
            errorDetails: errorDetails,
            expectedValue: expectedValue,
            actualValue: actualValue,
            fullBlock: block.trim()
          };
        });
      }
      
      // 요약용 에러 생성
      if (detailedFailures.length > 0) {
        const firstFailure = detailedFailures[0];
        errorSummary = `${firstFailure.errorType}: ${firstFailure.testName}`;
        
        if (detailedFailures.length > 1) {
          errorSummary += ` (+ ${detailedFailures.length - 1} more failures)`;
        }
        
        // 상세 실패 리포트 생성
        const reportLines = [`=== Detailed Failure Analysis (${detailedFailures.length} failures) ===\n`];
        
        detailedFailures.slice(0, 5).forEach(failure => { // 최대 5개까지
          reportLines.push(`${failure.index}. ${failure.testName}`);
          reportLines.push(`   Request: ${failure.requestName}`);
          reportLines.push(`   Type: ${failure.errorType}`);
          
          if (failure.errorDetails) {
            reportLines.push(`   Error: ${failure.errorDetails}`);
          }
          
          if (failure.expectedValue && failure.actualValue) {
            reportLines.push(`   Expected: ${failure.expectedValue}`);
            reportLines.push(`   Actual: ${failure.actualValue}`);
          }
          
          reportLines.push(''); // 빈 줄로 구분
        });
        
        if (detailedFailures.length > 5) {
          reportLines.push(`... and ${detailedFailures.length - 5} more failures. See full report for details.`);
        }
        
        failureReport = reportLines.join('\n');
      }
    }
    
    // failure detail이 없으면 일반 에러 라인에서 추출
    if (!detailedFailures.length) {
      const errorLines = output.split('\n')
        .filter(line => line.trim() && 
          (line.includes('AssertionError') || 
           line.includes('Error:') || 
           line.includes('failed') ||
           line.includes('✗'))) // Newman의 실패 마크
        .slice(0, 10); // 최대 10개 라인
      
      if (errorLines.length > 0) {
        errorSummary = errorLines[0].trim();
        failureReport = `Error Output:\n${errorLines.join('\n')}`;
      } else {
        errorSummary = `Process exited with code ${code}`;
      }
    }
    
  } catch (error) {
    console.log('[CLI PARSE ERROR]', error);
    errorSummary = `Parse error: ${error.message}`;
  }
}

  // history 저장
  const history = histRead();
  const historyEntry = {
    timestamp: endTime,
    job: jobName,
    type: job.type,
    exitCode: code,
    summary: summary, // 개선된 summary 사용
    report: htmlReport,
    stdout: path.basename(stdoutPath),
    stderr: path.basename(stderrPath),
    tags: [],
    duration: duration,
    // 상세 Newman 통계 추가
    newmanStats: newmanStats,
    detailedStats: detailedStats
  };
  
  history.push(historyEntry);
  
  const { history_keep = 500 } = readCfg();
  if (history.length > history_keep) {
    history.splice(0, history.length - history_keep);
  }
  
  histWrite(history);
  cleanupOldReports();

  // 히스토리 저장 후 추가 상태 확인 및 초기화
  console.log(`[HIST_SAVE] Newman job ${jobName} saved to history, checking state...`);
  if (state.running && state.running.job === jobName) {
    console.log(`[HIST_SAVE] Forcing state reset after history save for ${jobName}`);
    state.running = null;
    broadcastState({ running: null });
  }

  // 알람 데이터 준비 - 훨씬 풍부한 정보 포함
  const alertData = {
  jobName,
  startTime,
  endTime,
  duration,
  exitCode: code,
  collection: path.basename(collection),
  environment: environment ? path.basename(environment) : null,
  
  // 기본 오류 정보
  errorSummary,
  failureReport,
  
  // Newman 상세 통계
  newmanStats: newmanStats,
  detailedStats: detailedStats,
  
  // 상세 실패 정보 (CLI에서 파싱한 것과 JSON에서 파싱한 것 모두)
  failureDetails: failureDetails, // JSON에서 파싱한 것
  detailedFailures: detailedFailures, // CLI에서 파싱한 상세한 것
  
  // 성능 정보
  performanceInfo: {
    avgResponseTime: detailedStats?.avgResponseTime || 0,
    totalDuration: detailedStats?.totalDuration || duration * 1000,
    successRate: detailedStats?.successRate || 0
  },
  
  // 요약 정보
  summaryText: summary,
  
  // 리포트 경로
  reportPath: fs.existsSync(htmlReport) ? htmlReport : null
};

  // 결과에 따른 알람 전송
  if (code === 0) {
    await sendAlert('success', alertData);
  } else {
    await sendAlert('error', alertData);
  }

  // 통합 완료 처리 함수 사용 (완료를 기다림)
  await finalizeJobCompletion(jobName, code);
  
  // Newman HTML 리포트에 다크모드 토글 추가 (원래 Newman HTMLExtra 리포트 유지)
  // if (fs.existsSync(htmlReport)) {
  //   addDarkModeToggleToHtml(htmlReport);
  // }
  
  resolve({ started: true, exitCode: code });
});
  });
}

// 바이너리 Job 실행 함수
async function runBinaryJob(jobName, job) {
  console.log('🔥🔥🔥 [BINARY_ENTRY] runBinaryJob called! 🔥🔥🔥');
  process.stdout.write('🔥🔥🔥 [BINARY_ENTRY] runBinaryJob called! 🔥🔥🔥\n');
  console.log(`[BINARY] Starting binary job: ${jobName}`);
  
  const stamp = kstTimestamp();
  const stdoutPath = path.join(logsDir, `stdout_${jobName}_${stamp}.log`);
  const stderrPath = path.join(logsDir, `stderr_${jobName}_${stamp}.log`);
  const txtReport = path.join(reportsDir, `${jobName}_${stamp}.txt`);
  
  console.log(`[BINARY] Created paths: stdout=${stdoutPath}, stderr=${stderrPath}`);
  
  const outStream = fs.createWriteStream(stdoutPath, { flags:'a' });
  const errStream = fs.createWriteStream(stderrPath, { flags:'a' });

  try {
    // YAML 컬렉션 파일이 있는지 확인
    if (job.collection) {
      const collectionPath = path.resolve(root, job.collection);
      console.log(`[BINARY] Checking collection: ${collectionPath}`);
      console.log(`[BINARY] Path exists: ${fs.existsSync(collectionPath)}`);
      console.log(`[BINARY] Is YAML file: ${collectionPath.toLowerCase().endsWith('.yaml')}`);
      console.log(`[BINARY] Is directory: ${fs.existsSync(collectionPath) && fs.statSync(collectionPath).isDirectory()}`);
      
      if (fs.existsSync(collectionPath) && collectionPath.toLowerCase().endsWith('.yaml')) {
        console.log(`[BINARY] YAML collection found, delegating to runYamlSClientScenario`);
        
        // YAML 컬렉션을 사용한 SClient 시나리오 실행
        const result = await runYamlSClientScenario(jobName, job, collectionPath, {
          stdoutPath,
          stderrPath,
          txtReport,
          outStream,
          errStream,
          stamp
        });
        
        console.log(`[BINARY] YAML scenario completed, result:`, result);
        return result;
      } else if (fs.existsSync(collectionPath) && fs.statSync(collectionPath).isDirectory()) {
        console.log(`[BINARY] YAML directory found, delegating to runYamlDirectoryBatch`);
        
        // YAML 폴더 배치 실행
        const result = await runYamlDirectoryBatch(jobName, job, collectionPath, {
          stdoutPath,
          stderrPath,
          txtReport,
          outStream,
          errStream,
          stamp
        });
        
        console.log(`[BINARY] YAML directory batch completed, result:`, result);
        return result;
      }
    }

    // 기존 바이너리 실행 로직
    // 바이너리 경로 확인
    const binaryPath = getBinaryPath(job);
    console.log('[BINARY JOB] Binary path:', binaryPath);
    
    // 파일 존재 확인 (플랫폼별 처리)
    const platform = process.platform;
    let checkPath = binaryPath;
    
    if (job.platforms && job.platforms[platform]) {
      // 플랫폼별 설정이 있는 경우는 이미 getBinaryPath에서 처리됨
    } else if (platform === 'win32') {
      // Windows에서 cmd.exe 명령어는 확인하지 않음
      if (!binaryPath.includes('cmd.exe') && !fs.existsSync(binaryPath)) {
        return { started: false, reason: 'binary_not_found', path: binaryPath };
      }
    } else {
      // Linux/macOS에서는 시스템 명령어도 확인
      if (!fs.existsSync(binaryPath)) {
        // 시스템 PATH에서 찾기 시도
        try {
          require('child_process').execSync(`which ${path.basename(binaryPath)}`, { stdio: 'ignore' });
        } catch {
          return { started: false, reason: 'binary_not_found', path: binaryPath };
        }
      }
    }

    const startTime = nowInTZString();
    const startTs = Date.now();

    state.running = { job: jobName, startAt: startTime };
    broadcastState({ running: state.running });
    broadcastLog(`[BINARY START] ${jobName}`);

    // 시작 알람 전송
    await sendAlert('start', {
      jobName,
      startTime,
      executable: path.basename(binaryPath),
      type: 'binary'
    });

    // 인수 준비
    let args = [];
    if (job.platforms && job.platforms[platform]) {
      args = job.platforms[platform].arguments || [];
    } else {
      args = job.arguments || [];
    }

    // 환경변수 치환
    args = args.map(arg => {
      if (typeof arg === 'string' && arg.includes('${')) {
        return arg.replace(/\$\{(\w+)\}/g, (match, envVar) => {
          return job.env?.[envVar] || process.env[envVar] || match;
        });
      }
      return arg;
    });

    const config = readCfg();
    const timeout = job.timeout || config.binary_timeout || 30000;

    return new Promise((resolve) => {
      const proc = spawnBinaryCLI(binaryPath, args);
      let stdout = '';
      let stderr = '';
      let errorOutput = '';

      proc.stdout.on('data', d => {
        let s;
        try {
          // Windows에서 Korean 인코딩 처리 (CP949/EUC-KR)
          if (process.platform === 'win32') {
            s = iconv.decode(d, 'cp949');
          } else {
            s = d.toString('utf8');
          }
        } catch (err) {
          // 인코딩 실패시 기본 처리
          s = d.toString();
        }
        stdout += s;
        outStream.write(s);
        s.split(/\r?\n/).forEach(line => {
          if (line) {
            broadcastLog(line, jobName);
          }
        });
      });
      
      proc.stderr.on('data', d => {
        let s;
        try {
          // Windows에서 Korean 인코딩 처리 (CP949/EUC-KR)
          if (process.platform === 'win32') {
            s = iconv.decode(d, 'cp949');
          } else {
            s = d.toString('utf8');
          }
        } catch (err) {
          // 인코딩 실패시 기본 처리
          s = d.toString();
        }
        stderr += s;
        errorOutput += s;
        errStream.write(s);
        s.split(/\r?\n/).forEach(line => {
          if (line) {
            console.log(`[BINARY STDERR] ${jobName}: ${line}`);
            broadcastLog(line, jobName);
          }
        });
      });

      // 타임아웃 처리
      const timeoutHandle = setTimeout(() => {
        if (!proc.killed) {
          console.log(`[BINARY TIMEOUT] Killing process after ${timeout}ms`);
          proc.kill('SIGTERM');
          broadcastLog(`[BINARY TIMEOUT] Process killed after ${timeout}ms`);
        }
      }, timeout);

      proc.on('close', async (code) => {
        clearTimeout(timeoutHandle);
        
        // 빠른 실행 완료 시 강화된 로그 출력
        console.log(`[BINARY CLOSE] ${jobName} exited with code ${code}`);
        
        // stdout 내용이 있으면 실시간 로그로 전송
        if (stdout.trim()) {
          const lines = stdout.trim().split(/\r?\n/);
          lines.forEach(line => {
            if (line.trim()) {
              console.log(`[BINARY FINAL_STDOUT] ${jobName}: ${line}`);
              broadcastLog(line.trim(), jobName);
            }
          });
        }
        
        // stderr 내용이 있으면 실시간 로그로 전송
        if (stderr.trim()) {
          const lines = stderr.trim().split(/\r?\n/);
          lines.forEach(line => {
            if (line.trim()) {
              console.log(`[BINARY FINAL_STDERR] ${jobName}: ${line}`);
              broadcastLog(line.trim(), jobName);
            }
          });
        }
        
        outStream.end();
        errStream.end();

        const endTime = nowInTZString();
        const duration = Math.round((Date.now() - startTs) / 1000);

        broadcastLog(`[BINARY DONE] ${jobName} completed in ${duration}s with exit code ${code}`, 'SYSTEM');

        // 출력 파싱
        const parseConfig = job.parseOutput || {};
        const parsedResult = parseBinaryOutput(stdout, parseConfig);
        
        // 텍스트 리포트 생성
        const reportContent = [
          `Binary Execution Report`,
          `========================`,
          `Job: ${jobName}`,
          `Binary: ${binaryPath}`,
          `Arguments: ${args.join(' ')}`,
          `Start Time: ${startTime}`,
          `End Time: ${endTime}`,
          `Duration: ${duration}s`,
          `Exit Code: ${code}`,
          ``,
          `STDOUT:`,
          `-------`,
          stdout || '(no output)',
          ``,
          `STDERR:`,
          `-------`,
          stderr || '(no errors)',
          ``,
          `Parsed Result:`,
          `-------------`,
          `Success: ${parsedResult.success}`,
          `Summary: ${parsedResult.summary}`,
          parsedResult.stats ? `Stats: ${JSON.stringify(parsedResult.stats, null, 2)}` : '',
          parsedResult.failures.length > 0 ? `Failures: ${parsedResult.failures.join(', ')}` : ''
        ].filter(line => line !== '').join('\n');

        fs.writeFileSync(txtReport, reportContent);

        // Newman 스타일 리포트 생성 (job 설정에서 요청된 경우)
        let htmlReportPath = null;
        if (job.generateHtmlReport) {
          htmlReportPath = path.join(reportsDir, `${jobName}_${stamp}.html`);
          
          try {
            // binary 결과를 Newman 형식으로 변환하여 리포트 생성
            const newmanReportPath = await generateNewmanStyleBinaryReport({
              jobName,
              binaryPath,
              args,
              startTime,
              endTime,
              duration,
              exitCode: code,
              stdout,
              stderr,
              parsedResult,
              reportOptions: job.reportOptions || {},
              outputPath: htmlReportPath
            });
            
            if (newmanReportPath) {
              htmlReportPath = newmanReportPath;
              console.log(`[BINARY] Newman-style HTML report generated: ${htmlReportPath}`);
            } else {
              // 기존 HTML 리포트로 fallback
              const htmlReportContent = generateBinaryHtmlReport({
                jobName,
                binaryPath,
                args,
                startTime,
                endTime,
                duration,
                exitCode: code,
                stdout,
                stderr,
                parsedResult,
                reportOptions: job.reportOptions || {}
              });
              fs.writeFileSync(htmlReportPath, htmlReportContent);
              console.log(`[BINARY] Standard HTML report generated: ${htmlReportPath}`);
            }
          } catch (error) {
            console.warn(`[BINARY NEWMAN REPORT] Failed to generate Newman-style report: ${error.message}`);
            // 기존 HTML 리포트로 fallback
            const htmlReportContent = generateBinaryHtmlReport({
              jobName,
              binaryPath,
              args,
              startTime,
              endTime,
              duration,
              exitCode: code,
              stdout,
              stderr,
              parsedResult,
              reportOptions: job.reportOptions || {}
            });
            fs.writeFileSync(htmlReportPath, htmlReportContent);
            console.log(`[BINARY] Fallback HTML report generated: ${htmlReportPath}`);
          }
        }

        // 히스토리 저장
        const history = histRead();
        const historyEntry = {
          timestamp: endTime,
          job: jobName,
          type: 'binary',
          exitCode: code,
          summary: parsedResult.summary,
          report: txtReport,
          htmlReport: htmlReportPath,
          stdout: path.basename(stdoutPath),
          stderr: path.basename(stderrPath),
          tags: ['binary'],
          duration: duration,
          binaryPath: binaryPath,
          arguments: args,
          parsedResult: parsedResult
        };

        history.push(historyEntry);

        const { history_keep = 500 } = readCfg();
        if (history.length > history_keep) {
          history.splice(0, history.length - history_keep);
        }

        histWrite(history);
        cleanupOldReports();
        
        // 히스토리 저장 후 추가 상태 확인 및 초기화
        console.log(`[HIST_SAVE] Binary job ${jobName} saved to history, checking state...`);
        if (state.running && state.running.job === jobName) {
          console.log(`[HIST_SAVE] Forcing state reset after history save for ${jobName}`);
          state.running = null;
          broadcastState({ running: null });
        }
        
        // 강화된 History 업데이트 신호
        console.log(`[HISTORY_UPDATE] Binary job ${jobName} history updated`);
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
          exitCode: code,
          executable: path.basename(binaryPath),
          arguments: args.join(' '),
          summary: parsedResult.summary,
          success: parsedResult.success,
          type: 'binary',
          reportPath: fs.existsSync(txtReport) ? txtReport : null
        };

        if (!parsedResult.success && parsedResult.failures.length > 0) {
          alertData.errorSummary = parsedResult.failures.slice(0, 3).join('; ');
          alertData.failureReport = `Binary Execution Failures:\n${parsedResult.failures.join('\n')}`;
        }

        // 결과에 따른 알람 전송
        if (code === 0 && parsedResult.success) {
          await sendAlert('success', alertData);
        } else {
          await sendAlert('error', alertData);
        }

        // 통합 완료 처리 함수 사용 (완료를 기다림)
        finalizeJobCompletion(jobName, code, parsedResult.success).then(() => {
          resolve({ started: true, exitCode: code, success: parsedResult.success });
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timeoutHandle);
        console.error('[BINARY ERROR]', error);
        outStream.end();
        errStream.end();

        finalizeJobCompletion(jobName, -1, false).then(() => {
          resolve({ started: false, reason: 'spawn_error', error: error.message });
        });
      });
    });

  } catch (error) {
    console.error('[BINARY JOB ERROR]', error);
    outStream.end();
    errStream.end();
    
    await finalizeJobCompletion(jobName, -1, false);
    
    return { started: false, reason: 'job_error', error: error.message };
  }
}

// YAML 컬렉션을 사용한 SClient 시나리오 실행 함수
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
      const { SClientYAMLParser } = await import('./simple-yaml-parser.js');
      const { SClientScenarioEngine, SClientReportGenerator } = await import('./sclient-engine.js');
      
      console.log(`[YAML] Modules imported successfully`);
      console.log('[YAML SCENARIO] Loading YAML collection:', collectionPath);
      
      // YAML 파일을 JSON 시나리오로 변환 (변수 치환 포함)
      const yamlContent = fs.readFileSync(collectionPath, 'utf-8');
      const scenario = SClientYAMLParser.parseYamlToScenario(yamlContent);
      console.log('[YAML SCENARIO] Parsed scenario:', scenario.info.name);
      
      // SClient 바이너리 경로 확인
      const binaryPath = getBinaryPath(job);
      if (!fs.existsSync(binaryPath)) {
        resolve({ started: false, reason: 'binary_not_found', path: binaryPath });
        return;
      }
      
      const startTime = nowInTZString();
      const startTs = Date.now();
      
      state.running = { job: jobName, startAt: startTime };
      broadcastState({ running: state.running });
      broadcastLog(`[YAML SCENARIO START] ${jobName} - ${scenario.info.name}`);
      
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
            const { SClientToNewmanConverter } = await import('./newman-converter.js');
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
          
          // 히스토리 저장
          const history = histRead();
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
          
          history.push(historyEntry);
          
          const { history_keep = 500 } = readCfg();
          if (history.length > history_keep) {
            history.splice(0, history.length - history_keep);
          }
          
          histWrite(history);
          cleanupOldReports();
          
          // 히스토리 저장 후 추가 상태 확인 및 초기화
          console.log(`[HIST_SAVE] YAML scenario ${jobName} saved to history, checking state...`);
          if (state.running && state.running.job === jobName) {
            console.log(`[HIST_SAVE] Forcing state reset after history save for ${jobName}`);
            state.running = null;
            broadcastState({ running: null });
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
            alertData.failureReport = `YAML Scenario Failures:\n${failedSteps.map(step => 
              `- ${step.name}: ${step.error || 'Test assertions failed'}`
            ).join('\n')}`;
          }
          
          // 결과에 따른 알람 전송
          if (scenarioResult.success) {
            await sendAlert('success', alertData);
          } else {
            await sendAlert('error', alertData);
          }
          
          // 통합 완료 처리 함수 사용 (완료를 기다림)
          await finalizeJobCompletion(jobName, scenarioResult.success ? 0 : 1, scenarioResult.success);
          
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
  const name = req.params.name;
  console.log(`[DEBUG] === API CALL RECEIVED ===`);
  console.log(`[API] POST /api/run/${name} - Job execution request received`);
  console.log(`[DEBUG] req.method: ${req.method}, req.url: ${req.url}`);
  console.log(`[DEBUG] state.running:`, state.running);
  console.log(`[DEBUG] Express res object exists:`, !!res);
  console.log(`[DEBUG] res.json function exists:`, typeof res.json);
  
  try {
    // 상태 검증 및 강제 초기화 로직 추가
    if (state.running) {
      const runningTime = Date.now() - new Date(state.running.startAt).getTime();
      console.log(`[DEBUG] Job ${state.running.job} has been running for ${runningTime}ms, batchMode: ${state.batchMode}`);
      
      // 배치 모드일 때는 더 긴 시간 허용 (30초), 일반 작업은 10초
      const timeoutLimit = state.batchMode ? 30000 : 10000;
      if (runningTime > timeoutLimit) {
        console.log(`[DEBUG] Job ${state.running.job} running too long (${runningTime}ms > ${timeoutLimit}ms), forcing reset`);
        state.running = null;
        state.batchMode = false;
        broadcastState({ running: null });
        broadcastLog(`[SYSTEM] Forced state reset due to stale job state (${runningTime}ms)`, 'SYSTEM');
      } else {
        console.log(`[API] Job execution rejected - already running: ${state.running.job} (${runningTime}ms)`);
        console.log(`[DEBUG] About to send already_running response`);
        const response = { ok: false, reason: 'already_running' };
        console.log(`[DEBUG] Response data:`, response);
        return res.status(400).json(response);
      }
    }

    const jobPath = path.join(root, 'jobs', `${name}.json`);
    if (!fs.existsSync(jobPath)) {
      console.log(`[API] Job execution rejected - job file not found: ${jobPath}`);
      console.log(`[DEBUG] About to send job_not_found response`);
      const response = { ok: false, reason: 'job_not_found' };
      console.log(`[DEBUG] Response data:`, response);
      return res.status(400).json(response);
    }
    
    // 즉시 성공 응답 전송
    console.log(`[API] About to send immediate success response for job: ${name}`);
    const response = { ok: true, message: `잡 '${name}'이(가) 시작되었습니다.` };
    console.log(`[DEBUG] Success response data:`, response);
    
    // Try to send response with additional debugging
    console.log(`[DEBUG] Calling res.json()...`);
    res.json(response);
    console.log(`[DEBUG] res.json() call completed`);
    
    // 백그라운드에서 비동기 실행
    console.log(`[API] Starting background execution for job: ${name}`);
    runJob(name)
      .then(result => {
        console.log(`[API] Job ${name} completed successfully:`, result);
      })
      .catch(error => {
        console.error(`[JOB ERROR] ${name}:`, error);
        // 에러가 발생해도 서버는 계속 동작
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
      webhook_url: config.webhook_url ? '설정됨' : '미설정'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/alert/config', (req, res) => {
  try {
    const currentConfig = readCfg();
    const newConfig = { ...currentConfig, ...req.body };
    
    // config 디렉토리가 없으면 생성
    const configDir = path.dirname(cfgPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2));
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

// Keep-alive를 위한 하트비트
setInterval(() => {
  // State 클라이언트들에게 하트비트 전송
  const heartbeat = `event: heartbeat\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`;
  
  const deadStateClients = new Set();
  for (const c of stateClients) {
    try {
      c.write(heartbeat);
    } catch {
      deadStateClients.add(c);
    }
  }
  
  const deadLogClients = new Set();
  for (const c of logClients) {
    try {
      c.write(heartbeat);
    } catch {
      deadLogClients.add(c);
    }
  }
  
  // 끊어진 연결들 정리
  for (const c of deadStateClients) stateClients.delete(c);
  for (const c of deadLogClients) logClients.delete(c);
  
}, 30000); // 30초마다 하트비트

// 메모리 사용량 모니터링 (개발용)
if (process.env.NODE_ENV === 'development') {
  setInterval(() => {
    const memUsage = process.memoryUsage();
    console.log(`[MEMORY] RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB, Heap: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
    console.log(`[CONNECTIONS] State: ${stateClients.size}, Log: ${logClients.size}`);
    console.log(`[BUFFER] Pending logs: ${logBuffer.length}`);
  }, 10000); // 10초마다
}

// 프로세스 종료 시 정리
process.on('SIGINT', () => {
  console.log('\n[SERVER] 서버 종료 중...');
  
  // 모든 SSE 연결 정리
  for (const c of stateClients) {
    try { c.end(); } catch {}
  }
  for (const c of logClients) {
    try { c.end(); } catch {}
  }
  
  process.exit(0);
});

// 정적 파일 서빙 (캐시 비활성화)
app.use('/reports', express.static(reportsDir, {
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));
app.use('/logs', express.static(logsDir, {
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));
app.use('/', express.static(path.join(root, 'public'), {
  setHeaders: (res, path) => {
    // HTML, CSS, JS 파일들에 캐시 비활성화
    if (path.endsWith('.html') || path.endsWith('.css') || path.endsWith('.js')) {
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

// 캐시 상태 및 클리어 API
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
  // 클라이언트에게 강제 새로고침 지시를 위한 응답
  res.json({
    success: true,
    message: '캐시 클리어 신호가 전송되었습니다. 브라우저를 새로고침해주세요.',
    timestamp: new Date().toISOString(),
    instruction: 'Ctrl+F5 또는 Ctrl+Shift+R로 강제 새로고침하세요.'
  });
});

// 네트워크 연결 테스트 엔드포인트 (캐시 비활성화)
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

// 기본 라우트 (캐시 비활성화)
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('ETag', false);
  res.sendFile(path.join(root, 'public', 'index.html'));
});

// YAML 단일 파일 실행 함수 (state.running 체크 없음)
async function runSingleYamlFile(jobName, job, collectionPath, paths) {
  console.log('🚨🚨🚨 [SINGLE_YAML_ENTRY] FUNCTION CALLED! 🚨🚨🚨');
  console.log('🚨🚨🚨 [SINGLE_YAML_ENTRY] JobName:', jobName);
  console.log('🚨🚨🚨 [SINGLE_YAML_ENTRY] CollectionPath:', collectionPath);
  
  // 강제로 stdout에도 출력
  process.stdout.write('🚨🚨🚨 [SINGLE_YAML_ENTRY] FUNCTION CALLED! 🚨🚨🚨\n');
  process.stdout.write(`🚨🚨🚨 [SINGLE_YAML_ENTRY] JobName: ${jobName}\n`);
  process.stdout.write(`🚨🚨🚨 [SINGLE_YAML_ENTRY] CollectionPath: ${collectionPath}\n`);
  debugLog(`[SINGLE_YAML] Starting single YAML file: ${jobName}`);
  debugLog(`[SINGLE_YAML] Collection path: ${collectionPath}`);
  debugLog(`[SINGLE_YAML] Job config`, job);
  console.log(`[SINGLE_YAML] Starting single YAML file: ${jobName}`);
  console.log(`[SINGLE_YAML] Collection path: ${collectionPath}`);
  
  const { stdoutPath, stderrPath, txtReport, outStream, errStream, stamp } = paths;
  
  return new Promise(async (resolve) => {
    try {
      debugLog(`[SINGLE_YAML] Importing modules for: ${jobName}`);
      // YAML 파서와 SClient 엔진 import
      const { SClientYAMLParser } = await import('./simple-yaml-parser.js');
      const { SClientScenarioEngine, SClientReportGenerator } = await import('./sclient-engine.js');
      debugLog(`[SINGLE_YAML] Modules imported successfully for: ${jobName}`);
      
      debugLog(`[SINGLE_YAML] Reading YAML file: ${collectionPath}`);
      console.log('[SINGLE_YAML] Loading YAML collection:', collectionPath);
      
      // YAML 파일을 JSON 시나리오로 변환 (변수 치환 포함)
      const yamlContent = fs.readFileSync(collectionPath, 'utf-8');
      debugLog(`[SINGLE_YAML] YAML content read, length: ${yamlContent.length} chars`);
      
      const scenario = SClientYAMLParser.parseYamlToScenario(yamlContent);
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
      
      // 개별 파일용 로그 브로드캐스트
      broadcastLog(`[SINGLE_YAML START] ${jobName} - ${scenario.info.name}`);
      
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
            broadcastLog(line.trim(), jobName);
          }
        });
      });
      
      engine.on('stderr', (data) => {
        errStream.write(data.text);
        const lines = data.text.split(/\r?\n/);
        lines.forEach(line => {
          if (line.trim()) {
            broadcastLog(`[ERROR] ${line.trim()}`, jobName);
          }
        });
      });
      
      // 시나리오 실행
      debugLog(`[SINGLE_YAML] Starting scenario execution for: ${jobName}`);
      debugLog(`[SINGLE_YAML] Temp scenario path: ${tempScenarioPath}`);
      console.log('[SINGLE_YAML] Executing scenario...');
      
      const executionResult = await engine.runScenario(tempScenarioPath);
      
      // 강제 로그 출력 - 디버깅용
      console.log('🚨🚨🚨 [FORCE_DEBUG] executionResult received! 🚨🚨🚨');
      console.log('🚨🚨🚨 [FORCE_DEBUG] Type:', typeof executionResult);
      console.log('🚨🚨🚨 [FORCE_DEBUG] Is null:', executionResult === null);
      console.log('🚨🚨🚨 [FORCE_DEBUG] Is undefined:', executionResult === undefined);
      if (executionResult) {
        console.log('🚨🚨🚨 [FORCE_DEBUG] Keys:', Object.keys(executionResult));
        console.log('🚨🚨🚨 [FORCE_DEBUG] Info exists:', !!executionResult.info);
        console.log('🚨🚨🚨 [FORCE_DEBUG] Steps length:', executionResult.steps?.length || 0);
        console.log('🚨🚨🚨 [FORCE_DEBUG] Summary total:', executionResult.summary?.total || 0);
      }
      
      debugLog(`[SINGLE_YAML] Scenario execution completed for: ${jobName}`, {
        success: executionResult?.success,
        stepCount: executionResult?.steps?.length || 0,
        totalTests: executionResult?.summary?.total || 0,
        passedTests: executionResult?.summary?.passed || 0
      });
      console.log('[SINGLE_YAML] Scenario execution completed, result:', executionResult);
      
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
      console.log('🔥🔥🔥 [HTML_CHECK] Checking HTML report generation! 🔥🔥🔥');
      console.log('🔥🔥🔥 [HTML_CHECK] job.generateHtmlReport:', job.generateHtmlReport);
      console.log('🔥🔥🔥 [HTML_CHECK] typeof job.generateHtmlReport:', typeof job.generateHtmlReport);
      console.log('🔥🔥🔥 [HTML_CHECK] Boolean check:', !!job.generateHtmlReport);
      console.log('🔥🔥🔥 [HTML_CHECK] reportsDir:', reportsDir);
      console.log('🔥🔥🔥 [HTML_CHECK] stamp:', stamp);
      
      debugLog(`[SINGLE_YAML] Checking HTML report generation for: ${jobName}`, {
        generateHtmlReport: job.generateHtmlReport,
        reportsDir: reportsDir,
        stamp: stamp
      });
      
      let finalReportPath = null;
      
      if (job.generateHtmlReport) {
        debugLog(`[SINGLE_YAML] Starting HTML report generation for: ${jobName}`);
        try {
          console.log('[SINGLE_YAML] Generating HTML report...');
          const { SClientToNewmanConverter } = await import('./newman-converter.js');
          const reportPath = path.join(reportsDir, `${jobName}_${stamp}.html`);
          
          debugLog(`[SINGLE_YAML] Report path: ${reportPath}`);
          debugLog(`[SINGLE_YAML] Execution result for report`, {
            success: executionResult?.success,
            totalTests: executionResult?.summary?.total,
            passedTests: executionResult?.summary?.passed,
            steps: executionResult?.steps?.length
          });
          
          // DEBUG: executionResult 구조 완전히 로깅
          console.log('[DEBUG_EXECUTION_RESULT] Full executionResult structure:', JSON.stringify(executionResult, null, 2));
          console.log('[DEBUG_EXECUTION_RESULT] Object keys:', Object.keys(executionResult || {}));
          console.log('[DEBUG_EXECUTION_RESULT] Has info?', !!executionResult?.info);
          console.log('[DEBUG_EXECUTION_RESULT] Has steps?', !!executionResult?.steps);
          console.log('[DEBUG_EXECUTION_RESULT] Has summary?', !!executionResult?.summary);
          
          console.log('[HTML_GENERATION] Starting HTML report generation...');
          console.log('[HTML_GENERATION] Report path:', reportPath);
          
          try {
            const converter = new SClientToNewmanConverter();
            // SClient 결과를 Newman 형식으로 변환한 후 HTML 생성
            console.log('[DEBUG_CONVERSION] About to call convertToNewmanRun...');
            const newmanRun = converter.convertToNewmanRun(executionResult);
            console.log('[DEBUG_CONVERSION] Newman conversion result:', JSON.stringify(newmanRun, null, 2));
            console.log('[DEBUG_CONVERSION] Newman run has info?', !!newmanRun?.info);
            console.log('[DEBUG_CONVERSION] Newman run info name?', newmanRun?.info?.name);
            
            console.log('[HTML_GENERATION] Calling generateNewmanStyleHTML...');
            console.log('[HTML_GENERATION] Passing run object with executions:', (newmanRun.run.executions || []).length);
            await converter.generateNewmanStyleHTML(newmanRun.run, reportPath, {
              title: job.reportOptions?.title || `${jobName} Test Report`,
              browserTitle: job.reportOptions?.browserTitle || `${jobName} Report`
            });
            console.log('[HTML_GENERATION] generateNewmanStyleHTML completed');
            
            // 파일이 실제로 생성되었는지 확인
            const reportExists = fs.existsSync(reportPath);
            debugLog(`[SINGLE_YAML] HTML report file exists: ${reportExists}`, {
              reportPath: reportPath,
              fileSize: reportExists ? fs.statSync(reportPath).size : 'N/A'
            });
            
            if (reportExists) {
              finalReportPath = reportPath;
              console.log(`[HTML_GENERATION] ✅ HTML report successfully generated: ${reportPath}`);
            } else {
              console.error('[HTML_GENERATION] ❌ HTML report file not found after generation');
            }
            
          } catch (htmlError) {
            console.error('[HTML_GENERATION] ❌ HTML generation failed:', htmlError.message);
            console.error('[HTML_GENERATION] Error stack:', htmlError.stack);
            
            // 폴백: 기본 HTML 리포트 생성 시도
            try {
              console.log('[HTML_FALLBACK] Attempting fallback HTML generation...');
              const { SClientReportGenerator } = await import('./sclient-engine.js');
              const fallbackContent = SClientReportGenerator.generateHTMLReport(executionResult);
              fs.writeFileSync(reportPath, fallbackContent);
              
              if (fs.existsSync(reportPath)) {
                finalReportPath = reportPath;
                console.log('[HTML_FALLBACK] ✅ Fallback HTML report generated successfully');
              }
            } catch (fallbackError) {
              console.error('[HTML_FALLBACK] ❌ Fallback HTML generation also failed:', fallbackError.message);
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
            const { SClientReportGenerator } = await import('./sclient-engine.js');
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
      broadcastLog(message);
      
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
      broadcastLog(`❌ ${jobName}: ERROR - ${error.message}`);
      
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

// 디버깅용 로그 함수
function debugLog(message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = data ? `[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}` : `[${timestamp}] ${message}`;
  
  console.log(logEntry);
  
  // 디버그 로그 파일에도 기록
  const debugLogPath = path.join(logsDir, `debug_batch_${new Date().toISOString().split('T')[0]}.log`);
  try {
    fs.appendFileSync(debugLogPath, logEntry + '\n');
  } catch (err) {
    console.error('Debug log write failed:', err);
  }
}

// 배치 전용 로그 함수 (콘솔 + 파일 동시 기록)
function batchLog(message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = data ? `[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}` : `[${timestamp}] ${message}`;
  
  // 콘솔 출력
  console.log(logEntry);
  
  // 배치 전용 로그 파일에 기록
  const batchLogPath = path.join(logsDir, `batch_execution_${new Date().toISOString().split('T')[0]}.log`);
  try {
    fs.appendFileSync(batchLogPath, logEntry + '\n');
  } catch (err) {
    console.error('Batch log write failed:', err);
  }
}

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
  
  batchLog(`\n🔄 === ENTERING MAIN TRY BLOCK === 🔄`);
  batchLog(`[MAIN_TRY] About to start main batch processing logic`);
  
  try {
    console.log('🚨🚨🚨 [TRY_BLOCK_ENTRY] Entered main try block! 🚨🚨🚨');
    batchLog(`[MAIN_TRY] Inside try block, about to read directory`);
    // YAML 파일들 찾기
    debugLog(`[YAML_BATCH] Reading directory: ${collectionPath}`);
    const allFiles = fs.readdirSync(collectionPath);
    batchLog(`[MAIN_TRY] Directory read successfully, found ${allFiles.length} files`);
    debugLog(`[YAML_BATCH] All files in directory`, allFiles);
    
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

    state.running = { job: jobName, startAt: startTime };
    broadcastState({ running: state.running });
    broadcastLog(`[YAML_BATCH START] ${jobName} - ${yamlFiles.length} files`);
    
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

    console.log('🚨🚨🚨 [BATCH_ABOUT_TO_START_LOOP] About to start batch loop! 🚨🚨🚨');
    console.log('🚨🚨🚨 [BATCH_ABOUT_TO_START_LOOP] Files to process:', yamlFiles);

    // 각 YAML 파일을 순차적으로 기존 runYamlSClientScenario 방식으로 처리
    const batchResults = [];
    let overallSuccess = true;
    
    debugLog(`[YAML_BATCH] Starting sequential execution of ${yamlFiles.length} files`);
    
    for (let i = 0; i < yamlFiles.length; i++) {
      const fileName = yamlFiles[i];
      const filePath = path.join(collectionPath, fileName);
      
      console.log(`\n=== [BATCH_LOOP] Starting file ${i + 1}/${yamlFiles.length} ===`);
      console.log(`[BATCH_LOOP] Current time: ${new Date().toISOString()}`);
      console.log(`[BATCH_LOOP] Processing: ${fileName}`);
      console.log(`[BATCH_LOOP] Full path: ${filePath}`);
      console.log(`[BATCH_LOOP] Current state.running: ${JSON.stringify(state.running)}`);
      console.log(`[BATCH_LOOP] Current state.batchMode: ${state.batchMode}`);
      console.log(`[BATCH_LOOP] Previous results count: ${batchResults.length}`);
      console.log(`[BATCH_LOOP] Overall success so far: ${overallSuccess}`);
      
      debugLog(`[YAML_BATCH] Processing file ${i + 1}/${yamlFiles.length}: ${fileName}`);
      debugLog(`[YAML_BATCH] Full file path: ${filePath}`);
      console.log(`[YAML_BATCH] Processing ${i + 1}/${yamlFiles.length}: ${fileName}`);
      broadcastLog(`📋 [${i + 1}/${yamlFiles.length}] Starting ${fileName}...`);
      
      // 진행률 표시
      const progressPercent = Math.round(((i + 1) / yamlFiles.length) * 100);
      broadcastLog(`📊 Batch Progress: ${progressPercent}% (${i + 1}/${yamlFiles.length} files)`);
      
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
        
        debugLog(`[YAML_BATCH] Calling runSingleYamlFile for: ${fileName}`);
        console.log(`[BATCH_LOOP] Calling runSingleYamlFile at: ${new Date().toISOString()}`);
        
        // 전체 배치 로그에 개별 파일 시작 로그 기록
        outStream.write(`\n=== [${i + 1}/${yamlFiles.length}] Starting ${fileName} ===\n`);
        
        console.log('🚨🚨🚨 [FORCE_CALL] About to call runSingleYamlFile! 🚨🚨🚨');
        console.log('🚨🚨🚨 [FORCE_CALL] JobName:', `${jobName}_${fileName}`);
        console.log('🚨🚨🚨 [FORCE_CALL] FilePath:', filePath);
        console.log('🚨🚨🚨 [FORCE_CALL] Job.generateHtmlReport:', job.generateHtmlReport);
        console.log('🚨🚨🚨 [FORCE_CALL] Job object keys:', Object.keys(job || {}));
        
        const result = await runSingleYamlFile(`${jobName}_${fileName}`, job, filePath, filePaths);
        
        console.log('🚨🚨🚨 [FORCE_RESULT] runSingleYamlFile returned! 🚨🚨🚨');
        console.log('🚨🚨🚨 [FORCE_RESULT] Success:', result?.success);
        console.log('🚨🚨🚨 [FORCE_RESULT] ReportPath:', result?.reportPath);
        
        // 전체 배치 로그에 개별 파일 완료 로그 기록
        const fileStatusIcon = result.success ? '✅' : '❌';
        const fileStatusText = result.success ? 'SUCCESS' : 'FAILED';
        outStream.write(`=== [${i + 1}/${yamlFiles.length}] ${fileStatusIcon} ${fileName}: ${fileStatusText} (${result.duration}ms) ===\n\n`);
        
        console.log(`[BATCH_LOOP] runSingleYamlFile returned at: ${new Date().toISOString()}`);
        console.log(`[BATCH_LOOP] Result received:`, {
          started: result?.started,
          success: result?.success,
          duration: result?.duration,
          error: result?.error,
          reportPath: result?.reportPath
        });
        
        debugLog(`[YAML_BATCH] runSingleYamlFile completed for: ${fileName}`, {
          started: result.started,
          success: result.success,
          duration: result.duration,
          error: result.error
        });
        
        // 스트림 정리
        individualOutStream.end();
        individualErrStream.end();
        
        const fileResult = {
          fileName,
          filePath,
          success: result.success,
          reportPath: result.reportPath,
          result
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
        broadcastLog(message);
        
        // 개별 파일 상세 진행 상황 브로드캐스트
        if (result.scenarioResult?.summary) {
          const detailMessage = `[${fileName}] Steps: ${result.scenarioResult.summary.passed}✅ ${result.scenarioResult.summary.failed}❌ Duration: ${result.duration}ms`;
          broadcastLog(detailMessage);
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
        broadcastLog(`❌ ${fileName}: ERROR - ${error.message}`);
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

    debugLog(`[YAML_BATCH] Clearing state.running and broadcasting null state`);
    console.log(`[YAML_BATCH] About to clear state.running - current:`, state.running);
    console.log(`[YAML_BATCH] About to deactivate batch mode - current:`, state.batchMode);
    
    state.running = null;
    state.batchMode = false; // 배치 모드 비활성화
    
    console.log(`[YAML_BATCH] State cleared - running:`, state.running, 'batchMode:', state.batchMode);
    console.log(`[YAML_BATCH] About to broadcast null state`);
    try {
      broadcastState({ running: null });
      console.log(`[YAML_BATCH] State broadcast completed`);
    } catch (broadcastError) {
      console.error(`[YAML_BATCH] WARNING: broadcastState failed:`, broadcastError.message);
      debugLog(`[YAML_BATCH] WARNING: broadcastState failed: ${broadcastError.message}`);
    }
    debugLog(`[YAML_BATCH_DEBUG] After broadcastState, about to reach batch report section`);
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

    // 알람 전송
    await sendAlert(overallSuccess ? 'success' : 'error', {
      jobName,
      endTime,
      duration,
      result: finalResult,
      stats: finalResult.stats,
      reportUrl: batchReportPath ? `${readCfg().dashboard_url || 'http://localhost:3000'}/reports/${path.basename(batchReportPath)}` : null
    });

    // 배치 실행 결과를 히스토리에 저장
    const historyEntry = {
      timestamp: endTime,
      job: jobName,
      type: 'binary',
      exitCode: overallSuccess ? 0 : 1,
      summary: `${successFiles}/${yamlFiles.length} files passed (batch)`,
      report: batchReportPath,
      htmlReport: batchReportPath,
      stdout: `batch_execution_${new Date().toISOString().split('T')[0]}.log`,
      stderr: `batch_execution_${new Date().toISOString().split('T')[0]}.log`,
      tags: ['binary', 'yaml', 'batch'],
      duration: Math.round(duration / 1000), // ms를 초로 변환
      batchStats: {
        totalFiles: yamlFiles.length,
        successFiles: successFiles,
        failedFiles: failedFiles,
        successRate: parseFloat(successRate),
        results: batchResults
      },
      detailedStats: {
        totalSteps: batchResults.reduce((sum, r) => sum + (r.result?.scenarioResult?.summary?.total || 0), 0),
        passedSteps: batchResults.reduce((sum, r) => sum + (r.result?.scenarioResult?.summary?.passed || 0), 0),
        failedSteps: batchResults.reduce((sum, r) => sum + (r.result?.scenarioResult?.summary?.failed || 0), 0),
        avgResponseTime: Math.round(batchResults.reduce((sum, r) => {
          const duration = r.result?.scenarioResult?.summary?.duration || 0;
          const total = r.result?.scenarioResult?.summary?.total || 1;
          return sum + (total > 0 ? duration / total : 0);
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
    
    // history 저장
    const history = histRead();
    history.push(historyEntry);
    
    // 최대 기록 개수 유지
    const { history_keep = 500 } = readCfg();
    if (history.length > history_keep) {
      history.splice(0, history.length - history_keep);
    }
    
    // 히스토리 파일에 저장
    try {
      histWrite(history);
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
    broadcastLog(`[YAML_BATCH COMPLETE] ${jobName} - ${statusIcon} ${successFiles}/${yamlFiles.length} files passed`);
    console.log(`[BATCH_COMPLETE] About to return finalResult`);

    return finalResult;

  } catch (error) {
    console.error('🚨🚨🚨 [BATCH_ERROR_CAUGHT] CATCH BLOCK ENTERED! 🚨🚨🚨');
    console.error('🚨🚨🚨 [BATCH_ERROR_CAUGHT] Error:', error.message);
    console.error('🚨🚨🚨 [BATCH_ERROR_CAUGHT] Stack:', error.stack);
    console.error(`\n💥 === [BATCH_ERROR] Critical batch execution error === 💥`);
    console.error(`[BATCH_ERROR] Error occurred at: ${new Date().toISOString()}`);
    console.error(`[BATCH_ERROR] Error message:`, error.message);
    console.error(`[BATCH_ERROR] Error stack:`, error.stack);
    console.error(`[BATCH_ERROR] This error caused the entire batch to terminate!`);
    console.error(`[BATCH_ERROR] Current state when error occurred:`, {
      running: state.running,
      batchMode: state.batchMode,
      processedFiles: batchResults?.length || 0,
      totalFiles: yamlFiles?.length || 'unknown'
    });
    
    console.error(`[YAML_BATCH] Batch execution error:`, error);
    
    console.log(`[BATCH_ERROR] Cleaning up state...`);
    state.running = null;
    state.batchMode = false; // 에러 시에도 배치 모드 비활성화
    console.log(`[YAML_BATCH] Batch mode deactivated due to error`);
    console.log(`[BATCH_ERROR] State cleaned up, broadcasting null state...`);
    broadcastState({ running: null });
    
    return {
      started: false,
      reason: 'batch_execution_error',
      error: error.message
    };
  }
}

// SClient 시나리오 실행 함수
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
    
    state.running = { job: jobName, startAt: startTime };
    broadcastState({ running: state.running });
    broadcastLog(`[SCENARIO START] ${jobName} - ${collectionPath}`);
    
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
      broadcastLog(`[SCENARIO] ${data.message}`);
    });

    engine.on('step-start', (data) => {
      broadcastLog(`[STEP START] ${data.name}`);
      broadcastState({ 
        running: { 
          ...state.running, 
          currentStep: data.name,
          stepProgress: `${data.step || 0}/${data.total || 0}`
        } 
      });
    });

    engine.on('step-end', (data) => {
      broadcastLog(`[STEP END] ${data.name} - Duration: ${data.duration}ms, Exit: ${data.exitCode}`);
    });

    engine.on('step-error', (data) => {
      broadcastLog(`[STEP ERROR] ${data.name} - ${data.error}`);
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
    await finalizeJobCompletion(jobName, success ? 0 : 1, success);
    
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
    
    history.push(historyEntry);
    
    // 최대 기록 개수 유지
    const { history_keep = 500 } = readCfg();
    if (history.length > history_keep) {
      history.splice(0, history.length - history_keep);
    }
    
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

// Binary Job HTML 레포트 생성 함수
async function generateNewmanStyleBinaryReport(data) {
  const {
    jobName,
    binaryPath,
    args,
    startTime,
    endTime,
    duration,
    exitCode,
    stdout,
    stderr,
    parsedResult,
    reportOptions,
    outputPath
  } = data;

  try {
    // Newman 컨버터 import
    const { SClientToNewmanConverter } = await import('./newman-converter.js');
    const converter = new SClientToNewmanConverter();

    // Binary 실행 결과를 Newman 형식으로 변환할 시나리오 결과 생성
    const scenarioResult = convertBinaryToScenarioResult({
      jobName,
      binaryPath,
      args,
      startTime,
      endTime,
      duration,
      exitCode,
      stdout,
      stderr,
      parsedResult,
      reportOptions
    });

    // Newman HTMLExtra 리포트 생성
    const result = await converter.generateReport(scenarioResult, outputPath, 'htmlextra');
    
    if (result.success) {
      return result.path;
    } else {
      console.warn(`[NEWMAN BINARY REPORT] Report generation failed: ${result.error}`);
      return null;
    }
  } catch (error) {
    console.error(`[NEWMAN BINARY REPORT] Error generating Newman report: ${error.message}`);
    return null;
  }
}

function convertBinaryToScenarioResult(data) {
  const {
    jobName,
    binaryPath,
    args,
    startTime,
    endTime,
    duration,
    exitCode,
    stdout,
    stderr,
    parsedResult,
    reportOptions
  } = data;

  const success = exitCode === 0 && parsedResult.success;
  
  // Binary 실행을 단일 스텝으로 변환
  const step = {
    name: `Execute ${path.basename(binaryPath)}`,
    command: path.basename(binaryPath),
    arguments: args.join(' '),
    passed: success,
    duration: duration * 1000, // milliseconds로 변환
    response: {
      exitCode,
      stdout,
      stderr,
      duration: duration * 1000,
      arguments: args
    },
    tests: []
  };

  // parsedResult에 따른 테스트 결과 생성
  if (parsedResult.success !== undefined) {
    step.tests.push({
      name: 'Binary execution success',
      passed: parsedResult.success,
      script: `pm.test("Binary execution success", function () { pm.expect(exitCode).to.equal(0); });`,
      error: parsedResult.success ? null : `Exit code: ${exitCode}`
    });
  }

  // stdout 패턴 검사 테스트 추가
  if (parsedResult.stats && typeof parsedResult.stats === 'object') {
    Object.entries(parsedResult.stats).forEach(([key, value]) => {
      step.tests.push({
        name: `Check ${key}`,
        passed: true,
        script: `pm.test("Check ${key}", function () { pm.expect("${value}").to.be.ok; });`,
        error: null
      });
    });
  }

  // 실패 정보가 있으면 테스트 추가
  if (parsedResult.failures && parsedResult.failures.length > 0) {
    parsedResult.failures.forEach((failure, index) => {
      step.tests.push({
        name: `Failure ${index + 1}`,
        passed: false,
        script: `pm.test("Failure ${index + 1}", function () { pm.expect(false).to.be.true; });`,
        error: failure
      });
    });
  }

  // 테스트가 없으면 기본 테스트 추가
  if (step.tests.length === 0) {
    step.tests.push({
      name: 'Binary execution completed',
      passed: exitCode === 0,
      script: 'pm.test("Binary execution completed", function () { pm.expect(exitCode).to.equal(0); });',
      error: exitCode === 0 ? null : `Process exited with code ${exitCode}`
    });
  }

  return {
    info: {
      name: reportOptions.title || `${jobName} Binary Execution`,
      description: reportOptions.description || `Binary execution report for ${jobName}`
    },
    steps: [step],
    summary: {
      total: 1,
      passed: success ? 1 : 0,
      failed: success ? 0 : 1
    },
    startTime,
    endTime,
    success
  };
}

// Newman HTML 리포트 다크모드 토글 추가 함수 (비활성화 - 원래 Newman HTMLExtra 유지)
/*
function addDarkModeToggleToHtml(htmlFilePath) {
  try {
    if (!fs.existsSync(htmlFilePath)) {
      console.log(`[HTML_POSTPROCESS] 파일이 존재하지 않음: ${htmlFilePath}`);
      return;
    }

    let htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');
    
    // 이미 토글이 추가되어 있는지 확인
    if (htmlContent.includes('theme-toggle-btn')) {
      console.log(`[HTML_POSTPROCESS] 이미 다크모드 토글이 추가됨: ${htmlFilePath}`);
      return;
    }

    // CSS 변수와 다크모드 스타일 추가
    const darkModeCSS = `
    <style id="dark-mode-styles">
        :root {
          --bg-primary: #ffffff;
          --bg-secondary: #f8f9fa;
          --text-primary: #333333;
          --text-secondary: #666666;
          --border-color: #dddddd;
        }
        
        [data-theme="dark"] {
          --bg-primary: #0d1117;
          --bg-secondary: #161b22;
          --text-primary: #c9d1d9;
          --text-secondary: #8b949e;
          --border-color: #30363d;
        }
        
        [data-theme="dark"] body {
          background: var(--bg-primary) !important;
          color: var(--text-primary) !important;
        }
        
        [data-theme="dark"] .container,
        [data-theme="dark"] .card,
        [data-theme="dark"] .summary-item {
          background: var(--bg-secondary) !important;
          color: var(--text-primary) !important;
          border-color: var(--border-color) !important;
        }
        
        .theme-toggle-btn {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 45px;
            height: 45px;
            border-radius: 10px;
            background: var(--bg-secondary);
            border: 2px solid var(--border-color);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
            z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        }
        
        .theme-toggle-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(0,0,0,0.2);
        }
        
        .theme-toggle-btn svg {
            width: 22px;
            height: 22px;
            color: var(--text-primary);
        }
    </style>`;

    // 토글 버튼 HTML
    const toggleButton = `
    <button class="theme-toggle-btn" onclick="toggleTheme()" title="테마 전환">
        <svg id="themeIcon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path>
        </svg>
    </button>`;

    // JavaScript 추가
    const darkModeScript = `
    <script>
        function initTheme() {
            const savedTheme = localStorage.getItem('theme') || 'light';
            setTheme(savedTheme);
        }

        function setTheme(theme) {
            if (theme === 'dark') {
                document.documentElement.setAttribute('data-theme', 'dark');
                updateThemeIcon('dark');
            } else {
                document.documentElement.removeAttribute('data-theme');
                updateThemeIcon('light');
            }
            localStorage.setItem('theme', theme);
        }

        function toggleTheme() {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            setTheme(newTheme);
        }

        function updateThemeIcon(theme) {
            const themeIcon = document.getElementById('themeIcon');
            if (theme === 'dark') {
                themeIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path>';
            } else {
                themeIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path>';
            }
        }

        // 페이지 로드 시 초기화
        document.addEventListener('DOMContentLoaded', initTheme);
    </script>`;

    // </head> 앞에 CSS 추가
    htmlContent = htmlContent.replace('</head>', darkModeCSS + '</head>');
    
    // <body> 뒤에 토글 버튼 추가
    htmlContent = htmlContent.replace('<body>', '<body>' + toggleButton);
    
    // </body> 앞에 JavaScript 추가
    htmlContent = htmlContent.replace('</body>', darkModeScript + '</body>');

    // 파일 저장
    fs.writeFileSync(htmlFilePath, htmlContent);
    console.log(`[HTML_POSTPROCESS] 다크모드 토글 추가 완료: ${htmlFilePath}`);
    
  } catch (error) {
    console.error(`[HTML_POSTPROCESS] 오류 발생: ${error.message}`);
  }
}
*/

function generateBinaryHtmlReport(data) {
  const {
    jobName,
    binaryPath,
    args,
    startTime,
    endTime,
    duration,
    exitCode,
    stdout,
    stderr,
    parsedResult,
    reportOptions
  } = data;

  const title = reportOptions.title || `${jobName} Execution Report`;
  const browserTitle = reportOptions.browserTitle || `${jobName} Report`;
  
  const successClass = exitCode === 0 && parsedResult.success ? 'success' : 'failure';
  const statusText = exitCode === 0 && parsedResult.success ? 'SUCCESS' : 'FAILED';
  
  return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${browserTitle}</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { background: #2c3e50; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .header h1 { margin: 0; font-size: 24px; }
        .status { display: inline-block; padding: 4px 12px; border-radius: 4px; font-weight: bold; margin-left: 10px; }
        .status.success { background-color: #27ae60; color: white; }
        .status.failure { background-color: #e74c3c; color: white; }
        .content { padding: 20px; }
        .section { margin-bottom: 30px; }
        .section h2 { color: #2c3e50; border-bottom: 2px solid #ecf0f1; padding-bottom: 10px; }
        .info-grid { display: grid; grid-template-columns: 200px 1fr; gap: 10px; margin-bottom: 20px; }
        .info-label { font-weight: bold; color: #7f8c8d; }
        .info-value { color: #2c3e50; }
        .output-section { background-color: #f8f9fa; border-left: 4px solid #3498db; padding: 15px; margin: 15px 0; }
        .output-content { background-color: #ffffff; border: 1px solid #dee2e6; border-radius: 4px; padding: 15px; font-family: 'Courier New', monospace; font-size: 14px; white-space: pre-wrap; max-height: 400px; overflow-y: auto; }
        .stats-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        .stats-table th, .stats-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #dee2e6; }
        .stats-table th { background-color: #f8f9fa; font-weight: bold; }
        .failures { background-color: #fff5f5; border-left: 4px solid #e74c3c; padding: 15px; margin: 15px 0; }
        .timestamp { font-size: 12px; color: #7f8c8d; margin-top: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${title}<span class="status ${successClass}">${statusText}</span></h1>
        </div>
        
        <div class="content">
            <div class="section">
                <h2>실행 정보</h2>
                <div class="info-grid">
                    <div class="info-label">Job Name:</div>
                    <div class="info-value">${jobName}</div>
                    <div class="info-label">Binary Path:</div>
                    <div class="info-value">${binaryPath}</div>
                    <div class="info-label">Arguments:</div>
                    <div class="info-value">${args.join(' ') || '(none)'}</div>
                    <div class="info-label">Start Time:</div>
                    <div class="info-value">${startTime}</div>
                    <div class="info-label">End Time:</div>
                    <div class="info-value">${endTime}</div>
                    <div class="info-label">Duration:</div>
                    <div class="info-value">${duration} seconds</div>
                    <div class="info-label">Exit Code:</div>
                    <div class="info-value">${exitCode}</div>
                </div>
            </div>

            <div class="section">
                <h2>실행 결과</h2>
                <div class="info-grid">
                    <div class="info-label">Success:</div>
                    <div class="info-value">${parsedResult.success ? 'Yes' : 'No'}</div>
                    <div class="info-label">Summary:</div>
                    <div class="info-value">${parsedResult.summary}</div>
                </div>
                
                ${parsedResult.stats ? `
                <h3>통계</h3>
                <table class="stats-table">
                    ${Object.entries(parsedResult.stats).map(([key, value]) => 
                        `<tr><td>${key}</td><td>${value}</td></tr>`
                    ).join('')}
                </table>
                ` : ''}
                
                ${parsedResult.failures && parsedResult.failures.length > 0 ? `
                <div class="failures">
                    <h3>실패 항목</h3>
                    <ul>
                        ${parsedResult.failures.map(failure => `<li>${failure}</li>`).join('')}
                    </ul>
                </div>
                ` : ''}
            </div>

            ${stdout ? `
            <div class="section">
                <h2>표준 출력 (STDOUT)</h2>
                <div class="output-section">
                    <div class="output-content">${stdout}</div>
                </div>
            </div>
            ` : ''}

            ${stderr ? `
            <div class="section">
                <h2>표준 에러 (STDERR)</h2>
                <div class="output-section">
                    <div class="output-content">${stderr}</div>
                </div>
            </div>
            ` : ''}
        </div>
        
        <div class="timestamp">
            Generated at ${new Date().toISOString()}
        </div>
    </div>
</body>
</html>`;
}


const cfg = readCfg();
const { site_port = 3000, base_url } = cfg;
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
    console.log(`[CORS] CORS 헤더 활성화 - 로컬 개발 환경 지원`);
    console.log(`[BROWSER] 브라우저 호환성 헤더 설정 완료`);
    console.log(`[ALERT] 알람 시스템 초기화 완료`);
    console.log(`[SSE] 실시간 로그 스트리밍 준비 완료`);
    console.log(`[OPTIMIZATION] 성능 최적화 모드 활성화`);
    console.log(`[SCHEDULE] 스케줄 시스템 로드 완료`);
    console.log(`[FIREWALL] 방화벽에서 포트 ${site_port}이 열려 있는지 확인하세요`);
    console.log(`[DEBUG] 브라우저 문제 시 다음 명령 실행: npm run debug:browser`);
  });
});

// 기존 복잡한 배치 리포트 함수들 제거됨 - generateSimpleBatchReport로 대체

// 간단한 패턴 매칭 함수 (glob-like)
function matchPattern(str, pattern) {
  // 특수 문자들을 정규표현식용으로 escape
  let regexPattern = pattern
    .replace(/\./g, '\\.')  // . -> \.
    .replace(/\*/g, '.*')   // * -> .*
    .replace(/\?/g, '.')    // ? -> .
    .replace(/\*\*/g, '.*'); // ** -> .*
    
  // 패턴이 파일명의 어느 부분에나 매치되도록
  const regex = new RegExp(regexPattern, 'i'); // case insensitive
  
  const isMatch = regex.test(str);
  
  // 디버깅을 위한 로그 (필요시)
  // console.log(`[PATTERN] Testing "${str}" against "${pattern}" -> "${regexPattern}" -> ${isMatch}`);
  
  return isMatch;
}

// 간단한 배치 요약 리포트 생성 함수
async function generateSimpleBatchReport(jobName, batchData) {
  const { startTime, endTime, duration, yamlFiles, successFiles, failedFiles, successRate, results, stamp } = batchData;
  
  const reportPath = path.join(reportsDir, `${jobName}_batch_summary_${stamp}.html`);
  
  const htmlContent = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Batch YAML Test Summary - Newman Report</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><defs><linearGradient id=%22g%22 x1=%220%22 y1=%220%22 x2=%221%22 y2=%221%22><stop offset=%220%25%22 stop-color=%22%237c3aed%22/><stop offset=%22100%25%22 stop-color=%22%233b82f6%22/></linearGradient></defs><circle cx=%2250%22 cy=%2250%22 r=%2245%22 fill=%22url(%23g)%22/><path d=%22M30 35h40v8H30zM30 47h30v8H30zM30 59h35v8H30z%22 fill=%22white%22/><circle cx=%2275%22 cy=%2228%22 r=%228%22 fill=%22%2328a745%22/></svg>">
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            /* Light theme colors */
            --bg-primary: #ffffff;
            --bg-secondary: #f8f9fa;
            --bg-tertiary: #e9ecef;
            --bg-elevated: #ffffff;
            --text-primary: #212529;
            --text-secondary: #6c757d;
            --text-muted: #adb5bd;
            --border-color: #dee2e6;
            --border-hover: #007bff;
            --shadow-color: rgba(0, 0, 0, 0.1);
            --gradient-primary: linear-gradient(135deg, #7c3aed 0%, #3b82f6 100%);
            --success-color: #28a745;
            --success-bg: rgba(40, 167, 69, 0.1);
            --success-border: rgba(40, 167, 69, 0.3);
            --error-color: #dc3545;
            --error-bg: rgba(220, 53, 69, 0.1);
            --error-border: rgba(220, 53, 69, 0.3);
            --info-color: #007bff;
            --warning-color: #ffc107;
            --hover-bg: #f8f9fa;
            --card-bg: #ffffff;
            --code-bg: #f8f9fa;
        }

        [data-theme="dark"] {
            /* Dark theme colors */
            --bg-primary: #0d1117;
            --bg-secondary: #161b22;
            --bg-tertiary: #21262d;
            --bg-elevated: #161b22;
            --text-primary: #c9d1d9;
            --text-secondary: #8b949e;
            --text-muted: #6e7681;
            --border-color: #30363d;
            --border-hover: #58a6ff;
            --shadow-color: rgba(0, 0, 0, 0.3);
            --gradient-primary: linear-gradient(135deg, #7c3aed 0%, #3b82f6 100%);
            --success-color: #238636;
            --success-bg: rgba(35, 134, 54, 0.15);
            --success-border: rgba(35, 134, 54, 0.4);
            --error-color: #f85149;
            --error-bg: rgba(248, 81, 73, 0.15);
            --error-border: rgba(248, 81, 73, 0.4);
            --info-color: #58a6ff;
            --warning-color: #d29922;
            --hover-bg: #21262d;
            --card-bg: #161b22;
            --code-bg: #21262d;
        }

        * {
            box-sizing: border-box;
        }

        body {
            font-family: 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            margin: 0;
            padding: 0;
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.6;
            min-height: 100vh;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
        }

        .header {
            background: var(--gradient-primary);
            color: white;
            padding: 40px 20px;
            text-align: center;
            margin-bottom: 30px;
            border-radius: 12px;
            box-shadow: 0 8px 32px var(--shadow-color);
        }

        .header h1 {
            margin: 0 0 10px 0;
            font-size: 2.5rem;
            font-weight: 700;
        }

        .header .subtitle {
            margin: 0;
            font-size: 1.1rem;
            opacity: 0.9;
            font-weight: 300;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }

        .stat-card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 24px;
            text-align: center;
            box-shadow: 0 4px 16px var(--shadow-color);
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }

        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px var(--shadow-color);
        }

        .stat-number {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 8px;
            line-height: 1;
        }

        .stat-label {
            font-size: 0.9rem;
            color: var(--text-secondary);
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .success { color: var(--success-color); }
        .failed { color: var(--error-color); }

        .results-section {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 4px 16px var(--shadow-color);
            margin-bottom: 30px;
        }

        .results-section h2 {
            margin: 0 0 24px 0;
            font-size: 1.5rem;
            font-weight: 600;
            color: var(--text-primary);
        }

        .results-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 0;
        }

        .results-table th,
        .results-table td {
            padding: 16px;
            text-align: left;
            border-bottom: 1px solid var(--border-color);
        }

        .results-table th {
            background: var(--bg-secondary);
            font-weight: 600;
            color: var(--text-primary);
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .results-table tr:hover {
            background: var(--hover-bg);
        }

        .results-table a {
            color: var(--info-color);
            text-decoration: none;
            font-weight: 500;
            border-bottom: 1px dotted var(--info-color);
            transition: all 0.2s ease;
        }

        .results-table a:hover {
            border-bottom: 1px solid var(--info-color);
        }

        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 0.85rem;
            font-weight: 600;
        }

        .status-success {
            background: var(--success-bg);
            color: var(--success-color);
            border: 1px solid var(--success-border);
        }

        .status-failed {
            background: var(--error-bg);
            color: var(--error-color);
            border: 1px solid var(--error-border);
        }

        .footer {
            text-align: center;
            padding: 30px 20px;
            color: var(--text-muted);
            font-size: 0.9rem;
            border-top: 1px solid var(--border-color);
        }

        .footer p {
            margin: 8px 0;
        }

        .theme-toggle {
            position: fixed;
            top: 20px;
            right: 20px;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 50%;
            width: 50px;
            height: 50px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-shadow: 0 4px 16px var(--shadow-color);
            transition: all 0.2s ease;
            z-index: 1000;
        }

        .theme-toggle:hover {
            transform: scale(1.1);
        }

        @media (max-width: 768px) {
            .container {
                padding: 10px;
            }
            
            .header {
                padding: 20px 15px;
            }
            
            .header h1 {
                font-size: 1.8rem;
            }
            
            .stats-grid {
                grid-template-columns: repeat(2, 1fr);
                gap: 15px;
            }
            
            .stat-number {
                font-size: 2rem;
            }
            
            .results-table th,
            .results-table td {
                padding: 12px 8px;
                font-size: 0.9rem;
            }
        }
    </style>
</head>
<body>
    <div class="theme-toggle" onclick="toggleTheme()" title="Toggle Theme">
        🌙
    </div>

    <div class="container">
        <div class="header">
            <h1>Batch YAML Test Summary</h1>
            <div class="subtitle">Job: ${jobName} | Generated: ${endTime}</div>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-number">${yamlFiles}</div>
                <div class="stat-label">Total Files</div>
            </div>
            <div class="stat-card">
                <div class="stat-number success">${successFiles}</div>
                <div class="stat-label">Success</div>
            </div>
            <div class="stat-card">
                <div class="stat-number failed">${failedFiles}</div>
                <div class="stat-label">Failed</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${successRate}%</div>
                <div class="stat-label">Success Rate</div>
            </div>
        </div>
        
        <div class="results-section">
            <h2>Test Results</h2>
            <table class="results-table">
                <thead>
                    <tr>
                        <th>File Name</th>
                        <th>Status</th>
                        <th>Individual Report</th>
                    </tr>
                </thead>
                <tbody>
                    ${results.map(result => `
                    <tr>
                        <td><strong>${result.fileName}</strong></td>
                        <td>
                            <span class="status-badge ${result.success ? 'status-success' : 'status-failed'}">
                                ${result.success ? '✅ SUCCESS' : '❌ FAILED'}
                            </span>
                        </td>
                        <td>
                            ${result.reportPath ? 
                              `<a href="${path.basename(result.reportPath)}">${path.basename(result.reportPath)}</a>` : 
                              '<span style="color: var(--text-muted);">No report generated</span>'}
                        </td>
                    </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        
        <div class="footer">
            <p><strong>Execution Time:</strong> ${(duration / 1000).toFixed(2)}s | <strong>Start:</strong> ${startTime} | <strong>End:</strong> ${endTime}</p>
            <p>Generated by <strong>2uknow API Monitor System</strong> 🤖</p>
        </div>
    </div>

    <script>
        function toggleTheme() {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme') || 'dark';
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', newTheme);
            
            // Update theme toggle icon
            const toggle = document.querySelector('.theme-toggle');
            toggle.textContent = newTheme === 'dark' ? '🌙' : '☀️';
            
            // Save preference
            localStorage.setItem('theme', newTheme);
        }
        
        // Load saved theme
        document.addEventListener('DOMContentLoaded', () => {
            const savedTheme = localStorage.getItem('theme') || 'dark';
            document.documentElement.setAttribute('data-theme', savedTheme);
            
            const toggle = document.querySelector('.theme-toggle');
            toggle.textContent = savedTheme === 'dark' ? '🌙' : '☀️';
        });
    </script>
</body>
</html>`;

  fs.writeFileSync(reportPath, htmlContent, 'utf8');
  console.log(`[BATCH_SUMMARY] Simple batch report saved: ${reportPath}`);
  
  return reportPath;
}