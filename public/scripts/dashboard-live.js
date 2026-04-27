// === Live Mode 토글 + SSE 관리 ===
function toggleLiveMode(forceState) {
  const enable = typeof forceState === 'boolean' ? forceState : !isLiveMode;
  if (enable === isLiveMode) return;
  
  isLiveMode = enable;
  
  if (isLiveMode) {
    connectSSE();
    clearAutoOffTimer();
  } else {
    disconnectSSE();
    clearAutoOffTimer();
  }
  
  updateLiveUI();
}

function updateLiveUI() {
  const toggles = [document.getElementById('liveToggle'), document.getElementById('modalLiveToggle')];
  toggles.forEach(t => {
    if (!t) return;
    if (isLiveMode) { t.classList.add('active'); } else { t.classList.remove('active'); }
  });
  
  const indicator = document.getElementById('logIndicator');
  const statusText = document.getElementById('logStatusText');
  const pollingBadge = document.getElementById('pollingBadge');
  
  if (isLiveMode) {
    const isConnected = unifiedEventSource?.readyState === EventSource.OPEN;
    indicator.className = isConnected
      ? 'w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse'
      : 'w-2.5 h-2.5 bg-yellow-400 rounded-full animate-pulse';
    statusText.textContent = isConnected ? 'Live' : '연결 중...';
    statusText.style.color = '#ef4444';
    pollingBadge.style.display = 'none';
  } else {
    indicator.className = 'w-2.5 h-2.5 bg-gray-400 rounded-full';
    statusText.textContent = 'Polling';
    statusText.style.color = 'var(--text-secondary)';
    const interval = runningJobs.length > 0 ? POLLING_ACTIVE / 1000 : POLLING_IDLE / 1000;
    pollingBadge.textContent = `${interval}s`;
    pollingBadge.style.display = '';
  }
}

// === Polling 모드 (기본) ===
function startPolling() {
  stopPolling();
  const interval = runningJobs.length > 0 ? POLLING_ACTIVE : POLLING_IDLE;
  _pollingTimer = setInterval(pollDashboard, interval);
}

function stopPolling() {
  if (_pollingTimer) { clearInterval(_pollingTimer); _pollingTimer = null; }
}

function adjustPollingInterval() {
  if (!isLiveMode && _pollingTimer) { startPolling(); }
  updateLiveUI();
}

async function pollDashboard() {
  try {
    const prevCount = runningJobs.length;
    await Promise.all([fetchRunningJobs(), fetchTodayStats()]);
    // Polling 모드에서 Job 발견 시 폴링 간격 조정
    if (runningJobs.length !== prevCount) adjustPollingInterval();
  } catch (e) { /* 무시 */ }
}

// === SSE 연결/해제 (Live 모드 전용) ===
function connectSSE() {
  if (unifiedEventSource?.readyState === EventSource.OPEN) return;
  disconnectSSE();
  
  try {
    unifiedEventSource = new EventSource('/api/stream/unified');
    
    unifiedEventSource.addEventListener('open', () => {
      lastSSEHeartbeat = Date.now();
      updateLiveUI();
    });
    
    unifiedEventSource.addEventListener('state', (e) => {
      try {
        lastSSEHeartbeat = Date.now();
        const data = JSON.parse(e.data);
        running = data.running;
        
        if (data.runningJobs) {
          const prevManualCount = runningJobs.filter(j => !j.fromSchedule).length;
          const newJobs = data.runningJobs.map(sj => mergeRunningJobState(sj, runningJobs));
          runningJobs = newJobs;
          renderRunningJobs();
          
          const manualCount = runningJobs.filter(j => !j.fromSchedule).length;
          if (prevManualCount > 0 && manualCount === 0) scheduleAutoOff();
          if (manualCount > 0) clearAutoOffTimer();
          adjustPollingInterval();
        }
        setStatusChip();
      } catch (err) { /* 무시 */ }
    });
    
    unifiedEventSource.addEventListener('log', (e) => {
      try {
        lastSSEHeartbeat = Date.now();
        const data = JSON.parse(e.data);
        if (data.line) addLogToConsole(data.line, data.jobName || '');
        if (data.type === 'history_update' || data.line.includes('[HISTORY_UPDATE]')) scheduleFetchUpdates();
        if (data.type === 'execution_done' || 
            data.line.includes('[DONE]') || data.line.includes('[EXECUTION_COMPLETE]') ||
            data.line.includes('[JOB_FINISHED]') || data.line.includes('[YAML SCENARIO DONE]') ||
            data.line.includes('[BINARY DONE]') || data.line.includes('exit=')) {
          scheduleFetchUpdates();
        }
      } catch (err) { /* 무시 */ }
    });
    
    unifiedEventSource.addEventListener('message', (e) => {
      try {
        lastSSEHeartbeat = Date.now();
        const data = JSON.parse(e.data);
        if (data.type === 'heartbeat') return;
        if (data.line) addLogToConsole(data.line, data.jobName || '');
        if (data.type === 'history_update' || (data.line && data.line.includes('[HISTORY_UPDATE]'))) scheduleFetchUpdates();
        if (data.type === 'execution_done' || 
            (data.line && (data.line.includes('[DONE]') || data.line.includes('[EXECUTION_COMPLETE]') ||
            data.line.includes('[JOB_FINISHED]') || data.line.includes('[YAML SCENARIO DONE]') ||
            data.line.includes('[BINARY DONE]') || data.line.includes('exit=')))) {
          scheduleFetchUpdates();
        }
      } catch (err) { /* 무시 */ }
    });
    
    unifiedEventSource.addEventListener('heartbeat', () => { lastSSEHeartbeat = Date.now(); });
    
    unifiedEventSource.addEventListener('error', () => {
      updateLiveUI();
      if (isLiveMode) {
        setTimeout(() => {
          if (isLiveMode && (!unifiedEventSource || unifiedEventSource.readyState === EventSource.CLOSED)) connectSSE();
        }, 3000);
      }
    });
  } catch (error) {
    console.error('[SSE] 연결 실패:', error);
  }
  
  if (sseHealthCheckInterval) clearInterval(sseHealthCheckInterval);
  sseHealthCheckInterval = setInterval(() => {
    if (!isLiveMode) return;
    if (Date.now() - lastSSEHeartbeat > 30000 || unifiedEventSource?.readyState !== EventSource.OPEN) connectSSE();
  }, 30000);
}

function disconnectSSE() {
  if (sseHealthCheckInterval) { clearInterval(sseHealthCheckInterval); sseHealthCheckInterval = null; }
  if (unifiedEventSource) { try { unifiedEventSource.close(); } catch (e) {} unifiedEventSource = null; }
}

// === Auto-OFF: Job 모두 완료 후 30초 뒤 Live OFF ===
function scheduleAutoOff() {
  clearAutoOffTimer();
  _autoOffTimer = setTimeout(() => {
    if (isLiveMode && runningJobs.length === 0) {
      toggleLiveMode(false);
      cleanupFinishedJobTabs(); // 완료된 Job 탭 자동 정리
      showNotification('Job 완료 — Live 모드 자동 OFF', 'info');
    }
  }, AUTO_OFF_DELAY);
}

function clearAutoOffTimer() {
  if (_autoOffTimer) { clearTimeout(_autoOffTimer); _autoOffTimer = null; }
}

// 이전 함수 호환성 유지
function setupSSE() { if (isLiveMode) connectSSE(); }
function setupUnifiedSSE() { connectSSE(); }
function updateSSEIndicator() { updateLiveUI(); }
function checkSSEHealth() {}
function updateSSEHeartbeat() { lastSSEHeartbeat = Date.now(); }
