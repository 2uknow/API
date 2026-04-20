// src/services/schedule-service.js
// 스케줄 관리 (loadSchedules, saveSchedules, processSchedule)
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { root } from '../utils/config.js';

const schedFile = path.join(root, 'config', 'schedules.json');
const schedules = new Map();

/**
 * 스케줄 로드 (schedules.json에서 cron 스케줄 등록)
 * @param {Function} addToScheduleQueue - 스케줄 큐에 추가하는 함수 (server.js에서 주입)
 */
function loadSchedules(addToScheduleQueue) {
  if (!fs.existsSync(schedFile)) return;
  try {
    const arr = JSON.parse(fs.readFileSync(schedFile, 'utf-8'));
    arr.forEach(({ name, cronExpr }) => {
      console.log(`[SCHEDULE] Loading: ${name} with cron: ${cronExpr}`);

      // 6자리 cron을 5자리로 변환 (초 제거)
      let convertedCron = cronExpr;
      const parts = cronExpr.split(' ');
      if (parts.length === 6) {
        convertedCron = parts.slice(1).join(' ');
        console.log(`[SCHEDULE] Converted ${cronExpr} to ${convertedCron}`);
      }

      // node-cron 유효성 검사
      if (!cron.validate(convertedCron)) {
        console.error(`[SCHEDULE ERROR] Invalid cron expression: ${convertedCron}`);
        return;
      }

      const task = cron.schedule(convertedCron, () => {
        console.log(`[SCHEDULE TRIGGER] Triggered job: ${name}`);
        addToScheduleQueue(name);
      }, { scheduled: true });

      schedules.set(name, { cronExpr: convertedCron, task });
      console.log(`[SCHEDULE] Successfully scheduled: ${name}`);
    });
  } catch (e) {
    console.error('[SCHEDULE ERROR] Failed to load schedules:', e);
  }
}

function saveSchedules() {
  const arr = [...schedules.entries()].map(([name, { cronExpr }]) => ({ name, cronExpr }));
  fs.writeFileSync(schedFile, JSON.stringify(arr, null, 2));
}

/**
 * 스케줄 등록/수정 처리 로직
 * @param {string} name - Job 이름
 * @param {string} cronExpr - Cron 표현식
 * @param {object} res - Express response
 * @param {Function} addToScheduleQueue - 스케줄 큐에 추가하는 함수 (server.js에서 주입)
 */
function processSchedule(name, cronExpr, res, addToScheduleQueue) {
  if (!name || !cronExpr) {
    return res.status(400).json({ message: 'name/cronExpr 필요' });
  }

  console.log(`[SCHEDULE API] Received: ${name} with cron: "${cronExpr}"`);
  console.log(`[SCHEDULE API] Cron length: ${cronExpr.length}`);
  console.log(`[SCHEDULE API] Cron char codes:`, Array.from(cronExpr).map(c => c.charCodeAt(0)));

  // 6자리 cron을 5자리로 변환 (초 제거)
  let convertedCron = cronExpr;
  const parts = cronExpr.split(' ');
  if (parts.length === 6) {
    convertedCron = parts.slice(1).join(' ');
    console.log(`[SCHEDULE API] Converted ${cronExpr} to ${convertedCron}`);
  }

  // node-cron 유효성 검사
  if (!cron.validate(convertedCron)) {
    console.error(`[SCHEDULE API ERROR] Invalid cron expression: ${convertedCron}`);
    return res.status(400).json({ message: `잘못된 cron 표현식: ${convertedCron}` });
  }

  // 기존 스케줄 중지
  if (schedules.has(name)) {
    schedules.get(name).task.stop();
    console.log(`[SCHEDULE API] Stopped existing schedule: ${name}`);
  }

  // 새 스케줄 등록
  const task = cron.schedule(convertedCron, () => {
    console.log(`[SCHEDULE TRIGGER] Triggered job: ${name}`);
    addToScheduleQueue(name);
  }, { scheduled: true });

  schedules.set(name, { cronExpr: convertedCron, task });
  saveSchedules();

  console.log(`[SCHEDULE API] Successfully scheduled: ${name} with ${convertedCron}`);
  res.json({ ok: true, message: `스케줄 등록됨: ${name}`, convertedCron });
}

export { schedFile, schedules, loadSchedules, saveSchedules, processSchedule };
