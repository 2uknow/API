// YAML에서 사용할 수 있는 Chai.js 스타일 검증 엔진
import fs from 'fs';

/**
 * YAML 기반 Chai.js 스타일 Assertion 엔진
 * YAML 파일에서 다양한 검증 문법을 지원하여 더 강력한 테스트 작성 가능
 */
export class YAMLAssertEngine {
  
  constructor() {
    this.context = {}; // 테스트 컨텍스트 (변수 등)
    this.response = {}; // 응답 데이터
    this.errors = []; // 검증 오류 목록
  }

  /**
   * 컨텍스트 설정 (변수, 응답 등)
   */
  setContext(context) {
    this.context = context;
    return this;
  }

  /**
   * 응답 데이터 설정
   */
  setResponse(response) {
    this.response = response;
    return this;
  }

  /**
   * YAML 테스트 배열을 검증
   */
  runTests(tests) {
    this.errors = [];
    
    if (!Array.isArray(tests)) {
      tests = [tests];
    }

    const results = tests.map(test => this.runSingleTest(test));
    
    return {
      passed: this.errors.length === 0,
      total: tests.length,
      passed_count: results.filter(r => r.passed).length,
      failed_count: this.errors.length,
      errors: this.errors,
      results
    };
  }

  /**
   * 단일 테스트 실행
   */
  runSingleTest(test) {
    try {
      if (typeof test === 'string') {
        return this.parseStringAssertion(test);
      } else if (typeof test === 'object') {
        return this.parseObjectAssertion(test);
      }
      
      throw new Error('Invalid test format');
    } catch (error) {
      const testError = {
        test,
        error: error.message,
        passed: false
      };
      this.errors.push(testError);
      return testError;
    }
  }

