/**
 * 자동 백업 스크립트 (PM2 cron 용)
 *
 * reports, logs/history.json, config, jobs 폴더를 날짜별로 백업합니다.
 * 백업은 삭제하지 않고 영구 보관합니다. (디스크 관리는 수동으로)
 *
 * 환경변수:
 *   BACKUP_DIR: 백업 저장 경로 (기본: ./backups)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.resolve(__dirname, '..');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(projectDir, 'backups');

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
    execSync(`tar -czf "${tarPath}" -C "${BACKUP_DIR}" "${backupName}"`, {
      timeout: 120000,
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
  log(`현재 백업 현황: ${count}개, 총 ${sizeMB}MB (${sizeGB}GB)`);

  if (totalSize > 10 * 1024 * 1024 * 1024) {
    log(`[경고] 백업 용량이 10GB를 초과했습니다. 수동으로 오래된 백업 정리를 권장합니다.`);
  }
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
  reportBackupStatus();
  log('=== 자동 백업 완료 ===');
} catch (e) {
  log(`백업 실패: ${e.message}`);
  console.error(e);
  process.exit(1);
}
