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
import { validateTestsWithYamlData } from './sclient-test-validator.js';

/**
 * JavaScript 조건식을 분석하여 각 조건의 평가 결과를 반환
 * @param {string} expression JavaScript 표현식
 * @param {Object} variables 사용 가능한 변수들
 * @returns {Array} 조건별 분석 결과
 */
function analyzeJavaScriptConditions(expression, variables = {}) {
    try {
        const results = [];
        
        // && 또는 || 연산자로 분리된 조건들 찾기
        const conditions = parseConditions(expression);
        
        if (conditions.length <= 1) {
            // 단일 조건인 경우 전체 표현식 평가
            const result = evaluateExpression(expression, variables);
            const details = getVariableDetails(expression, variables);
            return [{
                expression: expression,
                result: result,
                details: details
            }];
        }
        
        // 각 조건별로 평가
        for (const condition of conditions) {
            const result = evaluateExpression(condition.expression, variables);
            const details = getVariableDetails(condition.expression, variables);
            
            results.push({
                expression: condition.expression,
                result: result,
                details: details,
                operator: condition.operator
            });
        }
        
        return results;
        
    } catch (error) {
        console.log(`      ❌ Analysis Error: ${error.message}`);
        return [];
    }
}

/**
 * JavaScript 표현식을 && 또는 || 연산자로 분리
 */
function parseConditions(expression) {
    const conditions = [];
    const operators = ['&&', '||'];
    
    // 간단한 파싱 - 괄호를 고려하지 않은 기본 분리
    let current = expression;
    let lastOperator = null;
    
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
function evaluateExpression(expression, variables) {
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
 * 표현식에서 사용된 변수들의 상세 정보 생성
 */
function getVariableDetails(expression, variables) {
    const details = [];
    
    // 변수명 추출 (간단한 패턴 매칭)
    const varMatches = expression.match(/[A-Z_][A-Z0-9_]*/g) || [];
    const uniqueVars = [...new Set(varMatches)];
    
    for (const varName of uniqueVars) {
        if (variables.hasOwnProperty(varName)) {
            const value = variables[varName];
            const type = typeof value;
            details.push(`(${varName} = "${value}")`);
        }
    }
    
    return details.length > 0 ? details.join(' ') : '';
}

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
        
        // 4. 공통 테스트 검증 모듈 사용
        const validatedResults = validateTestsWithYamlData(results, yamlData);
        
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
                        
                        // JavaScript 표현식 실패 시 상세 디버깅 정보
                        if (test.assertion && test.assertion.startsWith('js:') && test.debugInfo) {
                            console.log(`    ━━━ JavaScript Debug Info ━━━`);
                            console.log(`    Expression: ${test.debugInfo.expression}`);
                            console.log(`    Result: ${test.debugInfo.result} (${test.debugInfo.resultType})`);
                            
                            if (test.debugInfo.variables && Object.keys(test.debugInfo.variables).length > 0) {
                                console.log(`    Variables:`);
                                Object.entries(test.debugInfo.variables).forEach(([name, info]) => {
                                    console.log(`      ${name} = "${info.value}" (${info.type}, exists: ${info.exists})`);
                                });
                            }
                            
                            if (test.debugInfo.evaluation && test.debugInfo.evaluation.steps) {
                                console.log(`    Steps:`);
                                test.debugInfo.evaluation.steps.forEach((step, index) => {
                                    const result = step.error ? `ERROR: ${step.error}` : `${step.result}`;
                                    console.log(`      ${index + 1}. ${step.expression} → ${result}`);
                                });
                            }
                        }
                        // JavaScript 조건별 상세 분석 (debugInfo 없을 때)
                        else if (test.assertion && test.assertion.startsWith('js:')) {
                            const jsExpression = test.assertion.substring(3).trim();
                            console.log(`    JavaScript Expression: ${jsExpression}`);
                            
                            // 조건별 분석 수행
                            const conditionAnalysis = analyzeJavaScriptConditions(jsExpression, step.extracted || {});
                            if (conditionAnalysis && conditionAnalysis.length > 0) {
                                console.log(`    Condition Analysis:`);
                                conditionAnalysis.forEach(condition => {
                                    const status = condition.result ? '✅' : '❌';
                                    console.log(`      ${status} ${condition.expression} → ${condition.result} ${condition.details ? condition.details : ''}`);
                                });
                                console.log(`    Overall Result: ${test.actual || 'false'}`);
                            }
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


export { runYamlTest };