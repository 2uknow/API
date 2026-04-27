// === 로그 섹션 접기/펼치기 ===
function toggleLogSection() {
  isLogSectionCollapsed = !isLogSectionCollapsed;
  const contentArea = document.getElementById('logContentArea');
  const controls = document.getElementById('logControls');
  const arrow = document.getElementById('logSectionArrow');
  
  if (isLogSectionCollapsed) {
    if (contentArea) contentArea.style.display = 'none';
    if (controls) controls.style.display = 'none';
    if (arrow) arrow.textContent = '▶';
  } else {
    if (contentArea) contentArea.style.display = '';
    if (controls) controls.style.display = '';
    if (arrow) arrow.textContent = '▼';
  }
}

// === 로그 탭 관리 ===
function updateLogTabs(force = false) {
  const tabBars = [document.getElementById('logTabs'), document.getElementById('modalLogTabs')];
  // 스케줄 실행 Job은 탭에서 제외
  const jobNames = runningJobs.filter(j => !j.fromSchedule).map(j => j.job);
  const allJobNames = [...new Set([...jobNames, ...Object.keys(logsByJob).filter(k => k !== '_default' && k !== 'SYSTEM' && k !== 'ERROR')])];
  
  // 탭 구성이 변경되지 않았으면 재빌드 생략 (X 버튼 클릭 이벤트 씹힘 방지)
  const runningKey = jobNames.sort().join(',');
  const currentTabKeys = allJobNames.sort().join('|') + ':' + activeLogTab + ':' + runningKey;
  if (!force && currentTabKeys === _lastTabKeys) return;
  _lastTabKeys = currentTabKeys;  
  tabBars.forEach(tabBar => {
    if (!tabBar) return;
    
    let html = `<div class="log-tab ${activeLogTab === 'all' ? 'active' : ''} text-xs px-3 py-1 rounded-t-lg font-medium whitespace-nowrap transition-all duration-200 cursor-pointer" onclick="switchLogTab('all')" style="background: ${activeLogTab === 'all' ? '#1e293b' : '#334155'}; color: #4ade80; border: 1px solid #334155; border-bottom: none;">ALL</div>`;
    
    const jobColors = ['#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#f97316'];
    allJobNames.forEach((name, idx) => {
      const safeName = name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      const shortName = name.length > 20 ? name.substring(0, 18) + '..' : name;
      const isRunning = jobNames.includes(name);
      const isActive = activeLogTab === name;
      const colorIdx = getJobColorIndex(name);
      const tabColor = jobColors[colorIdx];
      html += `<div class="log-tab ${isActive ? 'active' : ''} text-xs px-3 py-1 rounded-t-lg font-medium whitespace-nowrap transition-all duration-200 cursor-pointer" onclick="switchLogTab('${safeName}')" style="background: ${isActive ? '#1e293b' : '#334155'}; color: ${isActive ? tabColor : '#e2e8f0'}; border: 1px solid #334155; border-bottom: none; ${isActive ? 'border-top: 2px solid ' + tabColor : ''}; display: flex; align-items: center; gap: 4px;" title="${name.replace(/"/g, '&quot;')}">
        <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${isRunning ? tabColor : '#6b7280'};${isRunning ? 'animation:pulse-border 2s infinite;' : ''}"></span>${shortName}
        <span onclick="event.stopPropagation();closeLogTab('${safeName}')" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;font-size:10px;line-height:1;cursor:pointer;color:#94a3b8;margin-left:2px;" onmouseover="this.style.background='rgba(239,68,68,0.3)';this.style.color='#ef4444'" onmouseout="this.style.background='transparent';this.style.color='#94a3b8'" title="${name} 탭 닫기">&times;</span>
      </div>`;
    });
    
    tabBar.innerHTML = html;
  });
}

// 개별 탭 닫기
function closeLogTab(tabName) {
  // 사용자가 닫은 탭 추적 (새 로그가 와도 재생성 방지)
  _closedTabs.add(tabName);
  // 해당 job의 로그 데이터 삭제
  delete logsByJob[tabName];
  // 색상 매핑도 정리
  jobColorMap.delete(tabName);
  
  // 현재 활성 탭이 닫히면 ALL 탭으로 전환
  if (activeLogTab === tabName) {
    activeLogTab = 'all';
    renderFilteredLogs();
  }
  
  _lastTabKeys = ''; // 강제 재빌드
  updateLogTabs(true);
}

// 완료된 Job 탭 자동 정리 (실행 중이 아닌 탭만 제거)
function cleanupFinishedJobTabs() {
  const jobNames = runningJobs.map(j => j.job);
  const tabKeys = Object.keys(logsByJob).filter(k => k !== '_default' && k !== 'SYSTEM' && k !== 'ERROR');
  
  let cleaned = false;
  for (const key of tabKeys) {
    if (!jobNames.includes(key)) {
      delete logsByJob[key];
      jobColorMap.delete(key);
      cleaned = true;
    }
  }
  
  // 모든 Job 완료 시 closedTabs도 초기화 (다음 실행에서는 다시 표시)
  _closedTabs.clear();
  
  if (cleaned) {
    // 현재 활성 탭이 정리된 경우
    if (activeLogTab !== 'all' && !logsByJob[activeLogTab]) {
      activeLogTab = 'all';
      renderFilteredLogs();
    }
    _lastTabKeys = ''; // 강제 재빌드
    updateLogTabs(true);
  }
}

