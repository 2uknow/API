# Danal External API Monitor

Newman(Postman CLI) 및 SClient 바이너리를 지원하는 실시간 API 모니터링 대시보드.  
네이버웍스 알람, Cron 스케줄링, HTML 리포트를 제공한다.

---

## 목차

1. [설치](#설치)
2. [실행](#실행)
3. [설정](#설정)
4. [Job 정의](#job-정의)
5. [YAML 테스트 작성](#yaml-테스트-작성)
6. [skip_if / run_if](#skip_if--run_if)
7. [여러 Job 묶어서 실행](#여러-job-묶어서-실행)
8. [스케줄링](#스케줄링)
9. [PM2 운영](#pm2-운영)
10. [API 레퍼런스](#api-레퍼런스)
11. [문제 해결](#문제-해결)

---

## 설치

### 사전 요구사항 (Windows)

- Node.js v18 이상 — https://nodejs.org/ (LTS, **Add to PATH** 체크)
- PM2 (전역 설치)

```bash
npm install -g pm2
```

### 프로젝트 설정

```bash
git clone https://github.com/danal-rnd/danal-external-api-monitor.git
cd danal-external-api-monitor

# 의존성 설치 + 필요 디렉토리 생성
npm run setup

# Newman HTML 리포터 설치
npm run install-reporters
```

### 방화벽 설정 (필요 시)

```powershell
# 관리자 권한 PowerShell에서 실행
New-NetFirewallRule -DisplayName "API Monitor" -Direction Inbound -Port 3001 -Protocol TCP -Action Allow
```

---

## 실행

### PM2로 실행 (권장)

```bash
# 서버 + 헬스체크 데몬 동시 시작
pm2 start ecosystem.config.cjs

# 재부팅 후 자동 시작 등록
pm2 save
```

`ecosystem.config.cjs`로 시작하면 두 프로세스가 함께 뜬다:
- **2uknow-api-monitor** — 메인 서버, 매일 04:00 자동 재시작
- **pm2-healthcheck** — 좀비 프로세스 감지 및 자동 복구 (5분 주기)

웹 대시보드: `http://localhost:3001`

### 개발 모드

```bash
npm run dev      # nodemon (파일 변경 시 자동 재시작)
npm start        # 일반 실행
```

### PM2 기본 명령어

```bash
pm2 status                        # 상태 확인
pm2 logs 2uknow-api-monitor       # 실시간 로그
pm2 restart 2uknow-api-monitor    # 재시작
pm2 stop ecosystem.config.cjs     # 전체 중지
pm2 kill                          # PM2 데몬 종료
```

---

## 설정

### `config/settings.json`

서버 첫 실행 시 자동 생성된다.

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

| 항목 | 설명 |
|------|------|
| `site_port` | 웹 서버 포트 |
| `webhook_url` | 네이버웍스 웹훅 URL (필수) |
| `alert_method` | `"flex"` 또는 `"text"` |
| `history_keep` | 실행 이력 보관 개수 |
| `report_keep_days` | HTML 리포트 보관 일수 |

### 환경변수

설정 파일보다 우선 적용된다.

```bash
NW_HOOK=https://...               # 웹훅 URL 오버라이드
TEXT_ONLY=true                    # 텍스트 알람 강제
DASHBOARD_URL=https://...        # 리포트 링크용 베이스 URL
NODE_ENV=development              # 상세 로깅 + 메모리 모니터링
BACKUP_KEEP=1                     # 백업 보관 개수
```

---

## Job 정의

`jobs/` 폴더에 JSON 파일로 정의한다.

### Newman Job (Postman Collection)

```json
{
  "name": "본인확인_정상",
  "type": "newman",
  "collection": "collections/Danal_Uas_v1.0.postman_collection.json",
  "environment": "environments/Danal_Uas_v1.0.postman_environment.json",
  "reporters": ["cli", "htmlextra", "junit", "json"],
  "extra": ["--insecure", "--timeout-request", "30000"]
}
```

### Binary Job (YAML 폴더 전체 실행)

```json
{
  "name": "휴대폰결제_정상",
  "type": "binary",
  "collection": "collections/Danal_Teledit_v2.0/",
  "generateHtmlReport": true,
  "timeout": 60000,
  "encoding": "cp949"
}
```

`collection` 폴더 내 `TEST*.yaml` 파일을 알파벳 순서로 전부 실행한다.  
`excludePatterns` 배열로 제외할 파일 패턴 지정 가능.

### SClient Scenario Job (단일 YAML 파일)

```json
{
  "name": "결제_단건테스트",
  "type": "sclient_scenario",
  "yaml": "collections/Danal_Teledit_v2.0/TEST_payment.yaml"
}
```

---

## YAML 테스트 작성

### 기본 구조

```yaml
name: "시나리오 이름"
description: "시나리오 설명"

variables:
  MERCHANT_ID: "A010002002"
  ORDER_ID: "{{$timestamp}}_{{$randomInt}}"

steps:
  - name: "결제 요청"
    args:
      Command: "ITEMSEND2"
      SERVICE: "TELEDIT"
      ID: "{{MERCHANT_ID}}"
      ORDERID: "{{ORDER_ID}}"
      AMOUNT: "1000"

    extract:
      - name: "result"
        pattern: "Result"           # 키워드만 입력 (정규식 불필요)
        variable: "RESULT_CODE"
      - name: "serverInfo"
        pattern: "ServerInfo"
        variable: "SERVER_INFO"

    test:
      - name: "응답코드 정상"
        assertion: "RESULT_CODE == 0"
      - name: "ServerInfo 존재"
        assertion: "SERVER_INFO exists"
```

### 변수

| 패턴 | 예시 | 설명 |
|------|------|------|
| YAML 변수 | `{{MERCHANT_ID}}` | `variables` 섹션 정의 값 |
| 동적 변수 | `{{$timestamp}}` | 실행 시점 자동 생성 |
| JS 표현식 | `{{js: new Date().getHours()}}` | JavaScript 실행 결과 |
| 추출 변수 | `{{RESULT_CODE}}` | 이전 step에서 추출된 값 |

**내장 동적 변수:**

| 변수 | 설명 |
|------|------|
| `$timestamp` | Unix 타임스탬프 (ms) |
| `$randomId` | 고유 랜덤 ID |
| `$randomInt` | 랜덤 정수 (0-9999) |
| `$date` | 현재 날짜 YYYYMMDD |
| `$time` | 현재 시간 HHMMSS |
| `$uuid` | UUID v4 |

### Assertion 문법

```yaml
test:
  # 단순 비교
  - assertion: "RESULT_CODE == 0"
  - assertion: "RESULT_CODE != 531"
  - assertion: "SERVER_INFO exists"

  # 이름 + 설명 포함
  - name: "응답코드 확인"
    description: "정상 처리 여부 확인"
    assertion: "RESULT_CODE == 0"

  # JavaScript 표현식
  - assertion: "js: RESULT_CODE == '0' && SERVER_INFO.length > 0"
  - assertion: "js: ['0', '531'].includes(RESULT_CODE)"
```

### step 간 값 체이닝

이전 step의 `extract` 변수를 다음 step의 `args`에 그대로 사용한다.

```yaml
steps:
  - name: "ITEMSEND2"
    args:
      Command: "ITEMSEND2"
    extract:
      - pattern: "ServerInfo"
        variable: "SERVER_INFO"

  - name: "IDELIVER"
    args:
      Command: "IDELIVER"
      ServerInfo: "{{SERVER_INFO}}"
      AUTHKEY: "{{AUTH_KEY}}"
```

### `conf.yaml` 공통 변수

같은 폴더에 `conf.yaml`이 있으면 자동으로 include되어 공통 변수를 공유한다.

```yaml
# collections/Danal_Teledit_v2.0/conf.yaml
variables:
  MERCHANT_ID: "A010002002"
  MERCHANT_PWD: "..."
```

---

## skip_if / run_if

step 실행 후 응답값에 따라 assertion을 건너뛰거나 흐름을 분기한다.

> 실행 순서: `args 실행` → `extract 추출` → **`skip_if 평가`** → `test 실행`

### action 종류

| action | 현재 step test | 다음 step |
|--------|----------------|-----------|
| `skip_tests` | skip | 정상 실행 |
| `skip_remaining_steps` | skip | 전부 skip |
| `goto_step` | skip | target까지 skip, target부터 실행 |

> 어느 action이든 현재 step 자체(args 실행, extract 추출)는 항상 실행된다.

### `skip_tests` — 이 step의 assertion만 skip

```yaml
    skip_if:
      - condition: "RESULT_CODE == 531"
        action: "skip_tests"
        reason: "531 인증실패는 허용 가능한 응답"
```

### `skip_remaining_steps` — 이후 step 전부 skip

```yaml
    skip_if:
      - condition: "js: RESULT_CODE != '0' && RESULT_CODE !== undefined"
        action: "skip_remaining_steps"
        reason: "실패 시 이후 step 불필요"
```

### `goto_step` — 특정 step으로 점프

```yaml
    skip_if:
      - condition: "RESULT_CODE == 531"
        action: "goto_step"
        target: "531 전용 처리"    # step name과 정확히 일치해야 함
        reason: "531 전용 흐름으로 이동"
```

target을 찾지 못하면 `skip_remaining_steps`로 자동 fallback된다.  
이전 step으로 돌아가는 건 불가하다.

### 다중 조건 (우선순위)

위에서부터 평가하고 첫 번째 매칭만 적용된다. 구체적인 조건 → 일반적인 조건 순서로 작성한다.

```yaml
    skip_if:
      - condition: "RESULT_CODE == 531"
        action: "goto_step"
        target: "531 전용 처리"
      - condition: "RESULT_CODE == 999"
        action: "skip_remaining_steps"
        reason: "서비스 불가"
      - condition: "js: RESULT_CODE != '0'"
        action: "skip_tests"
        reason: "기타 에러"
```

### `run_if` — 블럭 단위 조건부 assertion

조건에 맞을 때만 특정 assertion 블럭을 실행한다.

```yaml
    test:
      - run_if: "RESULT_CODE == 0"
        tests:
          - name: "TID 존재"
            assertion: "TID exists"

      - run_if: "RESULT_CODE == 531"
        tests:
          - name: "531 에러메시지 확인"
            assertion: "ERROR_MSG exists"
```

---

## 여러 Job 묶어서 실행

### 방법 1 — 스케줄에 여러 Job 등록 (순차 실행)

같은 cron 시간대에 여러 job을 등록하면 큐를 통해 순차적으로 실행된다.

```json
[
  { "name": "휴대폰결제_정상", "cronExpr": "0 9 * * *" },
  { "name": "휴대폰결제_오류", "cronExpr": "0 9 * * *" },
  { "name": "본인확인서비스_정상", "cronExpr": "0 9 * * *" }
]
```

### 방법 2 — Binary Job으로 폴더 전체 배치 실행

```json
{
  "name": "결제_전체배치",
  "type": "binary",
  "collection": "collections/payment_tests/",
  "excludePatterns": ["*_backup.yaml", "_*"],
  "timeout": 120000,
  "generateHtmlReport": true
}
```

폴더 내 YAML 파일을 알파벳 순서로 전부 실행하고 하나의 통합 HTML 리포트를 생성한다.

### 방법 3 — 특정 YAML 파일만 선택 실행

```json
{
  "name": "결제_선택배치",
  "type": "binary",
  "yamlFiles": [
    "collections/TEST_SKT_payment.yaml",
    "collections/TEST_KT_payment.yaml"
  ],
  "generateHtmlReport": true
}
```

### 권장 폴더 구조

```
collections/
├── payment/
│   ├── conf.yaml
│   ├── TEST_01_SKT.yaml
│   └── TEST_02_KT.yaml
└── settlement/
    ├── conf.yaml
    └── TEST_daily.yaml

jobs/
├── payment_batch.json
└── settlement_batch.json
```

---

## 스케줄링

### Cron 표현식

```
분  시  일  월  요일
0   9  *   *   *        매일 오전 9시
0   9  *   *   1-5      평일 오전 9시
0  */3  *   *   *        3시간마다
0  9,18  *   *   *      오전 9시 + 오후 6시
```

### 스케줄 관리

**웹 대시보드**: 스케줄 관리 메뉴에서 추가/삭제

**API**:

```bash
# 추가
curl -X POST http://localhost:3001/api/schedule \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"job_name\", \"cronExpr\": \"0 9 * * *\"}"

# 삭제
curl -X DELETE http://localhost:3001/api/schedule/job_name
```

**파일 직접 수정**: `config/schedules.json` 수정 후 서버 재시작

---

## PM2 운영

### 상태 확인 및 모니터링

```bash
pm2 status                          # 프로세스 목록
pm2 monit                           # 실시간 CPU/메모리 대시보드
pm2 logs --lines 200                # 최근 200줄 로그
pm2 logs --err                      # 에러 로그만
pm2 show 2uknow-api-monitor         # 상세 정보
```

### Cron 자동 재시작

`ecosystem.config.cjs` 수정 후 재적용:

```javascript
cron_restart: '0 4 * * *',   // 매일 새벽 4시 재시작
```

```bash
pm2 delete 2uknow-api-monitor
pm2 start ecosystem.config.cjs
pm2 save
```

### 로그 로테이션

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 30
pm2 set pm2-logrotate:compress true
```

### Windows 재부팅 후 자동 시작

```bash
pm2 startup   # 출력된 명령어를 관리자 PowerShell에서 실행
pm2 save
```

---

## API 레퍼런스

### Job 실행 관리

| Method | Endpoint | 설명 |
|--------|----------|------|
| `GET` | `/api/jobs` | Job 목록 조회 |
| `GET` | `/api/run/:name` | Job 실행 |
| `GET` | `/api/running` | 현재 실행 중인 Job 목록 |
| `POST` | `/api/stop/:name` | 실행 중인 Job 중지 |
| `POST` | `/api/reset-state` | 상태 강제 초기화 |

### 이력 및 통계

| Method | Endpoint | 설명 |
|--------|----------|------|
| `GET` | `/api/history` | 실행 이력 (페이지네이션) |
| `GET` | `/api/statistics/today` | 오늘의 통계 |

### 스케줄

| Method | Endpoint | 설명 |
|--------|----------|------|
| `GET` | `/api/schedule` | 스케줄 목록 |
| `POST` | `/api/schedule` | 스케줄 등록 |
| `DELETE` | `/api/schedule/:name` | 스케줄 삭제 |

### 알람 설정

| Method | Endpoint | 설명 |
|--------|----------|------|
| `GET` | `/api/alert/config` | 알람 설정 조회 |
| `POST` | `/api/alert/config` | 알람 설정 저장 |
| `POST` | `/api/alert/test` | 웹훅 연결 테스트 |

### 실시간 스트리밍 (SSE)

| Endpoint | 설명 |
|----------|------|
| `/api/stream/unified` | 상태 + 로그 통합 (권장) |
| `/api/stream/state` | 상태 전용 |
| `/api/stream/logs` | 로그 전용 |

---

## 문제 해결

### PM2 좀비 프로세스 (online이지만 접속 불가)

```bash
pm2 status
# pid: N/A, mem: 0b  ← 좀비 상태
```

```bash
pm2 kill
pm2 start ecosystem.config.cjs
pm2 save
```

`pm2-healthcheck` 데몬이 자동으로 감지하여 복구한다.

### Newman 실행 실패

```bash
npm run install-reporters
```

### 포트 충돌

```bash
netstat -ano | findstr :3001
taskkill /PID <PID번호> /F
```

또는 `config/settings.json`의 `site_port` 변경.

### 네이버웍스 알람 미수신

1. `config/settings.json`의 `webhook_url` 확인
2. 웹 UI 알람 설정에서 활성화 상태 확인
3. `POST /api/alert/test`로 웹훅 직접 테스트

### 스케줄 미동작

- Cron 표현식 5자리 형식 확인
- `/api/schedule`로 등록 여부 확인
- 서버 재시작 후 재시도

### YAML 테스트 assertion 실패 디버깅

```bash
node run-yaml.js collections/TEST_파일명.yaml
```

추출된 변수값과 assertion 평가 과정을 상세하게 출력한다.
