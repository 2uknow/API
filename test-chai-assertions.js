// Chai.js 스타일 assertion 엔진 테스트
import { YAMLAssertEngine } from './yaml-assert-engine.js';
import { SClientYAMLParser } from './simple-yaml-parser.js';

/**
 * YAMLAssertEngine 기능 데모 및 테스트
 */
async function demonstrateChaiAssertions() {
  console.log('=== YAML Chai.js Style Assertion Engine Demo ===\n');

  // 테스트용 응답 데이터 및 컨텍스트 설정
  const mockResponse = {
    result: 0,
    status: 'SUCCESS',
    message: 'Operation completed successfully',
    data: {
      count: 5,
      items: ['item1', 'item2', 'item3'],
      info: {
        version: '1.2.3',
        timeout: 3000
      }
    },
    serverInfo: 'ABC123DEF456',
    responseTime: 1250
  };

  const mockContext = {
    CONN_RESULT: 0,
    AUTH_RESULT: 1,
    SERVER_STATUS: 'ACTIVE',
    ERROR_MSG: 'No errors found',
    SUCCESS_COUNT: 25,
    API_TIMEOUT: 5000
  };

  const engine = new YAMLAssertEngine();
  engine.setContext(mockContext);
  engine.setResponse(mockResponse);

  console.log('Mock Response:', JSON.stringify(mockResponse, null, 2));
  console.log('Mock Context:', JSON.stringify(mockContext, null, 2));
  console.log('\n' + '='.repeat(60) + '\n');

  // === 1. Basic Equality Tests ===
  console.log('1. BASIC EQUALITY TESTS');
  console.log('-'.repeat(30));
  
  const equalityTests = [
    'CONN_RESULT == 0',
    'response.result == 0',
    'expect(CONN_RESULT).to.equal(0)',
    'expect(response.status).to.equal("SUCCESS")',
    'AUTH_RESULT != 0',
    'expect(response.result).to.not.equal(-1)'
  ];

  let result = engine.runTests(equalityTests);
  printTestResults('Equality Tests', result);

  // === 2. Existence Tests ===
  console.log('\n2. EXISTENCE TESTS');
  console.log('-'.repeat(30));
  
  const existenceTests = [
    'CONN_RESULT exists',
    'response.serverInfo exists',
    'expect(response.data).to.exist',
    'UNDEFINED_VAR not exists',
    'expect(response.nonexistent).to.not.exist'
  ];

  result = engine.runTests(existenceTests);
  printTestResults('Existence Tests', result);

  // === 3. String Content Tests ===
  console.log('\n3. STRING CONTENT TESTS');
  console.log('-'.repeat(30));
  
  const stringTests = [
    'ERROR_MSG not contains "FATAL"',
    'response.message contains "success"',
    'expect(response.message).to.contain("completed")',
    'expect(ERROR_MSG).to.not.contain("critical")'
  ];

  result = engine.runTests(stringTests);
  printTestResults('String Content Tests', result);

  // === 4. Numeric Comparison Tests ===
  console.log('\n4. NUMERIC COMPARISON TESTS');
  console.log('-'.repeat(30));
  
  const numericTests = [
    'SUCCESS_COUNT > 20',
    'response.responseTime < 2000',
    'expect(response.responseTime).to.be.above(1000)',
    'expect(response.data.count).to.be.below(10)',
    'API_TIMEOUT >= 5000'
  ];

  result = engine.runTests(numericTests);
  printTestResults('Numeric Comparison Tests', result);

  // === 5. Type and Advanced Tests ===
  console.log('\n5. TYPE AND ADVANCED TESTS');
  console.log('-'.repeat(30));
  
  const advancedTests = [
    'response.status is string',
    'expect(response.data.count).to.be.a("number")',
    'response.data.items.length == 3',
    'expect(response.data.items).to.have.lengthOf(3)',
    'response.data.info.version matches /^[0-9]+\\.[0-9]+/',
    'expect(response).to.have.property("status")'
  ];

  result = engine.runTests(advancedTests);
  printTestResults('Advanced Tests', result);

  // === 6. Object-Style Assertions ===
  console.log('\n6. OBJECT-STYLE ASSERTIONS');
  console.log('-'.repeat(30));
  
  const objectTests = [
    {
      name: 'Response result should be 0',
      expect: 'response.result',
      to: { equal: 0 }
    },
    {
      name: 'Response time should be reasonable',
      expect: 'response.responseTime',
      to: { be: { above: 1000, below: 2000 } }
    },
    {
      name: 'Success count should exist',
      expect: 'SUCCESS_COUNT',
      to: { exist: true }
    }
  ];

  result = engine.runTests(objectTests);
  printTestResults('Object-Style Assertions', result);

  // === 7. PM Script Generation Demo ===
  console.log('\n7. PM SCRIPT GENERATION DEMO');
  console.log('-'.repeat(30));
  
  const testForPM = [
    'response.result == 0',
    'response.serverInfo exists',
    'expect(response.responseTime).to.be.below(5000)'
  ];

  console.log('Generated PM Scripts:');
  console.log('```javascript');
  console.log(engine.generatePMScript(testForPM));
  console.log('```\n');

  // === 8. Error Handling Demo ===
  console.log('\n8. ERROR HANDLING DEMO');  
  console.log('-'.repeat(30));
  
  const errorTests = [
    'invalid_syntax_test',
    'NONEXISTENT_VAR == "should fail"',
    'expect(response.missing).to.equal("error")',
  ];

  result = engine.runTests(errorTests);
  printTestResults('Error Handling Tests', result);
}