function switchLogTab(tabName) {
  activeLogTab = tabName;
  _lastTabKeys = ''; // 강제 재빌드
  updateLogTabs(true);
  renderFilteredLogs();
}

function renderFilteredLogs() {
  const main = document.getElementById('console');
  const modal = document.getElementById('modalConsole');
  
  let allLines;
  if (activeLogTab === 'all') {
    allLines = Object.values(logsByJob).flat().sort((a, b) => a.ts - b.ts);
  } else {
    allLines = logsByJob[activeLogTab] || [];
  }
  
  // 최근 3000줄만 표시 (성능 보호)
  const displayLines = allLines.length > 3000 ? allLines.slice(-3000) : allLines;
  const html = displayLines.map(l => l.html).join('');
  if (main) { main.innerHTML = html; requestAnimationFrame(() => { main.scrollTop = main.scrollHeight; }); }
  if (isModalOpen && modal) { modal.innerHTML = html; requestAnimationFrame(() => { modal.scrollTop = modal.scrollHeight; }); }
}

function addLogToConsole(line, jobName) {
  let prefix = '';
  let colorClass = '';
  let borderClass = '';
  
  if (jobName === 'SYSTEM') {
    prefix = '[SYSTEM] ';
    colorClass = 'text-blue-400';
    borderClass = 'log-line-system';
  } else if (jobName === 'ERROR') {
    prefix = '[ERROR] ';
    colorClass = 'text-red-400';
    borderClass = 'log-line-error';
  } else if (jobName) {
    prefix = `[${jobName}] `;
    colorClass = 'text-green-400';
    const colorIdx = getJobColorIndex(jobName);
    borderClass = `log-line-job-${colorIdx}`;
  }
  
  const coloredLine = ansi_up.ansi_to_html(prefix + line);
  const logHtml = `<div class="log-line ${borderClass} ${colorClass}">${coloredLine}</div>`;
  
  // job별 로그 저장 (사용자가 닫은 탭 및 스케줄 Job 제외)
  const logKey = jobName || '_default';
  if (_closedTabs.has(logKey)) return; // 사용자가 닫은 탭의 로그는 무시
  // 스케줄 실행 Job의 로그는 탭/로그 저장 안 함 (SYSTEM/ERROR 로그는 통과)
  if (jobName && jobName !== 'SYSTEM' && jobName !== 'ERROR' && jobName !== '_default') {
    const isScheduleJob = runningJobs.some(j => j.job === jobName && j.fromSchedule);
    if (isScheduleJob) return;
  }
  if (!logsByJob[logKey]) logsByJob[logKey] = [];
  logsByJob[logKey].push({ html: logHtml, ts: Date.now() });
  
  // 로그 크기 제한 (job당 최대 2000줄)
  if (logsByJob[logKey].length > 2000) {
    logsByJob[logKey] = logsByJob[logKey].slice(-1500);
  }
  
  // 새 job 탭이면 탭 업데이트 예약
  if (jobName && jobName !== 'SYSTEM' && jobName !== 'ERROR' && jobName !== '_default') {
    scheduleTabsUpdate();
  }
  
  // 현재 활성 탭에 맞는 로그만 버퍼에 추가
  const shouldShow = activeLogTab === 'all' || activeLogTab === logKey;
  if (shouldShow) {
    _logBuffer.push(logHtml);
    scheduleLogFlush();
  }
}

// 로그 배치 렌더링 (requestAnimationFrame 기반)
function scheduleLogFlush() {
  if (_logFlushRAF) return;
  _logFlushRAF = requestAnimationFrame(flushLogBuffer);
}

function flushLogBuffer() {
  _logFlushRAF = null;
  if (_logBuffer.length === 0) return;
  
  const html = _logBuffer.join('');
  _logBuffer.length = 0;
  
  const main = document.getElementById('console');
  if (main) {
    main.insertAdjacentHTML('beforeend', html);
    // DOM 크기 제한 (자식 노드 3000개 초과 시 앞쪽 제거)
    while (main.childElementCount > 3000) {
      main.removeChild(main.firstChild);
    }
    main.scrollTop = main.scrollHeight;
  }
  
  if (isModalOpen) {
    const modal = document.getElementById('modalConsole');
    if (modal) {
      modal.insertAdjacentHTML('beforeend', html);
      while (modal.childElementCount > 3000) {
        modal.removeChild(modal.firstChild);
      }
      modal.scrollTop = modal.scrollHeight;
    }
  }
}

// updateLogTabs 쓰로틀링
function scheduleTabsUpdate() {
  _tabsNeedsUpdate = true;
  if (_tabsUpdateTimer) return;
  _tabsUpdateTimer = setTimeout(() => {
    _tabsUpdateTimer = null;
    if (_tabsNeedsUpdate) {
      _tabsNeedsUpdate = false;
      updateLogTabs();
    }
  }, TABS_THROTTLE);
}

// fetch 디바운싱 (fetchHistory + fetchTodayStats + fetchRunningJobs)
function scheduleFetchUpdates() {
  if (_fetchDebounceTimer) clearTimeout(_fetchDebounceTimer);
  _fetchDebounceTimer = setTimeout(() => {
    _fetchDebounceTimer = null;
    fetchRunningJobs();
    fetchHistory();
    fetchTodayStats();
  }, 500);
}

function clearAllConsoles() {
  document.getElementById('console').innerHTML = '';
  document.getElementById('modalConsole').innerHTML = '';
  logsByJob = {};
  jobColorMap.clear();
  nextJobColorIndex = 0;
  activeLogTab = 'all';
  updateLogTabs();
}

