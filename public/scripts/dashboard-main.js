// 초기화
async function init() {
  // 다크모드 초기화를 가장 먼저 실행
  initTheme();
  
  await Promise.all([
    fetchJobs(),
    fetchHistory(),
    checkAlertStatus(),
    loadSchedules(),
    fetchTodayStats(),
    fetchRunningJobs()
  ]);
  
  // Polling 모드로 시작 (SSE 연결 안 함 → 렉 없음)
  startPolling();
  updateLiveUI();
  console.log('[INIT] Polling 모드로 시작');
  updateCurrentDate();
  
  // 실행 중 jobs 경과시간 실시간 업데이트 (1초마다, DOM 텍스트만 변경)
  runningJobsTimer = setInterval(() => {
    if (runningJobs.length > 0) {
      runningJobs.forEach(j => {
        if (j._localStartTs) {
          j.elapsed = Math.round((Date.now() - j._localStartTs) / 1000);
        } else {
          j.elapsed = (j.elapsed || 0) + 1;
        }
        // DOM에서 해당 run의 경과시간 span만 업데이트 (runId 기준 — 동일 jobName 동시 실행 구분)
        const el = document.querySelector(`.running-elapsed[data-runid="${j.runId}"]`);
        if (el) {
          const e = j.elapsed;
          const h = Math.floor(e / 3600), m = Math.floor((e % 3600) / 60), s = e % 60;
          el.textContent = h > 0 
            ? `${h}h${String(m).padStart(2,'0')}m${String(s).padStart(2,'0')}s`
            : m > 0 ? `${m}m${String(s).padStart(2,'0')}s` : `${s}s`;
        }
      });
    }
  }, 1000);
  
  // 실행 중인 수동 Job이 있으면 자동으로 Live 모드 ON (스케줄 Job은 제외)
  const manualRunning = runningJobs.filter(j => !j.fromSchedule);
  if (manualRunning.length > 0) {
    toggleLiveMode(true);
  }
}

// 오늘 날짜 업데이트
function updateCurrentDate() {
  const today = new Date();
  const dateStr = today.toLocaleDateString('ko-KR', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    weekday: 'long'
  });
  document.getElementById('todayDate').textContent = dateStr;
}

// 오늘 통계 가져오기
async function fetchTodayStats() {
  try {
    const response = await fetch('/api/statistics/today');
    const stats = await response.json();
    
    document.getElementById('totalExecutions').textContent = stats.totalExecutions || 0;
    document.getElementById('successRate').textContent = stats.successRate ? `${stats.successRate}%` : '0%';
    document.getElementById('avgResponse').textContent = stats.avgResponseTime ? `${Math.round(stats.avgResponseTime)}ms` : '0ms';
    document.getElementById('failedTests').textContent = stats.failedTests || 0;
    
    // 디버그 정보가 있으면 콘솔에 출력
    if (stats.debug) {
      console.log('[STATS DEBUG]', stats.debug);
    }
    
  } catch (error) {
    console.error('오늘 통계 로딩 실패:', error);
    // 에러 시 기본값 표시
    document.getElementById('totalExecutions').textContent = '0';
    document.getElementById('successRate').textContent = '0%';
    document.getElementById('avgResponse').textContent = '0ms';
    document.getElementById('failedTests').textContent = '0';
  }
}



// 알람 상태
async function checkAlertStatus() {
  try {
    const res = await fetch('/api/alert/config');
    const config = await res.json();
    const indicator = document.getElementById('alertIndicator');
    
    if (config.webhook_url) {
      indicator.textContent = '활성화';
      indicator.className = 'px-3 py-1 text-sm rounded-full bg-green-100 text-green-700 font-medium';
    } else {
      indicator.textContent = '비활성화';
      indicator.className = 'px-3 py-1 text-sm rounded-full bg-red-100 text-red-700 font-medium';
    }
  } catch (error) {
    document.getElementById('alertIndicator').textContent = '확인 실패';
  }
}

