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
    return this.parseYamlToScenario(content);
  }

  /**
   * YAML 내용을 파싱하여 SClient 시나리오로 변환
   */
  static parseYamlToScenario(yamlContent) {
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
      }
      
      // 단계 섹션 파싱
      else if (currentSection === 'steps') {
        if (indent === 2 && trimmed.startsWith('- name:')) {
          // 새로운 단계 시작
          if (currentStep) {
            scenario.requests.push(currentStep);
          }
          
          currentStep = {
            name: this.extractValue(trimmed.substring(2)), // '- ' 제거
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
              const testName = this.extractValue(trimmed.substring(2));
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
    
    // 마지막 단계 추가
    if (currentStep) {
      scenario.requests.push(currentStep);
    }

    return scenario;
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
   * 키:값 라인에서 값 추출
   */
  static extractValue(line) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) return '';
    
    let value = line.substring(colonIndex + 1).trim();
    
    // 따옴표 제거
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    
    return value;
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
   * 고급 JavaScript 테스트 생성 (name과 description이 있는 경우)
   */
  static createAdvancedJavaScriptTest(jsCondition, testName, description = '') {
    return `pm.test('${testName}', function() {
      // ${description}
      // Condition: ${jsCondition}
      
      // 응답 데이터 복사 (소문자 키로 접근 가능)
      const result = pm.response.result || pm.response.RESULT || pm.response.RESULT_CODE;
      const serverinfo = pm.response.serverinfo || pm.response.SERVER_INFO || pm.response.SERVERINFO;
      const errmsg = pm.response.errmsg || pm.response.ERROR_MESSAGE || pm.response.ERRMSG;
      const cap = pm.response.cap || pm.response.CAP || pm.response.IDELIVER_CAP;
      const ansimmember = pm.response.ansimmember || pm.response.ANSIMMEMBER || pm.response.IDELIVER_ANSIMMEMBER;
      
      try {
        const testResult = ${jsCondition};
        if (testResult) {
          console.log('✅ JavaScript test passed:', '${jsCondition}');
          console.log('Test variables:', { result, serverinfo, errmsg, cap, ansimmember });
        } else {
          console.log('❌ JavaScript test failed:', '${jsCondition}');
          console.log('Test variables:', { result, serverinfo, errmsg, cap, ansimmember });
          pm.expect.fail('JavaScript condition failed: ${jsCondition}');
        }
      } catch (error) {
        console.log('💥 JavaScript test error:', error.message);
        console.log('Test variables:', { result, serverinfo, errmsg, cap, ansimmember });
        pm.expect.fail(\`JavaScript test error: \${error.message}\`);
      }
    });`;
  }

  /**
   * 테스트 표현식에서 깨끗한 테스트 이름 생성
   */
  static getCleanTestName(testExpression) {
    // JavaScript 테스트인 경우
    if (testExpression.startsWith('js:')) {
      return this.getJavaScriptTestName(testExpression.substring(3).trim());
    }

    // 존재 검증
    if (testExpression.includes(' exists')) {
      const fieldName = testExpression.replace(' exists', '').trim();
      return `Verify ${fieldName} field exists`;
    }

    // 값 비교
    if (testExpression.includes(' == ')) {
      const [left, right] = testExpression.split(' == ');
      return `Verify ${left.trim()} equals ${right.trim()}`;
    }

    if (testExpression.includes(' != ')) {
      const [left, right] = testExpression.split(' != ');
      return `Verify ${left.trim()} does not equal ${right.trim()}`;
    }

    // 기본값
    return testExpression;
  }

  /**
   * 테스트 표현식을 클린한 스크립트로 변환 (기존 방식과의 호환성)
   */
  static convertTestToCleanScript(testExpression, extractors = [], stepArgs = {}, testName = null) {
    // 깨끗한 테스트 이름 생성
    const cleanTestName = testName || this.getCleanTestName(testExpression);
    
    // JavaScript 표현식인 경우
    if (testExpression.startsWith('js:')) {
      const jsCondition = testExpression.substring(3).trim();
      return this.createJavaScriptTest(jsCondition, cleanTestName);
    }

    // 존재 검증
    if (testExpression.includes(' exists')) {
      const fieldName = testExpression.replace(' exists', '').trim();
      return `pm.test('Verify ${fieldName} field exists', function() { 
        pm.expect(pm.response).to.have.property('${fieldName.toLowerCase()}'); 
      });`;
    }

    // 값 비교
    if (testExpression.includes(' == ') || testExpression.includes(' != ')) {
      const operator = testExpression.includes(' == ') ? '==' : '!=';
      const [left, right] = testExpression.split(` ${operator} `);
      const fieldName = left.trim();
      const expectedValue = right.trim().replace(/['"]/g, '');
      
      const jsOperator = operator === '==' ? 'to.equal' : 'to.not.equal';
      return `pm.test('Verify ${fieldName} ${operator === '==' ? 'equals' : 'does not equal'} ${expectedValue}', function() { 
        pm.expect(pm.response.${fieldName.toLowerCase()}).${jsOperator}('${expectedValue}'); 
      });`;
    }

    // 기본 테스트
    return `pm.test('${cleanTestName}', function() { 
      // Test: ${testExpression}
      console.log('Test expression:', '${testExpression}');
    });`;
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
}

export default SClientYAMLParser;