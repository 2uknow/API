# PM2 다중 환경 관리 가이드

## 🎯 PM2 이름(name) vs 실행 파일(script)

### 핵심 개념

```javascript
{
  name: 'my-app',       // ← PM2 명령어에서 사용하는 라벨 (별명)
  script: './server.js' // ← 실제 실행되는 파일 (이것이 진짜!)
}
```

**PM2가 실행하는 것**:
```bash
# PM2 내부적으로 이렇게 실행됨
node /절대경로/server.js
```

**name의 역할**:
- PM2 명령어에서 앱을 식별하는 ID
- 마음대로 변경 가능
- 여러 앱을 구분하는 라벨

---

## 🏢 회사 레포 적용 시나리오

### 상황
- **개인 레포**: `D:\API\2uknow-api-monitor` (포트 3000)
- **회사 레포**: `D:\API\company-api-monitor` (포트 3001)
- **소스 코드**: 동일 (server.js)
- **설정**: 다르게 관리하고 싶음

---

## 📋 방법 1: 각 레포에 별도 설정 파일 (추천!)

### 개인 레포 설정
**파일**: `D:\API\2uknow-api-monitor\ecosystem.config.js`

```javascript
module.exports = {
  apps: [{
    name: 'personal-api-monitor',  // 개인 레포 이름
    script: './server.js',
    cwd: './',

    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },

    max_memory_restart: '800M',
    cron_restart: '0 4 * * *',

    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
  }]
};
```

### 회사 레포 설정
**파일**: `D:\API\company-api-monitor\ecosystem.config.js`

```javascript
module.exports = {
  apps: [{
    name: 'company-api-monitor',   // 회사 레포 이름
    script: './server.js',          // 동일한 파일명
    cwd: './',

    env: {
      NODE_ENV: 'production',
      PORT: 3001                    // 다른 포트!
    },

    max_memory_restart: '1G',       // 다른 메모리 제한
    cron_restart: '0 3 * * *',      // 다른 재시작 시간

    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
  }]
};
```

### 실행 방법
```bash
# 개인 레포 시작
cd D:\API\2uknow-api-monitor
pm2 start ecosystem.config.js

# 회사 레포 시작
cd D:\API\company-api-monitor
pm2 start ecosystem.config.js

# 두 앱 모두 실행 확인
pm2 ls
```

### 결과
```
┌─────────────────────────┬─────┬─────────┬────────┬─────┐
│ name                    │ id  │ mode    │ status │ port│
├─────────────────────────┼─────┼─────────┼────────┼─────┤
│ personal-api-monitor    │ 0   │ fork    │ online │ 3000│
│ company-api-monitor     │ 1   │ fork    │ online │ 3001│
└─────────────────────────┴─────┴─────────┴────────┴─────┘
```

---

## 📋 방법 2: 하나의 설정 파일로 관리

### 설정 파일 (어디든 위치 가능)
**파일**: `D:\PM2-Config\api-monitors.config.js`

```javascript
module.exports = {
  apps: [
    // 개인 레포
    {
      name: 'personal-monitor',
      script: './server.js',
      cwd: 'D:/API/2uknow-api-monitor',  // 절대 경로
      env: { PORT: 3000 }
    },

    // 회사 레포
    {
      name: 'company-monitor',
      script: './server.js',
      cwd: 'D:/API/company-api-monitor',  // 절대 경로
      env: { PORT: 3001 }
    }
  ]
};
```

### 실행 방법
```bash
# 모든 앱 시작
pm2 start D:\PM2-Config\api-monitors.config.js

# 개인 레포만 시작
pm2 start D:\PM2-Config\api-monitors.config.js --only personal-monitor

# 회사 레포만 시작
pm2 start D:\PM2-Config\api-monitors.config.js --only company-monitor
```

---

## 📋 방법 3: 환경 변수로 동적 설정

### 설정 파일
**파일**: `ecosystem.dynamic.config.js` (각 레포에 복사)

```javascript
const isCompany = process.env.IS_COMPANY === 'true';

module.exports = {
  apps: [{
    name: isCompany ? 'company-monitor' : 'personal-monitor',
    script: './server.js',
    env: {
      PORT: isCompany ? 3001 : 3000
    }
  }]
};
```

