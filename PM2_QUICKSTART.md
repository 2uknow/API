# PM2 빠른 시작 가이드 (5분 완성)

## 🚀 원클릭 설치

### Windows
```bash
# 프로젝트 폴더에서 실행
setup-pm2.bat
```

### 수동 설치 (3단계)
```bash
# 1. PM2 설치
npm install -g pm2
pm2 install pm2-logrotate

# 2. 로그 설정
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 30
pm2 set pm2-logrotate:compress true

# 3. 앱 시작
pm2 start ecosystem.config.js
pm2 save
```

---

## 📊 주요 명령어 (외우면 끝!)

### 기본 관리
```bash
pm2 start ecosystem.config.js   # 시작
pm2 stop 2uknow-api-monitor     # 중지
pm2 restart 2uknow-api-monitor  # 재시작
pm2 delete 2uknow-api-monitor   # 삭제
```

### 모니터링
```bash
pm2 status                       # 상태 확인
pm2 monit                        # 실시간 모니터링 (추천!)
pm2 logs                         # 로그 스트리밍
pm2 logs --lines 100             # 최근 100줄
```

### 자동 시작 설정
```bash
pm2 save                         # 현재 상태 저장
pm2 startup                      # Windows 시작 시 자동 실행
```

---

## 🎯 일일 운영 체크리스트

### 매일 아침 (30초)
```bash
pm2 status                       # ✅ 앱 정상 작동 확인
pm2 monit                        # ✅ CPU/메모리 정상 확인
```

### 문제 발생 시 (1분)
```bash
pm2 logs --err --lines 50        # 🔍 에러 로그 확인
pm2 restart 2uknow-api-monitor   # 🔄 재시작
```

### 주간 점검 (5분)
```bash
pm2 show 2uknow-api-monitor      # 📊 상세 통계 확인
ls -lh logs/                     # 📁 로그 파일 크기 확인
```

---

## ⚙️ 설정 변경

### Cron 재시작 시간 변경
```javascript
// ecosystem.config.js 파일 수정
cron_restart: '0 4 * * *',  // 매일 새벽 4시

// 적용
pm2 restart ecosystem.config.js
```

### 메모리 제한 변경
```javascript
// ecosystem.config.js 파일 수정
max_memory_restart: '800M',  // 800MB

// 적용
pm2 restart ecosystem.config.js
```

### 로그 로테이션 설정 변경
```bash
# 로그 파일 크기 변경 (10MB → 50MB)
pm2 set pm2-logrotate:max_size 50M

# 보관 파일 개수 변경 (30개 → 10개)
pm2 set pm2-logrotate:retain 10
```

---

## 🚨 긴급 상황 대응

### 앱이 죽었을 때
```bash
pm2 restart 2uknow-api-monitor
```

### 메모리 사용량이 높을 때
```bash
pm2 restart 2uknow-api-monitor  # 메모리 초기화
```

### 로그가 너무 많을 때
```bash
pm2 flush                        # 로그 비우기
```

### PM2가 응답 없을 때
```bash
pm2 kill                         # PM2 종료
pm2 resurrect                    # 저장된 설정으로 복원
```

---

## 📚 상세 가이드

- **PM2 전체 기능**: `PM2_GUIDE.md` 참고
- **로그 로테이션**: `PM2_LOGROTATE_GUIDE.md` 참고
- **Cron 설정**: `PM2_GUIDE.md` → "Cron 자동 재시작 설정" 섹션

---

## 🎓 자주 묻는 질문 (FAQ)

### Q1. PM2가 Windows 재부팅 후 자동 시작 안됨
```bash
# 관리자 권한 CMD에서 실행
pm2 startup
# 출력된 명령어 복사해서 실행
pm2 save
```

### Q2. 로그 파일이 너무 커짐
```bash
# 로그 로테이션 설정 확인
pm2 conf pm2-logrotate

# 파일 크기 줄이기
pm2 set pm2-logrotate:max_size 10M
```

### Q3. 앱이 계속 재시작됨
```bash
# 에러 로그 확인
pm2 logs --err

# 재시작 횟수 확인
pm2 ls

# max_restarts 늘리기 (ecosystem.config.js)
max_restarts: 10
```

### Q4. CPU 사용률이 높음
```bash
# 현재 실행 중인 작업 확인
pm2 monit

# 클러스터 모드 비활성화 (ecosystem.config.js)
instances: 1,
exec_mode: 'fork',
```

### Q5. Cron 재시작 시간 변경하고 싶음
```javascript
// ecosystem.config.js
cron_restart: '0 2 * * *',  // 새벽 2시로 변경

// 적용
pm2 delete 2uknow-api-monitor
pm2 start ecosystem.config.js
pm2 save
```

---

## 💡 유용한 팁

### 실시간 로그 보기 (Ctrl+C로 종료)
```bash
pm2 logs --lines 200
```

### 메모리 사용량 실시간 모니터링
```bash
pm2 monit
```

### 특정 시간의 로그 찾기
```bash
# 압축된 로그 검색
zgrep "2025-01-06" logs/*.gz
```

### 설정 백업
```bash
pm2 save  # 자동으로 C:\Users\사용자\.pm2\dump.pm2 에 저장됨
```

### 다른 PC로 이전
```bash
# 원본 PC
pm2 save
copy %USERPROFILE%\.pm2\dump.pm2 D:\backup\

# 새 PC
pm2 install pm2-logrotate
pm2 resurrect  # dump.pm2 파일이 있으면 자동 복원
```

---

## ✅ 설치 확인

설치가 완료되었는지 확인하세요:

```bash
# ✅ PM2 버전 확인
pm2 -v

# ✅ 앱 상태 확인
pm2 status
# 2uknow-api-monitor가 'online' 상태여야 함

# ✅ 로그 로테이션 확인
pm2 ls | findstr logrotate
# pm2-logrotate가 'online' 상태여야 함

# ✅ 웹 대시보드 접속
# 브라우저: http://localhost:3000

# ✅ 로그 확인
pm2 logs --lines 10
# 에러 없이 정상 동작해야 함
```

**모든 항목이 ✅ 표시되면 설치 완료!** 🎉

---

## 🔗 추가 리소스

- **공식 문서**: https://pm2.keymetrics.io/
- **한글 커뮤니티**: https://www.inflearn.com/questions (PM2 검색)
- **문제 해결**: GitHub Issues 또는 Stack Overflow

---

## 📞 도움말

문제가 해결되지 않으면:

1. 에러 로그 확인: `pm2 logs --err`
2. 상세 정보 확인: `pm2 show 2uknow-api-monitor`
3. PM2 재시작: `pm2 kill && pm2 resurrect`
4. 완전 재설치: `setup-pm2.bat` 다시 실행

**Happy Monitoring! 🚀**
