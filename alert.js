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
  return process.env.DASHBOARD_URL || config.base_url || `http://localhost:${port}`;
}

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function getHookUrl() {
  const { webhook_url } = readCfg();
  return process.env.NW_HOOK || webhook_url || '';
}

// 텍스트 메시지 전송
export async function sendTextMessage(text) {
  const url = getHookUrl();
  if (!url) {
    console.log('[ALERT] webhook_url이 설정되지 않았습니다.');
    return { ok: false, status: 0, body: 'No webhook_url configured' };
  }

  const asText = !!process.env.TEXT_ONLY;
  const body = asText ? text : JSON.stringify({ content: { type: 'text', text } });
  const headers = asText
    ? { 'Content-Type': 'text/plain;charset=UTF-8' }
    : { 'Content-Type': 'application/json' };

  try {
    console.log(`[ALERT] 텍스트 메시지 전송 중...`);
    
    const response = await fetch(url, { 
      method: 'POST', 
      body, 
      headers, 
      agent: insecureAgent 
    });
    
    const responseText = await response.text();
    
    if (response.ok) {
      console.log('[ALERT] 텍스트 메시지 전송 성공');
    } else {
      console.error(`[ALERT] 텍스트 메시지 전송 실패: ${response.status}`);
    }
    
    return { ok: response.ok, status: response.status, body: responseText };
  } catch (error) {
    console.error('[ALERT] 텍스트 메시지 전송 중 오류:', error.message);
    return { ok: false, status: 0, body: error.message };
  }
}

// Flex 메시지 전송
export async function sendFlexMessage(flex, customUrl = null) {
  const url = customUrl || getHookUrl();
  if (!url) {
    console.log('[ALERT] webhook_url이 설정되지 않았습니다.');
    return { ok: false, status: 0, body: 'No webhook_url configured' };
  }

  try {
    console.log('[ALERT] Flex 메시지 전송 중...');
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: flex }),
      agent: insecureAgent
    });
    
    const responseText = await response.text();
    
    if (response.ok) {
      console.log('[ALERT] Flex 메시지 전송 성공');
    } else {
      console.error(`[ALERT] Flex 메시지 전송 실패: ${response.status}`);
    }
    
    return { ok: response.ok, status: response.status, body: responseText };
  } catch (error) {
    console.error('[ALERT] Flex 메시지 전송 중 오류:', error.message);
    return { ok: false, status: 0, body: error.message };
  }
}

// 기본 상태 텍스트 생성
export function buildBasicStatusText(kind, data) {
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  
  if (kind === 'start') {
    return `🚀 API 테스트 시작\n작업: ${data.jobName}\n컬렉션: ${data.collection}\n시간: ${timestamp}`;
  } else if (kind === 'success') {
    let message = `✅ API 테스트 성공\n작업: ${data.jobName}\n컬렉션: ${data.collection}\n소요시간: ${data.duration}초\n시간: ${timestamp}`;
    
    if (data.newmanStats) {
      const stats = data.newmanStats;
      message += `\n\n📊 실행 결과:`;
      if (stats.requests && stats.requests.total > 0) {
        message += `\n• 요청: ${stats.requests.total}건 실행, ${stats.requests.total - stats.requests.failed}건 성공`;
      }
      if (stats.assertions && stats.assertions.total > 0) {
        message += `\n• 검증: ${stats.assertions.total}건 실행, ${stats.assertions.total - stats.assertions.failed}건 성공`;
      }
    }
    
    return message;
  } else if (kind === 'error') {
    let message = `❌ API 테스트 실패\n작업: ${data.jobName}\n컬렉션: ${data.collection}\n오류: ${data.errorSummary || '알 수 없는 오류'}\n소요시간: ${data.duration}초\n시간: ${timestamp}`;
    
    if (data.newmanStats) {
      const stats = data.newmanStats;
      message += `\n\n📊 실행 결과:`;
      if (stats.requests && stats.requests.total > 0) {
        message += `\n• 요청: ${stats.requests.total}건 중 ${stats.requests.failed}건 실패`;
      }
      if (stats.assertions && stats.assertions.total > 0) {
        message += `\n• 검증: ${stats.assertions.total}건 중 ${stats.assertions.failed}건 실패`;
      }
    }
    
    if (data.detailedFailures && data.detailedFailures.length > 0) {
      message += `\n\n🔍 주요 실패 원인:`;
      data.detailedFailures.slice(0, 3).forEach((failure, index) => {
        message += `\n${index + 1}. ${failure.testName}`;
        if (failure.error) {
          message += `\n   오류: ${failure.error}`;
        }
      });
    }
    
    return message;
  }
  
  return `📋 API 테스트 상태 업데이트\n작업: ${data.jobName}\n시간: ${timestamp}`;
}

