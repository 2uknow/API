// src/services/alert/builders/failure-yaml.js
// YAML Scenario 단일 실행 실패 시 텍스트 알람 본문 빌더
import { decodeUrlEncodedContent } from '../../../utils/crypto.js';

export function buildYamlScenarioFailureReport(failedSteps) {
  const lines = [];

  lines.push('=== YAML Scenario Failure Report ===');
  lines.push('');

  failedSteps.forEach((step, idx) => {
    lines.push(`[Step ${idx + 1}] ${step.name}`);

    if (step.error) {
      lines.push(`  Error: ${step.error}`);
    }

    if (step.tests && step.tests.length > 0) {
      const failedTests = step.tests.filter(t => !t.passed);
      if (failedTests.length > 0) {
        lines.push('  Failed Assertions:');
        failedTests.forEach(test => {
          lines.push(`    - ${test.name}: ${test.error || 'Failed'}`);
        });
      }
    }

    if (step.response) {
      lines.push('  Response:');

      if (step.response.body) {
        const decodedBody = decodeUrlEncodedContent(step.response.body);
        const truncated = decodedBody.substring(0, 800);
        lines.push(`    Body: ${truncated}${decodedBody.length > 800 ? '...' : ''}`);
      }

      if (step.response.stdout) {
        const decodedStdout = decodeUrlEncodedContent(step.response.stdout);
        const truncated = decodedStdout.substring(0, 800);
        lines.push(`    Output: ${truncated}${decodedStdout.length > 800 ? '...' : ''}`);
      }

      if (step.response.parsed && Object.keys(step.response.parsed).length > 0) {
        lines.push('    Parsed:');
        Object.entries(step.response.parsed).forEach(([key, value]) => {
          const decodedValue = decodeUrlEncodedContent(String(value));
          lines.push(`      ${key}: ${decodedValue}`);
        });
      }

      if (step.response.duration) {
        lines.push(`    Duration: ${step.response.duration}ms`);
      }
    }

    lines.push('');
  });

  return lines.join('\n');
}
