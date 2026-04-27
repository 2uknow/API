// src/services/alert/builders/failure-binary.js
// Binary Job 실행 실패 시 텍스트 알람 본문 빌더
import { decodeUrlEncodedContent } from '../../../utils/crypto.js';

export function buildBinaryFailureReport(stdout, stderr, parsedResult) {
  const lines = [];

  lines.push('=== Binary Execution Failure Report ===');
  lines.push('');

  if (parsedResult.failures && parsedResult.failures.length > 0) {
    lines.push('[Assertion Failures]');
    parsedResult.failures.forEach((failure, idx) => {
      lines.push(`  ${idx + 1}. ${failure}`);
    });
    lines.push('');
  }

  if (stdout) {
    const decodedStdout = decodeUrlEncodedContent(stdout);

    const responsePatterns = [
      /Response Body[:\s]*(.+?)(?=\n\[|$)/is,
      /HTTP Response[:\s]*(.+?)(?=\n\[|$)/is,
      /BODY[:\s]*(.+?)(?=\n\[|$)/is,
      /Result=.*/gm
    ];

    let responseBody = null;
    for (const pattern of responsePatterns) {
      const match = decodedStdout.match(pattern);
      if (match) {
        responseBody = match[0];
        break;
      }
    }

    lines.push('[Response (Decoded)]');
    if (responseBody) {
      lines.push(responseBody.substring(0, 1000));
    } else {
      const truncated = decodedStdout.substring(0, 1500);
      lines.push(truncated);
      if (decodedStdout.length > 1500) {
        lines.push('... (truncated)');
      }
    }
    lines.push('');
  }

  if (stderr && stderr.trim()) {
    lines.push('[Error Output]');
    lines.push(stderr.substring(0, 500));
    lines.push('');
  }

  lines.push(`[Summary] ${parsedResult.summary || 'Execution failed'}`);

  return lines.join('\n');
}
