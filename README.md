# Danal External API Monitor

**네이버웍스 알람 통합 API 모니터링 시스템**

Newman(Postman CLI) 및 SClient 바이너리를 지원하는 실시간 API 모니터링과 네이버웍스 알람을 제공하는 웹 기반 대시보드입니다.

## 주요 특징

### 다중 테스트 엔진 지원
- **Newman 기반**: Postman Collection/Environment 파일 직접 활용
- **SClient 바이너리**: YAML 기반 SClient 통합 테스트 지원
- **실시간 로그 스트리밍**: Server-Sent Events로 실시간 실행 상황 모니터링
- **고품질 HTML 리포트**: 다크/라이트 테마, 반응형 디자인, 툴팁 지원

### 실시간 모니터링 대시보드
- 오늘의 실행 통계 (총 실행 횟수, 성공률, 평균 응답시간, 실패 횟수)
- 페이지네이션 지원 실행 이력 조회
- 필터링 & 검색 기능 (Job별, 기간별, 키워드)
- 실시간 콘솔 로그 (전체화면 모달 지원)

### 네이버웍스 알람 시스템
- 웹훅 기반 즉시 알람 전송
- Flex 메시지와 텍스트 메시지 지원
- 시작/성공/실패별 세분화된 알람 설정
- 웹 UI에서 알람 설정 관리

### 자동 스케줄링
- Cron 표현식 기반 자동 실행
- 웹 UI에서 스케줄 생성/삭제 관리
- 다중 Job 동시 스케줄링 지원

## 빠른 시작

> 💡 **처음 설치하시나요?** 아무것도 설치되지 않은 컴퓨터라면 [INSTALL.md](INSTALL.md)의 상세 가이드를 따라주세요.

### 1. 설치

```bash
# 저장소 클론
git clone https://github.com/danal-rnd/danal-external-api-monitor.git
cd danal-external-api-monitor

# 프로젝트 초기 설정 (의존성 설치 + 디렉토리 생성)
npm run setup
```

### 2. Newman 리포터 설치

```bash
# Newman과 HTML 리포터 설치
npm run install-reporters
```

## ⚡ SClient YAML Testing

**YAML 기반 SClient 테스트 즉시 실행:**

```bash
# YAML 테스트 파일 직접 실행
node run-yaml.js collections/simple_api_test.yaml

# 상세한 디버깅 정보와 함께 결과 출력:
# ✅ SClient 명령어 실행 결과
# ✅ 추출된 변수들 (타입, 길이 포함)  
# ✅ JavaScript 조건식 단계별 분석
# ✅ 대화형 확장 가능한 변수값 표시
# ✅ Newman 스타일 HTML 리포트 생성
```

### 범용 Assertion 엔진

**어떤 변수명이든 하드코딩 없이 테스트 가능:**

```yaml
# 존재 여부 체크
- "FIELD_NAME exists"

# 비교 연산
- "RESULT_CODE == 0"
- "AMOUNT > 1000" 
- "STATUS != 'FAILED'"

# JavaScript 표현식
- "js: FIELD1 == 'ok' && FIELD2.length > 5"
- "js: CUSTOM_VAR > 0 || ERROR_MSG == ''"
```

**특징:**
- 🚀 **완전 범용적**: 새로운 변수명 추가시 코드 수정 불필요
- 🔍 **조건별 분석**: JavaScript 조건식을 항목별로 분석하여 실패 원인 정확 파악
- ⚡ **즉시 실행**: YAML 파일만 작성하고 바로 테스트
- 📱 **대화형 UI**: 긴 변수값은 클릭해서 전체 내용 확인 가능
- 🧪 **JavaScript 지원**: 복잡한 조건도 JavaScript로 표현 가능

### 🔄 동적 변수 치환 (Variable Substitution)

**YAML 테스트에서 실시간 변수 치환 지원:**

