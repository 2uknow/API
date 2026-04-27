// src/services/alert-integration.js — 알람 전송 래퍼 (실패 리포트 빌더는 alert/builders/ 하위로 분리됨)
import { readCfg } from '../utils/config.js';
import {
  sendTextMessage,
  sendFlexMessage,
  buildRunStatusFlex,
} from './alert.js';
export { buildNewmanFailureReport } from './alert/builders/failure-newman.js';
export { buildBinaryFailureReport } from './alert/builders/failure-binary.js';
export { buildYamlScenarioFailureReport } from './alert/builders/failure-yaml.js';
export { buildBatchFailureReport } from './alert/builders/failure-batch.js';

export async function sendAlert(type, data) {
  const config = readCfg();
  
  // 알람이 비활성화되어 있으면 리턴
  if (!config.run_event_alert) {
    console.log(`[ALERT] Alert disabled: ${type}`);
    return;
  }

  // 각 타입별 알람 설정 확인
  if (type === 'start' && !config.alert_on_start) return;
  if (type === 'success' && !config.alert_on_success) return;
  if (type === 'error' && !config.alert_on_error) return;

  try {
    let result;
    
    if (config.alert_method === 'flex') {
      const flexData = buildRunStatusFlex(type, data);
      result = await sendFlexMessage(flexData);
    } else {
      let message;
      if (type === 'start') {
        message = `API Test Execution Started\nJob: ${data.jobName}\nCollection: ${data.collection}`;
        if (data.environment) {
          message += `\nEnvironment: ${data.environment}`;
        }
        message += `\nTime: ${data.startTime}`;
      } else if (type === 'success') {
        message = `API Test Execution Success\nJob: ${data.jobName}\nCollection: ${data.collection}`;
        if (data.environment) {
          message += `\nEnvironment: ${data.environment}`;
        }
        message += `\nDuration: ${data.duration}s\nEnd Time: ${data.endTime}`;
      } else if (type === 'error') {
        message = `[API Test FAILED]\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `Job: ${data.jobName}\n`;

        if (data.collection) {
          message += `Collection: ${data.collection}\n`;
        }
        if (data.environment) {
          message += `Environment: ${data.environment}\n`;
        }
        if (data.scenarioName) {
          message += `Scenario: ${data.scenarioName}\n`;
        }

        message += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        message += `Exit Code: ${data.exitCode}\n`;
        message += `Duration: ${data.duration}s\n`;
        message += `End Time: ${data.endTime}\n`;

        if (data.detailedStats) {
          message += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
          message += `[Statistics]\n`;
          message += `Total: ${data.detailedStats.totalSteps || 0}\n`;
          message += `Passed: ${data.detailedStats.passedSteps || 0}\n`;
          message += `Failed: ${data.detailedStats.failedSteps || 0}\n`;
          message += `Success Rate: ${data.detailedStats.successRate || 0}%\n`;
        }

        if (data.errorSummary) {
          message += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
          message += `[Error Summary]\n`;
          message += `${data.errorSummary}\n`;
        }

        if (data.failureReport) {
          message += `\n${data.failureReport}`;
        }

        if (data.stdout && !data.failureReport) {
          message += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
          message += `[Response (Decoded)]\n`;
          const truncatedStdout = data.stdout.substring(0, 1500);
          message += truncatedStdout;
          if (data.stdout.length > 1500) {
            message += '\n... (truncated)';
          }
        }
      }
      result = await sendTextMessage(message);
    }

    console.log(`[ALERT] ${type} alert result:`, result);
    
    if (!result.ok) {
      console.error(`[ALERT ERROR] ${type} alert failed:`, result);
    }

  } catch (error) {
    console.error(`[ALERT ERROR] ${type} alert error:`, error);
  }
}

