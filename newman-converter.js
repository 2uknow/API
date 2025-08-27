// SClient 결과를 Newman 형식으로 변환하는 컨버터
import newman from 'newman';
import path from 'path';
import fs from 'fs';

/**
 * SClient 시나리오 결과를 Newman 실행 결과 형식으로 변환
 */
export class SClientToNewmanConverter {
  constructor() {
    this.reportGenerators = {};
  }

  /**
   * SClient 시나리오 결과를 Newman 실행 결과로 변환
   */
  convertToNewmanRun(scenarioResult) {
    const { info, steps, summary, startTime, endTime } = scenarioResult;
    
    // Newman Collection 형식으로 변환
    const collection = {
      info: {
        _postman_id: this.generateId(),
        name: info.name,
        description: info.description || '',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: steps.map((step, index) => ({
        name: step.name,
        event: step.tests ? [{
          listen: 'test',
          script: {
            exec: step.tests.map(test => test.script || `pm.test("${test.name}", function () { /* test logic */ });`)
          }
        }] : [],
        request: {
          method: 'POST',
          header: [],
          body: {
            mode: 'raw',
            raw: JSON.stringify({
              command: step.command,
              arguments: step.arguments || step.response?.arguments || {},
              cmdString: step.response?.cmdString || ''
            })
          },
          url: {
            raw: 'sclient://local',
            protocol: 'sclient',
            host: ['local']
          }
        }
      }))
    };

    // Newman 실행 통계 생성
    const stats = {
      requests: {
        total: summary.total,
        failed: summary.failed,
        pending: 0
      },
      assertions: {
        total: this.countTotalTests(steps),
        failed: this.countFailedTests(steps),
        pending: 0
      },
      testScripts: {
        total: steps.filter(s => s.tests && s.tests.length > 0).length,
        failed: steps.filter(s => s.tests && s.tests.some(t => !t.passed)).length,
        pending: 0
      },
      prerequestScripts: {
        total: 0,
        failed: 0,
        pending: 0
      }
    };

    // Newman 실행 결과 생성
    const executions = steps.map((step, index) => {
      const execution = {
        id: this.generateId(),
        item: {
          id: this.generateId(),
          name: step.name,
          _: {
            postman_id: this.generateId()
          }
        },
        request: {
          url: {
            raw: 'sclient://local',
            protocol: 'sclient',
            host: ['local']
          },
          method: 'POST',
          header: [],
          body: {
            mode: 'raw',
            raw: JSON.stringify({
              command: step.command,
              arguments: step.arguments || step.response?.arguments || {},
              cmdString: step.response?.cmdString || ''
            })
          }
        },
        response: {
          id: this.generateId(),
          status: step.passed ? 'OK' : 'ERROR',
          code: step.response?.exitCode || (step.passed ? 0 : 1),
          header: [],
          stream: Buffer.from(step.response?.stdout || ''),
          responseTime: step.response?.duration || step.duration || 0,
          responseSize: (step.response?.stdout || '').length
        },
        assertions: (step.tests || []).map(test => ({
          assertion: test.name,
          description: test.description || null,
          skipped: false,
          error: test.passed ? null : {
            name: 'AssertionError',
            index: 0,
            test: test.name,
            message: test.error || 'Test failed',
            stack: test.error || 'Test failed'
          }
        })),
        testScript: step.tests && step.tests.length > 0 ? {
          id: this.generateId(),
          type: 'text/javascript',
          exec: step.tests.map(test => test.script || `pm.test("${test.name}", function () { /* test logic */ });`)
        } : undefined
      };

      return execution;
    });

    // Newman Run 객체 생성
    const run = {
      id: this.generateId(),
      stats,
      executions,
      failures: executions.filter(e => e.assertions.some(a => a.error))
        .map(e => ({
          error: e.assertions.find(a => a.error)?.error,
          at: e.item.name,
          source: {
            name: e.item.name
          }
        })),
      collection: {
        id: collection.info._postman_id,
        name: collection.info.name,
        description: collection.info.description
      },
      environment: {},
      globals: {},
      timings: {
        responseAverage: this.calculateAverageResponseTime(executions),
        responseMin: this.calculateMinResponseTime(executions),
        responseMax: this.calculateMaxResponseTime(executions),
        started: new Date(startTime).getTime(),
        completed: new Date(endTime || Date.now()).getTime()
      }
    };

    return {
      collection,
      run,
      newmanOptions: {
        collection,
        environment: {},
        globals: {},
        iterationCount: 1,
        folder: undefined,
        data: undefined
      }
    };
  }

  /**
   * Newman Reporter를 사용하여 리포트 생성
   */
  async generateReport(scenarioResult, outputPath, reporterName = 'htmlextra') {
    const converted = this.convertToNewmanRun(scenarioResult);
    
    return new Promise((resolve, reject) => {
      const reporterOptions = this.getReporterOptions(reporterName, outputPath);
      
      // Newman 실행 시뮬레이션
      const mockNewmanRun = {
        on: (event, callback) => {
          if (event === 'start') {
            setTimeout(() => callback(null, { collection: converted.collection }), 10);
          } else if (event === 'done') {
            setTimeout(() => callback(null, converted.run), 100);
          }
        }
      };

      try {
        // Reporter 직접 호출
        this.callReporter(reporterName, converted, outputPath)
          .then(resolve)
          .catch(reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Reporter 직접 호출
   */
  async callReporter(reporterName, converted, outputPath) {
    const { collection, run } = converted;
    
    switch (reporterName) {
      case 'htmlextra':
        return await this.generateHTMLExtraReport(collection, run, outputPath);
      case 'html':
        return await this.generateHTMLReport(collection, run, outputPath);
      case 'json':
        return await this.generateJSONReport(collection, run, outputPath);
      case 'junit':
        return await this.generateJUnitReport(collection, run, outputPath);
      default:
        throw new Error(`Unsupported reporter: ${reporterName}`);
    }
  }

  /**
   * HTMLExtra 리포트 생성 (Newman 스타일 템플릿 적용)
   */
  async generateHTMLExtraReport(collection, run, outputPath) {
    // Newman HTMLExtra 스타일의 고급 HTML 리포트 생성
    const html = this.generateNewmanStyleHTML(collection, run);
    fs.writeFileSync(outputPath, html);
    return { success: true, path: outputPath };
  }

  /**
   * 커스텀 HTML 리포트 생성 (fallback)
   */
  async generateCustomHTMLReport(collection, run, outputPath) {
    const html = this.generateCustomHTML(collection, run);
    fs.writeFileSync(outputPath, html);
    return { success: true, path: outputPath };
  }

  /**
   * Newman HTMLExtra 스타일 HTML 생성
   */
  generateNewmanStyleHTML(collection, run) {
    console.log('[HTML DEBUG] SClientToNewmanConverter.generateNewmanStyleHTML called');
    const { stats, executions, timings, failures } = run;
    const successRate = ((stats.requests.total - stats.requests.failed) / stats.requests.total * 100).toFixed(1);
    const duration = timings.completed - timings.started;
    const avgResponseTime = timings.responseAverage || 0;

    return `
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${collection.info.name} - Newman Report</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><defs><linearGradient id=%22g%22 x1=%220%22 y1=%220%22 x2=%221%22 y2=%221%22><stop offset=%220%25%22 stop-color=%22%237c3aed%22/><stop offset=%22100%25%22 stop-color=%22%233b82f6%22/></linearGradient></defs><circle cx=%2250%22 cy=%2250%22 r=%2245%22 fill=%22url(%23g)%22/><path d=%22M30 35h40v8H30zM30 47h30v8H30zM30 59h35v8H30z%22 fill=%22white%22/><circle cx=%2275%22 cy=%2228%22 r=%228%22 fill=%22%2328a745%22/></svg>">
    <link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAADZ0lEQVRYhe2Xa0iTcRjGf+/2uc1t5nRzXsqyQrPSsguRlRGRFxItLSIqKCEhgiAiKChCpQ+RH/rQhy4fCqKgD0UfCrqQkRUVdKEPURZlF8wsb3Nq2+Y293beDwGRCprO9qGBHzz/533+/+d5/u/zPuMlmUySZFkmSdK/7ReMAv8fwP8esCzL8vJsucJstkBGRBP/A6PfvwlKzWG/yDzWmGPjU4gYHe2B6q3YlKqFVJLB3tUbuM/XoGnkPXb/bT5FLH7l9/Ni+OTLqWPLKCH7OOlNJHY3EvddR+PAa4wFhuE1eWE2m2B6D2GJCNx8W4XW3kac0+1gGIaBZGhArJ8j9n17CfKgXrR1v8TWy3fFGi5nZjA4MoV4R0eCb/8+7K6pxNWGN6hcuwUCwwMA0P9dD4V+NW49r4Qj7YSQYUFZh3L9DfF3KZXX4JkNxzSyKLM3Ilt9K8SyNb9Zqm5l+nQ5t3Irlna1ek1H83vkLM/GjbfNaOz8jMrXH1Fc+wYp/hJExHph3/VynL/3AlazBfe7+pA5Y7IVv3OKy+ePKKk7TfcsOY2XZdtI51QwKyWoq0lStZfyFlNp3VkKXp2HiJhwZM2YjqRYOXjBa/HHKIyOQ2RUKhZNnglv75XY3ZSDg3VtuNPZDyPPY/f9Dhxrfg+73Q6r1QqHwwGO42A2m8U1PoaFpY3BwZaHFOz7VJfS6+6xAo0qByEe2wg5pjfpyOJfZCPd7dBOe3L85k+mfY4TLx04xzHm+YEL7RpXk0LTKLXwVhOJSKTN7Qv8/FdXnYZcLJWF4/6nr/jlyPDTyPRRjmJRCOa6YGZGh+F7aBAMwzwwm822p10fqSJjqj2A4MDbZPJZK5w29g21H2+oGjrrR2qhd8Vq6BNiRG6oBBaOg9Oqx9XGTjT0j5ItJ68jM2uKSZcKbz9/XKj6g1GjyaRdHO42E5w9HKJXJyJCGYAIvAKPexox6LXg4x2ot/bL3zbvDtSN4E9kGVnq4fMkm8FNMiYyaBCqLbFyB8+nYNy+dPEgYxcKOYSrv7gFz3WVWMv7u6u/vAb8PXAcB5vNJq4Jh8MBhmHgdDrBMAykUil4nofZbIbJZILD4YDNZgMgbiIYhAISwzBI7HMBYFkW4uNgIjxnLEV+Ayjqv7lKQ4WLAAAAAElFTkSuQmCC">
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            /* Light theme colors */
            --bg-primary: #ffffff;
            --bg-secondary: #f8f9fa;
            --bg-tertiary: #e9ecef;
            --bg-elevated: #ffffff;
            --text-primary: #212529;
            --text-secondary: #6c757d;
            --text-muted: #adb5bd;
            --border-color: #dee2e6;
            --border-hover: #007bff;
            --shadow-color: rgba(0, 0, 0, 0.1);
            --gradient-primary: linear-gradient(135deg, #7c3aed 0%, #3b82f6 100%);
            --success-color: #28a745;
            --success-bg: rgba(40, 167, 69, 0.1);
            --success-border: rgba(40, 167, 69, 0.3);
            --error-color: #dc3545;
            --error-bg: rgba(220, 53, 69, 0.1);
            --error-border: rgba(220, 53, 69, 0.3);
            --info-color: #007bff;
            --warning-color: #ffc107;
            --hover-bg: #f8f9fa;
            --card-bg: #ffffff;
            --code-bg: #f8f9fa;
        }

        [data-theme="dark"] {
            /* Dark theme colors */
            --bg-primary: #0d1117;
            --bg-secondary: #161b22;
            --bg-tertiary: #21262d;
            --bg-elevated: #161b22;
            --text-primary: #c9d1d9;
            --text-secondary: #8b949e;
            --text-muted: #6e7681;
            --border-color: #30363d;
            --border-hover: #58a6ff;
            --shadow-color: rgba(0, 0, 0, 0.3);
            --gradient-primary: linear-gradient(135deg, #7c3aed 0%, #3b82f6 100%);
            --success-color: #238636;
            --success-bg: rgba(35, 134, 54, 0.2);
            --success-border: rgba(35, 134, 54, 0.4);
            --error-color: #da3633;
            --error-bg: rgba(218, 54, 51, 0.2);
            --error-border: rgba(218, 54, 51, 0.4);
            --info-color: #58a6ff;
            --warning-color: #d29922;
            --hover-bg: #21262d;
            --card-bg: #161b22;
            --code-bg: #161b22;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Roboto', sans-serif; 
            background: var(--bg-primary); 
            color: var(--text-primary);
            line-height: 1.6;
            transition: background-color 0.3s ease, color 0.3s ease;
        }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        
        /* Theme Toggle */
        .theme-toggle {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 1000;
            background: var(--card-bg);
            border: 2px solid var(--border-color);
            border-radius: 25px;
            padding: 8px 16px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            color: var(--text-primary);
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px var(--shadow-color);
        }
        .theme-toggle:hover {
            border-color: var(--border-hover);
            transform: translateY(-1px);
            box-shadow: 0 6px 16px var(--shadow-color);
        }
        .theme-toggle::before {
            content: '🌙';
            margin-right: 8px;
        }
        [data-theme="light"] .theme-toggle::before {
            content: '☀️';
        }
        
        /* Header */
        .header { 
            background: var(--gradient-primary);
            color: white; 
            padding: 40px 30px;
            border-radius: 12px;
            margin-bottom: 30px;
            box-shadow: 0 8px 32px var(--shadow-color);
            border: 1px solid var(--border-color);
            position: relative;
        }
        .header h1 { 
            font-size: 2.5rem; 
            font-weight: 300; 
            margin-bottom: 10px;
            text-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }
        .header .subtitle { 
            font-size: 1.1rem; 
            opacity: 0.9; 
            font-weight: 300;
        }
        .header .meta {
            margin-top: 20px;
            font-size: 0.95rem;
            opacity: 0.8;
        }
        
        /* Dashboard Cards */
        .dashboard { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
            gap: 20px; 
            margin-bottom: 30px; 
        }
        .metric-card { 
            background: var(--card-bg); 
            padding: 25px; 
            border-radius: 12px; 
            box-shadow: 0 4px 20px var(--shadow-color);
            text-align: center;
            transition: transform 0.2s ease, box-shadow 0.2s ease, background-color 0.3s ease;
            border: 1px solid var(--border-color);
        }
        .metric-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px var(--shadow-color);
            border-color: var(--border-hover);
        }
        .metric-number { 
            font-size: 2.8rem; 
            font-weight: 700; 
            margin-bottom: 8px;
            background: linear-gradient(135deg, #7c3aed, #3b82f6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .metric-label { 
            color: var(--text-secondary); 
            font-size: 0.9rem; 
            text-transform: uppercase; 
            letter-spacing: 1px;
            font-weight: 500;
        }
        .metric-pass { color: var(--success-color); }
        .metric-fail { color: var(--error-color); }
        .metric-warning { color: var(--warning-color); }
        
        /* Progress Ring */
        .progress-ring {
            position: relative;
            width: 120px;
            height: 120px;
            margin: 20px auto;
        }
        .progress-ring svg {
            width: 100%;
            height: 100%;
            transform: rotate(-90deg);
        }
        .progress-ring circle {
            fill: none;
            stroke-width: 8;
        }
        .progress-ring .bg {
            stroke: var(--border-color);
        }
        .progress-ring .progress {
            stroke: var(--success-color);
            stroke-dasharray: 283;
            stroke-dashoffset: ${283 - (283 * successRate / 100)};
            stroke-linecap: round;
            transition: stroke-dashoffset 0.5s ease;
        }
        .progress-text {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 1.4rem;
            font-weight: 700;
            color: var(--success-color);
        }
        
        /* Test Results */
        .test-results { 
            background: var(--card-bg); 
            border-radius: 12px; 
            box-shadow: 0 4px 20px var(--shadow-color);
            margin-bottom: 30px;
            border: 1px solid var(--border-color);
        }
        .section-header {
            background: linear-gradient(135deg, var(--bg-tertiary), var(--border-color));
            padding: 20px 30px;
            border-radius: 12px 12px 0 0;
            border-bottom: 1px solid var(--border-color);
        }
        .section-title {
            font-size: 1.4rem;
            font-weight: 500;
            color: var(--text-primary);
            margin-bottom: 5px;
        }
        .section-subtitle {
            color: var(--text-secondary);
            font-size: 0.9rem;
        }
        
        /* Request Items */
        .request-item { 
            border-bottom: 1px solid var(--border-color); 
            transition: background-color 0.2s ease;
        }
        .request-item:last-child { border-bottom: none; }
        .request-item:hover { background-color: var(--hover-bg); }
        
        .request-header { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            padding: 25px 30px;
            cursor: pointer;
        }
        .request-name { 
            font-weight: 500; 
            font-size: 1.1rem;
            color: var(--text-primary);
        }
        .request-method {
            background: var(--info-color);
            color: white;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: 500;
            margin-right: 15px;
        }
        .request-status { 
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .status-badge { 
            padding: 6px 16px; 
            border-radius: 20px; 
            font-size: 0.85rem; 
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .status-pass { 
            background: var(--success-bg); 
            color: var(--success-color); 
            border: 1px solid var(--success-border);
        }
        .status-fail { 
            background: var(--error-bg); 
            color: var(--error-color); 
            border: 1px solid var(--error-border);
        }
        .response-time {
            font-size: 0.9rem;
            color: var(--text-secondary);
            font-weight: 500;
        }
        
        /* Request Details */
        .request-details { 
            padding: 0 30px 25px 30px;
            background: var(--bg-primary);
            border-top: 1px solid var(--border-color);
        }
        .details-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-top: 20px;
        }
        .detail-item {
            background: var(--bg-tertiary);
            padding: 15px;
            border-radius: 8px;
            border: 1px solid var(--border-color);
        }
        .detail-label {
            font-size: 0.8rem;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
            font-weight: 500;
        }
        .detail-value {
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 0.9rem;
            background: var(--code-bg);
            padding: 10px;
            border-radius: 4px;
            border: 1px solid var(--border-color);
            white-space: pre-wrap;
            word-break: break-all;
            color: var(--text-primary);
        }
        
        /* Assertions */
        .assertions {
            margin-top: 20px;
        }
        .assertion {
            display: flex;
            align-items: center;
            padding: 12px 15px;
            margin: 8px 0;
            border-radius: 8px;
            font-size: 0.95rem;
        }
        .assertion-pass {
            background: var(--success-bg);
            border-left: 4px solid var(--success-color);
            color: var(--success-color);
        }
        .assertion-fail {
            background: var(--error-bg);
            border-left: 4px solid var(--error-color);
            color: var(--error-color);
        }
        .assertion-icon {
            margin-right: 12px;
            font-weight: bold;
            font-size: 1.1rem;
        }
        .assertion-pass .assertion-icon { color: var(--success-color); }
        .assertion-fail .assertion-icon { color: var(--error-color); }
        
        /* Summary Stats */
        .summary-section {
            background: var(--card-bg);
            border-radius: 12px;
            box-shadow: 0 4px 20px var(--shadow-color);
            padding: 30px;
            margin-bottom: 30px;
            border: 1px solid var(--border-color);
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 20px;
        }
        .stat-item {
            text-align: center;
            padding: 20px;
            background: var(--bg-tertiary);
            border-radius: 8px;
            border: 1px solid var(--border-color);
        }
        .stat-number {
            font-size: 1.8rem;
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 5px;
        }
        .stat-label {
            color: var(--text-secondary);
            font-size: 0.85rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        /* Footer */
        .footer { 
            text-align: center; 
            margin-top: 40px; 
            padding: 20px;
            color: var(--text-secondary); 
            font-size: 0.9rem;
        }
        .footer a {
            color: var(--info-color);
            text-decoration: none;
        }
        .footer a:hover {
            color: var(--border-hover);
        }
        
        /* Tooltip styles */
        .tooltip {
            position: relative;
            cursor: help;
        }
        
        .tooltip::before {
            content: attr(data-tooltip);
            position: absolute;
            bottom: 125%;
            left: 50%;
            transform: translateX(-50%);
            background: var(--text-primary);
            color: var(--bg-primary);
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 0.85rem;
            white-space: pre-line;
            max-width: 300px;
            min-width: 150px;
            text-align: left;
            line-height: 1.4;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.3s, visibility 0.3s;
            z-index: 1000;
            pointer-events: none;
        }
        
        .tooltip::after {
            content: '';
            position: absolute;
            bottom: 115%;
            left: 50%;
            transform: translateX(-50%);
            border: 5px solid transparent;
            border-top-color: var(--text-primary);
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.3s, visibility 0.3s;
            z-index: 1000;
        }
        
        .tooltip:hover::before,
        .tooltip:hover::after {
            opacity: 1;
            visibility: visible;
        }

        /* Ensure tooltip doesn't get cut off on the right side */
        .assertion.tooltip:last-child::before {
            left: auto;
            right: 0;
            transform: none;
        }
        
        .assertion.tooltip:last-child::after {
            left: auto;
            right: 15px;
            transform: none;
        }
        
        /* Responsive */
        @media (max-width: 768px) {
            .container { padding: 15px; }
            .dashboard { grid-template-columns: repeat(2, 1fr); }
            .details-grid { grid-template-columns: 1fr; }
            .header h1 { font-size: 2rem; }
        }
    </style>
</head>
<body>
    <!-- Theme Toggle -->
    <button class="theme-toggle" onclick="toggleTheme()">Dark Mode</button>
    
    <div class="container">
        <!-- Header -->
        <div class="header">
            <h1>${collection.info.name}</h1>
            <div class="subtitle">${collection.info.description || 'API Test Report'}</div>
            <div class="meta">
                Generated on ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} • 
                Duration: ${duration}ms
            </div>
        </div>

        <!-- Dashboard Metrics -->
        <div class="dashboard">
            <div class="metric-card">
                <div class="progress-ring">
                    <svg>
                        <circle class="bg" cx="60" cy="60" r="45"></circle>
                        <circle class="progress" cx="60" cy="60" r="45"></circle>
                    </svg>
                    <div class="progress-text">${successRate}%</div>
                </div>
                <div class="metric-label">Success Rate</div>
            </div>
            <div class="metric-card">
                <div class="metric-number">${stats.requests.total}</div>
                <div class="metric-label">Total Requests</div>
            </div>
            <div class="metric-card">
                <div class="metric-number metric-pass">${stats.requests.total - stats.requests.failed}</div>
                <div class="metric-label">Passed</div>
            </div>
            <div class="metric-card">
                <div class="metric-number metric-fail">${stats.requests.failed}</div>
                <div class="metric-label">Failed</div>
            </div>
            <div class="metric-card">
                <div class="metric-number">${avgResponseTime}ms</div>
                <div class="metric-label">Avg Response</div>
            </div>
        </div>

        <!-- Test Results -->
        <div class="test-results">
            <div class="section-header">
                <div class="section-title">Request Results</div>
                <div class="section-subtitle">${executions.length} request${executions.length !== 1 ? 's' : ''} executed</div>
            </div>
            
            ${executions.map((execution, index) => {
                const hasFailures = execution.assertions.some(a => a.error);
                const responseData = execution.response.stream ? execution.response.stream.toString() : '';
                
                return `
                <div class="request-item">
                    <div class="request-header" onclick="toggleDetails('request-${index}')">
                        <div style="display: flex; align-items: center;">
                            <span class="request-method">POST</span>
                            <span class="request-name">${execution.item.name}</span>
                        </div>
                        <div class="request-status">
                            <span class="response-time">${execution.response.responseTime}ms</span>
                            <span class="status-badge ${hasFailures ? 'status-fail' : 'status-pass'}">
                                ${hasFailures ? 'FAIL' : 'PASS'}
                            </span>
                        </div>
                    </div>
                    <div class="request-details" id="request-${index}" style="display: none;">
                        <div class="details-grid">
                            <div class="detail-item">
                                <div class="detail-label">Status Code</div>
                                <div class="detail-value">${execution.response.code}</div>
                            </div>
                            <div class="detail-item">
                                <div class="detail-label">Response Size</div>
                                <div class="detail-value">${execution.response.responseSize} bytes</div>
                            </div>
                        </div>
                        
                        ${execution.assertions.length > 0 ? `
                            <div class="assertions">
                                <div class="detail-label">Test Results</div>
                                ${execution.assertions.map(assertion => {
                                    const hasDescription = assertion.description && assertion.description.trim();
                                    const tooltipClass = hasDescription ? 'tooltip' : '';
                                    const tooltipAttr = hasDescription ? `data-tooltip="${assertion.description.replace(/"/g, '&quot;')}"` : '';
                                    
                                    // DEBUG: Log tooltip generation
                                    console.log(`[TOOLTIP DEBUG] Test: "${assertion.assertion}", Description: "${assertion.description}", HasTooltip: ${hasDescription}`);
                                    
                                    return `
                                    <div class="assertion ${assertion.error ? 'assertion-fail' : 'assertion-pass'} ${tooltipClass}" ${tooltipAttr}>
                                        <span class="assertion-icon">${assertion.error ? '✗' : '✓'}</span>
                                        ${assertion.assertion}
                                        ${assertion.error ? `<br><small>${assertion.error.message}</small>` : ''}
                                    </div>
                                    `;
                                }).join('')}
                            </div>
                        ` : ''}
                        
                        ${execution.request.body && execution.request.body.raw ? `
                            <div style="margin-top: 20px;">
                                <div class="detail-label">Request Command</div>
                                <div class="detail-value">${(() => {
                                  try {
                                    const requestData = JSON.parse(execution.request.body.raw);
                                    if (requestData.cmdString) {
                                      return requestData.cmdString.replace(/;/g, ';\\n').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                                    } else {
                                      return Object.entries(requestData.arguments || {}).map(([key, value]) => 
                                        `${key}=${value}`).join(';\\n');
                                    }
                                  } catch (e) {
                                    return execution.request.body.raw.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                                  }
                                })()}</div>
                            </div>
                        ` : ''}
                        
                        ${responseData ? `
                            <div style="margin-top: 20px;">
                                <div class="detail-label">Response Body</div>
                                <div class="detail-value">${responseData.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                            </div>
                        ` : ''}
                    </div>
                </div>
                `;
            }).join('')}
        </div>

        <!-- Summary -->
        <div class="summary-section">
            <div class="section-title" style="text-align: center; margin-bottom: 20px;">Execution Summary</div>
            <div class="stats-grid">
                <div class="stat-item">
                    <div class="stat-number">${stats.assertions.total}</div>
                    <div class="stat-label">Total Tests</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${stats.assertions.failed}</div>
                    <div class="stat-label">Failed Tests</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${timings.responseMin || 0}ms</div>
                    <div class="stat-label">Min Response</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${timings.responseMax || 0}ms</div>
                    <div class="stat-label">Max Response</div>
                </div>
            </div>
        </div>

        <!-- Footer -->
        <div class="footer">
            <p>Generated by <a href="https://github.com/postmanlabs/newman" target="_blank">Newman</a> HTMLExtra Reporter</p>
            <p>Powered by 2uknow API Monitor - SClient Integration</p>
        </div>
    </div>

    <script>
        // Theme management
        function initTheme() {
            const savedTheme = localStorage.getItem('theme') || 'dark';
            document.documentElement.setAttribute('data-theme', savedTheme);
            updateThemeButton(savedTheme);
        }
        
        function toggleTheme() {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            updateThemeButton(newTheme);
        }
        
        function updateThemeButton(theme) {
            const button = document.querySelector('.theme-toggle');
            if (button) {
                button.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
            }
        }
        
        // Request details toggle
        function toggleDetails(id) {
            const element = document.getElementById(id);
            if (element.style.display === 'none') {
                element.style.display = 'block';
            } else {
                element.style.display = 'none';
            }
        }
        
        // Initialize theme on page load
        document.addEventListener('DOMContentLoaded', initTheme);
    </script>
</body>
</html>
    `.trim();
  }

  /**
   * 커스텀 HTML 템플릿 생성
   */
  generateCustomHTML(collection, run) {
    const { stats, executions, timings } = run;
    const successRate = ((stats.requests.total - stats.requests.failed) / stats.requests.total * 100).toFixed(1);
    const duration = timings.completed - timings.started;

    return `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${collection.info.name} - SClient Test Report</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><defs><linearGradient id=%22g%22 x1=%220%22 y1=%220%22 x2=%221%22 y2=%221%22><stop offset=%220%25%22 stop-color=%22%237c3aed%22/><stop offset=%22100%25%22 stop-color=%22%233b82f6%22/></linearGradient></defs><circle cx=%2250%22 cy=%2250%22 r=%2245%22 fill=%22url(%23g)%22/><path d=%22M30 35h40v8H30zM30 47h30v8H30zM30 59h35v8H30z%22 fill=%22white%22/><circle cx=%2275%22 cy=%2228%22 r=%228%22 fill=%22%2328a745%22/></svg>">
    <link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAADZ0lEQVRYhe2Xa0iTcRjGf+/2uc1t5nRzXsqyQrPSsguRlRGRFxItLSIqKCEhgiAiKChCpQ+RH/rQhy4fCqKgD0UfCrqQkRUVdKEPURZlF8wsb3Nq2+Y293beDwGRCprO9qGBHzz/533+/+d5/u/zPuMlmUySZFkmSdK/7ReMAv8fwP8esCzL8vJsucJstkBGRBP/A6PfvwlKzWG/yDzWmGPjU4gYHe2B6q3YlKqFVJLB3tUbuM/XoGnkPXb/bT5FLH7l9/Ni+OTLqWPLKCH7OOlNJHY3EvddR+PAa4wFhuE1eWE2m2B6D2GJCNx8W4XW3kac0+1gGIaBZGhArJ8j9n17CfKgXrR1v8TWy3fFGi5nZjA4MoV4R0eCb/8+7K6pxNWGN6hcuwUCwwMA0P9dD4V+NW49r4Qj7YSQYUFZh3L9DfF3KZXX4JkNxzSyKLM3Ilt9K8SyNb9Zqm5l+nQ5t3Irlna1ek1H83vkLM/GjbfNaOz8jMrXH1Fc+wYp/hJExHph3/VynL/3AlazBfe7+pA5Y7IVv3OKy+ePKKk7TfcsOY2XZdtI51QwKyWoq0lStZfyFlNp3VkKXp2HiJhwZM2YjqRYOXjBa/HHKIyOQ2RUKhZNnglv75XY3ZSDg3VtuNPZDyPPY/f9Dhxrfg+73Q6r1QqHwwGO42A2m8U1PoaFpY3BwZaHFOz7VJfS6+6xAo0qByEe2wg5pjfpyOJfZCPd7dBOe3L85k+mfY4TLx04xzHm+YEL7RpXk0LTKLXwVhOJSKTN7Qv8/FdXnYZcLJWF4/6nr/jlyPDTyPRRjmJRCOa6YGZGh+F7aBAMwzwwm822p10fqSJjqj2A4MDbZPJZK5w29g21H2+oGjrrR2qhd8Vq6BNiRG6oBBaOg9Oqx9XGTjT0j5ItJ68jM2uKSZcKbz9/XKj6g1GjyaRdHO42E5w9HKJXJyJCGYAIvAKPexox6LXg4x2ot/bL3zbvDtSN4E9kGVnq4fMkm8FNMiYyaBCqLbFyB8+nYNy+dPEgYxcKOYSrv7gFz3WVWMv7u6u/vAb8PXAcB5vNJq4Jh8MBhmHgdDrBMAykUil4nofZbIbJZILD4YDNZgMgbiIYhAISwzBI7HMBYFkW4uNgIjxnLEV+Ayjqv7lKQ4WLAAAAAElFTkSuQmCC">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .header h1 { color: #2c3e50; margin-bottom: 10px; }
        .header p { color: #666; margin-bottom: 5px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); text-align: center; }
        .stat-value { font-size: 2.5em; font-weight: bold; margin-bottom: 5px; }
        .stat-label { color: #666; text-transform: uppercase; letter-spacing: 1px; font-size: 0.8em; }
        .success { color: #27ae60; }
        .error { color: #e74c3c; }
        .warning { color: #f39c12; }
        .executions { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .execution { border-bottom: 1px solid #eee; padding: 20px; }
        .execution:last-child { border-bottom: none; }
        .execution-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .execution-name { font-weight: 600; font-size: 1.1em; }
        .execution-status { padding: 4px 12px; border-radius: 4px; font-size: 0.9em; font-weight: 500; }
        .status-pass { background: #d4edda; color: #155724; }
        .status-fail { background: #f8d7da; color: #721c24; }
        .execution-details { color: #666; font-size: 0.9em; }
        .assertions { margin-top: 15px; }
        .assertion { padding: 8px 12px; margin: 5px 0; border-radius: 4px; }
        .assertion-pass { background: #d4edda; color: #155724; }
        .assertion-fail { background: #f8d7da; color: #721c24; }
        .response-data { background: #f8f9fa; padding: 15px; border-radius: 4px; margin-top: 10px; font-family: 'Courier New', monospace; font-size: 0.9em; }
        .footer { text-align: center; margin-top: 40px; color: #666; font-size: 0.9em; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${collection.info.name}</h1>
            <p><strong>Description:</strong> ${collection.info.description || 'SClient Scenario Test'}</p>
            <p><strong>Generated:</strong> ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>
            <p><strong>Duration:</strong> ${duration}ms</p>
        </div>

        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${stats.requests.total}</div>
                <div class="stat-label">Total Requests</div>
            </div>
            <div class="stat-card">
                <div class="stat-value success">${stats.requests.total - stats.requests.failed}</div>
                <div class="stat-label">Passed</div>
            </div>
            <div class="stat-card">
                <div class="stat-value error">${stats.requests.failed}</div>
                <div class="stat-label">Failed</div>
            </div>
            <div class="stat-card">
                <div class="stat-value ${successRate >= 80 ? 'success' : successRate >= 50 ? 'warning' : 'error'}">${successRate}%</div>
                <div class="stat-label">Success Rate</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${timings.responseAverage}ms</div>
                <div class="stat-label">Avg Response</div>
            </div>
        </div>

        <div class="executions">
            ${executions.map((execution, index) => `
                <div class="execution">
                    <div class="execution-header">
                        <div class="execution-name">${index + 1}. ${execution.item.name}</div>
                        <div class="execution-status ${execution.assertions.every(a => !a.error) ? 'status-pass' : 'status-fail'}">
                            ${execution.assertions.every(a => !a.error) ? 'PASS' : 'FAIL'}
                        </div>
                    </div>
                    <div class="execution-details">
                        <span><strong>Response Time:</strong> ${execution.response.responseTime}ms</span> •
                        <span><strong>Status Code:</strong> ${execution.response.code}</span> •
                        <span><strong>Size:</strong> ${execution.response.responseSize} bytes</span>
                    </div>
                    
                    ${execution.assertions.length > 0 ? `
                        <div class="assertions">
                            <strong>Assertions:</strong>
                            ${execution.assertions.map(assertion => `
                                <div class="assertion ${assertion.error ? 'assertion-fail' : 'assertion-pass'}">
                                    ${assertion.error ? '✗' : '✓'} ${assertion.assertion}
                                    ${assertion.error ? `<br><small>${assertion.error.message}</small>` : ''}
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                    
                    ${execution.request.body && execution.request.body.raw ? `
                        <div class="response-data">
                            <strong>Request Command:</strong><br>
                            ${(() => {
                              try {
                                const requestData = JSON.parse(execution.request.body.raw);
                                if (requestData.cmdString) {
                                  return requestData.cmdString.replace(/;/g, ';<br>').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                                } else {
                                  return Object.entries(requestData.arguments || {}).map(([key, value]) => 
                                    `${key}=${value}`).join(';<br>');
                                }
                              } catch (e) {
                                return execution.request.body.raw.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                              }
                            })()}
                        </div>
                    ` : ''}
                    
                    ${execution.response.stream && execution.response.stream.length > 0 ? `
                        <div class="response-data">
                            <strong>Response:</strong><br>
                            ${execution.response.stream.toString().replace(/</g, '&lt;').replace(/>/g, '&gt;')}
                        </div>
                    ` : ''}
                </div>
            `).join('')}
        </div>

        <div class="footer">
            <p>Generated by 2uknow API Monitor - SClient to Newman Reporter</p>
            <p>Powered by Newman HTMLExtra styling</p>
        </div>
    </div>
</body>
</html>
    `.trim();
  }

  /**
   * JSON 리포트 생성
   */
  async generateJSONReport(collection, run, outputPath) {
    const report = {
      collection,
      run,
      summary: {
        stats: run.stats,
        timings: run.timings,
        executions: run.executions.length,
        failures: run.failures.length
      }
    };
    
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    return { success: true, path: outputPath };
  }

  /**
   * JUnit 리포트 생성
   */
  async generateJUnitReport(collection, run, outputPath) {
    const xml = this.generateJUnitXML(collection, run);
    fs.writeFileSync(outputPath, xml);
    return { success: true, path: outputPath };
  }

  /**
   * JUnit XML 생성
   */
  generateJUnitXML(collection, run) {
    const { stats, executions, timings } = run;
    const duration = (timings.completed - timings.started) / 1000;

    const testsuites = `
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${collection.name}" tests="${stats.assertions.total}" failures="${stats.assertions.failed}" time="${duration}">
    <testsuite name="${collection.name}" tests="${stats.assertions.total}" failures="${stats.assertions.failed}" time="${duration}">
        ${executions.map(execution => 
          execution.assertions.map(assertion => `
            <testcase name="${assertion.assertion}" classname="${execution.item.name}" time="${execution.response.responseTime / 1000}">
                ${assertion.error ? `
                    <failure message="${assertion.error.message}" type="${assertion.error.name}">
                        ${assertion.error.stack}
                    </failure>
                ` : ''}
            </testcase>
          `).join('')
        ).join('')}
    </testsuite>
</testsuites>
    `.trim();

    return testsuites;
  }

  // 유틸리티 메서드들
  generateId() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  countTotalTests(steps) {
    return steps.reduce((total, step) => total + (step.tests ? step.tests.length : 0), 0);
  }

  countFailedTests(steps) {
    return steps.reduce((total, step) => 
      total + (step.tests ? step.tests.filter(t => !t.passed).length : 0), 0);
  }

  calculateAverageResponseTime(executions) {
    if (executions.length === 0) return 0;
    const total = executions.reduce((sum, e) => sum + e.response.responseTime, 0);
    return Math.round(total / executions.length);
  }

  calculateMinResponseTime(executions) {
    if (executions.length === 0) return 0;
    return Math.min(...executions.map(e => e.response.responseTime));
  }

  calculateMaxResponseTime(executions) {
    if (executions.length === 0) return 0;
    return Math.max(...executions.map(e => e.response.responseTime));
  }

  getReporterOptions(reporterName, outputPath) {
    const baseOptions = {
      export: outputPath
    };

    switch (reporterName) {
      case 'htmlextra':
        return {
          ...baseOptions,
          template: 'dashboard',
          browserTitle: 'SClient Test Results',
          title: 'SClient Test Report',
          showOnlyFails: false,
          testPaging: false
        };
      default:
        return baseOptions;
    }
  }
}

export default SClientToNewmanConverter;