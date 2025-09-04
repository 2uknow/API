// 간단한 YAML 파서 (SClient 시나리오 전용)
// Last updated: 2025-08-25 13:52 - Uses fixed YAMLAssertEngine
import fs from 'fs';
import path from 'path';
import { YAMLAssertEngine } from './yaml-assert-engine.js';

/**
 * SClient 시나리오 전용 간단한 YAML 파서
 * 복잡한 YAML 구조보다는 실용적인 변환에 중점
 */
export class SClientYAMLParser {
  
  /**
   * YAML 파일을 SClient 시나리오 JSON으로 변환
   */
  static convertYamlToScenario(yamlPath) {
    const content = fs.readFileSync(yamlPath, 'utf-8');
    const basePath = path.dirname(yamlPath);
    return this.parseYamlToScenario(content, basePath);
  }

  /**
   * 변수 치환 처리 ({{variable}} 형태)
   */
  static substituteVariables(text, variables = {}) {
    if (typeof text !== 'string') return text;
    
    return text.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
      const trimmed = varName.trim();
      
      // 동적 변수 처리
      if (trimmed === '$timestamp') {
        return Date.now().toString();
      }
      if (trimmed === '$randomInt') {
        return Math.floor(Math.random() * 10000).toString();
      }
      if (trimmed === '$randomId') {
        return Date.now().toString() + Math.floor(Math.random() * 1000).toString();
      }
      if (trimmed === '$dateTime') {
        return new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
      }
      if (trimmed === '$date') {
        return new Date().toISOString().substring(0, 10).replace(/-/g, '');
      }
      if (trimmed === '$time') {
        return new Date().toTimeString().substring(0, 8).replace(/:/g, '');
      }
      if (trimmed === '$uuid') {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      }
      
      // JavaScript 표현식 처리
      if (trimmed.startsWith('js:')) {
        try {
          const jsCode = trimmed.substring(3).trim();
          const context = {
            Date, Math, parseInt, parseFloat, String, Number,
            env: process.env,
            ...variables
          };
          const func = new Function(...Object.keys(context), `return (${jsCode})`);
          const result = func(...Object.values(context));
          return result !== undefined ? result.toString() : match;
        } catch (error) {
          console.warn(`[JS ERROR] Failed to evaluate: ${trimmed} - ${error.message}`);
          return match;
        }
      }
      
      // 일반 변수 치환
      return variables[trimmed] !== undefined ? variables[trimmed] : match;
    });
  }

  /**
   * YAML 내용을 파싱하여 SClient 시나리오로 변환
   */
  static parseYamlToScenario(yamlContent, basePath = null) {
    // include 처리 (구조화된 방식)
    const { processedContent, commonData } = this.processIncludes(yamlContent, basePath);
    yamlContent = processedContent;
    
    const lines = yamlContent.replace(/\r/g, '').split('\n');
    
    const scenario = {
      info: {
        name: 'Untitled Scenario',
        description: '',
        version: '1.0.0',
        schema: 'sclient-scenario/v1.0.0'
      },
      variables: [],
      requests: [],
      events: {
        prerequest: [],
        test: []
      }
    };

    let currentSection = null;
    let currentStep = null;
    let currentStepProperty = null;
    let indentLevel = 0;
    let collectedVariables = {}; // 변수 수집용
    
    // 🎯 공통 설정의 모든 변수를 자동으로 collectedVariables에 추가
    this.autoLoadCommonVariables(commonData, collectedVariables);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const indent = this.getIndentLevel(line);
      
      // 빈 줄이나 주석 건너뛰기
      if (!trimmed || trimmed.startsWith('#')) continue;

      // 기본 정보 파싱 (최상위 레벨)
      if (indent === 0) {
        if (trimmed.startsWith('name:')) {
          scenario.info.name = this.extractValue(trimmed);
          currentSection = null;
        } else if (trimmed.startsWith('description:')) {
          scenario.info.description = this.extractValue(trimmed);
          currentSection = null;
        } else if (trimmed.startsWith('version:')) {
          scenario.info.version = this.extractValue(trimmed);
          currentSection = null;
        }
        
        // 섹션 시작 감지
        else if (trimmed === 'variables:') {
          currentSection = 'variables';
          currentStep = null;
        } else if (trimmed === 'steps:') {
          currentSection = 'steps';
          currentStep = null;
        } else if (trimmed === 'options:') {
          // 현재 단계가 있다면 저장
          if (currentStep) {
            scenario.requests.push(currentStep);
          }
          currentSection = 'options';
          currentStep = null;
        }
      }
      
      // 변수 섹션 파싱 (2-space indent)
      else if (currentSection === 'variables' && indent === 2 && trimmed.includes(':')) {
        const [key, value] = this.splitKeyValue(trimmed);
        scenario.variables.push({
          key,
          value: value,
          description: `Variable: ${key}`
        });
        // 변수 수집 (변수 치환용)
        collectedVariables[key] = value;
      }
      
      // 단계 섹션 파싱
      else if (currentSection === 'steps') {
        if (indent === 2 && trimmed.startsWith('- name:')) {
          // 새로운 단계 시작 - 이전 단계가 있으면 공통 설정 적용 후 저장
          if (currentStep) {
            // 🎯 자동 공통 설정 적용 (플래그 없이!)
            currentStep = this.autoApplyCommonSettings(currentStep, commonData);
            scenario.requests.push(currentStep);
          }
          
          const rawName = this.extractValue(trimmed.substring(2)); // '- ' 제거
          currentStep = {
            name: this.substituteVariables(rawName, collectedVariables), // 변수 치환 적용
            description: '',
            command: '',
            arguments: {},
            tests: [],
            extractors: []
          };
          currentStepProperty = null;
        }
        
        else if (currentStep && indent === 4) {
          if (trimmed.startsWith('description:')) {
            currentStep.description = this.extractValue(trimmed);
            currentStepProperty = null;
          } else if (trimmed.startsWith('command:')) {
            currentStep.command = this.extractValue(trimmed);
            currentStepProperty = null;
          }
          
          // args 섹션
          else if (trimmed === 'args:') {
            currentStepProperty = 'args';
          }
          
          // extract 섹션
          else if (trimmed === 'extract:') {
            currentStepProperty = 'extract';
          }
          
          // test 섹션
          else if (trimmed === 'test:') {
            currentStepProperty = 'test';
          }
        }
        
        // 속성 내부 파싱 (6-space indent)
        else if (currentStep && indent === 6) {
          if (currentStepProperty === 'args' && trimmed.includes(':')) {
            const [key, value] = this.splitKeyValue(trimmed);
            currentStep.arguments[key] = value;
          }
          
          else if (currentStepProperty === 'extract' && trimmed.startsWith('- name:')) {
            const extractorName = this.extractValue(trimmed.substring(2));
            
            // 다음 몇 줄에서 pattern과 variable 찾기
            let pattern = '';
            let variable = '';
            
            for (let j = i + 1; j < lines.length && j < i + 5; j++) {
              const nextLine = lines[j].trim();
              if (nextLine.startsWith('pattern:')) {
                pattern = this.extractValue(nextLine);
              } else if (nextLine.startsWith('variable:')) {
                variable = this.extractValue(nextLine);
                i = j; // 인덱스 업데이트
                break;
              }
            }
            
            if (pattern && variable) {
              currentStep.extractors.push({
                name: extractorName,
                pattern,
                variable
              });
            }
          }
          
          else if (currentStepProperty === 'test' && trimmed.startsWith('- ')) {
            // 객체 형태 테스트 처리 (- name: "test name")
            if (trimmed.includes('name:')) {
              const rawTestName = this.extractValue(trimmed.substring(2));
              const testName = this.substituteVariables(rawTestName, collectedVariables); // 변수 치환 적용
              let description = '';
              let assertion = '';
              
              // 다음 몇 줄에서 description과 assertion 찾기
              for (let j = i + 1; j < lines.length && j < i + 5; j++) {
                const nextLine = lines[j].trim();
                if (nextLine.startsWith('description:')) {
                  description = this.extractValue(nextLine);
                } else if (nextLine.startsWith('assertion:')) {
                  assertion = this.extractValue(nextLine);
                  i = j; // 인덱스 업데이트
                  break;
                }
              }
              
              if (assertion) {
                // JavaScript 테스트 처리
                if (assertion.startsWith('js:')) {
                  const jsCondition = assertion.substring(3).trim();
                  const testScript = this.createAdvancedJavaScriptTest(jsCondition, testName, description);
                  currentStep.tests.push({
                    name: testName,
                    description: description,
                    script: testScript
                  });
                } else {
                  // 일반 테스트 처리 - testName을 스크립트 생성에 전달
                  const cleanTestScript = this.convertTestToCleanScript(assertion, currentStep.extractors, currentStep.arguments, testName);
                  currentStep.tests.push({
                    name: testName,
                    description: description,
                    script: cleanTestScript
                  });
                }
              }
            } else {
              // 기존 단순 문자열 형태 테스트
              const testExpression = trimmed.substring(2).trim().replace(/['"]/g, '').replace(/#.*$/, '').trim();
              // 주석으로 시작하는 테스트는 건너뛰기
              if (testExpression && !testExpression.startsWith('#')) {
                // JavaScript 조건부 테스트 지원 확인
                if (testExpression.startsWith('js:')) {
                  const jsCondition = testExpression.substring(3).trim();
                  const friendlyName = this.getJavaScriptTestName(jsCondition);
                  const testScript = this.createJavaScriptTest(jsCondition, friendlyName);
                  currentStep.tests.push({
                    name: friendlyName,
                    script: testScript
                  });
                } else {
                  // 기존 방식 (단순 표현식) - 현재 단계의 arguments 전달
                  const cleanTestScript = this.convertTestToCleanScript(testExpression, currentStep.extractors, currentStep.arguments);
                  currentStep.tests.push({
                    name: this.getCleanTestName(testExpression),
                    script: cleanTestScript
                  });
                }
              }
            }
          }
        }
      }
    }
    
    // 마지막 단계 추가 (자동 공통 설정 적용)
    if (currentStep) {
      currentStep = this.autoApplyCommonSettings(currentStep, commonData);
      scenario.requests.push(currentStep);
    }

    // 🎯 공통 변수들을 scenario.variables 배열에 추가 (SClient 엔진이 인식할 수 있도록)
    Object.keys(collectedVariables).forEach(key => {
      // 기존 variables에 없는 공통 변수들만 추가
      const existingVar = scenario.variables.find(v => v.key === key);
      if (!existingVar) {
        scenario.variables.push({
          key,
          value: collectedVariables[key],
          description: `Auto-loaded variable: ${key}`
        });
      }
    });

    // 모든 시나리오에서 변수 치환 적용 (post-processing)
    const processedScenario = this.applyVariableSubstitutionToScenario(scenario, collectedVariables);

    return processedScenario;
  }

  /**
   * 시나리오의 모든 필드에 변수 치환 적용 (post-processing)
   */
  static applyVariableSubstitutionToScenario(scenario, variables) {
    // Deep clone to avoid modifying original
    const newScenario = JSON.parse(JSON.stringify(scenario));
    
    // info.name에 변수 치환 적용
    if (newScenario.info && newScenario.info.name) {
      newScenario.info.name = this.substituteVariables(newScenario.info.name, variables);
    }
    
    // info.description에 변수 치환 적용
    if (newScenario.info && newScenario.info.description) {
      newScenario.info.description = this.substituteVariables(newScenario.info.description, variables);
    }
    
    // requests의 모든 test name에 변수 치환 적용
    if (newScenario.requests && Array.isArray(newScenario.requests)) {
      newScenario.requests.forEach(request => {
        if (request.tests && Array.isArray(request.tests)) {
          request.tests.forEach(test => {
            if (test.name) {
              test.name = this.substituteVariables(test.name, variables);
            }
            if (test.description) {
              test.description = this.substituteVariables(test.description, variables);
            }
          });
        }
      });
    }
    
    return newScenario;
  }

  /**
   * JavaScript 조건부 테스트의 친화적인 이름 생성
   */
  static getJavaScriptTestName(jsCondition) {
    // 일반적인 패턴들을 친화적인 이름으로 변환
    if (jsCondition.includes("result == '0'") && jsCondition.includes("result == '3'")) {
      return "결과 코드가 0이거나 3번 오류여야 함";
    }
    if (jsCondition.includes("result == '0'") && jsCondition.includes("result == '1'") && jsCondition.includes("CPIN")) {
      return "성공(0) 또는 CPIN 관련 오류(1)여야 함";
    }
    if (jsCondition.includes("result == '0'") && jsCondition.includes("new Date().getHours()")) {
      return "성공이거나 오전 9시 이전이어야 함";
    }
    if (jsCondition.includes("CPIN") && jsCondition.includes("password")) {
      return "CPIN 또는 비밀번호 관련 조건 확인";
    }
    
    // 기본값: 조건의 축약형
    if (jsCondition.length > 50) {
      return "조건부 검증: " + jsCondition.substring(0, 40) + "...";
    }
    return "조건부 검증: " + jsCondition;
  }

  /**
   * 고급 JavaScript 테스트 생성 (설명 포함)
   */
  static createAdvancedJavaScriptTest(condition, testName, description) {
    const displayName = testName || this.getJavaScriptTestName(condition);
    const testDescription = description ? `\n    // ${description}` : '';
    
    return `pm.test('${displayName}', function() {${testDescription}
    try {
        // 응답 데이터를 컨텍스트로 제공
        const result = pm.response.result;
        const serverinfo = pm.response.serverinfo;
        const errmsg = pm.response.errmsg;
        const response = pm.response;
        
        // 조건식 실행
        const conditionResult = (${condition});
        
        if (!conditionResult) {
            // 실제/예상 결과 표시
            const actualValues = {
                result: result,
                serverinfo: serverinfo,
                errmsg: errmsg
            };
            
            throw new Error(\`❌ Condition failed: ${condition}\\n\` +
                          \`  📋 Expected: Condition to be true\\n\` +
                          \`  📄 Actual values: \${JSON.stringify(actualValues, null, 2)}\\n\` +
                          \`  🔍 Check if condition matches the actual response data.\`);
        }
        
        // JavaScript test passed (no output for success)
        
    } catch (error) {
        if (error.message.includes('❌ Condition failed')) {
            throw error; // 우리가 만든 에러는 그대로 전달
        } else {
            throw new Error(\`❌ JavaScript execution error: \${error.message}\\n\` +
                          \`  📋 Expected: Valid JavaScript condition\\n\` +
                          \`  📄 Actual: Syntax or runtime error\\n\` +
                          \`  🔍 Check JavaScript syntax: ${condition}\`);
        }
    }
});`;
  }

  /**
   * JavaScript 조건부 테스트 생성
   */
  static createJavaScriptTest(jsCondition, testName = 'JavaScript Condition Test') {
    return `pm.test('${testName}', function() {
    // 응답 데이터 직접 접근
    const result = pm.response.result;
    const serverinfo = pm.response.serverinfo;
    const errmsg = pm.response.errmsg;
    const response = pm.response;
    
    // JavaScript 조건 평가 (CPIN을 문자열로 처리)
    try {
        let condition = ${JSON.stringify(jsCondition)};
        // CPIN을 문자열 리터럴로 변환
        condition = condition.replace(/\\bCPIN\\b/g, "'CPIN'");
        const conditionResult = eval(condition);
        
        if (!conditionResult) {
            throw new Error('조건이 만족되지 않았습니다: ' + condition);
        }
        
        console.log('✅ 조건 통과:', condition);
    } catch (error) {
        console.log('❌ 조건 실패:', ${JSON.stringify(jsCondition)});
        throw error;
    }
});`;
  }

  /**
   * 깔끔한 개별 테스트 이름 생성
   */
  static getCleanTestName(expression) {
    // 변수 매핑을 위한 기본 매핑
    const friendlyNames = {
      'result': '응답 코드',
      'serverInfo': '서버 정보', 
      'errMsg': '오류 메시지',
      'authResult': '인증 결과',
      'responseTime': '응답 시간'
    };

    if (expression.match(/^(\w+)\s+exists?$/)) {
      const field = RegExp.$1;
      const friendlyName = friendlyNames[field] || field;
      return `${friendlyName} 필드 존재 검증`;
    }

    if (expression.match(/^(\w+)\s*==\s*(.+)$/)) {
      const field = RegExp.$1;
      const expected = RegExp.$2;
      const friendlyName = friendlyNames[field] || field;
      return `${friendlyName} 값 검증: ${expected}`;
    }

    if (expression.match(/^(\w+)\s*!=\s*(.+)$/)) {
      const field = RegExp.$1;  
      const notExpected = RegExp.$2;
      const friendlyName = friendlyNames[field] || field;
      return `${friendlyName} 부정 검증: ${notExpected}`;
    }

    return expression;
  }

  /**
   * 깔끔한 개별 테스트 스크립트 생성
   */
  static convertTestToCleanScript(expression, extractors, currentStepArgs = {}, customTestName = null) {
    // 변수 매핑
    const variableMap = {};
    extractors.forEach(extractor => {
      if (extractor.name && extractor.variable) {
        variableMap[extractor.name] = extractor.variable;
      }
    });

    // 소문자 필드명을 대문자 변수명으로 매핑
    let mappedExpression = expression;
    Object.keys(variableMap).forEach(fieldName => {
      const variableName = variableMap[fieldName];
      const regex = new RegExp('\\b' + fieldName + '\\b', 'g');
      mappedExpression = mappedExpression.replace(regex, variableName);
    });

    // 개별 테스트 스크립트 생성
    return this.generateCleanTestScript(mappedExpression, currentStepArgs, customTestName);
  }

  /**
   * 현재 단계의 요청 인자를 동적으로 생성하는 헬퍼 함수
   */
  static generateDynamicRequestArgs(stepArgs, forErrorMessage = false) {
    if (!stepArgs || Object.keys(stepArgs).length === 0) {
      // 기본값 (arguments가 없을 때)
      if (forErrorMessage) {
        return `{SERVICE: pm.variables.get('SERVICE_NAME'), ID: pm.variables.get('MERCHANT_ID'), PWD: '***'}`;
      }
      return `{
        SERVICE: pm.variables.get('SERVICE_NAME'),
        ID: pm.variables.get('MERCHANT_ID'), 
        PWD: pm.variables.get('MERCHANT_PWD'),
        COMMAND: 'ITEMSEND2'
    }`;
    }
    
    // 현재 단계의 실제 args를 기반으로 동적 생성
    const argEntries = Object.entries(stepArgs).map(([key, value]) => {
      // 비밀번호 마스킹
      if (key.toLowerCase().includes('pwd') || key.toLowerCase().includes('password')) {
        return forErrorMessage ? `${key}: '***'` : `        ${key}: "***"`;
      }
      // 변수 참조인지 확인 ({{}} 형태)
      if (typeof value === 'string' && value.includes('{{') && value.includes('}}')) {
        const varName = value.replace(/[{}]/g, '').trim();
        return forErrorMessage ? `${key}: pm.variables.get('${varName}')` : `        ${key}: pm.variables.get('${varName}')`;
      }
      // 일반 값
      return forErrorMessage ? `${key}: "${value}"` : `        ${key}: "${value}"`;
    });
    
    if (forErrorMessage) {
      return `{${argEntries.join(', ')}}`;
    }
    return `{\n${argEntries.join(',\n')}\n    }`;
  }

  /**
   * 깔끔한 개별 테스트 스크립트 생성
   */
  static generateCleanTestScript(expression, currentStepArgs = {}, customTestName = null) {
    // YAMLAssertEngine 사용하여 영어 테스트 이름 생성
    const engine = new YAMLAssertEngine();
    const testScript = engine.convertStringToPMTest(expression);
    
    // 커스텀 테스트 이름이 있으면 그것을 사용, 없으면 생성된 이름 사용
    let testName;
    if (customTestName) {
      testName = customTestName;
    } else {
      // 생성된 스크립트에서 테스트 이름 추출 (fallback용)
      const testNameMatch = testScript.match(/pm\.test\('([^']+)'/);
      testName = testNameMatch ? testNameMatch[1] : this.getCleanTestName(expression.replace(/[A-Z_]+/g, match => {
        // 대문자 변수를 다시 소문자로 매핑 (표시용)
        const varMap = {
          'RESULT_CODE': 'result',
          'SERVER_INFO': 'serverInfo',
          'ERROR_MESSAGE': 'errMsg'
        };
        return varMap[match] || match.toLowerCase();
      }));
    }
    
    // YAMLAssertEngine에서 생성된 스크립트가 있으면 그것을 사용하되, 커스텀 테스트 이름이 있으면 교체
    if (testScript && testScript.includes('pm.test(')) {
      if (customTestName) {
        // 기존 테스트 이름을 커스텀 이름으로 교체
        return testScript.replace(/pm\.test\('([^']+)'/, `pm.test('${testName}'`);
      }
      return testScript;
    }

    // == 패턴
    if (expression.match(/^([A-Z_]+)\s*==\s*(.+)$/)) {
      const variable = RegExp.$1;
      const expected = RegExp.$2.replace(/['"]/g, '');
      const requestArgsCode = this.generateDynamicRequestArgs(currentStepArgs);
      const errorArgsCode = this.generateDynamicRequestArgs(currentStepArgs, true);
      
      return `pm.test('${testName}', function() {
    // 간단하게! response.parsed에 모든 SClient 필드가 있으니까 그냥 찾아서 쓰자
    let actual = undefined;
    
    // 1차: 변수명 기준으로 찾기
    if ('${variable}'.includes('RESULT') && pm.response.result !== undefined) {
        actual = pm.response.result;
    } else if ('${variable}'.includes('SERVER_INFO') && pm.response.serverinfo !== undefined) {
        actual = pm.response.serverinfo;
    } else if ('${variable}'.includes('ERROR') && pm.response.errmsg !== undefined) {
        actual = pm.response.errmsg;
    } else {
        // 2차: response 객체의 모든 키를 확인해서 매칭되는 거 찾기
        const keys = Object.keys(pm.response);
        for (let key of keys) {
            if (pm.response[key] !== undefined && pm.response[key] !== null) {
                actual = pm.response[key];
                break; // 일단 첫 번째로 찾은 값 사용
            }
        }
    }
    
    // Request arguments 표시 (동적 생성)
    console.log('📤 Request Arguments:', JSON.stringify(${requestArgsCode}, null, 2));
    
    // SClient 응답 표시  
    console.log('📥 SClient Response Preview:', {
        result: pm.response.result,
        serverinfo: pm.response.serverinfo,
        errmsg: pm.response.errmsg
    });
    
    if (actual === undefined || actual === null) {
        throw new Error('❌ 값을 찾을 수 없음\\n  🔍 SClient 응답에서 추출되지 않음\\n  📋 요청 인자: ' + JSON.stringify(${errorArgsCode}));
    }
    pm.expect(actual.toString(), \`기대값: ${expected}, 실제값: \${actual}\`).to.equal('${expected}');
});`;
    }

    // exists 패턴
    if (expression.match(/^([A-Z_]+)\s+exists?$/)) {
      const variable = RegExp.$1;
      const requestArgsCode = this.generateDynamicRequestArgs(currentStepArgs);
      const errorArgsCode = this.generateDynamicRequestArgs(currentStepArgs, true);
      
      return `pm.test('${testName}', function() {
    // 동적으로 필드 찾기
    let actual = undefined;
    
    if ('${variable}'.includes('RESULT') && pm.response.result !== undefined) {
        actual = pm.response.result;
    } else if ('${variable}'.includes('SERVER_INFO') && pm.response.serverinfo !== undefined) {
        actual = pm.response.serverinfo;
    } else if ('${variable}'.includes('ERROR') && pm.response.errmsg !== undefined) {
        actual = pm.response.errmsg;
    } else {
        // 다른 필드들도 찾아보기
        const keys = Object.keys(pm.response);
        for (let key of keys) {
            if (pm.response[key] !== undefined && pm.response[key] !== null && pm.response[key] !== '') {
                actual = pm.response[key];
                break;
            }
        }
    }
    
    // Request arguments 표시 (동적 생성)
    console.log('📤 Request Arguments:', JSON.stringify(${requestArgsCode}, null, 2));
    
    // SClient 응답 표시
    console.log('📥 SClient Response Preview:', {
        result: pm.response.result,
        serverinfo: pm.response.serverinfo,
        errmsg: pm.response.errmsg
    });
    
    if (actual === undefined || actual === null || actual === '') {
        throw new Error('❌ 값이 존재하지 않음\\n  🔍 SClient 응답에서 추출되지 않음\\n  📋 요청 인자: ' + JSON.stringify(${errorArgsCode}));
    }
    pm.expect(actual).to.exist;
    pm.expect(actual).to.not.equal('');
});`;
    }

    // != 패턴  
    if (expression.match(/^([A-Z_]+)\s*!=\s*(.+)$/)) {
      const variable = RegExp.$1;
      const notExpected = RegExp.$2.replace(/['"]/g, '');
      const responseField = this.getResponseFieldName(variable);
      const requestArgsCode = this.generateDynamicRequestArgs(currentStepArgs);
      const errorArgsCode = this.generateDynamicRequestArgs(currentStepArgs, true);
      return `pm.test('${testName}', function() {
    const actual = pm.response.${responseField};
    
    // Request arguments 표시 (동적 생성)
    console.log('📤 Request Arguments:', JSON.stringify(${requestArgsCode}, null, 2));
    
    // SClient 응답 표시  
    console.log('📥 SClient Response Preview:', {
        result: pm.response.result,
        serverinfo: pm.response.serverinfo,
        errmsg: pm.response.errmsg
    });
    
    if (actual === undefined || actual === null) {
        throw new Error('❌ 값을 찾을 수 없음\\n  🔍 SClient 응답에서 추출되지 않음\\n  📋 요청 인자: ' + JSON.stringify(${errorArgsCode}));
    }
    pm.expect(actual.toString(), \`${notExpected}이면 안 되는데 실제값: \${actual}\`).to.not.equal('${notExpected}');
});`;
    }

    // 기본 처리
    return `pm.test('${testName}', function() {
    // TODO: ${expression} 구현 필요
    pm.expect(true).to.be.true;
});`;
  }

  /**
   * 변수명을 pm.response 필드명으로 매핑
   * SClient 응답은 이미 sclient-engine.js에서 파싱되어 소문자로 매핑됨
   */
  static getResponseFieldName(variable) {
    // 아주 간단하게! response.parsed에 모든 필드가 있으니까
    // 그냥 변수명을 SClient 원본 필드명으로 변환해서 접근
    
    // 1. RESULT 관련 -> result (sclient-engine.js에서 이미 소문자로 매핑)
    if (variable.includes('RESULT')) {
      return 'result';
    }
    
    // 2. SERVER_INFO 관련 -> serverinfo
    if (variable.includes('SERVER_INFO')) {
      return 'serverinfo';
    }
    
    // 3. ERROR 관련 -> errmsg  
    if (variable.includes('ERROR')) {
      return 'errmsg';
    }
    
    // 4. 기타: response.parsed에서 해당 필드를 직접 찾기
    // 예: IDELIVER_AUTH_RESULT -> authresult
    const cleanName = variable.replace(/^[A-Z]+_/, '').toLowerCase(); // 접두사 제거하고 소문자
    return cleanName.replace(/_/g, ''); // 언더스코어 제거
  }

  /**
   * 수집된 테스트 표현식들을 하나의 통합된 테스트로 변환 (사용 안 함)
   */
  static finalizeStepTests(step) {
    if (!step.testExpressions || step.testExpressions.length === 0) {
      return;
    }

    // 통합된 테스트 스크립트 생성
    const stepName = step.name || '테스트';
    const unifiedScript = this.createUnifiedTestScript(step.testExpressions, step.extractors, stepName);
    
    // 기존 tests 배열 초기화 후 통합 테스트 추가
    step.tests = [{
      name: `${stepName} 검증`,
      script: unifiedScript
    }];

    // 임시 배열 정리
    delete step.testExpressions;
  }

  /**
   * 통합된 테스트 스크립트 생성
   */
  static createUnifiedTestScript(expressions, extractors, stepName) {
    const variableMap = {};
    extractors.forEach(extractor => {
      if (extractor.name && extractor.variable) {
        variableMap[extractor.name] = extractor.variable;
      }
    });

    // 검증 로직들 생성
    const validations = [];
    const successMessages = [];
    
    expressions.forEach(expr => {
      // 변수 매핑 적용
      let mappedExpr = expr;
      Object.keys(variableMap).forEach(fieldName => {
        const variableName = variableMap[fieldName];
        const regex = new RegExp('\\b' + fieldName + '\\b', 'g');
        mappedExpr = mappedExpr.replace(regex, variableName);
      });

      const validation = this.generateValidationLogic(mappedExpr);
      if (validation) {
        validations.push(validation);
        successMessages.push(this.getSuccessMessage(mappedExpr));
      }
    });

    return `pm.test('📋 ${stepName} - 종합 검증', function() {
    const errors = [];
    const successes = [];
    
    ${validations.join('\n    ')}
    
    // 결과 종합
    if (errors.length > 0) {
        throw new Error('❌ 검증 실패 항목:\\n' + errors.join('\\n') + '\\n\\n✅ 성공 항목:\\n' + successes.join('\\n'));
    } else {
        console.log('✅ 모든 검증 통과:\\n' + successes.join('\\n'));
    }
});`;
  }

  /**
   * 개별 검증 로직 생성
   */
  static generateValidationLogic(expression) {
    const engine = new YAMLAssertEngine();
    const friendlyName = expression.match(/^([A-Z_]+)/) ? 
      engine.getFriendlyVariableName(expression.match(/^([A-Z_]+)/)[1]) : expression;

    if (expression.match(/^([A-Z_]+)\s*==\s*(.+)$/)) {
      const variable = RegExp.$1;
      const expected = RegExp.$2.replace(/['"]/g, '');
      const responseField = this.getResponseFieldName(variable);
      return `// ${friendlyName} == ${expected} 검증
    try {
        const actual = pm.response.${responseField};
        if (actual === undefined || actual === null) {
            errors.push('  • ${friendlyName}: 값을 찾을 수 없음 (추출 실패)');
        } else if (actual.toString() !== '${expected}') {
            errors.push('  • ${friendlyName}: 기대값 ${expected}, 실제값 ' + actual);
        } else {
            successes.push('  • ${friendlyName}: ✓ ${expected}');
        }
    } catch (e) {
        errors.push('  • ${friendlyName}: 검증 오류 - ' + e.message);
    }`;
    }

    if (expression.match(/^([A-Z_]+)\s+exists?$/)) {
      const variable = RegExp.$1;
      const responseField = this.getResponseFieldName(variable);
      return `// ${friendlyName} 존재 검증
    try {
        const actual = pm.response.${responseField};
        if (actual === undefined || actual === null || actual === '') {
            errors.push('  • ${friendlyName}: 필드 누락');
        } else {
            successes.push('  • ${friendlyName}: ✓ 검증 성공 (' + actual + ')');
        }
    } catch (e) {
        errors.push('  • ${friendlyName}: 검증 오류 - ' + e.message);
    }`;
    }

    if (expression.match(/^([A-Z_]+)\s*!=\s*(.+)$/)) {
      const variable = RegExp.$1;
      const notExpected = RegExp.$2.replace(/['"]/g, '');
      const responseField = this.getResponseFieldName(variable);
      return `// ${friendlyName} != ${notExpected} 검증
    try {
        const actual = pm.response.${responseField};
        if (actual === undefined || actual === null) {
            errors.push('  • ${friendlyName}: 값을 찾을 수 없음 (추출 실패)');
        } else if (actual.toString() === '${notExpected}') {
            errors.push('  • ${friendlyName}: ${notExpected}이면 안 됨, 실제값 ' + actual);
        } else {
            successes.push('  • ${friendlyName}: ✓ ${notExpected}이 아님 (' + actual + ')');
        }
    } catch (e) {
        errors.push('  • ${friendlyName}: 검증 오류 - ' + e.message);
    }`;
    }

    // 기본 처리
    return `// ${expression} 검증
    try {
        // TODO: ${expression} 구현 필요
        successes.push('  • ${expression}: ✓ 검증 필요');
    } catch (e) {
        errors.push('  • ${expression}: 검증 오류 - ' + e.message);
    }`;
  }

  /**
   * 성공 메시지 생성
   */
  static getSuccessMessage(expression) {
    if (expression.match(/^([A-Z_]+)\s*==\s*(.+)$/)) {
      return `${RegExp.$1} == ${RegExp.$2}`;
    }
    if (expression.match(/^([A-Z_]+)\s+exists?$/)) {
      return `${RegExp.$1} exists`;
    }
    if (expression.match(/^([A-Z_]+)\s*!=\s*(.+)$/)) {
      return `${RegExp.$1} != ${RegExp.$2}`;
    }
    return expression;
  }

  /**
   * 들여쓰기 레벨 계산
   */
  static getIndentLevel(line) {
    let indent = 0;
    for (const char of line) {
      if (char === ' ') indent++;
      else if (char === '\t') indent += 2;
      else break;
    }
    return indent;
  }

  /**
   * 키:값 라인에서 값 추출 (인라인 주석 제거 포함)
   */
  static extractValue(line) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) return '';
    
    let value = line.substring(colonIndex + 1).trim();
    
    // 인라인 주석 제거 (따옴표 밖의 # 이후 제거)
    value = this.removeInlineComments(value);
    
    // 따옴표 제거
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    return value;
  }

  /**
   * 인라인 주석 제거 (따옴표 안의 # 문자는 보존)
   */
  static removeInlineComments(text) {
    let result = '';
    let inQuotes = false;
    let quoteChar = '';
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      
      if (!inQuotes && (char === '"' || char === "'")) {
        // 따옴표 시작
        inQuotes = true;
        quoteChar = char;
        result += char;
      } else if (inQuotes && char === quoteChar) {
        // 따옴표 끝
        inQuotes = false;
        quoteChar = '';
        result += char;
      } else if (!inQuotes && char === '#') {
        // 따옴표 밖의 주석 시작 - 여기서 중단
        break;
      } else {
        result += char;
      }
    }
    
    return result.trim();
  }

  /**
   * 키-값 분리
   */
  static splitKeyValue(line) {
    const colonIndex = line.indexOf(':');
    const key = line.substring(0, colonIndex).trim();
    const value = this.extractValue(line);
    return [key, value];
  }

  /**
   * 향상된 테스트 표현식을 PM 스크립트로 변환 (YAMLAssertEngine 사용)
   */
  static convertTestToScript(expression, extractors = []) {
    // extractors에서 변수 매핑 생성
    const variableMap = {};
    extractors.forEach(extractor => {
      if (extractor.name && extractor.variable) {
        variableMap[extractor.name] = extractor.variable;
      }
    });
    
    // 소문자 필드명을 대문자 변수명으로 매핑
    let mappedExpression = expression;
    Object.keys(variableMap).forEach(fieldName => {
      const variableName = variableMap[fieldName];
      // 단어 경계를 사용하여 정확한 매치
      const regex = new RegExp('\\b' + fieldName + '\\b', 'g');
      mappedExpression = mappedExpression.replace(regex, variableName);
    });
    
    // YAMLAssertEngine을 사용하여 더 풍부한 assertion 지원
    const engine = new YAMLAssertEngine();
    
    // 기본 PM 테스트 스크립트 생성
    try {
      // 매핑된 표현식을 PM 스크립트로 변환
      return engine.convertStringToPMTest(mappedExpression);
    } catch (error) {
      // 실패 시 기본 방식으로 fallback
      return this.convertTestToScriptLegacy(mappedExpression);
    }
  }

  /**
   * 레거시 테스트 변환 방식 (하위 호환성을 위해 유지)
   */
  static convertTestToScriptLegacy(expression) {
    // result == 0
    if (expression.match(/^result\s*==\s*(.+)$/)) {
      const expectedValue = RegExp.$1.trim();
      return `pm.test('Result should be ${expectedValue}', function() { pm.expect(pm.response.result).to.equal('${expectedValue}'); });`;
    }

    // serverInfo exists
    if (expression.match(/^(\w+)\s+exists$/)) {
      const fieldName = RegExp.$1;
      return `pm.test('${fieldName} should exist', function() { pm.expect(pm.response.${fieldName.toLowerCase()}).to.not.be.undefined; });`;
    }

    // errMsg not contains '오류'
    if (expression.match(/^(\w+)\s+not\s+contains\s+(.+)$/)) {
      const fieldName = RegExp.$1;
      const text = RegExp.$2.replace(/['"]/g, '');
      return `pm.test('${fieldName} should not contain "${text}"', function() { pm.expect(pm.response.${fieldName.toLowerCase()}).to.not.contain('${text}'); });`;
    }

    // authResult == 1
    if (expression.match(/^(\w+)\s*==\s*(.+)$/)) {
      const fieldName = RegExp.$1;
      const expectedValue = RegExp.$2.trim();
      return `pm.test('${fieldName} should be ${expectedValue}', function() { pm.expect(pm.response.${fieldName.toLowerCase()}).to.equal('${expectedValue}'); });`;
    }

    // 기본 테스트
    return `pm.test('${expression}', function() { /* ${expression} */ });`;
  }

  /**
   * 향상된 테스트 배열 검증 (런타임에서 사용)
   */
  static validateTests(tests, context, response) {
    const engine = new YAMLAssertEngine();
    engine.setContext(context);
    engine.setResponse(response);
    
    return engine.runTests(tests);
  }

  /**
   * YAML을 JSON 파일로 변환하여 저장
   */
  static convertAndSave(yamlPath, jsonPath = null) {
    if (!jsonPath) {
      // YAML 파일인 경우에만 temp/ 폴더에 생성, 그 외에는 원래 위치
      if (yamlPath.includes('.yaml') || yamlPath.includes('.yml')) {
        const baseName = path.basename(yamlPath).replace(/\.ya?ml$/, '.json');
        jsonPath = path.join('temp', baseName);
      } else {
        jsonPath = yamlPath.replace(/\.ya?ml$/, '.json');
      }
    }

    const scenario = this.convertYamlToScenario(yamlPath);
    fs.writeFileSync(jsonPath, JSON.stringify(scenario, null, 2));
    
    return {
      yamlPath,
      jsonPath,
      scenario
    };
  }

  /**
   * 구조화된 공통 설정 적용 (완전히 동적)
   */
  static applyCommonSettings(stepData, commonData, collectedVariables) {
    console.log('🔧 공통 설정 적용 시작:', stepData.name);
    console.log('   - commonData keys:', Object.keys(commonData));
    console.log('   - useCommonExtracts:', stepData.useCommonExtracts);
    console.log('   - useCommonTests:', stepData.useCommonTests);
    console.log('   - useCarrier:', stepData.useCarrier);

    // 1. 통신사별 설정 먼저 적용 (변수 치환에 필요)
    if (commonData.carriers && stepData.useCarrier) {
      const carrierConfig = commonData.carriers[stepData.useCarrier];
      console.log('   📱 통신사 설정 적용:', stepData.useCarrier, carrierConfig);
      
      if (carrierConfig) {
        // 통신사별 변수를 현재 변수에 병합
        Object.keys(carrierConfig).forEach(key => {
          collectedVariables[key] = carrierConfig[key];
          console.log(`     + ${key} = ${carrierConfig[key]}`);
        });
      }
    }

    // 2. 공통 추출 패턴 적용
    if (commonData.common_extracts && stepData.useCommonExtracts) {
      const extractType = stepData.useCommonExtracts;
      const extractPatterns = commonData.common_extracts[extractType];
      console.log('   📤 공통 추출 패턴 적용:', extractType, extractPatterns);
      
      if (extractPatterns) {
        stepData.extractors = stepData.extractors || [];
        // 공통 추출 패턴을 extractors에 추가
        extractPatterns.forEach(pattern => {
          stepData.extractors.push({
            name: pattern.name,
            pattern: pattern.pattern,
            variable: pattern.variable
          });
          console.log(`     + Extract: ${pattern.name} -> ${pattern.variable}`);
        });
      }
    }

    // 3. 공통 테스트 적용
    if (commonData.common_tests && stepData.useCommonTests) {
      const testTypes = Array.isArray(stepData.useCommonTests) ? stepData.useCommonTests : [stepData.useCommonTests];
      stepData.tests = stepData.tests || [];
      console.log('   ✅ 공통 테스트 적용:', testTypes);
      
      testTypes.forEach(testType => {
        const testGroup = commonData.common_tests[testType];
        if (testGroup) {
          testGroup.forEach(test => {
            stepData.tests.push({
              name: test.name,
              description: test.description || '',
              assertion: test.assertion
            });
            console.log(`     + Test: ${test.name}`);
          });
        }
      });
    }

    // 4. arguments에 변수 치환 적용 (이제 통신사 설정이 collectedVariables에 포함됨)
    if (stepData.arguments && Object.keys(stepData.arguments).length > 0) {
      console.log('   🔄 Arguments 변수 치환 적용');
      Object.keys(stepData.arguments).forEach(key => {
        const originalValue = stepData.arguments[key];
        const substitutedValue = this.substituteVariables(originalValue, collectedVariables);
        if (originalValue !== substitutedValue) {
          console.log(`     + ${key}: ${originalValue} -> ${substitutedValue}`);
          stepData.arguments[key] = substitutedValue;
        }
      });
    }

    // 정리: 플래그들 제거
    delete stepData.useCommonExtracts;
    delete stepData.useCommonTests;
    delete stepData.useCarrier;

    console.log('✅ 공통 설정 적용 완료:', stepData.name);
    return stepData;
  }

  /**
   * YAML 파일에서 include 구문을 처리 (구조화된 방식)
   */
  static processIncludes(yamlContent, basePath = null) {
    if (!basePath) basePath = path.resolve('./collections');
    
    // include: filename.yaml 패턴 찾기
    const includePattern = /^(\s*)include:\s*(.+\.yaml)\s*$/gm;
    
    let processedContent = yamlContent;
    let commonData = {}; // 공통 설정 데이터 저장
    let match;
    
    while ((match = includePattern.exec(yamlContent)) !== null) {
      const [fullMatch, indent, filename] = match;
      
      try {
        const trimmedFilename = filename.trim();
        let includePath;
        
        // 절대경로인지 확인 (Windows: C:\, D:\ / Unix: /)
        if (path.isAbsolute(trimmedFilename)) {
          includePath = trimmedFilename;
        } else {
          // 상대경로는 현재 YAML 파일 기준으로 해석
          includePath = path.resolve(basePath, trimmedFilename);
        }
        
        if (fs.existsSync(includePath)) {
          const includeContent = fs.readFileSync(includePath, 'utf-8');
          
          // 공통 파일인지 확인 (common.yaml 등)
          if (trimmedFilename.includes('common')) {
            // 구조화된 데이터 파싱하여 저장
            commonData = this.parseCommonData(includeContent);
            
            // 공통 파일의 경우 variables와 options만 인라인으로 포함
            const variablesOnlyContent = this.extractVariablesAndOptions(includeContent);
            const indentedContent = this.applyIndentToYaml(variablesOnlyContent, indent);
            processedContent = processedContent.replace(fullMatch, indentedContent);
          } else {
            // 일반 include 파일은 기존 방식 유지
            const indentedContent = this.applyIndentToYaml(includeContent, indent);
            processedContent = processedContent.replace(fullMatch, indentedContent);
          }
        } else {
          console.warn(`⚠️ Include 파일을 찾을 수 없습니다: ${includePath}`);
        }
      } catch (error) {
        console.error(`❌ Include 처리 중 오류 발생: ${filename} - ${error.message}`);
      }
    }
    
    // 처리된 내용과 공통 데이터를 함께 반환
    return { processedContent, commonData };
  }

  /**
   * 공통 데이터 파싱 (구조화된 섹션들)
   */
  static parseCommonData(yamlContent) {
    const lines = yamlContent.replace(/\r/g, '').split('\n');
    const commonData = {};
    
    let currentSection = null;
    let currentSubSection = null;
    let buffer = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      const indent = this.getIndentLevel(line);
      
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      // 최상위 섹션 (common_extracts, common_tests, carriers 등)
      if (indent === 0 && trimmed.endsWith(':')) {
        // 이전 섹션 저장
        if (currentSection && buffer.length > 0) {
          commonData[currentSection] = this.parseStructuredSection(buffer);
          buffer = [];
        }
        
        currentSection = trimmed.replace(':', '');
        currentSubSection = null;
      }
      // 하위 섹션 및 데이터
      else if (currentSection && (currentSection.includes('common_') || currentSection === 'carriers')) {
        buffer.push(line);
      }
    }
    
    // 마지막 섹션 저장
    if (currentSection && buffer.length > 0) {
      commonData[currentSection] = this.parseStructuredSection(buffer);
    }
    
    return commonData;
  }

  /**
   * 구조화된 섹션 파싱
   */
  static parseStructuredSection(lines) {
    const result = {};
    let currentKey = null;
    let currentArray = [];
    let currentObject = {};
    
    for (const line of lines) {
      const trimmed = line.trim();
      const indent = this.getIndentLevel(line);
      
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      // 2단계 들여쓰기: 하위 섹션 키
      if (indent === 2 && trimmed.endsWith(':')) {
        // 이전 키 저장
        if (currentKey) {
          if (currentArray.length > 0) {
            result[currentKey] = currentArray;
          } else if (Object.keys(currentObject).length > 0) {
            result[currentKey] = currentObject;
          }
        }
        
        currentKey = trimmed.replace(':', '');
        currentArray = [];
        currentObject = {};
      }
      // 4단계 들여쓰기: 배열 항목
      else if (indent === 4 && trimmed.startsWith('- ')) {
        if (trimmed.includes('name:')) {
          // 테스트/추출 객체 시작
          const obj = { name: this.extractValue(trimmed.substring(2)) };
          currentArray.push(obj);
        } else {
          // 간단한 문자열 배열
          currentArray.push(trimmed.substring(2));
        }
      }
      // 6단계 들여쓰기: 객체 속성 (추출 패턴의 pattern, variable)
      else if (indent === 6 && trimmed.includes(':')) {
        const [key, value] = this.splitKeyValue(trimmed);
        
        if (currentArray.length > 0 && typeof currentArray[currentArray.length - 1] === 'object') {
          // 배열의 마지막 객체에 속성 추가
          currentArray[currentArray.length - 1][key] = value;
        }
      }
      // 4단계 들여쓰기: 객체 속성 (직접 키-값)
      else if (indent === 4 && trimmed.includes(':')) {
        const [key, value] = this.splitKeyValue(trimmed);
        
        if (currentArray.length > 0 && typeof currentArray[currentArray.length - 1] === 'object') {
          // 배열의 마지막 객체에 속성 추가
          currentArray[currentArray.length - 1][key] = value;
        } else {
          // 직접 객체 속성
          currentObject[key] = value;
        }
      }
    }
    
    // 마지막 키 저장
    if (currentKey) {
      if (currentArray.length > 0) {
        result[currentKey] = currentArray;
      } else if (Object.keys(currentObject).length > 0) {
        result[currentKey] = currentObject;
      }
    }
    
    return result;
  }

  /**
   * variables와 options만 추출
   */
  static extractVariablesAndOptions(yamlContent) {
    const lines = yamlContent.replace(/\r/g, '').split('\n');
    const result = [];
    let currentSection = null;
    let includeCurrentSection = false;
    
    for (const line of lines) {
      const trimmed = line.trim();
      const indent = this.getIndentLevel(line);
      
      if (!trimmed || trimmed.startsWith('#')) {
        if (includeCurrentSection) result.push(line);
        continue;
      }
      
      // 최상위 섹션 확인
      if (indent === 0 && trimmed.endsWith(':')) {
        currentSection = trimmed.replace(':', '');
        includeCurrentSection = (currentSection === 'variables' || currentSection === 'options');
      }
      
      if (includeCurrentSection) {
        result.push(line);
      }
    }
    
    return result.join('\n');
  }

  /**
   * 🎯 공통 설정의 모든 변수를 자동으로 로드 (완전히 동적!)
   */
  static autoLoadCommonVariables(commonData, collectedVariables) {
    // 🚀 모든 구조화된 섹션을 동적으로 처리
    Object.keys(commonData).forEach(sectionName => {
      const section = commonData[sectionName];
      
      // 구조화된 섹션인지 확인 (carriers, payment_methods, servers 등)
      if (typeof section === 'object' && section !== null && !Array.isArray(section)) {
        Object.keys(section).forEach(itemName => {
          const itemConfig = section[itemName];
          
          // 항목이 객체인 경우 (SKT: {IDEN: "...", DST_ADDR: "..."})
          if (typeof itemConfig === 'object' && itemConfig !== null) {
            Object.keys(itemConfig).forEach(key => {
              // 구조화된 변수: SECTION_ITEM_KEY (예: CARRIERS_SKT_IDEN)
              const structuredKey = `${sectionName.toUpperCase()}_${itemName}_${key}`;
              collectedVariables[structuredKey] = itemConfig[key];
              
              // 간편 변수: ITEM_KEY (예: SKT_IDEN)  
              const simpleKey = `${itemName}_${key}`;
              collectedVariables[simpleKey] = itemConfig[key];
              
              // 기본값 설정 (첫 번째 항목을 기본값으로)
              const baseKey = key;
              if (!collectedVariables[baseKey]) {
                collectedVariables[baseKey] = itemConfig[key];
              }
            });
          }
        });
      }
    });
  }

  /**
   * 🎯 공통 추출과 테스트를 자동으로 적용 (플래그 없이!)
   */
  static autoApplyCommonSettings(stepData, commonData) {
    // 1. 기본 추출 패턴을 항상 자동 적용
    if (commonData.common_extracts && commonData.common_extracts.basic_response) {
      stepData.extractors = stepData.extractors || [];
      
      commonData.common_extracts.basic_response.forEach(pattern => {
        stepData.extractors.push({
          name: pattern.name,
          pattern: pattern.pattern,
          variable: pattern.variable
        });
      });
    }
    
    // 2. 기본 성공 테스트를 항상 자동 적용
    if (commonData.common_tests && commonData.common_tests.success_tests) {
      stepData.tests = stepData.tests || [];
      
      commonData.common_tests.success_tests.forEach(test => {
        stepData.tests.push({
          name: test.name,
          description: test.description || '',
          assertion: test.assertion
        });
      });
    }
    
    return stepData;
  }

  /**
   * YAML 내용에 들여쓰기 적용
   */
  static applyIndentToYaml(content, baseIndent) {
    const lines = content.split('\n');
    return lines.map((line, index) => {
      if (line.trim() === '') return line; // 빈 줄은 그대로
      if (index === 0 && line.trim().startsWith('#')) return line; // 첫 줄 주석은 그대로
      return baseIndent + line;
    }).join('\n');
  }

  /**
   * 공통 변수를 현재 YAML의 변수와 병합
   */
  static mergeVariables(currentVars, commonVars) {
    // 현재 파일의 변수가 공통 변수보다 우선순위가 높음
    return { ...commonVars, ...currentVars };
  }
}

export default SClientYAMLParser;