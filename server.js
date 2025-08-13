// server.js (최종 수정 - 모든 문제 해결)
import express from 'express';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
// alert.js import 추가
import { sendTextMessage, sendFlexMessage, buildRunStatusFlex } from './alert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const root       = __dirname;

const app = express();
app.use(morgan('dev'));
// 캐시 방지 미들웨어 추가
app.use((req, res, next) => {
  // API 요청에 대해 캐시 완전 비활성화
  if (req.url.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.json());

const cfgPath = path.join(root, 'config', 'settings.json');
function readCfg() {
  try { 
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); 
  } catch { 
    return { 
      site_port: 3000, 
      history_keep: 500, 
      report_keep_days: 30, 
      timezone: 'Asia/Seoul', 
      run_mode:'cli', 
      run_event_alert: false,  // 기본값 false로 변경
      alert_on_start: false,
      alert_on_success: false,
      alert_on_error: false,
      alert_method: 'flex'
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

// 디렉토리 생성
const reportsDir = path.join(root, 'reports');
const logsDir    = path.join(root, 'logs');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
if (!fs.existsSync(logsDir))    fs.mkdirSync(logsDir,    { recursive: true });

// SSE 연결 관리 - 단순화
const state = { running: null };
const stateClients = new Set();
const logClients = new Set();

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

// 단순화된 브로드캐스트
function broadcastState(payload){ 
  const data = `event: state\ndata: ${JSON.stringify(payload)}\n\n`; 
  const deadClients = [];
  
  for (const client of stateClients) { 
    try {
      if (!client.destroyed && !client.finished) {
        client.write(data);
      } else {
        deadClients.push(client);
      }
    } catch (err) {
      deadClients.push(client);
    }
  }
  
  deadClients.forEach(client => stateClients.delete(client));
  console.log(`[SSE] State clients: ${stateClients.size}`);
}

// 개선된 로그 시스템 - 탭별 독립성 보장
let logBuffer = []; // 최근 로그를 저장하는 버퍼
const MAX_LOG_BUFFER = 1000; // 최대 1000줄까지 버퍼링

function broadcastLog(line){ 
  if (!line || line.trim() === '') return;
  
  const logEntry = { 
    line: line.trim(), 
    at: Date.now(),
    id: Date.now() + Math.random() // 각 로그에 고유 ID
  };
  
  // 로그 버퍼에 추가
  logBuffer.push(logEntry);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer = logBuffer.slice(-MAX_LOG_BUFFER); // 오래된 로그 제거
  }
  
  const data = `event: log\ndata: ${JSON.stringify(logEntry)}\n\n`; 
  const deadClients = [];
  
  for (const client of logClients) { 
    try {
      if (!client.destroyed && !client.finished) {
        client.write(data);
      } else {
        deadClients.push(client);
      }
    } catch (err) {
      deadClients.push(client);
    }
  }
  
  deadClients.forEach(client => logClients.delete(client));
}

function histRead(){ 
  const p = path.join(root,'logs','history.json'); 
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf-8')) : []; 
}

function histWrite(arr){ 
  const p = path.join(root,'logs','history.json'); 
  fs.writeFileSync(p, JSON.stringify(arr,null,2)); 
}

function cleanupOldReports(){ 
  const { report_keep_days = 30 } = readCfg(); 
  const maxAge = report_keep_days * 24 * 3600 * 1000; 
  const now = Date.now(); 
  try {
    for (const f of fs.readdirSync(reportsDir)){ 
      const p = path.join(reportsDir,f); 
      const st = fs.statSync(p); 
      if (now - st.mtimeMs > maxAge){ 
        try{ fs.unlinkSync(p); }catch{} 
      } 
    }
  } catch(e) {
    console.log('[CLEANUP] 리포트 정리 중 오류:', e.message);
  }
}

// 실제 알람 전송 함수 (alert.js 사용)
async function sendAlert(type, data) {
  const config = readCfg();
  
  if (!config.run_event_alert) {
    console.log(`[ALERT] 알람이 비활성화되어 있습니다: ${type}`);
    return;
  }

  if (type === 'start' && !config.alert_on_start) return;
  if (type === 'success' && !config.alert_on_success) return;
  if (type === 'error' && !config.alert_on_error) return;

  try {
    let result;
    
    if (config.alert_method === 'flex') {
      const flexData = buildRunStatusFlex(type, data);
      result = await sendFlexMessage(flexData);
    } else {
      let message;
      if (type === 'start') {
        message = `🚀 API 테스트 실행 시작\n잡: ${data.jobName}\n시간: ${data.startTime}`;
      } else if (type === 'success') {
        message = `✅ API 테스트 실행 성공\n잡: ${data.jobName}\n실행시간: ${data.duration}초\n종료시간: ${data.endTime}`;
      } else if (type === 'error') {
        message = `❌ API 테스트 실행 실패\n잡: ${data.jobName}\n종료코드: ${data.exitCode}\n실행시간: ${data.duration}초\n종료시간: ${data.endTime}`;
        if (data.errorSummary) {
          message += `\n오류: ${data.errorSummary}`;
        }
      }
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

// API: jobs - 디버깅 추가
app.get('/api/jobs', (req,res)=>{
  console.log(`[API] GET /api/jobs 요청 받음`);
  const dir = path.join(root, 'jobs');
  console.log(`[API] jobs 디렉토리: ${dir}`);
  
  try{
    if (!fs.existsSync(dir)) {
      console.log(`[API] ❌ jobs 디렉토리가 없음: ${dir}`);
      return res.json([]);
    }
    
    const files = fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
    console.log(`[API] 발견된 JSON 파일들:`, files);
    
    const items = [];
    for (const f of files){
      const filePath = path.join(dir, f);
      console.log(`[API] 파일 처리 중: ${filePath}`);
      
      try{
        const j = JSON.parse(fs.readFileSync(filePath,'utf-8'));
        console.log(`[API] 파일 내용:`, j);
        
        if (!j.name || !j.type) {
          console.log(`[API] ⚠️ 잘못된 잡 형식 (name 또는 type 없음):`, f);
          continue;
        }
        
        items.push({
          file: f,
          name: j.name,
          type: j.type,
          collection: j.collection,
          environment: j.environment || null,
          reporters: j.reporters || ['cli','htmlextra','junit','json'],
          extra: j.extra || []
        });
        
        console.log(`[API] ✅ 잡 추가됨: ${j.name}`);
      } catch(e) {
        console.log(`[API] ❌ 파일 파싱 실패: ${f}`, e.message);
      }
    }
    
    console.log(`[API] 최종 잡 목록 (${items.length}개):`, items.map(i => i.name));
    res.json(items);
  }catch(e){ 
    console.log(`[API] ❌ 디렉토리 읽기 실패:`, e.message);
    res.status(500).json({ error:e.message }); 
  }
});

app.get('/api/history', (req,res)=>{
  try{
    const data = histRead();
    const page = parseInt(req.query.page||'1',10);
    const size = Math.min(parseInt(req.query.size||'50',10),500);
    const start = Math.max(data.length-page*size,0);
    const end = data.length-(page-1)*size;
    res.json({ 
      total:data.length, 
      page, 
      size, 
      items:data.slice(start,end), 
      running: state.running
    });
  }catch(e){ 
    res.status(500).json({ error:e.message }); 
  }
});

// 단순화된 SSE 엔드포인트
app.get('/api/stream/state', (req,res)=>{ 
  console.log(`[SSE] New state client`);
  
  sseHeaders(res); 
  stateClients.add(res);
  
  // 즉시 현재 상태 전송
  const currentState = { running: state.running, last: histRead().at(-1) || null };
  res.write(`event: state\ndata: ${JSON.stringify(currentState)}\n\n`);
  
  req.on('close', () => {
    console.log(`[SSE] State client disconnected`);
    stateClients.delete(res);
  });
  
  req.on('error', () => {
    stateClients.delete(res);
  });
});

// 개선된 로그 SSE 엔드포인트 - 연결 제한
app.get('/api/stream/logs', (req,res)=>{ 
  console.log(`[SSE] New log client connected from ${req.ip} (현재: ${logClients.size}개)`);
  
  // 연결 수 제한
  if (logClients.size >= 10) {
    console.warn(`[SSE] ❌ Log 연결 제한 초과 (${logClients.size}개) - 연결 거부`);
    res.status(429).json({ error: 'Too many connections' });
    return;
  }
  
  // CORS 및 SSE 헤더 설정
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control',
    'X-Accel-Buffering': 'no'
  });
  
  // 즉시 연결 확인 메시지 전송
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Log stream connected', time: Date.now() })}\n\n`);
  
  logClients.add(res);
  
  // 새로 연결된 클라이언트에게 최근 로그 전송
  if (req.query.recent === 'true' && logBuffer.length > 0) {
    const recentLogs = logBuffer.slice(-20); // 최근 20줄만
    recentLogs.forEach(logEntry => {
      try {
        res.write(`event: log\ndata: ${JSON.stringify(logEntry)}\n\n`);
      } catch(e) {
        console.log('[SSE] Failed to send recent log:', e.message);
      }
    });
  }
  
  // 연결 유지를 위한 heartbeat (60초마다)
  const heartbeatInterval = setInterval(() => {
    if (!res.destroyed && !res.finished && res.writable) {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
      } catch(e) {
        clearInterval(heartbeatInterval);
        logClients.delete(res);
      }
    } else {
      clearInterval(heartbeatInterval);
      logClients.delete(res);
    }
  }, 60000);
  
  req.on('close', () => {
    console.log(`[SSE] Log client disconnected (남은: ${logClients.size - 1}개)`);
    clearInterval(heartbeatInterval);
    logClients.delete(res);
  });
  
  req.on('error', (err) => {
    console.log(`[SSE] Log client error:`, err.message);
    clearInterval(heartbeatInterval);
    logClients.delete(res);
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    running: state.running,
    timestamp: Date.now(),
    stateClients: stateClients.size,
    logClients: logClients.size
  });
});

// 스케줄 관리
const schedFile = path.join(root,'config','schedules.json'); 
const schedules = new Map();

function loadSchedules(){ 
  if(!fs.existsSync(schedFile)) return; 
  try{ 
    const arr = JSON.parse(fs.readFileSync(schedFile,'utf-8')); 
    arr.forEach(({name,cronExpr})=>{ 
      const task = cron.schedule(cronExpr,()=>runJob(name),{scheduled:true}); 
      schedules.set(name,{cronExpr,task});
    }); 
  }catch{} 
}

function saveSchedules(){ 
  const arr = [...schedules.entries()].map(([name,{cronExpr}])=>({name,cronExpr})); 
  fs.writeFileSync(schedFile, JSON.stringify(arr,null,2)); 
}

app.get('/api/schedule',(req,res)=>{ 
  res.json([...schedules.entries()].map(([name,{cronExpr}])=>({name,cronExpr})));
});

app.post('/api/schedule',(req,res)=>{ 
  let body=''; 
  req.on('data',c=>body+=c); 
  req.on('end',()=>{ 
    try{ 
      const {name,cronExpr} = JSON.parse(body||'{}'); 
      if(!name||!cronExpr) return res.status(400).json({message:'name/cronExpr 필요'}); 
      if(schedules.has(name)) schedules.get(name).task.stop(); 
      const task = cron.schedule(cronExpr,()=>runJob(name),{scheduled:true}); 
      schedules.set(name,{cronExpr,task}); 
      saveSchedules(); 
      res.json({ok:true}); 
    }catch(e){ 
      res.status(400).json({message:'invalid body'});
    } 
  });
});

app.delete('/api/schedule/:name',(req,res)=>{ 
  const {name} = req.params; 
  const it = schedules.get(name); 
  if(it){ 
    it.task.stop(); 
    schedules.delete(name); 
    saveSchedules(); 
  } 
  res.json({ok:true});
});

loadSchedules();

// 수정된 Newman CLI 실행 - Windows용 최적화
function spawnNewmanCLI(args){
  console.log('[SPAWN] Newman 실행 시작');
  
  // Windows에서 cmd를 통해 실행
  return spawn('cmd', ['/c', 'npx', ...args], { 
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

// 핵심 잡 실행 함수
async function runJob(jobName){
  if (state.running) {
    console.log(`[JOB] 이미 실행 중: ${state.running.job}`);
    return { started:false, reason:'already_running' };
  }

  const jobPath = path.join(root, 'jobs', `${jobName}.json`);
  if (!fs.existsSync(jobPath)) return { started:false, reason:'job_not_found' };
  
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobPath,'utf-8'));
  } catch(e) {
    return { started:false, reason:'invalid_job_config' };
  }
  
  if (job.type !== 'newman') return { started:false, reason:'unsupported_type' };

  const collection  = path.resolve(root, job.collection);
  const environment = job.environment ? path.resolve(root, job.environment) : undefined;
  const reporters   = job.reporters?.length ? job.reporters : ['cli','htmlextra'];
  const stamp = new Date().toISOString().replace(/[:T]/g,'_').replace(/\..+/,'');

  const htmlReport = path.join(reportsDir, `${jobName}_${stamp}.html`);
  const junitReport = path.join(reportsDir, `${jobName}_${stamp}.xml`);
  const jsonReport = path.join(reportsDir, `${jobName}_${stamp}.json`);
  const stdoutPath = path.join(logsDir, `stdout_${jobName}_${stamp}.log`);
  const stderrPath = path.join(logsDir, `stderr_${jobName}_${stamp}.log`);
  const cliExport = path.join(logsDir, `cli_${jobName}_${stamp}.txt`);
  
  const outStream  = fs.createWriteStream(stdoutPath, { flags:'a' });
  const errStream  = fs.createWriteStream(stderrPath, { flags:'a' });

  if (!fs.existsSync(collection)) return { started:false, reason:'collection_not_found' };
  if (environment && !fs.existsSync(environment)) return { started:false, reason:'environment_not_found' };

  const startTime = nowInTZString();
  const startTs = Date.now();

  // 실행 상태 설정
  state.running = { job: jobName, startAt: startTime };
  console.log(`[JOB] ===== 실행 시작: ${jobName} =====`);
  broadcastState({ running: state.running });
  broadcastLog(`🚀 [${startTime}] ${jobName} 실행 시작`);

  return new Promise((resolve) => {
    // 단순화된 Newman 인수 구성
    const args = [
      'newman', 'run', collection,
      '-r', reporters.join(','),
      '--color', 'on'
    ];
    
    if (environment) args.push('-e', environment);
    
    // 리포트 파일 설정
    if (reporters.includes('htmlextra')) {
      args.push('--reporter-htmlextra-export', htmlReport);
    }
    if (reporters.includes('junit')) {
      args.push('--reporter-junit-export', junitReport);
    }
    if (reporters.includes('json')) {
      args.push('--reporter-json-export', jsonReport);
    }
    if (reporters.includes('cli')) {
      args.push('--reporter-cli-export', cliExport);
    }
    
    // 추가 옵션
    if (job.extra && Array.isArray(job.extra)) {
      args.push(...job.extra);
    }

    console.log('[NEWMAN] Args:', args.slice(0, 5), '...'); // 처음 5개만 로그
    broadcastLog(`📋 Newman 시작: ${collection.split('\\').pop()}`);

    const proc = spawnNewmanCLI(args);
    let errorOutput = '';
    let outputCount = 0;

    proc.stdout.on('data', (data) => {
      const str = data.toString();
      outStream.write(str);
      
      // 모든 출력을 실시간으로 전송 (원래대로 복원)
      const lines = str.split(/\r?\n/);
      lines.forEach(line => {
        if (line.trim()) {
          broadcastLog(line);
        }
      });
    });

    proc.stderr.on('data', (data) => {
      const str = data.toString();
      errStream.write(str);
      errorOutput += str;
      
      // 모든 에러를 실시간 전송 (원래대로 복원)
      const lines = str.split(/\r?\n/);
      lines.forEach(line => {
        if (line.trim()) {
          broadcastLog(`❌ ${line}`);
        }
      });
    });

    proc.on('close', (code) => {
      outStream.end();
      errStream.end();

      const endTime = nowInTZString();
      const duration = Math.round((Date.now() - startTs) / 1000);

      console.log(`[JOB] ===== 완료: ${jobName} (${duration}초, 코드: ${code}) =====`);
      
      const resultIcon = code === 0 ? '✅' : '❌';
      const resultText = code === 0 ? '성공' : '실패';
      broadcastLog(`${resultIcon} [${endTime}] ${jobName} ${resultText} (${duration}초)`);

      // 히스토리 저장 (타임스탬프 수정)
      const histItem = {
        timestamp: Date.now(), // 숫자 타임스탬프로 저장 (정렬용)
        startTime,
        endTime,
        duration,
        job: jobName,
        type: job.type,
        exitCode: code,
        collection: path.basename(collection),
        environment: environment ? path.basename(environment) : null,
        stdout: path.basename(stdoutPath),
        stderr: path.basename(stderrPath),
        report: fs.existsSync(htmlReport) ? htmlReport : null,
        summary: code === 0 ? '성공' : '실패'
      };

      try {
        const hist = histRead();
        hist.push(histItem);
        const { history_keep = 500 } = readCfg();
        if (hist.length > history_keep) hist.splice(0, hist.length - history_keep);
        histWrite(hist);
      } catch(e) {
        console.error('[HISTORY] 저장 실패:', e.message);
      }

      // 알람 전송 (비동기)
      setTimeout(() => {
        const alertData = {
          jobName,
          startTime,
          endTime,
          duration,
          exitCode: code,
          collection: path.basename(collection),
          environment: environment ? path.basename(environment) : null,
          reportPath: htmlReport
        };

        if (code === 0) {
          sendAlert('success', alertData);
        } else {
          alertData.errorSummary = errorOutput.trim().split('\n').slice(-3).join('\n');
          sendAlert('error', alertData);
        }
      }, 100);

      // 실행 상태 초기화
      state.running = null;
      broadcastState({ running: null });
      resolve({ started:true, code });
    });

    proc.on('error', (err) => {
      console.error(`[PROC ERROR] ${jobName}:`, err);
      broadcastLog(`💥 프로세스 오류: ${err.message}`);
      
      const endTime = nowInTZString();
      const duration = Math.round((Date.now() - startTs) / 1000);
      
      setTimeout(() => {
        sendAlert('error', {
          jobName,
          startTime,
          endTime,
          duration,
          exitCode: -1,
          errorSummary: `프로세스 시작 실패: ${err.message}`,
          collection: path.basename(collection),
          environment: environment ? path.basename(environment) : null
        });
      }, 100);

      state.running = null;
      broadcastState({ running: null });
      resolve({ started:false, reason:'process_error', error: err.message });
    });

    // 시작 알람
    setTimeout(() => {
      sendAlert('start', {
        jobName,
        startTime,
        collection: path.basename(collection),
        environment: environment ? path.basename(environment) : null
      });
    }, 100);
  });
}

// 수정된 실행 API
app.post('/api/run/:job', async (req,res)=>{
  const { job } = req.params;
  console.log(`[API] 잡 실행 요청: ${job}`);
  
  if (state.running) {
    return res.status(409).json({ 
      error: 'already_running', 
      message: `이미 실행 중입니다: ${state.running.job}` 
    });
  }
  
  // 즉시 응답
  res.json({ message:`실행 시작: ${job}`, running: true });
  
  // 백그라운드 실행
  runJob(job).catch(error => {
    console.error(`[JOB] 실행 중 예외:`, error);
    state.running = null;
    broadcastState({ running: null });
  });
});

// 알람 설정 API
app.get('/api/alert/config', (req, res) => {
  const config = readCfg();
  res.json({
    run_event_alert: config.run_event_alert || false,
    alert_on_start: config.alert_on_start || false,
    alert_on_success: config.alert_on_success || false,
    alert_on_error: config.alert_on_error || false,
    alert_method: config.alert_method || 'text',
    webhook_url: config.webhook_url ? '설정됨' : '미설정'
  });
});

app.post('/api/alert/config', (req, res) => {
  try {
    const config = readCfg();
    const { 
      run_event_alert, 
      alert_on_start, 
      alert_on_success, 
      alert_on_error, 
      alert_method 
    } = req.body;

    if (typeof run_event_alert === 'boolean') config.run_event_alert = run_event_alert;
    if (typeof alert_on_start === 'boolean') config.alert_on_start = alert_on_start;
    if (typeof alert_on_success === 'boolean') config.alert_on_success = alert_on_success;
    if (typeof alert_on_error === 'boolean') config.alert_on_error = alert_on_error;
    if (alert_method && ['text', 'flex'].includes(alert_method)) config.alert_method = alert_method;

    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
    
    res.json({ success: true, message: '알람 설정이 업데이트되었습니다.' });
  } catch (error) {
    console.error('[CONFIG ERROR]', error);
    res.status(500).json({ success: false, message: '설정 저장 중 오류가 발생했습니다.' });
  }
});

// 알람 테스트 API 추가
app.post('/api/alert/test', async (req, res) => {
  try {
    const { type } = req.body;
    const testData = {
      jobName: 'test-job',
      startTime: nowInTZString(),
      endTime: nowInTZString(),
      duration: 10,
      exitCode: type === 'error' ? 1 : 0,
      collection: 'test-collection.json',
      environment: 'test-env.json'
    };

    if (type === 'error') {
      testData.errorSummary = '테스트 오류 메시지입니다.';
    }

    await sendAlert(type, testData);
    res.json({ success: true, message: `${type} 테스트 알람을 전송했습니다.` });
  } catch (error) {
    console.error('[TEST ALERT ERROR]', error);
    res.status(500).json({ success: false, message: '테스트 알람 전송 중 오류가 발생했습니다.' });
  }
});

// 로그 초기화 API 추가
app.post('/api/logs/clear', (req, res) => {
  logBuffer = [];
  broadcastLog('🧹 콘솔이 지워졌습니다.');
  res.json({ success: true });
});

// 정적 파일 제공
app.use(express.static(path.join(root, 'public')));
app.use('/reports', express.static(reportsDir));
app.use('/logs', express.static(logsDir));

// 연결 정리 - 더 자주
setInterval(() => {
  // 죽은 연결 정리
  const deadState = [];
  const deadLog = [];
  
  for (const client of stateClients) {
    if (client.destroyed || client.finished) {
      deadState.push(client);
    }
  }
  
  for (const client of logClients) {
    if (client.destroyed || client.finished) {
      deadLog.push(client);
    }
  }
  
  deadState.forEach(client => stateClients.delete(client));
  deadLog.forEach(client => logClients.delete(client));
  
  if (deadState.length > 0 || deadLog.length > 0) {
    console.log(`[SSE] 정리: ${deadState.length} state + ${deadLog.length} log`);
  }
}, 10000); // 10초마다

cleanupOldReports();

const PORT = readCfg().site_port || 3000;
app.listen(PORT, '127.0.0.1', () => {  // localhost로 명시적 바인딩
  console.log(`[SERVER] 🚀 포트 ${PORT}에서 실행 중 (localhost)`);
  console.log(`[SERVER] 🌐 http://localhost:${PORT}`);
  console.log(`[SERVER] 📁 리포트: http://localhost:${PORT}/reports/`);
});