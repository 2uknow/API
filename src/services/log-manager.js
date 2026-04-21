// src/services/log-manager.js — 로그 관리 (스플릿, 아카이브, 정리)
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { logsDir, reportsDir, readCfg } from '../utils/config.js';
import { nowInTZString } from '../utils/time.js';

const archiveDir = path.join(logsDir, 'archive');

// 압축이 필요한 로그 파일 패턴 (일별 스플릿되는 로그들)
const LOG_PATTERNS_TO_ARCHIVE = [
  /^stdout_.*\.log$/,
  /^stderr_.*\.log$/,
  /^batch_execution_\d{4}-\d{2}-\d{2}\.log$/,
  /^debug_batch_\d{4}-\d{2}-\d{2}\.log$/
];

// pm2-out.log 등 대용량 단일 로그 파일 일별 스플릿
export function splitLargeLogs() {
  const logFilesToSplit = ['pm2-out.log', 'pm2-error.log'];
  const today = nowInTZString().split(' ')[0]; // YYYY-MM-DD

  for (const logFile of logFilesToSplit) {
    const logPath = path.join(logsDir, logFile);
    if (!fs.existsSync(logPath)) continue;

    try {
      const stats = fs.statSync(logPath);
      const lastModified = new Date(stats.mtime);
      const lastModifiedDate = lastModified.toISOString().split('T')[0];

      // 파일이 10MB 이상이거나, 날짜가 바뀌었으면 스플릿
      const fileSizeMB = stats.size / (1024 * 1024);
      if (fileSizeMB > 10 || lastModifiedDate !== today) {
        const splitName = logFile.replace('.log', `_${lastModifiedDate}.log`);
        const splitPath = path.join(logsDir, splitName);

        // 기존 스플릿 파일이 없으면 이동
        if (!fs.existsSync(splitPath)) {
          fs.renameSync(logPath, splitPath);
          fs.writeFileSync(logPath, ''); // 빈 파일 생성
          console.log(`[LOG_SPLIT] ${logFile} -> ${splitName} (${fileSizeMB.toFixed(2)}MB)`);
        }
      }
    } catch (e) {
      console.error(`[LOG_SPLIT] Error splitting ${logFile}: ${e.message}`);
    }
  }
}

// 7일 이상 된 로그 파일 압축
export async function archiveOldLogs() {
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

  // archive 디렉토리 생성
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  try {
    const files = fs.readdirSync(logsDir);

    for (const file of files) {
      // 압축 대상 패턴인지 확인
      const isTarget = LOG_PATTERNS_TO_ARCHIVE.some(pattern => pattern.test(file));
      if (!isTarget) continue;

      // 이미 압축된 파일은 건너뜀
      if (file.endsWith('.gz') || file.endsWith('.zip')) continue;

      const filePath = path.join(logsDir, file);
      const stats = fs.statSync(filePath);

      // 7일 이상 된 파일만 압축
      if (stats.mtimeMs < sevenDaysAgo) {
        try {
          const { createGzip } = await import('zlib');
          const gzip = createGzip();
          const source = fs.createReadStream(filePath);
          const destPath = path.join(archiveDir, `${file}.gz`);
          const dest = fs.createWriteStream(destPath);

          await new Promise((resolve, reject) => {
            source.pipe(gzip).pipe(dest);
            dest.on('finish', resolve);
            dest.on('error', reject);
          });

          // 압축 완료 후 원본 삭제
          fs.unlinkSync(filePath);
          console.log(`[LOG_ARCHIVE] Archived: ${file} -> archive/${file}.gz`);
        } catch (e) {
          console.error(`[LOG_ARCHIVE] Error archiving ${file}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.error(`[LOG_ARCHIVE] Error reading logs directory: ${e.message}`);
  }
}

// 30일 이상 된 압축 파일 삭제
export function cleanupOldArchives() {
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

  if (!fs.existsSync(archiveDir)) return;

  try {
    const files = fs.readdirSync(archiveDir);
    for (const file of files) {
      const filePath = path.join(archiveDir, file);
      const stats = fs.statSync(filePath);

      if (stats.mtimeMs < thirtyDaysAgo) {
        fs.unlinkSync(filePath);
        console.log(`[LOG_CLEANUP] Deleted old archive: ${file}`);
      }
    }
  } catch (e) {
    console.error(`[LOG_CLEANUP] Error cleaning archives: ${e.message}`);
  }
}

export function cleanupOldReports(){
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

// 로그 관리 스케줄러 (매일 새벽 3시에 실행)
export function initLogManagement() {
  // 서버 시작 시 한 번 실행
  splitLargeLogs();
  archiveOldLogs();
  cleanupOldArchives();

  // 매일 새벽 3시에 실행
  cron.schedule('0 3 * * *', () => {
    console.log('[LOG_MGMT] Running daily log management...');
    splitLargeLogs();
    archiveOldLogs();
    cleanupOldArchives();
    console.log('[LOG_MGMT] Daily log management completed');
  }, {
    timezone: 'Asia/Seoul'
  });

  console.log('[LOG_MGMT] Log management scheduler initialized');
}
