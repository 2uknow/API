// SClient 시나리오 실행 엔진
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import { SClientToNewmanConverter } from './newman-converter.js';

/**
 * SClient 시나리오 실행 엔진
 * Postman Collection과 유사한 방식으로 다단계 SClient 명령을 실행
 */
export class SClientScenarioEngine {
  constructor(options = {}) {
    this.binaryPath = options.binaryPath || './binaries/windows/SClient.exe';
    this.timeout = options.timeout || 30000;
    this.encoding = options.encoding || 'cp949';
    this.variables = new Map();
    this.results = [];
    this.logs = [];
    this.eventHandlers = {};
    this.newmanConverter = new SClientToNewmanConverter();
  }

  // 이벤트 핸들러 등록
  on(event, handler) {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
    this.eventHandlers[event].push(handler);
  }

  // 이벤트 발생
  emit(event, data) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event].forEach(handler => handler(data));
    }
  }

  // 변수 치환 처리 (JavaScript 표현식 지원)
  replaceVariables(text) {
    if (typeof text !== 'string') return text;
    
    return text.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
      // JavaScript 표현식 처리
      if (varName.startsWith('js:')) {
        try {
          const jsCode = varName.substring(3).trim();
          // 안전한 컨텍스트 제공
          const context = {
            Date, Math, parseInt, parseFloat, String, Number, Array, Object,
            timestamp: Date.now(),
            randomInt: Math.floor(Math.random() * 10000),
            date: new Date().toISOString().substring(0, 10).replace(/-/g, ''),
            time: new Date().toTimeString().substring(0, 8).replace(/:/g, ''),
            env: process.env,
            variables: Object.fromEntries(this.variables)
          };
          
          // Function constructor를 사용하여 안전한 실행
          const func = new Function(...Object.keys(context), `return (${jsCode})`);
          const result = func(...Object.values(context));
          return result !== undefined ? result.toString() : match;
        } catch (error) {
          this.log(`[JS ERROR] Failed to evaluate: ${varName} - ${error.message}`);
          return match;
        }
      }
      
      // 동적 변수 처리
      if (varName === '$timestamp') {
        return Date.now().toString();
      }
      if (varName === '$randomInt') {
        return Math.floor(Math.random() * 10000).toString();
      }
      if (varName === '$randomId') {
        return Date.now().toString() + Math.floor(Math.random() * 1000).toString();
      }
      if (varName === '$dateTime') {
        return new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
      }
      if (varName === '$date') {
        return new Date().toISOString().substring(0, 10).replace(/-/g, '');
      }
      if (varName === '$time') {
        return new Date().toTimeString().substring(0, 8).replace(/:/g, '');
      }
      if (varName === '$uuid') {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      }
      
      // 일반 변수 처리
      return this.variables.get(varName) || match;
    });
  }

  // SClient 명령 실행
  async executeCommand(command, args, requestName = 'Unnamed') {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      // 명령어 인수 생성 - SClient는 세미콜론으로 구분된 하나의 문자열을 받음
      const cmdPairs = [];
      
      // YAML args를 순서대로 그대로 처리 (특별한 변환 없이)
      Object.entries(args).forEach(([key, value]) => {
        const processedValue = this.replaceVariables(value);
        cmdPairs.push(`${key}=${processedValue}`);
      });
      
      // 세미콜론으로 구분된 하나의 문자열로 조합
      const cmdString = cmdPairs.join(';');
      const cmdArgs = [cmdString];

      this.emit('step-start', {
        name: requestName,
        command,
        arguments: cmdPairs,
        cmdString,
        timestamp: new Date().toISOString()
      });

      this.log(`[STEP START] ${requestName} - Command: ${command}`);
      this.log(`[COMMAND STRING] ${cmdString}`);

      const proc = spawn(this.binaryPath, cmdArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';

      // 타임아웃 설정
      const timeoutId = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Command timeout after ${this.timeout}ms`));
      }, this.timeout);

      proc.stdout.on('data', (data) => {
        try {
          const text = process.platform === 'win32' 
            ? iconv.decode(data, this.encoding)
            : data.toString('utf8');
          stdout += text;
          this.emit('stdout', { text, step: requestName });
        } catch (err) {
          stdout += data.toString();
        }
      });

      proc.stderr.on('data', (data) => {
        try {
          const text = process.platform === 'win32'
            ? iconv.decode(data, this.encoding) 
            : data.toString('utf8');
          stderr += text;
          this.emit('stderr', { text, step: requestName });
        } catch (err) {
          stderr += data.toString();
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        const endTime = Date.now();
        const duration = endTime - startTime;

        const result = {
          name: requestName,
          command,
          arguments: cmdPairs,
          cmdString,
          exitCode: code,
          stdout,
          stderr,
          duration,
          timestamp: new Date().toISOString(),
          parsed: this.parseResponse(stdout)
        };

        this.log(`[STEP END] ${requestName} - Exit Code: ${code}, Duration: ${duration}ms`);
        
        this.emit('step-end', result);
        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        this.log(`[STEP ERROR] ${requestName} - ${err.message}`);
        this.emit('step-error', { name: requestName, error: err.message });
        reject(err);
      });
    });
  }

  // SClient 응답 파싱
  parseResponse(stdout) {
    const lines = stdout.split(/\r?\n/).filter(line => line.trim());
    const parsed = {};

    lines.forEach(line => {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match) {
        const [, key, value] = match;
        parsed[key.toLowerCase()] = value;
      }
    });

    return parsed;
  }

  // 변수 추출 (extractors 처리)
  extractVariables(response, extractors = []) {
    const extracted = {};
    
    extractors.forEach(extractor => {
      const { name, pattern, variable } = extractor;
      
      try {
        let value = null;
        
        // 간단한 키워드 기반 추출 (예: "Result" → response.parsed.result)
        if (!pattern.includes('\\') && !pattern.includes('(') && !pattern.includes('[')) {
          // 단순 키워드인 경우 parsed 객체에서 직접 가져오기 (대소문자 무관)
          const key = pattern.toLowerCase();
          if (response.parsed && response.parsed[key] !== undefined) {
            value = response.parsed[key];
            this.log(`[EXTRACT SIMPLE] ${name}: Found ${key} = ${value}`);
          } else {
            // 디버깅을 위해 사용 가능한 키들 출력
            const availableKeys = Object.keys(response.parsed || {});
            this.log(`[EXTRACT DEBUG] ${name}: Pattern '${pattern}' (key: '${key}') not found. Available keys: ${availableKeys.join(', ')}`);
          }
        } else {
          // 정규표현식 패턴인 경우 기존 방식 사용
          const regex = new RegExp(pattern);
          const match = response.stdout.match(regex);
          
          if (match && match[1]) {
            value = match[1];
            this.log(`[EXTRACT REGEX] ${name}: Pattern matched = ${value}`);
          }
        }
        
        if (value !== null) {
          this.variables.set(variable, value);
          extracted[variable] = value;
          this.log(`[EXTRACT SUCCESS] ${name}: ${variable} = ${value}`);
        } else {
          this.log(`[EXTRACT FAILED] ${name}: Pattern "${pattern}" not found`);
        }
      } catch (err) {
        this.log(`[EXTRACT ERROR] ${name}: ${err.message}`);
      }
    });

    return extracted;
  }

  // 테스트 실행 (tests 처리)
  runTests(response, tests = [], extracted = {}) {
    const testResults = [];
    
    tests.forEach(test => {
      const { name, script } = test;
      
      try {
        // 간단한 테스트 스크립트 실행 환경 생성
        const pm = {
          test: (testName, testFn) => {
            try {
              testFn();
              testResults.push({ name: testName, passed: true });
              this.log(`[TEST PASS] ${testName}`);
            } catch (err) {
              testResults.push({ name: testName, passed: false, error: err.message });
              this.log(`[TEST FAIL] ${testName}: ${err.message}`);
              this.log(`[DEBUG] PM Response: ${JSON.stringify(pm.response, null, 2)}`);
              this.log(`[DEBUG] Extracted variables: ${JSON.stringify(extracted, null, 2)}`);
            }
          },
          expect: (actual) => ({
            to: {
              equal: (expected) => {
                if (actual !== expected) {
                  throw new Error(`Expected "${expected}" but got "${actual}"`);
                }
              },
              exist: () => {
                if (actual === undefined || actual === null) {
                  throw new Error(`Expected value to exist but got "${actual}"`);
                }
              },
              not: {
                equal: (expected) => {
                  if (String(actual) === String(expected)) {
                    throw new Error(`Expected "${actual}" to not equal "${expected}"`);
                  }
                },
                be: {
                  empty: () => {
                    if (!actual || actual.length === 0) {
                      throw new Error(`Expected value to not be empty but got "${actual}"`);
                    }
                  }
                },
                contain: (substring) => {
                  if (actual && actual.includes(substring)) {
                    throw new Error(`Expected "${actual}" to not contain "${substring}"`);
                  }
                }
              }
            }
          }),
          // JavaScript 조건부 테스트 지원
          satisfyCondition: (condition) => {
            try {
              // 응답 데이터를 컨텍스트로 제공
              const context = {
                result: response.parsed.result,
                serverinfo: response.parsed.serverinfo,
                errmsg: response.parsed.errmsg,
                response: response.parsed,
                actual: actual,
                Date, Math, parseInt, parseFloat, String, Number
              };
              
              const func = new Function(...Object.keys(context), `return (${condition})`);
              const conditionResult = func(...Object.values(context));
              
              if (!conditionResult) {
                throw new Error(`Condition failed: ${condition} (actual: ${actual})`);
              }
            } catch (error) {
              throw new Error(`Condition error: ${condition} - ${error.message}`);
            }
          },
          variables: {
            get: (key) => this.variables.get(key)
          },
          response: {
            // SClient 응답 필드를 PM 형식으로 매핑
            result: response.parsed.result,
            serverinfo: response.parsed.serverinfo,
            errmsg: response.parsed.errmsg,
            // 전체 파싱된 응답도 접근 가능하게
            ...response.parsed,
            // 추출된 변수들도 포함
            ...extracted
          }
        };

        // 스크립트 실행
        eval(script);
      } catch (err) {
        testResults.push({ name, passed: false, error: err.message });
        this.log(`[TEST ERROR] ${name}: ${err.message}`);
      }
    });

    return testResults;
  }

  // 시나리오 실행
  async runScenario(scenarioPath) {
    this.log(`[SCENARIO START] Loading: ${scenarioPath}`);
    
    const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8'));
    const { info, variables = [], requests = [], events = {} } = scenario;

    this.emit('scenario-start', { info, timestamp: new Date().toISOString() });

    // 초기 변수 설정
    variables.forEach(variable => {
      const value = this.replaceVariables(variable.value);
      this.variables.set(variable.key, value);
      this.log(`[VARIABLE] ${variable.key} = ${value}`);
    });

    // Pre-request 스크립트 실행 (있는 경우)
    if (events.prerequest) {
      this.log(`[PRE-REQUEST] Executing pre-request scripts`);
      // 간단한 prerequest 처리 (필요시 확장)
    }

    const scenarioResult = {
      info,
      startTime: new Date().toISOString(),
      steps: [],
      summary: {
        total: requests.length,
        passed: 0,
        failed: 0,
        duration: 0
      }
    };

    // 요청 순차 실행
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];
      const stepNumber = i + 1;
      
      try {
        this.log(`[STEP ${stepNumber}/${requests.length}] ${request.name}`);
        
        // 명령 실행
        const response = await this.executeCommand(
          request.command,
          request.arguments,
          `${stepNumber}. ${request.name}`
        );

        // 변수 추출
        const extracted = this.extractVariables(response, request.extractors);

        // 테스트 실행 (추출된 변수들도 전달)
        const testResults = this.runTests(response, request.tests, extracted);

        const stepResult = {
          step: stepNumber,
          name: request.name,
          command: request.command,
          response,
          extracted,
          tests: testResults,
          passed: testResults.every(t => t.passed)
        };

        this.results.push(stepResult);
        scenarioResult.steps.push(stepResult);

        if (stepResult.passed) {
          scenarioResult.summary.passed++;
        } else {
          scenarioResult.summary.failed++;
        }

        scenarioResult.summary.duration += response.duration;

        this.emit('step-complete', stepResult);

      } catch (err) {
        const errorStep = {
          step: stepNumber,
          name: request.name,
          command: request.command,
          error: err.message,
          passed: false
        };

        this.results.push(errorStep);
        scenarioResult.steps.push(errorStep);
        scenarioResult.summary.failed++;

        this.log(`[STEP ERROR] ${request.name}: ${err.message}`);
        this.emit('step-error', errorStep);

        // 에러 발생 시 시나리오 중단할지 결정 (옵션으로 제어 가능)
        if (scenario.stopOnError !== false) {
          break;
        }
      }
    }

    scenarioResult.endTime = new Date().toISOString();
    scenarioResult.success = scenarioResult.summary.failed === 0;

    this.emit('scenario-end', scenarioResult);
    this.log(`[SCENARIO END] Success: ${scenarioResult.success}, Passed: ${scenarioResult.summary.passed}/${scenarioResult.summary.total}`);

    return scenarioResult;
  }

  // 로그 기록
  log(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} ${message}`;
    this.logs.push(logEntry);
    this.emit('log', { message: logEntry, timestamp });
  }

  // 결과 요약
  getSummary() {
    return {
      totalSteps: this.results.length,
      passedSteps: this.results.filter(r => r.passed).length,
      failedSteps: this.results.filter(r => !r.passed).length,
      variables: Object.fromEntries(this.variables),
      logs: this.logs
    };
  }

  // Newman 리포트 생성
  async generateNewmanReport(scenarioResult, outputPath, reporterName = 'htmlextra') {
    try {
      const result = await this.newmanConverter.generateReport(scenarioResult, outputPath, reporterName);
      this.log(`[NEWMAN REPORT] Generated ${reporterName} report: ${outputPath}`);
      return result;
    } catch (error) {
      this.log(`[NEWMAN REPORT ERROR] Failed to generate ${reporterName} report: ${error.message}`);
      throw error;
    }
  }

  // 여러 Newman 리포트 생성
  async generateMultipleReports(scenarioResult, basePath, reporters = ['htmlextra', 'json', 'junit']) {
    const results = {};
    
    for (const reporter of reporters) {
      try {
        const extension = this.getReporterExtension(reporter);
        const outputPath = `${basePath}.${extension}`;
        
        const result = await this.generateNewmanReport(scenarioResult, outputPath, reporter);
        results[reporter] = result;
      } catch (error) {
        this.log(`[NEWMAN REPORT ERROR] Failed to generate ${reporter} report: ${error.message}`);
        results[reporter] = { success: false, error: error.message };
      }
    }
    
    return results;
  }

  // Reporter 확장자 매핑
  getReporterExtension(reporterName) {
    const extensions = {
      'htmlextra': 'html',
      'html': 'html',
      'json': 'json',
      'junit': 'xml',
      'cli': 'txt'
    };
    return extensions[reporterName] || 'txt';
  }
}

