// src/parsers/binary-parser.js — SClient 바이너리 출력 파싱
export function parseBinaryOutput(output, parseConfig = {}) {
  const result = {
    success: false,
    summary: '',
    stats: null,
    failures: []
  };
  
  try {
    const lines = output.split('\n').map(line => line.trim()).filter(line => line);
    
    // 성공/실패 패턴 확인
    const successPattern = parseConfig.successPattern || 'SUCCESS|PASSED|OK';
    const failurePattern = parseConfig.failurePattern || 'FAIL|ERROR|EXCEPTION';
    
    const successRegex = new RegExp(successPattern, 'i');
    const failureRegex = new RegExp(failurePattern, 'i');
    
    let hasSuccess = false;
    let hasFailure = false;
    
    for (const line of lines) {
      if (successRegex.test(line)) {
        hasSuccess = true;
        if (!result.summary) result.summary = line;
      }
      if (failureRegex.test(line)) {
        hasFailure = true;
        result.failures.push(line);
        if (!result.summary) result.summary = line;
      }
    }
    
    // 통계 추출 (옵션)
    if (parseConfig.statsPattern) {
      const statsRegex = new RegExp(parseConfig.statsPattern, 'i');
      for (const line of lines) {
        const match = line.match(statsRegex);
        if (match) {
          result.stats = {
            total: parseInt(match[1]) || 0,
            success: parseInt(match[2]) || 0,
            failed: parseInt(match[3]) || 0
          };
          break;
        }
      }
    }
    
    // 최종 성공/실패 판정
    if (hasFailure) {
      result.success = false;
      result.summary = result.summary || 'Execution failed';
    } else if (hasSuccess) {
      result.success = true;
      result.summary = result.summary || 'Execution successful';
    } else {
      result.success = true;
      result.summary = 'Execution completed';
    }
    
  } catch (error) {
    console.error('[BINARY PARSE ERROR]', error);
    result.summary = `Parse error: ${error.message}`;
  }
  
  return result;
}
