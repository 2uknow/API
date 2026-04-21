// src/routes/api-stream.js — SSE 스트리밍 라우트
import { Router } from 'express';
import { stateClients, logClients, unifiedClients, sseHeaders, recentLogHistory } from '../utils/sse.js';
import { state } from '../state/running-jobs.js';
import { histRead } from '../services/history-service.js';

const router = Router();

// State SSE
router.get('/stream/state', (req, res) => {
  sseHeaders(res);
  stateClients.add(res);
  
  console.log(`[SSE] State client connected: ${stateClients.size} total`);
  
  const last = histRead().at(-1) || null;
  res.write(`event: state\ndata: ${JSON.stringify({ 
    running: state.running, 
    last,
    scheduleQueue: {
      length: state.scheduleQueue.length,
      processing: state.scheduleQueue.length > 0
    },
    serverTime: Date.now()
  })}\n\n`);
  
  req.on('close', () => {
    stateClients.delete(res);
    console.log(`[SSE] State client disconnected: ${stateClients.size} remaining`);
  });
  
  req.on('error', (error) => {
    console.log(`[SSE] State client error: ${error.message}`);
    stateClients.delete(res);
  });
  
  setTimeout(() => {
    if (!res.destroyed && !res.finished) {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch (e) {
        stateClients.delete(res);
      }
    }
  }, 1000);
});

// Log SSE
router.get('/stream/logs', (req, res) => {
  sseHeaders(res);
  logClients.add(res);
  
  console.log(`[SSE] Log client connected: ${logClients.size} total`);
  
  req.on('close', () => {
    logClients.delete(res);
    console.log(`[SSE] Log client disconnected: ${logClients.size} remaining`);
  });
  
  req.on('error', (error) => {
    console.log(`[SSE] Log client error: ${error.message}`);
    logClients.delete(res);
  });
  
  setTimeout(() => {
    if (!res.destroyed && !res.finished) {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch (e) {
        logClients.delete(res);
      }
    }
  }, 1000);
});

// 통합 SSE (단일 연결로 state + logs 모두 제공)
router.get('/stream/unified', (req, res) => {
  sseHeaders(res);
  unifiedClients.add(res);
  
  console.log(`[SSE] Unified client connected: ${unifiedClients.size} total`);
  
  req.on('close', () => {
    unifiedClients.delete(res);
    console.log(`[SSE] Unified client disconnected: ${unifiedClients.size} remaining`);
  });
  
  req.on('error', (error) => {
    console.log(`[SSE] Unified client error: ${error.message}`);
    unifiedClients.delete(res);
  });
  
  setTimeout(() => {
    if (!res.destroyed && !res.finished) {
      try {
        const runningJobsList = [];
        for (const [jobName, info] of state.runningJobs) {
          runningJobsList.push({
            job: jobName,
            startAt: info.startTime,
            type: info.type || 'unknown',
            elapsed: Math.round((Date.now() - info.startTs) / 1000)
          });
        }
        
        res.write(`event: state\ndata: ${JSON.stringify({ 
          running: state.running,
          runningJobs: runningJobsList,
          timestamp: Date.now()
        })}\n\n`);
        
        if (state.runningJobs.size > 0 && recentLogHistory.length > 0) {
          console.log(`[SSE] Replaying ${recentLogHistory.length} recent logs to new client`);
          for (const logEntry of recentLogHistory) {
            res.write(logEntry);
          }
        }
        
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch (e) {
        unifiedClients.delete(res);
      }
    }
  }, 100);
});

export default router;