```yaml
variables:
  SERVICE_NAME: "TELEDIT"
  MERCHANT_ID: "A010002002"
  ORDER_ID: "{{$timestamp}}_{{$randomInt}}"
  DYNAMIC_MSG: "{{js: new Date().getHours() > 12 ? 'PM' : 'AM'}}_TEST"

steps:
  - name: "{{SERVICE_NAME}} 결제 요청 테스트"  # ✅ SERVICE_NAME으로 치환
    args:
      SERVICE: "{{SERVICE_NAME}}"
      ID: "{{MERCHANT_ID}}"
      ORDERID: "{{ORDER_ID}}"
    
    extract:
      - name: "result"
        pattern: "Result"
        variable: "PAYMENT_RESULT"
    
    test:
      - name: "{{SERVICE_NAME}} 응답코드 확인"      # ✅ 치환됨
        assertion: "PAYMENT_RESULT == 0"
      - name: "추출된 결과값 {{PAYMENT_RESULT}} 검증"  # ✅ 추출변수도 치환
        assertion: "js: PAYMENT_RESULT !== null"
```

**지원하는 변수 타입:**

| 변수 패턴 | 예시 | 설명 |
|-----------|------|------|
| **YAML 변수** | `{{SERVICE_NAME}}` | variables 섹션에 정의된 변수 |
| **동적 변수** | `{{$timestamp}}`, `{{$randomId}}` | 내장 동적 생성 변수 |
| **JavaScript 식** | `{{js: new Date().getTime()}}` | JavaScript 코드 실행 결과 |
| **추출 변수** | `{{PAYMENT_RESULT}}` | 이전 단계에서 추출된 변수 |

**내장 동적 변수:**
- `{{$timestamp}}` - Unix 타임스탬프 (밀리초)
- `{{$randomId}}` - 고유 랜덤 ID 
- `{{$randomInt}}` - 랜덤 정수 (0-9999)
- `{{$date}}` - 현재 날짜 (YYYYMMDD)
- `{{$time}}` - 현재 시간 (HHMMSS)
- `{{$uuid}}` - UUID v4

**특징:**
- ✅ **실시간 치환**: 실행 시점에 변수값 적용
- ✅ **완전 독립**: run-yaml.js와 웹 대시보드 모두 지원
- ✅ **체이닝**: 이전 단계 결과를 다음 단계에서 사용
- ✅ **JavaScript 지원**: 복잡한 동적 값 생성 가능
- ✅ **하위 호환**: 기존 YAML 파일 그대로 동작

## 🔧 SClient 통합 시스템

### SClient 명령어 실행 구조
**시스템 흐름**: YAML 정의 → JSON 시나리오 → SClient 실행 → Newman 스타일 리포트

**핵심 구성 요소**:
- **SClient 엔진** (`sclient-engine.js`): SClient 바이너리 실행 및 응답 파싱
- **YAML 파서** (`simple-yaml-parser.js`): 변수 치환 및 시나리오 변환  
- **Newman 컨버터** (`newman-converter.js`): 고품질 HTML 리포트 생성

### SClient YAML 테스트 형식

```yaml
name: "SClient 결제 테스트"
description: "다날 SClient를 이용한 결제 프로세스 테스트"

variables:
  MERCHANT_ID: "A010002002"
  SERVICE_NAME: "TELEDIT" 
  ORDER_ID: "{{$timestamp}}_{{$randomInt}}"

steps:
  - name: "{{SERVICE_NAME}} 결제 요청"
    description: "결제 요청 API 호출"
    
    args:
      Command: "ITEMSEND2"
      SERVICE: "{{SERVICE_NAME}}"
      ID: "{{MERCHANT_ID}}"
      ORDERID: "{{ORDER_ID}}"
      AMOUNT: "1000"
    
    # 간단한 키워드 추출 (정규식 불필요)
    extract:
      - name: "result"
        pattern: "Result"         # 키워드만 입력
        variable: "PAYMENT_RESULT"
      - name: "serverInfo"
        pattern: "ServerInfo"
        variable: "SERVER_INFO"
    
    # 상세한 테스트 설명과 툴팁 지원
    test:
      - name: "결제 응답코드 확인"
        description: "결제가 정상적으로 처리되었는지 응답코드로 확인"
        assertion: "PAYMENT_RESULT == 0"
      
      - name: "서버 정보 존재 확인"  
        description: "다음 단계에서 사용할 ServerInfo가 정상 반환되었는지 확인"
        assertion: "SERVER_INFO exists"
```

### 고급 HTML 리포트 기능

