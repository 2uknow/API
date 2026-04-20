// src/routes/api-statistics.js — 통계 라우트
import { Router } from 'express';
import { histRead } from '../services/history-service.js';

const router = Router();

// 오늘 날짜 통계 API
router.get('/statistics/today', (req, res) => {
  try {
    const history = histRead();
    
    const now = new Date();
    const todayStr = new Intl.DateTimeFormat('sv-SE', { 
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);
    
    console.log(`[STATS] Today (KST): ${todayStr}, Server time: ${now.toISOString()}`);
    console.log(`[STATS] Total history items: ${history.length}`);
    
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
        
        const isToday = itemDateStr === todayStr;
        if (isToday) {
          console.log(`[STATS] Today item found: ${item.timestamp} -> ${itemDateStr} (job: ${item.job}, exitCode: ${item.exitCode})`);
        }
        
        return isToday;
      } catch (error) {
        console.log(`[STATS] Invalid timestamp format: ${item.timestamp}`);
        return false;
      }
    });
    
    console.log(`[STATS] Today's filtered items: ${todayHistory.length}`);
    
    if (todayHistory.length === 0) {
      return res.json({
        totalExecutions: 0,
        successRate: 0,
        avgResponseTime: 0,
        failedTests: 0,
        lastExecution: null
      });
    }
    
    const totalExecutions = todayHistory.length;
    const successfulExecutions = todayHistory.filter(item => item.exitCode === 0).length;
    const failedTests = totalExecutions - successfulExecutions;
    const successRate = totalExecutions > 0 ? Math.round((successfulExecutions / totalExecutions) * 100) : 0;
    
    console.log(`[STATS] Today's calculations:`);
    console.log(`  - Total executions: ${totalExecutions}`);
    console.log(`  - Successful: ${successfulExecutions}`);
    console.log(`  - Failed: ${failedTests}`);
    console.log(`  - Success rate: ${successRate}%`);
    
    let avgResponseTime = 0;
    const validResponseTimes = [];
    
    todayHistory.forEach(item => {
      if (item.detailedStats && item.detailedStats.avgResponseTime > 0) {
        validResponseTimes.push(item.detailedStats.avgResponseTime);
      }
      else if (item.newmanStats && item.newmanStats.timings && item.newmanStats.timings.responseAverage > 0) {
        validResponseTimes.push(item.newmanStats.timings.responseAverage);
      }
      else if (item.duration && item.duration > 0) {
        validResponseTimes.push(item.duration * 1000);
      }
    });
    
    if (validResponseTimes.length > 0) {
      const totalResponseTime = validResponseTimes.reduce((sum, time) => sum + time, 0);
      avgResponseTime = Math.round(totalResponseTime / validResponseTimes.length);
    }
    
    let lastExecution = null;
    if (todayHistory.length > 0) {
      const lastItem = todayHistory[0];
      lastExecution = {
        timestamp: lastItem.timestamp,
        job: lastItem.job,
        exitCode: lastItem.exitCode,
        duration: lastItem.duration,
        responseTime: lastItem.detailedStats?.avgResponseTime || 
                     lastItem.newmanStats?.timings?.responseAverage || 
                     (lastItem.duration ? lastItem.duration * 1000 : null)
      };
    }
    
    res.json({
      totalExecutions,
      successRate,
      avgResponseTime,
      failedTests,
      lastExecution,
      debug: {
        todayKST: todayStr,
        serverTime: now.toISOString(),
        totalHistoryCount: history.length,
        todayHistoryCount: todayHistory.length,
        validResponseTimes: validResponseTimes.length,
        sampleResponseTimes: validResponseTimes.slice(0, 3),
        sampleTimestamps: todayHistory.slice(0, 3).map(item => item.timestamp)
      }
    });
    
  } catch (error) {
    console.error('[STATISTICS ERROR]', error);
    res.status(500).json({ 
      error: error.message,
      totalExecutions: 0,
      successRate: 0,
      avgResponseTime: 0,
      failedTests: 0,
      lastExecution: null
    });
  }
});

export default router;
