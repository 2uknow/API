// 스케줄 관리
async function loadSchedules() {
  try {
    const res = await fetch('/api/schedule');
    const schedules = await res.json();
    
    renderScheduleIndicator(schedules);
    renderModalScheduleList(schedules);
  } catch (error) {
    console.error('스케줄 로딩 실패:', error);
  }
}

function renderScheduleIndicator(schedules) {
  const indicator = document.getElementById('scheduleIndicator');
  const list = document.getElementById('scheduleList');

  if (schedules.length === 0) {
    indicator.textContent = '활성 스케줄 없음';
    indicator.className = 'px-3 py-1 text-sm rounded-full bg-ter-var t-sec font-medium';
    list.innerHTML = '';
  } else {
    indicator.textContent = `${schedules.length}개 활성`;
    indicator.className = 'px-3 py-1 text-sm rounded-full schedule-indicator-active font-medium';

    // 모든 스케줄 표시 (스크롤로 처리)
    list.innerHTML = schedules.map(s =>
      `<div class="text-sm rounded-lg px-3 py-2 border bg-sec-var bd-c">${s.name} <span class="t-sec">(${s.cronExpr})</span></div>`
    ).join('');
  }
}

function renderModalScheduleList(schedules) {
  const list = document.getElementById('modalScheduleList');
  
  if (schedules.length === 0) {
    list.innerHTML = '<p class="text-sm t-sec">등록된 스케줄이 없습니다.</p>';
  } else {
    list.innerHTML = schedules.map(s => `
      <div class="flex items-center justify-between p-4 rounded-xl border bg-ter-var bd-c">
        <div>
          <div class="font-semibold t-pri">${s.name}</div>
          <div class="text-sm t-sec">${s.cronExpr}</div>
        </div>
        <button onclick="removeSchedule('${s.name}')"
                class="schedule-delete-btn text-sm px-3 py-1.5 rounded-lg transition-all duration-300 font-medium">
          삭제
        </button>
      </div>
    `).join('');
  }
}

async function addSchedule(name, cronExpr) {
  try {
    const response = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cronExpr })
    });
    
    const result = await response.json();
    
    if (response.ok) {
      showNotification('스케줄이 추가되었습니다', 'success');
      document.getElementById('scheduleForm').reset();
      await loadSchedules();
    } else {
      showNotification(result.message || '스케줄 추가 실패', 'error');
    }
  } catch (error) {
    showNotification('스케줄 추가 중 오류 발생', 'error');
  }
}

async function removeSchedule(name) {
  if (!confirm(`"${name}" 스케줄을 삭제하시겠습니까?`)) return;
  
  try {
    const response = await fetch(`/api/schedule/${encodeURIComponent(name)}`, {
      method: 'DELETE'
    });
    
    if (response.ok) {
      showNotification('스케줄이 삭제되었습니다', 'success');
      await loadSchedules();
    } else {
      const result = await response.json();
      showNotification(result.message || '스케줄 삭제 실패', 'error');
    }
  } catch (error) {
    showNotification('스케줄 삭제 중 오류 발생', 'error');
  }
}
