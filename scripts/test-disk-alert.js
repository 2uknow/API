// 디스크 사용량 알람 레벨별 테스트 발송
// 실행: node scripts/test-disk-alert.js
import { exec } from 'child_process';
import { promisify } from 'util';
import { sendFlexMessage, buildDiskAlertFlex } from '../src/services/alert.js';

const execAsync = promisify(exec);

async function getRealDiskInfo(drive = 'D:') {
  const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID='${drive}'\\" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress"`;
  const { stdout } = await execAsync(cmd, { timeout: 15000, windowsHide: true });
  const data = JSON.parse(stdout.trim());
  const size = Number(data.Size);
  const free = Number(data.FreeSpace);
  return { size, free };
}

function makeInfo(drive, totalGB, usedPercent) {
  const usedGB = totalGB * (usedPercent / 100);
  const freeGB = totalGB - usedGB;
  return {
    drive,
    usedPercent,
    usedGB,
    freeGB,
    totalGB,
  };
}

async function main() {
  const drive = 'D:';
  const real = await getRealDiskInfo(drive);
  const totalGB = real.size / (1024 ** 3);
  console.log(`[TEST] ${drive} 실제 용량: ${totalGB.toFixed(1)} GB\n`);

  // 각 레벨별 시나리오
  const scenarios = [
    { level: 80, percent: 81.2, kind: 'exceed', desc: '80% 초과 (주의)' },
    { level: 85, percent: 86.5, kind: 'exceed', desc: '85% 초과 (경고)' },
    { level: 90, percent: 91.8, kind: 'exceed', desc: '90% 초과 (위험)' },
    { level: 95, percent: 96.3, kind: 'exceed', desc: '95% 초과 (심각)' },
    { level: 95, percent: 78.4, kind: 'recover', desc: '복구 알람' },
  ];

  for (const s of scenarios) {
    const info = makeInfo(drive, totalGB, s.percent);
    console.log(`[TEST] ${s.desc} — ${info.usedPercent}% (${info.usedGB.toFixed(1)}/${info.totalGB.toFixed(1)} GB)`);
    const flex = buildDiskAlertFlex(info, s.level, s.kind);
    const result = await sendFlexMessage(flex);
    console.log(`[TEST] → ${result.ok ? '성공' : '실패'} (status=${result.status})\n`);
    // 도배 방지 간격
    await new Promise(r => setTimeout(r, 1200));
  }

  console.log('[TEST] 5종 알람 발송 완료');
}

main().catch(err => {
  console.error('[TEST] 실패:', err);
  process.exit(1);
});
