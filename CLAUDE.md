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

## SClient Integration System (Updated 2025-08-27)

### Architecture Overview
This system provides YAML-based SClient testing capabilities with Newman-style HTML reporting.

**System Flow**: YAML Definition → JSON Scenario → SClient Execution → Newman Report

### Key Components

#### 1. **SClient Engine** (`sclient-engine.js`)
- **Primary Function**: Executes SClient binary with proper argument formatting
- **Argument Format**: Converts YAML args to semicolon-delimited single string
- **Example**: `./SClient "Command=ITEMSEND2;SERVICE=TELEDIT;ID=A010002002;PWD=bbbbb"`
- **Test Environment**: Provides `pm` object compatibility for Postman-style tests
- **Response Parsing**: Extracts key-value pairs from SClient stdout

#### 2. **YAML Parser** (`simple-yaml-parser.js`)  
- **Purpose**: Converts YAML test definitions to SClient JSON scenarios
- **Features**: Variable substitution, test generation, extractor mapping
- **Structure**: Handles `variables`, `steps`, `args`, `extract`, `test` sections

#### 3. **Newman Converter** (`newman-converter.js`)
- **Function**: Generates Newman-compatible HTML reports from SClient results
- **Features**: Dark/light theme, responsive design, request command display, favicon
- **Report Types**: HTMLExtra style, custom HTML, JSON, JUnit XML

### YAML Test Format

```yaml
# SClient YAML Test Structure
name: "Test Name"
description: "Test Description"
variables:
  MERCHANT_ID: "A010002002"
  SERVICE_NAME: "TELEDIT"
  ORDER_ID: "{{$randomId}}"          # Dynamic variable

steps:
  - name: "Test Step Name"
    args:
      Command: "ITEMSEND2"
      SERVICE: "{{SERVICE_NAME}}"
      ID: "{{MERCHANT_ID}}"
      ORDERID: "{{ORDER_ID}}"
      # Additional parameters...
    
    extract:
      - name: "result"
        pattern: "Result"              # Simple keyword extraction
        variable: "RESULT_CODE"
      - name: "serverInfo"
        pattern: "ServerInfo"          # No regex needed
        variable: "SERVER_INFO"
    
    test:
      - "RESULT_CODE exists"
      - "RESULT_CODE == 0"
      # Advanced JavaScript tests with description
      - name: "Payment validation"
        description: "Verify payment completed successfully"
        assertion: "js: result == '0' && serverinfo && serverinfo.length > 0"
```

### Simple Data Extraction (Updated 2025-08-27)

**Old Complex Way**:
```yaml
extract:
  - name: "result"
    pattern: "Result\\s*=\\s*([0-9-]+)"  # Complex regex
    variable: "RESULT_CODE"
```

**New Simple Way**:
```yaml
extract:
  - name: "result"
    pattern: "Result"                     # Just keyword
    variable: "RESULT_CODE"
```

**How it works**:
- SClient response: `Result=0\nServerInfo=abc123\nErrMsg=No Information`
- Auto-parsed to: `{result: "0", serverinfo: "abc123", errmsg: "No Information"}`
- Simple extraction: `pattern: "Result"` → finds `result` value directly

### Dynamic Variables
Built-in dynamic variables available in YAML:

| Variable | Example Output | Description |
|----------|---------------|-------------|
| `{{$timestamp}}` | `1724580000123` | Unix timestamp (milliseconds) |
| `{{$randomInt}}` | `7429` | Random integer (0-9999) |
| `{{$randomId}}` | `1724580000123456` | Timestamp + random (unique ID) |
| `{{$dateTime}}` | `20250825143020` | Current datetime (YYYYMMDDHHMMSS) |
| `{{$date}}` | `20250825` | Current date (YYYYMMDD) |
| `{{$time}}` | `143020` | Current time (HHMMSS) |
| `{{$uuid}}` | `f47ac10b-58cc-4372-a567-0e02b2c3d479` | UUID v4 |

### JavaScript Expressions (Advanced)
Execute JavaScript code within YAML for ultimate flexibility:

