# PM2 운영 가이드

## 🚀 시작하기

### 초기 실행
```bash
# 설정 파일로 실행
pm2 start ecosystem.config.js

# 또는 직접 실행
pm2 start server.js --name 2uknow-api-monitor
```

### Windows 시작 시 자동 실행 설정
```bash
# 현재 실행 중인 앱을 시작 프로그램으로 등록
pm2 save

# Windows 시작 시 PM2 자동 실행 설정
pm2 startup
```

---

## 📊 모니터링 명령어

### 실시간 모니터링
```bash
# 대시보드 (CPU/메모리/로그 실시간)
pm2 monit

# 간단한 상태 확인
pm2 status
pm2 ls

# 특정 앱 정보
pm2 show 2uknow-api-monitor

# 실시간 로그 스트리밍
pm2 logs

# 특정 앱 로그만 보기
pm2 logs 2uknow-api-monitor

# 에러 로그만 보기
pm2 logs --err

# 최근 200라인 로그
pm2 logs --lines 200
```

### 성능 통계
```bash
# 메모리/CPU 사용량
pm2 describe 2uknow-api-monitor

# 상세 통계
pm2 show 2uknow-api-monitor
```

---

## 🔧 관리 명령어

### 재시작/중지
```bash
# 재시작 (무중단)
pm2 reload 2uknow-api-monitor

# 재시작 (중단 후 시작)
pm2 restart 2uknow-api-monitor

# 중지
pm2 stop 2uknow-api-monitor

# 완전 삭제
pm2 delete 2uknow-api-monitor

# 모든 앱 재시작
pm2 restart all

# 모든 앱 중지
pm2 stop all
```

### 설정 변경 후 적용
```bash
# ecosystem.config.js 수정 후
pm2 reload ecosystem.config.js

# 또는
pm2 delete 2uknow-api-monitor
pm2 start ecosystem.config.js
```

### 환경 변수 변경
```bash
# 개발 모드로 실행
pm2 start ecosystem.config.js --env development

# 프로덕션 모드로 실행
pm2 start ecosystem.config.js --env production
```

---

## 📈 클러스터 모드 전환 (부하 높을 시)

### ecosystem.config.js 수정
```javascript
// 단일 인스턴스 → 클러스터 모드 변경
instances: 4,  // 4개 워커 (CPU 코어 수에 맞춰 조정)
exec_mode: 'cluster',
```

### 적용
```bash
pm2 reload ecosystem.config.js
```

### 클러스터 모드 확인
```bash
pm2 ls
# NAME                  MODE      ↺     STATUS
# 2uknow-api-monitor    cluster   0     online
```

---

## 🔍 트러블슈팅

### 로그 확인
```bash
# 전체 로그
pm2 logs

# 에러만
pm2 logs --err

# 로그 파일 직접 확인
cat logs/pm2-error.log
cat logs/pm2-out.log
```

### 메모리 누수 의심 시
```bash
# 메모리 사용량 확인
pm2 monit

# 강제 재시작
pm2 restart 2uknow-api-monitor

# 메모리 제한 변경 (ecosystem.config.js)
max_memory_restart: '1G'
```

### 앱이 계속 재시작될 때
```bash
# 상세 에러 확인
pm2 logs --err --lines 100

# 재시작 카운트 확인
pm2 ls

# max_restarts 도달 시 수동 재시작
pm2 delete 2uknow-api-monitor
pm2 start ecosystem.config.js
```

### PM2 자체 문제 시
```bash
# PM2 프로세스 종료
pm2 kill

# PM2 재시작
pm2 resurrect

# 또는 완전 초기화
pm2 kill
pm2 start ecosystem.config.js
```

---

## ⏰ Cron 자동 재시작 설정

### Cron 재시작이란?
특정 시간에 자동으로 애플리케이션을 재시작하여 메모리 누수 방지 및 시스템 최적화를 수행합니다.

### Cron 표현식 형식
```
* * * * *
│ │ │ │ │
│ │ │ │ └─ 요일 (0-7, 0과 7은 일요일)
│ │ │ └─── 월 (1-12)
│ │ └───── 일 (1-31)
│ └─────── 시 (0-23)
└───────── 분 (0-59)
```

### 자주 사용하는 Cron 패턴

#### 일일 재시작
```javascript
// ecosystem.config.js
cron_restart: '0 4 * * *',  // 매일 새벽 4시
```

#### 주기적 재시작
```javascript
// 6시간마다
cron_restart: '0 */6 * * *',

// 12시간마다 (자정, 정오)
cron_restart: '0 0,12 * * *',

// 30분마다 (테스트용, 프로덕션 비추천)
cron_restart: '*/30 * * * *',
```

