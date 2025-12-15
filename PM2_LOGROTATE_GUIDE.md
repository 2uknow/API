# PM2 Log Rotation 가이드 (로그 로테이션)

## 📁 로그 로테이션이란?

로그 파일이 계속 커지는 것을 방지하기 위해:
- **자동으로 로그 파일 분할**
- **오래된 로그 압축 및 삭제**
- **디스크 공간 관리**

시간당 100회 실행 환경에서는 **필수 기능**입니다!

---

## 🚀 빠른 시작

### 1단계: pm2-logrotate 설치
```bash
# PM2 로그 로테이션 모듈 설치
pm2 install pm2-logrotate

# 설치 확인
pm2 ls
# pm2-logrotate가 목록에 나타남
```

### 2단계: 기본 설정 확인
```bash
# 현재 설정 보기
pm2 get pm2-logrotate:max_size
pm2 get pm2-logrotate:retain
pm2 get pm2-logrotate:compress
```

### 3단계: 권장 설정 적용
```bash
# 로그 파일 크기 제한 (10MB)
pm2 set pm2-logrotate:max_size 10M

# 보관할 로그 파일 개수 (10개)
pm2 set pm2-logrotate:retain 10

# 오래된 로그 압축 활성화
pm2 set pm2-logrotate:compress true

# 로그 확인 주기 (30초마다)
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'

# 로그 로테이션 간격 (매일 자정)
pm2 set pm2-logrotate:rotateModule true
```

---

## ⚙️ 상세 설정 옵션

### 파일 크기 기반 로테이션

#### max_size (최대 파일 크기)
```bash
# 10MB (권장 - 시간당 100회)
pm2 set pm2-logrotate:max_size 10M

# 50MB (로그 많이 쌓이는 환경)
pm2 set pm2-logrotate:max_size 50M

# 100MB (대용량 로그)
pm2 set pm2-logrotate:max_size 100M

# 1KB (테스트용)
pm2 set pm2-logrotate:max_size 1K
```

**단위**:
- `K` = 킬로바이트
- `M` = 메가바이트
- `G` = 기가바이트

### 파일 개수 관리

#### retain (보관할 파일 개수)
```bash
# 10개 보관 (약 1-2주 분량)
pm2 set pm2-logrotate:retain 10

# 30개 보관 (약 1개월 분량)
pm2 set pm2-logrotate:retain 30

# 100개 보관 (장기 보관)
pm2 set pm2-logrotate:retain 100

# 모든 파일 보관 (디스크 주의!)
pm2 set pm2-logrotate:retain all
```

### 압축 옵션

#### compress (압축 활성화)
```bash
# 압축 활성화 (gzip)
pm2 set pm2-logrotate:compress true

# 압축 비활성화
pm2 set pm2-logrotate:compress false
```

**압축 효과**:
- 텍스트 로그: **약 90% 압축**
- 10MB → 1MB로 축소
- 디스크 공간 크게 절약

### 날짜/시간 기반 로테이션

#### rotateInterval (로테이션 간격)
```bash
# 매일 자정 (권장)
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'

# 매 시간마다
pm2 set pm2-logrotate:rotateInterval '0 * * * *'

# 6시간마다
pm2 set pm2-logrotate:rotateInterval '0 */6 * * *'

# 매주 일요일 자정
pm2 set pm2-logrotate:rotateInterval '0 0 * * 0'

# 매일 새벽 4시
pm2 set pm2-logrotate:rotateInterval '0 4 * * *'
```

**Cron 형식**: `분 시 일 월 요일`

### 로그 파일 경로

#### workerInterval (확인 주기)
```bash
# 30초마다 확인 (기본값)
pm2 set pm2-logrotate:workerInterval 30

# 60초마다 확인 (부하 줄이기)
pm2 set pm2-logrotate:workerInterval 60

# 10초마다 확인 (빠른 로테이션)
pm2 set pm2-logrotate:workerInterval 10
```

### 날짜 포맷

#### dateFormat (로그 파일 날짜 형식)
```bash
# 기본 형식: YYYY-MM-DD_HH-mm-ss
pm2 set pm2-logrotate:dateFormat 'YYYY-MM-DD_HH-mm-ss'

# 한국 형식: YYYY년MM월DD일
pm2 set pm2-logrotate:dateFormat 'YYYY년MM월DD일'

# 간단한 형식: YYYYMMDD
pm2 set pm2-logrotate:dateFormat 'YYYYMMDD'
```

---

## 🎯 환경별 권장 설정

### 고부하 환경 (시간당 100회+)
```bash
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 30
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 4 * * *'
pm2 set pm2-logrotate:workerInterval 30
```

**효과**:
- 로그 파일 10MB마다 자동 분할
- 최근 30개 파일만 보관 (약 1개월)
- 오래된 로그 gzip 압축 (90% 절약)
- 매일 새벽 4시 강제 로테이션

### 중간 부하 환경
```bash
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 10
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * 0'
```

