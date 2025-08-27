# Linux Binaries

Linux용 실행 파일들을 이 디렉토리에 배치하세요.

## 실행 권한 설정
Linux에서는 실행 권한을 설정해야 합니다:

```bash
chmod +x your_binary_file
```

## 지원 파일 형식
- 컴파일된 바이너리 파일
- 스크립트 파일 (#!/bin/bash, #!/usr/bin/env node 등)

## 환경 요구사항
- 필요한 라이브러리가 시스템에 설치되어 있어야 합니다
- 의존성 확인: `ldd your_binary`

## 테스트 방법
```bash
# 테스트 스크립트 실행  
node scripts/test-binary.js your_binary

# 또는 API를 통해 실행
curl -X POST http://localhost:3001/api/run/your_job_name
```