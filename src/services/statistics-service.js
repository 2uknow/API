// src/services/statistics-service.js
// 통계 및 정기 리포트 (getTodayStatsInternal, getJobServiceMap, sendDailyReport, setupDailyReportScheduler)
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { root, readCfg } from '../utils/config.js';
import { histRead } from './history-service.js';
import {
  sendTextMessage,
  sendFlexMessage,
  buildDailyReportText,
  buildDailyReportFlex
} from '../../alert.js';

// 정기 리포트 스케줄러 변수 (여러 시간 지원을 위해 배열로 변경)
let dailyReportCronJobs = [];

function getTodayStatsInternal() {
  const history = histRead();

  const now = new Date();
  const todayStr = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);

  const todayHistory = history.filter(item => {
    if (!item.timestamp) return false;
    try {
      let itemDateStr;
      if (item.timestamp.includes('T')) {
        const itemDate = new Date(item.timestamp);
        itemDateStr = new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Asia/Seoul',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).format(itemDate);
      } else {
        itemDateStr = item.timestamp.split(' ')[0];
      }
      return itemDateStr === todayStr;
    } catch {
      return false;
    }
  });

  const totalExecutions = todayHistory.length;
  const successCount = todayHistory.filter(item => item.exitCode === 0).length;
  const failedTests = totalExecutions - successCount;
  const successRate = totalExecutions > 0 ? Math.round((successCount / totalExecutions) * 100) : 0;

  // 평균 응답시간 계산
  const validResponseTimes = [];
  todayHistory.forEach(item => {
    if (item.detailedStats && item.detailedStats.avgResponseTime > 0) {
      validResponseTimes.push(item.detailedStats.avgResponseTime);
    } else if (item.newmanStats && item.newmanStats.timings && item.newmanStats.timings.responseAverage > 0) {
      validResponseTimes.push(item.newmanStats.timings.responseAverage);
    } else if (item.duration && item.duration > 0) {
      validResponseTimes.push(item.duration * 1000);
    }
  });

  const avgResponseTime = validResponseTimes.length > 0
    ? validResponseTimes.reduce((a, b) => a + b, 0) / validResponseTimes.length
    : 0;

  // 서비스별 통계 계산
  const serviceStats = {};
  const jobServiceMap = getJobServiceMap();

  todayHistory.forEach(item => {
    const jobName = item.job || item.jobName;
    const service = jobServiceMap[jobName] || '기타';

    if (!serviceStats[service]) {
      serviceStats[service] = { total: 0, success: 0, failed: 0 };
    }

    serviceStats[service].total++;
    if (item.exitCode === 0) {
      serviceStats[service].success++;
    } else {
      serviceStats[service].failed++;
    }
  });

  return {
    totalExecutions,
    successRate,
    failedTests,
    avgResponseTime,
    serviceStats
  };
}

// Job별 서비스 매핑 정보 가져오기
function getJobServiceMap() {
  const jobServiceMap = {};
  const jobsDirPath = path.join(root, 'jobs');

  try {
    const jobFiles = fs.readdirSync(jobsDirPath).filter(f => f.endsWith('.json'));

    for (const file of jobFiles) {
      try {
        const jobConfig = JSON.parse(fs.readFileSync(path.join(jobsDirPath, file), 'utf-8'));
        if (jobConfig.name && jobConfig.service) {
          jobServiceMap[jobConfig.name] = jobConfig.service;
        }
      } catch {}
    }
  } catch {}

  return jobServiceMap;
}

// 정기 리포트 발송 함수
async function sendDailyReport() {
  console.log('[DAILY REPORT] 정기 리포트 발송 시작...');
  try {
    const stats = getTodayStatsInternal();
    const currentConfig = readCfg();

    let result;
    if (currentConfig.alert_method === 'flex') {
      const flexMsg = buildDailyReportFlex(stats);
      result = await sendFlexMessage(flexMsg);
    } else {
      const textMsg = buildDailyReportText(stats);
      result = await sendTextMessage(textMsg);
    }

    if (result.ok) {
      console.log('[DAILY REPORT] 정기 리포트 발송 성공');
    } else {
      console.error('[DAILY REPORT] 정기 리포트 발송 실패:', result);
    }
  } catch (error) {
    console.error('[DAILY REPORT] 정기 리포트 발송 오류:', error);
  }
}

// 정기 리포트 스케줄러 설정 함수
function setupDailyReportScheduler() {
  // 기존 스케줄러 모두 중지
  dailyReportCronJobs.forEach(job => {
    try { job.stop(); } catch {}
  });
  dailyReportCronJobs = [];
  console.log('[DAILY REPORT] 기존 스케줄러 중지');

  const config = readCfg();

  if (!config.daily_report_enabled) {
    console.log('[DAILY REPORT] 정기 리포트 비활성화 상태');
    return;
  }

  const times = config.daily_report_times || ['18:00'];
  const days = config.daily_report_days || [1, 2, 3, 4, 5];
  const daysStr = days.join(',');

  // 각 시간별로 스케줄러 생성
  times.forEach(time => {
    const [hour, minute] = time.split(':').map(Number);
    const cronExpr = `${minute} ${hour} * * ${daysStr}`;

    console.log(`[DAILY REPORT] 스케줄러 설정: ${cronExpr} (${time})`);

    const job = cron.schedule(cronExpr, sendDailyReport, {
      timezone: 'Asia/Seoul'
    });

    dailyReportCronJobs.push(job);
  });

  console.log(`[DAILY REPORT] ${times.length}개 스케줄러 시작됨: ${times.join(', ')}`);
}

export { getTodayStatsInternal, getJobServiceMap, sendDailyReport, setupDailyReportScheduler };
