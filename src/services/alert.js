// alert.js (개선된 알람 시스템)
import https from 'https';
import fetch from 'node-fetch';
import path from 'path';
import { readCfg } from '../utils/config.js';

function getBaseUrl() {
  const config = readCfg();
  const port = config.site_port || 3000;
  return config.base_url || `http://localhost:${port}`;
}

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function getHookUrl() {
  const { webhook_url } = readCfg();
  return process.env.NW_HOOK || webhook_url || '';
}

export async function sendTextMessage(text) {
  const url = getHookUrl();
  if (!url) {
    console.log('[ALERT] webhook_url이 설정되지 않았습니다.');
    return { ok:false, status:0, body:'No webhook_url configured' };
  }

  // 일부 환경에서 text/plain을 요구하면 아래 주석 해제
  const asText = !!process.env.TEXT_ONLY;

  const body = asText ? text : JSON.stringify({ content: { type:'text', text } });
  
  const headers = asText
    ? { 'Content-Type': 'text/plain;charset=UTF-8' }
    : { 'Content-Type': 'application/json' };

  try {
    
    console.log(`[ALERT] 텍스트 메시지 전송 중... URL: ${url.substring(0, 50)}...`);
    console.log('[ALERT] 전송할 메시지:', asText ? text : JSON.stringify({ content: { type:'text', text } }, null, 2));

    const r = await fetch(url, { method:'POST', body, headers, agent: insecureAgent });
    const t = await r.text();
    
    
    if (r.ok) {
      console.log('[ALERT] 텍스트 메시지 전송 성공');
    } else {
      console.error(`[ALERT] 텍스트 메시지 전송 실패: ${r.status} ${r.statusText}`);
    }
    
    return { ok: r.ok, status: r.status, body: t };
  } catch (e) {
    console.error('[ALERT] 텍스트 메시지 전송 중 오류:', e.message);
    return { ok:false, status:0, body: e.message };
  }
}

export async function sendFlexMessage(flex) {
  const url = getHookUrl();
  if (!url) {
    console.log('[ALERT] webhook_url이 설정되지 않았습니다.');
    return { ok:false, status:0, body:'No webhook_url configured' };
  }

  const payload = flex?.content
    ? flex
    : {
        content: {
          type: 'flex',
          ...flex
        }
      };

  try {
    console.log(`[ALERT] Flex 메시지 전송 중... URL: ${url.substring(0, 50)}...`);
    const r = await fetch(url, {
      method:'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      agent: insecureAgent
    });
    const t = await r.text();
    
    if (r.ok) {
      console.log('[ALERT] Flex 메시지 전송 성공');
    } else {
      console.error(`[ALERT] Flex 메시지 전송 실패: ${r.status} ${r.statusText}`);
    }
    
    return { ok: r.ok, status: r.status, body: t };
  } catch (e) {
    console.error('[ALERT] Flex 메시지 전송 중 오류:', e.message);
    return { ok:false, status:0, body: e.message };
  }
}

