// server.js (알람 시스템 개선 버전)
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

app.get('/api/stream/state', (req,res)=>{ 
  sseHeaders(res); 
  stateClients.add(res); 
  const last=histRead().at(-1)||null; 
  res.write(`event: state\ndata: ${JSON.stringify({ running:state.running, last })}\n\n`); 
  req.on('close',()=>stateClients.delete(res)); 
});

app.get('/api/stream/logs', (req,res)=>{ 
  sseHeaders(res); 
  logClients.add(res); 
  req.on('close',()=>logClients.delete(res)); 
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
        reportPath: htmlReport
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

app.post('/api/run/:job', async (req,res)=>{
  const { job } = req.params;
  const result = await runJob(job);
  if (!result.started) {
    const map = { 
      already_running:409, 
      job_not_found:404, 
      unsupported_type:400, 
      collection_not_found:400, 
      environment_not_found:400,
      process_error:500
    };
    return res.status(map[result.reason] || 400).json(result);
  }
  res.json({ message:`실행 시작: ${job}`, running: true });
});

// 알람 설정 API 추가
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
    res.status(500).json({ success: false, message: error.message });
  }
});

// 테스트 알람 전송 API
app.post('/api/alert/test', async (req, res) => {
  try {
    const { type = 'success' } = req.body;
    
    const testData = {
      jobName: 'TEST_JOB',
      startTime: nowInTZString(),
      endTime: nowInTZString(),
      duration: 5,
      exitCode: type === 'success' ? 0 : 1,
      collection: 'test.postman_collection.json',
      environment: 'test.postman_environment.json',
      errorSummary: type === 'error' ? '테스트 에러 메시지입니다.' : null
    };

    await sendAlert(type, testData);
    
    res.json({ success: true, message: `${type} 테스트 알람이 전송되었습니다.` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 진단용 API
app.post('/api/diagnose/webhook-flex', async (req, res) => {
  try{
    const event = (req.query.event || '').toLowerCase();
    if (event !== 'success') return res.json({ ok:true, status:200, body:'event filtered' });

    const flexMessage = {
      content: {
        type: 'flex',
        altText: '🔔 정기 시세 리포트 (변동기준: ±0.9%)',
        contents: {
          type: 'bubble',
          size: 'mega',
          header: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type:'text', text:'🔔 정기 시세 리포트', weight:'bold', size:'lg', color:'#FFFFFF' },
              { type:'text', text:'변동기준: ±0.9%', size:'sm', color:'#E0E0E0' }
            ],
            backgroundColor:'#0E71EB',
            paddingAll:'15px'
          },
          body: {
            type:'box', layout:'vertical', spacing:'md',
            contents: [
              { type:'text', text:'🟢 페이코인: 121원 (리포트: +0.83%)', wrap:true, size:'sm', color:'#222222' },
              { type:'text', text:'🔻 다날: 7,740원 (리포트: -1.65%, 시가: -1.65%)', wrap:true, size:'sm', color:'#222222' },
              { type:'text', text:'🔴 비트코인: 163,856,000원 (리포트: -0.08%, 시가: -0.27%)', wrap:true, size:'sm', color:'#222222' },
              { type:'text', text:'🟢 이더리움: 5,920,000원 (리포트: +0.37%, 시가: +1.32%)', wrap:true, size:'sm', color:'#222222' },
              { type:'text', text:'🟢 리플: 4,351원 (리포트: +0.23%, 시가: +0.44%)', wrap:true, size:'sm', color:'#222222' },
              { type:'separator', margin:'md' },
              { type:'text', text:'⏰ 2025. 8. 12. 오후 1:30:00', size:'xs', color:'#888888', align:'end' }
            ]
          }
        }
      }
    };
    const r = await sendFlexMessage(flexMessage);
    res.status(r.ok ? 200 : 500).json(r);
  }catch(e){
    res.status(500).json({ ok:false, status:0, body:e.message });
  }
});

// 정적 파일 서빙
app.use('/reports', express.static(reportsDir));
app.use('/logs',    express.static(logsDir));
app.use('/',        express.static(path.join(root, 'public')));

// 기본 라우트
app.get('/', (req, res) => {
  res.sendFile(path.join(root, 'index.html'));
});

const { site_port = 3000 } = readCfg();
app.listen(site_port, () => {
  console.log(`[SITE] http://localhost:${site_port}`);
  console.log(`[ALERT] 알람 시스템 초기화 완료`);
});