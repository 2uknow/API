/**
 * history 수동 백업 스크립트
 *
 * history.json + history_backup/ 를 날짜별로 압축 백업합니다.
 * server.js 의 새벽 3시 cron 과 동일한 로직을 수동으로 실행할 때 사용합니다.
 *
 * 사용법:
 *   node scripts/history-backup.js
 *
 * 환경변수:
 *   HIST_BACKUP_DIR  : 백업 저장 경로 (기본: ./logs/history_daily)
 *   HIST_BACKUP_KEEP : 유지할 백업 개수 (기본: 30)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const projectDir = path.resolve(__dirname, '..');

const BACKUP_DIR  = process.env.HIST_BACKUP_DIR  || path.join(projectDir, 'logs', 'history_daily');
const BACKUP_KEEP = parseInt(process.env.HIST_BACKUP_KEEP, 10) || 30;
const HIST_PATH   = path.join(projectDir, 'logs', 'history.json');
const HIST_BK_DIR = path.join(projectDir, 'logs', 'history_backup');

function nowKST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function formatDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function log(msg) {
  const ts = nowKST().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] [HIST_BACKUP] ${msg}`);
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    fs.statSync(s).isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
  }
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

function deleteDirSync(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    fs.statSync(p).isDirectory() ? deleteDirSync(p) : fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

// ── 1. history.json 존재 + JSON 유효성 검증 ──
function validateHistory() {
  if (!fs.existsSync(HIST_PATH)) {
    log('history.json 없음 — 백업 중단');
    process.exit(1);
  }
  try {
    const content = fs.readFileSync(HIST_PATH, 'utf-8').trim();
    const arr = JSON.parse(content);
    if (!Array.isArray(arr)) throw new Error('배열이 아님');
    log(`history.json 유효성 확인: ${arr.length}건`);
    return arr.length;
  } catch (e) {
    log(`history.json JSON 유효성 실패: ${e.message} — 백업 중단`);
    process.exit(1);
  }
}

// ── 2. 백업 폴더 생성 + 파일 복사 ──
function createBackupDir(timestamp) {
  const name     = `history_${timestamp}`;
  const stagePath = path.join(BACKUP_DIR, name);
  fs.mkdirSync(stagePath, { recursive: true });

  // history.json 복사
  const destFile = path.join(stagePath, 'history.json');
  fs.copyFileSync(HIST_PATH, destFile);
  log(`  history.json 복사 완료`);

  // history_backup/ 복사 (보호 백업 디렉토리)
  if (fs.existsSync(HIST_BK_DIR)) {
    const destBkDir = path.join(stagePath, 'history_backup');
    copyDirSync(HIST_BK_DIR, destBkDir);
    const n = countFiles(destBkDir);
    log(`  history_backup/ 복사 완료 (${n}개 파일)`);
  } else {
    log(`  history_backup/ 없음 — 생략`);
  }

  return stagePath;
}

// ── 3. tar.gz 압축 ──
function compress(stagePath) {
  const name    = path.basename(stagePath);
  const tarPath = stagePath + '.tar.gz';
  try {
    execSync(`tar -czf "${name}.tar.gz" "${name}"`, {
      cwd: BACKUP_DIR,
      timeout: 300000, // 5분
      stdio: 'pipe',
    });
    deleteDirSync(stagePath);
    const sizeMB = (fs.statSync(tarPath).size / (1024 * 1024)).toFixed(2);
    log(`  압축 완료: ${name}.tar.gz (${sizeMB}MB)`);
    return tarPath;
  } catch (e) {
    log(`  압축 실패 (폴더 백업 유지): ${e.message}`);
    return stagePath; // 폴더 형태로 남김
  }
}

// ── 4. 오래된 백업 정리 ──
function cleanup() {
  const entries = fs.readdirSync(BACKUP_DIR)
    .filter(n => n.startsWith('history_'))
    .map(n => ({
      name  : n,
      full  : path.join(BACKUP_DIR, n),
      isDir : fs.statSync(path.join(BACKUP_DIR, n)).isDirectory(),
      mtime : fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const archives = entries.filter(e => e.name.endsWith('.tar.gz'));
  const folders  = entries.filter(e => e.isDir);

  // 압축본이 있는 폴더는 중복 삭제
  for (const folder of folders) {
    if (archives.some(a => a.name === folder.name + '.tar.gz')) {
      try { deleteDirSync(folder.full); log(`  중복 폴더 삭제: ${folder.name}`); } catch (_) {}
    }
  }

  // 최신 N개만 유지
  const remaining = fs.readdirSync(BACKUP_DIR)
    .filter(n => n.startsWith('history_'))
    .map(n => ({ name: n, full: path.join(BACKUP_DIR, n), mtime: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = remaining.slice(BACKUP_KEEP);
  for (const item of toDelete) {
    try {
      item.full.endsWith('.tar.gz') ? fs.unlinkSync(item.full) : deleteDirSync(item.full);
      log(`  오래된 백업 삭제: ${item.name}`);
    } catch (e) {
      log(`  삭제 실패: ${item.name} — ${e.message}`);
    }
  }
  if (toDelete.length > 0) log(`정리 완료: ${toDelete.length}개 삭제, ${BACKUP_KEEP}개 유지`);
}

// ── 5. 현황 출력 ──
function reportStatus() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const items = fs.readdirSync(BACKUP_DIR).filter(n => n.startsWith('history_'));
  let totalBytes = 0;
  for (const n of items) {
    const p = path.join(BACKUP_DIR, n);
    const stat = fs.statSync(p);
    totalBytes += stat.isDirectory() ? 0 : stat.size;
  }
  const sizeMB = (totalBytes / (1024 * 1024)).toFixed(2);
  log(`현재 백업 현황: ${items.length}개, 총 ${sizeMB}MB, 유지 정책: 최근 ${BACKUP_KEEP}개`);
}

// ── 실행 ──
log('=== history 수동 백업 시작 ===');
log(`백업 경로: ${BACKUP_DIR}`);
log(`유지 개수: ${BACKUP_KEEP}개`);

try {
  validateHistory();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const timestamp = formatDate(nowKST());
  log(`백업 타임스탬프: ${timestamp}`);

  const stagePath = createBackupDir(timestamp);
  compress(stagePath);
  cleanup();
  reportStatus();
  log('=== history 수동 백업 완료 ===');
} catch (e) {
  log(`백업 실패: ${e.message}`);
  console.error(e);
  process.exit(1);
}
