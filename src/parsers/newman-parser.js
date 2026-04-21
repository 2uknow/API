// src/parsers/newman-parser.js — Newman 결과 파싱
import fs from 'fs';
import { decodeUrlEncodedContent } from '../utils/crypto.js';

export function parseNewmanResult(jsonReportPath) {
  try {
    if (!fs.existsSync(jsonReportPath)) {
      return { summary: 'JSON 리포트 없음', stats: null };
    }
    
    const jsonData = JSON.parse(fs.readFileSync(jsonReportPath, 'utf-8'));
    const run = jsonData.run;
    
    if (!run || !run.stats) {
      return { summary: 'JSON 리포트 파싱 실패', stats: null };
    }
    
    const stats = run.stats;
    const iterations = stats.iterations || {};
    const requests = stats.requests || {};
    const assertions = stats.assertions || {};
    const testScripts = stats.testScripts || {};
    
    const totalIterations = iterations.total || 0;
    const totalRequests = requests.total || 0;
    const failedRequests = requests.failed || 0;
    const totalAssertions = assertions.total || 0;
    const failedAssertions = assertions.failed || 0;
    const totalTests = testScripts.total || 0;
    const failedTests = testScripts.failed || 0;
    
    const successRequests = totalRequests - failedRequests;
    const successAssertions = totalAssertions - failedAssertions;
    const successTests = totalTests - failedTests;
    
    let summary = '';
    let isAllSuccess = failedRequests === 0 && failedAssertions === 0 && failedTests === 0;
    
    if (isAllSuccess) {
      summary = `✅ 모든 테스트 통과 (요청 ${totalRequests}건, 검증 ${totalAssertions}건, 테스트 ${totalTests}건)`;
    } else {
      const failures = [];
      if (failedRequests > 0) failures.push(`요청 ${failedRequests}건 실패`);
      if (failedAssertions > 0) failures.push(`검증 ${failedAssertions}건 실패`);
      if (failedTests > 0) failures.push(`테스트 ${failedTests}건 실패`);
      
      summary = `❌ ${failures.join(', ')} (총 요청 ${totalRequests}건, 검증 ${totalAssertions}건, 테스트 ${totalTests}건)`;
    }
    
    return {
      summary,
      stats: {
        iterations: { total: totalIterations, failed: 0 },
        requests: { total: totalRequests, failed: failedRequests },
        assertions: { total: totalAssertions, failed: failedAssertions },
        testScripts: { total: totalTests, failed: failedTests }
      }
    };
  } catch (error) {
    console.error('Newman 결과 파싱 오류:', error);
    return { summary: 'JSON 리포트 파싱 오류', stats: null };
  }
}

// Newman JSON 리포트 파싱 함수
export function parseNewmanJsonReport(jsonReportPath) {
  try {
    if (!fs.existsSync(jsonReportPath)) {
      console.log(`[NEWMAN PARSE] JSON 리포트 파일 없음: ${jsonReportPath}`);
      return null;
    }

    const reportData = JSON.parse(fs.readFileSync(jsonReportPath, 'utf-8'));
    const run = reportData.run;

    if (!run) {
      console.log('[NEWMAN PARSE] run 데이터 없음');
      return null;
    }

    const stats = run.stats || {};
    const timings = run.timings || {};
    const failures = run.failures || [];
    const executions = run.executions || [];

    const requests = stats.requests || {};
    const assertions = stats.assertions || {};
    const testScripts = stats.testScripts || {};

    // 실패한 요청의 Response Body 추출
    const failedExecutions = [];
    for (const execution of executions) {
      const hasFailedAssertion = execution.assertions?.some(a => a.error);
      const hasFailedRequest = execution.requestError;

      if (hasFailedAssertion || hasFailedRequest) {
        const responseBody = execution.response?.stream ?
          Buffer.from(execution.response.stream.data || []).toString('utf-8') :
          (execution.response?.body || '');

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
            body: decodeUrlEncodedContent(responseBody),
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

    const result = {
      summary: {
        iterations: stats.iterations || { total: 0, failed: 0 },
        requests: { total: requests.total || 0, failed: requests.failed || 0 },
        testScripts: { total: testScripts.total || 0, failed: testScripts.failed || 0 },
        assertions: { total: assertions.total || 0, failed: assertions.failed || 0 }
      },
      timings: {
        responseAverage: timings.responseAverage || 0,
        responseMin: timings.responseMin || 0,
        responseMax: timings.responseMax || 0,
        responseTotal: timings.responseTotal || 0,
        started: timings.started || 0,
        completed: timings.completed || 0
      },
      failures: failures.map(failure => ({
        source: failure.source?.name || 'Unknown',
        error: failure.error?.message || 'Unknown error',
        test: failure.error?.test || null,
        at: failure.at || null
      })),
      failedExecutions: failedExecutions,
      successRate: (() => {
        const totalRequests = requests.total || 0;
        const failedRequests = requests.failed || 0;
        const totalAssertions = assertions.total || 0;
        const failedAssertions = assertions.failed || 0;
        const totalTests = testScripts.total || 0;
        const failedTests = testScripts.failed || 0;

        const totalItems = totalRequests + totalAssertions + totalTests;
        const failedItems = failedRequests + failedAssertions + failedTests;

        if (totalItems === 0) return 100;
        return Math.round(((totalItems - failedItems) / totalItems) * 100);
      })()
    };

    console.log(`[NEWMAN PARSE] 성공적으로 파싱됨:`, {
      responseAverage: result.timings.responseAverage,
      successRate: result.successRate,
      totalRequests: result.summary.requests.total,
      failedRequests: result.summary.requests.failed,
      failedExecutions: failedExecutions.length
    });

    return result;
  } catch (error) {
    console.error('[NEWMAN PARSE ERROR]', error);
    return null;
  }
}

// Newman CLI 출력에서 통계 추출
export function parseNewmanCliOutput(stdoutPath) {
  try {
    if (!fs.existsSync(stdoutPath)) {
      return null;
    }
    
    const output = fs.readFileSync(stdoutPath, 'utf-8');
    const lines = output.split('\n');
    
    let stats = {
      requests: { executed: 0, failed: 0 },
      assertions: { executed: 0, failed: 0 },
      iterations: { executed: 0, failed: 0 }
    };
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.includes('│') && line.includes('executed') && line.includes('failed')) {
        for (let j = i + 2; j < lines.length; j++) {
          const dataLine = lines[j].trim();
          if (dataLine.includes('└')) break;
          
          if (dataLine.includes('│')) {
            const parts = dataLine.split('│').map(p => p.trim()).filter(p => p);
            if (parts.length >= 3) {
              const [type, executed, failed] = parts;
              const exec = parseInt(executed) || 0;
              const fail = parseInt(failed) || 0;
              
              if (type.includes('requests')) {
                stats.requests = { executed: exec, failed: fail };
              } else if (type.includes('assertions')) {
                stats.assertions = { executed: exec, failed: fail };
              } else if (type.includes('iterations')) {
                stats.iterations = { executed: exec, failed: fail };
              }
            }
          }
        }
        break;
      }
    }
    
    return stats;
  } catch (error) {
    console.error('[NEWMAN CLI PARSE ERROR]', error);
    return null;
  }
}