### 실행 방법
```bash
# 개인 레포
cd D:\API\2uknow-api-monitor
SET IS_COMPANY=false
pm2 start ecosystem.dynamic.config.js

# 회사 레포
cd D:\API\company-api-monitor
SET IS_COMPANY=true
pm2 start ecosystem.dynamic.config.js
```

---

## 🎯 각 방법 비교

| 방법 | 장점 | 단점 | 추천 |
|------|------|------|------|
| **방법 1: 각 레포 별도 설정** | 간단, 독립적 관리 | 설정 중복 | ⭐⭐⭐⭐⭐ |
| **방법 2: 중앙 집중 관리** | 한 곳에서 모든 관리 | 경로 의존성 | ⭐⭐⭐ |
| **방법 3: 동적 설정** | 유연성 높음 | 복잡함 | ⭐⭐ |

---

## 🔧 실전 관리 명령어

### 개별 앱 관리
```bash
# 개인 레포 재시작
pm2 restart personal-api-monitor

# 회사 레포 재시작
pm2 restart company-api-monitor

# 개인 레포 로그
pm2 logs personal-api-monitor

# 회사 레포 로그
pm2 logs company-api-monitor
```

### 그룹 관리 (선택사항)
```javascript
// ecosystem.config.js
{
  name: 'personal-monitor',
  script: './server.js',
  env: {
    PM2_APP_GROUP: 'monitors'  // 그룹 태그
  }
}
```

```bash
# 그룹별 관리는 PM2에서 직접 지원하지 않음
# 대신 패턴 매칭 사용
pm2 restart /.*-monitor/
```

---

## 🌐 포트 관리

### 포트 충돌 방지 전략

#### config/settings.json 확인
```javascript
// 개인 레포: config/settings.json
{
  "site_port": 3000
}

// 회사 레포: config/settings.json
{
  "site_port": 3001
}
```

#### 환경 변수로 포트 덮어쓰기
```javascript
// ecosystem.config.js
{
  name: 'company-monitor',
  script: './server.js',
  env: {
    PORT: 3001  // settings.json 대신 이 값 사용
  }
}
```

#### server.js에서 포트 우선순위
```javascript
// server.js
const PORT = process.env.PORT || settings.site_port || 3000;
```

---

## 📊 모니터링 및 구분

### 대시보드에서 구분
```bash
# 실시간 모니터링 (2개 앱 동시 확인)
pm2 monit

# 화면 예시:
# ┌─ Process list ────────────────┐
# │ personal-monitor  [0] online  │
# │ company-monitor   [1] online  │
# └───────────────────────────────┘
```

### 로그 분리 확인
```bash
# 개인 레포 로그
tail -f D:\API\2uknow-api-monitor\logs\pm2-out.log

# 회사 레포 로그
tail -f D:\API\company-api-monitor\logs\pm2-out.log
```

---

## 🚨 주의사항

### 1. 포트 충돌 확인
```bash
# 포트 사용 확인
netstat -ano | findstr :3000
netstat -ano | findstr :3001

# 프로세스 종료
taskkill /PID [프로세스ID] /F
```

### 2. 경로 주의
```javascript
// ❌ 잘못된 예 (상대 경로)
{
  name: 'company-monitor',
  cwd: '../company-api-monitor'  // 작동 안될 수 있음
}

// ✅ 올바른 예 (절대 경로)
{
  name: 'company-monitor',
  cwd: 'D:/API/company-api-monitor'
}
```

### 3. 로그 파일 경로
```javascript
// ❌ 잘못된 예 (충돌 가능)
{
  error_file: 'C:/logs/pm2-error.log'  // 두 앱이 같은 파일 사용
}

// ✅ 올바른 예 (각자 다른 폴더)
{
  error_file: './logs/pm2-error.log'  // cwd 기준 상대 경로
}
```

---

## 🎯 추천 설정 (회사 레포용)

