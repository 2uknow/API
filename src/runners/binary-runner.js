import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import { execSync } from 'child_process';
import { root, reportsDir, logsDir, readCfg } from '../utils/config.js';
import { nowInTZString, kstTimestamp } from '../utils/time.js';
import { broadcastLog } from '../utils/sse.js';
import { state, registerRunningJob, unregisterRunningJob, finalizeJobCompletion } from '../state/running-jobs.js';
import { histAppend } from '../services/history-service.js';
import { cleanupOldReports } from '../services/log-manager.js';
import { sendAlert, buildBinaryFailureReport } from '../services/alert-integration.js';
import { parseBinaryOutput } from '../parsers/binary-parser.js';
import { decodeUrlEncodedContent } from '../utils/crypto.js';
import { generateNewmanStyleBinaryReport, generateBinaryHtmlReport } from '../services/report-generator.js';
import { getBinaryPath, spawnBinaryCLI } from './spawn-helpers.js';
import { runYamlSClientScenario, runYamlDirectoryBatch } from './yaml-scenario-runner.js';

// 바이너리 Job 실행 함수
async function runBinaryJob(jobName, job) {
  console.log(`[BINARY] Starting binary job: ${jobName}`);
  
  const stamp = kstTimestamp();
  const stdoutPath = path.join(logsDir, `stdout_${jobName}_${stamp}.log`);
  const stderrPath = path.join(logsDir, `stderr_${jobName}_${stamp}.log`);
  const txtReport = path.join(reportsDir, `${jobName}_${stamp}.txt`);
  
  console.log(`[BINARY] Created paths: stdout=${stdoutPath}, stderr=${stderrPath}`);
  
  const outStream = fs.createWriteStream(stdoutPath, { flags:'a' });
  const errStream = fs.createWriteStream(stderrPath, { flags:'a' });

  try {
    // YAML 컬렉션 파일이 있는지 확인
    if (job.collection) {
      const collectionPath = path.resolve(root, job.collection);
      console.log(`[BINARY] Checking collection: ${collectionPath}`);
      console.log(`[BINARY] Path exists: ${fs.existsSync(collectionPath)}`);
      console.log(`[BINARY] Is YAML file: ${collectionPath.toLowerCase().endsWith('.yaml')}`);
      console.log(`[BINARY] Is directory: ${fs.existsSync(collectionPath) && fs.statSync(collectionPath).isDirectory()}`);
      
      if (fs.existsSync(collectionPath) && collectionPath.toLowerCase().endsWith('.yaml')) {
        console.log(`[BINARY] YAML collection found, delegating to runYamlSClientScenario`);
        
        // YAML 컬렉션을 사용한 SClient 시나리오 실행
        const result = await runYamlSClientScenario(jobName, job, collectionPath, {
          stdoutPath,
          stderrPath,
          txtReport,
          outStream,
          errStream,
          stamp
        });
        
        console.log(`[BINARY] YAML scenario completed, result:`, result);
        return result;
      } else if (fs.existsSync(collectionPath) && fs.statSync(collectionPath).isDirectory()) {
        console.log(`[BINARY] YAML directory found, delegating to runYamlDirectoryBatch`);
        
        // YAML 폴더 배치 실행
        const result = await runYamlDirectoryBatch(jobName, job, collectionPath, {
          stdoutPath,
          stderrPath,
          txtReport,
          outStream,
          errStream,
          stamp
        });
        
        console.log(`[BINARY] YAML directory batch completed, result:`, result);
        return result;
      }
    }

    // 기존 바이너리 실행 로직
    // 바이너리 경로 확인
    const binaryPath = getBinaryPath(job);
    console.log('[BINARY JOB] Binary path:', binaryPath);
    
    // 파일 존재 확인 (플랫폼별 처리)
    const platform = process.platform;
    let checkPath = binaryPath;
    
    if (job.platforms && job.platforms[platform]) {
      // 플랫폼별 설정이 있는 경우는 이미 getBinaryPath에서 처리됨
    } else if (platform === 'win32') {
      // Windows에서 cmd.exe 명령어는 확인하지 않음
      if (!binaryPath.includes('cmd.exe') && !fs.existsSync(binaryPath)) {
        return { started: false, reason: 'binary_not_found', path: binaryPath };
      }
    } else {
      // Linux/macOS에서는 시스템 명령어도 확인
      if (!fs.existsSync(binaryPath)) {
        // 시스템 PATH에서 찾기 시도
        try {
          execSync(`which ${path.basename(binaryPath)}`, { stdio: 'ignore' });
        } catch {
          return { started: false, reason: 'binary_not_found', path: binaryPath };
        }
      }
    }

    const startTime = nowInTZString();
    const startTs = Date.now();

    const runId = registerRunningJob(jobName, startTime, 'binary', null);
    broadcastLog(`[BINARY START] ${jobName}`, jobName);

    // 시작 알람 전송
    await sendAlert('start', {
      jobName,
      startTime,
      executable: path.basename(binaryPath),
      type: 'binary'
    });

    // 인수 준비
    let args = [];
    if (job.platforms && job.platforms[platform]) {
      args = job.platforms[platform].arguments || [];
    } else {
      args = job.arguments || [];
    }

    // 환경변수 치환
    args = args.map(arg => {
      if (typeof arg === 'string' && arg.includes('${')) {
        return arg.replace(/\$\{(\w+)\}/g, (match, envVar) => {
          return job.env?.[envVar] || process.env[envVar] || match;
        });
      }
      return arg;
    });

    const config = readCfg();
    const timeout = job.timeout || config.binary_timeout || 30000;

    return new Promise((resolve) => {
      const proc = spawnBinaryCLI(binaryPath, args);
      // 프로세스 참조를 runningJobs에 저장
      if (state.runningJobs.has(runId)) {
        state.runningJobs.get(runId).proc = proc;
      }
      let stdout = '';
      let stderr = '';
      let errorOutput = '';

      proc.stdout.on('data', d => {
        let s;
        try {
          // Windows에서 Korean 인코딩 처리 (CP949/EUC-KR)
          if (process.platform === 'win32') {
            s = iconv.decode(d, 'cp949');
          } else {
            s = d.toString('utf8');
          }
        } catch (err) {
          // 인코딩 실패시 기본 처리
          s = d.toString();
        }
        stdout += s;
        outStream.write(s);
        s.split(/\r?\n/).forEach(line => {
          if (line) {
            broadcastLog(line, jobName);
          }
        });
      });
      
      proc.stderr.on('data', d => {
        let s;
        try {
          // Windows에서 Korean 인코딩 처리 (CP949/EUC-KR)
          if (process.platform === 'win32') {
            s = iconv.decode(d, 'cp949');
          } else {
            s = d.toString('utf8');
          }
        } catch (err) {
          // 인코딩 실패시 기본 처리
          s = d.toString();
        }
        stderr += s;
        errorOutput += s;
        errStream.write(s);
        s.split(/\r?\n/).forEach(line => {
          if (line) {
            console.log(`[BINARY STDERR] ${jobName}: ${line}`);
            broadcastLog(line, jobName);
          }
        });
      });

      // 타임아웃 처리
      const timeoutHandle = setTimeout(() => {
        if (!proc.killed) {
          console.log(`[BINARY TIMEOUT] Killing process after ${timeout}ms`);
          proc.kill('SIGTERM');
          broadcastLog(`[BINARY TIMEOUT] Process killed after ${timeout}ms`, jobName);
        }
      }, timeout);

      proc.on('close', async (code) => {
        clearTimeout(timeoutHandle);
        
        // 빠른 실행 완료 시 강화된 로그 출력
        console.log(`[BINARY CLOSE] ${jobName} exited with code ${code}`);
        
        // stdout 내용이 있으면 실시간 로그로 전송
        if (stdout.trim()) {
          const lines = stdout.trim().split(/\r?\n/);
          lines.forEach(line => {
            if (line.trim()) {
              console.log(`[BINARY FINAL_STDOUT] ${jobName}: ${line}`);
              broadcastLog(line.trim(), jobName);
            }
          });
        }
        
        // stderr 내용이 있으면 실시간 로그로 전송
        if (stderr.trim()) {
          const lines = stderr.trim().split(/\r?\n/);
          lines.forEach(line => {
            if (line.trim()) {
              console.log(`[BINARY FINAL_STDERR] ${jobName}: ${line}`);
              broadcastLog(line.trim(), jobName);
            }
          });
        }
        
        outStream.end();
        errStream.end();

        const endTime = nowInTZString();
        const durationMs = Date.now() - startTs;
        const duration = Math.round(durationMs / 1000);

        broadcastLog(`[BINARY DONE] ${jobName} completed in ${duration}s with exit code ${code}`, 'SYSTEM');

        // 출력 파싱
        const parseConfig = job.parseOutput || {};
        const parsedResult = parseBinaryOutput(stdout, parseConfig);
        
        // 텍스트 리포트 생성
        const reportContent = [
          `Binary Execution Report`,
          `========================`,
          `Job: ${jobName}`,
          `Binary: ${binaryPath}`,
          `Arguments: ${args.join(' ')}`,
          `Start Time: ${startTime}`,
          `End Time: ${endTime}`,
          `Duration: ${duration}s`,
          `Exit Code: ${code}`,
          ``,
          `STDOUT:`,
          `-------`,
          stdout || '(no output)',
          ``,
          `STDERR:`,
          `-------`,
          stderr || '(no errors)',
          ``,
          `Parsed Result:`,
          `-------------`,
          `Success: ${parsedResult.success}`,
          `Summary: ${parsedResult.summary}`,
          parsedResult.stats ? `Stats: ${JSON.stringify(parsedResult.stats, null, 2)}` : '',
          parsedResult.failures.length > 0 ? `Failures: ${parsedResult.failures.join(', ')}` : ''
        ].filter(line => line !== '').join('\n');

        fs.writeFileSync(txtReport, reportContent);

        // Newman 스타일 리포트 생성 (job 설정에서 요청된 경우)
        let htmlReportPath = null;
        if (job.generateHtmlReport) {
          htmlReportPath = path.join(reportsDir, `${jobName}_${stamp}.html`);
          
          try {
            // binary 결과를 Newman 형식으로 변환하여 리포트 생성
            const newmanReportPath = await generateNewmanStyleBinaryReport({
              jobName,
              binaryPath,
              args,
              startTime,
              endTime,
              duration,
              exitCode: code,
              stdout,
              stderr,
              parsedResult,
              reportOptions: job.reportOptions || {},
              outputPath: htmlReportPath
            });
            
            if (newmanReportPath) {
              htmlReportPath = newmanReportPath;
              console.log(`[BINARY] Newman-style HTML report generated: ${htmlReportPath}`);
            } else {
              // 기존 HTML 리포트로 fallback
              const htmlReportContent = generateBinaryHtmlReport({
                jobName,
                binaryPath,
                args,
                startTime,
                endTime,
                duration,
                exitCode: code,
                stdout,
                stderr,
                parsedResult,
                reportOptions: job.reportOptions || {}
              });
              fs.writeFileSync(htmlReportPath, htmlReportContent);
              console.log(`[BINARY] Standard HTML report generated: ${htmlReportPath}`);
            }
          } catch (error) {
            console.warn(`[BINARY NEWMAN REPORT] Failed to generate Newman-style report: ${error.message}`);
            // 기존 HTML 리포트로 fallback
            const htmlReportContent = generateBinaryHtmlReport({
              jobName,
              binaryPath,
              args,
              startTime,
              endTime,
              duration,
              exitCode: code,
              stdout,
              stderr,
              parsedResult,
              reportOptions: job.reportOptions || {}
            });
            fs.writeFileSync(htmlReportPath, htmlReportContent);
            console.log(`[BINARY] Fallback HTML report generated: ${htmlReportPath}`);
          }
        }

        // 히스토리 저장 (비동기 - 이벤트 루프 블로킹 방지)
        const historyEntry = {
          timestamp: endTime,
          job: jobName,
          runId: runId,
          type: 'binary',
          exitCode: code,
          summary: parsedResult.summary,
          report: txtReport,
          htmlReport: htmlReportPath,
          stdout: path.basename(stdoutPath),
          stderr: path.basename(stderrPath),
          tags: ['binary'],
          duration: duration,
          durationMs: durationMs,
          binaryPath: binaryPath,
          arguments: args,
          parsedResult: parsedResult
        };

        await histAppend(historyEntry);
        cleanupOldReports();
        
        // 히스토리 저장 후 추가 상태 확인 및 초기화
        console.log(`[HIST_SAVE] Binary job ${jobName} saved to history, checking state...`);
        if (state.runningJobs.has(runId)) {
          console.log(`[HIST_SAVE] Cleaning up runningJobs for ${jobName} (runId=${runId})`);
          unregisterRunningJob(runId);
        }
        
        // 강화된 History 업데이트 신호
        console.log(`[HISTORY_UPDATE] Binary job ${jobName} history updated`);
        broadcastLog(`[HISTORY_UPDATE] Job completed and history updated`, 'SYSTEM');
        
        // 지연된 완료 신호 전송 (SSE 완전 전송 보장)
        setTimeout(() => {
          broadcastLog(`[EXECUTION_COMPLETE] ${jobName} - All logs processed`, 'SYSTEM');
        }, 100);

        // 알람 데이터 준비
        const alertData = {
          jobName,
          startTime,
          endTime,
          duration,
          exitCode: code,
          executable: path.basename(binaryPath),
          arguments: args.join(' '),
          summary: parsedResult.summary,
          success: parsedResult.success,
          type: 'binary',
          reportPath: fs.existsSync(txtReport) ? txtReport : null,
          // stdout(RES) 내용 포함 - URL 디코딩 적용
          stdout: decodeUrlEncodedContent(stdout || ''),
          stderr: stderr || ''
        };

        if (!parsedResult.success && parsedResult.failures.length > 0) {
          alertData.errorSummary = parsedResult.failures.slice(0, 3).join('; ');
          // 실패 리포트에 RES 내용과 Assertion 실패 원인 포함
          alertData.failureReport = buildBinaryFailureReport(stdout, stderr, parsedResult);
        }

        // 결과에 따른 알람 전송
        if (code === 0 && parsedResult.success) {
          await sendAlert('success', alertData);
        } else {
          await sendAlert('error', alertData);
        }

        // 통합 완료 처리 함수 사용 (완료를 기다림)
        finalizeJobCompletion(runId, code, parsedResult.success).then(() => {
          resolve({ started: true, exitCode: code, success: parsedResult.success });
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timeoutHandle);
        console.error('[BINARY ERROR]', error);
        outStream.end();
        errStream.end();

        finalizeJobCompletion(runId, -1, false).then(() => {
          resolve({ started: false, reason: 'spawn_error', error: error.message });
        });
      });
    });

  } catch (error) {
    console.error('[BINARY JOB ERROR]', error);
    outStream.end();
    errStream.end();
    
    await finalizeJobCompletion(jobName, -1, false);
    
    return { started: false, reason: 'job_error', error: error.message };
  }
}

export { runBinaryJob };