**Modern UI 기능**:
- ✅ **다크/라이트 테마**: 토글 버튼으로 테마 전환, localStorage 저장
- ✅ **반응형 디자인**: 모바일 친화적 레이아웃
- ✅ **대화형 툴팁**: 테스트 설명에 마우스 오버시 상세 정보 표시
- ✅ **확장 가능한 변수값**: 긴 변수값 클릭시 전체 내용 확인
- ✅ **JavaScript 조건 분석**: 실패한 조건식을 단계별로 분석하여 표시

**리포트 구조**:
1. 헤더 (테스트명, 설명, 생성시간 KST)
2. 대시보드 메트릭 (성공률, 응답시간 등 원형 진행바)
3. 요청 결과 (SClient 명령어 전체 표시)
4. 테스트 검증 (성공/실패 상태 및 상세 오류 메시지)
5. 실행 통계 요약

### 3. 기본 설정

프로젝트 실행 시 `config/settings.json`이 자동 생성됩니다:

```json
{
  "site_port": 3001,
  "webhook_url": "https://talk.naver.com/webhook/your-webhook-url",
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

### 4. Postman Collection 준비

```bash
# Postman에서 Collection과 Environment 파일을 내보내서 저장
collections/your_api.postman_collection.json      # 필수
environments/your_env.postman_environment.json    # 선택사항
```

### 5. Job 설정 파일 생성

**Newman Job (Postman Collection)**:
```json
// jobs/api_health_check.json
{
  "name": "API Health Check",
  "type": "newman", 
  "collection": "collections/your_api.postman_collection.json",
  "environment": "environments/your_env.postman_environment.json",
  "reporters": ["cli", "htmlextra", "json"]
}
```

**Binary Job (SClient YAML)**:
```json
// jobs/sclient_test.json
{
  "name": "SClient Payment Test",
  "type": "binary",
  "yamlFile": "collections/payment_test.yaml",
  "description": "SClient 결제 테스트 시나리오"
}
```

### 6. 실행

#### PM2로 실행 (권장 - 프로덕션)

```bash
# PM2 ecosystem으로 서버 + 헬스체크 데몬 동시 시작
pm2 start ecosystem.config.cjs

# 프로세스 목록 저장 (재부팅 후 자동 시작)
pm2 save

# 상태 확인
pm2 status
```

**ecosystem.config.cjs로 시작하면:**
- ✅ **2uknow-api-monitor**: 메인 API 모니터링 서버 (매일 04:00 자동 재시작)
- ✅ **pm2-healthcheck**: 좀비 프로세스 감지 및 자동 복구 데몬 (5분 주기)

#### 헬스체크 데몬 기능
- PM2 좀비 프로세스 자동 감지 (online 상태지만 실제 미실행)
- HTTP 헬스체크 실패시 자동 재시작
- 연속 3회 실패시 PM2 데몬 전체 리셋
- 로그: `logs/pm2-healthcheck.log`

#### 개별 실행 (개발용)

```bash
# 개발 모드 (자동 재시작)
npm run dev

# 프로덕션 모드 (PM2 없이)
npm start

# 환경변수와 함께 실행
npm run start:env

# 헬스체크만 수동 실행
npm run healthcheck
```

#### PM2 관리 명령어

```bash
# 전체 재시작
pm2 restart ecosystem.config.cjs

# 특정 프로세스만 재시작
pm2 restart 2uknow-api-monitor

# 로그 확인
pm2 logs                          # 전체 로그
pm2 logs 2uknow-api-monitor       # 서버 로그만
pm2 logs pm2-healthcheck          # 헬스체크 로그만

# 전체 중지 및 삭제
pm2 stop ecosystem.config.cjs
pm2 delete ecosystem.config.cjs
```

**웹 대시보드**: `http://localhost:3001`

## 사용법

### Job 실행

**웹 대시보드에서**:
1. Job Selection 드롭다운에서 실행할 Job 선택
2. **Run** 버튼 클릭
3. 실시간 로그에서 실행 상태 확인
4. Execution History에서 결과 확인
5. HTML 리포트 링크 클릭하여 상세 결과 확인

### 스케줄 관리

**웹 UI에서 스케줄 설정**:
1. 자동 스케줄 섹션의 **관리** 버튼 클릭
2. Job 선택 및 Cron 표현식 입력
   - `*/5 * * * *` : 5분마다 실행
   - `0 9 * * 1-5` : 평일 오전 9시 실행
3. **스케줄 추가** 버튼으로 등록