  /**
   * 문자열 형태의 assertion 파싱
   * 예: "response.result == 0", "data.exists", "status.not.contains('error')"
   */
  parseStringAssertion(assertion) {
    const testName = `Test: ${assertion}`;
    
    try {
      // 기본 패턴들
      const patterns = [
        // expect(value).to.equal(expected)
        { 
          regex: /^(\w+(?:\.\w+)*)\s*==\s*(.+)$/, 
          handler: (matches) => this.assertEqual(matches[1], matches[2]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.equal\(([^)]+)\)$/, 
          handler: (matches) => this.assertEqual(matches[1], matches[2]) 
        },
        
        // expect(value).to.not.equal(expected)
        { 
          regex: /^(\w+(?:\.\w+)*)\s*!=\s*(.+)$/, 
          handler: (matches) => this.assertNotEqual(matches[1], matches[2]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.not\.equal\(([^)]+)\)$/, 
          handler: (matches) => this.assertNotEqual(matches[1], matches[2]) 
        },

        // expect(value).to.exist
        { 
          regex: /^(\w+(?:\.\w+)*)\s+exists?$/, 
          handler: (matches) => this.assertExists(matches[1]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.exist$/, 
          handler: (matches) => this.assertExists(matches[1]) 
        },

        // expect(value).to.not.exist
        { 
          regex: /^(\w+(?:\.\w+)*)\s+not\s+exists?$/, 
          handler: (matches) => this.assertNotExists(matches[1]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.not\.exist$/, 
          handler: (matches) => this.assertNotExists(matches[1]) 
        },

        // expect(value).to.contain(text)
        { 
          regex: /^(\w+(?:\.\w+)*)\s+contains?\s+(['"].+['"])$/, 
          handler: (matches) => this.assertContains(matches[1], matches[2]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.contain\(([^)]+)\)$/, 
          handler: (matches) => this.assertContains(matches[1], matches[2]) 
        },

        // expect(value).to.not.contain(text)
        { 
          regex: /^(\w+(?:\.\w+)*)\s+not\s+contains?\s+(['"].+['"])$/, 
          handler: (matches) => this.assertNotContains(matches[1], matches[2]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.not\.contain\(([^)]+)\)$/, 
          handler: (matches) => this.assertNotContains(matches[1], matches[2]) 
        },

        // expect(value).to.be.above(number)
        { 
          regex: /^(\w+(?:\.\w+)*)\s*>\s*(.+)$/, 
          handler: (matches) => this.assertGreaterThan(matches[1], matches[2]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.be\.above\(([^)]+)\)$/, 
          handler: (matches) => this.assertGreaterThan(matches[1], matches[2]) 
        },

        // expect(value).to.be.below(number)
        { 
          regex: /^(\w+(?:\.\w+)*)\s*<\s*(.+)$/, 
          handler: (matches) => this.assertLessThan(matches[1], matches[2]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.be\.below\(([^)]+)\)$/, 
          handler: (matches) => this.assertLessThan(matches[1], matches[2]) 
        },

        // expect(value).to.be.a('type')
        { 
          regex: /^(\w+(?:\.\w+)*)\s+is\s+(\w+)$/, 
          handler: (matches) => this.assertType(matches[1], matches[2]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.be\.a\(['"]([^'"]+)['"]\)$/, 
          handler: (matches) => this.assertType(matches[1], matches[2]) 
        },

        // expect(array).to.have.lengthOf(n)
        { 
          regex: /^(\w+(?:\.\w+)*)\.length\s*==\s*(.+)$/, 
          handler: (matches) => this.assertLength(matches[1], matches[2]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.have\.lengthOf\(([^)]+)\)$/, 
          handler: (matches) => this.assertLength(matches[1], matches[2]) 
        },

        // expect(value).to.be.true/false
        { 
          regex: /^(\w+(?:\.\w+)*)\s+is\s+(true|false)$/, 
          handler: (matches) => this.assertEqual(matches[1], matches[2]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.be\.(true|false)$/, 
          handler: (matches) => this.assertEqual(matches[1], matches[2]) 
        },

        // expect(value).to.match(regex)
        { 
          regex: /^(\w+(?:\.\w+)*)\s+matches?\s+\/(.+)\/$/, 
          handler: (matches) => this.assertMatches(matches[1], matches[2]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.match\(\/([^)]+)\/\)$/, 
          handler: (matches) => this.assertMatches(matches[1], matches[2]) 
        },

        // expect(object).to.have.property('key')
        { 
          regex: /^(\w+(?:\.\w+)*)\s+has\s+property\s+(['"]([^'"]+)['"])$/, 
          handler: (matches) => this.assertHasProperty(matches[1], matches[3]) 
        },
        { 
          regex: /^expect\(([^)]+)\)\.to\.have\.property\(['"]([^'"]+)['"]\)$/, 
          handler: (matches) => this.assertHasProperty(matches[1], matches[2]) 
        }
      ];

      // 패턴 매칭
      for (const pattern of patterns) {
        const matches = assertion.match(pattern.regex);
        if (matches) {
          const result = pattern.handler(matches);
          return {
            test: assertion,
            name: testName,
            passed: result.success,
            message: result.message,
            actual: result.actual,
            expected: result.expected
          };
        }
      }

      throw new Error(`Unknown assertion pattern: ${assertion}`);

    } catch (error) {
      const testResult = {
        test: assertion,
        name: testName,
        passed: false,
        error: error.message
      };
      this.errors.push(testResult);
      return testResult;
    }
  }

  /**
   * 객체 형태의 assertion 파싱
   * 예: { expect: "response.result", to: { equal: 0 } }
   */
  parseObjectAssertion(testObj) {
    const testName = testObj.name || `Test: ${JSON.stringify(testObj)}`;
    
    try {
      if (testObj.expect && testObj.to) {
        const value = this.getValue(testObj.expect);
        
        if (testObj.to.equal !== undefined) {
          const result = this.assertEqual(testObj.expect, testObj.to.equal);
          return this.buildTestResult(testName, result, testObj);
        }
        
        if (testObj.to.not && testObj.to.not.equal !== undefined) {
          const result = this.assertNotEqual(testObj.expect, testObj.to.not.equal);
          return this.buildTestResult(testName, result, testObj);
        }
        
        if (testObj.to.exist !== undefined) {
          const result = this.assertExists(testObj.expect);
          return this.buildTestResult(testName, result, testObj);
        }
        
        if (testObj.to.contain !== undefined) {
          const result = this.assertContains(testObj.expect, testObj.to.contain);
          return this.buildTestResult(testName, result, testObj);
        }

        if (testObj.to.be && testObj.to.be.above !== undefined) {
          const result = this.assertGreaterThan(testObj.expect, testObj.to.be.above);
          return this.buildTestResult(testName, result, testObj);
        }

        if (testObj.to.be && testObj.to.be.below !== undefined) {
          const result = this.assertLessThan(testObj.expect, testObj.to.be.below);
          return this.buildTestResult(testName, result, testObj);
        }
      }

      throw new Error('Invalid object assertion format');
      
    } catch (error) {
      const testResult = {
        test: testObj,
        name: testName,
        passed: false,
        error: error.message
      };
      this.errors.push(testResult);
      return testResult;
    }
  }

  /**
   * 테스트 결과 객체 생성
   */
  buildTestResult(testName, assertResult, originalTest) {
    return {
      test: originalTest,
      name: testName,
      passed: assertResult.success,
      message: assertResult.message,
      actual: assertResult.actual,
      expected: assertResult.expected
    };
  }

  // === Assertion 메서드들 ===

  assertEqual(path, expected) {
    const actual = this.getValue(path);
    const expectedValue = this.parseValue(expected);
    const success = actual == expectedValue;
    
    return {
      success,
      message: success ? 
        `✓ ${path} equals ${expectedValue}` : 
        `✗ Expected ${path} to equal ${expectedValue}, but got ${actual}`,
      actual,
      expected: expectedValue
    };
  }

  assertNotEqual(path, expected) {
    const actual = this.getValue(path);
    const expectedValue = this.parseValue(expected);
    const success = actual != expectedValue;
    
    return {
      success,
      message: success ? 
        `✓ ${path} does not equal ${expectedValue}` : 
        `✗ Expected ${path} to not equal ${expectedValue}, but it does`,
      actual,
      expected: expectedValue
    };
  }

  assertExists(path) {
    const actual = this.getValue(path);
    const success = actual !== undefined && actual !== null;
    
    return {
      success,
      message: success ? 
        `✓ ${path} exists` : 
        `✗ Expected ${path} to exist, but it is ${actual}`,
      actual,
      expected: 'to exist'
    };
  }

  assertNotExists(path) {
    const actual = this.getValue(path);
    const success = actual === undefined || actual === null;
    
    return {
      success,
      message: success ? 
        `✓ ${path} does not exist` : 
        `✗ Expected ${path} to not exist, but got ${actual}`,
      actual,
      expected: 'to not exist'
    };
  }

  assertContains(path, text) {
    const actual = String(this.getValue(path) || '');
    const searchText = this.parseValue(text);
    const success = actual.includes(searchText);
    
    return {
      success,
      message: success ? 
        `✓ ${path} contains "${searchText}"` : 
        `✗ Expected ${path} to contain "${searchText}", but got "${actual}"`,
      actual,
      expected: `to contain "${searchText}"`
    };
  }

  assertNotContains(path, text) {
    const actual = String(this.getValue(path) || '');
    const searchText = this.parseValue(text);
    const success = !actual.includes(searchText);
    
    return {
      success,
      message: success ? 
        `✓ ${path} does not contain "${searchText}"` : 
        `✗ Expected ${path} to not contain "${searchText}", but got "${actual}"`,
      actual,
      expected: `to not contain "${searchText}"`
    };
  }

  assertGreaterThan(path, threshold) {
    const actual = Number(this.getValue(path));
    const expectedValue = Number(this.parseValue(threshold));
    const success = actual > expectedValue;
    
    return {
      success,
      message: success ? 
        `✓ ${path} (${actual}) is greater than ${expectedValue}` : 
        `✗ Expected ${path} (${actual}) to be greater than ${expectedValue}`,
      actual,
      expected: `> ${expectedValue}`
    };
  }

  assertLessThan(path, threshold) {
    const actual = Number(this.getValue(path));
    const expectedValue = Number(this.parseValue(threshold));
    const success = actual < expectedValue;
    
    return {
      success,
      message: success ? 
        `✓ ${path} (${actual}) is less than ${expectedValue}` : 
        `✗ Expected ${path} (${actual}) to be less than ${expectedValue}`,
      actual,
      expected: `< ${expectedValue}`
    };
  }

  assertType(path, expectedType) {
    const actual = this.getValue(path);
    const actualType = typeof actual;
    const success = actualType === expectedType.toLowerCase();
    
    return {
      success,
      message: success ? 
        `✓ ${path} is ${expectedType}` : 
        `✗ Expected ${path} to be ${expectedType}, but got ${actualType}`,
      actual: actualType,
      expected: expectedType
    };
  }

  assertLength(path, expectedLength) {
    const actual = this.getValue(path);
    const length = Array.isArray(actual) || typeof actual === 'string' ? 
      actual.length : Object.keys(actual || {}).length;
    const expectedValue = Number(this.parseValue(expectedLength));
    const success = length === expectedValue;
    
    return {
      success,
      message: success ? 
        `✓ ${path} has length ${expectedValue}` : 
        `✗ Expected ${path} to have length ${expectedValue}, but got ${length}`,
      actual: length,
      expected: expectedValue
    };
  }

  assertMatches(path, pattern) {
    const actual = String(this.getValue(path) || '');
    const regex = new RegExp(pattern);
    const success = regex.test(actual);
    
    return {
      success,
      message: success ? 
        `✓ ${path} matches /${pattern}/` : 
        `✗ Expected ${path} to match /${pattern}/, but got "${actual}"`,
      actual,
      expected: `to match /${pattern}/`
    };
  }

  assertHasProperty(path, property) {
    const obj = this.getValue(path);
    const success = obj && typeof obj === 'object' && property in obj;
    
    return {
      success,
      message: success ? 
        `✓ ${path} has property "${property}"` : 
        `✗ Expected ${path} to have property "${property}"`,
      actual: obj ? Object.keys(obj) : 'not an object',
      expected: `to have property "${property}"`
    };
  }

  // === 유틸리티 메서드들 ===

  /**
   * 경로를 통해 값 가져오기 (예: "response.result", "AUTH_RESULT")
   */
  getValue(path) {
    if (typeof path !== 'string') return path;

    // 변수명인 경우 (대문자 + 언더스코어)
    if (/^[A-Z_]+$/.test(path) && this.context[path] !== undefined) {
      return this.context[path];
    }

    // 점 표기법 경로 파싱 (예: response.result)
    const parts = path.split('.');
    let current = this.response;
    
    // 첫 번째 부분이 'response'가 아니고 컨텍스트에 있다면
    if (parts[0] !== 'response' && this.context[parts[0]] !== undefined) {
      current = this.context;
    }

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }
    
    return current;
  }

  /**
   * 문자열 값을 적절한 타입으로 파싱
   */
  parseValue(value) {
    if (typeof value !== 'string') return value;
    
    // 따옴표 제거
    if ((value.startsWith('"') && value.endsWith('"')) || 
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    
    // 불린값
    if (value === 'true') return true;
    if (value === 'false') return false;
    
    // 숫자
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
    
    return value;
  }

  /**
   * PM/Newman 스크립트 생성
   */
  generatePMScript(tests) {
    const scripts = [];
    
    tests.forEach((test, index) => {
      if (typeof test === 'string') {
        const script = this.convertStringToPMTest(test);
        scripts.push(script);
      } else if (typeof test === 'object') {
        const script = this.convertObjectToPMTest(test, index);
        scripts.push(script);
      }
    });

    return scripts.join('\n\n');
  }

  /**
   * 문자열 assertion을 PM 테스트로 변환
   */
  convertStringToPMTest(assertion) {
    const testName = assertion.replace(/['"]/g, '');
    
    // 간단한 변환 규칙들
    if (assertion.match(/^(\w+(?:\.\w+)*)\s*==\s*(.+)$/)) {
      const field = RegExp.$1;
      const expected = RegExp.$2;
      return `pm.test('${testName}', function() {
    pm.expect(pm.response.json().${field}).to.equal(${expected});
});`;
    }
    
    if (assertion.match(/^(\w+(?:\.\w+)*)\s+exists?$/)) {
      const field = RegExp.$1;
      return `pm.test('${testName}', function() {
    pm.expect(pm.response.json().${field}).to.not.be.undefined;
});`;
    }
    
    // 기본 템플릿
    return `pm.test('${testName}', function() {
    // ${assertion}
    // TODO: Implement this test
});`;
  }

  /**
   * 객체 assertion을 PM 테스트로 변환
   */
  convertObjectToPMTest(testObj, index) {
    const testName = testObj.name || `Test ${index + 1}`;
    
    if (testObj.expect && testObj.to && testObj.to.equal !== undefined) {
      return `pm.test('${testName}', function() {
    pm.expect(pm.response.json().${testObj.expect}).to.equal(${JSON.stringify(testObj.to.equal)});
});`;
    }
    
    return `pm.test('${testName}', function() {
    // TODO: Implement ${JSON.stringify(testObj)}
});`;
  }
}

export default YAMLAssertEngine;