// 시나리오 리포트 생성기
export class SClientReportGenerator {
  static generateTextReport(scenarioResult) {
    const lines = [];
    const { info, steps, summary, startTime, endTime } = scenarioResult;

    lines.push('SClient Scenario Execution Report');
    lines.push('===================================');
    lines.push(`Scenario: ${info.name}`);
    lines.push(`Description: ${info.description || 'No description'}`);
    lines.push(`Start Time: ${startTime}`);
    lines.push(`End Time: ${endTime}`);
    lines.push(`Duration: ${summary.duration}ms`);
    lines.push(`Result: ${scenarioResult.success ? 'PASS' : 'FAIL'}`);
    lines.push('');

    lines.push('Summary:');
    lines.push(`  Total Steps: ${summary.total}`);
    lines.push(`  Passed: ${summary.passed}`);
    lines.push(`  Failed: ${summary.failed}`);
    lines.push(`  Success Rate: ${((summary.passed / summary.total) * 100).toFixed(1)}%`);
    lines.push('');

    lines.push('Step Details:');
    lines.push('============');

    steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.name}`);
      lines.push(`   Command: ${step.command}`);
      lines.push(`   Status: ${step.passed ? 'PASS' : 'FAIL'}`);
      
      if (step.response) {
        lines.push(`   Duration: ${step.response.duration}ms`);
        lines.push(`   Exit Code: ${step.response.exitCode}`);
        
        if (step.response.parsed) {
          Object.entries(step.response.parsed).forEach(([key, value]) => {
            lines.push(`   ${key}: ${value}`);
          });
        }
      }

      if (step.tests && step.tests.length > 0) {
        lines.push('   Tests:');
        step.tests.forEach(test => {
          const status = test.passed ? 'PASS' : 'FAIL';
          lines.push(`     - ${test.name}: ${status}`);
          if (!test.passed && test.error) {
            lines.push(`       Error: ${test.error}`);
          }
        });
      }

      if (step.extracted && Object.keys(step.extracted).length > 0) {
        lines.push('   Extracted Variables:');
        Object.entries(step.extracted).forEach(([key, value]) => {
          lines.push(`     ${key}: ${value}`);
        });
      }

      if (step.error) {
        lines.push(`   Error: ${step.error}`);
      }

      lines.push('');
    });

    return lines.join('\n');
  }

  static generateJSONReport(scenarioResult) {
    return JSON.stringify(scenarioResult, null, 2);
  }

  static generateHTMLReport(scenarioResult) {
    const { info, steps, summary, startTime, endTime } = scenarioResult;
    const successRate = ((summary.passed / summary.total) * 100).toFixed(1);

    return `
<!DOCTYPE html>
<html>
<head>
    <title>SClient Scenario Report - ${info.name}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        /* 기본 스타일 */
        body { 
            font-family: Arial, sans-serif; 
            margin: 20px; 
            background: #ffffff;
            color: #333333;
        }
        
