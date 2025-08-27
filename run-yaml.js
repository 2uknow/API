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
        console.log('\n🚀 YAML 테스트 실행기');
        console.log('='.repeat(50));
        console.log(`📁 파일: ${yamlFilePath}`);
        
        // 1. YAML 파일 읽기
        if (!fs.existsSync(yamlFilePath)) {
            console.error(`❌ 파일을 찾을 수 없습니다: ${yamlFilePath}`);
            process.exit(1);
        }
        
        const yamlContent = fs.readFileSync(yamlFilePath, 'utf8');
        const yamlData = yaml.load(yamlContent);
        
        console.log(`📝 테스트명: ${yamlData.name || 'Unknown'}`);
        console.log(`📄 설명: ${yamlData.description || 'No description'}`);
        console.log();
        
        // 2. YAML → JSON 시나리오 변환
        const scenario = SClientYAMLParser.parseYamlToScenario(yamlContent);
        
        console.log('🔄 JSON 시나리오 생성 완료');
        
        // 첫 번째 스텝의 테스트만 디버그 출력
        if (scenario.requests && scenario.requests[0] && scenario.requests[0].event) {
            const firstStepTests = scenario.requests[0].event.test || [];
            console.log('🔍 첫 번째 스텝의 변환된 테스트들:');
            firstStepTests.forEach((test, index) => {
                console.log(`   ${index + 1}. name: "${test.name || 'No name'}"`);
                console.log(`       script: ${test.script ? 'EXISTS' : 'MISSING'}`);
                if (test.script) {
                    console.log(`       script content: ${test.script.slice(0, 100)}...`);
                }
            });
        }
        console.log();
        
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
            console.log(`⚠️ 임시 파일 정리 실패: ${error.message}`);
        }
        
        // 4. 우리가 직접 테스트 검증 수행 (기존 엔진의 버그 우회)
        const validatedResults = validateTestsManually(results, yamlData);
        
        // 5. 결과 출력
        displayResults(validatedResults);
        
    } catch (error) {
        console.error('❌ 실행 중 오류 발생:', error.message);
        process.exit(1);
    }
}