// 고급 Flex 메시지 생성
export function buildRunStatusFlex(kind, data) {
  const baseUrl = getBaseUrl();
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  
  const colors = {
    start: '#1976D2',
    success: '#2E7D32',
    error: '#C62828'
  };
  
  const icons = {
    start: '🚀',
    success: '✅',
    error: '❌'
  };
  
  const titles = {
    start: 'API 테스트 시작',
    success: 'API 테스트 성공',
    error: 'API 테스트 실패'
  };

  // 기본 body 구성
  const bodyContents = [
    {
      type: 'text',
      text: data.jobName,
      weight: 'bold',
      size: 'md',
      color: '#333333'
    },
    {
      type: 'text',
      text: `컬렉션: ${data.collection}`,
      size: 'sm',
      color: '#666666',
      margin: 'sm'
    }
  ];

  // 환경 정보 추가
  if (data.environment) {
    bodyContents.push({
      type: 'text',
      text: `환경: ${data.environment}`,
      size: 'sm',
      color: '#666666'
    });
  }

  // Newman 통계 추가
  if (kind !== 'start' && data.newmanStats) {
    bodyContents.push({
      type: 'separator',
      margin: 'md'
    });
    
    const stats = data.newmanStats;
    
    if (stats.requests && stats.requests.total > 0) {
      const successRequests = stats.requests.total - stats.requests.failed;
      bodyContents.push({
        type: 'box',
        layout: 'baseline',
        contents: [
          {
            type: 'text',
            text: '요청:',
            size: 'sm',
            color: '#666666',
            flex: 2
          },
          {
            type: 'text',
            text: `${successRequests}/${stats.requests.total}건 성공`,
            size: 'sm',
            color: stats.requests.failed === 0 ? '#2E7D32' : '#C62828',
            flex: 3,
            align: 'end'
          }
        ]
      });
    }
    
    if (stats.assertions && stats.assertions.total > 0) {
      const successAssertions = stats.assertions.total - stats.assertions.failed;
      bodyContents.push({
        type: 'box',
        layout: 'baseline',
        contents: [
          {
            type: 'text',
            text: '검증:',
            size: 'sm',
            color: '#666666',
            flex: 2
          },
          {
            type: 'text',
            text: `${successAssertions}/${stats.assertions.total}건 성공`,
            size: 'sm',
            color: stats.assertions.failed === 0 ? '#2E7D32' : '#C62828',
            flex: 3,
            align: 'end'
          }
        ]
      });
    }

    // 성공률 표시
    if (data.detailedStats && data.detailedStats.successRate !== undefined) {
      bodyContents.push({
        type: 'box',
        layout: 'baseline',
        contents: [
          {
            type: 'text',
            text: '성공률:',
            size: 'sm',
            color: '#666666',
            flex: 2
          },
          {
            type: 'text',
            text: `${data.detailedStats.successRate}%`,
            size: 'sm',
            color: data.detailedStats.successRate >= 95 ? '#2E7D32' : 
                   data.detailedStats.successRate >= 80 ? '#F57C00' : '#C62828',
            flex: 3,
            align: 'end',
            weight: 'bold'
          }
        ]
      });
    }

    // 평균 응답시간 표시
    if (data.detailedStats && data.detailedStats.avgResponseTime > 0) {
      bodyContents.push({
        type: 'box',
        layout: 'baseline',
        contents: [
          {
            type: 'text',
            text: '평균응답:',
            size: 'sm',
            color: '#666666',
            flex: 2
          },
          {
            type: 'text',
            text: `${Math.round(data.detailedStats.avgResponseTime)}ms`,
            size: 'sm',
            color: '#333333',
            flex: 3,
            align: 'end'
          }
        ]
      });
    }
  }

  // 오류 정보 추가
  if (kind === 'error') {
    if (data.errorSummary) {
      bodyContents.push({
        type: 'separator',
        margin: 'sm'
      });
      
      bodyContents.push({
        type: 'text',
        text: `오류: ${data.errorSummary}`,
        size: 'sm',
        color: '#C62828',
        wrap: true
      });
    }

    // 상세 실패 정보
    if (data.detailedFailures && data.detailedFailures.length > 0) {
      bodyContents.push({
        type: 'text',
        text: '주요 실패:',
        size: 'sm',
        color: '#666666',
        margin: 'sm'
      });

      data.detailedFailures.slice(0, 2).forEach(failure => {
        bodyContents.push({
          type: 'text',
          text: `• ${failure.testName}`,
          size: 'xs',
          color: '#C62828',
          wrap: true
        });
      });
    }
  }

  // 시간 정보
  const timeText = kind === 'start' ? timestamp : `${timestamp} (${data.duration}초)`;
  bodyContents.push({
    type: 'separator',
    margin: 'md'
  });
  
  bodyContents.push({
    type: 'text',
    text: `🕐 ${timeText}`,
    size: 'xs',
    color: '#888888',
    align: 'end'
  });

  // footer 버튼 구성
  const footerContents = [];

  if (kind !== 'start') {
    if (kind === 'success') {
      // 성공시: 대시보드 버튼만
      footerContents.push({
        type: 'button',
        style: 'primary',
        height: 'sm',
        action: {
          type: 'uri',
          label: '📊 대시보드 확인',
          uri: baseUrl
        },
        color: '#2E7D32'
      });
    } else if (kind === 'error') {
      // 실패시: 대시보드 + 리포트 버튼
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
              label: '🖥️ 대시보드',
              uri: baseUrl
            },
            color: '#1976D2'
          }
        ]
      };

      // 리포트가 있으면 리포트 버튼 추가
      if (data.reportPath) {
        const reportUrl = `${baseUrl}/reports/${path.basename(data.reportPath)}`;
        buttonBox.contents.push({
          type: 'button',
          style: 'secondary',
          height: 'sm',
          flex: 1,
          action: {
            type: 'uri',
            label: '📋 상세리포트',
            uri: reportUrl
          },
          color: '#FF5722'
        });
      }

      footerContents.push(buttonBox);
    }
  }

  const flexMessage = {
    type: 'flex',
    altText: `${titles[kind]}: ${data.jobName}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: icons[kind],
                size: 'lg',
                flex: 0
              },
              {
                type: 'text',
                text: titles[kind],
                weight: 'bold',
                size: 'lg',
                color: '#FFFFFF',
                flex: 1,
                margin: 'md'
              }
            ]
          }
        ],
        backgroundColor: colors[kind],
        paddingAll: 'lg'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: bodyContents,
        paddingAll: 'lg'
      }
    }
  };

  // footer가 있을 때만 추가
  if (footerContents.length > 0) {
    flexMessage.contents.footer = {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: footerContents,
      paddingAll: 'lg'
    };
  }

  return flexMessage;
}

// 기본 Flex 메시지 (호환성)
export function buildBasicRunStatusFlex(kind, data) {
  return buildRunStatusFlex(kind, data);
}

// 연결 테스트
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
      timeout: 10000
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
}