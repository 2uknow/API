/**
 * 백업 스크립트 공통 헬퍼
 *
 * scripts/auto-backup.js, full-backup.js, history-backup.js 에서 중복되던
 * fs 헬퍼와 KST 시간 포맷, 로거 팩토리를 한 곳에 모았다.
 */

import fs from 'fs';
import path from 'path';

export function nowKST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

export function formatDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function createLogger(prefix) {
  return function log(msg) {
    const ts = nowKST().toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${ts}] [${prefix}] ${msg}`);
  };
}

export function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    fs.statSync(s).isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
  }
}

export function deleteDirSync(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    fs.statSync(p).isDirectory() ? deleteDirSync(p) : fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

export function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

export function getDirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let size = 0;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    const stat = fs.statSync(p);
    size += stat.isDirectory() ? getDirSize(p) : stat.size;
  }
  return size;
}

// reports 증분 동기화 (size + mtime 비교, 평탄 구조 가정).
// mtime 은 FS 정밀도 차이를 감안해 2초 tolerance.
export function syncReportsIncremental(srcRoot, mirrorRoot) {
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
