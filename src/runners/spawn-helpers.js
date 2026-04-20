// src/runners/spawn-helpers.js
// 프로세스 spawn 헬퍼 (spawnNewmanCLI, getBinaryPath, spawnBinaryCLI)
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { root, readCfg } from '../utils/config.js';

function spawnNewmanCLI(args) {
  let cmd, argv;
  if (process.platform === 'win32') {
    cmd = 'cmd.exe';
    argv = ['/d', '/s', '/c', 'npx', ...args];
  } else {
    cmd = '/bin/sh';
    argv = ['-lc', ['npx', ...args].join(' ')];
  }
  console.log('[SPAWN]', cmd, argv);
  return spawn(cmd, argv, { cwd: root, windowsHide: true });
}

// 바이너리 경로 확인 함수
function getBinaryPath(jobConfig) {
  const platform = process.platform;

  // 1. 환경변수 우선 사용
  if (process.env.BINARY_PATH) {
    const execName = platform === 'win32'
      ? jobConfig.executable
      : jobConfig.executable.replace('.exe', '');
    return path.join(process.env.BINARY_PATH, execName);
  }

  // 2. 플랫폼별 설정에서 가져오기
  const config = readCfg();
  const binaryConfig = config.binary_base_path || {};

  let basePath;
  if (jobConfig.platforms && jobConfig.platforms[platform]) {
    const platformConfig = jobConfig.platforms[platform];
    basePath = platformConfig.path || binaryConfig[platform] || binaryConfig.default || './binaries';
    return path.resolve(root, basePath, platformConfig.executable);
  } else {
    basePath = binaryConfig[platform] || binaryConfig.default || './binaries';
    const execName = platform === 'win32'
      ? jobConfig.executable
      : jobConfig.executable.replace('.exe', '');
    return path.resolve(root, basePath, execName);
  }
}

// 바이너리 실행 함수
function spawnBinaryCLI(binaryPath, args = [], options = {}) {
  const platform = process.platform;
  let cmd, argv;

  if (platform === 'win32') {
    if (binaryPath.endsWith('.exe') || binaryPath.endsWith('.bat')) {
      cmd = binaryPath;
      argv = args;
    } else {
      cmd = 'cmd.exe';
      argv = ['/d', '/s', '/c', binaryPath, ...args];
    }
  } else {
    cmd = binaryPath;
    argv = args;
  }

  console.log('[BINARY SPAWN]', cmd, argv);
  return spawn(cmd, argv, {
    cwd: options.cwd || root,
    windowsHide: true,
    ...options
  });
}

export { spawnNewmanCLI, getBinaryPath, spawnBinaryCLI };
