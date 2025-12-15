// Direct test of enhanced_chai_test.yaml to verify tooltip functionality
import { SClientYAMLParser } from './simple-yaml-parser.js';
import { SClientToNewmanConverter } from './newman-converter.js';
import fs from 'fs';

console.log('🚀 Direct test of enhanced_chai_test.yaml...');

try {
  // Step 1: Convert the actual enhanced_chai_test.yaml
  console.log('1️⃣ Converting enhanced_chai_test.yaml...');
  const result = await SClientYAMLParser.convertAndSave('./collections/enhanced_chai_test.yaml');
  console.log(`   ✅ Generated: ${result.jsonPath}`);
  
  // Step 2: Load the scenario
  const scenarioData = JSON.parse(fs.readFileSync(result.jsonPath, 'utf-8'));
  console.log(`   📋 Scenario: ${scenarioData.info?.name || 'Unnamed'}`);
  console.log(`   📦 Steps: ${scenarioData.requests?.length || 0}`);
  
  // Step 3: Check the first step's tests for tooltip data
  if (scenarioData.requests && scenarioData.requests.length > 0) {
    const firstStep = scenarioData.requests[0];
    console.log(`   🧪 Tests in first step: ${firstStep.tests?.length || 0}`);
    
    console.log('\n📊 Test Structure Analysis:');
    firstStep.tests?.slice(0, 5).forEach((test, index) => {
      console.log(`   ${index + 1}. Name: "${test.name}"`);
      console.log(`      Description: "${test.description || 'NO DESCRIPTION'}"`);
      console.log(`      Has tooltip data: ${test.description ? '✅' : '❌'}`);
    });
    
    // Step 4: Create a mock result and generate HTML
    console.log('\n2️⃣ Creating mock execution result...');
    const mockResult = {
      info: scenarioData.info,
      steps: [{
        name: firstStep.name,
        passed: true,
        tests: firstStep.tests.slice(0, 8).map(test => ({
          name: test.name,
          description: test.description || null,
          passed: true
        })),
        response: {
          stdout: "Result=0\\nServerInfo=ABCDEF123456\\nResponseTime=150\\n",
          duration: 150,
          exitCode: 0
        }
      }],
      summary: { passed: 8, failed: 0, total: 8 },
      startTime: Date.now() - 2000,
      endTime: Date.now()
    };
    
    console.log('3️⃣ Converting to Newman format...');
    const converter = new SClientToNewmanConverter();
    const newmanRun = converter.convertToNewmanRun(mockResult);
    
    console.log('4️⃣ Generating HTML report...');
    const htmlReport = converter.generateNewmanStyleHTML(newmanRun.collection, newmanRun.run);
    
    const reportPath = `./temp/enhanced_direct_test_${Date.now()}.html`;
    fs.writeFileSync(reportPath, htmlReport);
    
    console.log('5️⃣ HTML Analysis...');
    const tooltipCount = (htmlReport.match(/data-tooltip="/g) || []).length;
    const tooltipClassCount = (htmlReport.match(/class="[^"]*tooltip[^"]*"/g) || []).length;
    
    console.log(`\\n🎯 Final Report Analysis:`);
    console.log(`   📁 Generated: ${reportPath}`);
    console.log(`   🏷️  Tooltip attributes: ${tooltipCount}`);
    console.log(`   🎨 Tooltip CSS classes: ${tooltipClassCount}`);
    
    if (tooltipCount > 0) {
      console.log('   ✅ SUCCESS: Tooltips are working correctly!');
      console.log(`   💡 The issue was that the server needs to restart to load new code`);
    } else {
      console.log('   ❌ ISSUE: No tooltips found');
    }
    
    // Show a sample of the HTML assertion structure
    console.log('\\n🔍 Sample HTML structure:');
    const assertionMatch = htmlReport.match(/<div class="assertion[^>]*tooltip[^>]*data-tooltip="[^"]*"[^>]*>.*?<\/div>/);
    if (assertionMatch) {
      console.log('   ', assertionMatch[0].substring(0, 150) + '...');
    }
    
  } else {
    console.log('   ❌ No test steps found in scenario');
  }
  
} catch (error) {
  console.error('❌ Direct test failed:', error.message);
  console.error('Stack trace:', error.stack);
}