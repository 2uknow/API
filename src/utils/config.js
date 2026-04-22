// src/utils/config.js — 설정 파일 관리 및 경로 상수
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// 프로젝트 루트 (src/utils/ 기준 2단계 상위)
export const root = path.resolve(__dirname, '..', '..');

export const cfgPath = path.join(root, 'config', 'settings.json');
export const reportsDir = path.join(root, 'reports');
export const logsDir    = path.join(root, 'logs');

// 디렉토리 자동 생성
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
if (!fs.existsSync(logsDir))    fs.mkdirSync(logsDir,    { recursive: true });

export function readCfg() {
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); }
  catch { return { 
    site_port: 3000, 
    report_keep_days: 30, 
    timezone: 'Asia/Seoul', 
    run_mode:'cli', 
    run_event_alert: true,
    alert_on_start: true,
    alert_on_success: true,
    alert_on_error: true,
    alert_method: 'flex'
    }; 
  }
}
