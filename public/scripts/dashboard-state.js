// 전역 변수
let jobs = [];
let historyRaw = [];
let historyView = [];
let running = null;
let runningJobs = []; // 실행 중인 run 목록 (runId 단위로 독립 추적)
let currentPage = 1;
let pageSize = 10;
let totalItems = 0;
let totalPages = 0;
let isModalOpen = false;
let activeLogTab = 'all';
let logsByJob = {};
let runningJobsTimer = null;
const jobColorMap = new Map();
let nextJobColorIndex = 0;
let isLogSectionCollapsed = false; // 로그 섹션 접기/펼치기 상태
const _closedTabs = new Set();     // 사용자가 닫은 탭 (로그 수신해도 재생성 방지)

// === 성능 최적화: 배치/쓰로틀 관련 ===
let _logBuffer = [];           // addLogToConsole 배치 버퍼
let _logFlushRAF = null;       // requestAnimationFrame ID
let _tabsUpdateTimer = null;   // updateLogTabs 쓰로틀
let _tabsNeedsUpdate = false;
let _lastTabKeys = '';         // 탭 불필요한 재빌드 방지용
let _fetchDebounceTimer = null; // fetchHistory/Stats 디바운스
const LOG_FLUSH_INTERVAL = 80; // ms — 로그 배치 렌더 주기
const TABS_THROTTLE = 500;     // ms — 탭 업데이트 최소 간격

// === Live Mode (실시간 SSE) vs Polling Mode ===
let isLiveMode = false;         // Live 모드 ON/OFF
let _pollingTimer = null;       // Polling 타이머
let _autoOffTimer = null;       // Auto-OFF 타이머 (Job 완료 후 30초)
const POLLING_IDLE = 30000;     // Polling 간격: 유휴 시 30초
const POLLING_ACTIVE = 10000;   // Polling 간격: Job 실행 중 10초
const AUTO_OFF_DELAY = 30000;   // Live 모드 자동 OFF 대기시간 30초

function getJobColorIndex(jobName) {
  if (!jobName || jobName === 'SYSTEM' || jobName === 'ERROR' || jobName === '_default') return 0;
  if (!jobColorMap.has(jobName)) {
    jobColorMap.set(jobName, nextJobColorIndex % 6);
    nextJobColorIndex++;
  }
  return jobColorMap.get(jobName);
}

// 통합 SSE 연결 (단일 연결로 state + logs 모두 처리)
let unifiedEventSource;
let sseHealthCheckInterval;
let lastSSEHeartbeat = Date.now();

// ANSI 색상 변환기
const ansi_up = new AnsiUp();