### 저부하 환경
```bash
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 5
pm2 set pm2-logrotate:compress false
pm2 set pm2-logrotate:rotateInterval '0 0 1 * *'
```

---

## 📊 로그 파일 구조

### 로테이션 전
```
logs/
├── pm2-out.log       (10MB - 계속 증가 중)
└── pm2-error.log     (5MB - 계속 증가 중)
```

### 로테이션 후
```
logs/
├── pm2-out.log                          (현재 로그, 0KB부터 시작)
├── pm2-out__2025-01-06_10-30-00.log    (이전 로그)
├── pm2-out__2025-01-05_10-30-00.log.gz (압축된 로그)
├── pm2-out__2025-01-04_10-30-00.log.gz
├── pm2-error.log                        (현재 에러 로그)
├── pm2-error__2025-01-06_10-30-00.log
└── pm2-error__2025-01-05_10-30-00.log.gz
```

---

## 🔍 로그 확인 및 관리

### 현재 로그 확인
```bash
# 실시간 로그 스트리밍
pm2 logs

# 최근 100줄
pm2 logs --lines 100

# 에러만
pm2 logs --err

# 특정 앱만
pm2 logs 2uknow-api-monitor
```

### 로그 파일 직접 확인
```bash
# 현재 로그
cat logs/pm2-out.log
cat logs/pm2-error.log

# 이전 로그 (압축된 경우)
zcat logs/pm2-out__2025-01-05_10-30-00.log.gz

# 또는 압축 해제 후 확인
gzip -d logs/pm2-out__2025-01-05_10-30-00.log.gz
cat logs/pm2-out__2025-01-05_10-30-00.log
```

### 로그 검색
```bash
# 에러 검색
grep -i "error" logs/pm2-error.log

# 특정 날짜 검색
grep "2025-01-06" logs/pm2-out.log

# 여러 파일에서 검색
grep -r "Newman" logs/

# 압축 파일 검색
zgrep "error" logs/*.gz
```

### 로그 파일 크기 확인
```bash
# 로그 디렉토리 전체 크기
du -sh logs/

# 파일별 크기
ls -lh logs/

# 압축 효과 확인
ls -lh logs/ | grep .gz
```

---

## 🔧 관리 명령어

### pm2-logrotate 상태 확인
```bash
# 모듈 상태
pm2 ls

# 상세 정보
pm2 show pm2-logrotate

# 모든 설정 보기
pm2 conf pm2-logrotate
```

### 설정 초기화
```bash
# 특정 설정 삭제
pm2 unset pm2-logrotate:max_size

# 모듈 재설치 (완전 초기화)
pm2 uninstall pm2-logrotate
pm2 install pm2-logrotate
```

### 강제 로테이션 실행
```bash
# 수동 로테이션 트리거
pm2 flush

# 또는 모듈 재시작
pm2 restart pm2-logrotate
```

### 로그 완전 삭제
```bash
# 모든 로그 파일 비우기
pm2 flush

# 로그 파일 수동 삭제
rm -f logs/pm2-*.log*

# 오래된 압축 파일만 삭제 (30일 이상)
find logs/ -name "*.gz" -mtime +30 -delete
```

---

## 🎨 고급 활용

### 애플리케이션별 로그 분리

#### ecosystem.config.js 설정
```javascript
module.exports = {
  apps: [
    {
      name: '2uknow-api-monitor',
      script: './server.js',

      // 로그 파일 경로 지정
      error_file: './logs/app-error.log',
      out_file: './logs/app-out.log',

      // 로그 합치기
      merge_logs: true,

      // 로그 날짜 포맷
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // 로그 타입
      log_type: 'json',  // 'json' 또는 일반 텍스트
    }
  ]
};
```

### JSON 형식 로그
```bash
# JSON 로그 활성화
pm2 set pm2-logrotate:TZ 'Asia/Seoul'

# 로그 파일 구조
{
  "message": "API test completed",
  "timestamp": "2025-01-06T10:30:00+09:00",
  "type": "out",
  "process_id": 12345,
  "app_name": "2uknow-api-monitor"
}
```

### 원격 로그 전송 (Syslog)
```bash
# Syslog 서버로 로그 전송
pm2 install pm2-syslog
pm2 set pm2-syslog:server 'syslog.example.com:514'
```

---

## 🚨 트러블슈팅

### 로테이션이 작동하지 않을 때

#### 1. 모듈 상태 확인
```bash
pm2 ls
# pm2-logrotate가 'online' 상태인지 확인
```

#### 2. 설정 확인
```bash
pm2 conf pm2-logrotate
# 모든 설정값이 올바른지 확인
```

#### 3. 모듈 재시작
```bash
pm2 restart pm2-logrotate
```

#### 4. 로그 권한 확인
```bash
# Windows에서 로그 폴더 권한 확인
icacls logs/

# 권한 문제 시 재생성
rm -rf logs/
mkdir logs
```

### 로그 파일이 너무 많을 때
```bash
# retain 값 줄이기
pm2 set pm2-logrotate:retain 5

# 오래된 파일 수동 삭제
find logs/ -name "*.log*" -mtime +7 -delete
```

