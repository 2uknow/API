#!/usr/bin/env node

import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

// 설정 파일 읽기
function readConfig() {
  try {
    const configPath = path.join(process.cwd(), 'config', 'settings.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config;
  } catch (error) {
    console.error('설정 파일을 읽을 수 없습니다:', error.message);
    return { site_port: 3000 };
  }
}

function main() {
  const config = readConfig();
  const { site_port = 3000 } = config;
  
  const dockerCommand = `docker run -p ${site_port}:${site_port} -v $(pwd)/config:/app/config -v $(pwd)/reports:/app/reports danal-api-monitor`;
  
  console.log(`포트: ${site_port}`);
  console.log(`Docker 명령: ${dockerCommand}`);
  console.log('');
  
  try {
    execSync(dockerCommand, { stdio: 'inherit' });
  } catch (error) {
    console.error('Docker 실행 실패:', error.message);
    process.exit(1);
  }
}

main();