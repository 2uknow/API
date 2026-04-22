/**
 * 자동 백업 스크립트 (PM2 cron 용)
 *
 * reports, logs/history.json, config, jobs 폴더를 날짜별로 백업합니다.
 * 최근 3개 백업만 유지하고 오래된 백업은 자동 삭제합니다.
 *
 * 환경변수:
 *   BACKUP_DIR: 백업 저장 경로 (기본: ./backups)
 *   BACKUP_KEEP: 유지할 백업 개수 (기본: 3)
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

function createBackup() {
  const timestamp = formatDate(nowKST());
  const backupName = `backup_${timestamp}`;
  const backupPath = path.join(BACKUP_DIR, backupName);

  // 백업 디렉토리 생성
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  fs.mkdirSync(backupPath, { recursive: true });

  const targets = [
    { src: 'config', type: 'dir' },
    { src: 'jobs', type: 'dir' },
    { src: 'reports', type: 'dir' },
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

  // tar.gz 압축 (tar 사용 가능한 경우)
  let compressed = false;
  try {
    const tarPath = `${backupPath}.tar.gz`;
    execSync(`tar -czf "${backupName}.tar.gz" "${backupName}"`, {
      cwd: BACKUP_DIR,
      timeout: 1800000,  // 30분 (29만개+ 파일 압축 대응)
      stdio: 'pipe'
    });
    // 압축 성공 시 원본 폴더 삭제
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
    .sort((a, b) => b.mtime - a.mtime); // 최신순 정렬

  const archives = entries.filter(e => !e.isDir && e.name.endsWith('.tar.gz'));
  const folders = entries.filter(e => e.isDir);

  // 1단계: tar.gz가 존재하는 폴더는 중복이므로 무조건 삭제
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

  // 2단계: 남은 항목 재조회 (중복 폴더 삭제 후)
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

  let totalSize = 0;
  let count = 0;

  for (const entry of fs.readdirSync(BACKUP_DIR)) {
    const entryPath = path.join(BACKUP_DIR, entry);
    const stat = fs.statSync(entryPath);
    totalSize += stat.isDirectory() ? getDirSize(entryPath) : stat.size;
    count++;
  }

  const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
  const sizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2);
  log(`현재 백업 현황: ${count}개, 총 ${sizeMB}MB (${sizeGB}GB), 유지 정책: 최근 ${BACKUP_KEEP}개`);
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
