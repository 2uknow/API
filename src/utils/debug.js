// src/utils/debug.js — 디버그/배치 로그 및 패턴 매칭 유틸리티
import fs from 'fs';
import path from 'path';
import { logsDir } from './config.js';

// 디버깅용 로그 함수
export function debugLog(message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = data ? `[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}` : `[${timestamp}] ${message}`;
  
  console.log(logEntry);
  
  // 디버그 로그 파일에도 기록
  const debugLogPath = path.join(logsDir, `debug_batch_${new Date().toISOString().split('T')[0]}.log`);
  try {
    fs.appendFileSync(debugLogPath, logEntry + '\n');
  } catch (err) {
    console.error('Debug log write failed:', err);
  }
}

// 배치 전용 로그 함수 (콘솔 + 파일 동시 기록)
export function batchLog(message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = data ? `[${timestamp}] ${message}: ${JSON.stringify(data, null, 2)}` : `[${timestamp}] ${message}`;
  
  // 콘솔 출력
  console.log(logEntry);
  
  // 배치 전용 로그 파일에 기록
  const batchLogPath = path.join(logsDir, `batch_execution_${new Date().toISOString().split('T')[0]}.log`);
  try {
    fs.appendFileSync(batchLogPath, logEntry + '\n');
  } catch (err) {
    console.error('Batch log write failed:', err);
  }
}

// 간단한 패턴 매칭 함수 (glob-like)
export function matchPattern(str, pattern) {
  // 특수 문자들을 정규표현식용으로 escape
  let regexPattern = pattern
    .replace(/\./g, '\\.')  // . -> \.
    .replace(/\*/g, '.*')   // * -> .*
    .replace(/\?/g, '.')    // ? -> .
    .replace(/\*\*/g, '.*'); // ** -> .*
    
  // 패턴이 파일명의 어느 부분에나 매치되도록
  const regex = new RegExp(regexPattern, 'i'); // case insensitive
  
  const isMatch = regex.test(str);
  
  return isMatch;
}
