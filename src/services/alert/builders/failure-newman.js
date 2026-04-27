// src/services/alert/builders/failure-newman.js
// Newman 실행 실패 시 텍스트 알람 본문 빌더

export function buildNewmanFailureReport(newmanParsed, detailedFailures) {
  const lines = [];

  lines.push('=== Newman Test Failure Report ===');
  lines.push('');

  if (newmanParsed?.summary) {
    lines.push('[Statistics]');
    lines.push(`  Requests: ${newmanParsed.summary.requests.failed}/${newmanParsed.summary.requests.total} failed`);
    lines.push(`  Assertions: ${newmanParsed.summary.assertions.failed}/${newmanParsed.summary.assertions.total} failed`);
    lines.push(`  Success Rate: ${newmanParsed.successRate}%`);
    lines.push('');
  }

  if (newmanParsed?.failedExecutions?.length > 0) {
    lines.push('[Failed Requests with Response]');

    newmanParsed.failedExecutions.slice(0, 5).forEach((exec, idx) => {
      lines.push(`━━━ ${idx + 1}. ${exec.name} ━━━`);
      lines.push(`  URL: ${exec.request.method} ${exec.request.url}`);
      lines.push(`  Status: ${exec.response.status} ${exec.response.statusText}`);
      lines.push(`  Response Time: ${exec.response.responseTime}ms`);

      const failedAssertions = exec.assertions.filter(a => !a.passed);
      if (failedAssertions.length > 0) {
        lines.push('  Failed Assertions:');
        failedAssertions.forEach(a => {
          lines.push(`    - ${a.name}: ${a.error || 'Failed'}`);
        });
      }

      if (exec.response.body) {
        lines.push('  Response Body:');
        const truncated = exec.response.body.substring(0, 800);
        lines.push(`    ${truncated}${exec.response.body.length > 800 ? '...' : ''}`);
      }

      lines.push('');
    });

    if (newmanParsed.failedExecutions.length > 5) {
      lines.push(`... and ${newmanParsed.failedExecutions.length - 5} more failed requests`);
    }
  }

  if (detailedFailures?.length > 0 && (!newmanParsed?.failedExecutions?.length)) {
    lines.push('[Assertion Failures]');
    detailedFailures.slice(0, 5).forEach((failure, idx) => {
      lines.push(`  ${idx + 1}. ${failure.testName}`);
      lines.push(`     Request: ${failure.requestName}`);
      if (failure.errorDetails) {
        lines.push(`     Error: ${failure.errorDetails}`);
      }
      if (failure.expectedValue && failure.actualValue) {
        lines.push(`     Expected: ${failure.expectedValue}`);
        lines.push(`     Actual: ${failure.actualValue}`);
      }
      lines.push('');
    });
  }

  return lines.join('\n');
}
