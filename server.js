// server.js (알람 시스템 개선 + 성능 최적화 버전)
import express from 'express';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import cron from 'node-cron';
import { sendTextMessage, sendFlexMessage, buildRunStatusFlex } from './alert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const root       = __dirname;

const app = express();
app.use(morgan('dev'));
app.use(express.json());

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
const state = { running: null };
const stateClients = new Set(); 
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

// 성능 최적화된 runJob 함수
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

  const args = ['newman', 'run', collection];
  if (environment) args.push('-e', environment);
  
  // 리포터 설정 최적화
  const reporterStr = reporters.map(r => {
    if (r === 'htmlextra') return `htmlextra --reporter-htmlextra-export ${htmlReport}`;
    if (r === 'junit') return `junit --reporter-junit-export ${junitReport}`;
    if (r === 'json') return `json --reporter-json-export ${jsonReport}`;
    if (r === 'cli') return 'cli --reporter-cli-no-summary --reporter-cli-no-failures --reporter-cli-no-assertions';
    return r;
  }).join(',');
  
  args.push('--reporters', reporterStr);
  if (job.extra?.length) args.push(...job.extra);

  console.log('[RUN]', args.join(' '));
  const proc = spawnNewmanCLI(args);

  // 성능 최적화된 로그 처리
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const FLUSH_INTERVAL = 100; // 100ms마다 플러시
  
  const flushStdout = () => {
    if (stdoutBuffer) {
      outStream.write(stdoutBuffer);
      const lines = stdoutBuffer.split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          broadcastLog(line);
        }
      });
      stdoutBuffer = '';
    }
  };
  
  const flushStderr = () => {
    if (stderrBuffer) {
      errStream.write(stderrBuffer);
      const lines = stderrBuffer.split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          broadcastLog(`[ERROR] ${line}`);
        }
      });
      stderrBuffer = '';
    }
  };

  // 버퍼링된 로그 처리
  proc.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString();
  });
  
  proc.stderr.on('data', chunk => {
    stderrBuffer += chunk.toString();
  });
  
  // 주기적으로 버퍼 플러시
  const flushTimer = setInterval(() => {
    flushStdout();
    flushStderr();
  }, FLUSH_INTERVAL);

  return new Promise(resolve => {
    proc.on('close', async (code) => {
      clearInterval(flushTimer);
      
      // 남은 버퍼 플러시
      flushStdout();
      flushStderr();
      
      const endTime = nowInTZString();
      const duration = Math.round((Date.now() - startTs) / 1000);
      
      outStream.end();
      errStream.end();

      // 히스토리 업데이트
      const hist = histRead();
      let summary = '';
      
      // JSON 리포트에서 요약 정보 추출
      if (fs.existsSync(jsonReport)) {
        try {
          const report = JSON.parse(fs.readFileSync(jsonReport, 'utf-8'));
          const stats = report.run?.stats;
          if (stats) {
            const failed = stats.assertions?.failed || 0;
            const total = stats.assertions?.total || 0;
            const requests = stats.requests?.total || 0;
            summary = failed > 0 ? 
              `실패: ${failed}/${total} assertions, ${requests} requests` :
              `성공: ${total} assertions, ${requests} requests`;
          }
        } catch {}
      }

      const entry = {
        timestamp: startTime,
        job: jobName,
        type: job.type,
        exitCode: code,
        duration,
        startTime,
        endTime,
        stdout: path.basename(stdoutPath),
        stderr: path.basename(stderrPath),
        report: fs.existsSync(htmlReport) ? htmlReport : null,
        summary
      };

      hist.push(entry);
      
      // 히스토리 크기 제한
      const { history_keep = 500 } = readCfg();
      if (hist.length > history_keep) {
        hist.splice(0, hist.length - history_keep);
      }
      
      histWrite(hist);
      
      // 상태 업데이트
      state.running = null;
      broadcastState({ running: null, last: entry });
      broadcastLog(`[END] ${jobName} - Exit Code: ${code}`);

      // 완료 알람 전송
      const alertData = {
        jobName,
        exitCode: code,
        duration,
        endTime,
        summary: summary || (code === 0 ? '성공' : '실패')
      };

      if (code === 0) {
        await sendAlert('success', alertData);
      } else {
        await sendAlert('error', {
          ...alertData,
          errorSummary: summary || `프로세스가 코드 ${code}로 종료됨`
        });
      }

      resolve({ started: true, exitCode: code });
      
      // 정리 작업
      setTimeout(cleanupOldReports, 5000);
    });

    proc.on('error', async (error) => {
      clearInterval(flushTimer);
      console.error('[RUN ERROR]', error);
      
      outStream.end();
      errStream.end();
      
      state.running = null;
      broadcastState({ running: null });
      broadcastLog(`[ERROR] ${jobName} - ${error.message}`);
      
      // 에러 알람 전송
      await sendAlert('error', {
        jobName,
        exitCode: -1,
        duration: Math.round((Date.now() - startTs) / 1000),
        endTime: nowInTZString(),
        errorSummary: error.message
      });
      
      resolve({ started: false, reason: error.message });
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