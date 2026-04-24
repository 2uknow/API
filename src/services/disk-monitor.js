// src/services/disk-monitor.js
// 디스크 사용량 모니터링 — 임계값 단계 진입 시 네이버 웍스 알람 발송
// 레벨 상승 시에만 알람, 같은 레벨 유지 중에는 조용, 레벨 하락 시 복구 알람 1회
import { exec } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';
import { readCfg } from '../utils/config.js';
import { sendFlexMessage, buildDiskAlertFlex } from './alert.js';

const execAsync = promisify(exec);

const DEFAULT_CONFIG = {
  enabled: false,
  drives: ['D:'],
  thresholds: [80, 85, 90, 95],
  check_cron: '*/5 * * * *',
  cooldown_minutes: 60
};

// 드라이브별 현재 레벨 (0, 80, 85, 90, 95 중 하나) — 레벨 전이 감지용
const driveLevels = new Map();
// 같은 드라이브+레벨 조합의 마지막 알람 시각 — 도배 방지 안전장치
const lastAlertTime = new Map();

async function getDiskUsage(drive) {
  const deviceId = drive.endsWith(':') ? drive : `${drive}:`;
  const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID='${deviceId}'\\" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress"`;

  try {
    const { stdout } = await execAsync(cmd, { timeout: 15000, windowsHide: true });
    const raw = stdout.trim();
    if (!raw) {
      console.error(`[DISK] ${deviceId} 조회 결과 비어 있음`);
      return null;
    }
    const data = JSON.parse(raw);
    const size = Number(data.Size) || 0;
    const free = Number(data.FreeSpace) || 0;
    if (size === 0) {
      console.error(`[DISK] ${deviceId} Size=0 — 드라이브가 존재하지 않거나 접근 불가`);
      return null;
    }
    const used = size - free;
    return {
      drive: deviceId,
      usedPercent: (used / size) * 100,
      usedGB: used / (1024 ** 3),
      freeGB: free / (1024 ** 3),
      totalGB: size / (1024 ** 3)
    };
  } catch (err) {
    console.error(`[DISK] ${deviceId} 체크 실패: ${err.message}`);
    return null;
  }
}

function computeLevel(percent, thresholds) {
  // 내림차순으로 돌면서 가장 높은 진입 레벨 반환
  const sorted = [...thresholds].sort((a, b) => b - a);
  for (const t of sorted) {
    if (percent >= t) return t;
  }
  return 0;
}

async function checkOnce() {
  const cfg = readCfg();
  const diskCfg = { ...DEFAULT_CONFIG, ...(cfg.disk_monitor || {}) };
  if (!diskCfg.enabled) return;

  for (const drive of diskCfg.drives) {
    const info = await getDiskUsage(drive);
    if (!info) continue;

    const newLevel = computeLevel(info.usedPercent, diskCfg.thresholds);
    const prevLevel = driveLevels.get(info.drive) ?? 0;

    if (newLevel > prevLevel) {
      // 레벨 상승 — 같은 레벨 쿨다운 확인 후 알람
      const key = `${info.drive}:${newLevel}`;
      const last = lastAlertTime.get(key) || 0;
      const cooldownMs = diskCfg.cooldown_minutes * 60 * 1000;
      if (Date.now() - last >= cooldownMs) {
        await sendFlexMessage(buildDiskAlertFlex(info, newLevel, 'exceed'));
        lastAlertTime.set(key, Date.now());
        console.log(`[DISK] ${info.drive} ${info.usedPercent.toFixed(1)}% — ${newLevel}% 레벨 알람 발송`);
      } else {
        console.log(`[DISK] ${info.drive} ${newLevel}% 알람 쿨다운 중 — 생략`);
      }
    } else if (newLevel < prevLevel) {
      await sendFlexMessage(buildDiskAlertFlex(info, prevLevel, 'recover'));
      console.log(`[DISK] ${info.drive} ${info.usedPercent.toFixed(1)}% — ${prevLevel}% 미만 복구 알람 발송`);
    }

    driveLevels.set(info.drive, newLevel);
  }
}

export function initDiskMonitor() {
  const cfg = readCfg();
  const diskCfg = { ...DEFAULT_CONFIG, ...(cfg.disk_monitor || {}) };

  if (!diskCfg.enabled) {
    console.log('[DISK] 디스크 모니터링 비활성 (disk_monitor.enabled=false)');
    return;
  }

  if (!cron.validate(diskCfg.check_cron)) {
    console.error(`[DISK] 잘못된 cron 표현식: ${diskCfg.check_cron} — 모니터링 중단`);
    return;
  }

  cron.schedule(diskCfg.check_cron, () => {
    checkOnce().catch(err => console.error('[DISK] 체크 중 예외:', err.message));
  }, { timezone: 'Asia/Seoul' });

  console.log(`[DISK] 모니터링 시작 — drives=${diskCfg.drives.join(',')} thresholds=${diskCfg.thresholds.join('/')}% cron=${diskCfg.check_cron} cooldown=${diskCfg.cooldown_minutes}m`);

  // 서버 시작 직후 1회 체크 (이미 임계치 초과 상태라면 즉시 알람)
  checkOnce().catch(err => console.error('[DISK] 초기 체크 실패:', err.message));
}
