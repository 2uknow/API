// alert.js (확장성 있는 URL 관리 버전)
import https from 'https';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

// IP 주소 자동 감지 함수
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // IPv4이고 내부 주소가 아닌 것 찾기
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost'; // 기본값
}

// 확장성 있는 베이스 URL 관리
function getBaseUrl() {
  const config = readCfg();
  
  // 1순위: 환경변수 BASE_URL (배포 시 유용)
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, ''); // 끝의 / 제거
  }
  
  // 2순위: 설정 파일의 base_url (수동 설정)
  if (config.base_url) {
    return config.base_url.replace(/\/$/, '');
  }
  
  // 3순위: 도메인 설정이 있는 경우
  if (config.domain) {
    const protocol = config.use_https ? 'https' : 'http';
    const port = config.use_https && config.site_port === 443 ? '' 
               : !config.use_https && config.site_port === 80 ? ''
               : `:${config.site_port || 3000}`;
    return `${protocol}://${config.domain}${port}`;
  }
  
  // 4순위: IP 자동 감지 (개발 환경)
  const ip = getLocalIP();
  const port = config.site_port || 3000;
  return `http://${ip}:${port}`;
}

// URL 빌더 헬퍼 함수들
export function buildDashboardUrl() {
  return getBaseUrl();
}

export function buildReportUrl(reportPath) {
  if (!reportPath) return null;
  const baseUrl = getBaseUrl();
  const fileName = path.basename(reportPath);
  return `${baseUrl}/reports/${fileName}`;
}

export function buildLogsUrl() {
  const baseUrl = getBaseUrl();
  return `${baseUrl}/logs`;
}

export function buildHistoryUrl() {
  const baseUrl = getBaseUrl();
  return `${baseUrl}/#history`;
}

// URL 검증 함수
function validateUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export async function sendTextMessage(text) {
  const url = getHookUrl();
  if (!url) {
    console.log('[ALERT] webhook_url이 설정되지 않았습니다.');
    return { ok:false, status:0, body:'No webhook_url configured' };
  }

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

/** 실행 상태 알림을 위한 Flex 메시지 생성 (확장성 있는 Footer 링크 포함) */
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

    // 실패 시에도 리포트 생성됨을 알림
    if (data.reportPath) {
      bodyContents.push({
        type: 'text',
        text: '📊 실패 상세 리포트가 생성되었습니다.',
        wrap: true,
        size: 'xs',
        color: '#C62828'
      });
    }
  }

  // 성공한 경우 리포트 링크 추가
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

  // Flex 메시지 기본 구조
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

  // Footer 추가 (리포트가 있는 경우 성공/실패 구분없이)
  if (data.reportPath) {
    let footerContents = [];
    const reportUrl = buildReportUrl(data.reportPath);

    if (reportUrl && validateUrl(reportUrl)) {
      if (kind === 'error') {
        // 실패 시: 실패 리포트 링크 (Primary)
        footerContents.push({
          type: "button",
          style: "primary",
          color: "#C62828",
          height: "sm",
          action: {
            type: "uri",
            label: "실패보고서 보기",
            uri: reportUrl
          }
        });
      } else if (kind === 'success') {
        // 성공 시: 성공 리포트 링크 (Primary)
        footerContents.push({
          type: "button",
          style: "primary", 
          color: "#2E7D32",
          height: "sm",
          action: {
            type: "uri",
            label: "상세보고서 보기",
            uri: reportUrl
          }
        });
      }
    }

    // 공통: 대시보드 링크 (Secondary 버튼)
    if (footerContents.length > 0) {
      const dashboardUrl = buildDashboardUrl();
      if (validateUrl(dashboardUrl)) {
        footerContents.push({
          type: "button",
          style: "secondary",
          height: "sm",
          action: {
            type: "uri",
            label: "대시보드",
            uri: dashboardUrl
          }
        });
      }
    }

    // Footer가 있는 경우에만 추가
    if (footerContents.length > 0) {
      flexMessage.content.contents.footer = {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: footerContents,
        paddingAll: "15px"
      };
    }
  }

  return flexMessage;
}

/** 간단한 상태 알림을 위한 텍스트 생성 (확장성 있는 링크 포함) */
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
    
    // 성공 시에도 링크 추가
    if (data.reportPath) {
      const reportUrl = buildReportUrl(data.reportPath);
      if (reportUrl && validateUrl(reportUrl)) {
        message += `\n\n📊 상세보고서: ${reportUrl}`;
      }
    }
    
    const dashboardUrl = buildDashboardUrl();
    if (validateUrl(dashboardUrl)) {
      message += `\n🖥️ 대시보드: ${dashboardUrl}`;
    }
  } else if (kind === 'error') {
    message = `❌ API 테스트 실행 실패\n`;
    message += `잡: ${data.jobName}\n`;
    message += `종료코드: ${data.exitCode}\n`;
    message += `실행시간: ${data.duration}초\n`;
    message += `종료시간: ${data.endTime}`;
    if (data.errorSummary) {
      message += `\n오류: ${data.errorSummary}`;
    }
    
    // 실패 시에도 리포트 링크 추가 (있는 경우)
    if (data.reportPath) {
      const reportUrl = buildReportUrl(data.reportPath);
      if (reportUrl && validateUrl(reportUrl)) {
        message += `\n\n📊 실패보고서: ${reportUrl}`;
      }
    }
    
    // 대시보드 링크 추가
    const dashboardUrl = buildDashboardUrl();
    if (validateUrl(dashboardUrl)) {
      message += `\n🖥️ 대시보드: ${dashboardUrl}`;
    }
  }
  
  return message;
}

// 디버깅 및 설정 확인을 위한 함수들
export function getUrlInfo() {
  const config = readCfg();
  const baseUrl = getBaseUrl();
  
  return {
    baseUrl,
    source: process.env.BASE_URL ? 'environment' 
          : config.base_url ? 'config_base_url'
          : config.domain ? 'config_domain'
          : 'auto_detected',
    config: {
      domain: config.domain || null,
      use_https: config.use_https || false,
      site_port: config.site_port || 3000,
      base_url: config.base_url || null
    },
    environment: {
      BASE_URL: process.env.BASE_URL || null
    },
    auto_detected_ip: getLocalIP()
  };
}

// 연결 테스트 함수
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
        text: '🔧 Danal External API 모니터링 시스템 연결 테스트\n테스트 시간: ' + new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
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

// 설정 예시를 위한 함수
export function getConfigExamples() {
  return {
    development: {
      description: "개발 환경 (IP 자동 감지)",
      config: {
        site_port: 3000
      }
    },
    production_ip: {
      description: "운영 환경 (IP 기반)",
      config: {
        base_url: "http://192.168.1.100:3000"
      }
    },
    production_domain_http: {
      description: "운영 환경 (도메인, HTTP)",
      config: {
        domain: "danal-api-monitor.company.com",
        site_port: 80,
        use_https: false
      }
    },
    production_domain_https: {
      description: "운영 환경 (도메인, HTTPS)",
      config: {
        domain: "danal-api-monitor.company.com", 
        site_port: 443,
        use_https: true
      }
    },
    production_domain_custom_port: {
      description: "운영 환경 (도메인, 커스텀 포트)",
      config: {
        domain: "danal-api-monitor.company.com",
        site_port: 8080,
        use_https: true
      }
    },
    docker_compose: {
      description: "Docker Compose 환경",
      environment: {
        BASE_URL: "https://danal-api-monitor.company.com"
      }
    }
  };
}