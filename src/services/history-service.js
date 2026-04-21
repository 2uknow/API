// src/services/history-service.js — 히스토리 읽기/쓰기
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { root } from '../utils/config.js';

export function histRead(){
  const p=path.join(root,'logs','history.json');
  if(!fs.existsSync(p)) return [];
  try {
    const content = fs.readFileSync(p,'utf-8').trim();
    if(!content) return [];
    return JSON.parse(content);
  } catch(e) {
    console.error(`[HIST_READ] history.json 파싱 실패: ${e.message}`);
    return [];
  }
}

export function histWrite(arr){
  const p=path.join(root,'logs','history.json');
  const backupDir = path.join(root, 'logs', 'history_backup');

  // 백업 디렉토리 생성
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // 기존 파일이 있고 내용이 있으면 백업 (덮어쓰기 방지)
  if (fs.existsSync(p)) {
    try {
      const existing = fs.readFileSync(p, 'utf-8');
      const existingArr = JSON.parse(existing);

      // 기존 데이터가 있는데 새 데이터가 비어있거나 더 적으면 백업 후 병합
      if (existingArr.length > 0 && arr.length < existingArr.length) {
        const backupPath = path.join(backupDir, `history_backup_${Date.now()}.json`);
        fs.writeFileSync(backupPath, existing);
        console.log(`[HIST_PROTECT] Backup created: ${backupPath} (existing: ${existingArr.length}, new: ${arr.length})`);

        // 오래된 history 백업 정리 (최근 3개만 유지)
        try {
          const HISTORY_BACKUP_KEEP = 3;
          const backupFiles = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('history_backup_') && f.endsWith('.json'))
            .map(f => ({ name: f, path: path.join(backupDir, f), mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          if (backupFiles.length > HISTORY_BACKUP_KEEP) {
            for (const old of backupFiles.slice(HISTORY_BACKUP_KEEP)) {
              fs.unlinkSync(old.path);
              console.log(`[HIST_PROTECT] Old backup removed: ${old.name}`);
            }
          }
        } catch (cleanupErr) {
          console.error(`[HIST_PROTECT] Backup cleanup error: ${cleanupErr.message}`);
        }

        // 새 데이터와 기존 데이터 병합 (중복 제거)
        const merged = [...existingArr];
        for (const item of arr) {
          const exists = merged.some(m => m.timestamp === item.timestamp && m.job === item.job);
          if (!exists) {
            merged.push(item);
          }
        }
        arr = merged;
        console.log(`[HIST_PROTECT] Merged data: ${arr.length} items`);
      }
    } catch (e) {
      console.error(`[HIST_PROTECT] Error reading existing history: ${e.message}`);
    }
  }

  // 임시 파일에 먼저 쓰고 성공하면 원본 교체 (ENOSPC 시 원본 보호)
  const tmpPath = p + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(arr,null,2));
    fs.renameSync(tmpPath, p);
  } catch(e) {
    console.error(`[HIST_WRITE] history.json 저장 실패: ${e.message}`);
    try { fs.unlinkSync(tmpPath); } catch(_) {}
  }
}

// 비동기 히스토리 읽기 (이벤트 루프 블로킹 방지)
export async function histReadAsync() {
  const p = path.join(root, 'logs', 'history.json');
  try {
    await fsPromises.access(p);
    const content = (await fsPromises.readFile(p, 'utf-8')).trim();
    if (!content) return [];
    return JSON.parse(content);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    console.error(`[HIST_READ_ASYNC] history.json 파싱 실패: ${e.message}`);
    return [];
  }
}

// 비동기 히스토리 쓰기 (이벤트 루프 블로킹 방지)
export async function histWriteAsync(arr) {
  const p = path.join(root, 'logs', 'history.json');
  const backupDir = path.join(root, 'logs', 'history_backup');

  await fsPromises.mkdir(backupDir, { recursive: true });

  try {
    const existing = await fsPromises.readFile(p, 'utf-8');
    const existingArr = JSON.parse(existing);

    if (existingArr.length > 0 && arr.length < existingArr.length) {
      const backupPath = path.join(backupDir, `history_backup_${Date.now()}.json`);
      await fsPromises.writeFile(backupPath, existing);
      console.log(`[HIST_PROTECT] Backup created: ${backupPath} (existing: ${existingArr.length}, new: ${arr.length})`);

      try {
        const HISTORY_BACKUP_KEEP = 3;
        const backupFiles = (await fsPromises.readdir(backupDir))
          .filter(f => f.startsWith('history_backup_') && f.endsWith('.json'));
        const fileStats = await Promise.all(backupFiles.map(async f => {
          const fp = path.join(backupDir, f);
          const stat = await fsPromises.stat(fp);
          return { name: f, path: fp, mtime: stat.mtimeMs };
        }));
        fileStats.sort((a, b) => b.mtime - a.mtime);
        for (const old of fileStats.slice(HISTORY_BACKUP_KEEP)) {
          await fsPromises.unlink(old.path);
        }
      } catch (cleanupErr) {
        console.error(`[HIST_PROTECT] Backup cleanup error: ${cleanupErr.message}`);
      }

      const merged = [...existingArr];
      for (const item of arr) {
        const exists = merged.some(m => m.timestamp === item.timestamp && m.job === item.job);
        if (!exists) merged.push(item);
      }
      arr = merged;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[HIST_PROTECT] Error reading existing history: ${e.message}`);
    }
  }

  const tmpPath = p + '.tmp';
  try {
    await fsPromises.writeFile(tmpPath, JSON.stringify(arr, null, 2));
    await fsPromises.rename(tmpPath, p);
  } catch (e) {
    console.error(`[HIST_WRITE_ASYNC] history.json 저장 실패: ${e.message}`);
    try { await fsPromises.unlink(tmpPath); } catch (_) {}
  }
}
