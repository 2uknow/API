# Windows Binaries

Windows용 실행 파일들을 이 디렉토리에 배치하세요.

## 지원 파일 형식
- `.exe` - Windows 실행 파일
- `.bat` - 배치 스크립트
- `.cmd` - 명령 스크립트

## 실행 권한
Windows에서는 별도의 실행 권한 설정이 필요하지 않습니다.

## 테스트 방법
```bash
# 테스트 스크립트 실행
node scripts/test-binary.js your_binary.exe

# 또는 API를 통해 실행
curl -X POST http://localhost:3001/api/run/your_job_name
```