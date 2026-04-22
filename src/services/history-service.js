// src/services/history-service.js — 히스토리 읽기/쓰기 (동시 쓰기 잠금 + 손상 복구)
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { root } from '../utils/config.js';

// ── 동시 쓰기 방지를 위한 비동기 뮤텍스 ──
let _writeLock = Promise.resolve();
const HISTORY_BACKUP_KEEP = 10; // 백업 보관 개수 증가 (데이터 복구 안전망)

function _acquireWriteLock() {
  let release;
  const prev = _writeLock;
  _writeLock = new Promise(resolve => { release = resolve; });
  return prev.then(() => release);
}

// ── 백업에서 history 복구 시도 ──
async function _tryRecoverFromBackup(backupDir) {
  try {
    const files = await fsPromises.readdir(backupDir);
    const backups = files
      .filter(f => f.startsWith('history_backup_') && f.endsWith('.json'))
      .sort()
      .reverse(); // 최신 순

    for (const bkFile of backups) {
      try {
        const bkPath = path.join(backupDir, bkFile);
        const content = (await fsPromises.readFile(bkPath, 'utf-8')).trim();
        if (!content) continue;
        const arr = JSON.parse(content);
        if (Array.isArray(arr) && arr.length > 0) {
          console.log(`[HIST_RECOVER] 백업에서 복구 성공: ${bkFile} (${arr.length}건)`);
          return arr;
        }
      } catch (_) {
        // 이 백업도 깨졌으면 다음 백업 시도
      }
    }
  } catch (_) {
    // backupDir 자체가 없으면 무시
  }
  return null;
}

function _tryRecoverFromBackupSync(backupDir) {
  try {
    const files = fs.readdirSync(backupDir);
    const backups = files
      .filter(f => f.startsWith('history_backup_') && f.endsWith('.json'))
      .sort()
      .reverse();

    for (const bkFile of backups) {
      try {
        const bkPath = path.join(backupDir, bkFile);
        const content = fs.readFileSync(bkPath, 'utf-8').trim();
        if (!content) continue;
        const arr = JSON.parse(content);
        if (Array.isArray(arr) && arr.length > 0) {
          console.log(`[HIST_RECOVER] 백업에서 동기 복구 성공: ${bkFile} (${arr.length}건)`);
          return arr;
        }
      } catch (_) {
        // 다음 백업 시도
      }
    }
  } catch (_) {}
  return null;
}

// ── 백업 정리 (최근 N개만 유지) ──
async function _cleanupBackups(backupDir) {
  try {
    const files = (await fsPromises.readdir(backupDir))
      .filter(f => f.startsWith('history_backup_') && f.endsWith('.json'));
    const fileStats = await Promise.all(files.map(async f => {
      const fp = path.join(backupDir, f);
      const stat = await fsPromises.stat(fp);
      return { name: f, path: fp, mtime: stat.mtimeMs };
    }));
    fileStats.sort((a, b) => b.mtime - a.mtime);
    for (const old of fileStats.slice(HISTORY_BACKUP_KEEP)) {
      await fsPromises.unlink(old.path);
      console.log(`[HIST_PROTECT] Old backup removed: ${old.name}`);
    }
  } catch (cleanupErr) {
    console.error(`[HIST_PROTECT] Backup cleanup error: ${cleanupErr.message}`);
  }
}

// ── 동기 읽기 ──
export function histRead() {
  const p = path.join(root, 'logs', 'history.json');
  const backupDir = path.join(root, 'logs', 'history_backup');
  if (!fs.existsSync(p)) return [];
  try {
    const content = fs.readFileSync(p, 'utf-8').trim();
    if (!content) return [];
    return JSON.parse(content);
  } catch (e) {
    console.error(`[HIST_READ] history.json 파싱 실패: ${e.message}`);
    // 백업에서 복구 시도
    const recovered = _tryRecoverFromBackupSync(backupDir);
    if (recovered) {
      console.log(`[HIST_READ] 백업 데이터 복구 완료 (${recovered.length}건), 원본 파일 복원 중...`);
      try {
        const tmpPath = p + '.recovery.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(recovered, null, 2));
        fs.renameSync(tmpPath, p);
        console.log(`[HIST_READ] history.json 복원 완료`);
      } catch (restoreErr) {
        console.error(`[HIST_READ] history.json 복원 실패: ${restoreErr.message}`);
      }
      return recovered;
    }
    return [];
  }
}

