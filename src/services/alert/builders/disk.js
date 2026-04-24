// src/services/alert/builders/disk.js — 디스크 사용량 알람 Flex 빌더
import { readCfg } from '../../../utils/config.js';

function getBaseUrl() {
  const config = readCfg();
  const port = config.site_port || 3000;
  return config.base_url || `http://localhost:${port}`;
}

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
