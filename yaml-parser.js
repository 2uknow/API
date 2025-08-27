// YAML 시나리오를 JSON으로 변환하는 파서
import fs from 'fs';
import path from 'path';

/**
 * 간단한 YAML 파서 (기본적인 기능만 구현)
 * 외부 라이브러리 없이 SClient 시나리오용 YAML을 JSON으로 변환
 */
export class SimpleYAMLParser {
  
  /**
   * YAML 파일을 파싱하여 JSON 객체로 변환
   */
  static parseFile(yamlPath) {
    const content = fs.readFileSync(yamlPath, 'utf-8');
    return this.parseString(content);
  }

  /**
   * YAML 문자열을 파싱하여 JSON 객체로 변환
   */
  static parseString(yamlContent) {
    const lines = yamlContent.split('\n').map(line => line.trimRight());
    const result = {};
    
    let currentKey = null;
    let currentObject = result;
    let stack = [{ object: result, key: null }];
    let inList = false;
    let listKey = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // 빈 줄이나 주석 건너뛰기
      if (!line.trim() || line.trim().startsWith('#')) {
        continue;
      }

      const indent = this.getIndentLevel(line);
      const trimmed = line.trim();

      // 들여쓰기에 따른 객체 구조 관리
      while (stack.length > 1 && indent <= this.getParentIndent(stack)) {
        stack.pop();
        currentObject = stack[stack.length - 1].object;
      }

      // 리스트 아이템 처리
      if (trimmed.startsWith('- ')) {
        const value = trimmed.substring(2).trim();
        
        // 현재 컨텍스트에서 배열 찾기 또는 생성
        let targetArray = null;
        let targetKey = null;
        
        // 현재 스택의 마지막 컨텍스트 확인
        const currentContext = stack[stack.length - 1];
        if (currentContext && currentContext.key) {
          const parentObject = stack.length > 1 ? stack[stack.length - 2].object : result;
          const key = currentContext.key;
          
          // 현재 키에 배열이 없다면 생성
          if (!Array.isArray(parentObject[key])) {
            parentObject[key] = [];
          }
          targetArray = parentObject[key];
          targetKey = key;
        }

        if (targetArray && value.includes(':')) {
          // 객체형 리스트 아이템
          const newObj = {};
          targetArray.push(newObj);
          
          const [key, val] = this.splitKeyValue(value);
          if (val === '') {
            newObj[key] = {};
            stack.push({ object: newObj, key: null, indent });
            currentObject = newObj;
          } else {
            newObj[key] = this.parseValue(val);
            stack.push({ object: newObj, key: null, indent });
            currentObject = newObj;
          }
        } else if (targetArray) {
          // 단순 값 리스트 아이템
          targetArray.push(this.parseValue(value));
        }
        continue;
      }

      // 키-값 쌍 처리
      if (trimmed.includes(':')) {
        inList = false;
        
        const [key, value] = this.splitKeyValue(trimmed);
        
        if (value === '') {
          // 객체나 배열의 시작
          currentObject[key] = {};
          stack.push({ object: currentObject[key], key, indent });
          currentObject = currentObject[key];
        } else {
          // 단순 값
          currentObject[key] = this.parseValue(value);
        }
      }
    }

    return this.convertToScenarioFormat(result);
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
   * 부모 들여쓰기 레벨 찾기
   */
  static getParentIndent(stack) {
    return stack.length > 1 ? stack[stack.length - 2].indent || 0 : 0;
  }

  /**
   * 키-값 분리
   */
  static splitKeyValue(line) {
    const colonIndex = line.indexOf(':');
    const key = line.substring(0, colonIndex).trim();
    const value = line.substring(colonIndex + 1).trim();
    return [key, value];
  }

  /**
   * 값 파싱 (타입 추론)
   */
  static parseValue(value) {
    if (!value || value === '') return '';
    
    // 따옴표 제거
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    
    // 불린값
    if (value === 'true') return true;
    if (value === 'false') return false;
    
    // 숫자
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    
    return value;
  }

