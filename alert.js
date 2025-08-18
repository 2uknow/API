// alert.js (개선된 알람 시스템)
import https from 'https';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const cfgPath = path.join(process.cwd(), 'config', 'settings.json');

function readCfg() {
  try { 
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); 
  } catch { 
    return {}; 
  }
}
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

  try {
    console.log(`[ALERT] Flex 메시지 전송 중... URL: ${url.substring(0, 50)}...`);
    const r = await fetch(url, {
      method:'POST',
      body: JSON.stringify(flex),
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


/** 통계 정보를 포함한 실행 상태 알림을 위한 Flex 메시지 생성 */
export function buildRunStatusFlexWithStats(kind, data) {
  // 기본 Flex 메시지 생성
  const flexMessage = buildRunStatusFlex(kind, data);
  
  // 통계 정보가 있는 경우에만 추가
  if (data.stats) {
    const statsContents = [];
    
    // 통계 섹션 구분선
    statsContents.push({
      type: 'separator',
      margin: 'md'
    });
    
    // 통계 헤더
    statsContents.push({
      type: 'text',
      text: '📊 실행 통계',
      weight: 'bold',
      size: 'sm',
      color: '#333333',
      margin: 'md'
    });

    // 통계 데이터 추가
    if (data.stats.iterations) {
      statsContents.push({
        type: 'box',
        layout: 'baseline',
        contents: [
          {
            type: 'text',
            text: '반복횟수:',
            size: 'xs',
            color: '#666666',
            flex: 2
          },
          {
            type: 'text',
            text: `${data.stats.iterations.total}회`,
            size: 'xs',
            color: '#333333',
            flex: 3,
            align: 'end'
          }
        ]
      });
    }

    if (data.stats.requests) {
      statsContents.push({
        type: 'box',
        layout: 'baseline',
        contents: [
          {
            type: 'text',
            text: '요청수:',
            size: 'xs',
            color: '#666666',
            flex: 2
          },
          {
            type: 'text',
            text: `${data.stats.requests.total}개`,
            size: 'xs',
            color: '#333333',
            flex: 3,
            align: 'end'
          }
        ]
      });
    }

    if (data.stats.assertions) {
      const failedCount = data.stats.assertions.failed || 0;
      const totalCount = data.stats.assertions.total || 0;
      const successRate = totalCount > 0 ? Math.round(((totalCount - failedCount) / totalCount) * 100) : 0;
      
      statsContents.push({
        type: 'box',
        layout: 'baseline',
        contents: [
          {
            type: 'text',
            text: '성공률:',
            size: 'xs',
            color: '#666666',
            flex: 2
          },
          {
            type: 'text',
            text: `${successRate}%`,
            size: 'xs',
            color: successRate >= 95 ? '#2E7D32' : successRate >= 80 ? '#F57C00' : '#C62828',
            flex: 3,
            align: 'end',
            weight: 'bold'
          }
        ]
      });

      if (failedCount > 0) {
        statsContents.push({
          type: 'box',
          layout: 'baseline',
          contents: [
            {
              type: 'text',
              text: '실패:',
              size: 'xs',
              color: '#666666',
              flex: 2
            },
            {
              type: 'text',
              text: `${failedCount}개`,
              size: 'xs',
              color: '#C62828',
              flex: 3,
              align: 'end',
              weight: 'bold'
            }
          ]
        });
      }
    }

    if (data.stats.avgResponseTime) {
      statsContents.push({
        type: 'box',
        layout: 'baseline',
        contents: [
          {
            type: 'text',
            text: '평균응답:',
            size: 'xs',
            color: '#666666',
            flex: 2
          },
          {
            type: 'text',
            text: `${data.stats.avgResponseTime}ms`,
            size: 'xs',
            color: '#333333',
            flex: 3,
            align: 'end'
          }
        ]
      });
    }

    // 통계 정보를 body에 추가
    flexMessage.content.contents.body.contents.splice(-2, 0, ...statsContents);
  }

  return flexMessage;
}

// alert.js의 buildStatusText 함수 수정
/** 간단한 상태 알림을 위한 텍스트 생성 */
export function buildStatusText(kind, data) {
  let message = '';
  
  if (kind === 'start') {
    message = `API Test Execution Started\n`;
    message += `Job: ${data.jobName}\n`;
    message += `Collection: ${data.collection}\n`;
    if (data.environment) {
      message += `Environment: ${data.environment}\n`;
    }
    message += `Time: ${data.startTime}`;
  } else if (kind === 'success') {
    message = `API Test Execution Success\n`;
    message += `Job: ${data.jobName}\n`;
    message += `Duration: ${data.duration}s\n`;
    message += `End Time: ${data.endTime}`;
  } else if (kind === 'error') {
    message = `API Test Execution Failed\n`;
    message += `Job: ${data.jobName}\n`;
    message += `Exit Code: ${data.exitCode}\n`;
    message += `Duration: ${data.duration}s\n`;
    message += `End Time: ${data.endTime}`;
    if (data.errorSummary) {
      message += `\nError: ${data.errorSummary}`;
    }
    // 실패 요약 리포트 추가
    if (data.failureReport) {
      message += `\n\nFailure Summary Report:\n${data.failureReport}`;
    }
  }
  
  return message;
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
    },
    {
      type: 'text',
      text: `Collection: ${data.collection}`,
      wrap: true,
      size: 'xs',
      color: '#666666'
    }
  ];

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

  // Newman 통계 정보 추가 (성공/실패 관계없이)
  if (data.newmanStats) {
    bodyContents.push({
      type: 'separator',
      margin: 'md'
    });
    
    bodyContents.push({
      type: 'text',
      text: 'Test Results',
      wrap: true,
      size: 'sm',
      color: '#333333',
      weight: 'bold'
    });

    const stats = data.newmanStats;
    
    // Assertions 정보
    if (stats.assertions && stats.assertions.total > 0) {
      const assertionColor = stats.assertions.failed > 0 ? '#C62828' : '#2E7D32';
      const assertionText = stats.assertions.failed > 0 
        ? `Assertions: ${stats.assertions.total - stats.assertions.failed}/${stats.assertions.total} passed`
        : `Assertions: ${stats.assertions.total}/${stats.assertions.total} passed`;
      
      bodyContents.push({
        type: 'text',
        text: assertionText,
        wrap: true,
        size: 'xs',
        color: assertionColor,
        weight: stats.assertions.failed > 0 ? 'bold' : 'regular'
      });
    }
    
    // Requests 정보
    if (stats.requests && stats.requests.total > 0) {
      const requestColor = stats.requests.failed > 0 ? '#C62828' : '#2E7D32';
      const requestText = stats.requests.failed > 0 
        ? `Requests: ${stats.requests.total - stats.requests.failed}/${stats.requests.total} succeeded`
        : `Requests: ${stats.requests.total}/${stats.requests.total} succeeded`;
      
      bodyContents.push({
        type: 'text',
        text: requestText,
        wrap: true,
        size: 'xs',
        color: requestColor,
        weight: stats.requests.failed > 0 ? 'bold' : 'regular'
      });
    }
    
    // Tests 정보
    if (stats.testScripts && stats.testScripts.total > 0) {
      const testColor = stats.testScripts.failed > 0 ? '#C62828' : '#2E7D32';
      const testText = stats.testScripts.failed > 0 
        ? `Tests: ${stats.testScripts.total - stats.testScripts.failed}/${stats.testScripts.total} passed`
        : `Tests: ${stats.testScripts.total}/${stats.testScripts.total} passed`;
      
      bodyContents.push({
        type: 'text',
        text: testText,
        wrap: true,
        size: 'xs',
        color: testColor,
        weight: stats.testScripts.failed > 0 ? 'bold' : 'regular'
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
    bodyContents.push({
      type: 'separator',
      margin: 'md'
    });
    
    bodyContents.push({
      type: 'text',
      text: `Exit Code: ${data.exitCode}`,
      wrap: true,
      size: 'sm',
      color: '#C62828',
      weight: 'bold'
    });

    // CLI에서 파싱한 상세 실패 정보 우선 표시
    if (data.detailedFailures && data.detailedFailures.length > 0) {
      bodyContents.push({
        type: 'text',
        text: `Failed Tests (${data.detailedFailures.length} total):`,
        wrap: true,
        size: 'sm',
        color: '#C62828',
        weight: 'bold',
        margin: 'sm'
      });
      
      // 최대 4개까지 상세 실패 테스트 표시
      data.detailedFailures.slice(0, 4).forEach(failure => {
        bodyContents.push({
          type: 'text',
          text: `${failure.index}. ${failure.testName}`,
          wrap: true,
          size: 'xs',
          color: '#C62828',
          weight: 'bold',
          margin: 'xs'
        });
        
        if (failure.requestName && failure.requestName !== 'Unknown Request') {
          bodyContents.push({
            type: 'text',
            text: `   Request: ${failure.requestName}`,
            wrap: true,
            size: 'xs',
            color: '#666666',
            margin: 'none'
          });
        }
        
        if (failure.errorDetails) {
          bodyContents.push({
            type: 'text',
            text: `   Error: ${failure.errorDetails}`,
            wrap: true,
            size: 'xs',
            color: '#888888',
            margin: 'none'
          });
        }
        
        if (failure.expectedValue && failure.actualValue) {
          bodyContents.push({
            type: 'text',
            text: `   Expected: ${failure.expectedValue}`,
            wrap: true,
            size: 'xs',
            color: '#666666',
            margin: 'none'
          });
          bodyContents.push({
            type: 'text',
            text: `   Actual: ${failure.actualValue}`,
            wrap: true,
            size: 'xs',
            color: '#666666',
            margin: 'none'
          });
        }
      });
      
      if (data.detailedFailures.length > 4) {
        bodyContents.push({
          type: 'text',
          text: `... and ${data.detailedFailures.length - 4} more failures. Check report for full details.`,
          wrap: true,
          size: 'xs',
          color: '#888888',
          style: 'italic'
        });
      }
    } else if (data.failureDetails && data.failureDetails.length > 0) {
      // JSON에서 파싱한 기본 실패 정보 표시 (fallback)
      bodyContents.push({
        type: 'text',
        text: 'Failed Tests:',
        wrap: true,
        size: 'sm',
        color: '#C62828',
        weight: 'bold',
        margin: 'sm'
      });
      
      data.failureDetails.slice(0, 3).forEach(failure => {
        bodyContents.push({
          type: 'text',
          text: `• ${failure.test}: ${failure.error}`,
          wrap: true,
          size: 'xs',
          color: '#666666',
          margin: 'xs'
        });
      });
      
      if (data.failureDetails.length > 3) {
        bodyContents.push({
          type: 'text',
          text: `... and ${data.failureDetails.length - 3} more failures`,
          wrap: true,
          size: 'xs',
          color: '#888888',
          style: 'italic'
        });
      }
    } else if (data.errorSummary) {
      bodyContents.push({
        type: 'text',
        text: `Error: ${data.errorSummary}`,
        wrap: true,
        size: 'xs',
        color: '#666666'
      });
    }
  }

  // 성공한 경우 추가 정보
  if (kind === 'success' && data.reportPath) {
    bodyContents.push({
      type: 'separator',
      margin: 'md'
    });
    
    bodyContents.push({
      type: 'text',
      text: 'Detailed HTML report has been generated.',
      wrap: true,
      size: 'xs',
      color: '#2E7D32'
    });
  }

  // 시간 정보 추가
  bodyContents.push({
    type: 'separator',
    margin: 'md'
  });
  
  bodyContents.push({
    type: 'text',
    text: timeText,
    size: 'xs',
    color: '#888888',
    align: 'end'
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
// 개선된 텍스트 메시지 생성
export function buildTextMessage(kind, data) {
  if (kind === 'start') {
    return ` API 테스트 실행 시작\n잡: ${data.jobName}\n시간: ${data.startTime}`;
  } 
  
  if (kind === 'success') {
    let message = ` API 테스트 실행 성공\n잡: ${data.jobName}\n실행시간: ${data.duration}초\n종료시간: ${data.endTime}`;
    
    if (data.newmanResult) {
      const { requests, assertions } = data.newmanResult;
      message += `\n\n 실행 결과:`;
      
      if (requests.executed > 0) {
        message += `\n• 요청: ${requests.executed}건 실행, ${requests.executed - requests.failed}건 성공`;
      }
      
      if (assertions.executed > 0) {
        message += `\n• 검증: ${assertions.executed}건 실행, ${assertions.executed - assertions.failed}건 성공`;
      }
    }
    
    return message;
  }
  
  if (kind === 'error') {
    let message = ` API 테스트 실행 실패\n잡: ${data.jobName}\n종료코드: ${data.exitCode}\n실행시간: ${data.duration}초\n종료시간: ${data.endTime}`;
    
    if (data.summary) {
      message += `\n오류 요약: ${data.summary}`;
    }
    
    if (data.newmanResult) {
      const { requests, assertions, failures } = data.newmanResult;
      
      if (requests.executed > 0 || assertions.executed > 0) {
        message += `\n\n 실행 결과:`;
        
        if (requests.executed > 0) {
          message += `\n• 요청: ${requests.executed}건 중 ${requests.failed}건 실패`;
        }
        
        if (assertions.executed > 0) {
          message += `\n• 검증: ${assertions.executed}건 중 ${assertions.failed}건 실패`;
        }
      }
      
      if (failures && failures.length > 0) {
        message += `\n\n 주요 실패 원인:`;
        failures.slice(0, 2).forEach((failure, index) => {
          message += `\n${index + 1}. ${failure.title}`;
        });
        
        if (failures.length > 2) {
          message += `\n... 외 ${failures.length - 2}건 더`;
        }
      }
    }
    
    return message;
  }
  
  return `알 수 없는 메시지 타입: ${kind}`;
}
export function buildBasicStatusText(kind, data) {
  const baseUrl = getBaseUrl();
  let message = '';
  
  if (kind === 'start') {
    message = `API 테스트 실행 시작\n`;
    message += `Job: ${data.jobName}\n`;
    message += `Collection: ${data.collection}\n`;
    if (data.environment) {
      message += `env: ${data.environment}\n`;
    }
    message += `Time: ${data.startTime}`;
  } else if (kind === 'success') {
    message = `API 테스트 실행 성공\n`;
    message += `Job: ${data.jobName}\n`;
    message += `Duration: ${data.duration}초\n`;
    
    // Newman 통계 추가
    if (data.newmanStats) {
      const stats = data.newmanStats;
      message += `\n실행 결과:\n`;
      message += `• 요청: ${stats.requests.executed}건 (실패: ${stats.requests.failed}건)\n`;
      message += `• 테스트: ${stats.assertions.executed}건 (실패: ${stats.assertions.failed}건)\n`;
    }
    
    message += `\n종료시간: ${data.endTime}\n`;
    message += `대시보드: ${baseUrl}`;
  } else if (kind === 'error') {
    message = `API 테스트 실행 실패\n`;
    message += `잡: ${data.jobName}\n`;
    message += `실행시간: ${data.duration}초\n`;
    
    // Newman 통계 추가 (실패 케이스)
    if (data.newmanStats) {
      const stats = data.newmanStats;
      message += `\n 실행 결과:\n`;
      message += `• 요청: ${stats.requests.executed}건 (실패: ${stats.requests.failed}건)\n`;
      message += `• 테스트: ${stats.assertions.executed}건 (실패: ${stats.assertions.failed}건)\n`;
    }
    
    message += `\n종료시간: ${data.endTime}\n`;
    message += `대시보드: ${baseUrl}\n`;
    
    if (data.reportPath) {
      message += `상세 리포트: ${baseUrl}/reports/${path.basename(data.reportPath)}\n`;
    }
    
    if (data.errorSummary) {
      message += `\n 오류내용:\n${data.errorSummary}`;
    }
  }
  
  return message;
}
