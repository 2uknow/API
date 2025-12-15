# Job 묶어서 실행 가이드

## 🎯 Job을 묶어서 실행하는 2가지 방법

### 방법 1: 스케줄에 여러 Job 등록 (같은 시간 실행)

여러 job을 같은 시간에 스케줄로 등록하여 순차적으로 실행합니다.

#### 설정 파일: `config/schedules.json`

```json
[
  {
    "name": "TDB_SKT",
    "cronExpr": "0 9 * * *"
  },
  {
    "name": "EXPREBILL-PCancel",
    "cronExpr": "0 9 * * *"
  },
  {
    "name": "dnc_newman",
    "cronExpr": "0 9 * * *"
  }
]
```

**동작 방식**:
- 매일 오전 9시에 3개 job이 **순차적으로** 실행됨
- 큐 시스템을 사용하여 동시 실행 방지
- 하나가 끝나면 다음 job 자동 실행

#### 스케줄 등록 방법

**1. 파일로 직접 등록**:
```bash
# config/schedules.json 파일 수정
notepad config\schedules.json
```

**2. 웹 대시보드에서 등록**:
```
http://localhost:3000
→ 스케줄 관리 메뉴
→ Job 이름, Cron 표현식 입력
→ 추가 버튼 클릭
```

**3. API로 등록**:
```bash
# 첫 번째 job
curl -X POST http://localhost:3000/api/schedule ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"TDB_SKT\",\"cronExpr\":\"0 9 * * *\"}"

# 두 번째 job
curl -X POST http://localhost:3000/api/schedule ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"EXPREBILL-PCancel\",\"cronExpr\":\"0 9 * * *\"}"

# 세 번째 job
curl -X POST http://localhost:3000/api/schedule ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"dnc_newman\",\"cronExpr\":\"0 9 * * *\"}"
```

#### Cron 표현식 참고

```
* * * * *
│ │ │ │ │
│ │ │ │ └─ 요일 (0-7, 0과 7은 일요일)
│ │ │ └─── 월 (1-12)
│ │ └───── 일 (1-31)
│ └─────── 시 (0-23)
└───────── 분 (0-59)
```

**자주 사용하는 패턴**:
- `0 9 * * *` - 매일 오전 9시
- `0 */3 * * *` - 3시간마다
- `0 9 * * 1-5` - 평일 오전 9시
- `0 9,14 * * *` - 오전 9시, 오후 2시

---

### 방법 2: 배치 Job 생성 (여러 YAML을 하나의 Job으로)

여러 YAML 파일을 하나의 배치 job으로 묶어서 실행합니다.

#### 배치 Job 파일 예시: `jobs/my_batch.json`

```json
{
  "name": "my_batch",
  "type": "binary",
  "description": "Execute multiple YAML files as batch",
  "collection": "collections/",
  "environment": "Production",
  "excludePatterns": [
    "*config*",
    "_*",
    "*.config.yaml"
  ],
  "platforms": {
    "win32": {
      "executable": "SClient.exe",
      "path": "binaries/windows"
    }
  },
  "timeout": 60000,
  "encoding": "cp949",
  "parseOutput": {
    "successPattern": "Result=0|SUCCESS",
    "failurePattern": "Result=[^0]|ERROR|ErrMsg=",
    "statsPattern": "Result=([0-9]+)"
  },
  "generateHtmlReport": true,
  "reportOptions": {
    "title": "My Batch Test Execution Report",
    "browserTitle": "My Batch Report"
  }
}
```

**동작 방식**:
- `collections/` 폴더의 모든 YAML 파일을 자동으로 실행
- `excludePatterns`에 해당하는 파일은 제외
- 하나의 HTML 보고서로 통합 생성

#### 배치 Job 생성 방법

**1. 기존 배치 파일 복사**:
```bash
copy jobs\batch_collections.json jobs\my_batch.json
```

**2. 설정 수정**:
```json
{
  "name": "my_batch",  // ← Job 이름 변경
  "collection": "collections/",  // ← YAML 파일 경로
  "excludePatterns": [
    "test_*",  // ← 제외할 파일 패턴 추가
    "*_backup.yaml"
  ]
}
```

**3. 실행**:
```bash
# 웹 대시보드에서 실행
# http://localhost:3000 → Jobs 목록에서 "my_batch" 실행

# 또는 API로 실행
curl -X POST http://localhost:3000/api/run/my_batch
```

---

### 방법 3: 특정 YAML 파일만 묶어서 실행

특정 YAML 파일들만 선택해서 배치 실행합니다.

#### 커스텀 배치 Job: `jobs/payment_batch.json`

