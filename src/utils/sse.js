// src/utils/sse.js — SSE 헬퍼 (클라이언트 Set, broadcast 함수, 로그 버퍼)

// SSE 클라이언트 Set들 (싱글톤)
export const stateClients = new Set();
export const logClients = new Set();
export const unifiedClients = new Set();

// 로그 버퍼링을 위한 변수들
export let logBuffer = [];
export let broadcastTimeoutId = null;
export const BATCH_SIZE = 10;
export const BATCH_INTERVAL = 50;

// 최근 로그 히스토리 (신규 SSE 클라이언트에게 재전송용)
export const recentLogHistory = [];
export const MAX_LOG_HISTORY = 200;

// SSE 헤더 최적화
export function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Last-Event-ID',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'identity'
  });
  
  res.write('retry: 5000\n');
  res.write('event: connected\n');
  res.write('data: {"status":"connected","timestamp":' + Date.now() + '}\n\n');
  res.flushHeaders?.();
}

// 개선된 상태 브로드캐스트
export function broadcastState(payload) {
  const data = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
  
  const deadStateClients = new Set();
  for (const c of stateClients) {
    try {
      if (!c.destroyed && !c.finished) {
        c.write(data);
        c.flushHeaders?.();
      } else {
        deadStateClients.add(c);
      }
    } catch (error) {
      console.log(`[SSE] State client error: ${error.message}`);
      deadStateClients.add(c);
    }
  }
  
  // 통합 클라이언트들에게도 상태 전송
  const deadUnifiedClients = new Set();
  for (const c of unifiedClients) {
    try {
      if (!c.destroyed && !c.finished) {
        c.write(data);
        c.flushHeaders?.();
      } else {
        deadUnifiedClients.add(c);
      }
    } catch (error) {
      console.log(`[SSE] Unified state client error: ${error.message}`);
      deadUnifiedClients.add(c);
    }
  }
  
  // 끊어진 연결 정리
  for (const c of deadStateClients) {
    stateClients.delete(c);
  }
  for (const c of deadUnifiedClients) {
    unifiedClients.delete(c);
  }
}

// 개선된 로그 브로드캐스트 (unified 클라이언트 지원 포함)
export function broadcastLog(line, jobName = '') {
  const logData = {
    line: line,
    jobName: jobName,
    timestamp: Date.now(),
    type: line.includes('[HISTORY_UPDATE]') ? 'history_update' : 
          line.includes('[DONE]') ? 'execution_done' :
          line.includes('[EXECUTION_COMPLETE]') ? 'execution_complete' : 'log'
  };
  
  const data = `event: log\ndata: ${JSON.stringify(logData)}\n\n`;
  
  // 최근 로그 히스토리에 저장 (신규 SSE 클라이언트 재전송용)
  recentLogHistory.push(data);
  if (recentLogHistory.length > MAX_LOG_HISTORY) {
    recentLogHistory.splice(0, recentLogHistory.length - MAX_LOG_HISTORY);
  }
  
  // logClients에 전송
  const deadLogClients = new Set();
  let logSuccessCount = 0;
  
  for (const client of logClients) {
    try {
      if (!client.destroyed && !client.finished && client.writable) {
        client.write(data);
        logSuccessCount++;
      } else {
        deadLogClients.add(client);
      }
    } catch (error) {
      deadLogClients.add(client);
    }
  }
  
  // unifiedClients에도 전송
  const deadUnifiedClients = new Set();
  let unifiedSuccessCount = 0;

  for (const client of unifiedClients) {
    try {
      if (!client.destroyed && !client.finished && client.writable) {
        client.write(data);
        unifiedSuccessCount++;
      } else {
        deadUnifiedClients.add(client);
      }
    } catch (error) {
      deadUnifiedClients.add(client);
    }
  }

  // 끊어진 연결 정리
  for (const client of deadLogClients) {
    logClients.delete(client);
  }
  for (const client of deadUnifiedClients) {
    unifiedClients.delete(client);
  }
  
  // 중요 시그널 디버그 로그
  if (line.includes('[HISTORY_UPDATE]') || line.includes('[EXECUTION_COMPLETE]') || line.includes('[BINARY DONE]')) {
    const totalClients = logSuccessCount + unifiedSuccessCount;
    console.log(`[BROADCAST_LOG] ${logData.type} signal sent to ${totalClients} clients: ${line.substring(0, 100)}`);
  }
}

// 향상된 로그 버퍼 플러시
export function flushLogBuffer() {
  if (logBuffer.length === 0) return;
  
  const batch = logBuffer.splice(0, BATCH_SIZE);
  const data = batch.map(line => 
    `event: log\ndata: ${JSON.stringify({ line, at: Date.now() })}\n\n`
  ).join('');
  
  const deadLogClients = new Set();
  for (const c of logClients) {
    try {
      if (!c.destroyed && !c.finished) {
        c.write(data);
        c.flushHeaders?.();
      } else {
        deadLogClients.add(c);
      }
    } catch (error) {
      console.log(`[SSE] Log client error: ${error.message}`);
      deadLogClients.add(c);
    }
  }
  
  // 통합 클라이언트들에게도 로그 전송
  const deadUnifiedClients = new Set();
  for (const c of unifiedClients) {
    try {
      if (!c.destroyed && !c.finished) {
        c.write(data);
        c.flushHeaders?.();
      } else {
        deadUnifiedClients.add(c);
      }
    } catch (error) {
      deadUnifiedClients.add(c);
    }
  }
  
  // 끊어진 연결 정리
  for (const c of deadLogClients) {
    logClients.delete(c);
  }
  for (const c of deadUnifiedClients) {
    unifiedClients.delete(c);
  }
  
  // 다음 배치 스케줄링
  if (logBuffer.length > 0) {
    broadcastTimeoutId = setTimeout(flushLogBuffer, 20);
  } else {
    broadcastTimeoutId = null;
  }
}