**API로 스케줄 등록**:
```bash
curl -X POST http://localhost:3001/api/schedule \
  -H "Content-Type: application/json" \
  -d '{"name": "api_health_check", "cronExpr": "*/10 * * * *"}'
```

### 알람 설정

**웹 UI에서 설정**:
1. 헤더의 **Alert Settings** 버튼 클릭
2. 네이버웍스 웹훅 URL 입력 (서버 재시작 필요)
3. 알람 시스템 활성화 토글
4. 세부 알람 설정:
   - 실행 시작 알람
   - 실행 성공 알람  
   - 실행 실패 알람
5. 알람 방식 선택 (텍스트/Flex 메시지)

### 모니터링

**실시간 통계 확인**:
- 오늘의 총 실행 횟수
- 성공률 (%)
- 평균 응답 시간
- 실패한 테스트 수

**실행 이력 관리**:
- Job별, 기간별 필터링
- 키워드 검색 (Success/Failed)
- 페이지네이션 (10/20/50/100개씩 보기)

## 프로젝트 구조

```
2uknow-api-monitor/
├── collections/            # Postman Collections & YAML 테스트 파일들
├── environments/           # Postman Environment 파일들
├── jobs/                   # Job 설정 파일들 (.json)
├── config/                 # 시스템 설정 파일
│   ├── settings.json          # 메인 설정 파일
│   └── schedules.json         # 스케줄 설정 파일
├── reports/                # HTML 리포트 저장소 (Newman & SClient)
├── logs/                   # 실행 로그 및 히스토리 JSON  
├── temp/                   # 임시 JSON 시나리오 파일들
├── scripts/                # 디버그/테스트 스크립트
├── public/                 # 웹 대시보드 정적 파일
│   ├── index.html             # 메인 대시보드
│   └── alert-config.html      # 알람 설정 페이지
├── server.js               # Express 서버 (SSE, API, 스케줄링)
├── alert.js                # 네이버웍스 알람 시스템
├── run-yaml.js             # YAML 테스트 직접 실행기
├── sclient-engine.js       # SClient 바이너리 실행 엔진
├── simple-yaml-parser.js   # YAML 파서 및 변수 치환
├── newman-converter.js     # Newman 스타일 HTML 리포트 생성기
└── package.json
```

## 설정 옵션

### `config/settings.json`

```json
{
  "site_port": 3001,                    // 웹 서버 포트
  "webhook_url": "https://talk.naver.com/webhook/...",  // 네이버웍스 웹훅
  "timezone": "Asia/Seoul",             // 시간대
  "history_keep": 500,                  // 유지할 이력 개수
  "report_keep_days": 30,              // HTML 리포트 보관 일수
  "run_event_alert": true,             // 전체 알람 활성화
  "alert_on_start": true,              // 실행 시작 알람
  "alert_on_success": true,            // 성공 알람  
  "alert_on_error": true,              // 실패 알람
  "alert_method": "flex"               // 알람 방식 ("text" | "flex")
}
```

### 환경변수 지원

```bash
# 네이버웍스 웹훅 (설정 파일보다 우선)
export NW_HOOK="https://talk.naver.com/webhook/..."

# 텍스트 전용 알람 모드
export TEXT_ONLY=true

# 대시보드 베이스 URL  
export DASHBOARD_URL="https://api-monitor.yourdomain.com"

# 개발 모드 (자세한 로깅 + 메모리 모니터링)
export NODE_ENV=development
```

## 문제 해결

### 자주 발생하는 문제들

**Q: Newman 실행이 실패합니다**
```bash
# Newman 리포터 재설치
npm run install-reporters

# 또는 수동 설치
npm install newman newman-reporter-htmlextra
```

**Q: 네이버웍스 알람이 오지 않습니다**
1. `config/settings.json`에서 `webhook_url` 확인
2. 웹 UI의 알람 설정에서 "활성화" 상태 확인
3. 콘솔 로그에서 알람 전송 에러 확인
4. 환경변수 `NW_HOOK` 설정 확인

**Q: HTML 리포트가 생성되지 않습니다**
```bash
# htmlextra 리포터 확인
npm list newman-reporter-htmlextra

# 리포터 재설치
npm run update-newman
```

**Q: 스케줄이 실행되지 않습니다**
- Cron 표현식 형식 확인 (5자리: `분 시 일 월 요일`)
- 서버 시간대 확인 (`Asia/Seoul` 기본)
- Job 파일이 `jobs/` 폴더에 있는지 확인

