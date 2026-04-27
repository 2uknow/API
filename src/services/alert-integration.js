// src/services/alert-integration.js — 알람 전송 래퍼 + 실패 리포트 빌더
import { readCfg } from '../utils/config.js';
import { decodeUrlEncodedContent } from '../utils/crypto.js';
import {
  sendTextMessage,
  sendFlexMessage,
  buildRunStatusFlex,
} from './alert.js';
export { buildNewmanFailureReport } from './alert/builders/failure-newman.js';
export { buildBinaryFailureReport } from './alert/builders/failure-binary.js';
export { buildYamlScenarioFailureReport } from './alert/builders/failure-yaml.js';

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

// Batch 실행 실패 리포트 생성 함수
export function buildBatchFailureReport(failedResults) {
  const lines = [];

  lines.push(`[Failure Report] ${failedResults.length} file(s) failed`);

  failedResults.slice(0, 8).forEach((failedResult, idx) => {
    const result = failedResult.result;
    let fileLine = `${idx + 1}. ${failedResult.fileName}`;

    if (result?.error) {
      fileLine += ` - Error: ${result.error}`;
    }

    if (result?.scenarioResult) {
      const summary = result.scenarioResult.summary;
      if (summary) {
        fileLine += ` (${summary.passed}/${summary.total} steps)`;
      }

      const failedSteps = (result.scenarioResult.steps || []).filter(s => !s.passed);
      if (failedSteps.length > 0) {
        lines.push(fileLine);

        failedSteps.slice(0, 5).forEach((step, stepIdx) => {
          let stepLine = `  ${stepIdx + 1}) ${step.name}`;

          if (step.tests) {
            const failedTests = step.tests.filter(t => !t.passed);
            if (failedTests.length > 0) {
              const testInfo = failedTests.slice(0, 3).map(t =>
                `${t.name}: ${t.error || 'Failed'}`
              ).join('; ');
              stepLine += ` | ${testInfo}`;
              if (failedTests.length > 3) {
                stepLine += ` (+${failedTests.length - 3} more)`;
              }
            }
          }

          if (step.response) {
            if (step.response.parsed && Object.keys(step.response.parsed).length > 0) {
              const parsedInfo = Object.entries(step.response.parsed).slice(0, 8).map(([key, value]) => {
                const decodedValue = decodeUrlEncodedContent(String(value));
                return `${key}=${decodedValue.substring(0, 100)}`;
              }).join(', ');
              stepLine += ` | Response: ${parsedInfo}`;
            } else if (step.response.body) {
              const decodedBody = decodeUrlEncodedContent(step.response.body);
              stepLine += ` | Response: ${decodedBody.substring(0, 1000)}`;
            } else if (step.response.stdout) {
              const decodedStdout = decodeUrlEncodedContent(step.response.stdout);
              stepLine += ` | Output: ${decodedStdout.substring(0, 1000)}`;
            }
          }

          lines.push(stepLine.substring(0, 2000));
        });

        if (failedSteps.length > 5) {
          lines.push(`  ... +${failedSteps.length - 5} more steps`);
        }
      } else {
        lines.push(fileLine);
      }
    } else {
      lines.push(fileLine);
    }
  });

  if (failedResults.length > 8) {
    lines.push(`... +${failedResults.length - 8} more files`);
  }

  return lines.join('\n');
}
