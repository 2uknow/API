
// 히스토리 관리
async function fetchHistory(){
  const job = document.getElementById('filterJob').value;
  const range = document.getElementById('range').value;
  const search = document.getElementById('searchText').value.trim();
  const status = document.getElementById('filterStatus').value;
  const dateFrom = document.getElementById('dateFrom').value;
  const dateTo = document.getElementById('dateTo').value;

  const params = new URLSearchParams({
    page: currentPage,
    size: pageSize
  });

  if (job) params.append('job', job);
  if (range) params.append('range', range);
  if (search) params.append('search', search);
  if (status) params.append('status', status);
  if (dateFrom) params.append('dateFrom', dateFrom);
  if (dateTo) params.append('dateTo', dateTo);
  
  const r = await fetch(`/api/history?${params}`); 
  const data = await r.json();
  
  running = data.running || null; 
  setStatusChip();
  
  // 여기 조건 수정!
  if (data.total !== undefined && data.totalPages !== undefined) {
    // 서버측 페이징 (현재 구조)
    console.log('서버측 페이징 사용');
    historyRaw = data.items || [];
    totalItems = data.total;        // data.pagination.total → data.total
    totalPages = data.totalPages;   // data.pagination.totalPages → data.totalPages  
    currentPage = data.page;        // data.pagination.page → data.page
    historyView = historyRaw.slice();
  } else {
    // 클라이언트측 처리 (하위호환)
    console.log('클라이언트측 페이징 사용');
    historyRaw = data.items || [];
    historyView = historyRaw.slice();
    totalItems = historyView.length;
    totalPages = Math.ceil(totalItems / pageSize);
  }
  
  console.log('최종 계산:', { totalItems, totalPages, currentPage, pageSize });
  
  renderHistory();
  renderPagination();
}


function setStatusChip() {
  const chip = document.getElementById('statusChip');
  const runBtn = document.getElementById('runBtn');
  
  // 스케줄 Job 제외한 실행 중 Job 리스트
  const manualRunningJobs = runningJobs.filter(j => !j.fromSchedule);
  
  if (manualRunningJobs.length > 1) {
    chip.textContent = `Running: ${manualRunningJobs.length} jobs`;
    chip.className = "text-xs px-3 py-1.5 rounded-full bg-amber-100 text-amber-700 font-medium";
    chip.style = '';
  } else if (manualRunningJobs.length === 1) {
    chip.textContent = 'Running: ' + manualRunningJobs[0].job;
    chip.className = "text-xs px-3 py-1.5 rounded-full bg-amber-100 text-amber-700 font-medium";
    chip.style = '';
  } else if (running && running.job) {
    chip.textContent = 'Running: ' + running.job;
    chip.className = "text-xs px-3 py-1.5 rounded-full bg-amber-100 text-amber-700 font-medium";
    chip.style = '';
  } else {
    chip.textContent = 'Standby';
    chip.className = "text-xs px-3 py-1.5 rounded-full font-medium";
    chip.style.background = "var(--bg-tertiary)";
    chip.style.color = "var(--text-primary)";
  }
  
  // 선택된 job이 실행 중이면 Run 버튼 비활성화 (스케줄 실행은 제외)
  const selectedJob = document.getElementById('jobSelect').value;
  const isSelectedRunning = manualRunningJobs.some(j => j.job === selectedJob);
  
  if (isSelectedRunning) {
    runBtn.disabled = true;
    runBtn.textContent = 'Running...';
    runBtn.className = 'px-6 py-3 rounded-xl text-white disabled:opacity-50 flex-1 cursor-not-allowed';
    runBtn.style.background = 'var(--btn-disabled)';
  } else {
    runBtn.disabled = false;
    runBtn.textContent = 'Run';
    runBtn.className = 'px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 text-white disabled:opacity-50 flex-1 hover:from-indigo-700 hover:to-purple-700 transition-all duration-300 font-semibold glow-on-hover';
    runBtn.style.background = '';
  }
}

