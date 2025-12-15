/**
 * PM2 Health Check Script
 * PM2 좀비 프로세스 감지 및 자동 복구
 *
 * 사용법:
 *   node scripts/pm2-healthcheck.js
 *
 * Windows 작업 스케줄러에 등록:
 *   - 프로그램: node
 *   - 인수: D:\API\2uknow-api-monitor\scripts\pm2-healthcheck.js
 *   - 시작 위치: D:\API\2uknow-api-monitor
 *   - 트리거: 매 5분마다
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

const CONFIG = {
    processName: '2uknow-api-monitor',
    serverScript: 'server.js',
    healthUrl: 'http://localhost:3001/',
    cronRestart: '0 4 * * *',
    logFile: path.join(projectDir, 'logs', 'pm2-healthcheck.log'),
    maxRetries: 3,
    retryDelay: 5000, // 5초
};

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
        console.error('로그 파일 쓰기 실패:', err.message);
    }
}

async function getPM2ProcessInfo() {
    try {
        const { stdout } = await execAsync(`pm2 jlist`);
        const processes = JSON.parse(stdout);
        return processes.find(p => p.name === CONFIG.processName);
    } catch (error) {
        log(`PM2 정보 조회 실패: ${error.message}`, 'ERROR');
        return null;
    }
}

async function checkHttpHealth() {
    try {
        const response = await fetch(CONFIG.healthUrl, {
            timeout: 10000,
            signal: AbortSignal.timeout(10000)
        });
        return response.ok;
    } catch (error) {
        log(`HTTP 헬스체크 실패: ${error.message}`, 'WARN');
        return false;
    }
}

async function restartPM2Daemon() {
    log('PM2 데몬 재시작 시도...', 'WARN');

    try {
        // PM2 kill
        try {
            await execAsync('pm2 kill');
            log('PM2 데몬 종료됨');
        } catch (e) {
            log(`PM2 kill 경고: ${e.message}`, 'WARN');
        }

        // 잠시 대기
        await new Promise(resolve => setTimeout(resolve, 2000));

        // PM2 start
        const { stdout, stderr } = await execAsync(
            `pm2 start ${path.join(projectDir, CONFIG.serverScript)} --name ${CONFIG.processName} --cron-restart="${CONFIG.cronRestart}"`,
            { cwd: projectDir }
        );

        log('PM2 프로세스 시작됨');

        // PM2 save
        await execAsync('pm2 save');
        log('PM2 프로세스 목록 저장됨');

        return true;
    } catch (error) {
        log(`PM2 데몬 재시작 실패: ${error.message}`, 'ERROR');
        return false;
    }
}

async function restartProcess() {
    log('PM2 프로세스 재시작 시도...', 'WARN');

    try {
        await execAsync(`pm2 restart ${CONFIG.processName}`);
        log('PM2 프로세스 재시작됨');
        return true;
    } catch (error) {
        log(`PM2 재시작 실패: ${error.message}`, 'ERROR');
        return false;
    }
}

async function diagnoseAndFix() {
    log('=== PM2 헬스체크 시작 ===');

    // 1. PM2 프로세스 정보 확인
    const processInfo = await getPM2ProcessInfo();

    if (!processInfo) {
        log('프로세스가 PM2에 등록되어 있지 않음', 'WARN');
        const success = await restartPM2Daemon();
        return success ? 'DAEMON_RESTARTED' : 'DAEMON_RESTART_FAILED';
    }

    // 2. 좀비 프로세스 감지 (PID 없거나 메모리 0)
    const pid = processInfo.pid;
    const memory = processInfo.monit?.memory || 0;
    const status = processInfo.pm2_env?.status;

    log(`프로세스 상태: status=${status}, pid=${pid}, memory=${memory}bytes`);

    // 좀비 상태: online이지만 PID가 없거나 메모리가 0
    const isZombie = (status === 'online' && (!pid || pid === 0 || memory === 0));

    if (isZombie) {
        log('좀비 프로세스 감지! (online 상태이지만 실제 실행 안됨)', 'ERROR');
        const success = await restartPM2Daemon();
        return success ? 'ZOMBIE_FIXED' : 'ZOMBIE_FIX_FAILED';
    }

    // 3. 프로세스가 stopped/errored 상태
    if (status === 'stopped' || status === 'errored') {
        log(`비정상 상태 감지: ${status}`, 'WARN');
        const success = await restartProcess();
        return success ? 'PROCESS_RESTARTED' : 'PROCESS_RESTART_FAILED';
    }

    // 4. HTTP 헬스체크
    const httpHealthy = await checkHttpHealth();

    if (!httpHealthy) {
        log('HTTP 헬스체크 실패, 프로세스 재시작 시도', 'WARN');

        // 먼저 일반 재시작 시도
        let success = await restartProcess();

        if (!success) {
            // 실패하면 데몬 재시작
            success = await restartPM2Daemon();
        }

        return success ? 'HTTP_HEALTH_FIXED' : 'HTTP_HEALTH_FIX_FAILED';
    }

    log('=== 모든 체크 통과, 정상 상태 ===');
    return 'HEALTHY';
}

async function main() {
    let retries = 0;
    let result;

    while (retries < CONFIG.maxRetries) {
        result = await diagnoseAndFix();

        if (result === 'HEALTHY' || result.includes('FIXED') || result.includes('RESTARTED')) {
            log(`최종 결과: ${result}`);

            // 수정된 경우 추가 검증
            if (result !== 'HEALTHY') {
                await new Promise(resolve => setTimeout(resolve, 5000));
                const httpHealthy = await checkHttpHealth();
                log(`복구 후 HTTP 검증: ${httpHealthy ? '성공' : '실패'}`);
            }

            process.exit(0);
        }

        retries++;
        log(`재시도 ${retries}/${CONFIG.maxRetries}...`, 'WARN');
        await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay));
    }

    log(`최대 재시도 횟수 초과. 최종 결과: ${result}`, 'ERROR');
    process.exit(1);
}

main().catch(error => {
    log(`치명적 오류: ${error.message}`, 'ERROR');
    process.exit(1);
});
