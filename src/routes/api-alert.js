// src/routes/api-alert.js — 알람 설정/테스트 라우트
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import {
  sendTextMessage,
  sendFlexMessage,
  buildDailyReportText,
  buildDailyReportFlex
} from '../services/alert.js';
import { readCfg, cfgPath } from '../utils/config.js';
import { nowInTZString } from '../utils/time.js';
import { getTodayStatsInternal } from '../services/statistics-service.js';
import { setupDailyReportScheduler } from '../services/statistics-service.js';

const router = Router();

// 알람 설정 조회
router.get('/alert/config', (req, res) => {
  try {
    const config = readCfg();
    res.json({
      run_event_alert: config.run_event_alert || false,
      alert_on_start: config.alert_on_start || false,
      alert_on_success: config.alert_on_success || false,
      alert_on_error: config.alert_on_error || false,
      alert_method: config.alert_method || 'text',
      webhook_url: config.webhook_url ? '설정됨' : '미설정',
      daily_report_enabled: config.daily_report_enabled || false,
      daily_report_times: config.daily_report_times || ['18:00'],
      daily_report_days: config.daily_report_days || [1, 2, 3, 4, 5]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 알람 설정 변경
router.post('/alert/config', (req, res) => {
  try {
    const currentConfig = readCfg();
    const newConfig = { ...currentConfig, ...req.body };

    const configDir = path.dirname(cfgPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    fs.writeFileSync(cfgPath, JSON.stringify(newConfig, null, 2));

    setupDailyReportScheduler();

    res.json({ ok: true, message: '설정이 저장되었습니다.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 알람 테스트 전송
router.post('/alert/test', async (req, res) => {
  try {
    const config = readCfg();
    
    if (!config.webhook_url) {
      return res.status(400).json({ 
        ok: false, 
        message: 'Webhook URL이 설정되지 않았습니다.' 
      });
    }

    const flexMessage = {
      type: 'flex',
      altText: '[테스트] API 자동화 모니터링 시스템',
      contents: {
        type: 'bubble',
        size: 'kilo',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '🔔 테스트 알람', weight: 'bold', size: 'lg', color: '#1f2937' },
            { type: 'text', text: 'API 자동화 모니터링', size: 'sm', color: '#6b7280', margin: 'xs' }
          ],
          backgroundColor: '#f3f4f6',
          paddingAll: 'lg'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              contents: [
                { type: 'text', text: '✅ 알람 시스템이 정상적으로 작동합니다!', wrap: true, size: 'md' },
                { type: 'text', text: '설정이 올바르게 되어있는지 확인하세요.', wrap: true, size: 'sm', color: '#6b7280', margin: 'md' }
              ]
            }
          ],
          paddingAll: 'lg'
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: nowInTZString(), size: 'xs', color: '#888888', align: 'end' }
              ]
            }
          ]
        }
      }
    };
    const r = await sendFlexMessage(flexMessage);
    res.status(r.ok ? 200 : 500).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, status: 0, body: e.message });
  }
});

// 정기 리포트 테스트 발송
router.post('/alert/daily-report/test', async (req, res) => {
  try {
    const stats = await getTodayStatsInternal();
    const config = readCfg();

    let result;
    if (config.alert_method === 'flex') {
      const flexMsg = buildDailyReportFlex(stats);
      result = await sendFlexMessage(flexMsg);
    } else {
      const textMsg = buildDailyReportText(stats);
      result = await sendTextMessage(textMsg);
    }

    res.json({
      ok: result.ok,
      message: result.ok ? '테스트 리포트가 발송되었습니다.' : '발송 실패',
      stats: stats
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

export default router;