function formatHistoryDuration(row) {
  // durationMs (정밀) 우선, 없으면 duration(seconds) * 1000 으로 폴백 (구버전 히스토리 호환)
  const ms = (row.durationMs != null) ? row.durationMs
    : (row.duration != null ? row.duration * 1000 : null);
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  return `${min}m${sec.toFixed(1)}s`;
}

function renderHistory() {
  const tb = document.getElementById('histTbody');
  tb.innerHTML = '';
  historyView.forEach(row => {
    const ok = row.exitCode === 0;
    const duration = formatHistoryDuration(row);
    
    const summaryTooltip = (row.summary || '').replace(/"/g, '&quot;');
    const summaryDisplay = row.summary && row.summary.length > 100 
      ? row.summary.substring(0, 97) + '...'
      : row.summary || '';
    
    tb.insertAdjacentHTML('beforeend', `
      <tr class="transition-colors duration-200" style="background: ${ok ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'};" onmouseover="this.style.background='${ok ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'}'" onmouseout="this.style.background='${ok ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'}'">
        <td class="py-3 pr-4 text-sm font-medium t-pri">${row.timestamp || ''}</td>
        <td class="py-3 pr-4 font-semibold t-pri">${row.job || ''}</td>
        <td class="py-3 pr-4">${ok ? '<span class="text-emerald-700 text-sm font-semibold">Success</span>' : '<span class="text-rose-700 text-sm font-semibold">Failed</span>'}</td>
        <td class="py-3 pr-4 text-sm t-sec" title="${summaryTooltip}">${summaryDisplay}</td>
        <td class="py-3 pr-4 text-sm font-medium t-sec">${duration}</td>
        <td class="py-3 pr-4">${row.report ? ('<a class="text-indigo-600 underline text-sm hover:text-indigo-800 transition-colors duration-200" href="' + row.report.replace(/^.*[\\/]reports[\\/]/, '/reports/') + '" target="_blank">' + (row.report.endsWith('.html') ? 'HTML' : 'TXT') + '</a>') : ''}</td>
        <td class="py-3">
          <a class="underline text-sm log-link transition-colors duration-200 t-pri" href="#" data-log-url="/logs/${row.stdout}" onmouseover="this.style.color='var(--text-secondary)'" onmouseout="this.style.color='var(--text-primary)'">stdout</a>
        </td>
      </tr>`
    );
  });
}
// 페이징 렌더링
function renderPagination() {
  const info = document.getElementById('paginationInfo');
  const controls = document.getElementById('paginationControls');
  
  if (totalItems === 0) {
    info.textContent = '데이터가 없습니다';
    controls.innerHTML = '';
    return;
  }
  
  // 정보 표시
  const startItem = (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);
  info.textContent = `${startItem}-${endItem} / ${totalItems}건 (${currentPage}/${totalPages} 페이지)`;
  
  // 페이징 컨트롤
  controls.innerHTML = '';
  
  // 맨 처음 버튼
  if (currentPage > 1) {
    const firstBtn = document.createElement('button');
    firstBtn.innerHTML = '&laquo;&laquo;';
    firstBtn.title = '맨 처음';
    firstBtn.className = 'px-3 py-2 border rounded-lg text-sm transition-all duration-300 pagination-btn';
    firstBtn.onclick = () => {
      currentPage = 1;
      fetchHistory();
    };
    controls.appendChild(firstBtn);
  }
  
  // 이전 페이지
  if (currentPage > 1) {
    const prevBtn = document.createElement('button');
    prevBtn.innerHTML = '&laquo; 이전';
    prevBtn.className = 'px-4 py-2 border rounded-lg text-sm transition-all duration-300 pagination-btn';
    prevBtn.onclick = () => {
      currentPage--;
      fetchHistory();
    };
    controls.appendChild(prevBtn);
  }
  
  // 페이지 번호들
  const maxVisible = 5; // 최대 표시할 페이지 번호 개수
  let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
  let endPage = Math.min(totalPages, startPage + maxVisible - 1);
  
  // 끝에서 시작점 조정
  if (endPage - startPage + 1 < maxVisible) {
    startPage = Math.max(1, endPage - maxVisible + 1);
  }
  
  // 첫 페이지가 시작점보다 멀면 생략 표시
  if (startPage > 1) {
    const pageBtn1 = document.createElement('button');
    pageBtn1.textContent = '1';
    pageBtn1.className = 'px-4 py-2 border rounded-lg text-sm transition-all duration-300 pagination-btn';
    pageBtn1.onclick = () => {
      currentPage = 1;
      fetchHistory();
    };
    controls.appendChild(pageBtn1);
    
    if (startPage > 2) {
      const ellipsis = document.createElement('span');
      ellipsis.textContent = '...';
      ellipsis.className = 'px-3 py-2 text-sm pagination-ellipsis';
      controls.appendChild(ellipsis);
    }
  }
  
  // 페이지 번호 버튼들
  for (let i = startPage; i <= endPage; i++) {
    const pageBtn = document.createElement('button');
    pageBtn.textContent = i;
    pageBtn.className = i === currentPage 
      ? 'px-4 py-2 border rounded-lg text-sm font-semibold pagination-current'
      : 'px-4 py-2 border rounded-lg text-sm transition-all duration-300 pagination-btn';
    pageBtn.onclick = () => {
      currentPage = i;
      fetchHistory();
    };
    controls.appendChild(pageBtn);
  }
  
  // 마지막 페이지가 끝점보다 멀면 생략 표시
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      const ellipsis = document.createElement('span');
      ellipsis.textContent = '...';
      ellipsis.className = 'px-3 py-2 text-sm pagination-ellipsis';
      controls.appendChild(ellipsis);
    }
    
    const lastPageBtn = document.createElement('button');
    lastPageBtn.textContent = totalPages;
    lastPageBtn.className = 'px-4 py-2 border rounded-lg text-sm transition-all duration-300 pagination-btn';
    lastPageBtn.onclick = () => {
      currentPage = totalPages;
      fetchHistory();
    };
    controls.appendChild(lastPageBtn);
  }
  
  // 다음 페이지
  if (currentPage < totalPages) {
    const nextBtn = document.createElement('button');
    nextBtn.innerHTML = '다음 &raquo;';
    nextBtn.className = 'px-4 py-2 border rounded-lg text-sm transition-all duration-300 pagination-btn';
    nextBtn.onclick = () => {
      currentPage++;
      fetchHistory();
    };
    controls.appendChild(nextBtn);
  }
  
  // 맨 마지막 버튼
  if (currentPage < totalPages) {
    const lastBtn = document.createElement('button');
    lastBtn.innerHTML = '&raquo;&raquo;';
    lastBtn.title = '맨 마지막';
    lastBtn.className = 'px-3 py-2 border rounded-lg text-sm transition-all duration-300 pagination-btn';
    lastBtn.onclick = () => {
      currentPage = totalPages;
      fetchHistory();
    };
    controls.appendChild(lastBtn);
  }
}
// 로그 자동 스크롤
function openLogWithAutoScroll(logUrl) {
  const logWindow = window.open(logUrl, '_blank');
  if (logWindow) {
    logWindow.addEventListener('load', () => {
      setTimeout(() => logWindow.scrollTo(0, logWindow.document.body.scrollHeight), 100);
    });
  }
}

// 필터링
function applyFilters() {
  currentPage = 1; // 필터 적용 시 첫 페이지로
  fetchHistory(); // 서버에서 필터링
}

function resetFilters() {
  ['filterJob', 'range', 'searchText', 'filterStatus', 'dateFrom', 'dateTo'].forEach(id => document.getElementById(id).value = '');
  currentPage = 1;
  fetchHistory(); // 서버에서 데이터 가져오기
}