```json
{
  "name": "payment_batch",
  "type": "binary",
  "description": "Payment related tests batch",
  "yamlFiles": [
    "collections/TDB_SKT.yaml",
    "collections/EXPREBILL-PCancel.yaml",
    "collections/settlement_test.yaml"
  ],
  "platforms": {
    "win32": {
      "executable": "SClient.exe",
      "path": "binaries/windows"
    }
  },
  "timeout": 60000,
  "encoding": "cp949",
  "generateHtmlReport": true,
  "reportOptions": {
    "title": "Payment Tests Report",
    "browserTitle": "Payment Batch"
  }
}
```

**특징**:
- `collection` 대신 `yamlFiles` 배열 사용
- 실행 순서 지정 가능
- 특정 파일만 선택 실행

---

## 📊 실전 예시

### 예시 1: 매일 오전 9시에 3개 API 테스트 실행

**config/schedules.json**:
```json
[
  {
    "name": "TDB_SKT",
    "cronExpr": "0 9 * * *"
  },
  {
    "name": "EXPREBILL-PCancel",
    "cronExpr": "0 9 * * *"
  },
  {
    "name": "settlement_test",
    "cronExpr": "0 9 * * *"
  }
]
```

**실행 결과**:
```
09:00:00 - TDB_SKT 실행 시작
09:01:30 - TDB_SKT 완료
09:01:30 - EXPREBILL-PCancel 실행 시작
09:03:00 - EXPREBILL-PCancel 완료
09:03:00 - settlement_test 실행 시작
09:04:20 - settlement_test 완료
```

---

### 예시 2: 결제 관련 테스트를 배치로 실행

**jobs/payment_all.json**:
```json
{
  "name": "payment_all",
  "type": "binary",
  "description": "All payment related tests",
  "collection": "collections/payment/",
  "platforms": {
    "win32": {
      "executable": "SClient.exe",
      "path": "binaries/windows"
    }
  },
  "timeout": 120000,
  "generateHtmlReport": true
}
```

**폴더 구조**:
```
collections/
└── payment/
    ├── TDB_SKT.yaml
    ├── EXPREBILL-PCancel.yaml
    ├── settlement_test.yaml
    └── refund_test.yaml
```

**실행**:
```bash
# 웹 대시보드 또는
curl -X POST http://localhost:3000/api/run/payment_all
```

---

### 예시 3: 시간대별 다른 Job 그룹 실행

**config/schedules.json**:
```json
[
  {
    "name": "morning_batch",
    "cronExpr": "0 9 * * *"
  },
  {
    "name": "afternoon_batch",
    "cronExpr": "0 14 * * *"
  },
  {
    "name": "evening_batch",
    "cronExpr": "0 18 * * *"
  }
]
```

**jobs/morning_batch.json**:
```json
{
  "name": "morning_batch",
  "type": "binary",
  "collection": "collections/morning/",
  "generateHtmlReport": true
}
```

**jobs/afternoon_batch.json**:
```json
{
  "name": "afternoon_batch",
  "type": "binary",
  "collection": "collections/afternoon/",
  "generateHtmlReport": true
}
```

---

## 🔧 스케줄 관리 명령어

### 스케줄 확인
```bash
# API로 확인
curl http://localhost:3000/api/schedule

# 또는 웹 대시보드에서 확인
# http://localhost:3000 → 스케줄 관리
```

### 스케줄 추가
```bash
curl -X POST http://localhost:3000/api/schedule \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"my_job\",\"cronExpr\":\"0 10 * * *\"}"
```

### 스케줄 삭제
```bash
curl -X DELETE http://localhost:3000/api/schedule/my_job
```

### 모든 스케줄 초기화
```bash
# config/schedules.json 파일을 빈 배열로 수정
echo [] > config\schedules.json

# 서버 재시작
pm2 restart 2uknow-api-monitor
```

---

## 🎯 추천 패턴

### 패턴 1: 시간대별 그룹 실행 (추천!)

```json
// config/schedules.json
[
  {
    "name": "morning_health_check",
    "cronExpr": "0 9 * * *"
  },
  {
    "name": "hourly_monitoring",
    "cronExpr": "0 * * * *"
  },
  {
    "name": "evening_summary",
    "cronExpr": "0 18 * * *"
  }
]
```

**장점**:
- 시간대별로 다른 테스트 실행
- 관리가 명확
- 로그/보고서 분리 용이

---

### 패턴 2: 카테고리별 배치 Job

```
jobs/
├── payment_batch.json      (결제 관련)
├── settlement_batch.json   (정산 관련)
└── refund_batch.json       (환불 관련)

collections/
├── payment/
│   ├── TDB_SKT.yaml
│   └── credit_card.yaml
├── settlement/
│   └── daily_settlement.yaml
└── refund/
    └── refund_test.yaml
```

