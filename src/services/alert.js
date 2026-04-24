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
export { buildDiskAlertFlex } from './alert/builders/disk.js';
export { buildDailyReportText, buildDailyReportFlex } from './alert/builders/daily.js';
