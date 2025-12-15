# 신규 설치 가이드

아무것도 설치되지 않은 Windows 컴퓨터에서 2uknow API Monitor를 처음 구동하기 위한 완전한 가이드입니다.

---

## 📋 체크리스트

설치 전 확인사항:

- [ ] Windows 10/11 또는 Windows Server 2016+
- [ ] 관리자 권한으로 설치 가능
- [ ] 인터넷 연결 상태 양호
- [ ] 포트 3001 사용 가능 (방화벽 확인)

---

## 1단계: Node.js 설치

### 1.1 Node.js 다운로드

1. https://nodejs.org/ 접속
2. **LTS 버전** 다운로드 (v18 이상 권장, v22 최신)
3. 다운로드된 `.msi` 파일 실행

### 1.2 설치 옵션

설치 중 다음 옵션 확인:
- ✅ **Add to PATH** (필수)
- ✅ **npm package manager** (필수)
- ⬜ Automatically install necessary tools (선택, 체크 안해도 됨)

### 1.3 설치 확인

**새 CMD 또는 PowerShell 창 열고** 실행:

```bash
node --version
# 출력 예: v22.15.0

npm --version
# 출력 예: 10.x.x
```

⚠️ **주의**: 기존 CMD 창에서는 PATH가 반영 안됨. 반드시 새 창에서 확인!

---

## 2단계: PM2 설치 (전역)

```bash
npm install -g pm2
```

### 설치 확인

```bash
pm2 --version
# 출력 예: 5.x.x
```

### Windows 서비스 등록 (재부팅 후 자동 시작)

```bash
# PM2 startup 설정 (관리자 권한 필요할 수 있음)
pm2 startup
```

출력된 명령어를 **관리자 권한 PowerShell**에서 실행하세요.

---

## 3단계: 프로젝트 다운로드

### 방법 A: Git 사용 (권장)

```bash
# Git이 없으면 먼저 설치: https://git-scm.com/download/win

cd D:\API
git clone https://github.com/danal-rnd/danal-external-api-monitor.git 2uknow-api-monitor
cd 2uknow-api-monitor
```

### 방법 B: ZIP 다운로드

1. GitHub에서 ZIP 파일 다운로드
2. `D:\API\2uknow-api-monitor` 폴더에 압축 해제

---

## 4단계: 의존성 설치

```bash
cd D:\API\2uknow-api-monitor

# 프로젝트 의존성 설치
npm install

# Newman 리포터 설치
npm run install-reporters
```

### 설치 확인

```bash
npm list newman
# 출력: newman@6.x.x

npm list newman-reporter-htmlextra
# 출력: newman-reporter-htmlextra@1.x.x
```

---

## 5단계: 설정 파일 확인

### 5.1 기본 설정 파일 생성

```bash
# 필요한 디렉토리 및 기본 설정 생성
npm run setup
```

### 5.2 설정 파일 확인/수정

`config/settings.json` 파일 확인:

```json
{
  "site_port": 3001,
  "webhook_url": "https://talk.worksmobile.com/webhook/...",
  "run_event_alert": true,
  "alert_on_start": true,
  "alert_on_success": true,
  "alert_on_error": true,
  "alert_method": "flex",
  "timezone": "Asia/Seoul",
  "history_keep": 500,
  "report_keep_days": 30
}
```

**필수 수정 항목**:
- `webhook_url`: 네이버웍스 웹훅 URL로 변경

---

## 6단계: 방화벽 설정

### Windows 방화벽에서 포트 3001 열기

**PowerShell (관리자):**

```powershell
New-NetFirewallRule -DisplayName "2uknow API Monitor" -Direction Inbound -Port 3001 -Protocol TCP -Action Allow
```

또는 **수동 설정**:

1. Windows 검색 → "방화벽" → "고급 설정"
2. 인바운드 규칙 → 새 규칙
3. 포트 → TCP → 특정 로컬 포트: 3001
4. 연결 허용 → 모든 프로필 → 이름: "2uknow API Monitor"

---

## 7단계: 서버 시작

### 처음 시작 (PM2 ecosystem 사용)

```bash
cd D:\API\2uknow-api-monitor

# 서버 + 헬스체크 데몬 동시 시작
pm2 start ecosystem.config.cjs

# 프로세스 목록 저장 (재부팅 후 자동 시작)
pm2 save
```

### 상태 확인

```bash
pm2 status
```

**정상 출력 예시:**