```yaml
variables:
  # JavaScript expressions with js: prefix
  ORDER_ID: "{{js: 'ORD' + Date.now() + '_' + Math.floor(Math.random() * 1000)}}"
  TIME_BASED: "{{js: new Date().getHours() > 12 ? 'PM_TEST' : 'AM_TEST'}}"
  ENVIRONMENT: "{{js: env.NODE_ENV || 'development'}}"
```

### Test Naming and Results (Updated 2025-08-27)

**Clean Test Names**:
- ✅ `Verify RESULT_CODE field exists` (no ✓ symbol)
- ✅ `Verify IDELIVER_CAP equals 000000` (original variable names)
- ✅ `Payment validation` (custom JavaScript test names)

**Enhanced JavaScript Tests**:
```yaml
test:
  - name: "Payment server response validation"
    description: "Verify success with serverinfo or failure with errmsg"
    assertion: "js: (result == '0' && serverinfo && serverinfo.length > 0) || (result != '0' && errmsg && errmsg.length > 0)"
```

**Test Results Display**:
- **Success**: Clean test name without symbols
- **Failure**: Detailed error with actual/expected values in JSON format
- **JavaScript Tests**: Shows condition, actual values, and helpful debug info

### File Naming Convention (Updated 2025-08-27)

**Report Files**: Use Korean Standard Time (KST)
- Format: `TDB_SKT_2025-08-27_09_47_36.html`
- Timezone: Asia/Seoul (KST = UTC+9)
- Pattern: `{job_name}_{YYYY-MM-DD_HH_mm_ss}.html`

### HTML Report Features (Updated 2025-08-27)

**Modern UI Features**:
- ✅ **Favicon**: API monitoring themed icon (gradient + document + status)
- ✅ **Dark/Light Theme**: Toggle with localStorage persistence  
- ✅ **Responsive Design**: Mobile-friendly responsive layout
- ✅ **Request Command Display**: Shows complete SClient command with semicolon-delimited parameters
- ✅ **Real-time Metrics**: Success rate, response times, comprehensive statistics
- ✅ **Variable Name Display**: Shows original variable names (RESULT_CODE, IDELIVER_CAP)

**Report Structure**:
1. Header with test name, description, generation time (KST)
2. Dashboard metrics with circular progress indicators
3. Request results with expandable details
4. Test assertions with pass/fail status and detailed error messages
5. Summary statistics with execution timings

## Variable Extraction Simplification (2025-08-27)

**Key Insight**: No complex mapping needed! Extracted variables are automatically included in PM response object.

**How it works**:
1. **YAML Definition**: `variable: "IDELIVER_CAP"` extracts to variable name
2. **Auto-Inclusion**: Variable automatically added to `pm.response` object
3. **Direct Access**: Tests can access `pm.response.IDELIVER_CAP` directly
4. **Fallback**: If not found, tries lowercase version `pm.response.ideliver_cap`

**No More Complex Mapping**:
```javascript
// OLD WAY: Complex mapping table
'IDELIVER_RESULT': 'result',
'IDELIVER_SERVER_INFO': 'serverinfo', 
'IDELIVER_ERROR_MSG': 'errmsg',
'IDELIVER_CAP': 'cap',

// NEW WAY: Simple direct access
pm.response.IDELIVER_CAP || pm.response.ideliver_cap
```

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

### SClient Integration Issues
1. **Extraction Fails**: Check debug logs for available keys vs. requested pattern
2. **Test Fails**: Verify variable names match between extract and test sections
3. **Pattern Issues**: Use simple keywords instead of complex regex when possible

### SSE Connection Issues
- Check browser dev tools for SSE connection status
- Monitor server logs for client connection/disconnection
- Verify firewall settings for SSE

### Schedule Issues
- Validate cron expressions (5-field format)
- Check server timezone (defaults to Asia/Seoul)
- Ensure job files exist in jobs/ directory

## SClient Command to YAML Conversion Guide

### Conversion Process

When user provides SClient commands in this format:
```bash
./SClient "ServerInfo=xxx;Command=IREPORT;Configure=FAILURE;IFVERSION=V1.0.5;..."
```

Convert to YAML step format following these rules:

