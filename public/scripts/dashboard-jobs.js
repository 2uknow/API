// 로그 모달
function openLogModal() {
  isModalOpen = true;
  const modal = document.getElementById('logModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  
  // 기존 로그 동기화
  const mainConsole = document.getElementById('console');
  const modalConsole = document.getElementById('modalConsole');
  modalConsole.innerHTML = mainConsole.innerHTML;
  
  setTimeout(() => {
    modalConsole.scrollTop = modalConsole.scrollHeight;
  }, 100);
}

function closeLogModal() {
  isModalOpen = false;
  const modal = document.getElementById('logModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

// === Running Jobs 관리 ===
// 서버 run을 로컬 상태와 병합 — runId 단위로 매칭(같은 jobName 여러 run 동시 추적)
function mergeRunningJobState(sj, currentJobs) {
  const existing = currentJobs.find(lj => lj.runId === sj.runId);
  // 같은 runId면 로컬 타임스탬프 유지, 새 run이면 서버 elapsed 기준으로 리셋
  return {
    ...sj,
    _localStartTs: existing?._localStartTs || (Date.now() - (sj.elapsed || 0) * 1000)
  };
}

async function fetchRunningJobs() {
  try {
    const res = await fetch('/api/running');
    const data = await res.json();
    if (data.ok) {
      const serverJobs = data.running || [];
      runningJobs = serverJobs.map(sj => mergeRunningJobState(sj, runningJobs));
      renderRunningJobs();
      setStatusChip();
    }
  } catch (e) {
    console.error('[RUNNING] Fetch failed:', e);
  }
}

function renderRunningJobs() {
  const panel = document.getElementById('runningJobsPanel');
  const list = document.getElementById('runningJobsList');
  const count = document.getElementById('runningJobsCount');

  if (runningJobs.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  count.textContent = runningJobs.length;

  // 같은 jobName의 동시 실행 run에 #1, #2 번호 부여 (서버 응답 순서 = 등록 순서)
  const runGroups = new Map(); // jobName → [runId, runId, ...]
  runningJobs.forEach(j => {
    if (!runGroups.has(j.job)) runGroups.set(j.job, []);
    runGroups.get(j.job).push(j.runId);
  });

  list.innerHTML = runningJobs.map(job => {
    // _localStartTs가 있으면 실시간 계산, 없으면 서버 값 사용
    const elapsed = job._localStartTs
      ? Math.round((Date.now() - job._localStartTs) / 1000)
      : (job.elapsed || 0);
    const hours = Math.floor(elapsed / 3600);
    const mins = Math.floor((elapsed % 3600) / 60);
    const secs = elapsed % 60;
    const elapsedStr = hours > 0
      ? `${hours}h${String(mins).padStart(2,'0')}m${String(secs).padStart(2,'0')}s`
      : mins > 0
        ? `${mins}m${String(secs).padStart(2,'0')}s`
        : `${secs}s`;
    const typeLabels = { yaml_batch: 'Batch', yaml_scenario: 'YAML', newman: 'Newman', binary: 'Binary', sclient_scenario: 'SClient', pending: '...' };
    const typeLabel = typeLabels[job.type] || job.type;
    const scheduleBadge = job.fromSchedule ? '<span class="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 flex-shrink-0">Schedule</span>' : '';

    // 같은 이름의 동시 run이 2개 이상이면 #1, #2 배지 표시
    const runIds = runGroups.get(job.job) || [];
    const runIdx = runIds.indexOf(job.runId);
    const runBadge = (runIds.length > 1) ? `<span class="text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-600 flex-shrink-0 font-mono">#${runIdx + 1}</span>` : '';

    return `
      <div class="running-job-item flex items-center justify-between p-2 rounded-lg border text-xs bg-sec-var bd-c">
        <div class="flex items-center space-x-2 flex-1 min-w-0">
          <span class="w-2 h-2 bg-blue-500 rounded-full animate-pulse flex-shrink-0"></span>
          <span class="font-semibold truncate t-pri" title="${job.job}">${job.job}</span>
          <span class="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 flex-shrink-0">${typeLabel}</span>
          ${scheduleBadge}${runBadge}
        </div>
        <div class="flex items-center space-x-2 flex-shrink-0 ml-2">
          <span class="running-elapsed t-sec" data-runid="${job.runId}">${elapsedStr}</span>
          <button onclick="stopJob('${job.job}')" class="px-2 py-0.5 text-xs bg-red-500 hover:bg-red-600 text-white rounded transition-all font-medium" title="중지">Stop</button>
        </div>
      </div>`;
  }).join('');

  scheduleTabsUpdate();
}

async function stopJob(jobName) {
  if (!confirm(`"${jobName}" Job을 중지하시겠습니까?`)) return;
  
  try {
    const res = await fetch(`/api/stop/${encodeURIComponent(jobName)}`, { method: 'POST' });
    const result = await res.json();
    
    if (result.ok) {
      showNotification(`${jobName} 중지됨`, 'success');
      addLogToConsole(`🛑 ${jobName} 사용자에 의해 중지됨`, 'SYSTEM');
      setTimeout(() => fetchRunningJobs(), 500);
    } else {
      showNotification(result.message || '중지 실패', 'error');
    }
  } catch (e) {
    showNotification('중지 요청 실패', 'error');
  }
}


// Jobs
async function fetchJobs() {
  const res = await fetch('/api/jobs');
  jobs = await res.json();
  
  ['jobSelect', 'filterJob', 'modalJobSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    
    el.innerHTML = id === 'filterJob' ? 
      '<option value="">All</option>' : '<option value="">Select</option>';
    jobs.forEach(j => el.insertAdjacentHTML('beforeend', `<option value="${j.name}">${j.name} (${j.type})</option>`));
  });
  
  if (jobs.length === 0) {
    document.getElementById('jobSummary').textContent = 'jobs 폴더가 비어 있습니다.';
  } else {
    updateJobSummary();
  }
}

function updateJobSummary() {
  const name = document.getElementById('jobSelect').value;
  const j = jobs.find(x => x.name === name);
  const chips = [`Collections: ${j?.collection?.split('/').pop() || '-'}`, `env: ${j?.environment?.split('/').pop() || '-'}`];
  document.getElementById('jobSummary').innerHTML = chips.map(c => 
    `<span class="inline-block px-3 py-1 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 mr-2 text-sm font-medium">${c}</span>`
  ).join('');
}
