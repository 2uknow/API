/**
 * PM2 Ecosystem Configuration - Company Repository Template
 *
 * 회사 레포에 복사해서 사용하세요!
 *
 * 복사 방법:
 *   1. 이 파일을 회사 레포로 복사
 *   2. 파일명을 'ecosystem.config.js'로 변경
 *   3. 아래 설정값들을 회사 환경에 맞게 수정
 *   4. pm2 start ecosystem.config.js 실행
 *
 * 수정이 필요한 부분은 ← 표시되어 있습니다
 */

module.exports = {
  apps: [
    {
      // ===== 기본 설정 =====
      name: 'company-api-monitor',      // ← 회사 레포 이름으로 변경
      script: './server.js',             // 그대로 유지
      cwd: './',                         // 그대로 유지

      // ===== 인스턴스 설정 =====
      instances: 1,                      // 단일 인스턴스 (권장)
      exec_mode: 'fork',                 // fork 모드 (권장)

      // 부하가 매우 높을 경우만 클러스터 모드 활성화:
      // instances: 4,
      // exec_mode: 'cluster',

      // ===== 자동 재시작 설정 =====
      autorestart: true,                 // 크래시 시 자동 재시작
      watch: false,                      // 프로덕션: false (개발: true)
      max_restarts: 10,                  // 1분 내 10회 재시작 제한
      min_uptime: '10s',                 // 최소 10초 정상 구동
      restart_delay: 3000,               // 재시작 시 3초 대기

      // ===== 메모리 관리 =====
      max_memory_restart: '1G',          // ← 회사 환경에 맞게 조정 (권장: 800M-2G)

      // ===== 환경 변수 =====
      env: {
        NODE_ENV: 'production',
        PORT: 3001,                      // ← 회사 레포 포트 (개인 레포와 겹치지 않게!)
        PROJECT_NAME: 'Company Monitor'  // ← 회사 프로젝트명
      },

      env_development: {
        NODE_ENV: 'development',
        PORT: 3001,
        PROJECT_NAME: 'Company Monitor (Dev)'
      },

      // ===== 크론 재시작 =====
      // 매일 새벽 3시 자동 재시작 (메모리 정리)
      cron_restart: '0 3 * * *',         // ← 원하는 시간으로 변경 가능

      // 크론 설정 예시:
      // '0 3 * * *'      - 매일 새벽 3시
      // '0 4 * * *'      - 매일 새벽 4시
      // '0 */6 * * *'    - 6시간마다
      // '0 0 * * 0'      - 매주 일요일 자정
      // '0 2 * * 1-5'    - 평일 새벽 2시

      // ===== 로그 관리 =====
      error_file: './logs/pm2-error.log',    // 에러 로그 경로
      out_file: './logs/pm2-out.log',        // 출력 로그 경로
      log_date_format: 'YYYY-MM-DD HH:mm:ss', // 로그 날짜 형식
      merge_logs: true,                       // 로그 병합
      time: true,                             // 타임스탬프 표시

      // ===== 타임아웃 설정 =====
      listen_timeout: 5000,              // 시작 대기 시간 (5초)
      kill_timeout: 5000,                // 종료 대기 시간 (5초)

      // ===== 기타 설정 =====
      source_map_support: true,          // 소스맵 지원
      instance_var: 'INSTANCE_ID'        // 인스턴스 변수명
    }
  ]
};

/**
 * 설정 적용 후 실행 명령어:
 *
 * 1. PM2 시작
 *    pm2 start ecosystem.config.js
 *
 * 2. 상태 확인
 *    pm2 status
 *    pm2 logs company-api-monitor
 *
 * 3. 웹 대시보드 접속
 *    http://localhost:3001
 *
 * 4. Windows 시작 시 자동 실행 설정
 *    pm2 save
 *    pm2 startup (관리자 권한 필요)
 *
 * 5. 로그 로테이션 설정 (한 번만 실행)
 *    pm2 install pm2-logrotate
 *    pm2 set pm2-logrotate:max_size 10M
 *    pm2 set pm2-logrotate:retain 30
 *    pm2 set pm2-logrotate:compress true
 */