```
┌────┬───────────────────────┬─────────┬──────────┬────────┬───────────┬──────────┐
│ id │ name                  │ mode    │ pid      │ uptime │ status    │ mem      │
├────┼───────────────────────┼─────────┼──────────┼────────┼───────────┼──────────┤
│ 0  │ 2uknow-api-monitor    │ fork    │ 12345    │ 10s    │ online    │ 90mb     │
│ 1  │ pm2-healthcheck       │ fork    │ 12346    │ 10s    │ online    │ 60mb     │
└────┴───────────────────────┴─────────┴──────────┴────────┴───────────┴──────────┘
```

⚠️ **주의**: `pid`가 `N/A`이거나 `mem`이 `0b`이면 좀비 상태! 아래 문제 해결 참조.

---

## 8단계: 접속 확인

### 로컬 접속

브라우저에서: `http://localhost:3001`

### 네트워크 접속

1. IP 주소 확인:
   ```bash
   ipconfig
   # IPv4 주소 확인 (예: 10.10.52.54)
   ```

2. 브라우저에서: `http://10.10.52.54:3001`

---

## ✅ 설치 완료 체크리스트

- [ ] `pm2 status`에서 두 프로세스 모두 `online` 상태
- [ ] `pid`가 숫자로 표시됨 (N/A 아님)
- [ ] `mem`이 0b 이상 (실제 메모리 사용)
- [ ] `http://localhost:3001` 접속 성공
- [ ] 웹 대시보드 화면 정상 로드
- [ ] `pm2 save` 실행 완료

---

## 🔧 문제 해결

### Node.js 명령어가 인식 안됨

```
'node'은(는) 내부 또는 외부 명령... 인식할 수 없습니다
```

**해결**:
1. Node.js 재설치 (Add to PATH 옵션 확인)
2. 새 CMD/PowerShell 창 열기
3. 시스템 재부팅

### PM2 명령어가 인식 안됨

```
'pm2'은(는) 내부 또는 외부 명령... 인식할 수 없습니다
```

**해결**:
```bash
npm install -g pm2
# 새 CMD 창 열기
```

### PM2 좀비 프로세스 (online이지만 접속 안됨)

**증상**:
```
│ status: online │ pid: N/A │ mem: 0b │
```

**해결**:
```bash
pm2 kill
pm2 start ecosystem.config.cjs
pm2 save
```

### 포트 3001 이미 사용 중

```
Error: listen EADDRINUSE: address already in use :::3001
```

**해결**:
```bash
# 사용 중인 프로세스 확인
netstat -ano | findstr :3001

# 해당 PID 종료
taskkill /PID <PID번호> /F
```

또는 `config/settings.json`에서 포트 변경:
```json
{
  "site_port": 3002
}
```

### npm install 실패

```
npm ERR! code EACCES
```

**해결**: 관리자 권한으로 CMD 실행 후 다시 시도

### 네트워크에서 접속 안됨

1. 방화벽 규칙 확인
2. IP 주소 확인 (`ipconfig`)
3. 같은 네트워크인지 확인

---

## 📁 디렉토리 구조 확인

설치 후 다음 디렉토리/파일이 있어야 합니다:

```
D:\API\2uknow-api-monitor\
├── node_modules/          ← npm install 후 생성
├── config/
│   └── settings.json      ← 설정 파일
├── collections/           ← Postman/YAML 테스트 파일
├── environments/          ← Postman 환경 파일
├── jobs/                  ← Job 정의 파일
├── logs/                  ← 로그 파일 (실행 후 생성)
├── reports/               ← HTML 리포트 (실행 후 생성)
├── scripts/               ← 유틸리티 스크립트
├── server.js              ← 메인 서버
├── ecosystem.config.cjs   ← PM2 설정
└── package.json
```

---

## 🔄 재부팅 후 자동 시작 설정

### PM2 Windows 서비스 등록

```bash
# 1. PM2 startup 실행
pm2 startup

# 2. 현재 프로세스 저장
pm2 save
```

### 수동 시작 (서비스 등록 안한 경우)

재부팅 후:
```bash
cd D:\API\2uknow-api-monitor
pm2 start ecosystem.config.cjs
```

---

## 📞 추가 지원

- **로그 확인**: `pm2 logs`
- **상태 모니터링**: `pm2 monit`
- **헬스체크 로그**: `logs/pm2-healthcheck.log`
- **서버 로그**: `logs/pm2-out.log`

문제 발생 시 로그 파일을 확인하고, 위 문제 해결 섹션을 참조하세요.