// 알림 표시
function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `fixed top-4 right-4 px-6 py-3 rounded-xl text-white text-sm z-50 shadow-lg ${
    type === 'success' ? 'bg-green-500' : type === 'error' ? 'bg-red-500' : 'bg-blue-500'
  }`;
  notification.textContent = message;
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 3000);
}

// 이벤트 리스너 설정
document.getElementById('jobSelect').onchange = () => {
  updateJobSummary();
  setStatusChip(); // 선택된 job에 따라 Run 버튼 상태 재계산
};

document.getElementById('runBtn').onclick = async () => {
  const name = document.getElementById('jobSelect').value;
  const runBtn = document.getElementById('runBtn');
  
  if (!name) { 
    alert('잡이 없습니다. jobs/*.json을 확인하세요.'); 
    return; 
  }
  
  // 같은 Job이 이미 실행 중인지 체크 (스케줄 실행은 제외, 다른 Job은 허용)
  if (runningJobs.some(j => j.job === name && !j.fromSchedule)) {
    alert(`같은 Job이 이미 실행 중입니다: ${name}\n완료 후 다시 시도해주세요.`);
    return;
  }
  
  // 잡 실행 시 접혀있던 로그 섹션 자동 펼침 — 모바일은 기본 접힘 상태라
  // 라이브 로그가 즉시 안 보이는 문제 해결. PC 에서도 사용자가 수동으로 접었다면 같이 펼침.
  if (typeof isLogSectionCollapsed !== 'undefined' && isLogSectionCollapsed && typeof toggleLogSection === 'function') {
    toggleLogSection();
  }

  // Live 모드 자동 활성화 + SSE 연결 대기 (로그 유실 방지)
  if (!isLiveMode) toggleLiveMode(true);
  if (!unifiedEventSource || unifiedEventSource.readyState !== EventSource.OPEN) {
    await new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (unifiedEventSource?.readyState === EventSource.OPEN) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
      setTimeout(() => { clearInterval(checkInterval); resolve(); }, 2000);
    });
  }
  
  // 실행 중 UI 변경
  runBtn.disabled = true;
  runBtn.textContent = 'Starting...';
  runBtn.style.background = 'var(--btn-disabled)';
  
  // 병렬 실행 시 로그를 클리어하지 않음 (탭으로 분리)
  addLogToConsole(`=== Starting job: ${name} ===`, 'SYSTEM');
  addLogToConsole(`Timestamp: ${new Date().toLocaleString('ko-KR')}`, 'SYSTEM');
  
  try {
    const response = await fetch(`/api/run/${encodeURIComponent(name)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const result = await response.json();
    addLogToConsole(`✅ ${name} 실행 요청 성공!`, 'SYSTEM');
    
    // Auto-Live: Run 클릭 시 자동으로 Live 모드 ON
    if (!isLiveMode) {
      toggleLiveMode(true);
    }
    
    // 즉시 로컬 runningJobs에 추가 (서버 응답 대기 없이 UI 즉시 반영)
    if (!runningJobs.some(j => j.job === name)) {
      runningJobs.push({
        job: name,
        startAt: new Date().toLocaleString('ko-KR'),
        type: 'pending',
        elapsed: 0,
        _localStartTs: Date.now()
      });
      renderRunningJobs();
      setStatusChip();
    }
    
    // 서버와 동기화 (서버 등록 확인)
    setTimeout(() => fetchRunningJobs(), 1000);
    setTimeout(() => fetchTodayStats(), 1500);
    
    // Fallback 동기화
    [3000, 6000].forEach(delay => {
      setTimeout(() => fetchRunningJobs(), delay);
    });
    
  } catch (error) {
    addLogToConsole(`❌ 요청 실패: ${error.message}`, 'ERROR');
    alert(`요청 실패: ${error.message}`);
    setStatusChip(); // 버튼 상태 복구
  }
};

document.getElementById('clearConsole').onclick = clearAllConsoles;
document.getElementById('expandLogModal').onclick = openLogModal;
document.getElementById('closeLogModal').onclick = closeLogModal;

// 통계 새로고침 버튼 이벤트 추가
document.getElementById('refreshStats').onclick = fetchTodayStats;

// Reset State 버튼 이벤트 추가
document.getElementById('resetStateBtn').onclick = async () => {
  if (!confirm('서버 상태를 강제로 초기화하시겠습니까?\n이 작업은 현재 실행 중인 모든 작업을 중단시킬 수 있습니다.')) {
    return;
  }
  
  try {
    console.log('[RESET] Sending reset state request...');
    const response = await fetch('/api/reset-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    const result = await response.json();
    
    if (result.ok) {
      console.log('[RESET] State reset successful:', result);
      addLogToConsole('🔄 서버 상태가 강제로 초기화되었습니다.', 'SYSTEM');
      
      // 클라이언트 상태도 초기화
      running = null;
      setStatusChip();
      
      // 데이터 새로고침
      await Promise.all([
        fetchHistory(),
        fetchTodayStats()
      ]);
      
      showNotification('서버 상태가 초기화되었습니다.', 'success');
    } else {
      throw new Error(result.message || 'Reset failed');
    }
  } catch (error) {
    console.error('[RESET] Error:', error);
    addLogToConsole(`❌ 상태 초기화 실패: ${error.message}`, 'ERROR');
    showNotification('상태 초기화에 실패했습니다.', 'error');
  }
};

document.getElementById('scheduleToggle').onclick = () => {
  document.getElementById('scheduleModal').classList.remove('hidden');
  document.getElementById('scheduleModal').classList.add('flex');
};

document.getElementById('closeScheduleModal').onclick = () => {
  document.getElementById('scheduleModal').classList.add('hidden');
  document.getElementById('scheduleModal').classList.remove('flex');
};

document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const jobName = document.getElementById('modalJobSelect').value;
  const cronExpr = document.getElementById('cronExpr').value.trim();
  if (!jobName || !cronExpr) {
    showNotification('모든 필드를 입력해주세요', 'error');
    return;
  }
  await addSchedule(jobName, cronExpr);
});

document.getElementById('applyFilter').onclick = applyFilters;
document.getElementById('resetFilter').onclick = resetFilters;
document.getElementById('pageSize').onchange = () => {
   pageSize = parseInt(document.getElementById('pageSize').value);
  currentPage = 1; // 페이지 크기 변경 시 첫 페이지로
  fetchHistory();
};
document.getElementById('searchText').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') applyFilters();
});

// 이벤트 위임 - 로그 링크와 모달 지우기 버튼
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('log-link')) {
    e.preventDefault();
    const logUrl = e.target.getAttribute('data-log-url');
    if (logUrl) openLogWithAutoScroll(logUrl);
  }
  
  if (e.target.id === 'clearModalConsole') {
    clearAllConsoles();
  }
});

// ESC 키로 모달 닫기
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (isModalOpen) {
      closeLogModal();
    } else if (!document.getElementById('scheduleModal').classList.contains('hidden')) {
      document.getElementById('closeScheduleModal').click();
    }
  }
});

// 페이지 언로드 시 연결 정리
window.addEventListener('beforeunload', () => {
  stopPolling();
  disconnectSSE();
});

// 페이지 가시성 변경 시 관리
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // 탭이 백그라운드 → SSE 해제 (리소스 절약), 폴링도 정지
    if (isLiveMode) disconnectSSE();
    stopPolling();
  } else {
    // 탭이 포그라운드 복귀
    startPolling();
    if (isLiveMode) connectSSE();
    // 상태 즉시 갱신
    fetchRunningJobs();
    fetchHistory();
    fetchTodayStats();
  }
});

// Chrome extension 에러 무시
window.addEventListener('error', (e) => {
  if (e.message && e.message.includes('message channel closed')) {
    e.preventDefault();
    return false;
  }
});

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && e.reason.message && e.reason.message.includes('message channel closed')) {
    e.preventDefault();
    return false;
  }
});

// 초기화 실행
init();
