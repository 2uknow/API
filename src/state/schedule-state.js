// src/state/schedule-state.js — 스케줄 실행 Job 추적 (프론트엔드 실시간 로그 필터링용)
// sse.js에서 분리: SSE 통신과 무관한 state 성격이므로 state 레이어로 이동.

export const scheduledJobNames = new Set();

export function markJobAsScheduled(jobName) {
  scheduledJobNames.add(jobName);
  console.log(`[SSE] Marked job as scheduled (log suppressed): ${jobName}`);
}

export function unmarkJobAsScheduled(jobName) {
  scheduledJobNames.delete(jobName);
  console.log(`[SSE] Unmarked scheduled job: ${jobName}`);
}
