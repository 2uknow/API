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
    // 강제 디버깅 로그
    console.log('🔍 [NEWMAN_CONVERTER] convertToNewmanRun called!');
    console.log('🔍 [NEWMAN_CONVERTER] scenarioResult type:', typeof scenarioResult);
    console.log('🔍 [NEWMAN_CONVERTER] scenarioResult keys:', Object.keys(scenarioResult || {}));
    console.log('🔍 [NEWMAN_CONVERTER] scenarioResult:', JSON.stringify(scenarioResult, null, 2));
    
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
        total: steps.length,  // 실행된 요청(스텝) 수
        failed: steps.filter(s => !s.passed).length,  // 실패한 요청 수
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
    console.log('🔍 [EXECUTIONS] Creating executions array...');
    console.log('🔍 [EXECUTIONS] Steps count:', steps.length);
    console.log('🔍 [EXECUTIONS] Steps structure:', steps.map((s, i) => ({ index: i, name: s.name, passed: s.passed })));
    
    const executions = steps.map((step, index) => {
      console.log(`🔍 [EXECUTIONS] Processing step ${index + 1}: ${step.name}`);
      
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
            originalAssertion: test.assertion || null,  // 원래 assertion 저장
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
        } : undefined,
        // 원래 step의 extracted 변수 데이터 보존
        extracted: step.extracted || {}
      };

      return execution;
    });

    console.log('🔍 [EXECUTIONS] Final executions array length:', executions.length);
    console.log('🔍 [EXECUTIONS] First execution sample:', executions[0] ? { name: executions[0].item?.name, id: executions[0].id } : 'No executions');

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
    return await this.generateNewmanStyleHTML(run, outputPath, {});
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
  generateNewmanStyleHTML(run, reportPath, options = {}) {
    console.log('[HTML DEBUG] SClientToNewmanConverter.generateNewmanStyleHTML called');
    console.log('[HTML DEBUG] Run type:', typeof run);
    console.log('[HTML DEBUG] Run is null?', run === null);
    console.log('[HTML DEBUG] Run is undefined?', run === undefined);
    console.log('[HTML DEBUG] Run keys:', Object.keys(run || {}));
    console.log('[HTML DEBUG] Run executions exists?', 'executions' in (run || {}));
    console.log('[HTML DEBUG] Run executions type:', typeof (run || {}).executions);
    console.log('[HTML DEBUG] Run executions length:', (run.executions || []).length);
    console.log('[HTML DEBUG] Run executions array:', run.executions);
    console.log('[HTML DEBUG] First 100 chars of run:', JSON.stringify(run, null, 2).substring(0, 100));
    
    const { stats, timings, failures } = run;
    const executions = run.executions || [];
    
    console.log('🔍 [HTML_TEMPLATE] About to generate HTML with executions:', executions.length);
    console.log('🔍 [HTML_TEMPLATE] First execution sample:', executions[0] ? executions[0].item?.name : 'No executions');
    
    // stats와 timings의 각 속성이 없는 경우 기본값 설정
    const requests = stats?.requests || { total: 0, failed: 0 };
    const assertions = stats?.assertions || { total: 0, failed: 0 };
    const timingsSafe = timings || { responseMin: 0, responseMax: 0, responseAverage: 0, completed: 0, started: 0 };
    const successRate = requests.total > 0 
      ? ((requests.total - requests.failed) / requests.total * 100).toFixed(1) 
      : '0.0';
      
    const duration = (timingsSafe.completed || 0) - (timingsSafe.started || 0);
    const avgResponseTime = timingsSafe.responseAverage || 0;

    const html = `
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${run.collection?.name || options.browserTitle || 'Test Report'} - Newman Report</title>
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
        
        /* Expandable Values */
        .expandable-value {
            color: var(--info-color);
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 3px;
            background: rgba(88, 166, 255, 0.1);
            transition: all 0.3s ease;
            display: inline-block;
            position: relative;
            max-width: 100%;
            word-break: break-all;
        }
        
        .expandable-value:hover {
            background: rgba(88, 166, 255, 0.2);
            transform: translateY(-1px);
        }
        
        .expandable-value.expanded {
            background: rgba(88, 166, 255, 0.15);
            padding: 4px 6px;
            border-radius: 4px;
        }
        
        .expandable-value::after {
            content: '🔍';
            position: absolute;
            right: -2px;
            top: -2px;
            font-size: 10px;
            opacity: 0.7;
            transition: opacity 0.3s ease;
        }
        
        .expandable-value:hover::after {
            opacity: 1;
        }
        
        .expandable-value.expanded::after {
            content: '🔄';
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
            <h1>${run.collection?.name || 'Test Report'}</h1>
            <div class="subtitle">${run.collection?.description || 'API Test Report'}</div>
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
                <div class="metric-number">${requests.total}</div>
                <div class="metric-label">Total Requests</div>
            </div>
            <div class="metric-card">
                <div class="metric-number metric-pass">${requests.total - requests.failed}</div>
                <div class="metric-label">Passed</div>
            </div>
            <div class="metric-card">
                <div class="metric-number metric-fail">${requests.failed}</div>
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
                <div class="section-subtitle">${(executions || []).length} request${(executions || []).length !== 1 ? 's' : ''} executed</div>
            </div>
            
            ${(executions || []).map((execution, index) => {
                const hasFailures = (execution.assertions || []).some(a => a.error);
                const responseData = execution.response && execution.response.stream ? execution.response.stream.toString() : '';
                
                return `
                <div class="request-item">
                    <div class="request-header" onclick="toggleDetails('request-${index}')">
                        <div style="display: flex; align-items: center;">
                            <span class="request-method">SClient</span>
                            <span class="request-name">${execution.item && execution.item.name || 'Unknown'}</span>
                        </div>
                        <div class="request-status">
                            <span class="response-time">${execution.response && execution.response.responseTime || 0}ms</span>
                            <span class="status-badge ${hasFailures ? 'status-fail' : 'status-pass'}">
                                ${hasFailures ? 'FAIL' : 'PASS'}
                            </span>
                        </div>
                    </div>
                    <div class="request-details" id="request-${index}" style="display: none;">
                        <div class="details-grid">
                            <div class="detail-item">
                                <div class="detail-label">Status Code</div>
                                <div class="detail-value">${execution.response && execution.response.code || 'N/A'}</div>
                            </div>
                            <div class="detail-item">
                                <div class="detail-label">Response Size</div>
                                <div class="detail-value">${execution.response && execution.response.responseSize || 0} bytes</div>
                            </div>
                        </div>
                        
                        ${(execution.assertions || []).length > 0 ? `
                            <div class="assertions">
                                <div class="detail-label">Test Results</div>
                                ${(execution.assertions || []).map(assertion => {
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
                                        ${assertion.error && assertion.originalAssertion && assertion.originalAssertion.startsWith('js:') ? `
                                        <div style="margin-top: 8px; padding: 8px; background: rgba(220,53,69,0.1); border-left: 3px solid #dc3545; font-size: 12px;">
                                            <strong>JavaScript Condition Analysis:</strong><br>
                                            <code style="background: rgba(0,0,0,0.1); padding: 2px 4px; border-radius: 3px;">${assertion.originalAssertion.substring(3).trim()}</code><br>
                                            ${(() => {
                                                const jsExpression = assertion.originalAssertion.substring(3).trim();
                                                const stepData = (executions || []).find(e => (e.assertions || []).includes(assertion));
                                                const extractedVars = stepData ? stepData.extracted || {} : {};
                                                const conditionAnalysis = SClientToNewmanConverter.analyzeJavaScriptConditions(jsExpression, extractedVars);
                                                if (conditionAnalysis && conditionAnalysis.length > 0) {
                                                    return conditionAnalysis.map(condition => {
                                                        const status = condition.result ? '✅' : '❌';
                                                        return `&nbsp;&nbsp;${status} <code>${condition.expression}</code> → ${condition.result} ${condition.details ? condition.details : ''}`;
                                                    }).join('<br>') + `<br><strong>Overall Result:</strong> false`;
                                                }
                                                return '';
                                            })()}
                                        </div>
                                        ` : ''}
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
                    <div class="stat-number">${assertions.total}</div>
                    <div class="stat-label">Total Tests</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${assertions.failed}</div>
                    <div class="stat-label">Failed Tests</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${timingsSafe.responseMin || 0}ms</div>
                    <div class="stat-label">Min Response</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number">${timingsSafe.responseMax || 0}ms</div>
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
        
        // Toggle expandable value expansion
        function toggleValueExpansion(elementId) {
            const element = document.getElementById(elementId);
            if (!element) return;
            
            const isExpanded = element.classList.contains('expanded');
            
            if (isExpanded) {
                // Collapse: show shortened value
                const fullValue = element.getAttribute('data-full-value');
                const shortValue = fullValue.substring(0, 20);
                element.textContent = shortValue + '...';
                element.classList.remove('expanded');
            } else {
                // Expand: show full value
                const fullValue = element.getAttribute('data-full-value');
                element.textContent = fullValue;
                element.classList.add('expanded');
            }
        }
        
        // Initialize theme on page load
        document.addEventListener('DOMContentLoaded', initTheme);
    </script>
</body>
</html>
    `.trim();
    
    // Write HTML to file
    try {
      fs.writeFileSync(reportPath, html, 'utf8');
      console.log(`[HTML] Report successfully written to: ${reportPath}`);
      return { success: true, path: reportPath };
    } catch (error) {
      console.error(`[HTML] Failed to write report to ${reportPath}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 커스텀 HTML 템플릿 생성
   */
  generateCustomHTML(collection, run) {
    const { stats, executions, timings } = run;
    
    // stats.requests가 없는 경우 기본값 설정
    const requests = stats?.requests || { total: 0, failed: 0 };
    const successRate = requests.total > 0 
      ? ((requests.total - requests.failed) / requests.total * 100).toFixed(1) 
      : '0.0';
      
    const duration = (timings?.completed || 0) - (timings?.started || 0);

    return `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${run.collection?.name || 'Test Report'} - SClient Test Report</title>
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
        
        /* Expandable Values */
        .expandable-value {
            color: #007bff;
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 3px;
            background: rgba(0, 123, 255, 0.1);
            transition: all 0.3s ease;
            display: inline-block;
            position: relative;
            max-width: 100%;
            word-break: break-all;
        }
        
        .expandable-value:hover {
            background: rgba(0, 123, 255, 0.2);
            transform: translateY(-1px);
        }
        
        .expandable-value.expanded {
            background: rgba(0, 123, 255, 0.15);
            padding: 4px 6px;
            border-radius: 4px;
        }
        
        .expandable-value::after {
            content: '🔍';
            position: absolute;
            right: -2px;
            top: -2px;
            font-size: 10px;
            opacity: 0.7;
            transition: opacity 0.3s ease;
        }
        
        .expandable-value:hover::after {
            opacity: 1;
        }
        
        .expandable-value.expanded::after {
            content: '🔄';
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${run.collection?.name || 'Test Report'}</h1>
            <p><strong>Description:</strong> ${run.collection?.description || 'SClient Scenario Test'}</p>
            <p><strong>Generated:</strong> ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>
            <p><strong>Duration:</strong> ${duration}ms</p>
        </div>

        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${requests.total}</div>
                <div class="stat-label">Total Requests</div>
            </div>
            <div class="stat-card">
                <div class="stat-value success">${requests.total - requests.failed}</div>
                <div class="stat-label">Passed</div>
            </div>
            <div class="stat-card">
                <div class="stat-value error">${requests.failed}</div>
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
                        <div class="execution-name">${index + 1}. ${execution.item && execution.item.name || 'Unknown'}</div>
                        <div class="execution-status ${(execution.assertions || []).every(a => !a.error) ? 'status-pass' : 'status-fail'}">
                            ${(execution.assertions || []).every(a => !a.error) ? 'PASS' : 'FAIL'}
                        </div>
                    </div>
                    <div class="execution-details">
                        <span><strong>Response Time:</strong> ${execution.response && execution.response.responseTime || 0}ms</span> •
                        <span><strong>Status Code:</strong> ${execution.response && execution.response.code || 'N/A'}</span> •
                        <span><strong>Size:</strong> ${execution.response && execution.response.responseSize || 0} bytes</span>
                    </div>
                    
                    ${(execution.assertions || []).length > 0 ? `
                        <div class="assertions">
                            <strong>Assertions:</strong>
                            ${(execution.assertions || []).map(assertion => `
                                <div class="assertion ${assertion.error ? 'assertion-fail' : 'assertion-pass'}">
                                    ${assertion.error ? '✗' : '✓'} ${assertion.assertion}
                                    ${assertion.error ? `<br><small>${assertion.error.message}</small>` : ''}
                                    ${assertion.error && assertion.originalAssertion && assertion.originalAssertion.startsWith('js:') ? `
                                    <div style="margin-top: 8px; padding: 8px; background: rgba(220,53,69,0.1); border-left: 3px solid #dc3545; font-size: 12px;">
                                        <strong>JavaScript Condition Analysis:</strong><br>
                                        <code style="background: rgba(0,0,0,0.1); padding: 2px 4px; border-radius: 3px;">${assertion.originalAssertion.substring(3).trim()}</code><br>
                                        ${(() => {
                                            const jsExpression = assertion.originalAssertion.substring(3).trim();
                                            // 현재 execution에서 extracted 변수 찾기
                                            const extractedVars = execution.extracted || {};
                                            const conditionAnalysis = SClientToNewmanConverter.analyzeJavaScriptConditions(jsExpression, extractedVars);
                                            if (conditionAnalysis && conditionAnalysis.length > 0) {
                                                return conditionAnalysis.map(condition => {
                                                    const status = condition.result ? '✅' : '❌';
                                                    return `&nbsp;&nbsp;${status} <code>${condition.expression}</code> → ${condition.result} ${condition.details ? condition.details : ''}`;
                                                }).join('<br>') + `<br><strong>Overall Result:</strong> false`;
                                            }
                                            return '';
                                        })()}
                                    </div>
                                    ` : ''}
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
                    
                    ${execution.response && execution.response.stream && execution.response.stream.length > 0 ? `
                        <div class="response-data">
                            <strong>Response:</strong><br>
                            ${execution.response && execution.response.stream ? execution.response.stream.toString().replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''}
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
    
    <script>
        // Toggle expandable value expansion
        function toggleValueExpansion(elementId) {
            const element = document.getElementById(elementId);
            if (!element) return;
            
            const isExpanded = element.classList.contains('expanded');
            
            if (isExpanded) {
                // Collapse: show shortened value
                const fullValue = element.getAttribute('data-full-value');
                const shortValue = fullValue.substring(0, 20);
                element.textContent = shortValue + '...';
                element.classList.remove('expanded');
            } else {
                // Expand: show full value
                const fullValue = element.getAttribute('data-full-value');
                element.textContent = fullValue;
                element.classList.add('expanded');
            }
        }
    </script>
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
          (execution.assertions || []).map(assertion => `
            <testcase name="${assertion.assertion}" classname="${execution.item && execution.item.name || 'Unknown'}" time="${execution.response && execution.response.responseTime ? execution.response.responseTime / 1000 : 0}">
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

  /**
   * JavaScript 조건식을 분석하여 각 조건의 평가 결과를 반환 (Newman HTML용)
   * @param {string} expression JavaScript 표현식
   * @param {Object} variables 사용 가능한 변수들
   * @returns {Array} 조건별 분석 결과
   */
  static analyzeJavaScriptConditions(expression, variables = {}) {
    try {
      const results = [];
      
      // && 또는 || 연산자로 분리된 조건들 찾기
      const conditions = this.parseConditions(expression);
      
      if (conditions.length <= 1) {
        // 단일 조건인 경우 전체 표현식 평가
        const result = this.evaluateExpression(expression, variables);
        const details = this.getVariableDetails(expression, variables);
        return [{
          expression: expression,
          result: result,
          details: details
        }];
      }
      
      // 각 조건별로 평가
      for (const condition of conditions) {
        const result = this.evaluateExpression(condition.expression, variables);
        const details = this.getVariableDetails(condition.expression, variables);
        
        results.push({
          expression: condition.expression,
          result: result,
          details: details,
          operator: condition.operator
        });
      }
      
      return results;
      
    } catch (error) {
      return [];
    }
  }

  /**
   * JavaScript 표현식을 && 또는 || 연산자로 분리
   */
  static parseConditions(expression) {
    const conditions = [];
    const operators = ['&&', '||'];
    
    // 간단한 파싱 - 괄호를 고려하지 않은 기본 분리
    let current = expression;
    
    for (const op of operators) {
      const parts = current.split(` ${op} `);
      if (parts.length > 1) {
        conditions.length = 0; // 기존 결과 클리어
        for (let i = 0; i < parts.length; i++) {
          conditions.push({
            expression: parts[i].trim(),
            operator: i > 0 ? op : null
          });
        }
        break;
      }
    }
    
    return conditions.length > 0 ? conditions : [{ expression: expression.trim(), operator: null }];
  }

  /**
   * JavaScript 표현식을 안전하게 평가
   */
  static evaluateExpression(expression, variables) {
    try {
      // 사용 가능한 변수들을 함수 컨텍스트에 추가
      const context = { ...variables };
      
      // Function constructor를 사용하여 안전하게 평가
      const func = new Function(...Object.keys(context), `return (${expression})`);
      return func(...Object.values(context));
      
    } catch (error) {
      return false;
    }
  }

  /**
   * 표현식에서 사용된 변수들의 상세 정보 생성 (HTML with expandable values)
   */
  static getVariableDetails(expression, variables) {
    const details = [];
    
    // 변수명 추출 (간단한 패턴 매칭)
    const varMatches = expression.match(/[A-Z_][A-Z0-9_]*/g) || [];
    const uniqueVars = [...new Set(varMatches)];
    
    for (const varName of uniqueVars) {
      if (variables.hasOwnProperty(varName)) {
        const value = variables[varName];
        if (typeof value === 'string' && value.length > 20) {
          const shortValue = value.substring(0, 20);
          const expandId = `expand_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          details.push(`(${varName} = "<span class="expandable-value" data-full-value="${value.replace(/"/g, '&quot;')}" onclick="toggleValueExpansion('${expandId}')" id="${expandId}">${shortValue}...</span>")`);
        } else {
          details.push(`(${varName} = "${value}")`);
        }
      } else {
        details.push(`(${varName} = undefined)`);
      }
    }
    
    return details.length > 0 ? details.join(' ') : '';
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

  /**
   * 배치 Summary HTML 생성 (Newman 스타일)
   */
  generateBatchSummaryHTML(batchData, outputPath) {
    const { 
      jobName, 
      startTime, 
      endTime, 
      duration, 
      yamlFiles, 
      successFiles, 
      failedFiles, 
      successRate, 
      results 
    } = batchData;

    const successRateNum = parseFloat(successRate) || 0;
    const totalFiles = results?.length || yamlFiles || 0;
    const avgResponseTime = results && results.length > 0 
      ? Math.round(results.reduce((sum, r) => sum + (r.result?.duration || 0), 0) / results.length)
      : 0;

    const html = `<!DOCTYPE html>
<html lang="ko" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${jobName} Batch Test Summary - Newman Report</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><defs><linearGradient id=%22g%22 x1=%220%22 y1=%220%22 x2=%221%22 y2=%221%22><stop offset=%220%25%22 stop-color=%22%237c3aed%22/><stop offset=%22100%25%22 stop-color=%22%233b82f6%22/></linearGradient></defs><circle cx=%2250%22 cy=%2250%22 r=%2245%22 fill=%22url(%23g)%22/><path d=%22M30 35h40v8H30zM30 47h30v8H30zM30 59h35v8H30z%22 fill=%22white%22/><circle cx=%2275%22 cy=%2228%22 r=%228%22 fill=%22%2328a745%22/></svg>">
    <link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAADZ0lEQVRYhe2Xa0iTcRjGf+/2uc1t5nRzXsqyQrPSsguRlRGRFxItLSIqKCEhgiAiKChCpQ+RH/rQhy4fCqKgD0UfCrqQkRUVdKEPURZlF8wsb3Nq2+Y293beDwGRCprO9qGBHzz/533+/+d5/u/zPuMlmUySZFkmSdK/7ReMAv8fwP8esCzL8vJsucJstkBGRBP/A6PfvwlKzWG/yDzWmGPjU4gYHe2B6q3YlKqFVJLB3tUbuM/XoGnkPXb/bT5FLH7l9/Ni+OTLqWPLKCH7OOlNJHY3EvddR+PAa4wFhuE1eWE2m2B6D2GJCNx8W4XW3kac0+1gGIaBZGhArJ8j9n17CfKgXrR1v8TWy3fFGi5nZjA4MoV4R0eCb/8+7K6pxNWGN6hcuwUCwwMA0P9dD4V+NW49r4Qj7YSQYUFZh3L9DfF3KZXX4JkNxzSyKLM3Ilt9K8SyNb9Zqm5l+nQ5t3Irlna1ek1H83vkLM/GjbfNaOz8jMrXH1Fc+wYp/hJExHph3/VynL/3AlazBfe7+pA5Y7IVv3OKy+ePKKk7TfcsOY2XZdtI51QwKyWoq0lStZfyFlNp3VkKXp2HiJhwZM2YjqRYOXjBa/HHKIyOQ2RUKhZNnglv75XY3ZSDg3VtuNPZDyPPY/f9Dhxrfg+73Q6r1QqHwwGO42A2m8U1PoaFpY3BwZaHFOz7VJfS6+6xAo0qByEe2wg5pjfpyOJfZCPd7dBOe3L85k+mfY4TLx04xzHm+YEL7RpXk0LTKLXwVhOJSKTN7Qv8/FdXnYZcLJWF4/6nr/jlyPDTyPRRjmJRCOa6YGZGh+F7aBAMwzwwm822p10fqSJjqj2A4MDbZPJZK5w29g21H2+oGjrrR2qhd8Vq6BNiRG6oBBaOg9Oqx9XGTjT0j5ItJ68jM2uKSZcKbz9/XKj6g1GjyaRdHO42E5w9HKJXJyJCGYAIvAKPexox6LXg4x2ot/bL3zbvDtSN4E9kGVnq4fMkm8FNMiYyaBCqLbFyB8+nYNy+dPEgYxcKOYSrv7gFz3WVWMv7u6u/vAb8PXAcB5vNJq4Jh8MBhmHgdDrBMAykUil4nofZbIbJZILD4YDNZgMgbiIYhAISwzBI7HMBYFkW4uNgIjxnLEV+Ayjqv7lKQ4WLAAAAAElFTkSuQmCC">
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
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
            --success-bg: rgba(35, 134, 54, 0.15);
            --success-border: rgba(35, 134, 54, 0.4);
            --error-color: #f85149;
            --error-bg: rgba(248, 81, 73, 0.15);
            --error-border: rgba(248, 81, 73, 0.4);
            --info-color: #58a6ff;
            --warning-color: #d29922;
            --hover-bg: #21262d;
            --card-bg: #161b22;
            --code-bg: #0d1117;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            font-family: 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            line-height: 1.6;
            color: var(--text-primary);
            background: var(--bg-primary);
            font-size: 14px;
            transition: all 0.3s ease;
        }

        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }

        .theme-toggle {
            position: fixed; top: 20px; right: 20px;
            background: var(--gradient-primary); color: white;
            border: none; padding: 10px 20px; border-radius: 25px;
            cursor: pointer; font-weight: 500; z-index: 1000;
            box-shadow: 0 4px 12px var(--shadow-color);
            transition: all 0.3s ease;
        }
        .theme-toggle:hover { transform: translateY(-2px); box-shadow: 0 6px 20px var(--shadow-color); }

        .header {
            text-align: center; padding: 40px 0;
            background: var(--card-bg); border-radius: 12px;
            box-shadow: 0 4px 20px var(--shadow-color);
            margin-bottom: 30px; border: 1px solid var(--border-color);
        }
        .header h1 {
            font-size: 2.5rem; font-weight: 700;
            background: var(--gradient-primary);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            background-clip: text; margin-bottom: 10px;
        }
        .subtitle { font-size: 1.1rem; color: var(--text-secondary); margin-bottom: 20px; }
        .meta { font-size: 0.95rem; color: var(--text-muted); }

        .dashboard {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px; margin-bottom: 40px;
        }
        .metric-card {
            background: var(--card-bg); padding: 25px; border-radius: 12px;
            text-align: center; box-shadow: 0 4px 20px var(--shadow-color);
            border: 1px solid var(--border-color); transition: all 0.3s ease;
            position: relative; overflow: hidden;
        }
        .metric-card:hover { transform: translateY(-5px); box-shadow: 0 8px 30px var(--shadow-color); }
        .metric-card::before {
            content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
            background: var(--gradient-primary);
        }

        .progress-ring { position: relative; width: 120px; height: 120px; margin: 0 auto 15px; }
        .progress-ring svg { width: 120px; height: 120px; transform: rotate(-90deg); }
        .progress-ring circle.bg { fill: none; stroke: var(--border-color); stroke-width: 8; }
        .progress-ring circle.progress {
            fill: none; stroke: var(--gradient-primary); stroke-width: 8;
            stroke-linecap: round; stroke-dasharray: 283;
            stroke-dashoffset: ${283 - (283 * successRateNum / 100)};
            transition: stroke-dashoffset 1s ease;
        }
        .progress-text {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
            font-size: 1.8rem; font-weight: 700; color: var(--text-primary);
        }

        .metric-number { font-size: 2.5rem; font-weight: 700; margin-bottom: 8px; color: var(--text-primary); }
        .metric-pass { color: var(--success-color); }
        .metric-fail { color: var(--error-color); }
        .metric-label { font-size: 1rem; color: var(--text-secondary); font-weight: 500; }

        .batch-results {
            background: var(--card-bg); border-radius: 12px;
            box-shadow: 0 4px 20px var(--shadow-color);
            border: 1px solid var(--border-color); overflow: hidden;
        }

        .section-header { padding: 25px 30px; border-bottom: 1px solid var(--border-color); }
        .section-title {
            font-size: 1.4rem; font-weight: 600; color: var(--text-primary); margin-bottom: 5px;
        }
        .section-subtitle { color: var(--text-secondary); font-size: 0.95rem; }

        .batch-table { width: 100%; border-collapse: collapse; }
        .batch-table th, .batch-table td {
            padding: 18px 30px; text-align: left; border-bottom: 1px solid var(--border-color);
        }
        .batch-table th {
            background: var(--bg-secondary); font-weight: 600;
            color: var(--text-primary); font-size: 0.95rem;
        }
        .batch-table tr:hover { background: var(--hover-bg); }

        .file-name { font-weight: 500; color: var(--text-primary); font-family: 'Monaco', 'Consolas', monospace; }

        .status-badge {
            padding: 6px 12px; border-radius: 20px; font-size: 0.85rem;
            font-weight: 600; display: inline-block; min-width: 70px; text-align: center;
        }
        .status-pass {
            background: var(--success-bg); color: var(--success-color); border: 1px solid var(--success-border);
        }
        .status-fail {
            background: var(--error-bg); color: var(--error-color); border: 1px solid var(--error-border);
        }

        .report-link {
            color: var(--info-color); text-decoration: none; font-weight: 500;
            font-family: 'Monaco', 'Consolas', monospace; font-size: 0.9rem;
            padding: 4px 8px; border-radius: 4px; transition: all 0.2s ease;
        }
        .report-link:hover { background: rgba(88, 166, 255, 0.1); text-decoration: underline; }

        @media (max-width: 768px) {
            .container { padding: 15px; }
            .dashboard { grid-template-columns: repeat(2, 1fr); }
            .header h1 { font-size: 2rem; }
            .batch-table th, .batch-table td { padding: 12px 15px; }
        }
    </style>
</head>
<body>
    <button class="theme-toggle" onclick="toggleTheme()">🌙 Dark Mode</button>
    
    <div class="container">
        <div class="header">
            <h1>Batch Test Summary</h1>
            <div class="subtitle">Job: ${jobName}</div>
            <div class="meta">
                Generated on ${new Date(endTime).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} • 
                Duration: ${Math.round(duration / 1000)}s
            </div>
        </div>

        <div class="dashboard">
            <div class="metric-card">
                <div class="progress-ring">
                    <svg>
                        <circle class="bg" cx="60" cy="60" r="45"></circle>
                        <circle class="progress" cx="60" cy="60" r="45"></circle>
                    </svg>
                    <div class="progress-text">${successRateNum.toFixed(1)}%</div>
                </div>
                <div class="metric-label">Success Rate</div>
            </div>
            <div class="metric-card">
                <div class="metric-number">${totalFiles}</div>
                <div class="metric-label">Total Files</div>
            </div>
            <div class="metric-card">
                <div class="metric-number metric-pass">${successFiles || 0}</div>
                <div class="metric-label">Passed</div>
            </div>
            <div class="metric-card">
                <div class="metric-number metric-fail">${failedFiles || 0}</div>
                <div class="metric-label">Failed</div>
            </div>
            <div class="metric-card">
                <div class="metric-number">${avgResponseTime}ms</div>
                <div class="metric-label">Avg Response</div>
            </div>
        </div>

        <div class="batch-results">
            <div class="section-header">
                <div class="section-title">File Results</div>
                <div class="section-subtitle">${totalFiles} file${totalFiles !== 1 ? 's' : ''} executed</div>
            </div>
            
            <table class="batch-table">
                <thead>
                    <tr>
                        <th>File Name</th>
                        <th>Status</th>
                        <th>Duration</th>
                        <th>Individual Report</th>
                    </tr>
                </thead>
                <tbody>
                    ${(results || []).map(result => {
                      const path = require('path');
                      return `
                    <tr>
                        <td><div class="file-name">${result.fileName || 'Unknown'}</div></td>
                        <td><span class="status-badge ${result.success ? 'status-pass' : 'status-fail'}">
                            ${result.success ? '✅ PASS' : '❌ FAIL'}
                        </span></td>
                        <td>${result.result?.duration || 0}ms</td>
                        <td>
                            ${result.reportPath ? 
                              `<a href="${path.basename(result.reportPath)}" class="report-link">${path.basename(result.reportPath)}</a>` : 
                              '<span style="color: var(--text-muted);">N/A</span>'}
                        </td>
                    </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
    </div>

    <script>
        function toggleTheme() {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            
            html.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
            
            const button = document.querySelector('.theme-toggle');
            button.textContent = newTheme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
        }

        document.addEventListener('DOMContentLoaded', function() {
            const savedTheme = localStorage.getItem('theme') || 'dark';
            document.documentElement.setAttribute('data-theme', savedTheme);
            
            const button = document.querySelector('.theme-toggle');
            button.textContent = savedTheme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
        });
    </script>
</body>
</html>`;

    const fs = require('fs');
    fs.writeFileSync(outputPath, html);
    return { success: true, path: outputPath };
  }
}

export default SClientToNewmanConverter;