### ecosystem.config.js
```javascript
/**
 * Company API Monitor - PM2 Configuration
 *
 * 개인 레포와 구분되는 회사 레포 설정
 */

module.exports = {
  apps: [
    {
      // ===== 기본 설정 =====
      name: 'company-api-monitor',      // 회사 레포 전용 이름
      script: './server.js',
      cwd: './',

      // ===== 인스턴스 설정 =====
      instances: 1,
      exec_mode: 'fork',

      // ===== 자동 재시작 설정 =====
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,

      // ===== 메모리 관리 =====
      max_memory_restart: '1G',         // 회사: 1GB (개인: 800MB)

      // ===== 환경 변수 =====
      env: {
        NODE_ENV: 'production',
        PORT: 3001,                     // 회사: 3001 (개인: 3000)
        PROJECT_NAME: 'Company Monitor'
      },

      // ===== 크론 재시작 =====
      cron_restart: '0 3 * * *',        // 회사: 새벽 3시 (개인: 새벽 4시)

      // ===== 로그 관리 =====
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      time: true,

      // ===== 타임아웃 설정 =====
      listen_timeout: 5000,
      kill_timeout: 5000,

      // ===== 기타 설정 =====
      source_map_support: true,
      instance_var: 'INSTANCE_ID'
    }
  ]
};
```

### 설정 파일 복사
```bash
# 개인 레포 → 회사 레포로 복사
copy D:\API\2uknow-api-monitor\ecosystem.config.js D:\API\company-api-monitor\

# 회사 레포 파일 수정
# - name 변경
# - PORT 변경
# - cron_restart 시간 변경 (선택)
```

---

## 🚀 빠른 시작 (회사 레포)

### 1. ecosystem.config.js 생성
```bash
cd D:\API\company-api-monitor
notepad ecosystem.config.js
```

### 2. 내용 붙여넣기
위의 "추천 설정" 복사

### 3. 실행
```bash
pm2 start ecosystem.config.js
pm2 save
```

### 4. 확인
```bash
pm2 ls
pm2 logs company-api-monitor
```

### 5. 웹 대시보드 접속
```
개인: http://localhost:3000
회사: http://localhost:3001
```

---

## 💡 유용한 팁

### 설정 파일 템플릿 생성
```bash
# 개인 레포 설정을 템플릿으로 사용
cd D:\API\2uknow-api-monitor
pm2 ecosystem  # 기본 템플릿 생성
```

### 설정 비교
```bash
# 두 레포의 설정 파일 비교
fc D:\API\2uknow-api-monitor\ecosystem.config.js D:\API\company-api-monitor\ecosystem.config.js
```

### 일괄 재시작
```bash
# 모든 monitor 앱 재시작
pm2 restart all

# 또는 패턴 매칭 (PM2 5.0+)
pm2 restart /monitor/
```

---

## 📞 체크리스트

회사 레포 적용 시:

- [ ] `ecosystem.config.js` 파일 생성
- [ ] `name` 변경 (예: `company-api-monitor`)
- [ ] `PORT` 변경 (예: 3001)
- [ ] `config/settings.json`의 `site_port` 확인
- [ ] 포트 충돌 확인 (`netstat -ano | findstr :3001`)
- [ ] PM2 시작 (`pm2 start ecosystem.config.js`)
- [ ] 로그 확인 (`pm2 logs company-api-monitor`)
- [ ] 웹 대시보드 접속 확인 (`http://localhost:3001`)
- [ ] 설정 저장 (`pm2 save`)
- [ ] 개인 레포와 동시 실행 확인 (`pm2 ls`)

---

## 🎯 결론

**가장 추천하는 방법**: 방법 1 (각 레포에 별도 설정)

**이유**:
- ✅ 간단하고 명확함
- ✅ 레포별 독립적 관리
- ✅ Git 버전 관리 용이
- ✅ 경로 의존성 없음

**핵심 포인트**:
1. `name`은 단순 라벨 → 자유롭게 변경
2. `script`가 실제 실행 파일 → `server.js` 유지
3. `PORT` 환경 변수로 포트 구분
4. 각 레포는 독립적으로 실행됨

**행운을 빕니다!** 🚀