export function buildRunStatusFlex(kind, data) {
  const baseUrl = getBaseUrl();
  
  const headerText = kind === 'start' ? 'Execution Started'
                    : kind === 'success' ? 'Execution Success'
                    : 'Execution Failed';

  const headerColor = kind === 'error' ? '#C62828'
                    : kind === 'success' ? '#2E7D32'
                    : '#1976D2';

  const timeText = kind === 'start' ? `Started: ${data.startTime}`
                  : `Ended: ${data.endTime} (${data.duration}s)`;

  // 기본 컨텐츠 구성
  const bodyContents = [
    {
      type: 'text',
      text: `Job: ${data.jobName}`,
      wrap: true,
      size: 'sm',
      color: '#333333',
      weight: 'bold'
    }
  ];

  // Collection 정보 추가 (있는 경우)
  if (data.collection) {
    bodyContents.push({
      type: 'text',
      text: `Collection: ${data.collection}`,
      wrap: true,
      size: 'xs',
      color: '#666666'
    });
  }

  // 배치 실행 통계 (yaml_batch 타입인 경우)
  if (data.type === 'yaml_batch' && data.stats) {
    bodyContents.push({
      type: 'text',
      text: `📊 결과: ${data.stats.successFiles}/${data.stats.files} 성공 (${data.stats.successRate}%)`,
      wrap: true,
      size: 'sm',
      color: data.stats.failedFiles > 0 ? '#C62828' : '#2E7D32',
      weight: 'bold',
      margin: 'sm'
    });

    // 실패한 파일 목록 표시
    if (data.result && data.result.results) {
      const failedResults = data.result.results.filter(r => !r.success);
      if (failedResults.length > 0) {
        // 실패 파일 목록 (최대 10개, 한 줄에 압축)
        const displayCount = Math.min(failedResults.length, 10);
        const failedFileNames = failedResults.slice(0, displayCount).map(f =>
          f.fileName || f.file || f.jobName || 'Unknown'
        );
        bodyContents.push({
          type: 'text',
          text: `❌ 실패(${failedResults.length}): ${failedFileNames.join(', ')}${failedResults.length > 10 ? ` 외 ${failedResults.length - 10}개` : ''}`,
          wrap: true,
          size: 'xs',
          color: '#C62828'
        });

        // ★★★ 첫 번째 실패 파일의 첫 번째 실패 step - 무조건 상세 정보 표시 ★★★
        const firstFailedFile = failedResults[0];
        const firstSteps = firstFailedFile.result?.scenarioResult?.steps || firstFailedFile.result?.result?.steps || firstFailedFile.result?.steps;

        if (firstSteps) {
          // 첫 번째 실패한 step 찾기
          const firstFailedStep = firstSteps.find(s => !s.passed);

          if (firstFailedStep) {
            // 구분선
            bodyContents.push({
              type: 'separator',
              margin: 'md'
            });

            // 파일명 + Step명
            bodyContents.push({
              type: 'text',
              text: `📋 [${firstFailedFile.fileName}] ${firstFailedStep.name}`,
              wrap: true,
              size: 'sm',
              color: '#C62828',
              weight: 'bold',
              margin: 'sm'
            });

            // Request Command (req) - 최대 1500자
            if (firstFailedStep.request) {
              let reqText = '';
              if (firstFailedStep.request.command) {
                reqText = firstFailedStep.request.command;
              } else if (firstFailedStep.request.args) {
                reqText = Object.entries(firstFailedStep.request.args)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(';');
              }
              if (reqText) {
                bodyContents.push({
                  type: 'text',
                  text: `▶ Request:`,
                  wrap: true,
                  size: 'xs',
                  color: '#1976D2',
                  weight: 'bold',
                  margin: 'sm'
                });
                bodyContents.push({
                  type: 'text',
                  text: reqText.substring(0, 1500),
                  wrap: true,
                  size: 'xs',
                  color: '#666666'
                });
              }
            }

            // Response Body (res) - 최대 1000자
            if (firstFailedStep.response) {
              let resText = '';
              if (firstFailedStep.response.parsed && Object.keys(firstFailedStep.response.parsed).length > 0) {
                resText = Object.entries(firstFailedStep.response.parsed)
                  .map(([k, v]) => `${k}=${v}`)
                  .join('\n');
              } else if (firstFailedStep.response.stdout) {
                resText = String(firstFailedStep.response.stdout);
              } else if (firstFailedStep.response.body) {
                resText = String(firstFailedStep.response.body);
              }
              if (resText) {
                bodyContents.push({
                  type: 'text',
                  text: `◀ Response:`,
                  wrap: true,
                  size: 'xs',
                  color: '#2E7D32',
                  weight: 'bold',
                  margin: 'sm'
                });
                bodyContents.push({
                  type: 'text',
                  text: resText.substring(0, 1000),
                  wrap: true,
                  size: 'xs',
                  color: '#666666'
                });
              }
            }

            // Assertion 상세 - 최대 5개
            if (firstFailedStep.tests) {
              const failedTests = firstFailedStep.tests.filter(t => !t.passed);
              if (failedTests.length > 0) {
                bodyContents.push({
                  type: 'text',
                  text: `✗ Assertion (${failedTests.length}개 실패):`,
                  wrap: true,
                  size: 'xs',
                  color: '#C62828',
                  weight: 'bold',
                  margin: 'sm'
                });

                // 최대 5개 assertion 상세
                failedTests.slice(0, 5).forEach((ft, idx) => {
                  let assertText = `${idx+1}. ${ft.name || ft.assertion}`;
                  if (ft.expected !== undefined && ft.actual !== undefined) {
                    assertText += ` [Expected: ${ft.expected}, Actual: ${ft.actual}]`;
                  } else if (ft.error) {
                    assertText += ` [${ft.error}]`;
                  }
                  bodyContents.push({
                    type: 'text',
                    text: assertText.substring(0, 500),
                    wrap: true,
                    size: 'xs',
                    color: '#666666'
                  });
                });

                if (failedTests.length > 5) {
                  bodyContents.push({
                    type: 'text',
                    text: `   ... 외 ${failedTests.length - 5}개 assertion`,
                    wrap: true,
                    size: 'xs',
                    color: '#999999'
                  });
                }
              }
            }
          }
        }

        // ★★★ 나머지 실패 파일들 - 가능한 한 최대한 표시 (최대 10개 파일) ★★★
        if (failedResults.length > 1) {
          bodyContents.push({
            type: 'separator',
            margin: 'md'
          });

          // 최대 10개 파일까지 표시
          const remainingFiles = failedResults.slice(1, 11);
          for (const failedFile of remainingFiles) {
            const steps = failedFile.result?.scenarioResult?.steps || failedFile.result?.result?.steps || failedFile.result?.steps;
            if (steps) {
              const failedSteps = steps.filter(s => !s.passed);
              const failedTestCount = failedSteps.reduce((sum, s) => sum + (s.tests?.filter(t => !t.passed)?.length || 0), 0);

              // 첫 번째 실패 step의 응답 및 assertion 요약
              const firstFailed = failedSteps[0];
              let summaryText = `📋 [${failedFile.fileName}] ${firstFailed?.name || 'Unknown'}`;

              // Response 요약 (Result, ErrMsg)
              if (firstFailed?.response?.parsed) {
                const p = firstFailed.response.parsed;
                if (p.Result !== undefined || p.ErrMsg) {
                  summaryText += `\n   ◀ Result=${p.Result || 'N/A'}, ${(p.ErrMsg || '').substring(0, 100)}`;
                }
              } else if (firstFailed?.response?.stdout) {
                summaryText += `\n   ◀ ${String(firstFailed.response.stdout).substring(0, 150)}`;
              }

              // Assertion 요약 (첫 번째 실패한 테스트)
              if (firstFailed?.tests) {
                const failedTest = firstFailed.tests.find(t => !t.passed);
                if (failedTest) {
                  let assertInfo = failedTest.name || failedTest.assertion || 'Unknown';
                  if (failedTest.expected !== undefined && failedTest.actual !== undefined) {
                    assertInfo += ` [Exp: ${String(failedTest.expected).substring(0, 30)}, Act: ${String(failedTest.actual).substring(0, 30)}]`;
                  }
                  summaryText += `\n   ✗ ${assertInfo.substring(0, 150)}`;
                }
              }

              bodyContents.push({
                type: 'text',
                text: summaryText.substring(0, 600),
                wrap: true,
                size: 'xs',
                color: '#666666',
                margin: 'sm'
              });
            }
          }

          if (failedResults.length > 11) {
            bodyContents.push({
              type: 'text',
              text: `... 외 ${failedResults.length - 11}개 파일 상세 생략`,
              wrap: true,
              size: 'xs',
              color: '#999999'
            });
          }
        }
      }
    }
  }

  // 환경 정보 추가 (있는 경우)
  if (data.environment) {
    bodyContents.push({
      type: 'text',
      text: `Environment: ${data.environment}`,
      wrap: true,
      size: 'xs',
      color: '#666666'
    });
  }

  // Newman 통계 정보 추가 (성공/실패 관계없이) - 한 줄로 압축
  if (data.newmanStats) {
    const stats = data.newmanStats;
    const parts = [];

    if (stats.assertions?.total > 0) {
      const passed = stats.assertions.total - (stats.assertions.failed || 0);
      parts.push(`Assertions: ${passed}/${stats.assertions.total}`);
    }
    if (stats.requests?.total > 0) {
      const passed = stats.requests.total - (stats.requests.failed || 0);
      parts.push(`Requests: ${passed}/${stats.requests.total}`);
    }
    if (stats.testScripts?.total > 0) {
      const passed = stats.testScripts.total - (stats.testScripts.failed || 0);
      parts.push(`Tests: ${passed}/${stats.testScripts.total}`);
    }

    if (parts.length > 0) {
      const hasFailed = (stats.assertions?.failed > 0) || (stats.requests?.failed > 0) || (stats.testScripts?.failed > 0);
      bodyContents.push({
        type: 'text',
        text: `📊 ${parts.join(' | ')}`,
        wrap: true,
        size: 'xs',
        color: hasFailed ? '#C62828' : '#2E7D32',
        weight: hasFailed ? 'bold' : 'regular',
        margin: 'xs'
      });
    }

  }

  // 성능 정보 추가
  if (data.performanceInfo) {
    const perf = data.performanceInfo;
    
    if (perf.successRate !== undefined) {
      const rateColor = perf.successRate >= 95 ? '#2E7D32' : perf.successRate >= 80 ? '#F57C00' : '#C62828';
      bodyContents.push({
        type: 'text',
        text: `Success Rate: ${perf.successRate}%`,
        wrap: true,
        size: 'xs',
        color: rateColor,
        weight: 'bold'
      });
    }
    
    if (perf.avgResponseTime > 0) {
      bodyContents.push({
        type: 'text',
        text: `Avg Response: ${Math.round(perf.avgResponseTime)}ms`,
        wrap: true,
        size: 'xs',
        color: '#666666'
      });
    }
  }

  // 실패한 경우 상세 실패 정보 추가
  if (kind === 'error') {
    // CLI에서 파싱한 상세 실패 정보 우선 표시
    if (data.detailedFailures && data.detailedFailures.length > 0) {
      bodyContents.push({
        type: 'text',
        text: `❌ Failed Tests (${data.detailedFailures.length}):`,
        wrap: true,
        size: 'xs',
        color: '#C62828',
        weight: 'bold',
        margin: 'xs'
      });

      // 최대 8개까지 상세 실패 테스트 표시 (압축 형태)
      data.detailedFailures.slice(0, 8).forEach((failure, idx) => {
        let failText = `${idx+1}. ${failure.testName}`;
        if (failure.requestName && failure.requestName !== 'Unknown Request') {
          failText += ` (${failure.requestName})`;
        }
        if (failure.errorDetails) {
          failText += ` - ${String(failure.errorDetails).substring(0, 200)}`;
        }
        if (failure.expectedValue && failure.actualValue) {
          failText += ` [Expected: ${failure.expectedValue}, Actual: ${failure.actualValue}]`;
        }
        bodyContents.push({
          type: 'text',
          text: failText.substring(0, 500),
          wrap: true,
          size: 'xs',
          color: '#666666'
        });
      });

      if (data.detailedFailures.length > 8) {
        bodyContents.push({
          type: 'text',
          text: `... 외 ${data.detailedFailures.length - 8}개 실패`,
          wrap: true,
          size: 'xs',
          color: '#999999'
        });
      }
    } else if (data.failureDetails && data.failureDetails.length > 0) {
      // JSON에서 파싱한 기본 실패 정보 표시 (fallback) - 최대 6개
      data.failureDetails.slice(0, 6).forEach((failure, idx) => {
        bodyContents.push({
          type: 'text',
          text: `${idx+1}. ${failure.test}: ${String(failure.error).substring(0, 300)}`,
          wrap: true,
          size: 'xs',
          color: '#666666'
        });
      });

      if (data.failureDetails.length > 6) {
        bodyContents.push({
          type: 'text',
          text: `... 외 ${data.failureDetails.length - 6}개 실패`,
          wrap: true,
          size: 'xs',
          color: '#999999'
        });
      }
    } else if (data.errorSummary) {
      bodyContents.push({
        type: 'text',
        text: `Error: ${String(data.errorSummary).substring(0, 500)}`,
        wrap: true,
        size: 'xs',
        color: '#666666'
      });
    }

    // Response Body 표시 (failedExecutions가 있는 경우 - Newman) - 최대 4개, 1500자
    if (data.failedExecutions && data.failedExecutions.length > 0) {
      bodyContents.push({
        type: 'text',
        text: `📋 Response (${data.failedExecutions.length}):`,
        wrap: true,
        size: 'xs',
        color: '#C62828',
        weight: 'bold',
        margin: 'xs'
      });

      data.failedExecutions.slice(0, 4).forEach((exec, idx) => {
        let respText = `${idx+1}. ${exec.name}`;
        if (exec.response?.status) {
          respText += ` [${exec.response.status}]`;
        }
        if (exec.response?.body) {
          respText += `: ${String(exec.response.body).substring(0, 1500)}`;
        }
        bodyContents.push({
          type: 'text',
          text: respText.substring(0, 2000),
          wrap: true,
          size: 'xs',
          color: '#888888'
        });
      });

      if (data.failedExecutions.length > 4) {
        bodyContents.push({
          type: 'text',
          text: `... 외 ${data.failedExecutions.length - 4}개 요청`,
          wrap: true,
          size: 'xs',
          color: '#999999'
        });
      }
    }

    // failureReport 표시 (텍스트 형태의 상세 리포트 - 최대 3000자)
    if (data.failureReport && !data.failedExecutions?.length) {
      const reportText = String(data.failureReport).substring(0, 3000);
      bodyContents.push({
        type: 'text',
        text: reportText + (data.failureReport.length > 3000 ? '...' : ''),
        wrap: true,
        size: 'xs',
        color: '#666666'
      });
    }
  }

  // 성공한 경우 추가 정보
  if (kind === 'success' && data.reportPath) {
    bodyContents.push({
      type: 'text',
      text: '✅ HTML report generated',
      wrap: true,
      size: 'xs',
      color: '#2E7D32',
      margin: 'xs'
    });
  }

  // 시간 정보 추가
  bodyContents.push({
    type: 'text',
    text: timeText,
    size: 'xs',
    color: '#888888',
    align: 'end',
    margin: 'xs'
  });

  const flexMessage = {
    content: {
      type: 'flex',
      altText: `${headerText}: ${data.jobName}`,
      contents: {
        type: 'bubble',
        size: 'mega',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: headerText,
              weight: 'bold',
              size: 'lg',
              color: '#FFFFFF'
            },
            {
              type: 'text',
              text: 'API Test Automation Monitoring',
              size: 'sm',
              color: '#E0E0E0'
            }
          ],
          backgroundColor: headerColor,
          paddingAll: '15px'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: bodyContents,
          paddingAll: '15px'
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              spacing: 'sm',
              contents: [
                {
                  type: 'button',
                  action: {
                    type: 'uri',
                    label: 'Dashboard',
                    uri: baseUrl
                  },
                  style: 'primary',
                  color: '#1976D2'
                },
                ...(data.reportPath ? [{
                  type: 'button',
                  action: {
                    type: 'uri',
                    label: 'View Report',
                    uri: `${baseUrl}/reports/${path.basename(data.reportPath)}`
                  },
                  style: 'secondary'
                }] : [{
                  type: 'button',
                  action: {
                    type: 'uri',
                    label: 'Reports',
                    uri: `${baseUrl}/reports`
                  },
                  style: 'secondary'
                }])
              ]
            }
          ],
          paddingAll: '12px'
        }
      }
    }
  };

  return flexMessage;
}
/** 웹훅 URL 유효성 검사 */
export function validateWebhookUrl(url) {
  if (!url) return { valid: false, message: 'URL이 비어있습니다.' };
  
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, message: 'HTTP 또는 HTTPS URL이어야 합니다.' };
    }
    return { valid: true, message: 'URL이 유효합니다.' };
  } catch (e) {
    return { valid: false, message: '유효하지 않은 URL 형식입니다.' };
  }
}

