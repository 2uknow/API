/**
 * PM2 Health Check Daemon
 * PM2 좀비 프로세스 감지 및 자동 복구 (상시 실행)
 *
 * 이 스크립트는 PM2에서 데몬으로 실행되며,
 * 주기적으로 대상 프로세스의 상태를 확인하고 문제 발생 시 자동 복구합니다.
 *
 * 환경변수:
 *   HEALTHCHECK_INTERVAL: 체크 주기 (밀리초, 기본: 300000 = 5분)
 *   TARGET_PROCESS: 대상 프로세스 이름 (기본: 2uknow-api-monitor)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.resolve(__dirname, '..');

// 설정
const CONFIG = {
    processName: process.env.TARGET_PROCESS || '2uknow-api-monitor',
    serverScript: 'server.js',
    healthUrl: 'http://localhost:3001/',
    cronRestart: '0 4 * * *',
    checkInterval: parseInt(process.env.HEALTHCHECK_INTERVAL) || 300000, // 5분
    logFile: path.join(projectDir, 'logs', 'pm2-healthcheck.log'),
    maxConsecutiveFailures: 3,
    httpTimeout: 10000, // 10초
};

// 상태 추적
let consecutiveFailures = 0;
let lastCheckTime = null;
let totalChecks = 0;
let totalFixes = 0;

function log(message, level = 'INFO') {
    const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(logMessage);

    try {
        const logDir = path.dirname(CONFIG.logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        fs.appendFileSync(CONFIG.logFile, logMessage + '\n');
    } catch (err) {
        // 로그 파일 쓰기 실패는 무시
    }
}

async function getPM2ProcessInfo() {
    try {
        const { stdout } = await execAsync('pm2 jlist');
        const processes = JSON.parse(stdout);
        return processes.find(p => p.name === CONFIG.processName);
    } catch (error) {
        log(`PM2 정보 조회 실패: ${error.message}`, 'ERROR');
        return null;
    }
}

async function checkHttpHealth() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.httpTimeout);

        const response = await fetch(CONFIG.healthUrl, {
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        return response.ok;
    } catch (error) {
        return false;
    }
}

async function restartPM2Daemon() {
    log('PM2 상태 복구 시도 (pm2 update 사용)...', 'WARN');

    try {
        // pm2 update로 내부 상태 리프레시 (kill보다 안전)
        try {
            await execAsync('pm2 update');
            log('PM2 상태 업데이트 완료');
        } catch (e) {
            log(`PM2 update 경고: ${e.message}`, 'WARN');

            // update 실패 시에만 kill 사용
            await execAsync('pm2 kill');
            log('PM2 데몬 종료됨');

            // 잠시 대기
            await new Promise(resolve => setTimeout(resolve, 3000));

            // ecosystem.config.cjs로 전체 시작
            const ecosystemPath = path.join(projectDir, 'ecosystem.config.cjs');

            if (fs.existsSync(ecosystemPath)) {
                await execAsync(`pm2 start "${ecosystemPath}"`, { cwd: projectDir });
                log('PM2 ecosystem 시작됨');
            } else {
                // ecosystem 파일이 없으면 개별 시작
                await execAsync(
                    `pm2 start "${path.join(projectDir, CONFIG.serverScript)}" --name ${CONFIG.processName} --cron-restart="${CONFIG.cronRestart}"`,
                    { cwd: projectDir }
                );
                log('PM2 프로세스 개별 시작됨');
            }

            // PM2 save
            await execAsync('pm2 save');
            log('PM2 프로세스 목록 저장됨');
        }

        totalFixes++;
        return true;
    } catch (error) {
        log(`PM2 복구 실패: ${error.message}`, 'ERROR');
        return false;
    }
}

async function restartTargetProcess() {
    log(`${CONFIG.processName} 프로세스 재시작 시도...`, 'WARN');

    try {
        await execAsync(`pm2 restart ${CONFIG.processName}`);
        log(`${CONFIG.processName} 프로세스 재시작됨`);
        totalFixes++;
        return true;
    } catch (error) {
        log(`프로세스 재시작 실패: ${error.message}, PM2 상태 복구 시도...`, 'ERROR');

        // restart 실패 시 pm2 update로 상태 복구 후 재시도
        try {
            await execAsync('pm2 update');
            await execAsync(`pm2 restart ${CONFIG.processName}`);
            log(`PM2 상태 복구 후 ${CONFIG.processName} 재시작 성공`);
            totalFixes++;
            return true;
        } catch (retryError) {
            log(`재시도도 실패: ${retryError.message}`, 'ERROR');
            return false;
        }
    }
}

async function performHealthCheck() {
    totalChecks++;
    lastCheckTime = new Date();

    // 1. PM2 프로세스 정보 확인
    const processInfo = await getPM2ProcessInfo();

    if (!processInfo) {
        log(`${CONFIG.processName} 프로세스가 PM2에 등록되어 있지 않음`, 'WARN');
        consecutiveFailures++;

        if (consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
            await restartPM2Daemon();
            consecutiveFailures = 0;
        }
        return 'NOT_FOUND';
    }

    // 2. 좀비 프로세스 감지
    const pid = processInfo.pid;
    const memory = processInfo.monit?.memory || 0;
    const status = processInfo.pm2_env?.status;

    // 좀비 상태: online이지만 PID가 없음 (Windows에서 memory는 wmic 오류로 항상 0이므로 체크 제외)
    const isZombie = (status === 'online' && (!pid || pid === 0));

    if (isZombie) {
        log(`좀비 프로세스 감지! status=${status}, pid=${pid}, memory=${memory}`, 'ERROR');
        consecutiveFailures++;

        if (consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
            await restartPM2Daemon();
            consecutiveFailures = 0;
        }
        return 'ZOMBIE';
    }

    // 3. 프로세스 상태 확인
    if (status === 'stopped' || status === 'errored') {
        log(`비정상 상태: ${status}`, 'WARN');
        await restartTargetProcess();
        return 'RESTARTED';
    }

    // 4. HTTP 헬스체크
    const httpHealthy = await checkHttpHealth();

    if (!httpHealthy) {
        log('HTTP 헬스체크 실패', 'WARN');
        consecutiveFailures++;

        if (consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
            log(`연속 ${consecutiveFailures}회 실패, 프로세스 재시작`, 'WARN');
            const success = await restartTargetProcess();

            if (!success) {
                await restartPM2Daemon();
            }
            consecutiveFailures = 0;
        }
        return 'HTTP_FAIL';
    }

    // 모든 체크 통과
    consecutiveFailures = 0;

    // 주기적 상태 로그 (10회마다)
    if (totalChecks % 10 === 0) {
        log(`정상 동작 중 - 총 체크: ${totalChecks}, 복구: ${totalFixes}, PID: ${pid}, Memory: ${Math.round(memory / 1024 / 1024)}MB`);
    }

    return 'HEALTHY';
}

async function main() {
    log('=== PM2 헬스체크 데몬 시작 ===');
    log(`대상 프로세스: ${CONFIG.processName}`);
    log(`체크 주기: ${CONFIG.checkInterval / 1000}초`);
    log(`HTTP 엔드포인트: ${CONFIG.healthUrl}`);
    log(`연속 실패 허용: ${CONFIG.maxConsecutiveFailures}회`);

    // 초기 체크
    await performHealthCheck();

    // 주기적 체크
    setInterval(async () => {
        try {
            await performHealthCheck();
        } catch (error) {
            log(`헬스체크 중 오류: ${error.message}`, 'ERROR');
        }
    }, CONFIG.checkInterval);

    // 프로세스 종료 핸들링
    process.on('SIGINT', () => {
        log('=== PM2 헬스체크 데몬 종료 (SIGINT) ===');
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        log('=== PM2 헬스체크 데몬 종료 (SIGTERM) ===');
        process.exit(0);
    });
}

main().catch(error => {
    log(`치명적 오류: ${error.message}`, 'ERROR');
    process.exit(1);
});
