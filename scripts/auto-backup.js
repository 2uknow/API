/**
 * 자동 백업 스크립트 (PM2 cron 용)
 *
 * config, jobs, logs/history.json, logs/history_backup 을 tar.gz 로 묶고,
 * reports 는 backups/reports_mirror/ 로 증분 동기화합니다.
 * 최근 BACKUP_KEEP 개의 압축본만 유지합니다 (mirror 는 영구 보존).
 *
 * 환경변수:
 *   BACKUP_DIR  : 백업 저장 경로 (기본: ./backups)
 *   BACKUP_KEEP : 유지할 압축본 개수 (기본: 1)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.resolve(__dirname, '..');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(projectDir, 'backups');
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP, 10) || 1;
const MIRROR_DIR = path.join(BACKUP_DIR, 'reports_mirror');

function nowKST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function formatDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function log(msg) {
  const ts = nowKST().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${ts}] [BACKUP] ${msg}`);
}

// ── reports 증분 동기화 (size + mtime 비교, 평탄 구조 가정) ──
function syncReportsIncremental(srcRoot, mirrorRoot) {
  fs.mkdirSync(mirrorRoot, { recursive: true });
  let copied = 0;
  let skipped = 0;

  for (const name of fs.readdirSync(srcRoot)) {
    const s = path.join(srcRoot, name);
    const srcStat = fs.statSync(s);
    if (srcStat.isDirectory()) continue;

    const d = path.join(mirrorRoot, name);
    if (fs.existsSync(d)) {
      const dStat = fs.statSync(d);
      // mtime은 FS 정밀도 차이를 감안해 2초 tolerance
      if (dStat.size === srcStat.size && Math.abs(dStat.mtimeMs - srcStat.mtimeMs) < 2000) {
        skipped++;
        continue;
      }
    }
    fs.copyFileSync(s, d);
    fs.utimesSync(d, srcStat.atime, srcStat.mtime);
    copied++;
  }

  return { copied, skipped };
}

function createBackup() {
  const timestamp = formatDate(nowKST());
  const backupName = `backup_${timestamp}`;
  const backupPath = path.join(BACKUP_DIR, backupName);

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  fs.mkdirSync(backupPath, { recursive: true });

  // ── 1. reports 증분 sync (압축 대상에서 분리) ──
  const reportsSrc = path.join(projectDir, 'reports');
  if (fs.existsSync(reportsSrc)) {
    const t0 = Date.now();
    const { copied, skipped } = syncReportsIncremental(reportsSrc, MIRROR_DIR);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`  reports 증분 sync: 신규/변경 ${copied}개, 스킵 ${skipped}개 (${elapsed}s)`);
  } else {
    log(`  스킵 (없음): reports`);
  }

  // ── 2. 압축 대상 복사 (작은 파일들만) ──
  const targets = [
    { src: 'config', type: 'dir' },
    { src: 'jobs', type: 'dir' },
    { src: path.join('logs', 'history.json'), type: 'file' },
    { src: path.join('logs', 'history_backup'), type: 'dir' },
  ];

  let totalFiles = 0;

  for (const target of targets) {
    const srcPath = path.join(projectDir, target.src);
    if (!fs.existsSync(srcPath)) {
      log(`  스킵 (없음): ${target.src}`);
      continue;
    }

    if (target.type === 'file') {
      const destDir = path.join(backupPath, path.dirname(target.src));
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.copyFileSync(srcPath, path.join(backupPath, target.src));
      totalFiles++;
      log(`  파일 복사: ${target.src}`);
    } else {
      const destPath = path.join(backupPath, target.src);
      copyDirSync(srcPath, destPath);
      const count = countFiles(destPath);
      totalFiles += count;
      log(`  폴더 복사: ${target.src} (${count}개 파일)`);
    }
  }

  // ── 3. tar.gz 압축 ──
  let compressed = false;
  try {
    const tarPath = `${backupPath}.tar.gz`;
    execSync(`tar -czf "${backupName}.tar.gz" "${backupName}"`, {
      cwd: BACKUP_DIR,
      timeout: 1800000,  // 30분
      stdio: 'pipe'
    });
    deleteDirSync(backupPath);
    const sizeMB = (fs.statSync(tarPath).size / (1024 * 1024)).toFixed(2);
    log(`  압축 완료: ${backupName}.tar.gz (${sizeMB}MB)`);
    compressed = true;
  } catch (e) {
    log(`  압축 실패 (폴더 백업 유지): ${e.message}`);
  }

  log(`백업 완료: ${totalFiles}개 파일, ${compressed ? '압축됨' : '폴더'}`);
  return true;
}

function cleanupOldBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;

  const entries = fs.readdirSync(BACKUP_DIR)
    .filter(name => name.startsWith('backup_'))
    .map(name => ({
      name,
      path: path.join(BACKUP_DIR, name),
      isDir: fs.statSync(path.join(BACKUP_DIR, name)).isDirectory(),
      mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const archives = entries.filter(e => !e.isDir && e.name.endsWith('.tar.gz'));
  const folders = entries.filter(e => e.isDir);

  // 1단계: tar.gz가 존재하는 폴더는 중복이므로 삭제
  for (const folder of folders) {
    const matchingArchive = `${folder.name}.tar.gz`;
    if (archives.some(a => a.name === matchingArchive)) {
      try {
        deleteDirSync(folder.path);
        log(`  중복 폴더 삭제 (압축본 존재): ${folder.name}`);
      } catch (e) {
        log(`  중복 폴더 삭제 실패: ${folder.name} - ${e.message}`);
      }
    }
  }

  // 2단계: 남은 항목 재조회
  const remaining = fs.readdirSync(BACKUP_DIR)
    .filter(name => name.startsWith('backup_'))
    .map(name => ({
      name,
      path: path.join(BACKUP_DIR, name),
      isDir: fs.statSync(path.join(BACKUP_DIR, name)).isDirectory(),
      mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const remainingArchives = remaining.filter(e => !e.isDir && e.name.endsWith('.tar.gz'));
  const remainingFolders = remaining.filter(e => e.isDir);

  // 3단계: 압축 파일 — 최근 BACKUP_KEEP개만 유지
  if (remainingArchives.length > BACKUP_KEEP) {
    const toDelete = remainingArchives.slice(BACKUP_KEEP);
    for (const item of toDelete) {
      try {
        fs.unlinkSync(item.path);
        log(`  오래된 압축 백업 삭제: ${item.name}`);
      } catch (e) {
        log(`  압축 백업 삭제 실패: ${item.name} - ${e.message}`);
      }
    }
    log(`압축 백업 정리: ${toDelete.length}개 삭제, ${BACKUP_KEEP}개 유지`);
  }

  // 4단계: 폴더 백업 (압축 실패한 경우만 남음) — 최근 BACKUP_KEEP개만 유지
  if (remainingFolders.length > BACKUP_KEEP) {
    const toDelete = remainingFolders.slice(BACKUP_KEEP);
    for (const item of toDelete) {
      try {
        deleteDirSync(item.path);
        log(`  오래된 폴더 백업 삭제: ${item.name}`);
      } catch (e) {
        log(`  폴더 백업 삭제 실패: ${item.name} - ${e.message}`);
      }
    }
    log(`폴더 백업 정리: ${toDelete.length}개 삭제, ${BACKUP_KEEP}개 유지`);
  }
}

function reportBackupStatus() {
  if (!fs.existsSync(BACKUP_DIR)) return;

  let backupTotal = 0;
  let backupCount = 0;

  for (const entry of fs.readdirSync(BACKUP_DIR)) {
    if (!entry.startsWith('backup_')) continue;
    const entryPath = path.join(BACKUP_DIR, entry);
    const stat = fs.statSync(entryPath);
    backupTotal += stat.isDirectory() ? getDirSize(entryPath) : stat.size;
    backupCount++;
  }

  const mirrorSize = fs.existsSync(MIRROR_DIR) ? getDirSize(MIRROR_DIR) : 0;
  const mirrorCount = fs.existsSync(MIRROR_DIR)
    ? fs.readdirSync(MIRROR_DIR).filter(n => fs.statSync(path.join(MIRROR_DIR, n)).isFile()).length
    : 0;

  const fmtMB = b => (b / (1024 * 1024)).toFixed(2);
  log(`압축본 현황: ${backupCount}개, 총 ${fmtMB(backupTotal)}MB, 유지 정책: 최근 ${BACKUP_KEEP}개`);
  log(`reports 미러: ${mirrorCount}개 파일, ${fmtMB(mirrorSize)}MB (영구 보존)`);
}

function getDirSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const stat = fs.statSync(p);
    size += stat.isDirectory() ? getDirSize(p) : stat.size;
  }
  return size;
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function deleteDirSync(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) {
      deleteDirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  }
  fs.rmdirSync(dir);
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) {
      count += countFiles(p);
    } else {
      count++;
    }
  }
  return count;
}

// 실행
log('=== 자동 백업 시작 ===');
log(`백업 경로: ${BACKUP_DIR}`);
log(`미러 경로: ${MIRROR_DIR}`);

try {
  createBackup();
  cleanupOldBackups();
  reportBackupStatus();
  log('=== 자동 백업 완료 ===');
} catch (e) {
  log(`백업 실패: ${e.message}`);
  console.error(e);
  process.exit(1);
}
