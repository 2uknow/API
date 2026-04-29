// 모바일 전용 동작: 필터 바텀시트, 로그 자동 접기, 날짜 칩
// 768px 미만에서만 의미 있게 동작하지만, 일부 함수(openFilterSheet 등)는
// 항상 정의되어 있어야 onclick에서 참조 가능하므로 무조건 로드한다.

(function () {
  const MOBILE_QUERY = '(max-width: 767px)';
  const isMobile = () => window.matchMedia(MOBILE_QUERY).matches;

  // === 1) 첫 로드 시 모바일이면 로그 섹션 자동 접기 + 레이아웃 재배치 ===
  document.addEventListener('DOMContentLoaded', () => {
    if (isMobile()) {
      // 로그 섹션 본문 영역 접기 (toggleLogSection이 정의되어 있을 때만)
      const content = document.getElementById('logContentArea');
      const arrow = document.getElementById('logSectionArrow');
      if (content) content.style.display = 'none';
      if (arrow) arrow.style.transform = 'rotate(-90deg)';
    }

    // 필터 바텀시트 Job 옵션을 데스크톱 #filterJob과 동기화
    syncSheetJobOptions();

    // 모바일 레이아웃 재배치: logSection을 History 위로
    rearrangeLayoutForMobile();

    // 모바일 진입 시 pageSize select도 5로 동기화
    if (isMobile()) {
      const sel = document.getElementById('pageSize');
      if (sel) {
        sel.value = '10'; // 기본 옵션이 10이라 5 옵션이 없으면 10으로 fallback
        // 실제 5 옵션이 select에 없을 수 있으니, 옵션을 동적 추가
        if (![...sel.options].some(o => o.value === '5')) {
          const opt = document.createElement('option');
          opt.value = '5';
          opt.textContent = '5';
          sel.insertBefore(opt, sel.firstChild);
        }
        sel.value = '5';
      }
    }
  });

  // jobSummary는 dashboard.css의 미디어 쿼리에서 모바일 완전 숨김으로 처리됨
  // (Collections/env 정보는 운영자가 모바일에서 볼 필요 없음)

  // === 모바일 레이아웃 재배치 ===
  // 데스크톱: <section .grid> [Job | History] </section> + <section #logSection>
  // 모바일:   <section .grid> [Job] </section> + <section #logSection> + <section .history-mobile-wrapper> [History] </section>
  // → 액션 → 현재 상태 → 과거 기록 흐름
  let _gridSectionRef = null; // 데스크톱 복귀 시 History를 되돌릴 원래 grid section
  function rearrangeLayoutForMobile() {
    const log = document.getElementById('logSection');
    const historyDiv = document.querySelector('.xl\\:col-span-3');
    if (!log || !historyDiv) return;

    const wrapperEl = document.querySelector('.history-mobile-wrapper');

    if (isMobile()) {
      if (wrapperEl) return; // 이미 모바일 모드 → 멱등
      // History의 원래 부모(grid section) 기억
      _gridSectionRef = historyDiv.parentElement;
      const wrapper = document.createElement('section');
      wrapper.className = 'history-mobile-wrapper';
      historyDiv.parentElement.removeChild(historyDiv);
      wrapper.appendChild(historyDiv);
      // logSection 바로 다음에 wrapper 삽입 → log → History 순
      log.parentElement.insertBefore(wrapper, log.nextSibling);
    } else {
      // 데스크톱 복귀: History를 원래 grid section으로 되돌림
      if (!wrapperEl) return;
      if (_gridSectionRef && historyDiv) {
        historyDiv.parentElement.removeChild(historyDiv);
        _gridSectionRef.appendChild(historyDiv);
      }
      wrapperEl.remove();
    }
  }

  // resize 시(모바일↔데스크톱 전환) 자동 재배치 (debounce)
  let _layoutTimer;
  window.addEventListener('resize', () => {
    clearTimeout(_layoutTimer);
    _layoutTimer = setTimeout(rearrangeLayoutForMobile, 120);
  });

  // 데스크톱 필터의 #filterJob 옵션이 비동기로 채워지므로,
  // 변경이 감지되면 시트의 select에도 같은 옵션을 복제한다.
  function syncSheetJobOptions() {
    const src = document.getElementById('filterJob');
    const dst = document.getElementById('sheetFilterJob');
    if (!src || !dst) return;

    const copy = () => {
      const current = dst.value;
      dst.innerHTML = src.innerHTML;
      // 선택값 보존
      if ([...dst.options].some(o => o.value === current)) dst.value = current;
    };
    copy();
    // MutationObserver로 src의 자식 변경 감시
    const mo = new MutationObserver(copy);
    mo.observe(src, { childList: true });
  }

  // === 2) 필터 바텀시트 ===
  window.openFilterSheet = function () {
    // 데스크톱 필터의 현재 값을 시트로 복사 (편집 진입점)
    document.getElementById('sheetFilterJob').value = document.getElementById('filterJob').value || '';
    document.getElementById('sheetFilterStatus').value = document.getElementById('filterStatus').value || '';
    document.getElementById('sheetDateFrom').value = document.getElementById('dateFrom').value || '';
    document.getElementById('sheetDateTo').value = document.getElementById('dateTo').value || '';
    refreshDateChipsActive();

    document.getElementById('filterSheetBackdrop').classList.add('open');
    document.getElementById('filterSheet').classList.add('open');
    document.body.style.overflow = 'hidden';
  };

  window.closeFilterSheet = function () {
    document.getElementById('filterSheetBackdrop').classList.remove('open');
    document.getElementById('filterSheet').classList.remove('open');
    document.body.style.overflow = '';
  };

  window.applyFilterSheet = function () {
    // 시트 값을 데스크톱 필터로 역동기화한 뒤 기존 applyFilters 사용
    document.getElementById('filterJob').value = document.getElementById('sheetFilterJob').value;
    document.getElementById('filterStatus').value = document.getElementById('sheetFilterStatus').value;
    document.getElementById('dateFrom').value = document.getElementById('sheetDateFrom').value;
    document.getElementById('dateTo').value = document.getElementById('sheetDateTo').value;
    // range 칩 선택 상태가 있으면 range select에도 반영(서버가 range 우선 처리)
    const activeChip = document.querySelector('#filterSheet .date-chip.active');
    document.getElementById('range').value = '';
    if (activeChip) {
      const r = activeChip.getAttribute('data-range');
      // range select 호환 값(7d) 외엔 dateFrom/To만 사용
      if (r === '7d') document.getElementById('range').value = '7d';
    }
    closeFilterSheet();
    if (typeof applyFilters === 'function') applyFilters();
    updateMobileFilterBadge();
  };

  window.resetFilterSheet = function () {
    document.getElementById('sheetFilterJob').value = '';
    document.getElementById('sheetFilterStatus').value = '';
    document.getElementById('sheetDateFrom').value = '';
    document.getElementById('sheetDateTo').value = '';
    document.querySelectorAll('#filterSheet .date-chip').forEach(c => c.classList.remove('active'));
  };

  // === 3) 날짜 칩 (오늘/어제/7일/30일) ===
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

  document.addEventListener('click', (e) => {
    const chip = e.target.closest('#filterSheet .date-chip');
    if (!chip) return;
    document.querySelectorAll('#filterSheet .date-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');

    const today = new Date();
    let from, to = new Date(today);
    switch (chip.getAttribute('data-range')) {
      case 'today':
        from = new Date(today);
        break;
      case 'yesterday':
        from = new Date(today); from.setDate(from.getDate() - 1);
        to = new Date(from);
        break;
      case '7d':
        from = new Date(today); from.setDate(from.getDate() - 6);
        break;
      case '30d':
        from = new Date(today); from.setDate(from.getDate() - 29);
        break;
    }
    if (from && to) {
      document.getElementById('sheetDateFrom').value = ymd(from);
      document.getElementById('sheetDateTo').value = ymd(to);
    }
  });

  function refreshDateChipsActive() {
    document.querySelectorAll('#filterSheet .date-chip').forEach(c => c.classList.remove('active'));
  }

  // === 4) 적용된 필터 개수 뱃지 ===
  function updateMobileFilterBadge() {
    const badge = document.getElementById('mobileFilterBadge');
    if (!badge) return;
    let n = 0;
    if (document.getElementById('filterJob').value) n++;
    if (document.getElementById('filterStatus').value) n++;
    if (document.getElementById('dateFrom').value || document.getElementById('dateTo').value) n++;
    badge.textContent = n > 0 ? String(n) : '';
  }
  // 필터 변경(데스크톱)에도 뱃지 갱신
  ['filterJob', 'filterStatus', 'dateFrom', 'dateTo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', updateMobileFilterBadge);
  });
  // 초기 1회
  document.addEventListener('DOMContentLoaded', updateMobileFilterBadge);

  // === 5) ESC로 시트 닫기 ===
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('filterSheet')?.classList.contains('open')) {
      closeFilterSheet();
    }
  });
})();
