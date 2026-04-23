// src/routes/api-debug.js — 디버그/진단 라우트
import { Router } from 'express';
import { stateClients, logClients } from '../utils/sse.js';

const router = Router();

// SSE 연결 상태
router.get('/debug/sse-status', (req, res) => {
  res.json({
    stateClients: stateClients.size,
    logClients: logClients.size,
    serverTime: new Date().toISOString()
  });
});

// 캐시 상태
router.get('/debug/cache-status', (req, res) => {
  res.json({
    cacheDisabled: true,
    etagDisabled: !req.app.get('etag'),
    viewCacheDisabled: !req.app.get('view cache'),
    serverTime: new Date().toISOString(),
    headers: {
      'cache-control': 'no-cache, no-store, must-revalidate',
      'pragma': 'no-cache',
      'expires': '0'
    }
  });
});

// 캐시 클리어 신호
router.post('/debug/clear-cache', (req, res) => {
  res.json({
    success: true,
    message: '캐시 클리어 신호가 전송되었습니다. 브라우저를 새로고침해주세요.',
    timestamp: new Date().toISOString(),
    instruction: 'Ctrl+F5 또는 Ctrl+Shift+R로 강제 새로고침하세요.'
  });
});

export default router;
