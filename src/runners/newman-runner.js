import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { root, reportsDir, logsDir } from '../utils/config.js';
import { nowInTZString, kstTimestamp } from '../utils/time.js';
import { broadcastLog } from '../utils/sse.js';
import { state, registerRunningJob, unregisterRunningJob, finalizeJobCompletion } from '../state/running-jobs.js';
import { histAppend } from '../services/history-service.js';
import { cleanupOldReports } from '../services/log-manager.js';
import { sendAlert, buildNewmanFailureReport } from '../services/alert-integration.js';
import { processResponseBody } from '../utils/crypto.js';
import { attachLineProcessor } from '../utils/stream-line-processor.js';
import { spawnNewmanCLI } from './spawn-helpers.js';

async function runNewmanJob(jobName, job) {
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

  const runId = registerRunningJob(jobName, startTime, 'newman', null);
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
    if (state.runningJobs.has(runId)) {
      state.runningJobs.get(runId).proc = proc;
    }
    let errorOutput = '';

    attachLineProcessor(proc.stdout, {
      encoding: 'utf8',
      fileStream: outStream,
      onChunk: s => console.log('[NEWMAN STDOUT]', s.substring(0, 100) + '...'),
      onLine: line => {
        console.log('[NEWMAN STDOUT LINE]', line.substring(0, 50) + '...');
        broadcastLog(line, jobName);
      },
    });

    attachLineProcessor(proc.stderr, {
      encoding: 'utf8',
      fileStream: errStream,
      onChunk: s => {
        console.log('[NEWMAN STDERR]', s.substring(0, 100) + '...');
        errorOutput += s;
      },
      onLine: line => {
        console.log('[NEWMAN STDERR LINE]', line.substring(0, 50) + '...');
        broadcastLog(line, jobName);
      },
    });

proc.on('close', async (code) => {
  outStream.end(); 
  errStream.end();
  
  const endTime = nowInTZString();
  const durationMs = Date.now() - startTs;
  const duration = Math.round(durationMs / 1000);
  
  broadcastLog(`[DONE] ${jobName} exit=${code}`, jobName);

  // Newman JSON 리포트에서 상세 통계 정보 추출
  let summary = `exit=${code}`;
  let newmanStats = null;
  let detailedStats = null;
  let failureDetails = [];
  
  try {
    if (fs.existsSync(jsonReport)) {
      const jsonRaw = await fsPromises.readFile(jsonReport, 'utf-8');
      const jsonData = JSON.parse(jsonRaw);
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
    const output = await fsPromises.readFile(stdoutPath, 'utf-8');
    
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

  // history 저장 (비동기 - 이벤트 루프 블로킹 방지)
  const historyEntry = {
    timestamp: endTime,
    job: jobName,
    runId: runId,
    type: job.type,
    exitCode: code,
    summary: summary, // 개선된 summary 사용
    report: htmlReport,
    stdout: path.basename(stdoutPath),
    stderr: path.basename(stderrPath),
    tags: [],
    duration: duration,
    durationMs: durationMs,
    // 상세 Newman 통계 추가
    newmanStats: newmanStats,
    detailedStats: detailedStats
  };

  await histAppend(historyEntry);
  cleanupOldReports();

  // 히스토리 저장 후 추가 상태 확인 및 초기화
  console.log(`[HIST_SAVE] Newman job ${jobName} saved to history, checking state...`);
  if (state.runningJobs.has(runId)) {
    console.log(`[HIST_SAVE] Cleaning up runningJobs for ${jobName} (runId=${runId})`);
    unregisterRunningJob(runId);
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
  await finalizeJobCompletion(runId, code);
  
  // Newman HTML 리포트에 다크모드 토글 추가 (원래 Newman HTMLExtra 리포트 유지)
  // if (fs.existsSync(htmlReport)) {
  //   addDarkModeToggleToHtml(htmlReport);
  // }
  
  resolve({ started: true, exitCode: code });
});
  });
}

export { runNewmanJob };