**장점**:
- 카테고리별 관리
- 필요한 것만 실행 가능
- 보고서 분리

---

### 패턴 3: 중요도별 실행

```json
// config/schedules.json
[
  {
    "name": "critical_tests",
    "cronExpr": "0 */2 * * *"  // 2시간마다
  },
  {
    "name": "normal_tests",
    "cronExpr": "0 9,18 * * *"  // 오전 9시, 오후 6시
  },
  {
    "name": "low_priority_tests",
    "cronExpr": "0 0 * * 0"  // 매주 일요일
  }
]
```

**장점**:
- 중요한 테스트는 자주 실행
- 덜 중요한 테스트는 주기 길게
- 리소스 효율적 사용

---

## 🚨 주의사항

### 1. 동시 실행 방지

시스템에는 **큐 시스템**이 내장되어 있습니다:
- 같은 시간에 여러 job이 스케줄되어도 순차적으로 실행
- 하나가 완료될 때까지 다음 job 대기
- 자동 재시도 기능 포함

### 2. 타임아웃 설정

배치 job은 개별 job보다 시간이 오래 걸리므로:
```json
{
  "timeout": 120000,  // 2분 (기본 60초)
  "maxRetries": 3     // 재시도 횟수
}
```

### 3. 메모리 관리

많은 job을 배치로 실행하면 메모리 사용량 증가:
- PM2 메모리 제한 조정 필요
- `ecosystem.config.js`에서 `max_memory_restart: '1G'`

### 4. 로그 확인

배치 실행 시 로그 확인:
```bash
pm2 logs 2uknow-api-monitor --lines 100
```

---

## 💡 실전 팁

### 팁 1: 테스트 먼저 실행

스케줄 등록 전에 수동으로 테스트:
```bash
# 웹 대시보드에서 실행 테스트
# http://localhost:3000 → Jobs → 실행 버튼

# 또는 API로
curl -X POST http://localhost:3000/api/run/my_batch
```

### 팁 2: 실행 이력 확인

웹 대시보드에서 실행 이력 확인:
```
http://localhost:3000 → History
```

### 팁 3: Naver Works 알림 활용

배치 실행 결과를 Naver Works로 알림:
```json
// config/settings.json
{
  "run_event_alert": true,
  "alert_on_start": true,
  "alert_on_success": true,
  "alert_on_error": true,
  "alert_method": "flex"
}
```

### 팁 4: 시간대 고려

한국 시간 기준으로 설정:
```json
// config/settings.json
{
  "timezone": "Asia/Seoul"
}
```

---

## 📋 빠른 참조

### 스케줄 파일 위치
```
config/schedules.json
```

### Job 파일 위치
```
jobs/*.json
```

### YAML 파일 위치
```
collections/*.yaml
```

### 스케줄 관리 API
```bash
GET    /api/schedule        # 목록 조회
POST   /api/schedule        # 추가
DELETE /api/schedule/:name  # 삭제
```

### Job 실행 API
```bash
POST /api/run/:jobName
```

---

## 🎯 완성된 예시

### 실전 예시: 매일 오전/오후 API 모니터링

**1. schedules.json**:
```json
[
  {
    "name": "morning_check",
    "cronExpr": "0 9 * * *"
  },
  {
    "name": "afternoon_check",
    "cronExpr": "0 14 * * *"
  }
]
```

**2. jobs/morning_check.json**:
```json
{
  "name": "morning_check",
  "type": "binary",
  "collection": "collections/critical/",
  "generateHtmlReport": true,
  "reportOptions": {
    "title": "Morning Health Check"
  }
}
```

**3. jobs/afternoon_check.json**:
```json
{
  "name": "afternoon_check",
  "type": "binary",
  "collection": "collections/all/",
  "excludePatterns": ["*test*"],
  "generateHtmlReport": true,
  "reportOptions": {
    "title": "Afternoon Full Check"
  }
}
```

**결과**:
- 매일 오전 9시: 중요 API만 테스트
- 매일 오후 2시: 전체 API 테스트
- 각각 별도 HTML 보고서 생성
- Naver Works 알림 전송

---

## ✅ 체크리스트

Job 묶어서 등록 시:

- [ ] `config/schedules.json` 파일 확인
- [ ] Job 파일 (`jobs/*.json`) 생성
- [ ] Cron 표현식 검증
- [ ] 타임아웃 설정 확인
- [ ] 메모리 제한 조정 (필요시)
- [ ] 수동 실행으로 테스트
- [ ] 로그 확인
- [ ] 알림 설정 확인
- [ ] 보고서 생성 확인
- [ ] PM2 설정 저장 (`pm2 save`)

---

**이제 여러 Job을 효율적으로 관리할 수 있습니다!** 🚀
