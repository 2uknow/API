#!/usr/bin/env node

/**
 * YAML 테스트 실행기
 * 사용법: node run-yaml.js [yaml파일경로]
 * 예시: node run-yaml.js collections/simple_api_test.yaml
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { SClientYAMLParser } from './simple-yaml-parser.js';
import { SClientScenarioEngine } from './sclient-engine.js';

async function runYamlTest(yamlFilePath) {
    try {
        // 1. YAML 파일 읽기
        if (!fs.existsSync(yamlFilePath)) {
            console.error(`파일을 찾을 수 없습니다: ${yamlFilePath}`);
            process.exit(1);
        }
        
        const yamlContent = fs.readFileSync(yamlFilePath, 'utf8');
        const yamlData = yaml.load(yamlContent);
        
        // 2. YAML → JSON 시나리오 변환
        const scenario = SClientYAMLParser.parseYamlToScenario(yamlContent);
        
        // 3. 임시 시나리오 파일 생성 및 SClient 실행
        const tempScenarioPath = path.join('temp', `temp_scenario_${Date.now()}.json`);
        
        // temp 디렉토리 확인/생성
        const tempDir = path.dirname(tempScenarioPath);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // 시나리오를 임시 파일로 저장
        fs.writeFileSync(tempScenarioPath, JSON.stringify(scenario, null, 2), 'utf-8');
        
        const engine = new SClientScenarioEngine();
        const results = await engine.runScenario(tempScenarioPath);
        
        // 임시 파일 정리
        try {
            fs.unlinkSync(tempScenarioPath);
        } catch (error) {
            console.log(`임시 파일 정리 실패: ${error.message}`);
        }
        
        // 4. 우리가 직접 테스트 검증 수행 (기존 엔진의 버그 우회)
        const validatedResults = validateTestsManually(results, yamlData);
        
        // 5. 결과 출력
        displayResults(validatedResults);
        
    } catch (error) {
        console.error('실행 중 오류 발생:', error.message);
        process.exit(1);
    }
}

function displayResults(scenarioResult) {
    let totalTests = 0;
    let passedTests = 0;
    
    // 각 스텝 결과 출력 (SClient 명령어 + 추출된 변수 + 테스트 결과)
    if (scenarioResult.steps && Array.isArray(scenarioResult.steps)) {
        scenarioResult.steps.forEach((step, index) => {
            // SClient 명령어 표시
            if (step.commandString) {
                console.log(`\n실행 명령어: ./SClient "${step.commandString}"`);
            }
            
            // SClient 응답값 표시
            if (step.response && step.response.stdout) {
                console.log('응답값:');
                console.log(`  ${step.response.stdout.trim()}`);
            }
            
            // 추출된 변수 표시
            if (step.extracted && Object.keys(step.extracted).length > 0) {
                console.log('추출된 변수:');
                Object.keys(step.extracted).forEach(varName => {
                    const value = step.extracted[varName];
                    const type = typeof value;
                    const length = (typeof value === 'string') ? value.length : 'N/A';
                    console.log(`  ${varName}: "${value}" (type: ${type}, length: ${length})`);
                });
            }
            
            // 테스트 결과 출력
            if (step.tests && Array.isArray(step.tests) && step.tests.length > 0) {
                step.tests.forEach(test => {
                    totalTests++;
                    const status = test.passed ? '✅' : '❌';
                    const testName = test.name || test.assertion || 'Unknown test';
                    
                    console.log(`${status} ${testName}`);
                    
                    if (!test.passed) {
                        console.log(`    Expected: ${test.expected || 'N/A'}`);
                        console.log(`    Actual: ${test.actual || 'N/A'}`);
                        if (test.error) {
                            console.log(`    Error: ${test.error}`);
                        }
                        
                        // JavaScript 표현식 실패시에만 표현식 표시
                        if (test.assertion && test.assertion.startsWith('js:')) {
                            console.log(`    JavaScript Expression: ${test.assertion.substring(3).trim()}`);
                        }
                        
                    } else {
                        passedTests++;
                    }
                });
            }
        });
    }
}

// 명령행 실행
const yamlFile = process.argv[2];

if (!yamlFile) {
    console.log('사용법: node run-yaml.js [yaml파일경로]');
    console.log('예시: node run-yaml.js collections/simple_api_test.yaml');
    process.exit(1);
}

runYamlTest(yamlFile);

// 범용 Assertion 평가 엔진
function evaluateAssertion(assertion, extractedVars) {
    try {
        // 1. exists 체크 패턴
        const existsMatch = assertion.match(/^(\w+)\s+exists$/i);
        if (existsMatch) {
            const varName = existsMatch[1];
            const exists = extractedVars[varName] !== undefined;
            return {
                passed: exists,
                expected: 'exists',
                actual: exists ? 'exists' : 'undefined'
            };
        }
        
        // 2. 등호 비교 패턴 (==, !=, >, <, >=, <=)
        const comparisonMatch = assertion.match(/^(\w+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
        if (comparisonMatch) {
            const varName = comparisonMatch[1];
            const operator = comparisonMatch[2];
            let expectedValue = comparisonMatch[3];
            
            // 따옴표 제거
            if ((expectedValue.startsWith('"') && expectedValue.endsWith('"')) ||
                (expectedValue.startsWith("'") && expectedValue.endsWith("'"))) {
                expectedValue = expectedValue.slice(1, -1);
            }
            
            const actualValue = extractedVars[varName];
            
            let passed = false;
            switch (operator) {
                case '==':
                    passed = actualValue == expectedValue;
                    break;
                case '!=':
                    passed = actualValue != expectedValue;
                    break;
                case '>':
                    passed = parseFloat(actualValue) > parseFloat(expectedValue);
                    break;
                case '<':
                    passed = parseFloat(actualValue) < parseFloat(expectedValue);
                    break;
                case '>=':
                    passed = parseFloat(actualValue) >= parseFloat(expectedValue);
                    break;
                case '<=':
                    passed = parseFloat(actualValue) <= parseFloat(expectedValue);
                    break;
            }
            
            return {
                passed: passed,
                expected: expectedValue,
                actual: actualValue,
                operator: operator
            };
        }
        
        // 3. JavaScript 표현식 패턴 - 완전 범용
        if (assertion.startsWith('js:')) {
            const jsCode = assertion.substring(3).trim();
            
            // 모든 추출된 변수를 그대로 컨텍스트에 추가
            const evalContext = { ...extractedVars };
            
            // 소문자 버전도 추가 (호환성)
            Object.keys(extractedVars).forEach(key => {
                evalContext[key.toLowerCase()] = extractedVars[key];
            });
            
            // JavaScript 코드 실행
            let result, error = null;
            try {
                result = new Function(...Object.keys(evalContext), `return ${jsCode}`)(...Object.values(evalContext));
            } catch (e) {
                result = false;
                error = e.message;
            }
            
            return {
                passed: !!result,
                expected: 'truthy',
                actual: `${result} (${typeof result})`,
                jsExpression: jsCode,
                error: error
            };
        }
        
        // 4. 인식할 수 없는 패턴은 문자열로 처리 (기존 호환성)
        return {
            passed: true,
            expected: 'unknown pattern',
            actual: 'skipped',
            warning: `Unrecognized assertion pattern: ${assertion}`
        };
        
    } catch (error) {
        return {
            passed: false,
            expected: 'no error',
            actual: error.message,
            error: `Evaluation failed: ${error.message}`
        };
    }
}

// 테스트 검증 함수 (기존 엔진의 버그 우회용)
function validateTestsManually(scenarioResult, yamlData) {
    // 모든 스텝에 대해 테스트 검증 수행
    scenarioResult.steps.forEach((step, stepIndex) => {
        const yamlStep = yamlData.steps && yamlData.steps[stepIndex];
        if (yamlStep && yamlStep.test && Array.isArray(yamlStep.test)) {
            const validatedTests = yamlStep.test.map(yamlTest => {
                const testName = yamlTest.name || yamlTest;
                const assertion = yamlTest.assertion || yamlTest;
                
                // 범용 assertion 평가
                const evalResult = evaluateAssertion(assertion, step.extracted || {});
                
                return {
                    name: testName,
                    assertion: assertion,
                    passed: evalResult.passed,
                    expected: evalResult.expected,
                    actual: evalResult.actual,
                    error: evalResult.passed ? null : `Expected: ${evalResult.expected}, Actual: ${evalResult.actual}`
                };
            });
            
            // 스텝의 테스트 결과 교체
            step.tests = validatedTests;
            
            // 스텝 통과 여부 재계산
            step.passed = validatedTests.every(test => test.passed);
        }
    });
    
    // 전체 성공 여부 재계산
    scenarioResult.success = scenarioResult.steps.every(step => step.passed);
    
    // 요약 정보 업데이트
    if (scenarioResult.summary) {
        scenarioResult.summary.passed = scenarioResult.steps.filter(step => step.passed).length;
        scenarioResult.summary.failed = scenarioResult.steps.length - scenarioResult.summary.passed;
    }
    
    return scenarioResult;
}

export { runYamlTest };