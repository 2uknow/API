// src/state/running-jobs.js — 런타임 상태 관리 (싱글톤) + Stale Job 자동 정리
// runId 기반 Map으로 동일 jobName 동시 실행 지원
import { broadcastState, broadcastLog, recentLogHistory, unmarkJobAsScheduled, scheduledJobNames } from '../utils/sse.js';

// SSE + history — Map<runId, { runId, jobName, startTime, startTs, type, proc }>
export const state = {
  running: null,
  runningJobs: new Map(),
  batchMode: false,
  scheduleQueue: []
};

// ★ Stale Job 감지 설정
const STALE_JOB_CHECK_INTERVAL = 60 * 1000;     // 1분마다 체크
const STALE_JOB_MAX_DURATION = 60 * 60 * 1000;  // 1시간 이상이면 stale로 판단

// runId 생성기 — 충돌 방지용 시퀀스 + 랜덤 suffix
let _runIdSeq = 0;
function genRunId() {
  _runIdSeq = (_runIdSeq + 1) % 1_000_000;
  return `run_${Date.now()}_${_runIdSeq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// 병렬 실행 관리 헬퍼 함수 — runId를 반환 (호출자가 unregister/finalize에 사용)
export function registerRunningJob(jobName, startTime, type = 'unknown', proc = null) {
  const runId = genRunId();
  state.runningJobs.set(runId, { runId, jobName, startTime, type, proc, startTs: Date.now() });
  state.running = { job: jobName, runId, startAt: startTime };
  broadcastRunningJobs();
  return runId;
}

// unregisterRunningJob — runId 우선 매치, 실패 시 jobName 매치(같은 이름 전체 제거: /api/stop, /reset-state 용도)
export function unregisterRunningJob(runIdOrName) {
  if (state.runningJobs.has(runIdOrName)) {
    state.runningJobs.delete(runIdOrName);
  } else {
    const toRemove = [];
    for (const [rid, info] of state.runningJobs) {
      if (info.jobName === runIdOrName) toRemove.push(rid);
    }
    for (const rid of toRemove) state.runningJobs.delete(rid);
  }

  if (state.runningJobs.size > 0) {
    const last = [...state.runningJobs.values()].pop();
    state.running = { job: last.jobName, runId: last.runId, startAt: last.startTime };
  } else {
    state.running = null;
  }
  broadcastRunningJobs();
}

export function broadcastRunningJobs() {
  const runningList = [];
  for (const [runId, info] of state.runningJobs) {
    runningList.push({
      runId,
      job: info.jobName,
      startAt: info.startTime,
      type: info.type,
      elapsed: Math.round((Date.now() - info.startTs) / 1000),
      fromSchedule: scheduledJobNames.has(info.jobName)
    });
  }
  broadcastState({ running: state.running, runningJobs: runningList });
}

// ★ Stale Job 감지 및 자동 정리 — runId 단위 정리, unmarkJobAsScheduled는 같은 이름 남은 게 없을 때만
function cleanupStaleJobs() {
  const now = Date.now();
  const staleEntries = [];

  for (const [runId, info] of state.runningJobs) {
    const elapsed = now - info.startTs;
    if (elapsed > STALE_JOB_MAX_DURATION) {
      staleEntries.push({ runId, info });
    }
  }

  for (const { runId, info } of staleEntries) {
    const elapsedMin = Math.round((now - info.startTs) / 60000);
    console.error(`[STALE_JOB] ★ Job "${info.jobName}" (runId=${runId}) 강제 종료 (${elapsedMin}분 경과, 최대 ${Math.round(STALE_JOB_MAX_DURATION / 60000)}분)`);

    if (info.proc && !info.proc.killed) {
      try {
        info.proc.kill('SIGTERM');
        console.log(`[STALE_JOB] Process killed for "${info.jobName}" (runId=${runId})`);
      } catch (e) {
        console.error(`[STALE_JOB] Failed to kill process for "${info.jobName}" (runId=${runId}): ${e.message}`);
      }
    }

    broadcastLog(`[STALE_JOB] ⏰ "${info.jobName}" 강제 종료 (${elapsedMin}분 경과)`, 'SYSTEM');

    state.runningJobs.delete(runId);

    // 같은 jobName의 다른 run이 남아있지 않을 때만 스케줄 해제
    const hasMoreWithSameName = [...state.runningJobs.values()].some(v => v.jobName === info.jobName);
    if (!hasMoreWithSameName) unmarkJobAsScheduled(info.jobName);
  }

  if (staleEntries.length > 0) {
    // state.running 재계산
    if (state.runningJobs.size > 0) {
      const last = [...state.runningJobs.values()].pop();
      state.running = { job: last.jobName, runId: last.runId, startAt: last.startTime };
    } else {
      state.running = null;
    }
    broadcastRunningJobs();
  }

  // 배치 모드가 켜져있는데 runningJobs가 비었으면 정리
  if (state.batchMode && state.runningJobs.size === 0) {
    console.log(`[STALE_JOB] Batch mode orphaned - resetting`);
    state.batchMode = false;
  }
}

const _staleJobTimer = setInterval(cleanupStaleJobs, STALE_JOB_CHECK_INTERVAL);
if (_staleJobTimer.unref) _staleJobTimer.unref();
console.log(`[STALE_JOB] Stale job detector started (check every ${STALE_JOB_CHECK_INTERVAL / 1000}s, max ${STALE_JOB_MAX_DURATION / 60000}min)`);

// 통합 Job 완료 처리 함수 — runId 우선, fallback으로 jobName 매치(최근 run)
export function finalizeJobCompletion(runIdOrName, exitCode, success = null) {
  return new Promise((resolve) => {
    let entry = state.runningJobs.get(runIdOrName);
    let runId = null;
    let jobName = runIdOrName;

    if (entry) {
      runId = runIdOrName;
      jobName = entry.jobName;
    } else {
      // jobName으로 들어왔을 가능성 — 같은 이름 중 가장 최근 run 선택(iter 순서는 삽입순)
      for (const [rid, info] of state.runningJobs) {
        if (info.jobName === runIdOrName) {
          runId = rid;
          entry = info;
          jobName = info.jobName;
        }
      }
    }

    console.log(`[FINALIZE] Starting job completion for ${jobName} (runId=${runId}), exitCode: ${exitCode}, success: ${success}`);

    broadcastLog(`[DONE] ${jobName} exit=${exitCode}`, 'SYSTEM');
    broadcastLog(`[EXECUTION_COMPLETE] ${jobName}`, 'SYSTEM');
    broadcastLog(`[JOB_FINISHED] ${jobName} with code ${exitCode}`, 'SYSTEM');

    console.log(`[FINALIZE] Before state reset - runningJobs:`, [...state.runningJobs.keys()]);

    if (runId) {
      state.runningJobs.delete(runId);
    }

    // state.running 갱신
    if (state.runningJobs.size > 0) {
      const last = [...state.runningJobs.values()].pop();
      state.running = { job: last.jobName, runId: last.runId, startAt: last.startTime };
    } else {
      state.running = null;
    }
    broadcastRunningJobs();

    // 같은 이름 run 남아있는지 확인
    const hasMoreWithSameName = [...state.runningJobs.values()].some(v => v.jobName === jobName);
    if (!hasMoreWithSameName) {
      unmarkJobAsScheduled(jobName);
    } else {
      console.log(`[FINALIZE] ${jobName}: 같은 이름의 다른 run이 ${[...state.runningJobs.values()].filter(v => v.jobName === jobName).length}개 남음 — scheduled 유지`);
    }

    console.log(`[FINALIZE] Job completion finalized for ${jobName} (runId=${runId}), remaining jobs:`, [...state.runningJobs.keys()]);

    setTimeout(() => {
      broadcastLog(`[HISTORY_UPDATE] ${jobName} completed`, 'SYSTEM');

      setTimeout(() => {
        if (runId && state.runningJobs.has(runId)) {
          console.log(`[FINALIZE] Final backup cleanup for ${jobName} (runId=${runId})`);
          state.runningJobs.delete(runId);
          broadcastRunningJobs();
        }
        console.log(`[FINALIZE] Completion process finished for ${jobName} (runId=${runId})`);

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
