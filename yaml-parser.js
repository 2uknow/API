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
              script: this.convertTestExpression(test)
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
  static convertTestExpression(expression) {
    // 간단한 표현식을 PM 테스트로 변환
    if (typeof expression !== 'string') {
      return `pm.test('Custom test', function() { /* ${JSON.stringify(expression)} */ });`;
    }

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
    if (expression.match(/^(\w+)\s+not\s+contains\s+['"](.+)['"]$/)) {
      const fieldName = RegExp.$1;
      const text = RegExp.$2;
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