/**
 * 전체 수동 백업 스크립트
 *
 * config, jobs, reports, logs/history.json, logs/history_backup,
 * logs/history_daily 를 tar.gz 로 압축 백업합니다.
 *
 * 사용법:
 *   node scripts/full-backup.js
 *
 * 환경변수:
 *   BACKUP_DIR  : 백업 저장 경로 (기본: ./backups)
 *   BACKUP_KEEP : 유지할 백업 개수 (기본: 3)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const projectDir = path.resolve(__dirname, '..');

const BACKUP_DIR  = process.env.BACKUP_DIR  || path.join(projectDir, 'backups');
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP, 10) || 3;

function nowKST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function formatDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function log(msg) {
  const ts = nowKST().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] [FULL_BACKUP] ${msg}`);
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

// ── 1. 스테이징 폴더 생성 + 파일/폴더 복사 ──
function createBackup(timestamp) {
  const name      = `backup_${timestamp}`;
  const stagePath = path.join(BACKUP_DIR, name);
  fs.mkdirSync(stagePath, { recursive: true });

  const targets = [
    { src: 'config',                          type: 'dir'  },
    { src: 'jobs',                            type: 'dir'  },
    { src: 'reports',                         type: 'dir'  },
    { src: path.join('logs', 'history.json'), type: 'file' },
    { src: path.join('logs', 'history_backup'), type: 'dir' },
    { src: path.join('logs', 'history_daily'), type: 'dir' },
  ];

  let totalFiles = 0;
  for (const t of targets) {
    const srcPath = path.join(projectDir, t.src);
    if (!fs.existsSync(srcPath)) { log(`  스킵 (없음): ${t.src}`); continue; }

    if (t.type === 'file') {
      const destDir = path.join(stagePath, path.dirname(t.src));
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(srcPath, path.join(stagePath, t.src));
      totalFiles++;
      log(`  파일 복사: ${t.src}`);
    } else {
      const destPath = path.join(stagePath, t.src);
      copyDirSync(srcPath, destPath);
      const n = countFiles(destPath);
      totalFiles += n;
      log(`  폴더 복사: ${t.src} (${n}개 파일)`);
    }
  }

  log(`스테이징 완료: ${totalFiles}개 파일`);
  return stagePath;
}

// ── 2. tar.gz 압축 ──
function compress(stagePath) {
  const name    = path.basename(stagePath);
  const tarPath = path.join(BACKUP_DIR, `${name}.tar.gz`);
  try {
    execSync(`tar -czf "${name}.tar.gz" "${name}"`, {
      cwd: BACKUP_DIR,
      timeout: 1800000, // 30분
      stdio: 'pipe',
    });
    deleteDirSync(stagePath);
    const sizeMB = (fs.statSync(tarPath).size / (1024 * 1024)).toFixed(2);
    log(`압축 완료: ${name}.tar.gz (${sizeMB}MB)`);
    return true;
  } catch (e) {
    log(`압축 실패 (폴더 백업 유지): ${e.message}`);
    return false;
  }
}

// ── 3. 오래된 백업 정리 ──
function cleanup() {
  const entries = fs.readdirSync(BACKUP_DIR)
    .filter(n => n.startsWith('backup_'))
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
    if (archives.some(a => a.name === `${folder.name}.tar.gz`)) {
      try { deleteDirSync(folder.full); log(`  중복 폴더 삭제: ${folder.name}`); } catch (_) {}
    }
  }

  // 최신 BACKUP_KEEP 개만 유지
  const remaining = fs.readdirSync(BACKUP_DIR)
    .filter(n => n.startsWith('backup_'))
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
  if (toDelete.length > 0) log(`정리: ${toDelete.length}개 삭제, ${BACKUP_KEEP}개 유지`);
}

// ── 4. 현황 출력 ──
function reportStatus() {
  const items = fs.readdirSync(BACKUP_DIR).filter(n => n.startsWith('backup_'));
  let totalBytes = 0;
  for (const n of items) {
    const p = path.join(BACKUP_DIR, n);
    const stat = fs.statSync(p);
    totalBytes += stat.isDirectory() ? 0 : stat.size;
  }
  log(`현재 백업 현황: ${items.length}개, 총 ${(totalBytes / (1024 * 1024)).toFixed(2)}MB, 유지 정책: 최근 ${BACKUP_KEEP}개`);
}

// ── 실행 ──
log('=== 전체 수동 백업 시작 ===');
log(`백업 경로: ${BACKUP_DIR}`);
log(`유지 개수: ${BACKUP_KEEP}개`);

try {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts        = formatDate(nowKST());
  const stagePath = createBackup(ts);
  compress(stagePath);
  cleanup();
  reportStatus();
  log('=== 전체 수동 백업 완료 ===');
} catch (e) {
  log(`백업 실패: ${e.message}`);
  console.error(e);
  process.exit(1);
}
