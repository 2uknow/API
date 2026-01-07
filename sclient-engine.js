// SClient 시나리오 실행 엔진
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import { URL } from 'url';
import https from 'https';
import http from 'http';
import fetch from 'node-fetch';
import { SClientToNewmanConverter } from './newman-converter.js';
import { createRequire } from 'module';
import { evaluateAssertion } from './sclient-test-validator.js';

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
  replaceVariables(text, additionalVars = {}) {
    if (typeof text !== 'string') return text;
    
    return text.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
      // JavaScript 표현식 처리
      if (varName.startsWith('js:')) {
        try {
          const jsCode = varName.substring(3).trim();
          // 안전한 컨텍스트 제공 (additionalVars 포함)
          const context = {
            Date, Math, parseInt, parseFloat, String, Number, Array, Object,
            timestamp: Date.now(),
            randomInt: Math.floor(Math.random() * 10000),
            date: new Date().toISOString().substring(0, 10).replace(/-/g, ''),
            time: new Date().toTimeString().substring(0, 8).replace(/:/g, ''),
            env: process.env,
            variables: Object.fromEntries(this.variables),
            encodeURIComponent: encodeURIComponent, // URL 인코딩 함수 추가
            decodeURIComponent: decodeURIComponent, // URL 디코딩 함수 추가
            ...Object.fromEntries(this.variables), // 변수들을 직접 컨텍스트에 추가
            ...additionalVars // 추출된 변수들도 컨텍스트에 추가
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
      
      // 일반 변수 처리 (추가 변수 우선, 기본 변수는 fallback)
      const extractedValue = additionalVars[varName];
      const storedValue = this.variables.get(varName);
      
      if (extractedValue !== undefined) {
        return extractedValue.toString();
      }
      if (storedValue !== undefined) {
        return storedValue.toString();  
      }
      
      return match;
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

        // JavaScript 표현식 패턴 (js: 로 시작)
        if (pattern.startsWith('js:')) {
          const jsCode = pattern.substring(3).trim();
          try {
            // vars 객체에 현재까지 축적된 모든 변수들 포함
            const vars = Object.fromEntries(this.variables);
            // response.parsed도 vars에 병합
            Object.assign(vars, response.parsed || {});

            // JavaScript 표현식 평가
            const evalFunc = new Function('vars', 'response', `return (${jsCode});`);
            value = evalFunc(vars, response);
          } catch (jsErr) {
            this.log(`[EXTRACT ERROR] ${name}: ${jsErr.message}`);
          }
        }
        // 간단한 키워드 기반 추출 (예: "Result" → response.parsed.result)
        else if (!pattern.includes('\\') && !pattern.includes('(') && !pattern.includes('[')) {
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
      const { name, script, description, assertion } = test;
      // test name에도 변수 치환 적용 (추출된 변수들도 포함)
      const resolvedTestName = this.replaceVariables(name || 'Unknown test', extracted);
      // Debug logging removed for production

      // ⚠️ 스크립트가 비어있거나 TODO만 있는 경우, assertion을 직접 평가
      // 이렇게 하면 첫 실행에서 정확한 결과를 얻어서 validator의 "재평가 안함" 로직이 제대로 동작함
      const isEmptyScript = !script ||
                            script.trim() === '' ||
                            script.includes('// TODO: Implement') ||
                            !script.includes('pm.expect') && !script.includes('pm.satisfyCondition');

      if (isEmptyScript && assertion) {
        // 직접 assertion 평가 (evaluateAssertion 사용)
        const evalResult = evaluateAssertion(assertion, extracted);

        if (evalResult.passed) {
          testResults.push({
            name: resolvedTestName,
            description: description,
            passed: true,
            expected: evalResult.expected,
            actual: evalResult.actual,
            assertion: assertion
          });
          this.log(`[TEST PASS] ${resolvedTestName}`);
        } else {
          testResults.push({
            name: resolvedTestName,
            description: description,
            passed: false,
            error: `Expected: ${evalResult.expected}, Actual: ${evalResult.actual}`,
            expected: evalResult.expected,
            actual: evalResult.actual,
            assertion: assertion
          });
          this.log(`[TEST FAIL] ${resolvedTestName}: Expected ${evalResult.expected}, Actual ${evalResult.actual}`);
        }
        return; // forEach 다음 항목으로
      }

      try {
        // 간단한 테스트 스크립트 실행 환경 생성
        const pm = {
          test: (testName, testFn) => {
            try {
              testFn();
              testResults.push({ name: resolvedTestName, description: description, passed: true });
              this.log(`[TEST PASS] ${resolvedTestName}`);
            } catch (err) {
              testResults.push({ name: resolvedTestName, description: description, passed: false, error: err.message });
              this.log(`[TEST FAIL] ${resolvedTestName}: ${err.message}`);
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
              // 모든 변수를 컨텍스트에 포함
              const context = {
                // 기본 JavaScript 객체들
                Date, Math, parseInt, parseFloat, String, Number,

                // 응답 데이터
                result: response.parsed.result,
                serverinfo: response.parsed.serverinfo,
                errmsg: response.parsed.errmsg,
                response: response.parsed,
                actual: actual,

                // 모든 YAML 정의 변수들
                ...Object.fromEntries(this.variables.entries()),

                // 추출된 변수들
                ...extracted
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
            // 이전 단계에서 축적된 모든 변수들 포함
            ...Object.fromEntries(this.variables),
            // 현재 단계의 추출된 변수들 (가장 우선순위 높음)
            ...extracted
          }
        };

        // 디버그: pm.response에 있는 변수 키들 로그
        this.log(`[TEST DEBUG] pm.response keys: ${Object.keys(pm.response).join(', ')}`);
        this.log(`[TEST DEBUG] this.variables keys: ${[...this.variables.keys()].join(', ')}`);

        // 스크립트 실행
        eval(script);
      } catch (err) {
        testResults.push({ name: resolvedTestName, description, passed: false, error: err.message });
        this.log(`[TEST ERROR] ${resolvedTestName}: ${err.message}`);
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
      
      // request name에도 변수 치환 적용
      const resolvedName = this.replaceVariables(request.name);
      
      try {
        this.log(`[STEP ${stepNumber}/${requests.length}] ${resolvedName}`);
        
        // 타입별 명령 실행
        let response;
        if (request.type === 'crypto') {
          response = await this.executeCryptoCommand(request.arguments, `${stepNumber}. ${resolvedName}`);
        } else if (request.type === 'http') {
          response = await this.executeHttpCommand(request.arguments, `${stepNumber}. ${resolvedName}`);
        } else if (request.type === 'sleep') {
          response = await this.executeSleepCommand(request.arguments, `${stepNumber}. ${resolvedName}`);
        } else {
          // 기본값: SClient 실행
          response = await this.executeCommand(
            request.command,
            request.arguments,
            `${stepNumber}. ${resolvedName}`
          );
        }

        // 변수 추출
        const extracted = this.extractVariables(response, request.extractors);

        // 테스트 실행 (추출된 변수들도 전달)
        const testResults = this.runTests(response, request.tests, extracted);

        const stepResult = {
          step: stepNumber,
          name: resolvedName, // 변수가 치환된 이름 사용
          command: request.command,
          commandString: response.cmdString,
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
          name: resolvedName, // 변수가 치환된 이름 사용
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
    // 축적된 모든 변수들을 포함
    scenarioResult.variables = Object.fromEntries(this.variables);

    this.emit('scenario-end', scenarioResult);
    this.log(`[SCENARIO END] Success: ${scenarioResult.success}, Passed: ${scenarioResult.summary.passed}/${scenarioResult.summary.total}`);

    return scenarioResult;
  }

  // 로그 기록
  log(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} ${message}`;
    this.logs.push(logEntry);

    // 디버그 모드에서는 콘솔에도 출력
    if (process.env.DEBUG || message.includes('[DEBUG]')) {
      console.log(logEntry);
    }

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

  // dncrypt를 사용한 암호화 명령 실행
  async executeCryptoCommand(args, description) {
    const startTime = Date.now();

    const { operation, data, key = 'DEFAULT_KEY', sleepDuration } = args;

    // 변수 치환 적용
    let processedData = this.replaceVariables(data);
    const processedKey = this.replaceVariables(key);
    const configuredSleepDuration = sleepDuration || 20000; // 기본값 20초

    // 복호화 시 URL 디코딩 시도 (HTTP 응답에서 추출한 데이터 처리)
    if (operation === 'decrypt' && processedData) {
      try {
        processedData = decodeURIComponent(processedData);
        this.log(`[CRYPTO] URL decoded data before decryption`);
      } catch (error) {
        // 이미 디코딩된 데이터거나 인코딩되지 않은 경우 그대로 사용
        this.log(`[CRYPTO] Data is not URL encoded, using as-is`);
      }
    }

    this.log(`[CRYPTO] ${operation}: ${processedData}`);
    this.log(`[CRYPTO DEBUG] Raw data before processing: "${data}"`);
    this.log(`[CRYPTO DEBUG] Processed data length: ${processedData.length}`);

    return new Promise((resolve, reject) => {
      const cryptoArgs = [operation, processedKey, processedData];
      const dncryptPath = './binaries/windows/dncrypto.exe';

      const dncrypt = spawn(dncryptPath, cryptoArgs, {
        windowsHide: true,
        encoding: 'buffer'  // 바이너리 모드
      });

      let stdoutBuffers = [];
      let stderr = '';

      dncrypt.stdout.on('data', (data) => {
        stdoutBuffers.push(data);
      });

      dncrypt.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      dncrypt.on('close', (code) => {
        const endTime = Date.now();
        const duration = endTime - startTime;

        if (code === 0) {
          // 모든 버퍼를 합치기
          const fullBuffer = Buffer.concat(stdoutBuffers);

          // 복호화된 결과의 특성에 따라 처리
          let result = null;

          try {
            // 먼저 기본 문자열로 변환하여 내용 확인
            const rawString = fullBuffer.toString('utf-8');

            // 암호화 작업 (encrypt)인 경우 - Base64 결과 예상
            if (operation === 'encrypt') {
              const asciiResult = fullBuffer.toString('ascii').trim();
              if (/^[A-Za-z0-9+/=]+$/.test(asciiResult)) {
                result = asciiResult;
                console.log(`[CRYPTO ENCODING] Encrypt result (ASCII): ${result.substring(0, 50)}...`);
              } else {
                result = rawString.trim();
                console.log(`[CRYPTO ENCODING] Encrypt result (UTF-8 fallback): ${result.substring(0, 50)}...`);
              }
            }
            // 복호화 작업 (decrypt)인 경우 - 한글 포함 결과 예상
            else if (operation === 'decrypt') {
              // CP949로 디코딩 시도
              const cp949Result = iconv.decode(fullBuffer, 'cp949');

              // Result=이나 한글이 포함되어 있으면 CP949 사용
              if (cp949Result.includes('Result=') || cp949Result.includes('오류') || cp949Result.includes('성공')) {
                result = cp949Result.trim();
              } else {
                // EUC-KR 시도
                const eucKrResult = iconv.decode(fullBuffer, 'euc-kr');
                if (eucKrResult.includes('Result=') || eucKrResult.includes('오류') || eucKrResult.includes('성공')) {
                  result = eucKrResult.trim();
                } else {
                  // UTF-8 fallback
                  result = rawString.trim();
                }
              }
            }
            // 기타 작업인 경우
            else {
              result = rawString.trim();
              console.log(`[CRYPTO ENCODING] Other operation result (UTF-8): ${result}`);
            }
          } catch (err) {
            result = fullBuffer.toString('utf-8').trim();
            console.log(`[CRYPTO ENCODING] Error, using UTF-8: ${result}`);
          }

          // 암호화 결과는 원본 그대로 유지 (HTTP 전송 시 자동 인코딩)
          let finalResult = result.trim();

          this.log(`[CRYPTO SUCCESS] ${processedData} -> ${finalResult}`);

          // 복호화인 경우 응답을 key=value 형식으로 파싱 (SClient 응답과 동일)
          let parsedDecryptedData = {};
          if (operation === 'decrypt' && finalResult) {
            const lines = finalResult.split(/[|\r\n]+/).filter(line => line.trim());
            lines.forEach(line => {
              const match = line.match(/^(\w+)=(.*)$/);
              if (match) {
                const [, key, value] = match;
                parsedDecryptedData[key.toLowerCase()] = value;
              }
            });
            this.log(`[CRYPTO PARSED] Decrypted data parsed: ${Object.keys(parsedDecryptedData).length} fields found`);
          }

          // PCancel 암호화인 경우 자동으로 슬립 추가
          if (operation === 'encrypt' && processedData.includes('CAMT=')) {
            this.log(`[CRYPTO SLEEP] PCancel 암호화 완료, ${configuredSleepDuration/1000}초 대기 시작`);

            setTimeout(() => {
              const finalDuration = Date.now() - startTime; // 슬립 포함 총 시간
              this.log(`[CRYPTO SLEEP] ${configuredSleepDuration/1000}초 대기 완료, HTTP 요청 준비됨`);

              resolve({
                command: 'dncrypt',
                cmdString: `dncrypt ${operation} ${processedKey} ${processedData} + ${configuredSleepDuration/1000}s sleep`,
                exitCode: code,
                stdout: finalResult,
                stderr: stderr,
                duration: finalDuration,
                timestamp: new Date().toISOString(),
                parsed: {
                  operation: operation,
                  input: processedData,
                  output: finalResult,
                  result: finalResult, // 추출용
                  sleepAdded: true,
                  sleepDuration: configuredSleepDuration,
                  ...parsedDecryptedData // 파싱된 복호화 데이터 추가
                }
              });
            }, configuredSleepDuration); // 설정된 시간만큼 대기
          } else {
            // 일반 암호화/복호화 (슬립 없음)
            resolve({
              command: 'dncrypt',
              cmdString: `dncrypt ${operation} ${processedKey} ${processedData}`,
              exitCode: code,
              stdout: finalResult,
              stderr: stderr,
              duration: duration,
              timestamp: new Date().toISOString(),
              parsed: {
                operation: operation,
                input: processedData,
                output: finalResult,
                result: finalResult, // 추출용
                ...parsedDecryptedData // 파싱된 복호화 데이터 추가
              }
            });
          }
        } else {
          this.log(`[CRYPTO FAILED] Code: ${code}, Error: ${stderr}`);
          reject(new Error(`Crypto operation failed: ${stderr}`));
        }
      });

      dncrypt.on('error', (error) => {
        this.log(`[CRYPTO ERROR] ${error.message}`);
        reject(error);
      });

      // 타임아웃 설정
      setTimeout(() => {
        dncrypt.kill();
        reject(new Error('Crypto operation timeout'));
      }, this.timeout);
    });
  }

  // HTTP POST 명령 실행 (Axios 사용)
  async executeHttpCommand(args, description) {
    const startTime = Date.now();

    const { url, method = 'POST', headers = {}, body = '' } = args;

    // 변수 치환 적용
    const processedUrl = this.replaceVariables(url);
    const processedHeaders = {};
    let processedBody = this.replaceVariables(body);

    Object.keys(headers).forEach(key => {
      processedHeaders[key] = this.replaceVariables(headers[key]);
    });

    // JSP 방식: DATA 파라미터 값에 대해 URL 인코딩 적용
    // JSP에서 urlEncode(encrypt(...))와 동일한 효과
    if (processedBody.includes('DATA=')) {
      // DATA= 파라미터의 값만 이중 URL 인코딩 (서버의 자동 디코딩 보상)
      processedBody = processedBody.replace(/DATA=([^&]+)/, (match, dataValue) => {
        const firstEncoding = encodeURIComponent(dataValue);
        const doubleEncoded = encodeURIComponent(firstEncoding);
        return `DATA=${doubleEncoded}`;
      });
    }

    this.log(`[HTTP POST] ${processedUrl}`);
    this.log(`[HTTP HEADERS] ${JSON.stringify(processedHeaders, null, 2)}`);
    this.log(`[HTTP BODY] ${processedBody}`);

    try {
      // 수동 HTTP 요청 - 완전한 raw 제어
      const parsedUrl = new URL(processedUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const finalHeaders = {
        ...processedHeaders,
        'Content-Length': Buffer.byteLength(processedBody, 'utf8').toString(),
        'Accept': '*/*',
        'Connection': 'close'
      };

      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: method.toUpperCase(),
        headers: finalHeaders,
        timeout: this.timeout,
        rejectUnauthorized: false // SSL 검증 비활성화
      };

      console.log(`[RAW HTTP] Sending raw body: ${processedBody.substring(0, 200)}...`);
      console.log(`[RAW HTTP] Full body length: ${processedBody.length}`);
      console.log(`[RAW HTTP] Body contains %2B: ${processedBody.includes('%2B')}`);
      console.log(`[RAW HTTP] Body contains %2F: ${processedBody.includes('%2F')}`);
      console.log(`[RAW HTTP] Body contains %3D: ${processedBody.includes('%3D')}`);

      const response = await new Promise((resolve, reject) => {
        const req = httpModule.request(requestOptions, (res) => {
          let responseBody = '';
          let chunks = [];

          res.on('data', (chunk) => {
            chunks.push(chunk);
          });

          res.on('end', () => {
            const endTime = Date.now();
            const duration = endTime - startTime;

            const buffer = Buffer.concat(chunks);

            // Content-Type에서 charset 추출
            const contentType = res.headers['content-type'] || '';
            let charset = 'utf-8';

            const charsetMatch = contentType.match(/charset=([^;]+)/i);
            if (charsetMatch) {
              charset = charsetMatch[1].toLowerCase();
            }

            // 응답 디코딩
            try {
              if (charset === 'euc-kr' || charset === 'ks_c_5601-1987') {
                responseBody = iconv.decode(buffer, 'euc-kr');
              } else {
                responseBody = buffer.toString('utf-8');
              }
            } catch (err) {
              responseBody = buffer.toString('utf-8');
            }

            this.log(`[HTTP RESPONSE] Status: ${res.statusCode}`);
            this.log(`[HTTP RESPONSE BODY] ${responseBody}`);

            resolve({
              command: 'http_post',
              cmdString: `POST ${processedUrl}`,
              exitCode: res.statusCode < 400 ? 0 : 1,
              stdout: responseBody,
              stderr: '',
              duration: duration,
              timestamp: new Date().toISOString(),
              parsed: {
                status: res.statusCode,
                statusText: res.statusMessage,
                headers: res.headers,
                body: responseBody
              }
            });
          });
        });

        req.on('error', (error) => {
          const endTime = Date.now();
          const duration = endTime - startTime;

          this.log(`[HTTP ERROR] ${error.message}`);

          resolve({
            command: 'http_post',
            cmdString: `POST ${processedUrl}`,
            exitCode: 1,
            stdout: '',
            stderr: error.message,
            duration: duration,
            timestamp: new Date().toISOString(),
            error: error.message,
            parsed: {
              status: 0,
              statusText: 'Error',
              headers: {},
              body: ''
            }
          });
        });

        req.on('timeout', () => {
          req.destroy();
          const endTime = Date.now();
          const duration = endTime - startTime;

          this.log(`[HTTP TIMEOUT] Request timeout after ${this.timeout}ms`);

          resolve({
            command: 'http_post',
            cmdString: `POST ${processedUrl}`,
            exitCode: 1,
            stdout: '',
            stderr: `HTTP request timeout after ${this.timeout}ms`,
            duration: duration,
            timestamp: new Date().toISOString(),
            error: 'Request timeout',
            parsed: {
              status: 0,
              statusText: 'Timeout',
              headers: {},
              body: ''
            }
          });
        });

        // HTTP body 전송 - URL 인코딩된 상태 그대로
        const bodyBuffer = Buffer.from(processedBody, 'utf8');
        console.log(`[RAW HTTP] Writing ${bodyBuffer.length} bytes`);
        console.log(`[RAW HTTP] Body hex preview: ${bodyBuffer.toString('hex', 0, 50)}`);

        req.write(bodyBuffer);
        req.end();
      });

      return response;
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;

      this.log(`[HTTP ERROR] ${error.message}`);

      return {
        command: 'http_post',
        cmdString: `POST ${processedUrl}`,
        exitCode: 1,
        stdout: '',
        stderr: error.message,
        duration: duration,
        timestamp: new Date().toISOString(),
        error: error.message,
        parsed: {
          status: 0,
          statusText: 'Error',
          headers: {},
          body: ''
        }
      };
    }
  }

  // JavaScript Sleep 명령 실행 (조건부 대기)
  async executeSleepCommand(args, description) {
    const startTime = Date.now();
    const { duration = 1000, condition = null } = args; // 기본값 1초

    // 이전 단계에서 암호화 성공 여부 확인
    const encryptionSuccess = this.variables.has('ENCRYPTED_PCANCEL_DATA');

    if (!encryptionSuccess) {
      this.log(`[JS SLEEP] 암호화 실패로 인한 슬립 건너뛰기`);
      return {
        command: 'js_sleep',
        cmdString: `Skip sleep (encryption failed)`,
        exitCode: 1,
        stdout: `Sleep skipped: encryption not completed`,
        stderr: 'ENCRYPTED_PCANCEL_DATA variable not found',
        duration: 0,
        timestamp: new Date().toISOString(),
        parsed: {
          duration: 0,
          requested: duration,
          status: 'skipped',
          type: 'conditional',
          reason: 'encryption_failed'
        }
      };
    }

    this.log(`[JS SLEEP] 암호화 완료 확인됨, ${duration}ms 대기 시작`);

    // JavaScript Promise 기반 슬립
    await new Promise(resolve => setTimeout(resolve, duration));

    const endTime = Date.now();
    const actualDuration = endTime - startTime;

    this.log(`[JS SLEEP] ${actualDuration}ms 대기 완료`);

    return {
      command: 'js_sleep',
      cmdString: `JavaScript setTimeout(${duration}ms) after encryption`,
      exitCode: 0,
      stdout: `Post-encryption sleep: ${actualDuration}ms elapsed`,
      stderr: '',
      duration: actualDuration,
      timestamp: new Date().toISOString(),
      parsed: {
        duration: actualDuration,
        requested: duration,
        status: 'completed',
        type: 'conditional',
        trigger: 'encryption_success'
      }
    };
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

  /**
   * JavaScript 조건식을 분석하여 각 조건의 평가 결과를 반환 (HTML용)
   * @param {string} expression JavaScript 표현식
   * @param {Object} variables 사용 가능한 변수들
   * @returns {Array} 조건별 분석 결과
   */
  static analyzeJavaScriptConditions(expression, variables = {}) {
    try {
      const results = [];
      
      // && 또는 || 연산자로 분리된 조건들 찾기
      const conditions = this.parseConditions(expression);
      
      if (conditions.length <= 1) {
        // 단일 조건인 경우 전체 표현식 평가
        const result = this.evaluateExpression(expression, variables);
        const details = this.getVariableDetails(expression, variables);
        return [{
          expression: expression,
          result: result,
          details: details
        }];
      }
      
      // 각 조건별로 평가
      for (const condition of conditions) {
        const result = this.evaluateExpression(condition.expression, variables);
        const details = this.getVariableDetails(condition.expression, variables);
        
        results.push({
          expression: condition.expression,
          result: result,
          details: details,
          operator: condition.operator
        });
      }
      
      return results;
      
    } catch (error) {
      return [];
    }
  }

  /**
   * JavaScript 표현식을 && 또는 || 연산자로 분리
   */
  static parseConditions(expression) {
    const conditions = [];
    const operators = ['&&', '||'];
    
    // 간단한 파싱 - 괄호를 고려하지 않은 기본 분리
    let current = expression;
    
    for (const op of operators) {
      const parts = current.split(` ${op} `);
      if (parts.length > 1) {
        conditions.length = 0; // 기존 결과 클리어
        for (let i = 0; i < parts.length; i++) {
          conditions.push({
            expression: parts[i].trim(),
            operator: i > 0 ? op : null
          });
        }
        break;
      }
    }
    
    return conditions.length > 0 ? conditions : [{ expression: expression.trim(), operator: null }];
  }

  /**
   * JavaScript 표현식을 안전하게 평가
   */
  static evaluateExpression(expression, variables) {
    try {
      // 사용 가능한 변수들을 함수 컨텍스트에 추가
      const context = { ...variables };
      
      // Function constructor를 사용하여 안전하게 평가
      const func = new Function(...Object.keys(context), `return (${expression})`);
      return func(...Object.values(context));
      
    } catch (error) {
      return false;
    }
  }

  /**
   * 표현식에서 사용된 변수들의 상세 정보 생성 (HTML with expandable values)
   */
  static getVariableDetails(expression, variables) {
    const details = [];

    // variables 객체에 실제로 존재하는 키들만 표시
    // 이 방식이면 JavaScript 내장 객체 필터링이 필요 없음
    for (const varName of Object.keys(variables)) {
      // 표현식에 해당 변수명이 포함되어 있는지 확인
      const varRegex = new RegExp(`\\b${varName}\\b`);
      if (!varRegex.test(expression)) continue;

      const value = variables[varName];
      if (typeof value === 'string' && value.length > 20) {
        const shortValue = value.substring(0, 20);
        const expandId = `expand_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        details.push(`(${varName} = "<span class="expandable-value" data-full-value="${value.replace(/"/g, '&quot;')}" onclick="toggleValueExpansion('${expandId}')" id="${expandId}">${shortValue}...</span>")`);
      } else {
        details.push(`(${varName} = "${value}")`);
      }
    }

    return details.length > 0 ? details.join(' ') : '';
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
        
        /* 툴팁 스타일 추가 */
        .tooltip {
            position: relative;
            cursor: help;
        }
        
        .tooltip::before {
            content: attr(data-tooltip);
            position: absolute;
            bottom: 125%;
            left: 50%;
            transform: translateX(-50%);
            background: #333;
            color: white;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 14px;
            white-space: nowrap;
            opacity: 0;
            visibility: hidden;
            transition: all 0.3s ease;
            z-index: 1000;
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
            max-width: 400px;
            white-space: normal;
            text-align: center;
            line-height: 1.4;
        }
        
        .tooltip::after {
            content: '';
            position: absolute;
            bottom: 115%;
            left: 50%;
            transform: translateX(-50%);
            border: 6px solid transparent;
            border-top-color: #333;
            opacity: 0;
            visibility: hidden;
            transition: all 0.3s ease;
            z-index: 1000;
        }
        
        .tooltip:hover::before,
        .tooltip:hover::after {
            opacity: 1;
            visibility: visible;
        }
        
        /* Expandable Values */
        .expandable-value {
            color: #007bff;
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 3px;
            background: rgba(0, 123, 255, 0.1);
            transition: all 0.3s ease;
            display: inline-block;
            position: relative;
            max-width: 100%;
            word-break: break-all;
        }
        
        .expandable-value:hover {
            background: rgba(0, 123, 255, 0.2);
            transform: translateY(-1px);
        }
        
        .expandable-value.expanded {
            background: rgba(0, 123, 255, 0.15);
            padding: 4px 6px;
            border-radius: 4px;
        }
        
        .expandable-value::after {
            content: '🔍';
            position: absolute;
            right: -2px;
            top: -2px;
            font-size: 10px;
            opacity: 0.7;
            transition: opacity 0.3s ease;
        }
        
        .expandable-value:hover::after {
            opacity: 1;
        }
        
        .expandable-value.expanded::after {
            content: '🔄';
        }
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
                        ${step.tests.map(test => {
                            const hasDescription = test.description && test.description.trim();
                            const tooltipClass = hasDescription ? 'tooltip' : '';
                            const tooltipAttr = hasDescription ? `data-tooltip="${test.description.replace(/"/g, '&quot;')}"` : '';
                            
                            return `
                            <div class="test-item">
                                <span class="status-${test.passed ? 'pass' : 'fail'}">${test.passed ? '✓' : '✗'}</span>
                                <span class="${tooltipClass}" ${tooltipAttr}>${test.name}</span>
                                ${!test.passed && test.error ? `<br><small style="color: #dc3545; margin-left: 20px;">${test.error}</small>` : ''}
                                ${!test.passed && test.debugInfo && test.assertion && test.assertion.startsWith('js:') ? `
                                <div style="margin-left: 20px; margin-top: 8px; padding: 8px; background: rgba(220,53,69,0.1); border-left: 3px solid #dc3545; font-size: 12px;">
                                    <strong>JavaScript Debug Info:</strong><br>
                                    <code style="background: rgba(0,0,0,0.1); padding: 2px 4px; border-radius: 3px;">${test.debugInfo.expression}</code><br>
                                    <strong>Result:</strong> ${test.debugInfo.result} (${test.debugInfo.resultType})<br>
                                    ${test.debugInfo.variables && Object.keys(test.debugInfo.variables).length > 0 ? `
                                    <strong>Variables:</strong><br>
                                    ${Object.entries(test.debugInfo.variables).map(([name, info]) => 
                                        `&nbsp;&nbsp;${name} = "${info.value}" (${info.type}, exists: ${info.exists})`
                                    ).join('<br>')}
                                    ` : ''}
                                    ${test.debugInfo.evaluation && test.debugInfo.evaluation.steps ? `
                                    <strong>Steps:</strong><br>
                                    ${test.debugInfo.evaluation.steps.map((step, index) => {
                                        const result = step.error ? `ERROR: ${step.error}` : step.result;
                                        return `&nbsp;&nbsp;${index + 1}. ${step.expression} → ${result}`;
                                    }).join('<br>')}
                                    ` : ''}
                                </div>
                                ` : ''}
                                ${!test.passed && test.assertion && test.assertion.startsWith('js:') && !test.debugInfo ? `
                                <div style="margin-left: 20px; margin-top: 8px; padding: 8px; background: rgba(220,53,69,0.1); border-left: 3px solid #dc3545; font-size: 12px;">
                                    <strong>JavaScript Condition Analysis:</strong><br>
                                    <code style="background: rgba(0,0,0,0.1); padding: 2px 4px; border-radius: 3px;">${test.assertion.substring(3).trim()}</code><br>
                                    ${(() => {
                                        const jsExpression = test.assertion.substring(3).trim();
                                        const conditionAnalysis = SClientScenarioEngine.analyzeJavaScriptConditions(jsExpression, step.extracted || {});
                                        if (conditionAnalysis && conditionAnalysis.length > 0) {
                                            return conditionAnalysis.map(condition => {
                                                const status = condition.result ? '✅' : '❌';
                                                return `&nbsp;&nbsp;${status} <code>${condition.expression}</code> → ${condition.result} ${condition.details ? condition.details : ''}`;
                                            }).join('<br>') + `<br><strong>Overall Result:</strong> false`;
                                        }
                                        return '';
                                    })()}
                                </div>
                                ` : ''}
                            </div>
                            `;
                        }).join('')}
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
        // Toggle expandable value expansion
        function toggleValueExpansion(elementId) {
            const element = document.getElementById(elementId);
            if (!element) return;
            
            const isExpanded = element.classList.contains('expanded');
            
            if (isExpanded) {
                // Collapse: show shortened value
                const fullValue = element.getAttribute('data-full-value');
                const shortValue = fullValue.substring(0, 20);
                element.textContent = shortValue + '...';
                element.classList.remove('expanded');
            } else {
                // Expand: show full value
                const fullValue = element.getAttribute('data-full-value');
                element.textContent = fullValue;
                element.classList.add('expanded');
            }
        }

        // 페이지 로드 시 실행할 함수들이 있다면 여기에 추가
    </script>
</body>
</html>
    `.trim();
  }

  // curl을 통한 HTTP POST 요청 (+ 기호 보존, 자체 인증서 대응)
  async executeHttpWithCurl(url, headers, body, startTime) {
    this.log(`[HTTP CURL] Starting curl request to ${url}`);

    const args = [
      '-X', 'POST',
      '-H', `Content-Type: ${headers['Content-Type'] || 'application/x-www-form-urlencoded'}`,
      '-H', `User-Agent: ${headers['User-Agent'] || '2uknow-api-monitor/1.0.0'}`,
      '--data', body,
      '-k', // 자체 인증서 무시
      '-s', // silent
      url
    ];

    this.log(`[CURL CMD] curl ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const curl = spawn('curl', args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      let resolved = false;

      const finish = (result) => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };

      curl.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      curl.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      curl.on('close', (code) => {
        const execTime = Date.now() - startTime;
        this.log(`[CURL RESULT] Code: ${code}, Response: "${stdout.trim()}"`);

        finish({
          status: code === 0 ? 200 : code,
          body: stdout.trim() || stderr.trim() || 'No response',
          executionTime: execTime
        });
      });

      curl.on('error', (error) => {
        this.log(`[CURL ERROR] ${error.message}`);
        finish({
          status: 0,
          body: `CURL_ERROR: ${error.message}`,
          executionTime: Date.now() - startTime
        });
      });

      // 5초 타임아웃
      setTimeout(() => {
        if (!resolved) {
          this.log(`[CURL TIMEOUT] Request timed out`);
          curl.kill();
          finish({
            status: 0,
            body: 'TIMEOUT',
            executionTime: Date.now() - startTime
          });
        }
      }, 5000);
    });
  }

  // bash를 통한 curl HTTP POST 요청 (+ 기호 보존, 자체 인증서 대응)
  async executeHttpWithBash(url, headers, body, startTime) {
    this.log(`[HTTP BASH CURL START] URL: ${url}`);
    this.log(`[HTTP BASH CURL START] Body: ${body}`);
    this.log(`[HTTP BASH CURL START] Headers:`, headers);

    try {
      const executionTime = Date.now() - startTime;

      // curl 명령어 구성 (Windows 환경 고려)
      const curlCmd = `curl -X POST "${url}" ` +
        `-H "Content-Type: ${headers['Content-Type'] || 'application/x-www-form-urlencoded'}" ` +
        `-H "User-Agent: ${headers['User-Agent'] || '2uknow-api-monitor/1.0.0'}" ` +
        `--data "${body}" -k -s`;

      this.log(`[BASH CURL CMD] ${curlCmd}`);

      return new Promise((resolve, reject) => {
        const require = createRequire(import.meta.url);
        const { exec } = require('child_process');

        this.log(`[BASH CURL EXEC] Starting exec...`);

        exec(curlCmd, (error, stdout, stderr) => {
        const execTime = Date.now() - startTime;

        this.log(`[BASH CURL DEBUG] Error: ${error}, Stdout: "${stdout}", Stderr: "${stderr}"`);

        if (error) {
          this.log(`[BASH CURL ERROR] ${error.message}`);
          resolve({
            status: 0,
            body: `EXEC_ERROR: ${error.message}`,
            error: error.message,
            executionTime: execTime
          });
          return;
        }

        const responseBody = stdout.trim();
        this.log(`[BASH CURL RESPONSE] Body: ${responseBody}`);

        resolve({
          status: responseBody ? 200 : 0,
          body: responseBody,
          executionTime: execTime
        });
      });
    });
    } catch (err) {
      this.log(`[BASH CURL ERROR] Exception: ${err.message}`);
      return {
        status: 0,
        body: `CURL_ERROR: ${err.message}`,
        executionTime: Date.now() - startTime
      };
    }
  }
}

export default SClientScenarioEngine;