  /**
   * YAML 구조를 SClient 시나리오 JSON 형식으로 변환
   */
  static convertToScenarioFormat(yamlData) {
    const scenario = {
      info: {
        name: yamlData.name || 'Untitled Scenario',
        description: yamlData.description || '',
        version: yamlData.version || '1.0.0',
        schema: 'sclient-scenario/v1.0.0'
      },
      variables: [],
      requests: [],
      events: {
        prerequest: [],
        test: []
      }
    };

    // 변수 변환
    if (yamlData.variables) {
      for (const [key, value] of Object.entries(yamlData.variables)) {
        scenario.variables.push({
          key,
          value: String(value),
          description: `Variable: ${key}`
        });
      }
    }

    // 단계 변환
    if (yamlData.steps && Array.isArray(yamlData.steps)) {
      yamlData.steps.forEach((step, index) => {
        const request = {
          name: step.name || `Step ${index + 1}`,
          description: step.description || '',
          command: step.command,
          arguments: step.args || {},
          tests: [],
          extractors: []
        };

        // 추출기 변환
        if (step.extract && Array.isArray(step.extract)) {
          step.extract.forEach(extractor => {
            request.extractors.push({
              name: extractor.name,
              pattern: extractor.pattern,
              variable: extractor.variable
            });
          });
        }

        // 테스트 변환
        if (step.test && Array.isArray(step.test)) {
          step.test.forEach((test, testIndex) => {
            request.tests.push({
              name: `Test ${testIndex + 1}`,
              script: this.convertTestExpression(test, request.extractors)
            });
          });
        }

        scenario.requests.push(request);
      });
    }

    return scenario;
  }

