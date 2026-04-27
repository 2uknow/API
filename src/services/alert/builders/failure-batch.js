// src/services/alert/builders/failure-batch.js
// YAML 디렉토리 배치 실행 실패 시 텍스트 알람 본문 빌더
import { decodeUrlEncodedContent } from '../../../utils/crypto.js';

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
