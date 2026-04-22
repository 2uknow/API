// src/state/running-jobs.js — 런타임 상태 관리 (싱글톤) + Stale Job 자동 정리
import { broadcastState, broadcastLog, recentLogHistory, unmarkJobAsScheduled, scheduledJobNames } from '../utils/sse.js';

// SSE + history (최적화된 버전)
export const state = { 
  running: null,
  runningJobs: new Map(),
  batchMode: false,
  scheduleQueue: []
};

// ★ Stale Job 감지 설정
const STALE_JOB_CHECK_INTERVAL = 60 * 1000;     // 1분마다 체크
const STALE_JOB_MAX_DURATION = 60 * 60 * 1000;  // 1시간 이상이면 stale로 판단

// 병렬 실행 관리 헬퍼 함수
export function registerRunningJob(jobName, startTime, type = 'unknown', proc = null) {
  state.runningJobs.set(jobName, { startTime, type, proc, startTs: Date.now() });
  state.running = { job: jobName, startAt: startTime };
  broadcastRunningJobs();
}

export function unregisterRunningJob(jobName) {
  state.runningJobs.delete(jobName);
  if (state.runningJobs.size > 0) {
    const last = [...state.runningJobs.entries()].pop();
    state.running = { job: last[0], startAt: last[1].startTime };
  } else {
    state.running = null;
  }
  broadcastRunningJobs();
}

export function broadcastRunningJobs() {
  const runningList = [];
  for (const [name, info] of state.runningJobs) {
    runningList.push({ 
      job: name, 
      startAt: info.startTime, 
      type: info.type,
      elapsed: Math.round((Date.now() - info.startTs) / 1000),
      fromSchedule: scheduledJobNames.has(name)
    });
  }
  broadcastState({ running: state.running, runningJobs: runningList });
}

// ★ Stale Job 감지 및 자동 정리
function cleanupStaleJobs() {
  const now = Date.now();
  const staleJobs = [];
  
  for (const [name, info] of state.runningJobs) {
    const elapsed = now - info.startTs;
    if (elapsed > STALE_JOB_MAX_DURATION) {
      staleJobs.push({ name, elapsed, info });
    }
  }
  
  for (const { name, elapsed, info } of staleJobs) {
    const elapsedMin = Math.round(elapsed / 60000);
    console.error(`[STALE_JOB] ★ Job "${name}" 강제 종료 (${elapsedMin}분 경과, 최대 ${Math.round(STALE_JOB_MAX_DURATION / 60000)}분)`);
    
    // 프로세스가 있으면 kill 시도
    if (info.proc && !info.proc.killed) {
      try {
        info.proc.kill('SIGTERM');
        console.log(`[STALE_JOB] Process killed for "${name}"`);
      } catch (e) {
        console.error(`[STALE_JOB] Failed to kill process for "${name}": ${e.message}`);
      }
    }
    
    broadcastLog(`[STALE_JOB] ⏰ "${name}" 강제 종료 (${elapsedMin}분 경과)`, 'SYSTEM');
    unregisterRunningJob(name);
    unmarkJobAsScheduled(name);
  }
  
  // 배치 모드가 켜져있는데 runningJobs가 비었으면 정리
  if (state.batchMode && state.runningJobs.size === 0) {
    console.log(`[STALE_JOB] Batch mode orphaned - resetting`);
    state.batchMode = false;
  }
}

// Stale Job 감지 타이머 시작
const _staleJobTimer = setInterval(cleanupStaleJobs, STALE_JOB_CHECK_INTERVAL);
// Node.js 프로세스 종료를 막지 않도록 unref
if (_staleJobTimer.unref) _staleJobTimer.unref();
console.log(`[STALE_JOB] Stale job detector started (check every ${STALE_JOB_CHECK_INTERVAL / 1000}s, max ${STALE_JOB_MAX_DURATION / 60000}min)`);

// 통합 Job 완료 처리 함수
export function finalizeJobCompletion(jobName, exitCode, success = null) {
  return new Promise((resolve) => {
    console.log(`[FINALIZE] Starting job completion for ${jobName}, exitCode: ${exitCode}, success: ${success}`);
    
    broadcastLog(`[DONE] ${jobName} exit=${exitCode}`, 'SYSTEM');
    broadcastLog(`[EXECUTION_COMPLETE] ${jobName}`, 'SYSTEM');
    broadcastLog(`[JOB_FINISHED] ${jobName} with code ${exitCode}`, 'SYSTEM');
    
    console.log(`[FINALIZE] Before state reset - runningJobs:`, [...state.runningJobs.keys()]);
    unregisterRunningJob(jobName);
    unmarkJobAsScheduled(jobName); // 스케줄 Job 표시 해제
    
    console.log(`[FINALIZE] Job completion finalized for ${jobName}, remaining jobs:`, [...state.runningJobs.keys()]);
    
    setTimeout(() => {
      broadcastLog(`[HISTORY_UPDATE] ${jobName} completed`, 'SYSTEM');
      
      setTimeout(() => {
        if (state.runningJobs.has(jobName)) {
          console.log(`[FINALIZE] Final backup cleanup for ${jobName}`);
          unregisterRunningJob(jobName);
        }
        console.log(`[FINALIZE] Completion process finished for ${jobName}`);
        
        // 작업 완료 후 스케줄 큐에 대기 중인 job 재처리
        if (state.scheduleQueue.length > 0 && state._processScheduleQueue) {
          setTimeout(() => state._processScheduleQueue(), 2000);
        }
        
        // 모든 Job이 완료되면 로그 히스토리 초기화
        if (state.runningJobs.size === 0) {
          recentLogHistory.length = 0;
          console.log(`[FINALIZE] All jobs done - log history cleared`);
        }
        
        resolve();
      }, 50);
    }, 100);
  });
}