#### 주간/월간 재시작
```javascript
// 매주 일요일 새벽 3시
cron_restart: '0 3 * * 0',

// 매주 월요일 새벽 2시
cron_restart: '0 2 * * 1',

// 평일 새벽 4시 (월-금)
cron_restart: '0 4 * * 1-5',

// 주말 새벽 5시 (토, 일)
cron_restart: '0 5 * * 0,6',

// 매월 1일 새벽 3시
cron_restart: '0 3 1 * *',
```

#### 복잡한 패턴
```javascript
// 평일 업무시간 외 (새벽 2시)
cron_restart: '0 2 * * 1-5',

// 특정 시간 범위 (새벽 2-4시 사이 매시)
cron_restart: '0 2-4 * * *',

// 15분 간격 (매시 0, 15, 30, 45분)
cron_restart: '0,15,30,45 * * * *',
```

### Cron 설정 적용 방법

#### 1. ecosystem.config.js 수정
```javascript
module.exports = {
  apps: [{
    name: '2uknow-api-monitor',
    script: './server.js',
    cron_restart: '0 4 * * *',  // 매일 새벽 4시 재시작
    // ... 기타 설정
  }]
};
```

#### 2. PM2에 적용
```bash
# 기존 앱 중지
pm2 stop 2uknow-api-monitor

# 새 설정으로 시작
pm2 start ecosystem.config.js

# 또는 삭제 후 재시작
pm2 delete 2uknow-api-monitor
pm2 start ecosystem.config.js

# 설정 저장
pm2 save
```

#### 3. Cron 설정 확인
```bash
# 앱 상세 정보 확인
pm2 show 2uknow-api-monitor

# cron_restart 필드 확인
pm2 describe 2uknow-api-monitor | grep cron
```

### Cron vs 수동 재시작

| 방식 | 장점 | 단점 | 추천 용도 |
|------|------|------|-----------|
| **Cron 자동** | 관리 불필요, 일관성 | 고정 시간 | 메모리 누수 방지 |
| **수동 재시작** | 유연성, 제어 가능 | 관리 필요 | 긴급 상황 |
| **메모리 제한** | 즉시 대응 | 예측 불가 | 메모리 보호 |

### 권장 Cron 설정

#### 고부하 환경 (시간당 100회+)
```javascript
// 매일 새벽 4시 재시작 (메모리 정리)
cron_restart: '0 4 * * *',
```

#### 중간 부하 환경
```javascript
// 매주 일요일 새벽 3시
cron_restart: '0 3 * * 0',
```

#### 저부하 환경
```javascript
// 매월 1일 새벽 2시
cron_restart: '0 2 1 * *',
```

### Cron 재시작 로그 확인

#### 재시작 이력 확인
```bash
# PM2 로그에서 cron 재시작 확인
pm2 logs | grep -i "cron"

# 또는 로그 파일 직접 확인
cat logs/pm2-out.log | grep -i "restart"
```

#### 재시작 카운트 확인
```bash
# 재시작 횟수 확인
pm2 ls

# NAME                  ↺     RESTART
# 2uknow-api-monitor    3     (cron 포함)
```

### Cron 비활성화

#### 임시 비활성화
```javascript
// ecosystem.config.js에서 주석 처리
// cron_restart: '0 4 * * *',
```

#### 완전 제거
```bash
# 앱 삭제 후 cron 없이 재시작
pm2 delete 2uknow-api-monitor
pm2 start server.js --name 2uknow-api-monitor
```

### Cron 재시작 vs 일반 재시작

```bash
# Cron 재시작 (자동, 예약)
# - 설정된 시간에 자동 실행
# - 무중단 재시작 (reload 방식)
# - 로그에 "cron restart" 기록

# 수동 재시작
pm2 restart 2uknow-api-monitor

# 무중단 재시작 (클러스터 모드)
pm2 reload 2uknow-api-monitor
```

### 고급 Cron 활용

#### 다중 환경 별도 설정
```javascript
module.exports = {
  apps: [
    {
      name: 'api-dev',
      script: './server.js',
      cron_restart: '0 */6 * * *',  // 개발: 6시간마다
      env: { NODE_ENV: 'development' }
    },
    {
      name: 'api-prod',
      script: './server.js',
      cron_restart: '0 4 * * *',    // 프로덕션: 매일 새벽 4시
      env: { NODE_ENV: 'production' }
    }
  ]
};
```

#### Cron + 메모리 제한 조합
```javascript
{
  name: '2uknow-api-monitor',
  script: './server.js',
  max_memory_restart: '800M',    // 800MB 초과 시 즉시 재시작
  cron_restart: '0 4 * * *',     // 매일 새벽 4시 정기 재시작
}
```

### Cron 재시작 알림 설정