/**
 * 테스트 결과를 보기 좋게 출력
 */
function printTestResults(category, result) {
  console.log(`${category}: ${result.passed_count}/${result.total} passed`);
  
  result.results.forEach((testResult, index) => {
    const status = testResult.passed ? '✓' : '✗';
    const testName = typeof testResult.test === 'string' ? 
      testResult.test : 
      (testResult.test.name || JSON.stringify(testResult.test));
    
    console.log(`  ${status} ${testName}`);
    
    if (!testResult.passed && testResult.message) {
      console.log(`    ${testResult.message}`);
    }
    
    if (!testResult.passed && testResult.error) {
      console.log(`    Error: ${testResult.error}`);
    }
  });
  
  if (result.errors.length > 0) {
    console.log(`\nErrors in ${category}:`);
    result.errors.forEach((error, index) => {
      console.log(`  ${index + 1}. ${error.error}`);
    });
  }
}

/**
 * YAML 파일 파싱 테스트
 */
async function testYAMLParsing() {
  console.log('\n' + '='.repeat(60));
  console.log('=== YAML FILE PARSING TEST ===');
  console.log('='.repeat(60) + '\n');

  try {
    const yamlPath = './sample/advanced_chai_test.yaml';
    console.log(`Parsing YAML file: ${yamlPath}`);
    
    // YAML 파일을 JSON으로 변환
    const result = SClientYAMLParser.convertYamlToScenario(yamlPath);
    
    console.log('\nParsed Scenario Info:');
    console.log('- Name:', result.info.name);
    console.log('- Description:', result.info.description);
    console.log('- Variables:', result.variables.length);
    console.log('- Steps:', result.requests.length);
    
    console.log('\nSample Test Scripts Generated:');
    result.requests.forEach((request, index) => {
      if (request.tests && request.tests.length > 0) {
        console.log(`\nStep ${index + 1}: ${request.name}`);
        request.tests.forEach((test, testIndex) => {
          console.log(`  Test ${testIndex + 1}: ${test.name}`);
          // console.log(`    Script: ${test.script.substring(0, 100)}...`);
        });
      }
    });

  } catch (error) {
    console.error('YAML Parsing Error:', error.message);
  }
}

// 메인 실행
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  demonstrateChaiAssertions()
    .then(() => testYAMLParsing())
    .then(() => {
      console.log('\n' + '='.repeat(60));
      console.log('Demo completed successfully!');
      console.log('='.repeat(60));
    })
    .catch(error => {
      console.error('Demo failed:', error);
    });
}

export { demonstrateChaiAssertions, testYAMLParsing };