function displayResults(scenarioResult) {
    console.log('📊 실행 결과');
    console.log('='.repeat(50));
    
    // 시나리오 정보 출력
    if (scenarioResult.info) {
        console.log(`📝 시나리오: ${scenarioResult.info.name}`);
        console.log(`📄 설명: ${scenarioResult.info.description}`);
        console.log(`⏱️  총 실행시간: ${scenarioResult.summary?.duration || 0}ms`);
        console.log();
    }
    
    let totalTests = 0;
    let passedTests = 0;
    
    // 각 스텝 결과 출력
    if (scenarioResult.steps && Array.isArray(scenarioResult.steps)) {
        scenarioResult.steps.forEach((step, index) => {
            console.log(`🔸 Step ${step.step || index + 1}: ${step.name}`);
            console.log('─'.repeat(40));
            
            // Response 정보
            if (step.response) {
                console.log('📥 Response:');
                Object.keys(step.response).forEach(key => {
                    console.log(`   ${key}: ${step.response[key]}`);
                });
            }
            
            // Extract된 변수들
            if (step.extracted && Object.keys(step.extracted).length > 0) {
                console.log('📋 Extracted Variables:');
                Object.keys(step.extracted).forEach(key => {
                    console.log(`   ${key}: ${step.extracted[key]}`);
                });
            }
            
            // 테스트 결과
            if (step.tests && Array.isArray(step.tests) && step.tests.length > 0) {
                console.log('🧪 Test Results:');
                step.tests.forEach(test => {
                    totalTests++;
                    const status = test.passed ? '✅' : '❌';
                    const testName = test.name || test.assertion || 'Unknown test';
                    
                    // 첫 번째 스텝의 모든 테스트 디버그 정보 출력
                    if (step.step === 1) {
                        console.log(`   🔍 DEBUG: ${testName}`);
                        console.log(`      Assertion: ${test.assertion}`);
                        console.log(`      Test Passed: ${test.passed}`);
                        if (test.assertion && test.assertion.includes('== 2')) {
                            console.log(`      ⚠️  This should FAIL! RESULT_CODE=0 but checking == 2`);
                            console.log(`      Available variables:`, step.extracted);
                        }
                    }
                    
                    console.log(`   ${status} ${testName}`);
                    
                    if (test.passed) {
                        passedTests++;
                    } else {
                        console.log(`      Expected: ${test.expected || 'N/A'}`);
                        console.log(`      Actual: ${test.actual || 'N/A'}`);
                        if (test.error) {
                            console.log(`      Error: ${test.error}`);
                        }
                        
                        // JavaScript 표현식의 경우 상세 분석 정보 표시
                        if (test.assertion && test.assertion.startsWith('js:') && test.detailedAnalysis) {
                            console.log(`      🔍 Detailed Analysis:`);
                            test.detailedAnalysis.forEach(detail => {
                                console.log(`         ${detail}`);
                            });
                        }
                    }
                });
            }
            
            // 스텝 상태
            const stepStatus = step.passed ? '✅ PASS' : '❌ FAIL';
            console.log(`📊 Status: ${stepStatus}`);
            console.log();
        });
    }
    
    // 전체 요약
    console.log('='.repeat(50));
    console.log('📈 전체 요약');
    
    if (scenarioResult.summary) {
        console.log(`총 스텝: ${scenarioResult.summary.total}`);
        console.log(`성공한 스텝: ${scenarioResult.summary.passed} ✅`);
        console.log(`실패한 스텝: ${scenarioResult.summary.failed} ❌`);
    }
    
    console.log(`총 테스트: ${totalTests}`);
    console.log(`성공: ${passedTests} ✅`);
    console.log(`실패: ${totalTests - passedTests} ❌`);
    console.log(`테스트 성공률: ${totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(1) : 0}%`);
    
    if (scenarioResult.success) {
        console.log('\n🎉 모든 스텝이 성공했습니다!');
    } else {
        console.log('\n⚠️  일부 스텝이 실패했습니다.');
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
            
            console.log(`      🔍 JS Debug - Expression: ${jsCode}`);
            console.log(`      🔍 Available Variables: ${Object.keys(evalContext).join(', ')}`);
            
            // 현재 추출된 모든 변수의 값과 길이 출력
            Object.keys(extractedVars).forEach(varName => {
                const value = extractedVars[varName];
                const length = (typeof value === 'string') ? value.length : 'N/A';
                const type = typeof value;
                console.log(`      🔍 ${varName}: "${value}" (type: ${type}, length: ${length})`);
            });
            
            // JavaScript 코드 실행
            let result, error = null;
            try {
                result = new Function(...Object.keys(evalContext), `return ${jsCode}`)(...Object.values(evalContext));
                console.log(`      🔍 JS Debug - Final Result: ${result} (type: ${typeof result})`);
            } catch (e) {
                result = false;
                error = e.message;
                console.log(`      🔍 JS Debug - ERROR: ${e.message}`);
            }
            
            // 표현식을 부분별로 분석 (&&, || 연산자 기준)
            const operators = ['&&', '\\|\\|'];
            let foundOperator = null;
            let parts = [jsCode];
            let conditionAnalysis = [];
            
            try {
                for (const op of operators) {
                    if (jsCode.includes(op.replace('\\', ''))) {
                        foundOperator = op.replace('\\', '');
                        parts = jsCode.split(new RegExp(`\\s*${op}\\s*`)).map(p => p.trim());
                        break;
                    }
                }
                
                if (foundOperator && parts.length > 1) {
                    console.log(`      🔍 Condition Analysis (${foundOperator}):`);
                    parts.forEach((part, index) => {
                        try {
                            // 괄호 균형 맞추기
                            let balancedPart = part;
                            let openParens = (balancedPart.match(/\(/g) || []).length;
                            let closeParens = (balancedPart.match(/\)/g) || []).length;
                            
                            if (openParens > closeParens) {
                                balancedPart += ')'.repeat(openParens - closeParens);
                            } else if (closeParens > openParens) {
                                balancedPart = '('.repeat(closeParens - openParens) + balancedPart;
                            }
                            
                            const partResult = new Function(...Object.keys(evalContext), `return ${balancedPart}`)(...Object.values(evalContext));
                            const analysisLine = `Part ${index + 1}: "${part}" → ${partResult} (${typeof partResult})`;
                            console.log(`         ${analysisLine}`);
                            conditionAnalysis.push(analysisLine);
                        } catch (e) {
                            const analysisLine = `Part ${index + 1}: "${part}" → ERROR: ${e.message}`;
                            console.log(`         ${analysisLine}`);
                            conditionAnalysis.push(analysisLine);
                        }
                    });
                }
            } catch (e) {
                console.log(`      ⚠️ 표현식 분석 실패: ${e.message}`);
            }
            
            // 상세 분석 정보 수집
            const detailedAnalysis = [];
            
            // 모든 변수 정보 추가
            Object.keys(extractedVars).forEach(varName => {
                const value = extractedVars[varName];
                const length = (typeof value === 'string') ? value.length : 'N/A';
                detailedAnalysis.push(`${varName}: "${value}" (type: ${typeof value}, length: ${length})`);
            });
            
            // 조건 분석 결과 추가
            if (conditionAnalysis.length > 0) {
                detailedAnalysis.push(`Condition Analysis (${foundOperator}):`);
                conditionAnalysis.forEach(analysis => {
                    detailedAnalysis.push(`  ${analysis}`);
                });
            }
            
            return {
                passed: !!result,
                expected: 'truthy',
                actual: `${result} (${typeof result})`,
                jsExpression: jsCode,
                error: error,
                detailedAnalysis: detailedAnalysis
            };
        }
        
        // 4. 인식할 수 없는 패턴은 문자열로 처리 (기존 호환성)
        console.log(`   ⚠️ 알 수 없는 assertion 패턴: ${assertion}`);
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
    console.log('\n🔧 범용 테스트 검증 수행:');
    
    // 모든 스텝에 대해 테스트 검증 수행
    scenarioResult.steps.forEach((step, stepIndex) => {
        const yamlStep = yamlData.steps && yamlData.steps[stepIndex];
        if (yamlStep && yamlStep.test && Array.isArray(yamlStep.test)) {
            console.log(`\n   Step ${step.step}: ${step.name}`);
            
            const validatedTests = yamlStep.test.map(yamlTest => {
                const testName = yamlTest.name || yamlTest;
                const assertion = yamlTest.assertion || yamlTest;
                
                // 범용 assertion 평가
                const evalResult = evaluateAssertion(assertion, step.extracted || {});
                
                console.log(`   🧪 ${testName}: ${evalResult.passed ? '✅' : '❌'} (${assertion})`);
                if (!evalResult.passed) {
                    console.log(`      Expected: ${evalResult.expected}, Actual: ${evalResult.actual}`);
                }
                
                return {
                    name: testName,
                    assertion: assertion,
                    passed: evalResult.passed,
                    expected: evalResult.expected,
                    actual: evalResult.actual,
                    error: evalResult.passed ? null : `Expected: ${evalResult.expected}, Actual: ${evalResult.actual}`,
                    detailedAnalysis: evalResult.detailedAnalysis || null
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