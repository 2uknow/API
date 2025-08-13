// server.js (알람 시스템 개선 버전 - 전체 소스)
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
  buildRunStatusFlex, 
  buildStatusText,
  getUrlInfo, 
  getConfigExamples,
  testWebhookConnection 
} from './alert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const root       = __dirname;

const app = express();

// 타임아웃 설정 (SSE 제외)
app.use((req, res, next) => {
  // SSE 엔드포인트는 타임아웃 제외
  if (req.url.startsWith('/api/stream/')) {
    return next();
  }
  
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      console.log('Request timeout:', req.url);
      res.status(408).json({ error: 'Request timeout' });
    }
  });
  next();
});

app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const cfgPath = path.join(root, 'config', 'settings.json');

function readCfg() {
  try { 
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); 
  } catch { 
    return { 
      site_port: 3001,  // 기본 포트를 3001로 변경
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

// SSE + history
const state = { running: null };
const stateClients = new Set(); 
const logClients = new Set();

function sseHeaders(res){ 
  res.writeHead(200, { 
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache',
    'Connection':'keep-alive' 
  }); 
  res.write('\n'); 
}

function broadcastState(payload){ 
  const data=`event: state\ndata: ${JSON.stringify(payload)}\n\n`; 
  for (const c of stateClients){ 
    try{c.write(data);}catch{} 
  } 
}

function broadcastLog(line){ 
  const data=`event: log\ndata: ${JSON.stringify({ line, at: Date.now() })}\n\n`; 
  for (const c of logClients){ 
    try{c.write(data);}catch{} 
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

// 개선된 알람 전송 함수
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
      // Flex 메시지 전송
      const flexData = buildRunStatusFlex(type, data);
      result = await sendFlexMessage(flexData);
    } else {
      // 텍스트 메시지 전송
      const message = buildStatusText(type, data);
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

// spawn
function spawnNewmanCLI(args){
  let cmd, argv;
  if (process.platform === 'win32'){ 
    cmd='cmd.exe'; 
    // npx 제거하고 newman 직접 사용 (버전 6.2.1)
    argv=['/d','/s','/c','newman', ...args.slice(1)]; 
  } else { 
    cmd='/bin/sh'; 
    argv=['-lc', ['newman', ...args.slice(1)].join(' ')]; 
  }
  
  console.log('[SPAWN] 명령어:', cmd);
  console.log('[SPAWN] 인자들:', argv);
  console.log('[SPAWN] 전체 명령어:', ['newman', ...args.slice(1)].join(' '));
  
  return spawn(cmd, argv, { cwd: root });
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
  // htmlextra를 첫 번째로 우선순위 설정
  const reporters   = job.reporters?.length ? job.reporters : ['htmlextra','cli','junit','json'];
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

  // 명령어 검증 로그
  console.log('[NEWMAN] HTML 리포트 경로:', htmlReport);
  console.log('[NEWMAN] 리포터 목록:', reporters.join(','));
  console.log('[NEWMAN] htmlextra 포함 여부:', reporters.includes('htmlextra'));
  
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
      
      // htmlextra 관련 에러 특별히 로깅
      if (s.includes('htmlextra') || s.includes('reporter') || s.includes('export')) {
        console.error('[HTMLEXTRA DEBUG]', s);
      }
      
      s.split(/\r?\n/).forEach(line => line && broadcastLog(line));
    });
    
    proc.on('close', async (code)=>{
      outStream.end(); 
      errStream.end();
      
      const endTime = nowInTZString();
      const duration = Math.round((Date.now() - startTs) / 1000);
      
      broadcastLog(`[DONE] exit=${code}`);
      
      // HTML 파일 생성 확인
      console.log('[NEWMAN] 실행 완료, HTML 파일 확인 중...');
      const htmlExists = fs.existsSync(htmlReport);
      console.log('[NEWMAN] HTML 파일 존재:', htmlExists);
      if (!htmlExists) {
        console.error('[NEWMAN] HTML 파일이 생성되지 않았습니다:', htmlReport);
        console.error('[NEWMAN] 에러 출력:', errorOutput.slice(-500)); // 마지막 500자만
      }

      // history 저장
      const history = histRead();
      const historyEntry = {
        timestamp: endTime,
        job: jobName,
        type: job.type,
        exitCode: code,
        summary: `cli=${path.basename(cliExport)}`,
        report: htmlReport,
        stdout: path.basename(stdoutPath),
        stderr: path.basename(stderrPath),
        tags: [],
        duration: duration
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
        reportPath: htmlReport  // 성공/실패 관계없이 리포트 경로 포함
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

// API: run job (동시 실행 방지 강화)
app.post('/api/run/:job', async (req,res)=>{
  const { job } = req.params;
  
  // 실행 중인 Job이 있는지 확인
  if (state.running) {
    return res.status(409).json({ 
      error: 'already_running',
      message: `이미 실행 중인 Job이 있습니다: ${state.running.job}`,
      runningJob: state.running
    });
  }
  
  const result = await runJob(job);
  if (!result.started) {
    const map = { 
      already_running: 409, 
      job_not_found: 404, 
      unsupported_type: 400, 
      collection_not_found: 400, 
      environment_not_found: 400,
      process_error: 500
    };
    
    const errorMessages = {
      already_running: '이미 실행 중인 Job이 있습니다',
      job_not_found: 'Job 파일을 찾을 수 없습니다',
      unsupported_type: '지원하지 않는 Job 타입입니다',
      collection_not_found: 'Postman 컬렉션 파일을 찾을 수 없습니다',
      environment_not_found: 'Environment 파일을 찾을 수 없습니다',
      process_error: '프로세스 실행 중 오류가 발생했습니다'
    };
    
    return res.status(map[result.reason] || 400).json({
      error: result.reason,
      message: errorMessages[result.reason] || '알 수 없는 오류가 발생했습니다',
      details: result.error || null
    });
  }
  res.json({ 
    success: true,
    message: `Job "${job}" 실행을 시작했습니다`,
    running: true,
    startTime: new Date().toISOString()
  });
});

// API: history/SSE
app.get('/api/history', (req,res)=>{
  try{
    const data=histRead();
    const page=parseInt(req.query.page||'1',10);
    const size=Math.min(parseInt(req.query.size||'50',10),500);
    const start=Math.max(data.length-page*size,0);
    const end=data.length-(page-1)*size;
    res.json({ total:data.length, page, size, items:data.slice(start,end), running: state.running });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

app.get('/api/stream/state', (req,res)=>{ 
  sseHeaders(res); 
  
  // 클라이언트 정보 저장
  const clientId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  console.log(`[SSE] 새 State 클라이언트 연결: ${clientId}`);
  
  stateClients.add(res); 
  const last=histRead().at(-1)||null; 
  res.write(`event: state\ndata: ${JSON.stringify({ running:state.running, last, clientId })}\n\n`); 
  
  req.on('close', () => {
    console.log(`[SSE] State 클라이언트 연결 해제: ${clientId}`);
    stateClients.delete(res);
  });
  
  req.on('error', () => {
    console.log(`[SSE] State 클라이언트 에러: ${clientId}`);
    stateClients.delete(res);
  });
});

app.get('/api/stream/logs', (req,res)=>{ 
  sseHeaders(res); 
  
  // 클라이언트 정보 저장
  const clientId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  console.log(`[SSE] 새 Log 클라이언트 연결: ${clientId}`);
  
  logClients.add(res); 
  
  req.on('close', () => {
    console.log(`[SSE] Log 클라이언트 연결 해제: ${clientId}`);
    logClients.delete(res);
  });
  
  req.on('error', () => {
    console.log(`[SSE] Log 클라이언트 에러: ${clientId}`);
    logClients.delete(res);
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
      const task=cron.schedule(cronExpr,()=>runJob(name),{scheduled:true}); 
      schedules.set(name,{cronExpr,task});
    }); 
  }catch{} 
}

function saveSchedules(){ 
  const arr=[...schedules.entries()].map(([name,{cronExpr}])=>({name,cronExpr})); 
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
      const {name,cronExpr}=JSON.parse(body||'{}'); 
      if(!name||!cronExpr) return res.status(400).json({message:'name/cronExpr 필요'}); 
      if(schedules.has(name)) schedules.get(name).task.stop(); 
      const task=cron.schedule(cronExpr,()=>runJob(name),{scheduled:true}); 
      schedules.set(name,{cronExpr,task}); 
      saveSchedules(); 
      res.json({ok:true}); 
    }catch(e){ 
      res.status(400).json({message:'invalid body'});
    } 
  });
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

    // 설정 업데이트
    if (typeof run_event_alert === 'boolean') config.run_event_alert = run_event_alert;
    if (typeof alert_on_start === 'boolean') config.alert_on_start = alert_on_start;
    if (typeof alert_on_success === 'boolean') config.alert_on_success = alert_on_success;
    if (typeof alert_on_error === 'boolean') config.alert_on_error = alert_on_error;
    if (alert_method && ['text', 'flex'].includes(alert_method)) config.alert_method = alert_method;

    // 설정 저장
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
    
    res.json({ success: true, message: '알람 설정이 업데이트되었습니다.' });
  } catch (error) {
    res.status(500).json({ success: false, message: `설정 업데이트 중 오류: ${error.message}` });
  }
});

// 알람 테스트 API
app.post('/api/alert/test', async (req, res) => {
  try {
    const { type = 'success' } = req.body;
    
    // 테스트 데이터 생성
    const testData = {
      jobName: `테스트-${type}`,
      collection: 'test-collection',
      environment: 'test-env',
      startTime: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      endTime: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      duration: 15,
      exitCode: type === 'error' ? 1 : 0,
      errorSummary: type === 'error' ? '테스트 에러입니다.\n이것은 샘플 에러 메시지입니다.' : null,
      reportPath: 'test-report.html' // 테스트용 리포트 경로
    };

    const config = readCfg();
    let result;
    
    if (config.alert_method === 'flex') {
      const flexData = buildRunStatusFlex(type, testData);
      result = await sendFlexMessage(flexData);
    } else {
      const textData = buildStatusText(type, testData);
      result = await sendTextMessage(textData);
    }
    
    if (result.ok) {
      res.json({ 
        success: true, 
        message: `${type} 테스트 알람이 전송되었습니다.`,
        url_info: getUrlInfo()
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: `알람 전송 실패: ${result.body}`,
        status: result.status
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: `테스트 알람 전송 중 오류: ${error.message}` 
    });
  }
});

// 연결 테스트 API
app.post('/api/alert/test-connection', async (req, res) => {
  try {
    const result = await testWebhookConnection();
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `연결 테스트 중 오류: ${error.message}`
    });
  }
});

// 디버깅 API들
app.get('/api/debug/urls', (req, res) => {
  try {
    const urlInfo = getUrlInfo();
    res.json({
      success: true,
      ...urlInfo,
      message: `현재 베이스 URL: ${urlInfo.baseUrl} (출처: ${urlInfo.source})`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/debug/config-examples', (req, res) => {
  try {
    const examples = getConfigExamples();
    res.json({
      success: true,
      examples,
      current_config: readCfg(),
      message: '다양한 배포 환경에 맞는 설정 예시들입니다.'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/debug/environment', (req, res) => {
  res.json({
    success: true,
    environment_variables: {
      BASE_URL: process.env.BASE_URL || null,
      NW_HOOK: process.env.NW_HOOK ? '설정됨' : null,
      NODE_ENV: process.env.NODE_ENV || 'development',
      TEXT_ONLY: process.env.TEXT_ONLY || null
    },
    current_config: readCfg(),
    computed_urls: getUrlInfo()
  });
});

// 현재 실행 상태 확인 API
app.get('/api/status/current', (req, res) => {
  res.json({
    running: state.running,
    isRunning: !!state.running,
    connectedClients: {
      state: stateClients.size,
      logs: logClients.size
    },
    timestamp: new Date().toISOString()
  });
});

// 상태 확인 API
app.get('/api/status/health', async (req, res) => {
  try {
    const config = readCfg();
    const urlInfo = getUrlInfo();
    
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      server: {
        port: config.site_port || 3000,
        timezone: config.timezone || 'Asia/Seoul',
        run_mode: config.run_mode || 'cli'
      },
      urls: urlInfo,
      alert: {
        webhook_configured: !!process.env.NW_HOOK || !!config.webhook_url,
        system_enabled: config.run_event_alert || false,
        method: config.alert_method || 'text',
        enabled_alerts: {
          start: config.alert_on_start || false,
          success: config.alert_on_success || false,
          error: config.alert_on_error || false
        }
      },
      directories: {
        reports: fs.existsSync(reportsDir),
        logs: fs.existsSync(logsDir),
        config: fs.existsSync(cfgPath)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'error',
      message: error.message
    });
  }
});

// 설정 업데이트 API (URL 설정 포함)
app.post('/api/config/update', (req, res) => {
  try {
    const config = readCfg();
    const { 
      base_url,
      domain, 
      use_https,
      site_port,
      webhook_url,
      run_event_alert, 
      alert_on_start, 
      alert_on_success, 
      alert_on_error, 
      alert_method 
    } = req.body;

    // URL 관련 설정 업데이트
    if (base_url !== undefined) {
      if (base_url === '') {
        delete config.base_url;
      } else {
        config.base_url = base_url;
      }
    }
    
    if (domain !== undefined) {
      if (domain === '') {
        delete config.domain;
      } else {
        config.domain = domain;
      }
    }
    
    if (typeof use_https === 'boolean') config.use_https = use_https;
    if (typeof site_port === 'number') config.site_port = site_port;
    if (webhook_url !== undefined) config.webhook_url = webhook_url;

    // 알람 설정 업데이트
    if (typeof run_event_alert === 'boolean') config.run_event_alert = run_event_alert;
    if (typeof alert_on_start === 'boolean') config.alert_on_start = alert_on_start;
    if (typeof alert_on_success === 'boolean') config.alert_on_success = alert_on_success;
    if (typeof alert_on_error === 'boolean') config.alert_on_error = alert_on_error;
    if (alert_method && ['text', 'flex'].includes(alert_method)) config.alert_method = alert_method;

    // 설정 저장
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
    
    res.json({ 
      success: true, 
      message: '설정이 업데이트되었습니다.',
      new_config: config,
      url_info: getUrlInfo()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `설정 업데이트 중 오류: ${error.message}`
    });
  }
});

// 간단한 헬스체크 (즉시 응답)
app.get('/ping', (req, res) => {
  res.json({ status: 'pong', timestamp: Date.now() });
});

// 정적 파일 서빙 (public 폴더를 먼저 설정)
const publicDir = path.join(root, 'public');
app.use('/reports', express.static(reportsDir));
app.use('/logs', express.static(logsDir));

// public 폴더가 있으면 정적 파일 서빙 (기본 라우트보다 먼저)
if (fs.existsSync(publicDir)) {
  app.use('/', express.static(publicDir));
  console.log('✅ Public 폴더 서빙 설정:', publicDir);
} else {
  console.log('⚠️ Public 폴더가 없습니다:', publicDir);
}

// 기본 라우트 (public/index.html이 없을 때만 동작)
app.get('/', (req, res, next) => {
  const indexPath = path.join(publicDir, 'index.html');
  
  // public/index.html이 있으면 express.static이 처리하도록 넘김
  if (fs.existsSync(indexPath)) {
    return next();
  }
  
  // public/index.html이 없으면 JSON 응답
  res.json({
    status: 'OK',
    message: 'Danal External API Monitor 정상 작동 중',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    server: {
      port: readCfg().site_port || 3001,
      timezone: readCfg().timezone || 'Asia/Seoul'
    },
    endpoints: {
      jobs: '/api/jobs',
      history: '/api/history', 
      health: '/api/status/health',
      alerts: '/api/alert/config',
      debug: '/api/debug/urls'
    },
    links: {
      reports: '/reports',
      logs: '/logs'
    }
  });
});

// 404 핸들러
app.use((req, res, next) => {
  res.status(404).json({
    error: 'Not Found',
    message: `경로를 찾을 수 없습니다: ${req.url}`,
    availableEndpoints: [
      '/',
      '/api/jobs',
      '/api/history', 
      '/api/status/health',
      '/api/debug/urls',
      '/reports',
      '/logs'
    ]
  });
});

// 전역 에러 핸들러
app.use((error, req, res, next) => {
  console.error('[ERROR]', error);
  res.status(500).json({
    error: 'Internal Server Error',
    message: '서버 내부 오류가 발생했습니다.',
    timestamp: new Date().toISOString()
  });
});

// 스케줄 로드
try {
  console.log('🔍 스케줄 로딩 시도...');
  loadSchedules();
  console.log('✅ 스케줄 로딩 완료');
} catch (error) {
  console.error('❌ 스케줄 로딩 실패:', error.message);
}

// 서버 시작
const { site_port = 3001 } = readCfg();  // 기본 포트 3001로 변경
app.listen(site_port, () => {
  console.log(`[SITE] http://localhost:${site_port}`);
  console.log(`[ALERT] 알람 시스템 초기화 완료`);
});