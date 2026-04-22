/**
 * history 수동 백업 스크립트
 *
 * history.json + history_backup/ 를 타임스탬프별로 압축 백업합니다.
 * 오래된 백업을 삭제하지 않으며 무제한 누적됩니다.
 * server.js 새벽 3시 cron 과 동일한 로직을 수동으로 실행할 때 사용합니다.
 *
 * 사용법:
 *   node scripts/history-backup.js
 *
 * 환경변수:
 *   HIST_BACKUP_DIR : 백업 저장 경로 (기본: ./logs/history_daily)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const projectDir = path.resolve(__dirname, '..');

const BACKUP_DIR  = process.env.HIST_BACKUP_DIR || path.join(projectDir, 'logs', 'history_daily');
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
    const arr = JSON.parse(fs.readFileSync(HIST_PATH, 'utf-8').trim());
    if (!Array.isArray(arr)) throw new Error('배열이 아님');
    log(`history.json 유효성 확인: ${arr.length}건`);
    return arr.length;
  } catch (e) {
    log(`history.json JSON 유효성 실패: ${e.message} — 백업 중단`);
    process.exit(1);
  }
}

// ── 2. 스테이징 폴더 생성 + 파일 복사 ──
function stage(timestamp) {
  const name      = `history_${timestamp}`;
  const stagePath = path.join(BACKUP_DIR, name);
  fs.mkdirSync(stagePath, { recursive: true });

  fs.copyFileSync(HIST_PATH, path.join(stagePath, 'history.json'));
  log(`  history.json 복사 완료`);

  if (fs.existsSync(HIST_BK_DIR)) {
    copyDirSync(HIST_BK_DIR, path.join(stagePath, 'history_backup'));
    log(`  history_backup/ 복사 완료 (${countFiles(path.join(stagePath, 'history_backup'))}개 파일)`);
  }

  return stagePath;
}

// ── 3. tar.gz 압축 ──
function compress(stagePath) {
  const name = path.basename(stagePath);
  try {
    execSync(`tar -czf "${name}.tar.gz" "${name}"`, {
      cwd: BACKUP_DIR,
      timeout: 300000,
      stdio: 'pipe',
    });
    deleteDirSync(stagePath);
    const sizeMB = (fs.statSync(path.join(BACKUP_DIR, `${name}.tar.gz`)).size / (1024 * 1024)).toFixed(2);
    log(`  압축 완료: ${name}.tar.gz (${sizeMB}MB)`);
  } catch (e) {
    log(`  압축 실패 (폴더 백업 유지): ${e.message}`);
  }
}

const MAX_BACKUPS = 5;

// ── 4. 오래된 백업 삭제 (최신 MAX_BACKUPS개 유지) ──
function pruneOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(n => n.startsWith('history_') && n.endsWith('.tar.gz'))
    .sort();
  const toDelete = files.slice(0, -MAX_BACKUPS);
  for (const f of toDelete) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    log(`  오래된 백업 삭제: ${f}`);
  }
  if (toDelete.length === 0) log(`  삭제 없음 (${files.length}개 / 최대 ${MAX_BACKUPS}개)`);
}

// ── 5. 현황 출력 ──
function reportStatus() {
  const items = fs.readdirSync(BACKUP_DIR).filter(n => n.startsWith('history_') && n.endsWith('.tar.gz'));
  let totalBytes = 0;
  for (const n of items) {
    const p = path.join(BACKUP_DIR, n);
    totalBytes += fs.statSync(p).size;
  }
  log(`현재 백업 현황: ${items.length}개, 총 ${(totalBytes / (1024 * 1024)).toFixed(2)}MB`);
}

// ── 실행 ──
log('=== history 수동 백업 시작 ===');
log(`백업 경로: ${BACKUP_DIR}`);

try {
  validateHistory();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const ts        = formatDate(nowKST());
  const stagePath = stage(ts);
  compress(stagePath);
  pruneOldBackups();
  reportStatus();
  log('=== history 수동 백업 완료 ===');
} catch (e) {
  log(`백업 실패: ${e.message}`);
  console.error(e);
  process.exit(1);
}