// Newman 결과 파싱 함수
export function parseNewmanOutput(output) {
  const result = {
    iterations: { executed: 0, failed: 0 },
    requests: { executed: 0, failed: 0 },
    assertions: { executed: 0, failed: 0 },
    duration: 0,
    failures: []
  };

  try {
    const iterationsMatch = output.match(/│\s*iterations\s*│\s*(\d+)\s*│\s*(\d+)\s*│/);
    if (iterationsMatch) {
      result.iterations.executed = parseInt(iterationsMatch[1]);
      result.iterations.failed = parseInt(iterationsMatch[2]);
    }

    const requestsMatch = output.match(/│\s*requests\s*│\s*(\d+)\s*│\s*(\d+)\s*│/);
    if (requestsMatch) {
      result.requests.executed = parseInt(requestsMatch[1]);
      result.requests.failed = parseInt(requestsMatch[2]);
    }

    const assertionsMatch = output.match(/│\s*assertions\s*│\s*(\d+)\s*│\s*(\d+)\s*│/);
    if (assertionsMatch) {
      result.assertions.executed = parseInt(assertionsMatch[1]);
      result.assertions.failed = parseInt(assertionsMatch[2]);
    }

    const durationMatch = output.match(/total run duration:\s*([\d.]+)s/);
    if (durationMatch) {
      result.duration = parseFloat(durationMatch[1]);
    }

    const failureSection = output.match(/# failure detail([\s\S]*?)(?=\n\n|$)/);
    if (failureSection) {
      const failures = failureSection[1].match(/\d+\.\s+.*?(?=\n\d+\.|\n\n|$)/gs);
      if (failures) {
        result.failures = failures.map(failure => {
          const lines = failure.trim().split('\n');
          const title = lines[0].replace(/^\d+\.\s*/, '');
          const details = lines.slice(1).join(' ').trim();
          return { title, details };
        }).slice(0, 5);
      }
    }
  } catch (error) {
    console.error('[PARSE ERROR]', error);
  }

  return result;
}

// 요약 생성 함수
export function generateSummary(newmanResult, exitCode) {
  if (exitCode === 0) {
    const { requests, assertions } = newmanResult;
    if (requests.executed === 0) {
      return '실행 성공 (요청 없음)';
    }
    
    const requestSummary = requests.failed === 0 
      ? `요청 ${requests.executed}건 모두 성공`
      : `요청 ${requests.executed}건 중 ${requests.executed - requests.failed}건 성공`;
    
    const assertionSummary = assertions.executed > 0
      ? assertions.failed === 0
        ? `검증 ${assertions.executed}건 모두 성공`
        : `검증 ${assertions.executed}건 중 ${assertions.executed - assertions.failed}건 성공`
      : '';

    return assertionSummary ? `${requestSummary}, ${assertionSummary}` : requestSummary;
  } else {
    const { requests, assertions, failures } = newmanResult;
    
    if (failures.length > 0) {
      const mainFailure = failures[0].title.includes('AssertionError') 
        ? failures[0].title.replace('AssertionError ', '')
        : failures[0].title;
      
      const failureCount = failures.length;
      return failureCount > 1 
        ? `${mainFailure} 외 ${failureCount - 1}건 실패`
        : mainFailure;
    }
    
    if (assertions.failed > 0) {
      return `검증 ${assertions.executed}건 중 ${assertions.failed}건 실패`;
    }
    
    if (requests.failed > 0) {
      return `요청 ${requests.executed}건 중 ${requests.failed}건 실패`;
    }
    
    return `실행 실패 (exit=${exitCode})`;
  }
}
