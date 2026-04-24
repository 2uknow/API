// src/services/history-service.js — 히스토리 읽기/쓰기 (인메모리 캐시 + 디바운스 flush)
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { root } from '../utils/config.js';

const HIST_PATH = path.join(root, 'logs', 'history.json');
const BACKUP_DIR = path.join(root, 'logs', 'history_backup');
const DEBOUNCE_MS = 2000;

let _cache = null;           // 인메모리 캐시 (null = 아직 로드 안 됨)
let _flushTimer = null;      // 디바운스 타이머
let _flushing = false;       // 비동기 flush 진행 중 플래그
let _lastFlushedLength = 0;  // 마지막 디스크 flush 시 길이 (데이터 감소 감지용)
let _exitFlushed = false;    // 종료 시 중복 flush 방지

// ── 백업 복구 ──
async function _tryRecoverFromBackup() {
  try {
    const files = await fsPromises.readdir(BACKUP_DIR);
    const backups = files.filter(f => f.endsWith('.json')).sort().reverse();
    for (const bkFile of backups) {
      try {
        const content = (await fsPromises.readFile(path.join(BACKUP_DIR, bkFile), 'utf-8')).trim();
        if (!content) continue;
        const arr = JSON.parse(content);
        if (Array.isArray(arr) && arr.length > 0) {
          console.log(`[HIST_RECOVER] 백업에서 복구 성공: ${bkFile} (${arr.length}건)`);
          return arr;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function _tryRecoverFromBackupSync() {
  try {
    const files = fs.readdirSync(BACKUP_DIR);
    const backups = files.filter(f => f.endsWith('.json')).sort().reverse();
    for (const bkFile of backups) {
      try {
        const content = fs.readFileSync(path.join(BACKUP_DIR, bkFile), 'utf-8').trim();
        if (!content) continue;
        const arr = JSON.parse(content);
        if (Array.isArray(arr) && arr.length > 0) {
          console.log(`[HIST_RECOVER] 백업에서 동기 복구 성공: ${bkFile} (${arr.length}건)`);
          return arr;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// ── 디스크에서 로드 ──
function _loadFromDiskSync() {
  if (!fs.existsSync(HIST_PATH)) return [];
  try {
    const content = fs.readFileSync(HIST_PATH, 'utf-8').trim();
    if (!content) return [];
    return JSON.parse(content);
  } catch (e) {
    console.error(`[HIST_INIT] history.json 파싱 실패: ${e.message}`);
    const recovered = _tryRecoverFromBackupSync();
    if (recovered) {
      try {
        const tmpPath = HIST_PATH + '.recovery.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(recovered, null, 2));
        fs.renameSync(tmpPath, HIST_PATH);
        console.log(`[HIST_INIT] history.json 복원 완료`);
      } catch (restoreErr) {
        console.error(`[HIST_INIT] history.json 복원 실패: ${restoreErr.message}`);
      }
      return recovered;
    }
    return [];
  }
}

async function _loadFromDiskAsync() {
  try {
    const content = (await fsPromises.readFile(HIST_PATH, 'utf-8')).trim();
    if (!content) return [];
    return JSON.parse(content);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.error(`[HIST_INIT] history.json 파싱 실패 (async): ${e.message}`);
    const recovered = await _tryRecoverFromBackup();
    if (recovered) {
      try {
        const tmpPath = HIST_PATH + '.recovery.tmp';
        await fsPromises.writeFile(tmpPath, JSON.stringify(recovered, null, 2));
        await fsPromises.rename(tmpPath, HIST_PATH);
        console.log(`[HIST_INIT] history.json 복원 완료`);
      } catch (restoreErr) {
        console.error(`[HIST_INIT] history.json 복원 실패: ${restoreErr.message}`);
      }
      return recovered;
    }
    return [];
  }
}

// ── 캐시 초기화 (최초 접근 시 동기 lazy-load) ──
function _ensureCache() {
  if (_cache !== null) return;
  _cache = _loadFromDiskSync();
  _lastFlushedLength = _cache.length;
  console.log(`[HIST_CACHE] 캐시 초기화 완료 (sync): ${_cache.length}건`);
}

// ── 서버 시작 시 비동기 초기화 (server.js에서 호출 권장) ──
export async function initHistoryCache() {
  if (_cache !== null) return;
  _cache = await _loadFromDiskAsync();
  _lastFlushedLength = _cache.length;
  console.log(`[HIST_CACHE] 캐시 초기화 완료: ${_cache.length}건`);
}

// ── 디스크 flush 스케줄 (디바운스) ──
function _scheduleDiskFlush() {
  if (_flushTimer !== null) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => { _flushToDisk(); }, DEBOUNCE_MS);
}

// ── 비동기 디스크 flush ──
async function _flushToDisk() {
  if (_flushing || _cache === null) return;
  _flushing = true;
  _flushTimer = null;

  let arr = _cache;

  // 데이터 감소 보호 (정상 운영 시엔 발생하지 않음 — 외부 파일 조작 방어)
  if (arr.length < _lastFlushedLength) {
    console.log(`[HIST_PROTECT] 데이터 감소 감지 (last: ${_lastFlushedLength}, now: ${arr.length})`);
    try {
      await fsPromises.mkdir(BACKUP_DIR, { recursive: true });
      const existing = await fsPromises.readFile(HIST_PATH, 'utf-8');
      const backupPath = path.join(BACKUP_DIR, `history_protect_${Date.now()}.json`);
      await fsPromises.writeFile(backupPath, existing);
      console.log(`[HIST_PROTECT] 보호 백업 생성: ${backupPath}`);

      const existingArr = JSON.parse(existing);
      const makeKey = (m) => `${m.timestamp}_${m.job}_${m.runId || ''}`;
      const keySet = new Set(arr.map(makeKey));
      const merged = [...arr];
      for (const item of existingArr) {
        const key = makeKey(item);
        if (!keySet.has(key)) { merged.push(item); keySet.add(key); }
      }
      arr = merged;
      _cache = merged;
      console.log(`[HIST_PROTECT] Merged: ${arr.length}건`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error(`[HIST_PROTECT] 기존 history 읽기 실패: ${e.message}`);
      }
    }
  }

  const tmpPath = HIST_PATH + `.tmp.${process.pid}.${Date.now()}`;
  try {
    const json = JSON.stringify(arr, null, 2);
    JSON.parse(json); // 유효성 검증
    await fsPromises.writeFile(tmpPath, json);
    await fsPromises.rename(tmpPath, HIST_PATH);
    _lastFlushedLength = arr.length;
  } catch (e) {
    console.error(`[HIST_WRITE] history.json 저장 실패: ${e.message}`);
    try { await fsPromises.unlink(tmpPath); } catch (_) {}
  } finally {
    _flushing = false;
    // flush 중에 새 항목이 추가됐으면 재스케줄
    if (_cache !== null && _cache.length > _lastFlushedLength) {
      _scheduleDiskFlush();
    }
  }
}

// ── 종료 시 동기 flush ──
function _flushSync() {
  if (_cache === null || _exitFlushed) return;
  _exitFlushed = true;
  if (_flushTimer !== null) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_cache.length === _lastFlushedLength) return; // 변경 없으면 생략
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const tmpPath = HIST_PATH + '.exit.tmp';
    const json = JSON.stringify(_cache, null, 2);
    JSON.parse(json);
    fs.writeFileSync(tmpPath, json);
    fs.renameSync(tmpPath, HIST_PATH);
    console.log(`[HIST_EXIT] 종료 시 동기 flush 완료: ${_cache.length}건`);
  } catch (e) {
    console.error(`[HIST_EXIT] 종료 시 동기 flush 실패: ${e.message}`);
  }
}

process.on('SIGINT', () => { _flushSync(); process.exit(0); });
process.on('SIGTERM', () => { _flushSync(); process.exit(0); });
process.on('exit', () => { _flushSync(); });

// ── 동기 읽기 (메모리에서 즉시 반환) ──
export function histRead() {
  _ensureCache();
  return _cache;
}

// ── 동기 쓰기 (캐시 갱신 + 디바운스 flush) ──
export function histWrite(arr) {
  _ensureCache();
  _cache = arr;
  _scheduleDiskFlush();
}

// ── 비동기 읽기 (메모리에서 즉시 반환) ──
export async function histReadAsync() {
  _ensureCache();
  return _cache;
}

// ── 비동기 쓰기 (캐시 갱신 + 디바운스 flush) ──
export async function histWriteAsync(arr) {
  _ensureCache();
  _cache = arr;
  _scheduleDiskFlush();
}

// ── 항목 추가 헬퍼 (job-runner.js에서 권장) ──
export async function histAppend(entry) {
  _ensureCache();
  _cache.push(entry);
  _scheduleDiskFlush();
}
