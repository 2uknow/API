// src/routes/api-history.js — 실행 이력 조회 라우트
import { Router } from 'express';
import { histRead } from '../services/history-service.js';
import { state } from '../state/running-jobs.js';

const router = Router();

router.get('/history', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const size = parseInt(req.query.size) || 20;
  const searchQuery = req.query.search || '';
  const jobFilter = req.query.job || '';
  const rangeFilter = req.query.range || '';
  const statusFilter = req.query.status || '';
  const dateFrom = req.query.dateFrom || '';
  const dateTo = req.query.dateTo || '';

  let history = histRead();

  // 필터링 로직
  if (searchQuery || jobFilter || rangeFilter || statusFilter || dateFrom || dateTo) {
    const now = Date.now();

    function inRange(ts) {
      if (!rangeFilter) return true;
      const t = Date.parse(ts.replace(' ', 'T') + '+09:00');
      if (rangeFilter === '24h') return (now - t) <= (24 * 3600 * 1000);
      if (rangeFilter === '7d') return (now - t) <= (7 * 24 * 3600 * 1000);
      return true;
    }

    function inDateRange(ts) {
      if (!dateFrom && !dateTo) return true;
      const dateStr = ts.split(' ')[0];
      if (dateFrom && dateStr < dateFrom) return false;
      if (dateTo && dateStr > dateTo) return false;
      return true;
    }

    function matchStatus(exitCode) {
      if (!statusFilter) return true;
      if (statusFilter === 'success') return exitCode === 0;
      if (statusFilter === 'failed') return exitCode !== 0;
      return true;
    }

    history = history.filter(r => {
      const jobMatch = !jobFilter || r.job === jobFilter;
      const rangeMatch = inRange(r.timestamp);
      const dateRangeMatch = inDateRange(r.timestamp);
      const statusMatch = matchStatus(r.exitCode);

      let searchMatch = true;
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const status = r.exitCode === 0 ? 'success' : 'failed';
        const searchTarget = ((r.job || '') + ' ' + (r.summary || '') + ' ' + status).toLowerCase();
        searchMatch = searchTarget.includes(query);
      }

      return jobMatch && rangeMatch && dateRangeMatch && statusMatch && searchMatch;
    });
  }
  
  const total = history.length;
  const totalPages = Math.ceil(total / size);
  const startIndex = (page - 1) * size;
  const endIndex = startIndex + size;
  const rawItems = history.slice().reverse().slice(startIndex, endIndex);

  const items = rawItems.map(item => ({
    ...item,
    report: item.reportPath || item.report || '',
    htmlReport: item.reportPath || item.htmlReport || '',
    duration: item.duration || 0
  }));

  res.json({
    items,
    total,
    page,
    size,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    pagination: {
      page,
      size,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    },
    running: state.running
  });
});

export default router;
