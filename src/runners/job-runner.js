// src/runners/job-runner.js
// Job 실행 함수들 (runJob, runBinaryJob, runYamlSClientScenario, runSingleYamlFile, runYamlDirectoryBatch, runSClientScenarioJob)
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import { execSync } from 'child_process';
import { root, reportsDir, logsDir, readCfg } from '../utils/config.js';
import { nowInTZString, kstTimestamp } from '../utils/time.js';
import { debugLog, batchLog, matchPattern } from '../utils/debug.js';
import { broadcastState, broadcastLog } from '../utils/sse.js';
import { state, registerRunningJob, unregisterRunningJob, broadcastRunningJobs, finalizeJobCompletion } from '../state/running-jobs.js';
import { histRead, histWrite } from '../services/history-service.js';
import { cleanupOldReports } from '../services/log-manager.js';
import { sendAlert, buildNewmanFailureReport, buildBinaryFailureReport, buildYamlScenarioFailureReport, buildBatchFailureReport } from '../services/alert-integration.js';
import { parseBinaryOutput } from '../parsers/binary-parser.js';
import { decodeUrlEncodedContent, processResponseBody } from '../utils/crypto.js';
import { generateNewmanStyleBinaryReport, generateBinaryHtmlReport, generateSimpleBatchReport } from '../services/report-generator.js';
import { spawnNewmanCLI, getBinaryPath, spawnBinaryCLI } from './spawn-helpers.js';
import { SClientScenarioEngine, SClientReportGenerator } from '../../sclient-engine.js';
import { validateTestsWithYamlData } from '../../sclient-test-validator.js';
async function runJob(jobName, fromSchedule = false){
  console.log(`[RUNJOB] Starting job execution: ${jobName}, fromSchedule: ${fromSchedule}`);
  
  // 같은 이름의 job이 이미 실행 중이면 차단 (다른 job은 허용)
  if (state.runningJobs.has(jobName) && !state.batchMode) {
    console.log(`[RUNJOB] Job rejected - same job already running: ${jobName}`);
    return { started:false, reason:'already_running' };
  }
  
  // 스케줄 실행일 때는 동시 실행 허용
  if (fromSchedule) {
    console.log(`[RUNJOB] Schedule execution - allowing concurrent execution for: ${jobName}`);
  }
  
  // 배치 모드일 때는 중복 실행 허용
  if (state.batchMode) {
    console.log(`[RUNJOB] Batch mode enabled - allowing concurrent execution for: ${jobName}`);
  }

  const jobPath = path.join(root, 'jobs', `${jobName}.json`);
  if (!fs.existsSync(jobPath)) {
    console.log(`[RUNJOB] Job file not found: ${jobPath}`);
    return { started:false, reason:'job_not_found' };
  }
  
  const job = JSON.parse(fs.readFileSync(jobPath,'utf-8'));
  console.log(`[RUNJOB] Job loaded, type: ${job.type}`);
  
  if (!['newman', 'binary', 'sclient_scenario'].includes(job.type)) {
    console.log(`[RUNJOB] Unsupported job type: ${job.type}`);
    return { started:false, reason:'unsupported_type' };
  }

  // 바이너리/시나리오 타입은 위임 전에 먼저 runningJob 등록
  // (클라이언트가 500ms 후 fetchRunningJobs 호출 시 이미 등록되어 있어야 Run 버튼이 계속 비활성 상태 유지)
  if (job.type === 'binary' || job.type === 'sclient_scenario') {
    const earlyStartTime = nowInTZString();
    registerRunningJob(jobName, earlyStartTime, job.type, null);
    console.log(`[RUNJOB] Early registered running job: ${jobName} (type: ${job.type})`);
  }

  // 바이너리 타입 처리
  if (job.type === 'binary') {
    console.log(`[RUNJOB] Delegating to runBinaryJob: ${jobName}`);
    return await runBinaryJob(jobName, job);
  }
  
  // SClient 시나리오 타입 처리
  if (job.type === 'sclient_scenario') {
    return await runSClientScenarioJob(jobName, job);
  }

  const collection  = path.resolve(root, job.collection);
  const environment = job.environment ? path.resolve(root, job.environment) : undefined;
  const reporters   = job.reporters?.length ? job.reporters : ['cli','htmlextra','junit','json'];
  const stamp = kstTimestamp();

  const htmlReport = path.join(reportsDir, `${jobName}_${stamp}.html`);
  const junitReport= path.join(reportsDir, `${jobName}_${stamp}.xml`);
  const jsonReport = path.join(reportsDir, `${jobName}_${stamp}.json`);
  const stdoutPath = path.join(logsDir, `stdout_${jobName}_${stamp}.log`);
  const stderrPath = path.join(logsDir, `stderr_${jobName}_${stamp}.log`);
  const cliExport  = path.join(logsDir, `cli_${jobName}_${stamp}.txt`);
  
  const outStream  = fs.createWriteStream(stdoutPath, { flags:'a' });
  const errStream  = fs.createWriteStream(stderrPath, { flags:'a' });

  if (!fs.existsSync(collection)) return { started:false, reason:'collection_not_found' };
  if (environment && !fs.existsSync(environment)) return { started:false, reason:'environment_not_found' };

  const startTime = nowInTZString();
  const startTs = Date.now();

  registerRunningJob(jobName, startTime, 'newman', null);
  broadcastLog(`[START] ${jobName}`, jobName);

  // 시작 알람 전송
  await sendAlert('start', {
    jobName,
    startTime,
    collection: path.basename(collection),
    environment: environment ? path.basename(environment) : null
  });

  const args = [
    'newman','run', collection,
    '--verbose',
    '-r', reporters.join(','),
    '--reporter-htmlextra-export', htmlReport,
    '--reporter-junit-export',     junitReport,
    '--reporter-json-export',      jsonReport,
    '--reporter-cli-export',       cliExport
  ];
  
  if (environment) args.push('-e', environment);
  if (Array.isArray(job.extra)) args.push(...job.extra);

  return new Promise((resolve)=>{
    const proc = spawnNewmanCLI(args);
    // 프로세스 참조를 runningJobs에 저장
    if (state.runningJobs.has(jobName)) {
      state.runningJobs.get(jobName).proc = proc;
    }
    let errorOutput = '';

    proc.stdout.on('data', d => {
      const s = d.toString();
      console.log('[NEWMAN STDOUT]', s.substring(0, 100) + '...');
      outStream.write(s);
      s.split(/\r?\n/).forEach(line => {
        if (line) {
          console.log('[NEWMAN STDOUT LINE]', line.substring(0, 50) + '...');
          broadcastLog(line, jobName);
        }
      });
    });
    
    proc.stderr.on('data', d => {
      const s = d.toString();
      console.log('[NEWMAN STDERR]', s.substring(0, 100) + '...');
      errStream.write(s);
      errorOutput += s; // 에러 내용 수집
      s.split(/\r?\n/).forEach(line => {
        if (line) {
          console.log('[NEWMAN STDERR LINE]', line.substring(0, 50) + '...');
          broadcastLog(line, jobName);
        }
      });
    });
    


// runJob 함수의 proc.on('close') 부분을 이렇게 개선하세요:

proc.on('close', async (code) => {
  outStream.end(); 
  errStream.end();
  
  const endTime = nowInTZString();
  const duration = Math.round((Date.now() - startTs) / 1000);
  
  broadcastLog(`[DONE] ${jobName} exit=${code}`, jobName);

  // Newman JSON 리포트에서 상세 통계 정보 추출
  let summary = `exit=${code}`;
  let newmanStats = null;
  let detailedStats = null;
  let failureDetails = [];
  
  try {
    if (fs.existsSync(jsonReport)) {
      const jsonData = JSON.parse(fs.readFileSync(jsonReport, 'utf-8'));
      const run = jsonData.run;
      
      if (run && run.stats) {
        const stats = run.stats;
        const requests = stats.requests || {};
        const assertions = stats.assertions || {};
        const testScripts = stats.testScripts || {};
        const prerequestScripts = stats.prerequestScripts || {};
        const iterations = stats.iterations || {};
        
        // 기본 Newman 통계
        newmanStats = {
          requests: {
            total: requests.total || 0,
            failed: requests.failed || 0,
            pending: requests.pending || 0
          },
          assertions: {
            total: assertions.total || 0,
            failed: assertions.failed || 0,
            pending: assertions.pending || 0
          },
          testScripts: {
            total: testScripts.total || 0,
            failed: testScripts.failed || 0,
            pending: testScripts.pending || 0
          },
          prerequestScripts: {
            total: prerequestScripts.total || 0,
            failed: prerequestScripts.failed || 0,
            pending: prerequestScripts.pending || 0
          },
          iterations: {
            total: iterations.total || 0,
            failed: iterations.failed || 0,
            pending: iterations.pending || 0
          },
          // timings 정보 추가
          timings: {
            responseAverage: run.timings?.responseAverage || 0,
            responseMin: run.timings?.responseMin || 0,
            responseMax: run.timings?.responseMax || 0,
            responseTotal: run.timings?.responseTotal || 0
          },
          // summary 정보 (buildNewmanFailureReport에서 사용)
          summary: {
            requests: { total: requests.total || 0, failed: requests.failed || 0 },
            assertions: { total: assertions.total || 0, failed: assertions.failed || 0 }
          },
          successRate: 0 // 아래에서 계산
        };

        // 성공률 계산
        const totalItems = (requests.total || 0) + (assertions.total || 0);
        const failedItems = (requests.failed || 0) + (assertions.failed || 0);
        if (totalItems > 0) {
          newmanStats.successRate = Math.round(((totalItems - failedItems) / totalItems) * 100);
        } else {
          newmanStats.successRate = 100;
        }

        // 상세 통계 계산
        detailedStats = {
          totalExecuted: (requests.total || 0) + (assertions.total || 0) + (testScripts.total || 0),
          totalFailed: (requests.failed || 0) + (assertions.failed || 0) + (testScripts.failed || 0),
          successRate: 0,
          avgResponseTime: run.timings?.responseAverage || 0,
          totalDuration: run.timings?.responseTotal || duration * 1000
        };
        
        if (detailedStats.totalExecuted > 0) {
          detailedStats.successRate = Math.round(((detailedStats.totalExecuted - detailedStats.totalFailed) / detailedStats.totalExecuted) * 100);
        }
        
        // 실패 상세 정보 수집
        if (run.failures && run.failures.length > 0) {
          failureDetails = run.failures.slice(0, 5).map(failure => ({
            test: failure.source?.name || 'Unknown Test',
            error: failure.error?.message || 'Unknown Error',
            assertion: failure.error?.test || null,
            request: failure.source?.request?.name || null
          }));
        }

        // 실패한 요청의 Response Body 추출 (executions에서)
        const executions = run.executions || [];
        const failedExecutions = [];
        for (const execution of executions) {
          const hasFailedAssertion = execution.assertions?.some(a => a.error);
          const hasFailedRequest = execution.requestError;

          if (hasFailedAssertion || hasFailedRequest) {
            // Response Body 추출 (stream.data에서)
            let responseBody = '';
            if (execution.response?.stream?.data) {
              try {
                responseBody = Buffer.from(execution.response.stream.data).toString('utf-8');
              } catch (e) {
                responseBody = '';
              }
            }

            failedExecutions.push({
              name: execution.item?.name || 'Unknown Request',
              request: {
                url: execution.request?.url?.toString() || '',
                method: execution.request?.method || '',
                body: execution.request?.body?.raw || ''
              },
              response: {
                status: execution.response?.code || 0,
                statusText: execution.response?.status || '',
                body: processResponseBody(responseBody, jobName), // 복호화 시도 포함
                responseTime: execution.response?.responseTime || 0
              },
              assertions: (execution.assertions || []).map(a => ({
                name: a.assertion,
                passed: !a.error,
                error: a.error?.message || null
              })),
              error: execution.requestError?.message || null
            });
          }
        }

        // newmanStats에 failedExecutions 추가
        if (failedExecutions.length > 0) {
          newmanStats.failedExecutions = failedExecutions;
          console.log(`[NEWMAN] Found ${failedExecutions.length} failed executions with response bodies`);
        }
        
        // Summary 생성: 더 세분화된 정보
        /*
        if (code === 0) {
          // 성공한 경우
          const parts = [];
          
          if (assertions.total > 0) {
            if (assertions.failed === 0) {
              parts.push(`All ${assertions.total} Assertions Passed`);
            } else {
              parts.push(`${assertions.total - assertions.failed}/${assertions.total} Assertions Passed`);
            }
          }
          
          if (requests.total > 0) {
            if (requests.failed === 0) {
              parts.push(`All ${requests.total} Requests Succeeded`);
            } else {
              parts.push(`${requests.total - requests.failed}/${requests.total} Requests Succeeded`);
            }
          }
          
          if (testScripts.total > 0) {
            if (testScripts.failed === 0) {
              parts.push(`All ${testScripts.total} Tests Passed`);
            } else {
              parts.push(`${testScripts.total - testScripts.failed}/${testScripts.total} Tests Passed`);
            }
          }
          
          // 성공률 추가
          if (detailedStats.successRate < 100) {
            parts.push(`Success Rate: ${detailedStats.successRate}%`);
          }
          
          summary = parts.length > 0 ? parts.join(', ') : 'All Tests Completed Successfully';
        } else {
          // 실패한 경우
          const failureParts = [];
          
          if (assertions.failed > 0) {
            failureParts.push(`${assertions.failed}/${assertions.total} Assertions Failed`);
          }
          if (requests.failed > 0) {
            failureParts.push(`${requests.failed}/${requests.total} Requests Failed`);
          }
          if (testScripts.failed > 0) {
            failureParts.push(`${testScripts.failed}/${testScripts.total} Tests Failed`);
          }
          
          if (failureParts.length > 0) {
            summary = failureParts.join(', ');
            // 성공률이 낮으면 추가 정보
            if (detailedStats.successRate < 50) {
              summary += ` (Success Rate: ${detailedStats.successRate}%)`;
            }
          } else {
            // Newman 통계는 있지만 구체적 실패 정보가 없는 경우
            const totalParts = [];
            if (assertions.total > 0) totalParts.push(`${assertions.total} Assertions`);
            if (requests.total > 0) totalParts.push(`${requests.total} Requests`);
            if (testScripts.total > 0) totalParts.push(`${testScripts.total} Tests`);
            
            summary = totalParts.length > 0 ? 
              `Test Failed - ${totalParts.join(', ')} Executed` : 
              `Process Failed (exit=${code})`;
          }
        }
          */
         function generateImprovedSummary(stats, timings, code, failures = []) {
  const requests = stats.requests || {};
  const assertions = stats.assertions || {};
  const testScripts = stats.testScripts || {};
  
  const totalRequests = requests.total || 0;
  const failedRequests = requests.failed || 0;
  const totalAssertions = assertions.total || 0;
  const failedAssertions = assertions.failed || 0;
  const totalTests = testScripts.total || 0;
  const failedTests = testScripts.failed || 0;
  
  const avgResponseTime = timings?.responseAverage || 0;
  
  // 성공한 경우
  if (code === 0) {
    const parts = [];
    
    // 핵심 성공 정보만 간결하게
    if (totalRequests > 0) {
      parts.push(`✅ ${totalRequests} API calls`);
    }
    
    if (totalAssertions > 0) {
      parts.push(`${totalAssertions} validations`);
    }
    
    if (totalTests > 0) {
      parts.push(`${totalTests} tests`);
    }
    
    // 응답시간 추가 (의미있는 값일 때만)
    if (avgResponseTime >= 50) {
      parts.push(`avg ${Math.round(avgResponseTime)}ms`);
    }
    
    return parts.length > 0 ? parts.join(' • ') : '✅ Execution completed';
  }
  
  // 실패한 경우 - 더 상세하고 유용한 정보
  const issues = [];
  const details = [];
  
  if (failedRequests > 0) {
    if (failedRequests === totalRequests) {
      issues.push(`❌ All ${totalRequests} API calls failed`);
    } else {
      issues.push(`❌ ${failedRequests}/${totalRequests} API calls failed`);
      details.push(`${totalRequests - failedRequests} API calls succeeded`);
    }
  }
  
  if (failedAssertions > 0) {
    if (failedAssertions === totalAssertions) {
      issues.push(`⚠️ All ${totalAssertions} validations failed`);
    } else {
      issues.push(`⚠️ ${failedAssertions}/${totalAssertions} validations failed`);
      details.push(`${totalAssertions - failedAssertions} validations passed`);
    }
  }
  
  if (failedTests > 0) {
    if (failedTests === totalTests) {
      issues.push(`🚫 All ${totalTests} tests failed`);
    } else {
      issues.push(`🚫 ${failedTests}/${totalTests} tests failed`);
      details.push(`${totalTests - failedTests} tests passed`);
    }
  }
 
  // 응답시간 정보 (실패해도 유용함)
  if (avgResponseTime >= 100) {
    details.push(`avg ${Math.round(avgResponseTime)}ms`);
  }
  
  // 성공률 계산 및 추가
  const totalItems = totalRequests + totalAssertions + totalTests;
  const failedItems = failedRequests + failedAssertions + failedTests;
  
  if (totalItems > 0) {
    const successRate = Math.round(((totalItems - failedItems) / totalItems) * 100);
    if (successRate > 0) {
      details.push(`${successRate}% success rate`);
    }
  }
  
  // 최종 조합
  if (issues.length === 0) {
    return `❌ Process failed (exit code: ${code})`;
  }
  
  let summary = issues.join(' • ');
  if (details.length > 0) {
    // 가장 중요한 상세 정보 2-3개만 추가
    const importantDetails = details.slice(0, 3);
    summary += ` | ${importantDetails.join(', ')}`;
  }
  
  return summary;
}

// Summary 생성 - 개선된 함수 사용 (failures 정보도 전달)
summary = generateImprovedSummary(stats, run.timings, code, run.failures || []);
      }
    }
  } catch (error) {
    console.error('[NEWMAN STATS PARSE ERROR]', error);
    summary = `Parse Error (exit=${code})`;
  }

  // CLI 출력에서 추가 실패 정보 추출
  let errorSummary = null;
  let failureReport = null;
  let detailedFailures = [];
  
  if (code !== 0) {
  try {
    const output = fs.readFileSync(stdoutPath, 'utf-8');
    
    // # failure detail 섹션 찾기
    const failureDetailMatch = output.match(/# failure detail\s*\n([\s\S]*?)(?=\n# |$)/);
    
    if (failureDetailMatch) {
      const failureSection = failureDetailMatch[1];
      
      // 각 실패 항목 파싱 (1. 2. 3. ... 형태)
      const failureBlocks = failureSection.match(/\d+\.\s+.*?(?=\n\d+\.|\n\n|$)/gs);
      
      if (failureBlocks) {
        detailedFailures = failureBlocks.map((block, index) => {
          const lines = block.trim().split('\n');
          const firstLine = lines[0].replace(/^\d+\.\s*/, ''); // "1. " 부분 제거
          
          // 첫 번째 라인에서 테스트 정보 추출
          let testName = 'Unknown Test';
          let requestName = 'Unknown Request';
          let errorType = 'Error';
          
          // 패턴 매칭으로 정보 추출
          if (firstLine.includes(' | ')) {
            const parts = firstLine.split(' | ');
            if (parts.length >= 2) {
              testName = parts[0].trim();
              requestName = parts[1].trim();
            }
          } else {
            testName = firstLine;
          }
          
          // 에러 타입 확인
          if (firstLine.includes('AssertionError')) {
            errorType = 'Assertion Failed';
          } else if (firstLine.includes('Error')) {
            errorType = 'Request Error';
          }
          
          // 상세 내용 추출 (2번째 줄부터)
          const detailLines = lines.slice(1).filter(line => line.trim().length > 0);
          let errorDetails = '';
          let expectedValue = '';
          let actualValue = '';
          
          detailLines.forEach(line => {
            const trimmedLine = line.trim();
            
            if (trimmedLine.startsWith('expected')) {
              expectedValue = trimmedLine.replace(/^expected\s*/, '');
            } else if (trimmedLine.startsWith('actual')) {
              actualValue = trimmedLine.replace(/^actual\s*/, '');
            } else if (trimmedLine.startsWith('at ')) {
              // Stack trace 정보는 제외
            } else if (trimmedLine.length > 0) {
              if (!errorDetails) {
                errorDetails = trimmedLine;
              }
            }
          });
          
          return {
            index: index + 1,
            testName: testName,
            requestName: requestName,
            errorType: errorType,
            errorDetails: errorDetails,
            expectedValue: expectedValue,
            actualValue: actualValue,
            fullBlock: block.trim()
          };
        });
      }
      
      // 요약용 에러 생성
      if (detailedFailures.length > 0) {
        const firstFailure = detailedFailures[0];
        errorSummary = `${firstFailure.errorType}: ${firstFailure.testName}`;
        
        if (detailedFailures.length > 1) {
          errorSummary += ` (+ ${detailedFailures.length - 1} more failures)`;
        }
        
        // 상세 실패 리포트 생성
        const reportLines = [`=== Detailed Failure Analysis (${detailedFailures.length} failures) ===\n`];
        
        detailedFailures.slice(0, 5).forEach(failure => { // 최대 5개까지
          reportLines.push(`${failure.index}. ${failure.testName}`);
          reportLines.push(`   Request: ${failure.requestName}`);
          reportLines.push(`   Type: ${failure.errorType}`);
          
          if (failure.errorDetails) {
            reportLines.push(`   Error: ${failure.errorDetails}`);
          }
          
          if (failure.expectedValue && failure.actualValue) {
            reportLines.push(`   Expected: ${failure.expectedValue}`);
            reportLines.push(`   Actual: ${failure.actualValue}`);
          }
          
          reportLines.push(''); // 빈 줄로 구분
        });
        
        if (detailedFailures.length > 5) {
          reportLines.push(`... and ${detailedFailures.length - 5} more failures. See full report for details.`);
        }
        
        failureReport = reportLines.join('\n');
      }
    }
    
    // failure detail이 없으면 일반 에러 라인에서 추출
    if (!detailedFailures.length) {
      const errorLines = output.split('\n')
        .filter(line => line.trim() && 
          (line.includes('AssertionError') || 
           line.includes('Error:') || 
           line.includes('failed') ||
           line.includes('✗'))) // Newman의 실패 마크
        .slice(0, 10); // 최대 10개 라인
      
      if (errorLines.length > 0) {
        errorSummary = errorLines[0].trim();
        failureReport = `Error Output:\n${errorLines.join('\n')}`;
      } else {
        errorSummary = `Process exited with code ${code}`;
      }
    }
    
  } catch (error) {
    console.log('[CLI PARSE ERROR]', error);
    errorSummary = `Parse error: ${error.message}`;
  }
}

  // history 저장
  const history = histRead();
  const historyEntry = {
    timestamp: endTime,
    job: jobName,
    type: job.type,
    exitCode: code,
    summary: summary, // 개선된 summary 사용
    report: htmlReport,
    stdout: path.basename(stdoutPath),
    stderr: path.basename(stderrPath),
    tags: [],
    duration: duration,
    // 상세 Newman 통계 추가
    newmanStats: newmanStats,
    detailedStats: detailedStats
  };
  
  history.push(historyEntry);
  
  const { history_keep = 500 } = readCfg();
  if (history_keep > 0 && history.length > history_keep) {
    history.splice(0, history.length - history_keep);
  }

  histWrite(history);
  cleanupOldReports();

  // 히스토리 저장 후 추가 상태 확인 및 초기화
  console.log(`[HIST_SAVE] Newman job ${jobName} saved to history, checking state...`);
  if (state.runningJobs.has(jobName)) {
    console.log(`[HIST_SAVE] Cleaning up runningJobs for ${jobName}`);
    unregisterRunningJob(jobName);
  }

  // 알람 데이터 준비 - 훨씬 풍부한 정보 포함
  const alertData = {
    jobName,
    startTime,
    endTime,
    duration,
    exitCode: code,
    collection: path.basename(collection),
    environment: environment ? path.basename(environment) : null,

    // 기본 오류 정보
    errorSummary,
    // Response Body 포함한 상세 실패 리포트 생성
    failureReport: code !== 0 ? buildNewmanFailureReport(newmanStats, detailedFailures) : failureReport,

    // Newman 상세 통계
    newmanStats: newmanStats,
    detailedStats: detailedStats,

    // 상세 실패 정보 (CLI에서 파싱한 것과 JSON에서 파싱한 것 모두)
    failureDetails: failureDetails,
    detailedFailures: detailedFailures,
    // 실패한 요청들의 Response Body 포함
    failedExecutions: newmanStats?.failedExecutions || [],

    // 성능 정보
    performanceInfo: {
      avgResponseTime: detailedStats?.avgResponseTime || 0,
      totalDuration: detailedStats?.totalDuration || duration * 1000,
      successRate: detailedStats?.successRate || 0
    },

    // 요약 정보
    summaryText: summary,

    // 리포트 경로
    reportPath: fs.existsSync(htmlReport) ? htmlReport : null
  };

  // 결과에 따른 알람 전송
  if (code === 0) {
    await sendAlert('success', alertData);
  } else {
    await sendAlert('error', alertData);
  }

  // 통합 완료 처리 함수 사용 (완료를 기다림)
  await finalizeJobCompletion(jobName, code);
  
  // Newman HTML 리포트에 다크모드 토글 추가 (원래 Newman HTMLExtra 리포트 유지)
  // if (fs.existsSync(htmlReport)) {
  //   addDarkModeToggleToHtml(htmlReport);
  // }
  
  resolve({ started: true, exitCode: code });
});
  });
}

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

    registerRunningJob(jobName, startTime, 'binary', null);
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
      if (state.runningJobs.has(jobName)) {
        state.runningJobs.get(jobName).proc = proc;
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
        const duration = Math.round((Date.now() - startTs) / 1000);

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

        // 히스토리 저장
        const history = histRead();
        const historyEntry = {
          timestamp: endTime,
          job: jobName,
          type: 'binary',
          exitCode: code,
          summary: parsedResult.summary,
          report: txtReport,
          htmlReport: htmlReportPath,
          stdout: path.basename(stdoutPath),
          stderr: path.basename(stderrPath),
          tags: ['binary'],
          duration: duration,
          binaryPath: binaryPath,
          arguments: args,
          parsedResult: parsedResult
        };

        history.push(historyEntry);

        const { history_keep = 500 } = readCfg();
        if (history_keep > 0 && history.length > history_keep) {
          history.splice(0, history.length - history_keep);
        }

        histWrite(history);
        cleanupOldReports();
        
        // 히스토리 저장 후 추가 상태 확인 및 초기화
        console.log(`[HIST_SAVE] Binary job ${jobName} saved to history, checking state...`);
        if (state.runningJobs.has(jobName)) {
          console.log(`[HIST_SAVE] Cleaning up runningJobs for ${jobName}`);
          unregisterRunningJob(jobName);
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
        finalizeJobCompletion(jobName, code, parsedResult.success).then(() => {
          resolve({ started: true, exitCode: code, success: parsedResult.success });
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timeoutHandle);
        console.error('[BINARY ERROR]', error);
        outStream.end();
        errStream.end();

        finalizeJobCompletion(jobName, -1, false).then(() => {
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

// YAML 컬렉션을 사용한 SClient 시나리오 실행 함수
async function runYamlSClientScenario(jobName, job, collectionPath, paths) {
  console.log(`[YAML] Starting YAML scenario: ${jobName}`);
  console.log(`[YAML] Collection path: ${collectionPath}`);
  console.log(`[YAML] Job timeout: ${job.timeout || 15000}ms`);
  
  const { stdoutPath, stderrPath, txtReport, outStream, errStream, stamp } = paths;
  
  return new Promise(async (resolve) => {
    console.log(`[YAML] Promise wrapper created for ${jobName}`);
    
    try {
      console.log(`[YAML] Importing modules...`);
      
      // YAML 파서와 SClient 엔진 import
      const { SClientYAMLParser } = await import('../../simple-yaml-parser.js');
      const { SClientScenarioEngine, SClientReportGenerator } = await import('../../sclient-engine.js');
      
      console.log(`[YAML] Modules imported successfully`);
      console.log('[YAML SCENARIO] Loading YAML collection:', collectionPath);
      
      // YAML 파일을 JSON 시나리오로 변환 (변수 치환 포함)
      const yamlContent = fs.readFileSync(collectionPath, 'utf-8');
      const scenario = SClientYAMLParser.parseYamlToScenario(yamlContent);
      console.log('[YAML SCENARIO] Parsed scenario:', scenario.info.name);
      
      // SClient 바이너리 경로 확인
      const binaryPath = getBinaryPath(job);
      if (!fs.existsSync(binaryPath)) {
        resolve({ started: false, reason: 'binary_not_found', path: binaryPath });
        return;
      }
      
      const startTime = nowInTZString();
      const startTs = Date.now();
      
      registerRunningJob(jobName, startTime, 'yaml_scenario', null);
      broadcastLog(`[YAML SCENARIO START] ${jobName} - ${scenario.info.name}`, jobName);
      
      // 시작 알람 전송
      await sendAlert('start', {
        jobName,
        startTime,
        collection: path.basename(collectionPath),
        type: 'yaml_scenario'
      });
      
      // SClient 엔진 초기화
      const engine = new SClientScenarioEngine({
        binaryPath,
        timeout: job.timeout || 30000,
        encoding: job.encoding || 'cp949'
      });
      
      // 실시간 로그 이벤트 연결
      engine.on('log', (data) => {
        outStream.write(data.message + '\n');
        broadcastLog(data.message, jobName);
      });
    
    engine.on('stdout', (data) => {
      outStream.write(data.text);
      const lines = data.text.split(/\r?\n/);
      lines.forEach(line => {
        if (line.trim()) {
          broadcastLog(`[${data.step}] ${line.trim()}`, jobName);
        }
      });
    });
    
    engine.on('stderr', (data) => {
      errStream.write(data.text);
      const lines = data.text.split(/\r?\n/);
      lines.forEach(line => {
        if (line.trim()) {
          broadcastLog(`[${data.step} ERROR] ${line.trim()}`, jobName);
        }
      });
    });
    
    // 임시 시나리오 파일 생성 (SClient 엔진용)
    const tempScenarioPath = path.join(root, 'temp', `scenario_${jobName}_${stamp}.json`);
    const tempDir = path.dirname(tempScenarioPath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    fs.writeFileSync(tempScenarioPath, JSON.stringify(scenario, null, 2));
    
    try {
      console.log(`[YAML] Starting scenario execution with timeout: ${job.timeout || 15000}ms`);
      
      // 시나리오 실행 (타임아웃 적용)
      const scenarioPromise = engine.runScenario(tempScenarioPath);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Scenario execution timeout')), 
                  job.timeout || 15000);
      });
      
      console.log(`[YAML] Promise.race started, waiting for completion...`);
      const scenarioResult = await Promise.race([scenarioPromise, timeoutPromise]);
      console.log(`[YAML] Scenario execution completed, success: ${scenarioResult.success}`);
      
      // 공통 테스트 검증 모듈 적용 - run-yaml.js와 동일한 검증 로직 사용
      try {
        const yamlContent = fs.readFileSync(collectionPath, 'utf8');
        const { load } = await import('js-yaml');
        const yamlData = load(yamlContent);
        const validatedResult = validateTestsWithYamlData(scenarioResult, yamlData);
        console.log(`[YAML] Test validation completed - Updated success: ${validatedResult.success}`);
        
        // 검증 결과로 시나리오 결과 업데이트
        Object.assign(scenarioResult, validatedResult);
      } catch (validateError) {
        console.log(`[YAML] Test validation failed, using original results: ${validateError.message}`);
      }
      
      const endTime = nowInTZString();
      const duration = Math.round((Date.now() - startTs) / 1000);
      console.log(`[YAML] Execution duration: ${duration}s`);
      
      broadcastLog(`[YAML SCENARIO DONE] ${jobName} completed in ${duration}s`, 'SYSTEM');
      
      // Promise resolve를 먼저 실행하여 blocking 방지
      console.log(`[YAML] Preparing result data for immediate resolve`);
      const resultData = { 
        started: true, 
        exitCode: scenarioResult.success ? 0 : 1, 
        success: scenarioResult.success,
        scenarioResult
      };
      
      // 비동기적으로 리포트 생성 및 정리 작업 수행
      console.log(`[YAML] Starting async cleanup operations`);
      setImmediate(async () => {
        console.log(`[YAML] Async cleanup started`);
        try {
          outStream.end();
          errStream.end();
          
          // Newman 스타일 HTML 리포트 생성
          const htmlReport = path.join(reportsDir, `${jobName}_${stamp}.html`);
          
          try {
            // Newman 컨버터 사용하여 Newman 스타일 리포트 생성
            const { SClientToNewmanConverter } = await import('../../newman-converter.js');
            const converter = new SClientToNewmanConverter();
            
            console.log(`[BATCH_HTML] Converting ${jobName} to Newman format...`);
            const newmanRun = converter.convertToNewmanRun(scenarioResult);
            console.log(`[BATCH_HTML] Newman run executions:`, (newmanRun.executions || []).length);
            
            console.log(`[BATCH_HTML] Generating Newman style HTML for ${jobName}...`);
            await converter.generateNewmanStyleHTML(newmanRun.run, htmlReport, {
              title: `${jobName} Test Report`,
              browserTitle: `${jobName} Report`
            });
            console.log(`[BATCH_HTML] ✅ Newman style HTML generated successfully for ${jobName}`);
            
          } catch (error) {
            console.warn(`[YAML NEWMAN REPORT] Error generating Newman report: ${error.message}`);
            const htmlContent = SClientReportGenerator.generateHTMLReport(scenarioResult);
            fs.writeFileSync(htmlReport, htmlContent);
          }
          
          // 텍스트 리포트 생성
          const txtContent = SClientReportGenerator.generateTextReport(scenarioResult);
          fs.writeFileSync(txtReport, txtContent);
          
          // 히스토리 저장
          const history = histRead();
          const historyEntry = {
            timestamp: endTime,
            job: jobName,
            type: 'binary', // binary 타입으로 유지
            exitCode: scenarioResult.success ? 0 : 1,
            summary: `${scenarioResult.summary.passed}/${scenarioResult.summary.total} steps passed`,
            report: path.join(reportsDir, `${jobName}_${stamp}.html`),
            stdout: path.basename(stdoutPath),
            stderr: path.basename(stderrPath),
            tags: ['binary', 'yaml', 'scenario'],
            duration: duration,
            scenarioResult: {
              name: scenario.info.name,
              passed: scenarioResult.summary.passed,
              failed: scenarioResult.summary.failed,
              total: scenarioResult.summary.total,
              success: scenarioResult.success
            },
            // Binary Job의 detailedStats 추가 (평균 응답시간 계산을 위해)
            detailedStats: {
              totalSteps: scenarioResult.summary.total,
              passedSteps: scenarioResult.summary.passed,
              failedSteps: scenarioResult.summary.failed,
              avgResponseTime: scenarioResult.summary.total > 0 ? 
                Math.round(scenarioResult.summary.duration / scenarioResult.summary.total) : 0,
              totalDuration: scenarioResult.summary.duration,
              successRate: scenarioResult.summary.total > 0 ? 
                Math.round((scenarioResult.summary.passed / scenarioResult.summary.total) * 100) : 0
            }
          };
          
          history.push(historyEntry);

          const { history_keep = 500 } = readCfg();
          if (history_keep > 0 && history.length > history_keep) {
            history.splice(0, history.length - history_keep);
          }

          histWrite(history);
          cleanupOldReports();
          
          // 히스토리 저장 후 추가 상태 확인 및 초기화
          console.log(`[HIST_SAVE] YAML scenario ${jobName} saved to history, checking state...`);
          if (state.runningJobs.has(jobName)) {
            console.log(`[HIST_SAVE] Cleaning up runningJobs for ${jobName}`);
            unregisterRunningJob(jobName);
          }
          
          // 강화된 History 업데이트 신호
          console.log(`[HISTORY_UPDATE] YAML scenario ${jobName} history updated`);
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
            exitCode: scenarioResult.success ? 0 : 1,
            collection: path.basename(collectionPath),
            type: 'yaml_scenario',
            scenarioName: scenario.info.name,
            summary: `${scenarioResult.summary.passed}/${scenarioResult.summary.total} steps passed`,
            success: scenarioResult.success,
            reportPath: path.join(reportsDir, `${jobName}_${stamp}.html`),
            detailedStats: {
              totalSteps: scenarioResult.summary.total,
              passedSteps: scenarioResult.summary.passed,
              failedSteps: scenarioResult.summary.failed,
              avgResponseTime: scenarioResult.summary.duration / scenarioResult.summary.total,
              totalDuration: scenarioResult.summary.duration,
              successRate: Math.round((scenarioResult.summary.passed / scenarioResult.summary.total) * 100)
            }
          };
          
          if (!scenarioResult.success) {
            const failedSteps = scenarioResult.steps.filter(step => !step.passed);
            alertData.errorSummary = failedSteps.slice(0, 3).map(step =>
              `${step.name}: ${step.error || 'Test failed'}`
            ).join('; ');
            // Response Body 및 상세 Assertion 실패 정보 포함
            alertData.failureReport = buildYamlScenarioFailureReport(failedSteps);
            // 실패한 step들의 response 정보 추가
            alertData.failedStepDetails = failedSteps.map(step => ({
              name: step.name,
              error: step.error,
              tests: step.tests,
              response: step.response ? {
                body: decodeUrlEncodedContent(step.response.body || ''),
                stdout: decodeUrlEncodedContent(step.response.stdout || ''),
                parsed: step.response.parsed,
                duration: step.response.duration
              } : null
            }));
          }

          // 결과에 따른 알람 전송
          if (scenarioResult.success) {
            await sendAlert('success', alertData);
          } else {
            await sendAlert('error', alertData);
          }

          // 통합 완료 처리 함수 사용 (완료를 기다림)
          await finalizeJobCompletion(jobName, scenarioResult.success ? 0 : 1, scenarioResult.success);

          // 임시 파일 정리
          try {
            fs.unlinkSync(tempScenarioPath);
          } catch (err) {
            console.log('[CLEANUP] Failed to remove temp scenario file:', err.message);
          }
        } catch (error) {
          console.error('[ASYNC CLEANUP ERROR]', error);
        }
      });

      // Promise를 즉시 resolve
      console.log(`[YAML] Resolving Promise immediately with result:`, resultData);
      resolve(resultData);
      
    } catch (scenarioError) {
      // 임시 파일 정리
      try {
        fs.unlinkSync(tempScenarioPath);
      } catch (err) {
        // 정리 실패는 무시
      }
      throw scenarioError;
    }
    
    } catch (error) {
      console.error('[YAML SCENARIO ERROR]', error);
      outStream.end();
      errStream.end();
      
      const endTime = nowInTZString();
      const duration = 0; // 시작 시간 변수가 Promise 내부에 있으므로 0으로 설정
      
      // 에러 리포트 생성
      const errorReport = [
        `YAML Scenario Execution Error`,
        `=============================`,
        `Job: ${jobName}`,
        `Collection: ${collectionPath}`,
        `Error: ${error.message}`,
        `Stack: ${error.stack}`,
        `Time: ${endTime}`
      ].join('\n');
      
      fs.writeFileSync(txtReport, errorReport);
      
      // 에러 알람 전송
      await sendAlert('error', {
        jobName,
        startTime: nowInTZString(),
        endTime,
        duration,
        exitCode: 1,
        collection: path.basename(collectionPath),
        type: 'yaml_scenario',
        errorSummary: error.message,
        failureReport: `YAML Scenario Error:\n${error.message}\n\nStack Trace:\n${error.stack}`
      });
      
      // 통합 완료 처리 함수 사용 (완료를 기다림)
      await finalizeJobCompletion(jobName, 1, false);
      
      resolve({ started: false, reason: 'yaml_scenario_error', error: error.message });
    }
  });
}
// YAML 단일 파일 실행 함수 (state.running 체크 없음)
async function runSingleYamlFile(jobName, job, collectionPath, paths, broadcastJobName) {
  // broadcastJobName: 부모 배치 job 이름 (탭에 표시될 이름). 없으면 jobName 사용
  const logJobName = broadcastJobName || jobName;
  console.log(`[SINGLE_YAML] Starting: ${jobName} (broadcast as: ${logJobName})`);
  
  const { stdoutPath, stderrPath, txtReport, outStream, errStream, stamp } = paths;
  
  return new Promise(async (resolve) => {
    try {
      debugLog(`[SINGLE_YAML] Importing modules for: ${jobName}`);
      // YAML 파서와 SClient 엔진 import
      const { SClientYAMLParser } = await import('../../simple-yaml-parser.js');
      const { SClientScenarioEngine, SClientReportGenerator } = await import('../../sclient-engine.js');
      debugLog(`[SINGLE_YAML] Modules imported successfully for: ${jobName}`);
      
      debugLog(`[SINGLE_YAML] Reading YAML file: ${collectionPath}`);
      console.log('[SINGLE_YAML] Loading YAML collection:', collectionPath);
      
      // YAML 파일을 JSON 시나리오로 변환 (변수 치환 포함)
      const yamlContent = fs.readFileSync(collectionPath, 'utf-8');
      debugLog(`[SINGLE_YAML] YAML content read, length: ${yamlContent.length} chars`);
      
      const scenario = SClientYAMLParser.parseYamlToScenario(yamlContent);
      debugLog(`[SINGLE_YAML] Scenario parsed for: ${jobName}`, {
        name: scenario.info?.name,
        steps: scenario.requests?.length || 0,
        variables: scenario.variables?.length || 0
      });
      console.log('[SINGLE_YAML] Parsed scenario:', scenario.info.name);
      
      // SClient 바이너리 경로 확인
      const binaryPath = getBinaryPath(job);
      if (!fs.existsSync(binaryPath)) {
        resolve({ started: false, reason: 'binary_not_found', path: binaryPath });
        return;
      }
      
      const startTime = nowInTZString();
      const startTs = Date.now();
      
      // 개별 파일용 로그 브로드캐스트 (logJobName = 부모 배치 job 이름 또는 자기 자신)
      broadcastLog(`[SINGLE_YAML START] ${jobName} - ${scenario.info.name}`, logJobName);
      
      // SClient 엔진 초기화
      const engine = new SClientScenarioEngine({
        binaryPath,
        timeout: job.timeout || 30000,
        encoding: job.encoding || 'cp949'
      });
      
      // 임시 시나리오 파일 생성
      const tempDir = path.join(root, 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempScenarioPath = path.join(tempDir, `scenario_${jobName}_${stamp}.json`);
      fs.writeFileSync(tempScenarioPath, JSON.stringify(scenario, null, 2));
      console.log('[SINGLE_YAML] Temp scenario written to:', tempScenarioPath);
      
      // 실시간 로그 이벤트 연결 (logJobName 사용하여 부모 탭에 표시)
      engine.on('log', (data) => {
        outStream.write(data.message + '\n');
        broadcastLog(data.message, logJobName);
      });
    
      engine.on('stdout', (data) => {
        outStream.write(data.text);
        const lines = data.text.split(/\r?\n/);
        lines.forEach(line => {
          if (line.trim()) {
            broadcastLog(line.trim(), logJobName);
          }
        });
      });
      
      engine.on('stderr', (data) => {
        errStream.write(data.text);
        const lines = data.text.split(/\r?\n/);
        lines.forEach(line => {
          if (line.trim()) {
            broadcastLog(`[ERROR] ${line.trim()}`, logJobName);
          }
        });
      });
      
      // 시나리오 실행
      debugLog(`[SINGLE_YAML] Starting scenario execution for: ${jobName}`);

      const executionResult = await engine.runScenario(tempScenarioPath);

      debugLog(`[SINGLE_YAML] Scenario execution completed for: ${jobName}`, {
        success: executionResult?.success,
        stepCount: executionResult?.steps?.length || 0,
        totalTests: executionResult?.summary?.total || 0,
        passedTests: executionResult?.summary?.passed || 0
      });

      // 공통 테스트 검증 모듈 적용 - run-yaml.js와 동일한 검증 로직 사용
      try {
        const yamlContentForValidation = fs.readFileSync(collectionPath, 'utf8');
        const { load } = await import('js-yaml');
        const yamlDataForValidation = load(yamlContentForValidation);
        const validatedExecutionResult = validateTestsWithYamlData(executionResult, yamlDataForValidation);

        // 검증 결과로 실행 결과 업데이트
        Object.assign(executionResult, validatedExecutionResult);
      } catch (validateError) {
        console.warn(`[SINGLE_YAML] Test validation failed, using original results: ${validateError.message}`);
      }

      // 임시 파일 정리
      try {
        if (fs.existsSync(tempScenarioPath)) {
          fs.unlinkSync(tempScenarioPath);
        }
      } catch (cleanupError) {
        console.warn('[SINGLE_YAML] Temp file cleanup failed:', cleanupError.message);
      }

      const endTime = nowInTZString();
      const duration = Date.now() - startTs;

      const success = executionResult && executionResult.success;

      // HTML 리포트 생성
      let finalReportPath = null;

      if (job.generateHtmlReport) {
        try {
          const { SClientToNewmanConverter } = await import('../../newman-converter.js');
          const reportPath = path.join(reportsDir, `${jobName}_${stamp}.html`);

          try {
            const converter = new SClientToNewmanConverter();
            const newmanRun = converter.convertToNewmanRun(executionResult);

            await converter.generateNewmanStyleHTML(newmanRun.run, reportPath, {
              title: job.reportOptions?.title || `${jobName} Test Report`,
              browserTitle: job.reportOptions?.browserTitle || `${jobName} Report`
            });

            // 파일이 실제로 생성되었는지 확인
            if (fs.existsSync(reportPath)) {
              finalReportPath = reportPath;
            }

          } catch (htmlError) {
            console.error('[HTML_GENERATION] HTML generation failed:', htmlError.message);

            // 폴백: 기본 HTML 리포트 생성 시도
            try {
              const { SClientReportGenerator } = await import('../../sclient-engine.js');
              const fallbackContent = SClientReportGenerator.generateHTMLReport(executionResult);
              fs.writeFileSync(reportPath, fallbackContent);

              if (fs.existsSync(reportPath)) {
                finalReportPath = reportPath;
              }
            } catch (fallbackError) {
              console.error('[HTML_FALLBACK] Fallback generation failed:', fallbackError.message);
            }
          }
        } catch (reportError) {
          debugLog(`[SINGLE_YAML] HTML report generation failed for: ${jobName}`, {
            error: reportError.message,
            stack: reportError.stack
          });
          console.error('[SINGLE_YAML] HTML report generation failed:', reportError);
          
          // 폴백 HTML 생성
          try {
            debugLog(`[SINGLE_YAML] Attempting fallback HTML generation for: ${jobName}`);
            const { SClientReportGenerator } = await import('../../sclient-engine.js');
            const fallbackReportPath = path.join(reportsDir, `${jobName}_${stamp}.html`);
            SClientReportGenerator.generateHTMLReport(executionResult, fallbackReportPath, jobName);
            
            // 폴백 파일이 실제로 생성되었는지 확인
            const fallbackExists = fs.existsSync(fallbackReportPath);
            debugLog(`[SINGLE_YAML] Fallback HTML report file exists: ${fallbackExists}`, {
              reportPath: fallbackReportPath,
              fileSize: fallbackExists ? fs.statSync(fallbackReportPath).size : 'N/A'
            });
            
            if (fallbackExists) {
              finalReportPath = fallbackReportPath;
              console.log(`[SINGLE_YAML] Fallback HTML report generated: ${fallbackReportPath}`);
            }
          } catch (fallbackError) {
            debugLog(`[SINGLE_YAML] Fallback HTML generation failed for: ${jobName}`, {
              error: fallbackError.message,
              stack: fallbackError.stack
            });
            console.error('[SINGLE_YAML] Fallback HTML report generation failed:', fallbackError);
          }
        }
      } else {
        debugLog(`[SINGLE_YAML] HTML report generation SKIPPED for: ${jobName} (generateHtmlReport=false)`);
      }
      
      // 완료 로그
      const statusIcon = success ? '✅' : '❌';
      const message = `${statusIcon} ${jobName}: ${success ? 'SUCCESS' : 'FAILED'} (${duration}ms)`;
      broadcastLog(message, logJobName);
      
      // HTML 리포트 생성 완료 후 resolve
      debugLog(`[SINGLE_YAML] Final resolve for: ${jobName}`, {
        success: success,
        duration: duration,
        reportsGenerated: job.generateHtmlReport,
        finalReportPath: finalReportPath
      });
      
      resolve({
        started: true,
        success: success,
        duration: duration,
        startTime: startTime,
        endTime: endTime,
        reportPath: finalReportPath,
        result: executionResult
      });
      
    } catch (error) {
      debugLog(`[SINGLE_YAML] Error in ${jobName}`, {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      console.error(`[SINGLE_YAML] Error in ${jobName}:`, error);
      broadcastLog(`❌ ${jobName}: ERROR - ${error.message}`, logJobName);
      
      const errorResult = {
        started: true,
        success: false,
        error: error.message,
        result: null
      };
      debugLog(`[SINGLE_YAML] Resolving with error result for: ${jobName}`, errorResult);
      resolve(errorResult);
    }
  });
}

// debugLog, batchLog → src/utils/debug.js에서 import

// YAML 디렉토리 배치 실행 함수 (기존 runYamlSClientScenario 방식 재사용)
async function runYamlDirectoryBatch(jobName, job, collectionPath, paths) {
  console.log('🎯🎯🎯 [BATCH_FUNCTION] runYamlDirectoryBatch called! 🎯🎯🎯');
  process.stdout.write('🎯🎯🎯 [BATCH_FUNCTION] runYamlDirectoryBatch called! 🎯🎯🎯\n');
  
  batchLog(`\n🚀 === BATCH FUNCTION ENTRY === 🚀`);
  batchLog(`[BATCH_ENTRY] Function called at: ${new Date().toISOString()}`);
  batchLog(`[BATCH_ENTRY] jobName: ${jobName}`);
  batchLog(`[BATCH_ENTRY] collectionPath: ${collectionPath}`);
  batchLog(`[BATCH_ENTRY] Function parameters received successfully`);
  
  debugLog(`[YAML_BATCH] Starting YAML directory batch: ${jobName}`);
  debugLog(`[YAML_BATCH] Directory path: ${collectionPath}`);
  debugLog(`[YAML_BATCH] Job configuration`, job);
  debugLog(`[YAML_BATCH] Paths configuration`, paths);
  
  // 배치 모드 활성화
  state.batchMode = true;
  console.log(`[YAML_BATCH] Batch mode activated for concurrent file execution`);
  console.log(`[YAML_BATCH] Current state before start:`, state.running);
  
  const { stdoutPath, stderrPath, txtReport, outStream, errStream, stamp } = paths;
  
  try {
    // YAML 파일들 찾기
    const allFiles = fs.readdirSync(collectionPath);
    
    const allYamlFiles = allFiles.filter(file => file.toLowerCase().endsWith('.yaml'));
    debugLog(`[YAML_BATCH] All YAML files found`, allYamlFiles);
    
    // excludePatterns 적용
    let yamlFiles = allYamlFiles;
    if (job.excludePatterns && Array.isArray(job.excludePatterns)) {
      debugLog(`[YAML_BATCH] Applying exclude patterns`, job.excludePatterns);
      yamlFiles = allYamlFiles.filter(file => {
        const filePath = path.join(collectionPath, file);
        const relativePath = path.relative(collectionPath, filePath);
        
        // 각 제외 패턴과 비교
        for (const pattern of job.excludePatterns) {
          if (matchPattern(file, pattern) || matchPattern(relativePath, pattern)) {
            debugLog(`[YAML_BATCH] Excluding file: ${file} (matches pattern: ${pattern})`);
            return false; // 제외
          }
        }
        debugLog(`[YAML_BATCH] Including file: ${file}`);
        return true; // 포함
      });
    }
    debugLog(`[YAML_BATCH] Final YAML files for execution`, yamlFiles);
    
    batchLog(`\n📂 === FILE FILTERING RESULT === 📂`);
    batchLog(`[FILE_FILTER] Total YAML files found: ${allYamlFiles.length}`);
    batchLog(`[FILE_FILTER] After exclude patterns: ${yamlFiles.length}`);
    batchLog(`[FILE_FILTER] Files to process:`, yamlFiles);
    
    if (yamlFiles.length === 0) {
      console.log(`[YAML_BATCH] No YAML files found in ${collectionPath}`);
      batchLog(`[FILE_FILTER] ⚠️ EARLY RETURN: No files to process`);
      return { started: false, reason: 'no_yaml_files', path: collectionPath };
    }
    
    console.log(`[YAML_BATCH] All YAML files found: ${allYamlFiles.length}`);
    allYamlFiles.forEach(file => console.log(`[YAML_BATCH] ALL: ${file}`));
    
    console.log(`[YAML_BATCH] After exclude patterns: ${yamlFiles.length}`);
    yamlFiles.forEach(file => console.log(`[YAML_BATCH] INCLUDED: ${file}`));
    
    const startTime = nowInTZString();
    const startTs = Date.now();

    registerRunningJob(jobName, startTime, 'yaml_batch', null);
    broadcastLog(`[YAML_BATCH START] ${jobName} - ${yamlFiles.length} files`, jobName);
    
    // 전체 배치 로그에 시작 정보 기록
    outStream.write(`\n🚀 === YAML BATCH EXECUTION START ===\n`);
    outStream.write(`Job: ${jobName}\n`);
    outStream.write(`Start Time: ${startTime}\n`);
    outStream.write(`Total Files: ${yamlFiles.length}\n`);
    outStream.write(`Files: ${yamlFiles.join(', ')}\n`);
    outStream.write(`=== EXECUTION LOG ===\n\n`);

    // 시작 알람 전송
    try {
      await sendAlert('start', {
        jobName,
        startTime,
        target: collectionPath,
        fileCount: yamlFiles.length,
        type: 'yaml_batch'
      });
      console.log('[YAML_BATCH] Alert sent successfully');
    } catch (alertError) {
      console.error('[YAML_BATCH] Alert sending failed:', alertError.message);
      // 알람 실패는 배치 실행을 중단시키지 않음
    }

    // 각 YAML 파일을 순차적으로 기존 runYamlSClientScenario 방식으로 처리
    const batchResults = [];  // 히스토리 저장용 (요약만)
    const batchResultsFull = [];  // 알림 전송용 (상세 정보 포함)
    let overallSuccess = true;

    for (let i = 0; i < yamlFiles.length; i++) {
      const fileName = yamlFiles[i];
      const filePath = path.join(collectionPath, fileName);

      console.log(`[YAML_BATCH] Processing ${i + 1}/${yamlFiles.length}: ${fileName}`);
      broadcastLog(`📋 [${i + 1}/${yamlFiles.length}] Starting ${fileName}...`, jobName);

      // 진행률 표시
      const progressPercent = Math.round(((i + 1) / yamlFiles.length) * 100);
      broadcastLog(`📊 Batch Progress: ${progressPercent}% (${i + 1}/${yamlFiles.length} files)`, jobName);
      
      // 전체 배치 로그에도 진행률 기록
      outStream.write(`📊 Batch Progress: ${progressPercent}% (${i + 1}/${yamlFiles.length} files)\n`);
      
      console.log(`[BATCH_LOOP] About to enter try block for ${fileName}`);
      try {
        console.log('⭐⭐⭐ [TRY_ENTRY] Entered try block successfully! ⭐⭐⭐');
        process.stdout.write('⭐⭐⭐ [TRY_ENTRY] Entered try block successfully! ⭐⭐⭐\n');
        
        // 개별 파일을 위한 paths 생성
        const fileStamp = kstTimestamp();
        console.log('⭐⭐⭐ [TRY_PATHS] Created fileStamp:', fileStamp, '⭐⭐⭐');
        const individualOutStream = fs.createWriteStream(path.join(logsDir, `stdout_${jobName}_${fileName}_${fileStamp}.log`), { flags:'a' });
        const individualErrStream = fs.createWriteStream(path.join(logsDir, `stderr_${jobName}_${fileName}_${fileStamp}.log`), { flags:'a' });
        
        const filePaths = {
          stdoutPath: path.join(logsDir, `stdout_${jobName}_${fileName}_${fileStamp}.log`),
          stderrPath: path.join(logsDir, `stderr_${jobName}_${fileName}_${fileStamp}.log`),
          txtReport: path.join(reportsDir, `${jobName}_${fileName}_${fileStamp}.txt`),
          outStream: individualOutStream,
          errStream: individualErrStream,
          stamp: fileStamp
        };
        
        // 배치 전체 로그에도 기록하기 위한 로그 함수 오버라이드
        const originalLog = console.log;
        const enhancedLog = (...args) => {
          const message = args.join(' ');
          // 개별 파일 로그에 기록
          if (individualOutStream && !individualOutStream.destroyed) {
            individualOutStream.write(message + '\n');
          }
          // 전체 배치 로그에도 기록
          if (outStream && !outStream.destroyed) {
            outStream.write(`[${fileName}] ${message}\n`);
          }
          originalLog(...args);
        };
        
        // runYamlSClientScenario 함수의 핵심 로직을 직접 실행 (state.running 체크 우회)
        console.log(`[BATCH_LOOP] About to call runSingleYamlFile for: ${fileName}`);
        console.log(`[BATCH_LOOP] File paths created:`, {
          stdoutPath: filePaths.stdoutPath,
          stderrPath: filePaths.stderrPath,
          txtReport: filePaths.txtReport
        });
        
        // 전체 배치 로그에 개별 파일 시작 로그 기록
        outStream.write(`\n=== [${i + 1}/${yamlFiles.length}] Starting ${fileName} ===\n`);

        const result = await runSingleYamlFile(`${jobName}_${fileName}`, job, filePath, filePaths, jobName);

        // 전체 배치 로그에 개별 파일 완료 로그 기록
        const fileStatusIcon = result.success ? '✅' : '❌';
        const fileStatusText = result.success ? 'SUCCESS' : 'FAILED';
        outStream.write(`=== [${i + 1}/${yamlFiles.length}] ${fileStatusIcon} ${fileName}: ${fileStatusText} (${result.duration}ms) ===\n\n`);
        
        // 스트림 정리
        individualOutStream.end();
        individualErrStream.end();
        
        // 알림용: 상세 정보 포함 (에러 메시지 표시에 필요)
        const fileResultFull = {
          fileName,
          filePath,
          success: result.success,
          reportPath: result.reportPath,
          result  // 상세 결과 포함
        };
        batchResultsFull.push(fileResultFull);

        // 히스토리용: 요약 정보만 저장 (파일 크기 절약)
        const fileResult = {
          fileName,
          filePath,
          success: result.success,
          reportPath: result.reportPath,
          duration: result.duration,
          summary: result.scenarioResult?.summary ? {
            total: result.scenarioResult.summary.total,
            passed: result.scenarioResult.summary.passed,
            failed: result.scenarioResult.summary.failed
          } : null
        };
        batchResults.push(fileResult);
        debugLog(`[YAML_BATCH] Added result to batch for: ${fileName}`, fileResult);
        
        if (!result.success) {
          overallSuccess = false;
          debugLog(`[YAML_BATCH] File failed, setting overallSuccess to false: ${fileName}`);
        }
        
        const statusIcon = result.success ? '✅' : '❌';
        const stepInfo = result.scenarioResult?.summary ? 
          `${result.scenarioResult.summary.passed}/${result.scenarioResult.summary.total} steps passed` : 
          'No steps';
        const message = `${statusIcon} ${fileName}: ${result.success ? 'SUCCESS' : 'FAILED'} (${stepInfo})`;
        console.log(`[YAML_BATCH] ${message}`);
        broadcastLog(message, jobName);
        
        // 개별 파일 상세 진행 상황 브로드캐스트
        if (result.scenarioResult?.summary) {
          const detailMessage = `[${fileName}] Steps: ${result.scenarioResult.summary.passed}✅ ${result.scenarioResult.summary.failed}❌ Duration: ${result.duration}ms`;
          broadcastLog(detailMessage, jobName);
        }
        
        debugLog(`[YAML_BATCH] Broadcasted result for: ${fileName}`, { statusIcon, success: result.success, stepInfo });
        
        console.log(`[BATCH_LOOP] Completed processing ${fileName} successfully`);
        console.log(`[BATCH_LOOP] Moving to next file...`);
        
      } catch (error) {
        console.error(`[BATCH_LOOP] *** ERROR processing ${fileName} ***`);
        console.error(`[BATCH_LOOP] Error message:`, error.message);
        console.error(`[BATCH_LOOP] Error stack:`, error.stack);
        console.error(`[BATCH_LOOP] Current state when error occurred:`, {
          running: state.running,
          batchMode: state.batchMode,
          fileName: fileName,
          fileIndex: i,
          totalFiles: yamlFiles.length
        });
        
        console.error(`[YAML_BATCH] Error processing ${fileName}:`, error);
        console.error(`[YAML_BATCH] Error stack:`, error.stack);
        debugLog(`[YAML_BATCH] Critical error processing file: ${fileName}`, {
          message: error.message,
          stack: error.stack,
          fileName,
          index: i
        });
        
        batchResults.push({
          fileName,
          filePath,
          success: false,
          result: { success: false, error: error.message }
        });
        
        overallSuccess = false;
        broadcastLog(`❌ ${fileName}: ERROR - ${error.message}`, jobName);
      }
      
      // 각 파일 처리 후 상태 확인
      console.log(`[BATCH_LOOP] === File ${i + 1}/${yamlFiles.length} processing completed ===`);
      console.log(`[BATCH_LOOP] Batch results count: ${batchResults.length}`);
      console.log(`[BATCH_LOOP] Overall success: ${overallSuccess}`);
      console.log(`[BATCH_LOOP] Will continue: ${(i < yamlFiles.length - 1)}`);
      console.log(`[BATCH_LOOP] Current state.running: ${JSON.stringify(state.running)}`);
      console.log(`[BATCH_LOOP] Current state.batchMode: ${state.batchMode}`);
      
      debugLog(`[YAML_BATCH] File ${i + 1}/${yamlFiles.length} processing completed: ${fileName}`, {
        batchResults: batchResults.length,
        overallSuccess,
        willContinue: (i < yamlFiles.length - 1)
      });
      console.log(`[YAML_BATCH] Completed ${i + 1}/${yamlFiles.length}: ${fileName}`);
      
      if (i < yamlFiles.length - 1) {
        console.log(`[BATCH_LOOP] Continuing to next file...`);
      } else {
        console.log(`[BATCH_LOOP] All files processed, exiting loop`);
      }
    }

    console.log(`\n=== [BATCH_LOOP] Loop completed ===`);
    console.log(`[BATCH_LOOP] Final batch results count: ${batchResults.length}`);
    console.log(`[BATCH_LOOP] Final overall success: ${overallSuccess}`);
    console.log(`[BATCH_LOOP] About to proceed to batch completion...`);

    const endTime = nowInTZString();
    const duration = Date.now() - startTs;
    const successFiles = batchResults.filter(r => r.success).length;
    const failedFiles = yamlFiles.length - successFiles;
    const successRate = ((successFiles / yamlFiles.length) * 100).toFixed(1);

    console.log(`[YAML_BATCH] Batch execution completed`);
    console.log(`[YAML_BATCH] Results: ${successFiles}/${yamlFiles.length} files passed (${successRate}%)`);
    
    debugLog(`[YAML_BATCH] Final batch statistics`, {
      totalFiles: yamlFiles.length,
      successFiles: successFiles,
      failedFiles: failedFiles,
      successRate: successRate,
      duration: duration,
      overallSuccess: overallSuccess
    });

    debugLog(`[YAML_BATCH] Clearing state.running and broadcasting null state`);
    console.log(`[YAML_BATCH] About to clear runningJobs - current:`, [...state.runningJobs.keys()]);
    console.log(`[YAML_BATCH] About to deactivate batch mode - current:`, state.batchMode);
    
    unregisterRunningJob(jobName);
    state.batchMode = false; // 배치 모드 비활성화
    
    console.log(`[YAML_BATCH] State cleared - running:`, state.running, 'batchMode:', state.batchMode);
    console.log(`[YAML_BATCH] About to broadcast state`);
    try {
      broadcastRunningJobs();
      console.log(`[YAML_BATCH] State broadcast completed`);
    } catch (broadcastError) {
      console.error(`[YAML_BATCH] WARNING: broadcastState failed:`, broadcastError.message);
      debugLog(`[YAML_BATCH] WARNING: broadcastState failed: ${broadcastError.message}`);
    }
    debugLog(`[YAML_BATCH_DEBUG] After broadcastState, about to reach batch report section`);
    debugLog(`[YAML_BATCH_DEBUG] REACHED BATCH REPORT GENERATION SECTION`);

    // 배치 요약 리포트 생성 - 기본 방식으로 복구
    let batchReportPath = null;
    if (job.generateHtmlReport !== false) {
      try {
        console.log(`[YAML_BATCH] Generating simple batch summary report...`);
        batchReportPath = await generateSimpleBatchReport(jobName, {
          startTime,
          endTime,
          duration,
          yamlFiles: yamlFiles.length,
          successFiles,
          failedFiles,
          successRate,
          results: batchResults,
          stamp
        });
        console.log(`[YAML_BATCH] ✅ Batch report generated: ${path.basename(batchReportPath)}`);
      } catch (error) {
        console.error(`[YAML_BATCH] Batch report generation failed:`, error);
        batchReportPath = null;
      }
    }

    const finalResult = {
      started: true,
      success: overallSuccess,
      duration,
      stats: {
        files: yamlFiles.length,
        successFiles,
        failedFiles,
        successRate: parseFloat(successRate)
      },
      results: batchResults,
      batchReportPath
    };

    // 알람 전송 - 실패한 파일들의 상세 정보 포함 (batchResultsFull 사용)
    const failedResultsFull = batchResultsFull.filter(r => !r.success);
    let batchFailureReport = null;
    let batchErrorSummary = null;

    if (failedResultsFull.length > 0) {
      // 실패 요약
      batchErrorSummary = failedResultsFull.slice(0, 3).map(r =>
        `${r.fileName}: ${r.result?.error || 'Failed'}`
      ).join('; ');

      // 상세 실패 리포트 생성 (상세 정보가 포함된 배열 사용)
      batchFailureReport = buildBatchFailureReport(failedResultsFull);
    }

    // 알림용 결과 (상세 정보 포함)
    const alertResult = {
      started: true,
      success: overallSuccess,
      duration,
      stats: finalResult.stats,
      results: batchResultsFull,  // 알림에는 상세 정보 포함된 배열 사용
      batchReportPath
    };

    await sendAlert(overallSuccess ? 'success' : 'error', {
      jobName,
      startTime,
      endTime,
      duration: Math.round(duration / 1000), // 초 단위로 변환
      exitCode: overallSuccess ? 0 : 1,
      collection: path.basename(collectionPath),
      type: 'yaml_batch',
      result: alertResult,  // 알림용 상세 결과 사용
      stats: finalResult.stats,
      totalRequests: yamlFiles.length,
      passedRequests: successFiles,
      failedRequests: failedFiles,
      reportPath: batchReportPath,
      // 실패 정보 추가
      errorSummary: batchErrorSummary,
      failureReport: batchFailureReport,
      // 상세 통계 (sendAlert의 error 타입에서 사용)
      detailedStats: {
        totalSteps: yamlFiles.length,
        passedSteps: successFiles,
        failedSteps: failedFiles,
        successRate: parseFloat(successRate)
      }
    });

    // 배치 실행 결과를 히스토리에 저장
    // batchResults를 요약 정보만 포함하도록 축소 (JSON.stringify 크기 제한 문제 방지)
    const batchResultsSummary = batchResults.map(r => ({
      fileName: r.fileName,
      success: r.success,
      duration: r.duration,
      summary: r.summary ? {
        total: r.summary.total,
        passed: r.summary.passed,
        failed: r.summary.failed
      } : null
    }));

    const historyEntry = {
      timestamp: endTime,
      job: jobName,
      type: 'binary',
      exitCode: overallSuccess ? 0 : 1,
      summary: `${successFiles}/${yamlFiles.length} files passed (batch)`,
      report: batchReportPath,
      htmlReport: batchReportPath,
      reportPath: batchReportPath,
      stdout: `batch_execution_${new Date().toISOString().split('T')[0]}.log`,
      stderr: `batch_execution_${new Date().toISOString().split('T')[0]}.log`,
      tags: ['binary', 'yaml', 'batch'],
      duration: Math.round(duration / 1000), // ms를 초로 변환
      batchStats: {
        totalFiles: yamlFiles.length,
        successFiles: successFiles,
        failedFiles: failedFiles,
        successRate: parseFloat(successRate),
        results: batchResultsSummary // 요약 정보만 저장
      },
      detailedStats: {
        totalSteps: batchResults.reduce((sum, r) => sum + (r.summary?.total || 0), 0),
        passedSteps: batchResults.reduce((sum, r) => sum + (r.summary?.passed || 0), 0),
        failedSteps: batchResults.reduce((sum, r) => sum + (r.summary?.failed || 0), 0),
        avgResponseTime: Math.round(batchResults.reduce((sum, r) => {
          const fileDuration = r.duration || 0;
          const total = r.summary?.total || 1;
          return sum + (total > 0 ? fileDuration / total : 0);
        }, 0) / Math.max(batchResults.length, 1)),
        totalDuration: duration,
        successRate: parseFloat(successRate)
      }
    };
    
    debugLog(`[YAML_BATCH] Adding batch result to history`, {
      jobName: historyEntry.job,
      summary: historyEntry.summary,
      batchReport: historyEntry.report ? 'Generated' : 'None',
      totalSteps: historyEntry.detailedStats.totalSteps,
      passedSteps: historyEntry.detailedStats.passedSteps
    });
    
    // history 저장
    const history = histRead();
    history.push(historyEntry);
    
    // 최대 기록 개수 유지
    const { history_keep = 500 } = readCfg();
    if (history_keep > 0 && history.length > history_keep) {
      history.splice(0, history.length - history_keep);
    }

    // 히스토리 파일에 저장
    try {
      histWrite(history);
      console.log(`[YAML_BATCH] History saved successfully`);
      
      // 히스토리 업데이트 신호 브로드캐스트
      broadcastLog(`[HISTORY_UPDATE] Batch job ${jobName} completed and history updated`, 'SYSTEM');
      broadcastState({ history_updated: true });
    } catch (error) {
      console.error(`[YAML_BATCH] Failed to save history:`, error);
    }

    const statusIcon = overallSuccess ? '✅' : '❌';
    console.log(`\n🏁 === BATCH COMPLETION === 🏁`);
    console.log(`[BATCH_COMPLETE] Final results:`, {
      started: finalResult.started,
      success: finalResult.success,
      totalFiles: yamlFiles.length,
      successFiles: successFiles,
      failedFiles: failedFiles,
      duration: finalResult.duration,
      batchReportPath: finalResult.batchReportPath
    });
    console.log(`[BATCH_COMPLETE] About to broadcast completion message`);
    broadcastLog(`[YAML_BATCH COMPLETE] ${jobName} - ${statusIcon} ${successFiles}/${yamlFiles.length} files passed`, jobName);
    console.log(`[BATCH_COMPLETE] About to return finalResult`);

    return finalResult;

  } catch (error) {
    console.error(`[YAML_BATCH] Batch execution error:`, error.message);

    unregisterRunningJob(jobName);
    state.batchMode = false;
    
    return {
      started: false,
      reason: 'batch_execution_error',
      error: error.message
    };
  }
}

// SClient 시나리오 실행 함수
async function runSClientScenarioJob(jobName, job) {
  const stamp = kstTimestamp();
  const logPath = path.join(logsDir, `scenario_${jobName}_${stamp}.log`);
  const reportPath = path.join(reportsDir, `scenario_${jobName}_${stamp}.json`);
  const htmlReportPath = path.join(reportsDir, `scenario_${jobName}_${stamp}.html`);
  const txtReportPath = path.join(reportsDir, `scenario_${jobName}_${stamp}.txt`);
  
  try {
    // 컬렉션 파일 읽기
    const collectionPath = path.resolve(root, job.collection);
    if (!fs.existsSync(collectionPath)) {
      return { started: false, reason: 'collection_not_found', path: collectionPath };
    }
    
    const startTime = nowInTZString();
    const startTs = Date.now();
    
    registerRunningJob(jobName, startTime, 'sclient_scenario', null);
    broadcastLog(`[SCENARIO START] ${jobName} - ${collectionPath}`, jobName);
    
    // 시작 알람
    await sendAlert('start', {
      jobName,
      startTime,
      collection: job.collection,
      type: 'sclient_scenario'
    });

    // SClient 시나리오 엔진 초기화
    const binaryPath = getBinaryPath(job) || path.join(root, 'binaries', 'windows', 'SClient.exe');
    const engine = new SClientScenarioEngine({
      binaryPath,
      timeout: job.timeout || 30000,
      encoding: job.encoding || 'cp949'
    });

    // 실시간 이벤트 핸들링
    engine.on('log', (data) => {
      broadcastLog(`[SCENARIO] ${data.message}`, jobName);
    });

    engine.on('step-start', (data) => {
      broadcastLog(`[STEP START] ${data.name}`, jobName);
      broadcastState({ 
        running: { 
          ...state.running, 
          currentStep: data.name,
          stepProgress: `${data.step || 0}/${data.total || 0}`
        } 
      });
    });

    engine.on('step-end', (data) => {
      broadcastLog(`[STEP END] ${data.name} - Duration: ${data.duration}ms, Exit: ${data.exitCode}`, jobName);
    });

    engine.on('step-error', (data) => {
      broadcastLog(`[STEP ERROR] ${data.name} - ${data.error}`, jobName);
    });

    // 시나리오 실행
    const scenarioResult = await engine.runScenario(collectionPath);
    
    const endTime = nowInTZString();
    const duration = Math.round((Date.now() - startTs) / 1000);
    
    // Newman 리포트 생성
    const basePath = path.join(reportsDir, `scenario_${jobName}_${stamp}`);
    const reportResults = await engine.generateMultipleReports(
      scenarioResult, 
      basePath, 
      ['htmlextra', 'json', 'junit']
    );
    
    // 기존 텍스트 리포트도 생성 (호환성)
    const txtReport = SClientReportGenerator.generateTextReport(scenarioResult);
    fs.writeFileSync(txtReportPath, txtReport);
    fs.writeFileSync(logPath, engine.logs.join('\n'));
    
    // 리포트 경로 업데이트
    const finalHtmlReportPath = reportResults.htmlextra?.path || htmlReportPath;
    const finalJsonReportPath = reportResults.json?.path || reportPath;
    
    const success = scenarioResult.success;
    
    // 통합 완료 처리 함수 사용 (완료를 기다림)
    await finalizeJobCompletion(jobName, success ? 0 : 1, success);
    
    // 완료 알람
    await sendAlert(success ? 'success' : 'error', {
      jobName,
      collection: job.collection,
      duration,
      endTime,
      totalRequests: scenarioResult.summary.total,
      passedRequests: scenarioResult.summary.passed,
      failedRequests: scenarioResult.summary.failed,
      type: 'sclient_scenario',
      reportPath: finalHtmlReportPath
    });
    
    const historyEntry = {
      job: jobName,
      type: 'sclient_scenario', 
      startTime,
      endTime,
      duration,
      success,
      collection: job.collection,
      totalRequests: scenarioResult.summary.total,
      passedRequests: scenarioResult.summary.passed,
      failedRequests: scenarioResult.summary.failed
    };
    
    const history = histRead();
    history.push(historyEntry);
    
    // 최대 기록 개수 유지
    const { history_keep = 500 } = readCfg();
    if (history_keep > 0 && history.length > history_keep) {
      history.splice(0, history.length - history_keep);
    }

    broadcastState({ history_updated: true });
    
    return { started: true, success, result: scenarioResult };
    
  } catch (error) {
    console.error('[SCENARIO ERROR]', error);
    
    // 통합 완료 처리 함수 사용 (완료를 기다림)
    await finalizeJobCompletion(jobName, 1, false);
    
    await sendAlert('error', {
      jobName,
      error: error.message,
      type: 'sclient_scenario'
    });
    
    return { started: false, reason: 'execution_error', error: error.message };
  }
}

export { runJob, runBinaryJob, runYamlSClientScenario, runSingleYamlFile, runYamlDirectoryBatch, runSClientScenarioJob };

