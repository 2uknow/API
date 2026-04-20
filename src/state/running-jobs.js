// src/state/running-jobs.js — 런타임 상태 관리 (싱글톤)
import { broadcastState, broadcastLog, recentLogHistory } from '../utils/sse.js';

// SSE + history (최적화된 버전)
export const state = { 
  running: null,
  runningJobs: new Map(),
  batchMode: false,
  scheduleQueue: [],
  processingQueue: false
};

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
      elapsed: Math.round((Date.now() - info.startTs) / 1000)
    });
  }
  broadcastState({ running: state.running, runningJobs: runningList });
}

// 통합 Job 완료 처리 함수
export function finalizeJobCompletion(jobName, exitCode, success = null) {
  return new Promise((resolve) => {
    console.log(`[FINALIZE] Starting job completion for ${jobName}, exitCode: ${exitCode}, success: ${success}`);
    
    broadcastLog(`[DONE] ${jobName} exit=${exitCode}`, 'SYSTEM');
    broadcastLog(`[EXECUTION_COMPLETE] ${jobName}`, 'SYSTEM');
    broadcastLog(`[JOB_FINISHED] ${jobName} with code ${exitCode}`, 'SYSTEM');
    
    console.log(`[FINALIZE] Before state reset - runningJobs:`, [...state.runningJobs.keys()]);
    unregisterRunningJob(jobName);
    
    console.log(`[FINALIZE] Job completion finalized for ${jobName}, remaining jobs:`, [...state.runningJobs.keys()]);
    
    setTimeout(() => {
      broadcastLog(`[HISTORY_UPDATE] ${jobName} completed`, 'SYSTEM');
      
      setTimeout(() => {
        if (state.runningJobs.has(jobName)) {
          console.log(`[FINALIZE] Final backup cleanup for ${jobName}`);
          unregisterRunningJob(jobName);
        }
        console.log(`[FINALIZE] Completion process finished for ${jobName}`);
        
        // 작업 완료 후 스케줄 큐 처리는 schedule-service에서 처리
        // processScheduleQueue는 server.js에서 연결
        if (state._onJobComplete) {
          setTimeout(() => state._onJobComplete(), 2000);
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
