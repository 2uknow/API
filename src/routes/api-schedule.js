// src/routes/api-schedule.js — 스케줄 CRUD 라우트
import { Router } from 'express';
import { schedules, saveSchedules, processSchedule } from '../services/schedule-service.js';

const router = Router();

router.get('/schedule', (req, res) => {
  res.json([...schedules.entries()].map(([name, { cronExpr }]) => ({ name, cronExpr })));
});

router.post('/schedule', (req, res) => {
  try {
    let name, cronExpr;
    
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('application/json')) {
      ({ name, cronExpr } = req.body);
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      name = req.body.name;
      cronExpr = req.body.cronExpr;
    } else {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          ({ name, cronExpr } = JSON.parse(body || '{}'));
          const addToScheduleQueue = req.app.locals.addToScheduleQueue;
          processSchedule(name, cronExpr, res, addToScheduleQueue);
        } catch (e) {
          res.status(400).json({ message: 'invalid body' });
        }
      });
      return;
    }
    
    const addToScheduleQueue = req.app.locals.addToScheduleQueue;
    processSchedule(name, cronExpr, res, addToScheduleQueue);
    
  } catch (e) {
    console.error('[SCHEDULE API ERROR]', e);
    res.status(500).json({ message: 'Server error: ' + e.message });
  }
});

router.delete('/schedule/:name', (req, res) => {
  const { name } = req.params;
  const it = schedules.get(name);
  if (it) {
    it.task.stop();
    schedules.delete(name);
    saveSchedules();
  }
  res.json({ ok: true });
});

export default router;
