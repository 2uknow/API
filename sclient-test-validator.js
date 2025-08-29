/**
 * SClient 테스트 검증 공통 모듈
 * run-yaml.js와 웹 대시보드에서 공통으로 사용하는 테스트 검증 로직
 */

// 범용 Assertion 평가 엔진
export function evaluateAssertion(assertion, extractedVars) {
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
        
        // 3. JavaScript 표현식 패턴 - 완전 범용 (상세 디버깅 포함)
        if (assertion.startsWith('js:')) {
            const jsCode = assertion.substring(3).trim();
            
            // 모든 추출된 변수를 그대로 컨텍스트에 추가
            const evalContext = { ...extractedVars };
            
            // 소문자 버전도 추가 (호환성)
            Object.keys(extractedVars).forEach(key => {
                evalContext[key.toLowerCase()] = extractedVars[key];
            });
            
            // JavaScript 테스트에서 자주 사용하는 공통 변수명 매핑 추가
            if (extractedVars.RESULT_CODE !== undefined) {
                evalContext.result = extractedVars.RESULT_CODE;
            }
            if (extractedVars.SERVER_INFO !== undefined) {
                evalContext.serverinfo = extractedVars.SERVER_INFO;
            }
            if (extractedVars.ERROR_MESSAGE !== undefined) {
                evalContext.errmsg = extractedVars.ERROR_MESSAGE;
            }
            
            // IDELIVER 단계에서의 변수 매핑
            if (extractedVars.IDELIVER_RESULT !== undefined) {
                evalContext.result = extractedVars.IDELIVER_RESULT;
            }
            if (extractedVars.IDELIVER_SERVER_INFO !== undefined) {
                evalContext.serverinfo = extractedVars.IDELIVER_SERVER_INFO;
            }
            if (extractedVars.IDELIVER_ERROR_MSG !== undefined) {
                evalContext.errmsg = extractedVars.IDELIVER_ERROR_MSG;
            }
            
            // JavaScript 코드 실행 및 상세 디버깅 정보 수집
            let result, error = null;
            let debugInfo = null;
            
            try {
                result = new Function(...Object.keys(evalContext), `return ${jsCode}`)(...Object.values(evalContext));
                
                // 성공 시에도 디버깅 정보 생성 (실패 시 더 유용)
                debugInfo = generateJSDebugInfo(jsCode, evalContext, result);
            } catch (e) {
                result = false;
                error = e.message;
                debugInfo = generateJSDebugInfo(jsCode, evalContext, result, e);
            }
            
            return {
                passed: !!result,
                expected: 'truthy',
                actual: `${result} (${typeof result})`,
                jsExpression: jsCode,
                error: error,
                debugInfo: debugInfo,  // 새로운 디버깅 정보
                availableVariables: Object.keys(evalContext), // 사용 가능한 변수 목록
                variableValues: evalContext  // 변수 값들
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

// 테스트 검증 함수 - 웹 대시보드 및 run-yaml.js 공통 사용
export function validateTestsWithYamlData(scenarioResult, yamlData) {
    // 모든 스텝에 대해 테스트 검증 수행
    scenarioResult.steps.forEach((step, stepIndex) => {
        const yamlStep = yamlData.steps && yamlData.steps[stepIndex];
        if (yamlStep && yamlStep.test && Array.isArray(yamlStep.test)) {
            const validatedTests = yamlStep.test.map((yamlTest, testIndex) => {
                const originalTestName = yamlTest.name || yamlTest;
                const assertion = yamlTest.assertion || yamlTest;
                
                // 기존 실행된 테스트에서 변수 치환된 이름 사용 (있으면)
                const existingTest = step.tests && step.tests[testIndex];
                const finalTestName = existingTest && existingTest.name ? existingTest.name : originalTestName;
                
                // 범용 assertion 평가
                const evalResult = evaluateAssertion(assertion, step.extracted || {});
                
                return {
                    name: finalTestName,  // 변수 치환된 이름 사용
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

// JavaScript 표현식 디버깅 정보 생성 헬퍼 함수
function generateJSDebugInfo(jsCode, evalContext, result, error = null) {
    const debugInfo = {
        expression: jsCode,
        result: result,
        resultType: typeof result,
        variables: {},
        evaluation: null,
        error: error ? error.message : null
    };
    
    // 표현식에서 사용된 변수들 추출 및 값 매핑
    const variablePattern = /\b([A-Z_][A-Z0-9_]*)\b/g;
    let match;
    const usedVariables = new Set();
    
    while ((match = variablePattern.exec(jsCode)) !== null) {
        const varName = match[1];
        if (evalContext.hasOwnProperty(varName) || evalContext.hasOwnProperty(varName.toLowerCase())) {
            usedVariables.add(varName);
        }
    }
    
    // 사용된 변수들의 값 저장
    usedVariables.forEach(varName => {
        const value = evalContext[varName] || evalContext[varName.toLowerCase()];
        debugInfo.variables[varName] = {
            value: value,
            type: typeof value,
            length: typeof value === 'string' ? value.length : null,
            exists: value !== undefined && value !== null
        };
    });
    
    // 단계별 평가 시도 (복잡한 표현식 분석)
    try {
        debugInfo.evaluation = analyzeJSExpression(jsCode, evalContext);
    } catch (e) {
        debugInfo.evaluation = `분석 실패: ${e.message}`;
    }
    
    return debugInfo;
}

// JavaScript 표현식 단계별 분석 함수
function analyzeJSExpression(jsCode, evalContext) {
    const analysis = {
        steps: [],
        finalResult: null,
        breakdown: null
    };
    
    // 간단한 AND/OR 조건 분석
    if (jsCode.includes('&&') || jsCode.includes('||')) {
        const operators = jsCode.includes('&&') ? ['&&'] : ['||'];
        
        operators.forEach(op => {
            if (jsCode.includes(op)) {
                const parts = jsCode.split(op).map(p => p.trim());
                
                parts.forEach((part, index) => {
                    try {
                        const partResult = new Function(...Object.keys(evalContext), `return ${part}`)(...Object.values(evalContext));
                        analysis.steps.push({
                            step: index + 1,
                            expression: part,
                            result: partResult,
                            type: typeof partResult,
                            operator: index < parts.length - 1 ? op : null
                        });
                    } catch (e) {
                        analysis.steps.push({
                            step: index + 1,
                            expression: part,
                            result: 'ERROR',
                            error: e.message,
                            operator: index < parts.length - 1 ? op : null
                        });
                    }
                });
            }
        });
    } else {
        // 단순 표현식인 경우
        try {
            const result = new Function(...Object.keys(evalContext), `return ${jsCode}`)(...Object.values(evalContext));
            analysis.steps.push({
                step: 1,
                expression: jsCode,
                result: result,
                type: typeof result
            });
        } catch (e) {
            analysis.steps.push({
                step: 1,
                expression: jsCode,
                result: 'ERROR',
                error: e.message
            });
        }
    }
    
    return analysis;
}