// ── 동기 쓰기 ──
export function histWrite(arr) {
  const p = path.join(root, 'logs', 'history.json');
  const backupDir = path.join(root, 'logs', 'history_backup');

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // 기존 파일이 있고 내용이 있으면 백업 (덮어쓰기 방지)
  if (fs.existsSync(p)) {
    try {
      const existing = fs.readFileSync(p, 'utf-8');
      const existingArr = JSON.parse(existing);

      // 매 쓰기마다 백업 생성 (데이터 안전)
      if (existingArr.length > 0) {
        const backupPath = path.join(backupDir, `history_backup_${Date.now()}.json`);
        fs.writeFileSync(backupPath, existing);
      }

      // 기존 데이터가 있는데 새 데이터가 더 적으면 병합
      if (existingArr.length > 0 && arr.length < existingArr.length) {
        console.log(`[HIST_PROTECT] 데이터 감소 감지 (existing: ${existingArr.length}, new: ${arr.length}), 병합 수행`);
        const merged = [...existingArr];
        for (const item of arr) {
          const exists = merged.some(m => m.timestamp === item.timestamp && m.job === item.job);
          if (!exists) merged.push(item);
        }
        arr = merged;
        console.log(`[HIST_PROTECT] Merged data: ${arr.length} items`);
      }
    } catch (e) {
      console.error(`[HIST_PROTECT] 기존 history 읽기 실패: ${e.message}`);
      // ★ 핵심 수정: 파싱 실패 시 백업에서 복구 후 병합
      const recovered = _tryRecoverFromBackupSync(backupDir);
      if (recovered && recovered.length > 0) {
        console.log(`[HIST_PROTECT] 백업에서 복구 후 병합 (복구: ${recovered.length}건, 신규: ${arr.length}건)`);
        const merged = [...recovered];
        for (const item of arr) {
          const exists = merged.some(m => m.timestamp === item.timestamp && m.job === item.job);
          if (!exists) merged.push(item);
        }
        arr = merged;
        console.log(`[HIST_PROTECT] 병합 완료: ${arr.length}건`);
      } else if (arr.length <= 1) {
        // 복구도 실패하고 새 데이터도 1건뿐이면 위험 → 기존 파일 보존
        console.error(`[HIST_PROTECT] ★ 복구 실패 + 신규 데이터 부족 → 쓰기 중단 (데이터 보호)`);
        return;
      }
    }
  }

  const tmpPath = p + '.tmp';
  try {
    const json = JSON.stringify(arr, null, 2);
    // 쓰기 전 JSON 유효성 검증
    JSON.parse(json);
    fs.writeFileSync(tmpPath, json);
    fs.renameSync(tmpPath, p);
  } catch (e) {
    console.error(`[HIST_WRITE] history.json 저장 실패: ${e.message}`);
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }

  // 백업 정리 (동기)
  try {
    const backupFiles = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('history_backup_') && f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(backupDir, f), mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of backupFiles.slice(HISTORY_BACKUP_KEEP)) {
      fs.unlinkSync(old.path);
    }
  } catch (_) {}
}

