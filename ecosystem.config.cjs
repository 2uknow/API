/**
 * PM2 Ecosystem Configuration for 2uknow API Monitor
 *
 * 최적화된 설정:
 * - Ryzen 9 7950X (16코어) 활용
 * - 64GB RAM 환경
 * - 시간당 100회 부하 대응
 * - 안정성 최우선
 */

module.exports = {
  apps: [
    {
      // === 기본 설정 ===
      name: '2uknow-api-monitor',
      script: './server.js',
      cwd: './',

      // === 인스턴스 설정 ===
      // 옵션 1: 단일 인스턴스 (시작 추천)
      instances: 1,
      exec_mode: 'fork',

      // 옵션 2: 클러스터 모드 (부하 높을 시 활성화)
      // instances: 4,  // 4개 워커 프로세스
      // exec_mode: 'cluster',

      // === 자동 재시작 설정 ===
      autorestart: true,
      watch: false, // 프로덕션에서는 false
      max_restarts: 10, // 1분 내 10회 재시작 제한
      min_uptime: '10s', // 최소 10초 정상 구동
      restart_delay: 3000, // 재시작 시 3초 대기

      // === 메모리 관리 ===
      max_memory_restart: '800M', // 800MB 초과 시 재시작

      // === 환경 변수 ===
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },

      env_development: {
        NODE_ENV: 'development',
        PORT: 3001
      },

      // === 로그 관리 ===
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      time: true,

      // === 타임아웃 설정 ===
      listen_timeout: 5000,
      kill_timeout: 5000,

      // === 크론 재시작 (선택사항) ===
      // 매일 새벽 4시 자동 재시작 (메모리 정리)
      cron_restart: '0 4 * * *',

      // 크론 설정 예시:
      // '0 4 * * *'      - 매일 새벽 4시
      // '0 */6 * * *'    - 6시간마다
      // '0 0 * * 0'      - 매주 일요일 자정
      // '0 3 * * 1-5'    - 평일 새벽 3시
      // '*/30 * * * *'   - 30분마다

      // === 기타 설정 ===
      source_map_support: true,
      instance_var: 'INSTANCE_ID'
    },

    // === PM2 헬스체크 데몬 ===
    // 좀비 프로세스 감지 및 자동 복구
    {
      name: 'pm2-healthcheck',
      script: './scripts/pm2-healthcheck-daemon.js',
      cwd: './',

      // 환경설정
      env: {
        NODE_ENV: 'production',
        HEALTHCHECK_INTERVAL: '300000',     // 5분 (밀리초)
        TARGET_PROCESS: '2uknow-api-monitor'
      },

      // 재시작 설정
      autorestart: true,
      max_memory_restart: '100M',
      restart_delay: 5000,
      max_restarts: 5,
      min_uptime: '30s',

      // 로그 설정
      error_file: './logs/healthcheck-error.log',
      out_file: './logs/healthcheck-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      time: true,

      // 프로세스 관리
      watch: false,
      kill_timeout: 3000
    }
  ],

  // === PM2 Deploy 설정 (선택사항) ===
  // deploy: {
  //   production: {
  //     user: 'node',
  //     host: 'localhost',
  //     ref: 'origin/main',
  //     repo: 'git@github.com:repo.git',
  //     path: '/var/www/production',
  //     'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production'
  //   }
  // }
};
