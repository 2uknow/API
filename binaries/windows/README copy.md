# Binary Files Directory

이 디렉토리는 API 모니터링 시스템에서 실행할 바이너리 파일들을 저장하는 곳입니다.

## 구조

```
binaries/
├── windows/          # Windows용 실행 파일들
│   ├── *.exe
│   └── *.bat
├── linux/            # Linux용 실행 파일들
│   └── (executable files)
└── README.md         # 이 파일
```

## 사용법

1. **Windows 바이너리**: `binaries/windows/` 디렉토리에 `.exe` 또는 `.bat` 파일 배치
2. **Linux 바이너리**: `binaries/linux/` 디렉토리에 실행 파일 배치
3. **Job 파일**: `jobs/` 디렉토리에 바이너리 실행 설정 파일 생성

## Job 파일 예시

```json
{
  "name": "my_binary_test",
  "type": "binary",
  "platforms": {
    "win32": {
      "executable": "my_app.exe",
      "arguments": ["--test", "--verbose"]
    },
    "linux": {
      "executable": "my_app",
      "arguments": ["--test", "--verbose"]
    }
  },
  "timeout": 30000,
  "parseOutput": {
    "successPattern": "SUCCESS|PASSED|OK",
    "failurePattern": "FAIL|ERROR|EXCEPTION"
  }
}
```

## 환경변수 설정

`.env` 파일에서 바이너리 경로를 직접 지정할 수 있습니다:

```bash
BINARY_PATH=D:\custom\binary\path
```

## 보안 주의사항

- 바이너리 파일은 신뢰할 수 있는 소스에서만 가져오세요
- 실행 권한을 적절히 설정하세요
- 민감한 정보를 포함한 바이너리는 별도로 관리하세요