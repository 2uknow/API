
import express from 'express';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import cron from 'node-cron';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const root       = __dirname;

const app = express();
app.use(morgan('dev'));
app.use(express.json());

const cfgPath = path.join(root, 'config', 'settings.json');
function readCfg() {
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); }
  catch { return { site_port: 3000, history_keep: 500, report_keep_days: 30, timezone: 'Asia/Seoul', run_mode:'cli' }; }
}
function nowInTZString(d = new Date()){
  const { timezone = 'Asia/Seoul' } = readCfg();
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  }).formatToParts(d);
  const g=t=>(parts.find(p=>p.type===t)?.value||'').padStart(2,'0');
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
}

const reportsDir = path.join(root, 'reports');
const logsDir    = path.join(root, 'logs');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
if (!fs.existsSync(logsDir))    fs.mkdirSync(logsDir,    { recursive: true });

const state = { running: null };
const stateClients = new Set();
const logClients   = new Set();
function sseHeaders(res){
  res.writeHead(200, { 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive' });
  res.write('\n');
}
function broadcastState(payload){
  const data = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of stateClients){ try{ c.write(data);}catch{} }
}
function broadcastLog(line){
  const data = `event: log\ndata: ${JSON.stringify({ line, at: Date.now() })}\n\n`;
  for (const c of logClients){ try{ c.write(data);}catch{} }
}

function histRead(){ const p=path.join(root,'logs','history.json'); return fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf-8')):[]; }
function histWrite(a){ const p=path.join(root,'logs','history.json'); fs.writeFileSync(p, JSON.stringify(a,null,2)); }
function cleanupOldReports(){
  const { report_keep_days=30 }=readCfg(); const max=report_keep_days*24*3600*1000; const now=Date.now();
  for(const f of fs.readdirSync(reportsDir)){const p=path.join(reportsDir,f); const st=fs.statSync(p); if(now-st.mtimeMs>max){try{fs.unlinkSync(p)}catch{}}}
}

app.get('/api/jobs',(req,res)=>{
  const dir = path.join(root,'jobs');
  try {
    if(!fs.existsSync(dir)){ console.error('[JOBS] dir missing:',dir); return res.json([]); }
    const files = fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
    console.log('[JOBS] scan dir =', dir, 'files =', files);
    const items=[];
    for(const f of files){
      try{
        const j = JSON.parse(fs.readFileSync(path.join(dir,f),'utf-8'));
        if(!j.name || !j.type){ console.warn('[JOBS] skip invalid:',f); continue; }
        items.push({
          file:f, name:j.name, type:j.type,
          collection:j.collection, environment:j.environment||null,
          reporters:j.reporters||['cli','htmlextra','junit','json'],
          extra:j.extra||[]
        });
      }catch(e){ console.error('[JOBS] parse error:', f, e.message); }
    }
    res.json(items);
  } catch(e){ console.error('[JOBS] error:', e); res.status(500).json({error:e.message}); }
});

app.get('/api/history',(req,res)=>{
  try{
    const data=histRead();
    const page=parseInt(req.query.page||'1',10);
    const size=Math.min(parseInt(req.query.size||'50',10),500);
    const start=Math.max(data.length-page*size,0);
    const end=data.length-(page-1)*size;
    res.json({ total:data.length, page, size, items:data.slice(start,end), running:state.running });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

app.get('/api/stream/state',(req,res)=>{
  sseHeaders(res); stateClients.add(res);
  const last = histRead().at(-1) || null;
  res.write(`event: state\ndata: ${JSON.stringify({ running: state.running, last })}\n\n`);
  req.on('close',()=> stateClients.delete(res));
});
app.get('/api/stream/logs',(req,res)=>{
  sseHeaders(res); logClients.add(res);
  req.on('close',()=> logClients.delete(res));
});

// schedule
const schedFile=path.join(root,'config','schedules.json');
const schedules=new Map();
function loadSchedules(){ if(!fs.existsSync(schedFile)) return; try{ const arr=JSON.parse(fs.readFileSync(schedFile,'utf-8')); arr.forEach(({name,cronExpr})=>{ const t=cron.schedule(cronExpr,()=>runJob(name),{scheduled:true}); schedules.set(name,{cronExpr:cronExpr,task:t}); }); }catch{} }
function saveSchedules(){ const arr=[...schedules.entries()].map(([name,{cronExpr}])=>({name,cronExpr})); fs.writeFileSync(schedFile, JSON.stringify(arr,null,2)); }
app.get('/api/schedule',(req,res)=> res.json([...schedules.entries()].map(([n,{cronExpr}])=>({name:n,cronExpr}))));
app.post('/api/schedule',(req,res)=>{
  let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
    try{
      const {name,cronExpr}=JSON.parse(body||'{}');
      if(!name||!cronExpr) return res.status(400).json({message:'name/cronExpr 필요'});
      if(schedules.has(name)) schedules.get(name).task.stop();
      const t=cron.schedule(cronExpr,()=>runJob(name),{scheduled:true});
      schedules.set(name,{cronExpr,task:t}); saveSchedules(); res.json({ok:true});
    }catch{ res.status(400).json({message:'invalid body'}); }
  });
});
app.delete('/api/schedule/:name',(req,res)=>{
  const it=schedules.get(req.params.name); if(it){ it.task.stop(); schedules.delete(req.params.name); saveSchedules(); }
  res.json({ok:true});
});
loadSchedules();

async function runJob(jobName){
  if(state.running) return { started:false, reason:'already_running' };
  const jobPath = path.join(root,'jobs', `${jobName}.json`);
  if(!fs.existsSync(jobPath)) return { started:false, reason:'job_not_found' };
  const job = JSON.parse(fs.readFileSync(jobPath,'utf-8'));
  if(job.type!=='newman') return { started:false, reason:'unsupported_type' };

  const { run_mode='cli' } = readCfg();
  const reporters = job.reporters?.length ? job.reporters : ['cli','htmlextra','junit','json'];

  const stamp = new Date().toISOString().replace(/[:T]/g,'_').replace(/\..+/,'');
  const htmlReport = path.join(reportsDir, `${jobName}_${stamp}.html`);
  const junitReport= path.join(reportsDir, `${jobName}_${stamp}.xml`);
  const jsonReport = path.join(reportsDir, `${jobName}_${stamp}.json`);
  const stdoutPath = path.join(logsDir,    `stdout_${jobName}_${stamp}.log`);
  const stderrPath = path.join(logsDir,    `stderr_${jobName}_${stamp}.log`);
  const cliExport  = path.join(logsDir,    `cli_${jobName}_${stamp}.txt`);

  const outStream = fs.createWriteStream(stdoutPath,{flags:'a'});
  const errStream = fs.createWriteStream(stderrPath,{flags:'a'});

  const collection  = path.resolve(root, job.collection);
  const environment = job.environment ? path.resolve(root, job.environment) : undefined;

  console.log('[API] run request:', jobName);
  console.log('  collection =', collection);
  console.log('  environment =', environment || '(none)');

  if(!fs.existsSync(collection))  { console.error('[API] collection not found:', collection); return { started:false, reason:'collection_not_found' }; }
  if(environment && !fs.existsSync(environment)) { console.error('[API] environment not found:', environment); return { started:false, reason:'environment_not_found' }; }

  state.running = { job: jobName, startAt: nowInTZString() };
  broadcastState({ running: state.running });
  broadcastLog(`[START] ${jobName}`);

  function saveHistory(code, failures=0, extra={}){
    const h=histRead();
    h.push({ timestamp: nowInTZString(), job: jobName, type: job.type, exitCode: code, summary: `failures=${failures}`, report: htmlReport, stdout: path.basename(stdoutPath), stderr: path.basename(stderrPath), ...extra });
    const { history_keep=500 }=readCfg(); if(h.length>history_keep) h.splice(0, h.length-history_keep);
    histWrite(h); cleanupOldReports();
  }

  return new Promise((resolve)=>{
    if((run_mode||'cli').toLowerCase()==='cli'){
      const args = ['newman','run', collection, '--verbose', '-r', reporters.join(','),
        '--reporter-htmlextra-export', htmlReport,
        '--reporter-junit-export',     junitReport,
        '--reporter-json-export',      jsonReport,
        '--reporter-cli-export',       cliExport];
      if(environment) args.push('-e', environment);
      if(Array.isArray(job.extra)) args.push(...job.extra);

      const npxBin = process.platform==='win32' ? 'npx.cmd' : 'npx';
      const proc = spawn(npxBin, args, { cwd: root });

      proc.stdout.on('data', d=>{ const s=d.toString(); outStream.write(s); s.split(/\r?\n/).forEach(line=> line && broadcastLog(line)); });
      proc.stderr.on('data', d=>{ const s=d.toString(); errStream.write(s); s.split(/\r?\n/).forEach(line=> line && broadcastLog(line)); });
      proc.on('close', code=>{
        outStream.end(); errStream.end();
        broadcastLog(`[DONE] exit=${code}`);
        // tags optional extraction removed for simplicity
        saveHistory(code, code===0?0:1, { summary:`cli=${path.basename(cliExport)}` });
        state.running=null; broadcastState({ running:null }); resolve({ started:true, code });
      });
    } else {
      // programmatic fallback removed to keep minimal; could be added if needed
      saveHistory(1,1,{ summary:'Unsupported run_mode in this build' });
      state.running=null; broadcastState({ running:null }); resolve({ started:false, code:1 });
    }
  });
}

app.post('/api/run/:job', async (req,res)=>{
  const { job } = req.params;
  const result = await runJob(job);
  if(!result.started){
    const map={already_running:409, job_not_found:404, unsupported_type:400, collection_not_found:404, environment_not_found:404};
    return res.status(map[result.reason]||400).json(result);
  }
  res.json({ message:`실행 시작: ${job}`, running:true });
});

// static
app.use('/reports', express.static(reportsDir));
app.use('/logs',    express.static(logsDir));
app.use('/',        express.static(path.join(root,'public')));

const { site_port=3000 } = readCfg();
app.listen(site_port, ()=> console.log(`[SITE] http://localhost:${site_port}`));
