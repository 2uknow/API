# Danal External API Monitor

Newman(Postman CLI)과 SClient 바이너리를 지원하는 실시간 API 모니터링 및 네이버웍스 알람 시스템.

---

## 목차

1. [설치](#설치)
2. [설정](#설정)
3. [실행](#실행)
4. [Job 설정](#job-설정)
5. [YAML 테스트 작성](#yaml-테스트-작성)
6. [skip_if / run_if](#skip_if--run_if)
7. [SClient 커맨드 레퍼런스](#sclient-커맨드-레퍼런스)
8. [스케줄링 및 배치 실행](#스케줄링-및-배치-실행)
9. [PM2 운영](#pm2-운영)
10. [알람 설정](#알람-설정)
11. [API 레퍼런스](#api-레퍼런스)
12. [문제 해결](#문제-해결)

---

## 설치

### 사전 요구사항 (Windows)

1. **Node.js v18+** — https://nodejs.org 에서 LTS 버전 설치 (설치 시 "Add to PATH" 필수 체크)
2. **PM2** — 설치 후 새 터미널에서 확인

```bash
npm install -g pm2
pm2 --version
```

3. **방화벽 포트 오픈** (PowerShell 관리자)

```powershell
New-NetFirewallRule -DisplayName "API Monitor" -Direction Inbound -Port 3001 -Protocol TCP -Action Allow
```

### 프로젝트 설치

```bash
git clone https://github.com/danal-rnd/danal-external-api-monitor.git
cd danal-external-api-monitor

npm run setup              # 의존성 설치 + 디렉토리 생성
npm run install-reporters  # Newman + htmlextra 리포터 설치
```

---

## 설정

### config/settings.json

서버 최초 실행 시 자동 생성됩니다. 주요 항목:

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
|---|---|
| `site_port` | 웹 서버 포트 (기본 3001) |
| `webhook_url` | 네이버웍스 웹훅 URL |
| `alert_method` | `"flex"` 또는 `"text"` |
| `history_keep` | 유지할 실행 이력 개수 |
| `report_keep_days` | HTML 리포트 보관 일수 |

### 환경변수

| 변수 | 설명 |
|---|---|
| `NW_HOOK` | 웹훅 URL (settings.json보다 우선) |
| `TEXT_ONLY=true` | 텍스트 알람 강제 |
| `DASHBOARD_URL` | 대시보드 베이스 URL |
| `NODE_ENV=development` | 상세 로깅 + 메모리 모니터링 |

---

## 실행

### PM2 (권장 — 프로덕션)

```bash
pm2 start ecosystem.config.cjs   # 서버 + 헬스체크 데몬 시작
pm2 save                          # 현재 상태 저장 (재부팅 후 자동 시작)
pm2 startup                       # Windows 서비스 등록
```

`ecosystem.config.cjs`로 시작하면 두 프로세스가 함께 실행됩니다:
- `2uknow-api-monitor` — 메인 서버 (매일 04:00 자동 재시작)
- `pm2-healthcheck` — 좀비 프로세스 자동 감지 및 복구 (5분 주기)

```bash
# 상태 확인
pm2 status
pm2 monit                      # 실시간 CPU/메모리

# 로그
pm2 logs                       # 전체
pm2 logs 2uknow-api-monitor    # 서버만
pm2 logs --err --lines 50      # 에러 로그

# 재시작 / 중지
pm2 restart ecosystem.config.cjs
pm2 stop ecosystem.config.cjs
```

### 개발 모드

```bash
npm run dev        # nodemon (파일 변경 시 자동 재시작)
npm start          # 단순 실행
npm run start:env  # dotenv 로드 후 실행
```

**웹 대시보드**: `http://localhost:3001`

---

## Job 설정

Job 파일은 `jobs/*.json`에 위치합니다.

### Newman Job (Postman Collection)

```json
{
  "name": "본인확인서비스_정상",
  "type": "newman",
  "collection": "collections/Danal_Uas_v1.0.postman_collection.json",
  "environment": "environments/Danal_Uas_v1.0.postman_environment.json",
  "reporters": ["cli", "htmlextra", "junit", "json"],
  "extra": ["--insecure", "--timeout-request", "30000"]
}
```

### Binary Job (YAML 디렉토리 배치)

`collection` 경로의 모든 YAML 파일을 순서대로 실행합니다.

```json
{
  "name": "휴대폰결제_정상",
  "type": "binary",
  "collection": "collections/Danal_Teledit_v2.0",
  "excludePatterns": ["conf*", "_*"],
  "timeout": 60000,
  "encoding": "cp949",
  "generateHtmlReport": true
}
```

### SClient Scenario Job (단일 YAML 파일)

```json
{
  "name": "결제_시나리오",
  "type": "sclient_scenario",
  "yaml": "collections/Danal_Teledit_v2.0/TEST_SKT.yaml"
}
```

### 배치 실행 — 특정 파일만 지정

`collection` 대신 `yamlFiles` 배열을 사용하면 실행 순서를 직접 지정할 수 있습니다.

```json
{
  "name": "payment_batch",
  "type": "binary",
  "yamlFiles": [
    "collections/Danal_Teledit_v2.0/TEST_SKT.yaml",
    "collections/Danal_Teledit_v2.0/TEST_KT.yaml"
  ],
  "generateHtmlReport": true
}
```

---

## YAML 테스트 작성

### 기본 구조

```yaml
name: "시나리오 이름"
description: "시나리오 설명"

# 공통 변수 파일 참조
include:
  - "conf.yaml"

variables:
  MERCHANT_ID: "A010002002"
  AMOUNT: "1000"
  ORDER_ID: "{{$timestamp}}_{{$randomInt}}"

steps:
  - name: "결제 요청"
    args:
      Command: "ITEMSEND2"
      SERVICE: "TELEDIT"
      ID: "{{MERCHANT_ID}}"
      AMOUNT: "{{AMOUNT}}"
      ORDERID: "{{ORDER_ID}}"

    extract:
      - name: "result"
        pattern: "Result"
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

### Variables — 동적 변수

| 패턴 | 설명 |
|---|---|
| `{{VARIABLE_NAME}}` | variables 섹션에 정의된 변수 |
| `{{$timestamp}}` | Unix 타임스탬프 (밀리초) |
| `{{$randomInt}}` | 랜덤 정수 (0–9999) |
| `{{$date}}` | 현재 날짜 (YYYYMMDD) |
| `{{$time}}` | 현재 시간 (HHMMSS) |
| `{{$uuid}}` | UUID v4 |
| `{{js: new Date().getHours()}}` | JavaScript 실행 결과 |
| `{{RESULT_CODE}}` | 이전 step에서 추출된 변수 |

### Extract — 응답값 추출

키워드 방식(권장)과 정규식 방식 모두 지원합니다.

```yaml
extract:
  # 키워드 방식 (권장) — 대소문자 무관
  - name: "result"
    pattern: "Result"
    variable: "RESULT_CODE"
  - name: "serverInfo"
    pattern: "ServerInfo"
    variable: "SERVER_INFO"
  - name: "errMsg"
    pattern: "ErrMsg"
    variable: "ERROR_MESSAGE"

  # 정규식 방식 (기존 호환)
  - name: "tid"
    pattern: "TID=([A-Za-z0-9]+)"
    variable: "TRANSACTION_ID"
```

**자주 추출하는 필드**: `Result`, `ServerInfo`, `ErrMsg`, `AuthKey`, `TID`, `CAP`, `ANSIMMEMBER`

### Test — Assertion 문법

```yaml
test:
  # 단순 비교
  - "RESULT_CODE == 0"
  - "RESULT_CODE != 531"

  # 값 존재 확인
  - "SERVER_INFO exists"

  # 이름 붙은 assertion
  - name: "응답코드 정상"
    assertion: "RESULT_CODE == 0"

  # JavaScript 표현식
  - name: "복합 조건"
    assertion: "js: RESULT_CODE == '0' && SERVER_INFO.length > 10"
```

### 변수명 컨벤션

- 대문자 + 언더스코어: `MERCHANT_ID`, `RESULT_CODE`, `SERVER_INFO`
- step 이름: 한국어 + 커맨드명 포함 (`"SKT ITEMSEND2 결제 요청"`)
- 파일명: `TEST_[통신사].yaml` 또는 의미 있는 영문명

---

## skip_if / run_if

SClient 실행 **이후**, test 평가 **이전**에 조건을 검사하여 흐름을 제어합니다.

### action 종류

| action | 현재 step test | 이후 step |
|---|---|---|
| `skip_tests` | ⏭️ skip | ▶️ 정상 실행 |
| `skip_remaining_steps` | ⏭️ skip | ⏭️ 전부 skip |
| `goto_step` | ⏭️ skip | target까지 skip → target부터 재개 |

> 어떤 경우든 **현재 step 자체(SClient 실행 + extract)는 항상 실행**됩니다.

### 사용 예시

```yaml
    extract:
      - name: "result"
        pattern: "Result"
        variable: "RESULT_CODE"

    skip_if:
      # 위에서부터 순서대로 평가, 첫 매칭만 적용
      - condition: "RESULT_CODE == 531"
        action: "goto_step"
        target: "531 전용 처리"
        reason: "531 인증실패"

      - condition: "RESULT_CODE == 999"
        action: "skip_remaining_steps"
        reason: "999 서비스 불가"

      - condition: "js: RESULT_CODE != '0'"
        action: "skip_tests"
        reason: "기타 에러"

    test:
      - name: "결과코드 정상"
        assertion: "RESULT_CODE == 0"

  - name: "531 전용 처리"
    args: { ... }
    test:
      - name: "에러 메시지 확인"
        assertion: "ERROR_MESSAGE exists"
```

> **주의사항**
> - `js:` 표현식에서 변수값은 **문자열** → `== '0'` 권장
> - `goto_step`의 `target`은 step `name`과 **정확히 일치** 필요
> - target을 찾지 못하면 `skip_remaining_steps`로 자동 fallback

### run_if — 블럭 단위 조건부 assertion

test 섹션 안에서 조건이 true일 때만 특정 assertion 블럭을 실행합니다.

```yaml
    test:
      - run_if: "RESULT_CODE == 0"
        tests:
          - name: "TID 존재 확인"
            assertion: "TRANSACTION_ID exists"

      - run_if: "RESULT_CODE == 531"
        tests:
          - name: "531 에러 메시지 확인"
            assertion: "ERROR_MESSAGE exists"
```

---

## SClient 커맨드 레퍼런스

### 주요 커맨드 흐름

| 결제 유형 | 흐름 |
|---|---|
| 표준 소액결제 | `ITEMSEND2` → `IDELIVER` → `IREPORT` → `NCONFIRM` → `NBILL` |
| 정기/간편결제 | `EXPREBILL` (AUTHKEY + BILLTYPE) |
| 기본 재결제 | `REBILL` (AUTHKEY) |
| 전체 취소 | `BILL_CANCEL` |
| 부분 취소 | `PART_CANCEL` |
| 폰빌 | `ITEMSEND2` → `PBILL_DELIVER` → `PB_CONFIRM` → `NCONFIRM` → `NBILL` |
| KT PASS 앱결제 (PC) | `ITEMSEND2` → `IDELIVER` → `APP_CONFIRM` → `IREPORT` → `NCONFIRM` → `NBILL` |

### 커맨드별 핵심 파라미터

| 커맨드 | 필수 파라미터 |
|---|---|
| `ITEMSEND2` | `SERVICE`, `ID`, `PWD`, `ItemInfo`, `ORDERID` |
| `IDELIVER` | `ServerInfo`, `CARRIER`, `DSTADDR`, `IDEN` |
| `IREPORT` | `ServerInfo`, `OTP` (또는 `ANSIMPASS`) |
| `NCONFIRM` | `ServerInfo`, `CPID`, `AMOUNT` |
| `NBILL` | `ServerInfo`, `BillOption` |
| `EXPREBILL` | `ID`, `PWD`, `AUTHKEY`, `BILLTYPE`, `ItemInfo` |
| `REBILL` | `ID`, `PWD`, `AUTHKEY`, `ItemInfo` |
| `BILL_CANCEL` | `ID`, `PWD`, `TID` |
| `PART_CANCEL` | `ID`, `PWD`, `O_TID`, `CAMT` |
| `EBILL` | `ServerInfo`, `CONFIRMOPTION`, `AMOUNT`, `CPID` (NCONFIRM+NBILL 통합) |

### 통신사 코드

| 코드 | 통신사 |
|---|---|
| `SKT` | SK텔레콤 |
| `KT` / `KTF` | KT |
| `LGT` | LG U+ |
| `CJH` | CJ헬로 (알뜰폰) |
| `SKL` | SK세븐모바일 |
| `KTMVNO` | KT 알뜰폰 (통합) |
| `LGTMVNO` | LG U+ 알뜰폰 (통합) |

### 주요 Result 코드

| 코드 | 의미 | 처리 |
|---|---|---|
| `0` | 성공 | 정상 흐름 |
| `531` | 인증 실패 | 허용 가능, `skip_if`로 처리 |
| `999` | 서비스 불가 | 허용 가능, 이후 step 불필요 |
| 기타 | 오류 | `ErrMsg` 필드 확인 |

---

## 스케줄링 및 배치 실행

### 스케줄 등록

**웹 대시보드**: 스케줄 관리 → Job + Cron 표현식 입력

**API**:
```bash
curl -X POST http://localhost:3001/api/schedule \
  -H "Content-Type: application/json" \
  -d '{"name": "휴대폰결제_정상", "cronExpr": "0 9 * * *"}'
```

**파일 직접 수정** (`config/schedules.json`):
```json
[
  { "name": "휴대폰결제_정상",     "cronExpr": "0 9 * * *" },
  { "name": "본인확인서비스_정상", "cronExpr": "0 9 * * *" },
  { "name": "다날페이카드",        "cronExpr": "0 9 * * *" }
]
```

같은 시간에 등록된 job들은 **큐 시스템**으로 순차 실행됩니다.

### Cron 표현식 (5자리: 분 시 일 월 요일)

```
0 9 * * *      매일 오전 9시
0 9 * * 1-5    평일 오전 9시
0 9,14 * * *   오전 9시 + 오후 2시
*/30 * * * *   30분마다
```

### 병렬 실행

서로 다른 Job은 동시 실행 가능합니다. 같은 이름의 Job만 중복 차단됩니다.

```bash
# 실행 중인 Job 확인
curl http://localhost:3001/api/running

# 특정 Job 중지
curl -X POST http://localhost:3001/api/stop/휴대폰결제_정상
```

---

## PM2 운영

### 로그 로테이션 설정

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M   # 파일당 최대 크기
pm2 set pm2-logrotate:retain 30      # 보관 파일 수
pm2 set pm2-logrotate:compress true  # gzip 압축
```

### 주요 명령어

```bash
pm2 status                            # 프로세스 상태
pm2 monit                             # 실시간 CPU/메모리
pm2 logs --lines 100                  # 최근 로그
pm2 logs --err --lines 50             # 에러 로그
pm2 flush                             # 로그 비우기
pm2 restart 2uknow-api-monitor        # 서버 재시작
pm2 kill && pm2 start ecosystem.config.cjs  # PM2 완전 재시작
```

### cron 재시작 시간 변경

`ecosystem.config.cjs` 수정:
```javascript
cron_restart: '0 4 * * *',  // 새벽 4시
```
적용: `pm2 delete 2uknow-api-monitor && pm2 start ecosystem.config.cjs && pm2 save`

---

## 알람 설정

### 웹 UI

1. 헤더의 **Alert Settings** 클릭
2. 네이버웍스 웹훅 URL 입력 후 저장
3. 알람 트리거 설정 (시작 / 성공 / 실패)
4. 알람 방식: Flex 메시지 / 텍스트

> 웹훅 URL 변경 후 서버 재시작 필요

### 알람 테스트

```bash
curl -X POST http://localhost:3001/api/alert/test
```

---

## API 레퍼런스

| Method | Endpoint | 설명 |
|---|---|---|
| `GET` | `/api/jobs` | Job 목록 |
| `GET` | `/api/run/:name` | Job 실행 |
| `GET` | `/api/running` | 현재 실행 중인 Job 목록 |
| `POST` | `/api/stop/:name` | 특정 Job 중지 |
| `GET` | `/api/history` | 실행 이력 (페이지네이션) |
| `GET` | `/api/statistics/today` | 오늘 통계 |
| `GET` | `/api/stream/unified` | 통합 SSE (state + log) |
| `GET` | `/api/stream/state` | 상태 SSE (레거시) |
| `GET` | `/api/stream/logs` | 로그 SSE (레거시) |
| `GET` | `/api/schedule` | 스케줄 목록 |
| `POST` | `/api/schedule` | 스케줄 등록 |
| `DELETE` | `/api/schedule/:name` | 스케줄 삭제 |
| `GET` | `/api/alert/config` | 알람 설정 조회 |
| `POST` | `/api/alert/config` | 알람 설정 저장 |
| `POST` | `/api/alert/test` | 알람 테스트 |
| `POST` | `/api/reset-state` | 강제 상태 초기화 |

---

## 문제 해결

### PM2 좀비 프로세스 (online이지만 접속 안됨)

**증상**: `pm2 status`에서 `pid: N/A`, `mem: 0b`

```bash
pm2 kill
pm2 start ecosystem.config.cjs
pm2 save
```

> `ecosystem.config.cjs`로 시작하면 `pm2-healthcheck` 데몬이 자동 감지/복구합니다.

### 포트 충돌

```bash
netstat -ano | findstr :3001
taskkill /PID <PID번호> /F
```

또는 `config/settings.json`에서 `site_port` 변경.

### Newman 실행 실패

```bash
npm run install-reporters
```

### 알람 미수신

1. `config/settings.json`의 `webhook_url` 확인
2. `run_event_alert: true` 확인
3. `pm2 logs --err`에서 알람 전송 오류 확인

### 스케줄 미동작

- Cron 표현식 형식 확인 (5자리)
- Job 파일이 `jobs/` 폴더에 존재하는지 확인

### 실시간 로그 안 보임

브라우저 개발자 도구 → Network → EventSource 연결 확인. 방화벽/프록시가 SSE 차단 여부 확인.

### Node.js 인식 안됨

Node.js 재설치 (Add to PATH 체크) 후 **새 터미널** 열기.

---

## 프로젝트 구조

```
danal-external-api-monitor/
├── server.js               # Express 서버 (SSE, API, 스케줄링)
├── alert.js                # 네이버웍스 웹훅 알람
├── sclient-engine.js       # SClient 바이너리 실행 엔진
├── simple-yaml-parser.js   # YAML 파서 및 변수 치환
├── newman-converter.js     # HTML 리포트 생성
├── run-yaml.js             # YAML 테스트 직접 실행
├── ecosystem.config.cjs    # PM2 설정
├── collections/            # YAML 테스트 & Postman Collection
├── environments/           # Postman Environment
├── jobs/                   # Job 정의 파일 (.json)
├── config/
│   ├── settings.json       # 서버 설정
│   └── schedules.json      # 스케줄 설정
├── public/
│   ├── index.html          # 메인 대시보드
│   └── alert-config.html   # 알람 설정 페이지
├── reports/                # HTML 리포트
├── logs/                   # 실행 로그 & 히스토리
├── binaries/
│   ├── windows/SClient.exe
│   └── linux/SClient
└── scripts/                # 유틸리티 스크립트
```

### 유틸리티 스크립트

```bash
npm run setup              # 의존성 설치 + 디렉토리 생성
npm run install-reporters  # Newman + htmlextra 설치
npm run clean              # logs/, reports/ 비우기
npm run backup             # tar.gz 백업 생성
npm run healthcheck        # PM2 헬스체크 수동 실행
```