#### Naver Works 알림 연동 (선택사항)
```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: '2uknow-api-monitor',
    script: './server.js',
    cron_restart: '0 4 * * *',
    // 재시작 시 Naver Works 알림
    restart_delay: 3000,
    autorestart: true,
  }]
};
```

#### 커스텀 알림 스크립트
```bash
# restart-notify.sh
#!/bin/bash
pm2 restart 2uknow-api-monitor
curl -X POST "webhook_url" -d '{"text":"API Monitor 재시작 완료"}'
```

### Cron 설정 테스트

#### 테스트용 짧은 주기 설정
```javascript
// ecosystem.config.js (테스트용)
cron_restart: '*/2 * * * *',  // 2분마다 재시작
```

#### 테스트 실행
```bash
# 설정 적용
pm2 restart ecosystem.config.js

# 로그 모니터링 (2분마다 재시작 확인)
pm2 logs --lines 100

# 테스트 완료 후 원래 설정으로 복원
# ecosystem.config.js 수정 후
pm2 restart ecosystem.config.js
```

### Cron 문제 해결

#### Cron이 작동하지 않을 때
1. **설정 확인**
   ```bash
   pm2 show 2uknow-api-monitor
   # cron_restart 값 확인
   ```

2. **PM2 버전 확인**
   ```bash
   pm2 -v
   # 최신 버전 권장 (5.0+)
   npm update -g pm2
   ```

3. **타임존 확인**
   ```bash
   # Windows 시간대 확인
   tzutil /g

   # PM2는 시스템 시간대 사용
   # 한국 시간 기준으로 Cron 설정
   ```

4. **로그 확인**
   ```bash
   pm2 logs --err
   # Cron 관련 에러 메시지 확인
   ```

### 시간당 100회 부하 환경 권장 설정

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: '2uknow-api-monitor',
    script: './server.js',

    // 메모리 관리
    max_memory_restart: '800M',

    // 정기 재시작 (매일 새벽 4시)
    cron_restart: '0 4 * * *',

    // 자동 재시작 설정
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 3000,

    // 로그 관리
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
  }]
};
```

**이유**:
- **매일 새벽 4시**: 사용량 적은 시간대, 메모리 정리
- **800M 제한**: 비정상 메모리 증가 즉시 대응
- **자동 재시작**: 크래시 시 즉시 복구

---

## 🌐 웹 모니터링 (선택사항)

### PM2 Plus 연동
1. https://pm2.io 가입
2. 연동 명령 실행
```bash
pm2 link [secret_key] [public_key]
```
3. 웹 대시보드에서 실시간 모니터링

**기능**:
- 실시간 CPU/메모리 그래프
- 에러 알림
- 원격 재시작
- 로그 검색

---

## 📝 유용한 팁

### 로그 정리
```bash
# 로그 파일 비우기
pm2 flush

# 또는 수동 삭제
rm logs/pm2-*.log
```

### 설정 백업
```bash
# 현재 실행 중인 앱 목록 저장
pm2 save

# 저장된 설정으로 복원
pm2 resurrect
```

### 다중 환경 관리
```bash
# 개발 서버
pm2 start ecosystem.config.js --env development --name api-dev

# 프로덕션 서버
pm2 start ecosystem.config.js --env production --name api-prod
```

---

## 🎯 권장 운영 방식

### 일일 체크리스트
```bash
# 1. 상태 확인
pm2 status

# 2. 메모리 사용량 확인
pm2 monit

# 3. 최근 에러 확인
pm2 logs --err --lines 50
```

### 주간 유지보수
```bash
# 1. 로그 로테이션 확인
ls -lh logs/

# 2. PM2 업데이트
npm update -g pm2

# 3. 설정 백업
pm2 save
```

### 월간 최적화
```bash
# 1. 메모리 정리 (재시작)
pm2 restart all

# 2. 오래된 로그 삭제
find logs/ -name "*.log" -mtime +30 -delete

# 3. Node.js 업데이트 확인
node -v
npm -v
```

---

## 📞 문제 발생 시 체크포인트

1. **앱이 시작되지 않을 때**
   - `pm2 logs --err` 에러 확인
   - `node server.js` 직접 실행해보기
   - 포트 충돌 확인 (`netstat -ano | findstr :3000`)

2. **메모리 사용량이 계속 증가할 때**
   - `max_memory_restart` 값 낮추기
   - Newman 작업 동시 실행 수 제한
   - 로그 파일 크기 확인

3. **성능이 느릴 때**
   - 클러스터 모드 활성화
   - `instances` 수 증가 (2 → 4 → 8)
   - SSD 디스크 여유 공간 확인

4. **자동 재시작이 안 될 때**
   - `pm2 startup` 재실행
   - Windows 작업 스케줄러 확인
   - `pm2 save` 실행 확인