// ── 비동기 읽기 (이벤트 루프 블로킹 방지) ──
export async function histReadAsync() {
  const p = path.join(root, 'logs', 'history.json');
  const backupDir = path.join(root, 'logs', 'history_backup');
  try {
    await fsPromises.access(p);
    const content = (await fsPromises.readFile(p, 'utf-8')).trim();
    if (!content) return [];
    return JSON.parse(content);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.error(`[HIST_READ_ASYNC] history.json 파싱 실패: ${e.message}`);
    // ★ 핵심 수정: 파싱 실패 시 백업에서 복구
    const recovered = await _tryRecoverFromBackup(backupDir);
    if (recovered) {
      console.log(`[HIST_READ_ASYNC] 백업 데이터로 복구 완료 (${recovered.length}건), 원본 복원 중...`);
      try {
        const tmpPath = p + '.recovery.tmp';
        await fsPromises.writeFile(tmpPath, JSON.stringify(recovered, null, 2));
        await fsPromises.rename(tmpPath, p);
        console.log(`[HIST_READ_ASYNC] history.json 복원 완료`);
      } catch (restoreErr) {
        console.error(`[HIST_READ_ASYNC] history.json 복원 실패: ${restoreErr.message}`);
      }
      return recovered;
    }
    return [];
  }
}

// ── 비동기 쓰기 (뮤텍스 잠금 + 손상 복구) ──
export async function histWriteAsync(arr) {
  // ★ 핵심 수정: 동시 쓰기 방지 — 뮤텍스 잠금 획득
  const release = _acquireWriteLock();
  try {
    await _histWriteAsyncInternal(arr);
  } finally {
    release();
  }
}

async function _histWriteAsyncInternal(arr) {
  const p = path.join(root, 'logs', 'history.json');
  const backupDir = path.join(root, 'logs', 'history_backup');

  await fsPromises.mkdir(backupDir, { recursive: true });

  // 기존 데이터 읽기 + 보호
  try {
    const existing = await fsPromises.readFile(p, 'utf-8');
    const existingArr = JSON.parse(existing);

    // 매 쓰기마다 백업 생성
    if (existingArr.length > 0) {
      const backupPath = path.join(backupDir, `history_backup_${Date.now()}.json`);
      await fsPromises.writeFile(backupPath, existing);
    }

    // 데이터 감소 시 병합
    if (existingArr.length > 0 && arr.length < existingArr.length) {
      console.log(`[HIST_PROTECT] 데이터 감소 감지 (existing: ${existingArr.length}, new: ${arr.length}), 병합 수행`);
      const merged = [...existingArr];
      for (const item of arr) {
        const exists = merged.some(m => m.timestamp === item.timestamp && m.job === item.job);
        if (!exists) merged.push(item);
      }
      arr = merged;
      console.log(`[HIST_PROTECT] Merged data: ${arr.length} items`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[HIST_PROTECT] 기존 history 읽기 실패: ${e.message}`);
      // ★ 핵심 수정: 파싱 실패 시 백업에서 복구 후 병합
      const recovered = await _tryRecoverFromBackup(backupDir);
      if (recovered && recovered.length > 0) {
        console.log(`[HIST_PROTECT] 백업에서 복구 후 병합 (복구: ${recovered.length}건, 신규: ${arr.length}건)`);
        const merged = [...recovered];
        for (const item of arr) {
          const exists = merged.some(m => m.timestamp === item.timestamp && m.job === item.job);
          if (!exists) merged.push(item);
        }
        arr = merged;
        console.log(`[HIST_PROTECT] 병합 완료: ${arr.length}건`);
      } else if (arr.length <= 1) {
        // 복구도 실패하고 새 데이터도 1건뿐이면 위험 → 쓰기 중단
        console.error(`[HIST_PROTECT] ★ 복구 실패 + 신규 데이터 부족 → 쓰기 중단 (데이터 보호)`);
        return;
      }
    }
  }

  // ★ 핵심 수정: 고유 .tmp 파일명으로 충돌 방지
  const tmpPath = p + `.tmp.${process.pid}.${Date.now()}`;
  try {
    const json = JSON.stringify(arr, null, 2);
    // 쓰기 전 JSON 유효성 검증 (깨진 데이터 저장 방지)
    JSON.parse(json);
    await fsPromises.writeFile(tmpPath, json);
    await fsPromises.rename(tmpPath, p);
  } catch (e) {
    console.error(`[HIST_WRITE_ASYNC] history.json 저장 실패: ${e.message}`);
    try { await fsPromises.unlink(tmpPath); } catch (_) {}
  }

  // 백업 정리 (비동기)
  await _cleanupBackups(backupDir);
}
