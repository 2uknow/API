#!/usr/bin/env node

/**
 * skip_if 기능 HTML 리포트 생성 테스트
 * TEST_SKIP_IF_FORCE.yaml과 TEST_SKIP_IF_EXAMPLES.yaml를 실행하고 HTML 리포트를 생성
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { SClientYAMLParser } from '../src/engine/simple-yaml-parser.js';
import { SClientScenarioEngine } from '../src/engine/sclient-engine.js';
import { validateTestsWithYamlData } from '../src/engine/sclient-test-validator.js';
import { SClientToNewmanConverter } from '../src/engine/newman-converter.js';

async function generateSkipReport(yamlFilePath) {
    const fileName = path.basename(yamlFilePath, '.yaml');
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📄 ${fileName} 실행 및 리포트 생성`);
    console.log(`${'='.repeat(80)}`);

    // 1. YAML 파일 읽기 및 파싱
    const yamlContent = fs.readFileSync(yamlFilePath, 'utf8');
    const yamlData = yaml.load(yamlContent);
    const scenario = SClientYAMLParser.parseYamlToScenario(yamlContent);

    // 2. 임시 시나리오 파일 생성
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `temp_skip_test_${Date.now()}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(scenario, null, 2), 'utf-8');

    // 3. SClient 실행
    const engine = new SClientScenarioEngine();
    const results = await engine.runScenario(tempPath);

    // 4. 임시 파일 정리
    try { fs.unlinkSync(tempPath); } catch (e) {}

    // 5. 공통 테스트 검증
    const validatedResults = validateTestsWithYamlData(results, yamlData);

    // 6. 결과 요약 출력
    console.log(`\n📊 결과 요약:`);
    if (validatedResults.steps) {
        validatedResults.steps.forEach((step, i) => {
            const skippedTag = step.skipped ? ' [STEP SKIPPED]' : '';
            const skipActionTag = step.skipAction ? ` [${step.skipAction}]` : '';
            console.log(`  Step ${i + 1}: ${step.name}${skippedTag}${skipActionTag}`);
            if (step.tests && step.tests.length > 0) {
                step.tests.forEach(t => {
                    const tag = t.skipped ? '⏭️ SKIP' : (t.passed ? '✅ PASS' : '❌ FAIL');
                    console.log(`    ${tag} ${t.name}`);
                });
            }
        });
    }

    // 7. Newman 변환 및 HTML 리포트 생성
    const converter = new SClientToNewmanConverter();
    const newmanRun = converter.convertToNewmanRun(validatedResults);

    console.log(`\n📈 Newman 변환 결과:`);
    console.log(`  Requests: total=${newmanRun.run.stats.requests.total}, failed=${newmanRun.run.stats.requests.failed}`);
    console.log(`  Assertions: total=${newmanRun.run.stats.assertions.total}, failed=${newmanRun.run.stats.assertions.failed}`);
    console.log(`  Executions: ${(newmanRun.run.executions || []).length}개`);

    // 8. HTML 리포트 생성
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const stamp = kst.toISOString().replace(/T/, '_').replace(/:/g, '_').substring(0, 19);
    const reportPath = path.join(reportsDir, `${fileName}_${stamp}.html`);

    const htmlContent = converter.generateNewmanStyleHTML(newmanRun.run, reportPath, {
        title: `${fileName} skip_if Test Report`,
        browserTitle: `${fileName} Report`
    });

    if (typeof htmlContent === 'string') {
        fs.writeFileSync(reportPath, htmlContent);
    }

    console.log(`\n✅ HTML 리포트 생성 완료: ${reportPath}`);
    return reportPath;
}

async function main() {
    const yamlFiles = [
        'collections/Danal_Teledit_Cancel_D_v1.0/TEST_SKIP_IF_FORCE.yaml',
        'collections/Danal_Teledit_Cancel_D_v1.0/TEST_SKIP_IF_EXAMPLES.yaml'
    ];

    const reports = [];
    for (const yamlFile of yamlFiles) {
        try {
            const reportPath = await generateSkipReport(yamlFile);
            reports.push(reportPath);
        } catch (error) {
            console.error(`❌ ${yamlFile} 실행 실패:`, error.message);
        }
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🎯 생성된 리포트 파일:`);
    reports.forEach(r => console.log(`  📄 ${r}`));
    console.log(`${'='.repeat(80)}`);

    process.exit(0);
}

main().catch(error => {
    console.error('실행 중 오류:', error);
    process.exit(1);
});