**Q: 실시간 로그가 보이지 않습니다**
- 브라우저 개발자 도구에서 SSE 연결 상태 확인
- 방화벽/프록시가 SSE를 차단하지 않는지 확인

**Q: PM2가 online이지만 서버에 접속이 안됩니다 (좀비 프로세스)**

증상:
```bash
pm2 status
# status: online, pid: N/A, mem: 0b  ← 좀비 상태
```

원인: Windows에서 PM2 데몬이 `EACCES` 권한 오류로 node spawn 실패

해결:
```bash
# PM2 데몬 완전 재시작
pm2 kill
pm2 start ecosystem.config.cjs
pm2 save
```

예방: `ecosystem.config.cjs`로 시작하면 `pm2-healthcheck` 데몬이 자동으로 좀비 프로세스를 감지하고 복구합니다.

### 성능 최적화 기능

- **SSE 연결 관리**: 자동 재연결 및 클라이언트 정리
- **로그 배치 처리**: 10개씩 묶어서 50ms 간격으로 전송
- **하트비트 시스템**: 30초마다 연결 상태 확인
- **메모리 모니터링**: 개발 모드에서 메모리 사용량 추적
- **리포트 자동 정리**: 설정된 보관 일수에 따라 오래된 파일 삭제

## 개발 정보

### 기술 스택
- **Backend**: Node.js v16+, Express.js
- **Frontend**: Vanilla JavaScript, Tailwind CSS
- **테스트 엔진**: Newman (Postman CLI)
- **실시간 통신**: Server-Sent Events (SSE)
- **알람**: 네이버웍스 웹훅
- **스케줄링**: node-cron

### API 엔드포인트

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/jobs` | Job 목록 조회 |
| `POST` | `/api/run/:job` | 특정 Job 실행 |
| `GET` | `/api/history` | 실행 이력 조회 (페이지네이션) |
| `GET` | `/api/statistics/today` | 오늘의 실행 통계 |
| `GET` | `/api/stream/state` | 실시간 상태 스트리밍 (SSE) |
| `GET` | `/api/stream/logs` | 실시간 로그 스트리밍 (SSE) |
| `GET` | `/api/schedule` | 스케줄 목록 조회 |
| `POST` | `/api/schedule` | 스케줄 등록 |
| `DELETE` | `/api/schedule/:name` | 스케줄 삭제 |
| `GET` | `/api/alert/config` | 알람 설정 조회 |
| `POST` | `/api/alert/config` | 알람 설정 저장 |

### 테스트 스크립트

```bash
# 알람 테스트
npm run test:alert

# 에러 알람 테스트  
npm run test:error

# 연결 테스트
npm run test:connection

# 디버그 정보
npm run debug:all
```

### SClient 디버깅

**YAML 테스트 실행 시 상세 정보**:
```bash
# 기본 실행
node run-yaml.js collections/test.yaml

# 출력 예시:
# 📋 Step: TELEDIT 결제 요청
#   ⚡ Command: ./SClient "Command=ITEMSEND2;SERVICE=TELEDIT;..."
#   📊 Extracted Variables:
#     - PAYMENT_RESULT = "0" (string, 1 characters)
#     - SERVER_INFO = "abc123def..." (string, 45 characters)
#   ✅ 결제 응답코드 확인 (PAYMENT_RESULT == 0)
#   ❌ 서버 정보 길이 확인 (SERVER_INFO.length > 50)
#     JavaScript Condition Analysis:
#       ✅ SERVER_INFO !== null → true (SERVER_INFO = "abc123def...")
#       ❌ SERVER_INFO.length > 50 → false (SERVER_INFO = "abc123def...")
```

**HTML 리포트 디버깅**:
- 툴팁이 표시되지 않으면 → 테스트에 `description` 필드 확인
- 변수값이 확장되지 않으면 → 브라우저 JavaScript 콘솔 확인
- 리포트 생성 실패시 → 서버 로그에서 Newman 컨버터 오류 확인

### 유틸리티 스크립트

```bash
# 디렉토리 및 설정 파일 생성
npm run create-dirs

# 로그 및 리포트 정리
npm run clean

# 백업 생성 (tar.gz)
npm run backup
```

