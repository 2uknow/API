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

export { buildRunStatusFlex } from './alert/builders/run-status.js';
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

export { buildDiskAlertFlex } from './alert/builders/disk.js';
export { buildDailyReportText, buildDailyReportFlex } from './alert/builders/daily.js';
