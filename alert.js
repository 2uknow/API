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

/** 실행 상태 알림을 위한 Flex 메시지 생성 */
export function buildRunStatusFlex(kind, data) {
  const headerText = kind === 'start' ? '🚀 실행 시작'
                    : kind === 'success' ? '✅ 실행 성공'
                    : '❌ 실행 실패';

  const headerColor = kind === 'error' ? '#C62828'
                    : kind === 'success' ? '#2E7D32'
                    : '#1976D2';

  const timeText = kind === 'start' ? `시작: ${data.startTime}`
                  : `종료: ${data.endTime} (${data.duration}초)`;

  // 기본 컨텐츠 구성
  const bodyContents = [
    {
      type: 'text',
      text: `📋 잡: ${data.jobName}`,
      wrap: true,
      size: 'sm',
      color: '#333333',
      weight: 'bold'
    },
    {
      type: 'text',
      text: `📁 컬렉션: ${data.collection}`,
      wrap: true,
      size: 'xs',
      color: '#666666'
    }
  ];

  // 환경 정보 추가 (있는 경우)
  if (data.environment) {
    bodyContents.push({
      type: 'text',
      text: `🌍 환경: ${data.environment}`,
      wrap: true,
      size: 'xs',
      color: '#666666'
    });
  }

  // 실패한 경우 종료 코드와 에러 정보 추가
  if (kind === 'error') {
    bodyContents.push({
      type: 'separator',
      margin: 'md'
    });
    
    bodyContents.push({
      type: 'text',
      text: `💥 종료 코드: ${data.exitCode}`,
      wrap: true,
      size: 'sm',
      color: '#C62828',
      weight: 'bold'
    });

    if (data.errorSummary) {
      bodyContents.push({
        type: 'text',
        text: `📝 오류 내용:\n${data.errorSummary}`,
        wrap: true,
        size: 'xs',
        color: '#666666'
      });
    }
  }

  // 성공한 경우 리포트 링크 추가 (옵션)
  if (kind === 'success' && data.reportPath) {
    bodyContents.push({
      type: 'separator',
      margin: 'md'
    });
    
    bodyContents.push({
      type: 'text',
      text: '📊 상세 리포트가 생성되었습니다.',
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
    text: `⏰ ${timeText}`,
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

  return flexMessage;
}

/** 간단한 상태 알림을 위한 텍스트 생성 */
export function buildStatusText(kind, data) {
  let message = '';
  
  if (kind === 'start') {
    message = `🚀 API 테스트 실행 시작\n`;
    message += `잡: ${data.jobName}\n`;
    message += `컬렉션: ${data.collection}\n`;
    if (data.environment) {
      message += `환경: ${data.environment}\n`;
    }
    message += `시간: ${data.startTime}`;
  } else if (kind === 'success') {
    message = `✅ API 테스트 실행 성공\n`;
    message += `잡: ${data.jobName}\n`;
    message += `실행시간: ${data.duration}초\n`;
    message += `종료시간: ${data.endTime}`;
  } else if (kind === 'error') {
    message = `❌ API 테스트 실행 실패\n`;
    message += `잡: ${data.jobName}\n`;
    message += `종료코드: ${data.exitCode}\n`;
    message += `실행시간: ${data.duration}초\n`;
    message += `종료시간: ${data.endTime}`;
    if (data.errorSummary) {
      message += `\n오류: ${data.errorSummary}`;
    }
  }
  
  return message;
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
}