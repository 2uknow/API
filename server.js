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
  buildBasicStatusText
} from './alert.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const root       = __dirname;

const app = express();
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


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

// dirs
const reportsDir = path.join(root, 'reports');
const logsDir    = path.join(root, 'logs');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
if (!fs.existsSync(logsDir))    fs.mkdirSync(logsDir,    { recursive: true });

// SSE + history (최적화된 버전)
const state = { 
  runningJobs: new Map() // jobName -> { startTime, process } 형태로 관리
};const stateClients = new Set(); 
const logClients = new Set();

// 로그 버퍼링을 위한 변수들
let logBuffer = [];
let broadcastTimeoutId = null;
const BATCH_SIZE = 10; // 한 번에 보낼 로그 수
const BATCH_INTERVAL = 50; // 배치 전송 간격 (ms)

function sseHeaders(res){ 
  res.writeHead(200, { 
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    'Connection':'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  }); 
  res.write('\n'); 
}

function broadcastState(payload){ 
  const data=`event: state\ndata: ${JSON.stringify(payload)}\n\n`; 
  for (const c of stateClients){ 
    try{c.write(data);}catch{
      stateClients.delete(c);
    } 
  } 
}

// 최적화된 로그 브로드캐스트 - 배치 처리
function broadcastLog(line){ 
  logBuffer.push(line);
  
  // 배치 크기에 도달하거나 타이머가 설정되지 않았으면 즉시 전송
  if (logBuffer.length >= BATCH_SIZE || !broadcastTimeoutId) {
    flushLogBuffer();
  } else if (!broadcastTimeoutId) {
    // 타이머 설정하여 지연 전송
    broadcastTimeoutId = setTimeout(flushLogBuffer, BATCH_INTERVAL);
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

// 개선된 runJob 함수 - Newman 결과 통계 포함
function flushLogBuffer() {
  if (logBuffer.length === 0) return;
  
  // 배치로 로그 전송
  const batch = logBuffer.splice(0, BATCH_SIZE);
  const data = batch.map(line => 
    `event: log\ndata: ${JSON.stringify({ line, at: Date.now() })}\n\n`
  ).join('');
  
  // 연결이 끊어진 클라이언트 정리하면서 전송
  const deadClients = new Set();
  for (const c of logClients) {
    try {
      c.write(data);
    } catch (error) {
      deadClients.add(c);
    }
  }
  
  // 끊어진 연결 정리
  for (const c of deadClients) {
    logClients.delete(c);
  }
  
  // 더 보낼 로그가 있으면 다시 스케줄링
  if (logBuffer.length > 0) {
    broadcastTimeoutId = setTimeout(flushLogBuffer, BATCH_INTERVAL);
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
    console.log(`[ALERT] 알람이 비활성화되어 있습니다: ${type}`);
    return;
  }

  // 각 타입별 알람 설정 확인
  if (type === 'start' && !config.alert_on_start) return;
  if (type === 'success' && !config.alert_on_success) return;
  if (type === 'error' && !config.alert_on_error) return;

  try {
    let result;
    
    if (config.alert_method === 'flex') {
      // 기존 Flex 메시지 (복잡한 Newman 결과 제외)
      const flexData = buildBasicRunStatusFlex(type, data);
      result = await sendFlexMessage(flexData);
    } else {
      // 기존 텍스트 메시지 (간단한 정보만)
      const message = buildBasicStatusText(type, data);
      result = await sendTextMessage(message);
    }

    console.log(`[ALERT] ${type} 알람 전송 결과:`, result);
    
    if (!result.ok) {
      console.error(`[ALERT ERROR] ${type} 알람 전송 실패:`, result);
    }

  } catch (error) {
    console.error(`[ALERT ERROR] ${type} 알람 전송 중 오류:`, error);
  }
}

// Newman JSON 리포트 파싱 함수 추가
function parseNewmanJsonReport(jsonReportPath) {
  try {
    if (!fs.existsSync(jsonReportPath)) {
      return null;
    }
    
    const reportData = JSON.parse(fs.readFileSync(jsonReportPath, 'utf-8'));
    const run = reportData.run;
    
    if (!run) return null;
    
    const stats = run.stats;
    const failures = run.failures || [];
    
    return {
      summary: {
        iterations: stats.iterations,
        requests: stats.requests,
        testScripts: stats.testScripts,
        prerequestScripts: stats.prerequestScripts,
        assertions: stats.assertions
      },
      failures: failures.map(failure => ({
        source: failure.source?.name || 'Unknown',
        error: failure.error?.message || 'Unknown error',
        test: failure.error?.test || null
      })),
      timings: {
        responseAverage: run.timings?.responseAverage || 0,
        responseMin: run.timings?.responseMin || 0,
        responseMax: run.timings?.responseMax || 0
      }
    };
  } catch (error) {
    console.error('JSON 리포트 파싱 오류:', error);
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
app.get('/api/stream/state', (req,res)=>{ 
  sseHeaders(res); 
  stateClients.add(res); 
  
  // 연결 수 로깅
  console.log(`[SSE] State 클라이언트 연결: ${stateClients.size}개`);
  
  const last=histRead().at(-1)||null; 
  res.write(`event: state\ndata: ${JSON.stringify({ running:state.running, last })}\n\n`); 
  
  req.on('close',()=>{
    stateClients.delete(res);
    console.log(`[SSE] State 클라이언트 연결 해제: ${stateClients.size}개`);
  }); 
});

app.get('/api/stream/logs', (req,res)=>{ 
  sseHeaders(res); 
  logClients.add(res); 
  
  // 연결 수 로깅
  console.log(`[SSE] Log 클라이언트 연결: ${logClients.size}개`);
  
  req.on('close',()=>{
    logClients.delete(res);
    console.log(`[SSE] Log 클라이언트 연결 해제: ${logClients.size}개`);
  }); 
});

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
        console.log(`[SCHEDULE TRIGGER] Running job: ${name}`);
        runJob(name);
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
    console.log(`[SCHEDULE TRIGGER] Running job: ${name}`);
    runJob(name);
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
async function runJob(jobName){
  if (state.running) return { started:false, reason:'already_running' };

  const jobPath = path.join(root, 'jobs', `${jobName}.json`);
  if (!fs.existsSync(jobPath)) return { started:false, reason:'job_not_found' };
  
  const job = JSON.parse(fs.readFileSync(jobPath,'utf-8'));
  if (job.type !== 'newman') return { started:false, reason:'unsupported_type' };

  const collection  = path.resolve(root, job.collection);
  const environment = job.environment ? path.resolve(root, job.environment) : undefined;
  const reporters   = job.reporters?.length ? job.reporters : ['cli','htmlextra','junit','json'];
  const stamp = new Date().toISOString().replace(/[:T]/g,'_').replace(/\..+/,'');

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
      outStream.write(s);
      s.split(/\r?\n/).forEach(line => line && broadcastLog(line));
    });
    
    proc.stderr.on('data', d => {
      const s = d.toString();
      errStream.write(s);
      errorOutput += s; // 에러 내용 수집
      s.split(/\r?\n/).forEach(line => line && broadcastLog(line));
    });
    
    proc.on('close', async (code)=>{
      outStream.end(); 
      errStream.end();
      
      const endTime = nowInTZString();
      const duration = Math.round((Date.now() - startTs) / 1000);
      
      broadcastLog(`[DONE] exit=${code}`);

      // Newman 결과 파싱
      const { summary, stats } = parseNewmanResult(jsonReport);

      // history 저장
      const history = histRead();
      const historyEntry = {
        timestamp: endTime,
        job: jobName,
        type: job.type,
        exitCode: code,
        summary: summary, // 개선된 요약
        report: htmlReport,
        stdout: path.basename(stdoutPath),
        stderr: path.basename(stderrPath),
        tags: [],
        duration: duration,
        stats: stats // Newman 통계 추가
      };
      
      history.push(historyEntry);
      
      const { history_keep = 500 } = readCfg();
      if (history.length > history_keep) {
        history.splice(0, history.length - history_keep);
      }
      
      histWrite(history);
      cleanupOldReports();

      // 알람 데이터 준비
      const alertData = {
        jobName,
        startTime,
        endTime,
        duration,
        exitCode: code,
        collection: path.basename(collection),
        environment: environment ? path.basename(environment) : null,
        reportPath: htmlReport,
        stats: stats, // Newman 통계 추가
        summary: summary // 요약 추가
      };

      // 성공/실패에 따른 알람 전송
      if (code === 0) {
        // 성공 알람
        await sendAlert('success', alertData);
      } else {
        // 실패 알람
        alertData.errorSummary = errorOutput.trim().split('\n').slice(-3).join('\n'); // 마지막 3줄만
        await sendAlert('error', alertData);
      }

      state.running = null;
      broadcastState({ running: null });
      resolve({ started:true, code });
    });

    // 프로세스 에러 처리
    proc.on('error', async (err) => {
      console.error(`[PROC ERROR] ${jobName}:`, err);
      
      const endTime = nowInTZString();
      const duration = Math.round((Date.now() - startTs) / 1000);
      
      // 프로세스 시작 실패 알람
      await sendAlert('error', {
        jobName,
        startTime,
        endTime,
        duration,
        exitCode: -1,
        errorSummary: `프로세스 시작 실패: ${err.message}`,
        collection: path.basename(collection),
        environment: environment ? path.basename(environment) : null
      });

      state.running = null;
      broadcastState({ running: null });
      resolve({ started:false, reason:'process_error', error: err.message });
    });
  });
}

// POST /api/run/:name
app.post('/api/run/:name', async (req,res)=>{
  const name = req.params.name;
  const result = await runJob(name);
  
  if (result.started) {
    res.json({ ok: true, message: `잡 '${name}'이(가) 시작되었습니다.` });
  } else {
    res.status(400).json({ ok: false, reason: result.reason });
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

// 정적 파일 서빙
app.use('/reports', express.static(reportsDir));
app.use('/logs',    express.static(logsDir));
app.use('/',        express.static(path.join(root, 'public')));

// 기본 라우트
app.get('/', (req, res) => {
  res.sendFile(path.join(root, 'public', 'index.html'));
});

const { site_port = 3000 } = readCfg();
app.listen(site_port, () => {
  console.log(`[SITE] http://localhost:${site_port}`);
  console.log(`[ALERT] 알람 시스템 초기화 완료`);
  console.log(`[SSE] 실시간 로그 스트리밍 준비 완료`);
  console.log(`[OPTIMIZATION] 성능 최적화 모드 활성화`);
  console.log(`[SCHEDULE] 스케줄 시스템 로드 완료`);
});