/** 알람 설정 검증 */
export function validateAlertConfig(config) {
  const errors = [];
  
  if (config.run_event_alert && !getHookUrl()) {
    errors.push('알람이 활성화되어 있지만 webhook_url이 설정되지 않았습니다.');
  }
  
  if (config.alert_method && !['text', 'flex'].includes(config.alert_method)) {
    errors.push('alert_method는 "text" 또는 "flex"여야 합니다.');
  }
  
  return {
    valid: errors.length === 0,
    errors: errors
  };
}

/** 연결 테스트 */
export async function testWebhookConnection() {
  const url = getHookUrl();
  if (!url) {
    return { 
      success: false, 
      message: 'webhook_url이 설정되지 않았습니다.' 
    };
  }

  try {
    const testMessage = {
      content: {
        type: 'text',
        text: '🔧 API 자동화 모니터링 시스템 연결 테스트\n테스트 시간: ' + new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
      }
    };

    console.log('[ALERT] 웹훅 연결 테스트 중...');
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(testMessage),
      headers: { 'Content-Type': 'application/json' },
      agent: insecureAgent,
      timeout: 10000 // 10초 타임아웃
    });

    const responseText = await response.text();
    
    if (response.ok) {
      console.log('[ALERT] 웹훅 연결 테스트 성공');
      return {
        success: true,
        message: '웹훅 연결이 성공했습니다.',
        status: response.status,
        response: responseText
      };
    } else {
      console.error(`[ALERT] 웹훅 연결 테스트 실패: ${response.status}`);
      return {
        success: false,
        message: `웹훅 연결 실패: ${response.status} ${response.statusText}`,
        status: response.status,
        response: responseText
      };
    }
  } catch (error) {
    console.error('[ALERT] 웹훅 연결 테스트 중 오류:', error.message);
    return {
      success: false,
      message: `연결 오류: ${error.message}`,
      error: error.message
    };
  }
}export function buildBasicRunStatusFlex(kind, data) {
  const baseUrl = getBaseUrl();
  
  const headerText = kind === 'start' ? '실행 시작'
                    : kind === 'success' ? '실행 성공'
                    : '실행 실패';

  const headerColor = kind === 'error' ? '#C62828'
                    : kind === 'success' ? '#2E7D32'
                    : '#1976D2';

  const bodyContents = [
    {
      type: 'text',
      text: `Job: ${data.jobName}`,
      weight: 'bold',
      size: 'sm',
      color: '#222222'
    },
    {
      type: 'text',
      text: `Colletion: ${data.collection}`,
      size: 'xs',
      color: '#666666',
      wrap: true
    }
  ];

  if (data.environment) {
    bodyContents.push({
      type: 'text',
      text: `env: ${data.environment}`,
      size: 'xs',
      color: '#666666',
      wrap: true
    });
  }

  // 성공/실패 시 추가 정보
  if (kind === 'success' || kind === 'error') {
    bodyContents.push({
      type: 'separator',
      margin: 'md'
    });
    
    bodyContents.push({
      type: 'text',
      text: `Duration: ${data.duration}초`,
      size: 'xs',
      color: '#666666'
    });
    
    // Newman 통계 추가
    if (data.newmanStats) {
      const stats = data.newmanStats;
      
      bodyContents.push({
        type: 'separator',
        margin: 'sm'
      });
      
      bodyContents.push({
        type: 'text',
        text: '실행 결과',
        weight: 'bold',
        size: 'xs',
        color: '#333333'
      });
      
      bodyContents.push({
        type: 'text',
        text: `• 요청: ${stats.requests.executed}건 (실패: ${stats.requests.failed}건)`,
        size: 'xs',
        color: stats.requests.failed > 0 ? '#C62828' : '#2E7D32'
      });
      
      bodyContents.push({
        type: 'text',
        text: `• 테스트: ${stats.assertions.executed}건 (실패: ${stats.assertions.failed}건)`,
        size: 'xs',
        color: stats.assertions.failed > 0 ? '#C62828' : '#2E7D32'
      });
    }
    
    if (kind === 'error') {
      if (data.errorSummary) {
        bodyContents.push({
          type: 'separator',
          margin: 'sm'
        });
        
        bodyContents.push({
          type: 'text',
          text: `오류: ${data.errorSummary}`,
          size: 'xs',
          color: '#C62828',
          wrap: true
        });
      }
    }
  }

  // 시간 정보
  const timeText = kind === 'start' ? data.startTime
                  : `${data.endTime} (${data.duration}초)`;

  bodyContents.push({
    type: 'separator',
    margin: 'md'
  });
  
  bodyContents.push({
    type: 'text',
    text: ` ${timeText}`,
    size: 'xs',
    color: '#888888',
    align: 'end'
  });

  // footer 구성
  const footerContents = [];

  if (kind === 'success' || kind === 'error') {
    if (kind === 'success') {
      // 성공시: 대시보드만
      footerContents.push({
        type: 'button',
        style: 'primary',
        height: 'sm',
        action: {
          type: 'uri',
          label: '📊 대시보드 확인하기',
          uri: baseUrl
        },
        color: '#2E7D32'
      });
    } else if (kind === 'error') {
      // 실패시: 대시보드 + 리포트
      const buttonBox = {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            flex: 1,
            action: {
              type: 'uri',
              label: ' 대시보드',
              uri: baseUrl
            },
            color: '#1976D2'
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            flex: 1,
            action: {
              type: 'uri',
              label: '상세 리포트',
              uri: data.reportPath ? `${baseUrl}/reports/${path.basename(data.reportPath)}` : baseUrl
            },
            color: '#FF5722'
          }
        ]
      };
      footerContents.push(buttonBox);
    }
  }

  const flexMessage = {
    content: {
      type: 'flex',
      altText: `${headerText}: ${data.jobName}`,
      contents: {
        type: 'bubble',
        size: 'mega',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: headerText,
              weight: 'bold',
              size: 'lg',
              color: '#FFFFFF'
            },
            {
              type: 'text',
              text: 'API 자동화 모니터링',
              size: 'sm',
              color: '#E0E0E0'
            }
          ],
          backgroundColor: headerColor,
          paddingAll: '15px'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: bodyContents,
          paddingAll: '15px'
        }
      }
    }
  };

  // footer가 있을 때만 추가
  if (footerContents.length > 0) {
    flexMessage.content.contents.footer = {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: footerContents,
      paddingAll: '15px',
      backgroundColor: '#F8F9FA'
    };
  }

  return flexMessage;
}