### 디스크 공간 부족
```bash
# 압축 활성화
pm2 set pm2-logrotate:compress true

# 파일 크기 줄이기
pm2 set pm2-logrotate:max_size 5M

# 보관 기간 단축
pm2 set pm2-logrotate:retain 5
```

---

## 📈 모니터링 및 알림

### 로그 크기 모니터링 스크립트
```bash
# check-logs.sh
#!/bin/bash

LOG_DIR="./logs"
MAX_SIZE=100  # MB

TOTAL_SIZE=$(du -sm $LOG_DIR | cut -f1)

if [ $TOTAL_SIZE -gt $MAX_SIZE ]; then
    echo "Warning: Log directory size ($TOTAL_SIZE MB) exceeds limit ($MAX_SIZE MB)"
    # Naver Works 알림 전송
    curl -X POST "webhook_url" -d "{\"text\":\"로그 용량 경고: ${TOTAL_SIZE}MB\"}"
fi
```

### Windows 작업 스케줄러 등록
```powershell
# PowerShell 스크립트
$logSize = (Get-ChildItem -Path ".\logs" -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB

if ($logSize -gt 100) {
    Write-Host "Warning: Log size is $logSize MB"
    # 알림 전송 로직
}
```

---

## 💡 베스트 프랙티스

### 1. 적절한 크기 설정
```bash
# 너무 작으면: 파일 너무 많이 생성
# 너무 크면: 검색 어려움
# 권장: 10-50MB
pm2 set pm2-logrotate:max_size 10M
```

### 2. 압축 활성화
```bash
# 디스크 공간 90% 절약
pm2 set pm2-logrotate:compress true
```

### 3. 적절한 보관 기간
```bash
# 너무 많으면: 디스크 낭비
# 너무 적으면: 과거 로그 분석 불가
# 권장: 10-30개 (1-4주)
pm2 set pm2-logrotate:retain 10
```

### 4. 정기 로테이션 + 크기 제한
```bash
# 크기 제한: 10MB
pm2 set pm2-logrotate:max_size 10M

# 시간 제한: 매일 새벽 4시
pm2 set pm2-logrotate:rotateInterval '0 4 * * *'
```

### 5. 로그 레벨 조정
```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: '2uknow-api-monitor',
    script: './server.js',

    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info'  // debug, info, warn, error
    }
  }]
};
```

---

## 📋 완전한 설정 예시

### 시간당 100회 환경 최적화 설정
```bash
#!/bin/bash
# setup-logrotate.sh

# PM2 로그 로테이션 설치
pm2 install pm2-logrotate

# 파일 크기 제한 (10MB)
pm2 set pm2-logrotate:max_size 10M

# 보관 파일 개수 (30개 = 약 1개월)
pm2 set pm2-logrotate:retain 30

# 압축 활성화
pm2 set pm2-logrotate:compress true

# 매일 새벽 4시 로테이션
pm2 set pm2-logrotate:rotateInterval '0 4 * * *'

# 30초마다 확인
pm2 set pm2-logrotate:workerInterval 30

# 날짜 형식
pm2 set pm2-logrotate:dateFormat 'YYYY-MM-DD_HH-mm-ss'

# 타임존 (한국)
pm2 set pm2-logrotate:TZ 'Asia/Seoul'

# 설정 저장
pm2 save

echo "PM2 Log Rotation 설정 완료!"
```

### 실행
```bash
chmod +x setup-logrotate.sh
./setup-logrotate.sh
```

---

## 🎯 빠른 참조

| 명령어 | 설명 |
|--------|------|
| `pm2 install pm2-logrotate` | 로그 로테이션 설치 |
| `pm2 set pm2-logrotate:max_size 10M` | 최대 크기 10MB |
| `pm2 set pm2-logrotate:retain 10` | 10개 파일 보관 |
| `pm2 set pm2-logrotate:compress true` | 압축 활성화 |
| `pm2 conf pm2-logrotate` | 전체 설정 보기 |
| `pm2 flush` | 로그 비우기 |
| `pm2 restart pm2-logrotate` | 모듈 재시작 |
| `pm2 uninstall pm2-logrotate` | 모듈 제거 |

---

## ✅ 설정 완료 체크리스트

```bash
# ✅ 1. 모듈 설치 확인
pm2 ls | grep logrotate

# ✅ 2. 설정 확인
pm2 conf pm2-logrotate

# ✅ 3. 테스트 로그 생성
pm2 logs

# ✅ 4. 로그 파일 확인
ls -lh logs/

# ✅ 5. 로테이션 테스트 (max_size를 작게 설정 후)
pm2 set pm2-logrotate:max_size 1K
pm2 logs --lines 1000  # 많은 로그 생성
ls -lh logs/  # 새 파일 생성 확인

# ✅ 6. 원래 설정 복원
pm2 set pm2-logrotate:max_size 10M
```

---

**모든 설정이 완료되었습니다!** 🎉

로그가 자동으로 관리되며 디스크 공간 걱정이 없습니다.
