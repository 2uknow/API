// scripts/test.js - 동적 포트로 테스트하는 스크립트
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

// 설정 파일에서 포트 읽기
function getPort() {
  try {
    const configPath = path.join(process.cwd(), 'config', 'settings.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.site_port || 3001;
  } catch {
    return 3001; // 기본값
  }
}

const port = getPort();
const baseUrl = `http://localhost:${port}`;

// 명령행 인자 확인
const command = process.argv[2];

function runCurl(url, options = '') {
  return new Promise((resolve, reject) => {
    const cmd = `curl ${options} ${url}`;
    console.log(`🚀 실행: ${cmd}`);
    
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ 에러: ${error.message}`);
        reject(error);
      } else {
        console.log(`✅ 결과:\n${stdout}`);
        if (stderr) console.warn(`⚠️  경고: ${stderr}`);
        resolve(stdout);
      }
    });
  });
}

async function main() {
  console.log(`📍 현재 포트: ${port}`);
  console.log(`🌐 베이스 URL: ${baseUrl}`);
  console.log(''); // 빈 줄

  switch (command) {
    case 'alert':
      await runCurl(`${baseUrl}/api/alert/test`, `-X POST -H "Content-Type: application/json" -d '{"type": "success"}'`);
      break;
    
    case 'error':
      await runCurl(`${baseUrl}/api/alert/test`, `-X POST -H "Content-Type: application/json" -d '{"type": "error"}'`);
      break;
    
    case 'urls':
      await runCurl(`${baseUrl}/api/debug/urls`);
      break;
    
    case 'health':
      await runCurl(`${baseUrl}/api/status/health`);
      break;
    
    case 'connection':
      await runCurl(`${baseUrl}/api/alert/test-connection`, `-X POST`);
      break;
    
    case 'config':
      await runCurl(`${baseUrl}/api/alert/config`);
      break;

    case 'all':
      console.log('🔍 전체 상태 확인 중...\n');
      try {
        await runCurl(`${baseUrl}/api/status/health`);
        console.log('\n---\n');
        await runCurl(`${baseUrl}/api/debug/urls`);
        console.log('\n---\n');
        await runCurl(`${baseUrl}/api/alert/config`);
      } catch (error) {
        console.error('전체 확인 중 에러 발생');
      }
      break;
    
    default:
      console.log(`사용법: node scripts/test.js <command>

📋 사용 가능한 명령어:
  alert      - 성공 알람 테스트
  error      - 실패 알람 테스트  
  urls       - URL 설정 확인
  health     - 시스템 상태 확인
  connection - 웹훅 연결 테스트
  config     - 알람 설정 확인
  all        - 전체 상태 확인

📍 현재 설정 포트: ${port}
🌐 베이스 URL: ${baseUrl}

예시:
  npm run test:alert
  npm run test:health
  node scripts/test.js all`);
  }
}

main().catch(console.error);