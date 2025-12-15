/**
 * PM2 Multi-Environment Configuration
 *
 * 개인/회사 레포를 하나의 설정 파일로 관리
 * 사용법:
 *   개인: pm2 start ecosystem.multi-env.config.js --only personal-monitor
 *   회사: pm2 start ecosystem.multi-env.config.js --only company-monitor
 *   전체: pm2 start ecosystem.multi-env.config.js
 */

module.exports = {
  apps: [
    // ===== 개인 레포 설정 =====
    {
      name: 'personal-monitor',
      script: './server.js',
      cwd: 'D:/API/2uknow-api-monitor',  // 개인 레포 경로

      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '800M',
      cron_restart: '0 4 * * *',

      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        PROJECT_NAME: 'Personal Monitor'
      },

      error_file: 'D:/API/2uknow-api-monitor/logs/pm2-error.log',
      out_file: 'D:/API/2uknow-api-monitor/logs/pm2-out.log',
    },

    // ===== 회사 레포 설정 =====
    {
      name: 'company-monitor',
      script: './server.js',
      cwd: 'D:/API/company-api-monitor',  // 회사 레포 경로

      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',           // 회사는 더 큰 메모리 허용
      cron_restart: '0 3 * * *',          // 회사는 새벽 3시 재시작

      env: {
        NODE_ENV: 'production',
        PORT: 3001,                       // 다른 포트!
        PROJECT_NAME: 'Company Monitor'
      },

      error_file: 'D:/API/company-api-monitor/logs/pm2-error.log',
      out_file: 'D:/API/company-api-monitor/logs/pm2-out.log',
    },

    // ===== 개발/테스트 환경 (선택사항) =====
    {
      name: 'dev-monitor',
      script: './server.js',
      cwd: 'D:/API/dev-api-monitor',

      instances: 1,
      exec_mode: 'fork',
      watch: true,                        // 개발 환경은 watch 모드
      ignore_watch: ['node_modules', 'logs', 'reports'],

      env: {
        NODE_ENV: 'development',
        PORT: 3002,
        PROJECT_NAME: 'Dev Monitor'
      },

      error_file: 'D:/API/dev-api-monitor/logs/pm2-error.log',
      out_file: 'D:/API/dev-api-monitor/logs/pm2-out.log',
    }
  ]
};