#### 1. **Step Structure Template**
```yaml
- name: "[COMMAND_NAME] - [Korean Description]"
  description: "[Korean description of what this step does]"
  
  args:
    ServerInfo: "{{SERVER_INFO}}"  # Always use variable from previous step
    Command: "[COMMAND_NAME]"
    [Parameter]: "[Value]"
    # ... other parameters
  
  # 응답 데이터 추출 (Simplified)
  extract:
    - name: "result"
      pattern: "Result"              # Simple keyword
      variable: "[COMMAND_NAME]_RESULT"
    - name: "serverInfo"
      pattern: "ServerInfo"          # No regex needed  
      variable: "[COMMAND_NAME]_SERVER_INFO"
    - name: "errMsg"
      pattern: "ErrMsg"              # Clean and simple
      variable: "[COMMAND_NAME]_ERROR_MSG"
  
  # 테스트 검증
  test:
    - "[COMMAND_NAME]_RESULT exists"
    - "[COMMAND_NAME]_SERVER_INFO exists"
```

#### 2. **Parameter Mapping Rules**
- Extract semicolon-separated parameters from SClient command
- Convert each `key=value` pair to YAML `key: "value"` format
- Use existing variables where appropriate (e.g., `{{MERCHANT_ID}}`)
- Keep ServerInfo as `{{SERVER_INFO}}` to chain steps

#### 3. **Command-Specific Korean Names**
- **IREPORT**: "결제 정보 조회"
- **NCONFIRM**: "결제 확인" 
- **NBILL**: "결제 실행"
- **ITEMSEND2**: "결제 요청"
- **IDELIVER**: "인증 처리"

#### 4. **Variable Naming Convention**
- Result variables: `[COMMAND_NAME]_RESULT`
- ServerInfo variables: `[COMMAND_NAME]_SERVER_INFO`
- Error message variables: `[COMMAND_NAME]_ERROR_MSG`

#### 5. **Integration with Existing YAML**
- Add new steps to existing `steps:` section
- Maintain proper YAML indentation (2 spaces)
- Place before the final `options:` section

### Example Conversion

**Input:**
```bash
./SClient "ServerInfo=xxx;Command=IREPORT;Configure=FAILURE;IFVERSION=V1.0.5;TERMSAGREE2=N;WPRCODE=0000;OTP=000000;"
```

**Output:**
```yaml
- name: "IREPORT - 결제 정보 조회"
  description: "결제 정보 조회 테스트"
  
  args:
    ServerInfo: "{{SERVER_INFO}}"
    Command: "IREPORT"
    Configure: "FAILURE"
    IFVERSION: "V1.0.5"
    TERMSAGREE2: "N"
    WPRCODE: "0000"
    OTP: "000000"
  
  extract:
    - name: "result"
      pattern: "Result"
      variable: "IREPORT_RESULT"
    - name: "serverInfo"
      pattern: "ServerInfo"
      variable: "IREPORT_SERVER_INFO"
    - name: "errMsg"
      pattern: "ErrMsg"
      variable: "IREPORT_ERROR_MSG"
  
  test:
    - "IREPORT_RESULT exists"
    - "IREPORT_SERVER_INFO exists"
```

### Usage Instructions
When user provides SClient commands for conversion:
1. Parse each command to extract parameters
2. Apply the conversion template above
3. Add steps to the existing YAML file in the correct location
4. Maintain proper variable chaining between steps
5. Use appropriate Korean descriptions for each command type

## Best Practices

### YAML Test Development
1. **Use Simple Patterns**: Prefer `"Result"` over complex regex `"Result\\s*=\\s*([0-9-]+)"`
2. **Meaningful Variable Names**: Use descriptive names like `PAYMENT_RESULT` vs `RES1`
3. **JavaScript Tests**: Add descriptions for complex conditions
4. **Variable Chaining**: Use extracted variables from previous steps (e.g., `{{SERVER_INFO}}`)

### HTML Report Optimization  
1. **Favicon**: Automatically included for professional appearance
2. **Theme**: Dark/light toggle for user preference
3. **Variable Display**: Original names preserved (no friendly mapping)
4. **Error Details**: Comprehensive actual/expected value display

### Performance Considerations
1. **Simple Extraction**: Faster than regex parsing
2. **Direct Variable Access**: No complex mapping lookups
3. **KST Timestamps**: Proper timezone handling for Korean users
4. **Debug Logging**: Available key logging for troubleshooting