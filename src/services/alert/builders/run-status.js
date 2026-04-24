// src/services/alert/builders/run-status.js — Job 실행 상태(start/success/error) Flex 빌더
import path from 'path';
import { readCfg } from '../../../utils/config.js';

function getBaseUrl() {
  const config = readCfg();
  const port = config.site_port || 3000;
  return config.base_url || `http://localhost:${port}`;
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
