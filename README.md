# Danal API Monitor

다날 외부 API 모니터링 시스템입니다. Postman Newman을 기반으로 API 테스트를 자동화하고 네이버웍스로 실시간 알람을 보냅니다.

## 왜 만들었나?

- Postman 컬렉션을 그대로 활용 (기존 테스트 재사용)
- 네이버웍스 알람으로 즉시 문제 파악
- 웹 대시보드에서 한눈에 모니터링
- 스케줄링으로 자동 실행
- 상세한 HTML 리포트 생성

## 주요 기능

### 🔄 API 테스트 자동화
- Postman 컬렉션/환경 파일 기반 테스트
- Newman CLI 통합으로 안정적인 실행
- 실시간 로그 스트리밍
- 성공/실패 상세 통계

### 📊 모니터링 대시보드
- 실행 이력 관리 (성공률, 응답시간 등)
- 실시간 콘솔 로그 확인
- HTML 리포트 자동 생성 및 보관
- 필터링 및 검색 기능

### 🔔 알람 시스템
- 네이버웍스 메신저 통합
- Flex 메시지로 깔끔한 알람
- 성공/실패/시작 시점별 알람 설정
- 상세 실패 정보 포함

### ⏰ 스케줄링
- Cron 표현식 기반 자동 실행
- 여러 잡 동시 스케줄링
- 웹 UI에서 쉬운 관리

## 빠른 시작

### 설치

```bash
# 저장소 클론
git clone [repository-url]
cd danal-api-monitor

# 의존성 설치
npm install

# Newman 리포터 설치
npm run install-reporters
```

### 기본 설정

1. **설정 파일 생성**
```bash
mkdir -p config reports logs jobs
echo '{"site_port": 3000}' > config/settings.json
```

2. **네이버웍스 웹훅 설정**
```json
// config/settings.json
{
  "site_port": 3000,
  "webhook_url": "https://talk.naver.com/webhook/...",
  "run_event_alert": true,
  "alert_method": "flex"
}
```

3. **Postman 컬렉션 준비**
```bash
# collections 폴더에 .postman_collection.json 파일 저장
# environments 폴더에 .postman_environment.json 파일 저장 (선택)
```

4. **잡 설정 파일 생성**
```json
// jobs/api_health_check.json
{
  "name": "API Health Check",
  "type": "newman",
  "collection": "collections/health_check.postman_collection.json",
  "environment": "environments/production.postman_environment.json",
  "reporters": ["cli", "htmlextra", "junit", "json"]
}
```

### 실행

```bash
# 개발 모드 (nodemon)
npm run dev

# 프로덕션 모드
npm start

# 환경변수 포함 실행
npm run start:env
```

웹 브라우저에서 `http://localhost:3000` 접속

## 사용법

### 1. 잡 설정

`jobs/` 폴더에 JSON 파일로 테스트 잡을 정의합니다:

```json
{
  "name": "결제 API 테스트",
  "type": "newman",
  "collection": "collections/payment_api.postman_collection.json",
  "environment": "environments/staging.postman_environment.json",
  "reporters": ["cli", "htmlextra", "json"],
  "extra": ["--timeout", "10000", "--delay-request", "500"]
}
```

### 2. 수동 실행

웹 대시보드에서:
1. 잡 선택
2. "실행" 버튼 클릭
3. 실시간 로그 확인
4. 결과 리포트 확인

### 3. 스케줄 설정

```bash
# API로 스케줄 등록
curl -X POST http://localhost:3000/api/schedule \
  -H "Content-Type: application/json" \
  -d '{"name": "api_health_check", "cronExpr": "*/5 * * * *"}'

# 매 5분마다 실행
```

또는 웹 UI에서 스케줄 관리 가능

### 4. 알람 설정

웹 대시보드의 "알람 설정" 메뉴에서:
- 네이버웍스 웹훅 URL 입력
- 알람 타입 선택 (시작/성공/실패)
- 메시지 형식 선택 (텍스트/Flex)

## 디렉토리 구조

```
danal-api-monitor/
├── collections/          # Postman 컬렉션 파일
├── environments/         # Postman 환경 파일
├── jobs/                # 잡 설정 파일
├── config/              # 시스템 설정
├── reports/             # 생성된 HTML 리포트
├── logs/                # 실행 로그 및 히스토리
├── public/              # 웹 대시보드 파일
├── server.js            # 메인 서버
├── alert.js             # 알람 시스템
└── package.json
```

## 설정 옵션

### config/settings.json

```json
{
  "site_port": 3000,
  "webhook_url": "네이버웍스 웹훅 URL",
  "base_url": "https://your-domain.com",
  "timezone": "Asia/Seoul",
  "history_keep": 500,
  "report_keep_days": 30,
  "run_event_alert": true,
  "alert_on_start": true,
  "alert_on_success": true,
  "alert_on_error": true,
  "alert_method": "flex"
}
```

### 환경변수

```bash
# 네이버웍스 웹훅 (설정 파일보다 우선)
export NW_HOOK="https://talk.naver.com/webhook/..."

# 텍스트 전용 모드
export TEXT_ONLY=true

# 대시보드 URL
export DASHBOARD_URL="https://api-monitor.company.com"

# 개발 모드 (메모리 모니터링 활성화)
export NODE_ENV=development
```

## 문제 해결

### 자주 발생하는 문제들

**Q: Newman 실행이 안 됩니다**
```bash
# Newman 글로벌 설치 확인
npm install -g newman

# 권한 문제 해결 (Linux/Mac)
chmod +x node_modules/.bin/newman
```

**Q: 네이버웍스 알람이 안 옵니다**
1. 웹훅 URL 확인
2. 알람 설정에서 "연결 테스트" 실행
3. 콘솔 로그에서 에러 메시지 확인

**Q: 리포트가 생성되지 않습니다**
```bash
# htmlextra 리포터 설치
npm install newman-reporter-htmlextra
```

**Q: 스케줄이 실행되지 않습니다**
- Cron 표현식이 올바른지 확인 (5자리 형식)
- 서버 시간대 확인 (`Asia/Seoul` 기본)

### 성능 최적화

현재 구현된 최적화 기능들:
- SSE 연결 풀링 및 자동 정리
- 로그 배치 처리 (10개씩 50ms 간격)
- 30초마다 하트비트로 연결 상태 확인
- 메모리 사용량 모니터링 (개발 모드)
- 오래된 리포트 자동 정리

## 개발 정보

### 기술 스택
- **Backend**: Node.js, Express
- **Frontend**: Vanilla JS, Tailwind CSS
- **테스트 엔진**: Newman (Postman CLI)
- **알람**: 네이버웍스 메신저
- **스케줄링**: node-cron

### API 엔드포인트

```
GET  /api/jobs               # 잡 목록
POST /api/run/:job           # 잡 실행
GET  /api/history           # 실행 이력
GET  /api/stream/state      # 실시간 상태 (SSE)
GET  /api/stream/logs       # 실시간 로그 (SSE)
GET  /api/schedule          # 스케줄 목록
POST /api/schedule          # 스케줄 등록
GET  /api/alert/config      # 알람 설정
POST /api/alert/test        # 알람 테스트
```

### 개발 스크립트

```bash
# 개발 서버 실행 (자동 재시작)
npm run dev

# 프로덕션 빌드 없음 (정적 리소스 직접 서빙)
npm start

# 테스트
npm test

# 정리
npm run clean

# 백업
npm run backup
```

