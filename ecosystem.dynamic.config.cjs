/**
 * PM2 Dynamic Configuration
 *
 * 환경 변수로 동적으로 이름 설정
 * 사용법:
 *   SET PROJECT_ENV=personal && pm2 start ecosystem.dynamic.config.js
 *   SET PROJECT_ENV=company && pm2 start ecosystem.dynamic.config.js
 */

const projectEnv = process.env.PROJECT_ENV || 'personal';
const projectName = `${projectEnv}-api-monitor`;

module.exports = {
  apps: [
    {
      name: projectName,  // 환경 변수에 따라 동적으로 변경
      script: './server.js',
      cwd: './',

      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '800M',
      cron_restart: '0 4 * * *',

      env: {
        NODE_ENV: 'production',
        PORT: projectEnv === 'company' ? 3001 : 3000,
        PROJECT_ENV: projectEnv
      },

      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
    }
  ]
};
