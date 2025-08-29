# 2uknow API Monitor

**네이버웍스 알람 통합 API 모니터링 시스템**

Postman Collection을 활용한 실시간 API 모니터링과 네이버웍스 알람을 제공하는 웹 기반 대시보드입니다.

## 주요 특징

### Newman 기반 API 테스트
- Postman Collection/Environment 파일 직접 활용
- Newman CLI를 통한 안정적인 실행 엔진
- 실시간 로그 스트리밍 (Server-Sent Events)
- HTML/JSON/JUnit 리포트 자동 생성

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

## ⚡ Quick YAML Testing

**간단한 YAML 파일 실행으로 즉시 테스트 가능:**

```bash
# YAML 테스트 파일 직접 실행
node run-yaml.js collections/simple_api_test.yaml

# 상세한 디버깅 정보와 함께 결과 출력:
# ✅ Request/Response 데이터
# ✅ 추출된 변수들 (타입, 길이 포함)
# ✅ 테스트 결과 및 실패 상세 분석
# ✅ JavaScript 표현식 단계별 평가
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
- 🔍 **상세한 디버깅**: 실패 원인 정확한 분석 (변수값, 타입, 길이)
- ⚡ **즉시 실행**: YAML 파일만 작성하고 바로 테스트
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

### 6. 실행

```bash
# 개발 모드 (자동 재시작)
npm run dev

# 프로덕션 모드  
npm start

# 환경변수와 함께 실행
npm run start:env
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
danal-external-api-monitor/
├── collections/          # Postman Collection 파일들
├── environments/         # Postman Environment 파일들
├── jobs/                 # Job 설정 파일들 (.json)
├── config/               # 시스템 설정 파일
│   └── settings.json        # 메인 설정 파일
├── reports/              # Newman HTML 리포트 저장소
├── logs/                 # 실행 로그 및 히스토리 JSON
├── scripts/              # 디버그/테스트 스크립트
├── public/               # 웹 대시보드 정적 파일
│   ├── index.html           # 메인 대시보드
│   └── alert-config.html    # 알람 설정 페이지
├── server.js             # Express 서버 (SSE, API, 스케줄링)
├── alert.js              # 네이버웍스 알람 시스템
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

### 유틸리티 스크립트

```bash
# 디렉토리 및 설정 파일 생성
npm run create-dirs

# 로그 및 리포트 정리
npm run clean

# 백업 생성 (tar.gz)
npm run backup
```