        .header { 
            background: #f5f5f5; 
            padding: 20px; 
            border-radius: 5px; 
            margin-bottom: 20px; 
            border: 1px solid #dddddd;
        }
        .summary { display: flex; gap: 20px; margin-bottom: 20px; flex-wrap: wrap; }
        .stat-box { 
            background: #ffffff; 
            border: 1px solid #dddddd; 
            padding: 15px; 
            border-radius: 5px; 
            text-align: center; 
            min-width: 120px;
        }
        .stat-value { font-size: 24px; font-weight: bold; color: #2c5aa0; }
        .stat-label { color: #666666; margin-top: 5px; }
        .step { border: 1px solid #dddddd; margin-bottom: 15px; border-radius: 5px; background: #ffffff; }
        .step-header { background: #f8f9fa; padding: 15px; border-bottom: 1px solid #dddddd; }
        .step-content { padding: 15px; }
        .pass { border-left: 4px solid #28a745; }
        .fail { border-left: 4px solid #dc3545; }
        .status-pass { color: #28a745; font-weight: bold; }
        .status-fail { color: #dc3545; font-weight: bold; }
        .test-results { margin-top: 10px; }
        .test-item { padding: 5px 0; }
        .extracted-vars { background: #f8f9fa; padding: 10px; margin-top: 10px; border-radius: 3px; }
        .code { background: #f8f9fa; padding: 10px; border-radius: 3px; font-family: monospace; white-space: pre-wrap; }
    </style>
</head>
<body>
    
    <div class="header">
        <h1>SClient Scenario Report</h1>
        <h2>${info.name}</h2>
        <p>${info.description || 'No description provided'}</p>
        <p><strong>Executed:</strong> ${startTime} - ${endTime}</p>
        <p><strong>Overall Result:</strong> <span class="status-${scenarioResult.success ? 'pass' : 'fail'}">${scenarioResult.success ? 'PASS' : 'FAIL'}</span></p>
    </div>

    <div class="summary">
        <div class="stat-box">
            <div class="stat-value">${summary.total}</div>
            <div class="stat-label">Total Steps</div>
        </div>
        <div class="stat-box">
            <div class="stat-value">${summary.passed}</div>
            <div class="stat-label">Passed</div>
        </div>
        <div class="stat-box">
            <div class="stat-value">${summary.failed}</div>
            <div class="stat-label">Failed</div>
        </div>
        <div class="stat-box">
            <div class="stat-value">${successRate}%</div>
            <div class="stat-label">Success Rate</div>
        </div>
        <div class="stat-box">
            <div class="stat-value">${summary.duration}ms</div>
            <div class="stat-label">Total Duration</div>
        </div>
    </div>

    <h3>Step Details</h3>
    ${steps.map((step, index) => `
        <div class="step ${step.passed ? 'pass' : 'fail'}">
            <div class="step-header">
                <h4>${index + 1}. ${step.name}</h4>
                <p><strong>Command:</strong> ${step.command}</p>
                <p><strong>Status:</strong> <span class="status-${step.passed ? 'pass' : 'fail'}">${step.passed ? 'PASS' : 'FAIL'}</span></p>
                ${step.response ? `<p><strong>Duration:</strong> ${step.response.duration}ms | <strong>Exit Code:</strong> ${step.response.exitCode}</p>` : ''}
            </div>
            <div class="step-content">
                ${step.response && step.response.parsed ? `
                    <h5>Response Data:</h5>
                    <div class="code">${Object.entries(step.response.parsed).map(([k, v]) => `${k}: ${v}`).join('\n')}</div>
                ` : ''}
                
                ${step.tests && step.tests.length > 0 ? `
                    <h5>Test Results:</h5>
                    <div class="test-results">
                        ${step.tests.map(test => `
                            <div class="test-item">
                                <span class="status-${test.passed ? 'pass' : 'fail'}">${test.passed ? '✓' : '✗'}</span>
                                ${test.name}
                                ${!test.passed && test.error ? `<br><small style="color: #dc3545; margin-left: 20px;">${test.error}</small>` : ''}
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
                
                ${step.extracted && Object.keys(step.extracted).length > 0 ? `
                    <h5>Extracted Variables:</h5>
                    <div class="extracted-vars">
                        ${Object.entries(step.extracted).map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`).join('')}
                    </div>
                ` : ''}
                
                ${step.error ? `
                    <h5>Error:</h5>
                    <div class="code" style="color: #dc3545;">${step.error}</div>
                ` : ''}
            </div>
        </div>
    `).join('')}

    <footer style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #dddddd; color: #666666; text-align: center;">
        <p>Generated by 2uknow API Monitor - SClient Scenario Engine</p>
        <p>Report generated at: ${new Date().toISOString()}</p>
    </footer>

    <script>

        // 페이지 로드 시 실행할 함수들이 있다면 여기에 추가
    </script>
</body>
</html>
    `.trim();
  }
}

export default SClientScenarioEngine;