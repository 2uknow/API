# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Danal API Monitoring System** - a Node.js-based web application that automates API testing using Newman (Postman CLI) with real-time monitoring, scheduling, and Naver Works webhook notifications.

## Architecture

### Core Components

- **server.js** (main server): Express.js server handling web dashboard, API routes, SSE streaming, scheduling, and Newman job execution
- **alert.js** (notification system): Naver Works webhook integration for Flex messages and text alerts
- **Web Dashboard** (public/): Real-time monitoring interface with SSE for live logs and execution status

### Key Directories

- `collections/`: Postman collection files (.json)
- `environments/`: Postman environment files (.json) 
- `jobs/`: Job definition files that specify which collections/environments to run
- `config/`: System settings (settings.json, schedules.json)
- `reports/`: Generated Newman HTML/XML/JSON reports
- `logs/`: Execution logs (stdout/stderr) and history.json
- `scripts/`: Testing and debugging utilities

## Common Development Commands

```bash
# Development with auto-restart
npm run dev

# Production mode
npm start

# With environment variables
npm run start:env

# Setup project (install deps + create directories)
npm run setup

# Install Newman reporters
npm run install-reporters

# Testing
npm run test:alert          # Test Naver Works alerts
npm run test:error          # Test error notifications
npm run test:connection     # Test connectivity

# Debugging
npm run debug:all           # All debug information
npm run debug:config        # Configuration debugging
npm run debug:urls          # URL debugging
npm run debug:health        # Health check

# Maintenance
npm run clean              # Clean logs and reports
npm run backup            # Create backup tar.gz
npm run update-newman     # Update Newman and reporters
```

## Job Configuration

Jobs are defined in `jobs/*.json` files. Example structure:

```json
{
  "name": "api_health_check",
  "type": "newman",
  "collection": "collections/api_tests.postman_collection.json",
  "environment": "environments/dev.postman_environment.json",
  "reporters": ["cli", "htmlextra", "junit", "json"],
  "extra": ["--insecure", "--timeout-request", "30000"]
}
```

## Configuration Files

### config/settings.json
Main system configuration including:
- `site_port`: Web server port (default: 3000)
- `webhook_url`: Naver Works webhook URL
- `run_event_alert`: Enable/disable alerts
- `alert_on_start/success/error`: Alert triggers
- `alert_method`: "text" or "flex" message format
- `history_keep`: Number of execution records to retain
- `report_keep_days`: Days to keep HTML reports

### config/schedules.json
Cron-based job scheduling (loaded automatically on startup)

## Real-time Features

- **Server-Sent Events (SSE)**: Live log streaming and status updates
- **WebSocket-like communication**: Bi-directional real-time updates
- **Auto-reconnection**: Client-side SSE reconnection handling
- **Heartbeat system**: Connection health monitoring

## API Endpoints

### Job Management
- `GET /api/jobs` - List available jobs
- `POST /api/run/:name` - Execute specific job
- `GET /api/history` - Execution history with pagination

### Scheduling
- `GET /api/schedule` - List active schedules
- `POST /api/schedule` - Add new schedule
- `DELETE /api/schedule/:name` - Remove schedule

### Monitoring  
- `GET /api/statistics/today` - Today's execution statistics
- `GET /api/stream/state` - Real-time status stream (SSE)
- `GET /api/stream/logs` - Real-time log stream (SSE)

### Alerts
- `GET /api/alert/config` - Get alert configuration
- `POST /api/alert/config` - Update alert settings
- `POST /api/alert/test` - Test alert connectivity

## Development Notes

### Newman Integration
- Uses Newman CLI via child process spawning
- Supports all Newman reporters (CLI, HTML, JUnit, JSON)
- Parses Newman output for statistics and failure details
- Handles both successful and failed test executions

### Alert System Architecture
- **Flex Messages**: Rich Naver Works cards with statistics, buttons
- **Text Messages**: Simple text notifications
- **Smart Parsing**: Extracts failure details from Newman CLI output
- **Performance Metrics**: Response times, success rates, detailed statistics

### SSE Optimization
- Buffered log broadcasting to reduce network overhead
- Dead connection cleanup
- Memory usage monitoring
- Heartbeat system for connection health

### Error Handling
- Comprehensive Newman output parsing
- Detailed failure analysis with expected/actual values
- Error categorization and reporting
- Graceful degradation for parsing failures

## Environment Variables

- `NW_HOOK`: Override webhook URL
- `TEXT_ONLY`: Force text-only alerts
- `DASHBOARD_URL`: Custom base URL for links
- `NODE_ENV=development`: Enable debug logging and memory monitoring

## Troubleshooting

### Newman Issues
Check that Newman and htmlextra reporter are installed:
```bash
npm run install-reporters
```

### Alert Issues
1. Verify `webhook_url` in config/settings.json
2. Test connectivity: `npm run test:alert`
3. Check console logs for webhook responses

### SSE Connection Issues
- Check browser dev tools for SSE connection status
- Monitor server logs for client connection/disconnection
- Verify firewall settings for SSE

### Schedule Issues
- Validate cron expressions (5-field format)
- Check server timezone (defaults to Asia/Seoul)
- Ensure job files exist in jobs/ directory