  /**
   * 간단한 테스트 표현식을 PM 스크립트로 변환
   */
  static convertTestExpression(expression, extractors = []) {
    // 간단한 표현식을 PM 테스트로 변환
    if (typeof expression !== 'string') {
      return `pm.test('Custom test', function() { /* ${JSON.stringify(expression)} */ });`;
    }

    // 변수명을 한국어로 매핑
    const getVariableDisplayName = (variable) => {
      const nameMap = {
        'RESULT_CODE': '응답 코드',
        'SERVER_INFO': '서버 정보', 
        'ERROR_MESSAGE': '오류 메시지',
        'RESPONSE_TIME': '응답 시간',
        'ITEM_COUNT': '아이템 개수',
        'TOTAL_AMOUNT': '총 금액',
        'MULTI_RESULT': '다중 결과',
        'FAIL_RESULT': '테스트 결과'
      };
      return nameMap[variable] || variable;
    };

    // 추출기에서 변수에 대응하는 응답 필드명 찾기
    const getResponseField = (variable) => {
      const extractor = extractors.find(ext => ext.variable === variable);
      return extractor ? extractor.name : variable.toLowerCase();
    };

    // 변수 존재 여부 체크: VARIABLE_NAME exists
    if (expression.match(/^(\w+)\s+exists$/)) {
      const variable = RegExp.$1;
      const friendlyName = getVariableDisplayName(variable);
      const responseField = getResponseField(variable);
      
      return `pm.test('${friendlyName} 필드 존재 검증', function() {
        console.log('테스트 요청 인자:', JSON.stringify(pm.request.data || pm.request.body || {}, null, 2));
        const value = pm.response.${responseField};
        console.log('실제 ${responseField} 값:', value);
        pm.expect(value, '${friendlyName} 필드가 정의되지 않음').to.not.be.undefined;
        pm.expect(value, '${friendlyName} 필드가 null 값임').to.not.be.null;
      });`;
    }

    // 변수 값 비교: VARIABLE_NAME == value
    if (expression.match(/^(\w+)\s*==\s*(.+)$/)) {
      const variable = RegExp.$1;
      const expectedValue = RegExp.$2.trim();
      const friendlyName = getVariableDisplayName(variable);
      const responseField = getResponseField(variable);
      
      return `pm.test('${friendlyName}이(가) ${expectedValue}이어야 함', function() {
        console.log('테스트 요청 인자:', JSON.stringify(pm.request.data || pm.request.body || {}, null, 2));
        const actualValue = pm.response.${responseField};
        console.log('기대값:', ${expectedValue});
        console.log('실제값:', actualValue);
        pm.expect(actualValue, '${friendlyName} 값이 다름 - 기대: ${expectedValue}, 실제: ' + actualValue).to.equal(${expectedValue});
      });`;
    }

    // 변수 값 불일치: VARIABLE_NAME != value
    if (expression.match(/^(\w+)\s*!=\s*(.+)$/)) {
      const variable = RegExp.$1;
      const notExpectedValue = RegExp.$2.trim();
      const friendlyName = getVariableDisplayName(variable);
      const responseField = getResponseField(variable);
      
      return `pm.test('${friendlyName}이(가) ${notExpectedValue}이 아니어야 함', function() {
        console.log('테스트 요청 인자:', JSON.stringify(pm.request.data || pm.request.body || {}, null, 2));
        const actualValue = pm.response.${responseField};
        console.log('예상하지 않은 값:', ${notExpectedValue});
        console.log('실제값:', actualValue);
        pm.expect(actualValue, '${friendlyName}이(가) ${notExpectedValue}과 같음').to.not.equal(${notExpectedValue});
      });`;
    }

    // 문자열 포함 검사: VARIABLE_NAME contains "text"
    if (expression.match(/^(\w+)\s+contains\s+['"](.+)['"]$/)) {
      const variable = RegExp.$1;
      const text = RegExp.$2;
      const friendlyName = getVariableDisplayName(variable);
      const responseField = getResponseField(variable);
      
      return `pm.test('${friendlyName} 텍스트 포함 검증: "${text}"', function() {
        console.log('테스트 요청 인자:', JSON.stringify(pm.request.data || pm.request.body || {}, null, 2));
        const actualValue = pm.response.${responseField};
        console.log('찾는 텍스트:', '${text}');
        console.log('실제값:', actualValue);
        pm.expect(actualValue, '${friendlyName}에서 "${text}"을 찾을 수 없음').to.contain('${text}');
      });`;
    }

    // 문자열 미포함 검사: VARIABLE_NAME not contains "text"
    if (expression.match(/^(\w+)\s+not\s+contains\s+['"](.+)['"]$/)) {
      const variable = RegExp.$1;
      const text = RegExp.$2;
      const friendlyName = getVariableDisplayName(variable);
      const responseField = getResponseField(variable);
      
      return `pm.test('${friendlyName} 텍스트 미포함 검증: "${text}"', function() {
        console.log('테스트 요청 인자:', JSON.stringify(pm.request.data || pm.request.body || {}, null, 2));
        const actualValue = pm.response.${responseField};
        console.log('포함하지 말아야 할 텍스트:', '${text}');
        console.log('실제값:', actualValue);
        pm.expect(actualValue, '${friendlyName}에서 "${text}"가 발견됨').to.not.contain('${text}');
      });`;
    }

    // 기본 테스트
    return `pm.test('${expression}', function() { 
      console.log('테스트 요청 인자:', JSON.stringify(pm.request.data || pm.request.body || {}, null, 2));
      console.log('테스트 표현식:', '${expression}');
      /* ${expression} */ 
    });`;
  }

  /**
   * YAML 시나리오를 JSON 파일로 변환 저장
   */
  static convertYamlToJson(yamlPath, jsonPath = null) {
    if (!jsonPath) {
      jsonPath = yamlPath.replace(/\.ya?ml$/, '.json');
    }

    const scenario = this.parseFile(yamlPath);
    fs.writeFileSync(jsonPath, JSON.stringify(scenario, null, 2));
    
    return {
      yamlPath,
      jsonPath,
      scenario
    };
  }
}

export default SimpleYAMLParser;