/** 디스크 사용량 알람 Flex 메시지 생성 */
function makeDiskInfoRow(label, value, valueColor = '#333333') {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#888888', flex: 2 },
      { type: 'text', text: value, size: 'sm', color: valueColor, weight: 'bold', flex: 3, align: 'end' }
    ]
  };
}

export function buildDiskAlertFlex(info, level, kind) {
  const baseUrl = getBaseUrl();
  const isRecover = kind === 'recover';

  const headerColor = isRecover ? '#2E7D32'
    : level >= 95 ? '#C62828'
    : level >= 90 ? '#E64A19'
    : level >= 85 ? '#FB8C00'
    : '#F57C00';

  const headerIcon = isRecover ? '✅'
    : level >= 95 ? '🚨'
    : level >= 90 ? '🔴'
    : level >= 85 ? '🟠'
    : '⚠️';

  const headerText = isRecover
    ? `디스크 용량 복구 — ${level}% 미만`
    : `디스크 사용량 ${level}% 초과`;

  const percentColor = isRecover ? '#2E7D32'
    : info.usedPercent >= 95 ? '#C62828'
    : info.usedPercent >= 90 ? '#E64A19'
    : info.usedPercent >= 85 ? '#FB8C00'
    : '#F57C00';

  const freeColor = info.freeGB < 20 ? '#C62828'
    : info.freeGB < 50 ? '#F57C00'
    : '#2E7D32';

  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  return {
    content: {
      type: 'flex',
      altText: `${headerText} — ${info.drive} ${info.usedPercent.toFixed(1)}%`,
      contents: {
        type: 'bubble',
        size: 'mega',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: `${headerIcon} ${headerText}`,
              weight: 'bold',
              size: 'lg',
              color: '#FFFFFF'
            },
            {
              type: 'text',
              text: `${info.drive} Drive · API Monitor`,
              size: 'xs',
              color: '#E0E0E0',
              margin: 'xs'
            }
          ],
          backgroundColor: headerColor,
          paddingAll: '16px'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'text',
                  text: `${info.usedPercent.toFixed(1)}%`,
                  size: '3xl',
                  weight: 'bold',
                  color: percentColor,
                  align: 'center'
                },
                {
                  type: 'text',
                  text: '현재 사용률',
                  size: 'xs',
                  color: '#999999',
                  align: 'center',
                  margin: 'xs'
                }
              ]
            },
            { type: 'separator', margin: 'md' },
            {
              type: 'box',
              layout: 'vertical',
              spacing: 'sm',
              margin: 'md',
              contents: [
                makeDiskInfoRow('사용 용량', `${info.usedGB.toFixed(1)} GB`),
                makeDiskInfoRow('전체 용량', `${info.totalGB.toFixed(1)} GB`),
                makeDiskInfoRow('여유 공간', `${info.freeGB.toFixed(1)} GB`, freeColor)
              ]
            },
            { type: 'separator', margin: 'md' },
            {
              type: 'text',
              text: `확인 시각: ${now}`,
              size: 'xs',
              color: '#888888',
              align: 'end',
              margin: 'sm'
            }
          ],
          paddingAll: '16px'
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'primary',
              height: 'sm',
              action: { type: 'uri', label: '대시보드 확인', uri: baseUrl },
              color: headerColor
            }
          ],
          paddingAll: '12px'
        }
      }
    }
  };
}

