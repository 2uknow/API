// src/services/alert/builders/daily.js — 일일 통계 리포트 빌더 (텍스트 + Flex)
import { readCfg } from '../../../utils/config.js';

function getBaseUrl() {
  const config = readCfg();
  const port = config.site_port || 3000;
  return config.base_url || `http://localhost:${port}`;
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