/** 일일 통계 리포트 텍스트 메시지 생성 */
export function buildDailyReportText(stats) {
  const baseUrl = getBaseUrl();
  const today = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    timeZone: 'Asia/Seoul'
  });

  let message = `📊 일일 실행 통계 리포트\n`;
  message += `${today}\n\n`;
  message += `• 총 실행: ${stats.totalExecutions}건\n`;
  message += `• 성공률: ${stats.successRate}%\n`;
  message += `• 실패 건수: ${stats.failedTests}건\n`;
  message += `• 평균 응답시간: ${Math.round(stats.avgResponseTime || 0)}ms\n`;

  // 서비스별 통계 추가
  if (stats.serviceStats && Object.keys(stats.serviceStats).length > 0) {
    message += `\n📋 서비스별 실행 현황\n`;
    for (const [service, data] of Object.entries(stats.serviceStats)) {
      const serviceRate = data.total > 0 ? Math.round((data.success / data.total) * 100) : 0;
      message += `• ${service}: ${data.success}/${data.total} (${serviceRate}%)\n`;
    }
  }

  message += `\n대시보드: ${baseUrl}`;

  return message;
}

/** 일일 통계 리포트 Flex 메시지 생성 */
export function buildDailyReportFlex(stats) {
  const baseUrl = getBaseUrl();
  const today = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    timeZone: 'Asia/Seoul'
  });

  const successRate = parseFloat(stats.successRate) || 0;
  const rateColor = successRate >= 95 ? '#2E7D32' : successRate >= 80 ? '#F57C00' : '#C62828';

  // 기본 body 컨텐츠
  const bodyContents = [
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'text',
          text: '총 실행',
          size: 'sm',
          color: '#666666',
          flex: 2
        },
        {
          type: 'text',
          text: `${stats.totalExecutions}건`,
          size: 'sm',
          color: '#333333',
          weight: 'bold',
          flex: 3,
          align: 'end'
        }
      ]
    },
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'text',
          text: '성공률',
          size: 'sm',
          color: '#666666',
          flex: 2
        },
        {
          type: 'text',
          text: `${stats.successRate}%`,
          size: 'sm',
          color: rateColor,
          weight: 'bold',
          flex: 3,
          align: 'end'
        }
      ]
    },
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'text',
          text: '실패 건수',
          size: 'sm',
          color: '#666666',
          flex: 2
        },
        {
          type: 'text',
          text: `${stats.failedTests}건`,
          size: 'sm',
          color: stats.failedTests > 0 ? '#C62828' : '#333333',
          weight: 'bold',
          flex: 3,
          align: 'end'
        }
      ]
    },
    {
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'text',
          text: '평균 응답시간',
          size: 'sm',
          color: '#666666',
          flex: 2
        },
        {
          type: 'text',
          text: `${Math.round(stats.avgResponseTime || 0)}ms`,
          size: 'sm',
          color: '#333333',
          weight: 'bold',
          flex: 3,
          align: 'end'
        }
      ]
    }
  ];

  // 서비스별 통계 추가
  if (stats.serviceStats && Object.keys(stats.serviceStats).length > 0) {
    bodyContents.push({
      type: 'separator',
      margin: 'lg'
    });

    bodyContents.push({
      type: 'text',
      text: '📋 서비스별 실행 현황',
      size: 'sm',
      weight: 'bold',
      color: '#333333',
      margin: 'md'
    });

    for (const [service, data] of Object.entries(stats.serviceStats)) {
      const serviceRate = data.total > 0 ? Math.round((data.success / data.total) * 100) : 0;
      const serviceColor = serviceRate >= 95 ? '#2E7D32' : serviceRate >= 80 ? '#F57C00' : '#C62828';

      bodyContents.push({
        type: 'box',
        layout: 'horizontal',
        margin: 'sm',
        contents: [
          {
            type: 'text',
            text: service,
            size: 'xs',
            color: '#666666',
            flex: 2
          },
          {
            type: 'text',
            text: `${data.success}/${data.total} (${serviceRate}%)`,
            size: 'xs',
            color: serviceColor,
            weight: 'bold',
            flex: 3,
            align: 'end'
          }
        ]
      });
    }
  }

  return {
    content: {
      type: 'flex',
      altText: `일일 실행 통계 리포트 - ${today}`,
      contents: {
        type: 'bubble',
        size: 'mega',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '📊 일일 실행 통계',
              weight: 'bold',
              size: 'lg',
              color: '#FFFFFF'
            },
            {
              type: 'text',
              text: today,
              size: 'sm',
              color: '#E0E0E0'
            }
          ],
          backgroundColor: '#1976D2',
          paddingAll: '15px'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'md',
          contents: bodyContents,
          paddingAll: '15px'
        }
      }
    }
  };
}
