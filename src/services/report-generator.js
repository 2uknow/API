// src/services/report-generator.js
// 바이너리/배치 HTML 리포트 생성
import fs from 'fs';
import path from 'path';
import { reportsDir } from '../utils/config.js';

// Newman 스타일 바이너리 리포트 생성
async function generateNewmanStyleBinaryReport(data) {
  const {
    jobName,
    binaryPath,
    args,
    startTime,
    endTime,
    duration,
    exitCode,
    stdout,
    stderr,
    parsedResult,
    reportOptions,
    outputPath
  } = data;

  try {
    const { SClientToNewmanConverter } = await import('../engine/newman-converter.js');
    const converter = new SClientToNewmanConverter();

    const scenarioResult = convertBinaryToScenarioResult({
      jobName,
      binaryPath,
      args,
      startTime,
      endTime,
      duration,
      exitCode,
      stdout,
      stderr,
      parsedResult,
      reportOptions
    });

    const result = await converter.generateReport(scenarioResult, outputPath, 'htmlextra');

    if (result.success) {
      return result.path;
    } else {
      console.warn(`[NEWMAN BINARY REPORT] Report generation failed: ${result.error}`);
      return null;
    }
  } catch (error) {
    console.error(`[NEWMAN BINARY REPORT] Error generating Newman report: ${error.message}`);
    return null;
  }
}

function convertBinaryToScenarioResult(data) {
  const {
    jobName,
    binaryPath,
    args,
    startTime,
    endTime,
    duration,
    exitCode,
    stdout,
    stderr,
    parsedResult,
    reportOptions
  } = data;

  const success = exitCode === 0 && parsedResult.success;

  const step = {
    name: `Execute ${path.basename(binaryPath)}`,
    command: path.basename(binaryPath),
    arguments: args.join(' '),
    passed: success,
    duration: duration * 1000,
    response: {
      exitCode,
      stdout,
      stderr,
      duration: duration * 1000,
      arguments: args
    },
    tests: []
  };

  if (parsedResult.success !== undefined) {
    step.tests.push({
      name: 'Binary execution success',
      passed: parsedResult.success,
      script: `pm.test("Binary execution success", function () { pm.expect(exitCode).to.equal(0); });`,
      error: parsedResult.success ? null : `Exit code: ${exitCode}`
    });
  }

  if (parsedResult.stats && typeof parsedResult.stats === 'object') {
    Object.entries(parsedResult.stats).forEach(([key, value]) => {
      step.tests.push({
        name: `Check ${key}`,
        passed: true,
        script: `pm.test("Check ${key}", function () { pm.expect("${value}").to.be.ok; });`,
        error: null
      });
    });
  }

  if (parsedResult.failures && parsedResult.failures.length > 0) {
    parsedResult.failures.forEach((failure, index) => {
      step.tests.push({
        name: `Failure ${index + 1}`,
        passed: false,
        script: `pm.test("Failure ${index + 1}", function () { pm.expect(false).to.be.true; });`,
        error: failure
      });
    });
  }

  if (step.tests.length === 0) {
    step.tests.push({
      name: 'Binary execution completed',
      passed: exitCode === 0,
      script: 'pm.test("Binary execution completed", function () { pm.expect(exitCode).to.equal(0); });',
      error: exitCode === 0 ? null : `Process exited with code ${exitCode}`
    });
  }

  return {
    info: {
      name: reportOptions.title || `${jobName} Binary Execution`,
      description: reportOptions.description || `Binary execution report for ${jobName}`
    },
    steps: [step],
    summary: {
      total: 1,
      passed: success ? 1 : 0,
      failed: success ? 0 : 1
    },
    startTime,
    endTime,
    success
  };
}

function generateBinaryHtmlReport(data) {
  const {
    jobName,
    binaryPath,
    args,
    startTime,
    endTime,
    duration,
    exitCode,
    stdout,
    stderr,
    parsedResult,
    reportOptions
  } = data;

  const title = reportOptions.title || `${jobName} Execution Report`;
  const browserTitle = reportOptions.browserTitle || `${jobName} Report`;

  const successClass = exitCode === 0 && parsedResult.success ? 'success' : 'failure';
  const statusText = exitCode === 0 && parsedResult.success ? 'SUCCESS' : 'FAILED';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${browserTitle}</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { background: #2c3e50; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .header h1 { margin: 0; font-size: 24px; }
        .status { display: inline-block; padding: 4px 12px; border-radius: 4px; font-weight: bold; margin-left: 10px; }
        .status.success { background-color: #27ae60; color: white; }
        .status.failure { background-color: #e74c3c; color: white; }
        .content { padding: 20px; }
        .section { margin-bottom: 30px; }
        .section h2 { color: #2c3e50; border-bottom: 2px solid #ecf0f1; padding-bottom: 10px; }
        .info-grid { display: grid; grid-template-columns: 200px 1fr; gap: 10px; margin-bottom: 20px; }
        .info-label { font-weight: bold; color: #7f8c8d; }
        .info-value { color: #2c3e50; }
        .output-section { background-color: #f8f9fa; border-left: 4px solid #3498db; padding: 15px; margin: 15px 0; }
        .output-content { background-color: #ffffff; border: 1px solid #dee2e6; border-radius: 4px; padding: 15px; font-family: 'Courier New', monospace; font-size: 14px; white-space: pre-wrap; max-height: 400px; overflow-y: auto; }
        .stats-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        .stats-table th, .stats-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #dee2e6; }
        .stats-table th { background-color: #f8f9fa; font-weight: bold; }
        .failures { background-color: #fff5f5; border-left: 4px solid #e74c3c; padding: 15px; margin: 15px 0; }
        .timestamp { font-size: 12px; color: #7f8c8d; margin-top: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${title}<span class="status ${successClass}">${statusText}</span></h1>
        </div>
        
        <div class="content">
            <div class="section">
                <h2>실행 정보</h2>
                <div class="info-grid">
                    <div class="info-label">Job Name:</div>
                    <div class="info-value">${jobName}</div>
                    <div class="info-label">Binary Path:</div>
                    <div class="info-value">${binaryPath}</div>
                    <div class="info-label">Arguments:</div>
                    <div class="info-value">${args.join(' ') || '(none)'}</div>
                    <div class="info-label">Start Time:</div>
                    <div class="info-value">${startTime}</div>
                    <div class="info-label">End Time:</div>
                    <div class="info-value">${endTime}</div>
                    <div class="info-label">Duration:</div>
                    <div class="info-value">${duration} seconds</div>
                    <div class="info-label">Exit Code:</div>
                    <div class="info-value">${exitCode}</div>
                </div>
            </div>

            <div class="section">
                <h2>실행 결과</h2>
                <div class="info-grid">
                    <div class="info-label">Success:</div>
                    <div class="info-value">${parsedResult.success ? 'Yes' : 'No'}</div>
                    <div class="info-label">Summary:</div>
                    <div class="info-value">${parsedResult.summary}</div>
                </div>
                
                ${parsedResult.stats ? `
                <h3>통계</h3>
                <table class="stats-table">
                    ${Object.entries(parsedResult.stats).map(([key, value]) =>
                      `<tr><td>${key}</td><td>${value}</td></tr>`
                    ).join('')}
                </table>
                ` : ''}
                
                ${parsedResult.failures && parsedResult.failures.length > 0 ? `
                <div class="failures">
                    <h3>실패 항목</h3>
                    <ul>
                        ${parsedResult.failures.map(failure => `<li>${failure}</li>`).join('')}
                    </ul>
                </div>
                ` : ''}
            </div>

            ${stdout ? `
            <div class="section">
                <h2>표준 출력 (STDOUT)</h2>
                <div class="output-section">
                    <div class="output-content">${stdout}</div>
                </div>
            </div>
            ` : ''}

            ${stderr ? `
            <div class="section">
                <h2>표준 에러 (STDERR)</h2>
                <div class="output-section">
                    <div class="output-content">${stderr}</div>
                </div>
            </div>
            ` : ''}
        </div>
        
        <div class="timestamp">
            Generated at ${new Date().toISOString()}
        </div>
    </div>
</body>
</html>`;
}

// 간단한 배치 요약 리포트 생성 함수
async function generateSimpleBatchReport(jobName, batchData) {
  const { startTime, endTime, duration, yamlFiles, successFiles, failedFiles, successRate, results, stamp } = batchData;

  const reportPath = path.join(reportsDir, `${jobName}_batch_summary_${stamp}.html`);

  const htmlContent = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Batch YAML Test Summary - Newman Report</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><defs><linearGradient id=%22g%22 x1=%220%22 y1=%220%22 x2=%221%22 y2=%221%22><stop offset=%220%25%22 stop-color=%22%237c3aed%22/><stop offset=%22100%25%22 stop-color=%22%233b82f6%22/></linearGradient></defs><circle cx=%2250%22 cy=%2250%22 r=%2245%22 fill=%22url(%23g)%22/><path d=%22M30 35h40v8H30zM30 47h30v8H30zM30 59h35v8H30z%22 fill=%22white%22/><circle cx=%2275%22 cy=%2228%22 r=%228%22 fill=%22%2328a745%22/></svg>">
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-primary: #ffffff; --bg-secondary: #f8f9fa; --bg-tertiary: #e9ecef;
            --bg-elevated: #ffffff; --text-primary: #212529; --text-secondary: #6c757d;
            --text-muted: #adb5bd; --border-color: #dee2e6; --border-hover: #007bff;
            --shadow-color: rgba(0, 0, 0, 0.1);
            --gradient-primary: linear-gradient(135deg, #7c3aed 0%, #3b82f6 100%);
            --success-color: #28a745; --success-bg: rgba(40, 167, 69, 0.1); --success-border: rgba(40, 167, 69, 0.3);
            --error-color: #dc3545; --error-bg: rgba(220, 53, 69, 0.1); --error-border: rgba(220, 53, 69, 0.3);
            --info-color: #007bff; --warning-color: #ffc107; --hover-bg: #f8f9fa;
            --card-bg: #ffffff; --code-bg: #f8f9fa;
        }
        [data-theme="dark"] {
            --bg-primary: #0d1117; --bg-secondary: #161b22; --bg-tertiary: #21262d;
            --bg-elevated: #161b22; --text-primary: #c9d1d9; --text-secondary: #8b949e;
            --text-muted: #6e7681; --border-color: #30363d; --border-hover: #58a6ff;
            --shadow-color: rgba(0, 0, 0, 0.3);
            --success-color: #238636; --success-bg: rgba(35, 134, 54, 0.15); --success-border: rgba(35, 134, 54, 0.4);
            --error-color: #f85149; --error-bg: rgba(248, 81, 73, 0.15); --error-border: rgba(248, 81, 73, 0.4);
            --info-color: #58a6ff; --warning-color: #d29922; --hover-bg: #21262d;
            --card-bg: #161b22; --code-bg: #21262d;
        }
        * { box-sizing: border-box; }
        body { font-family: 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 0; background: var(--bg-primary); color: var(--text-primary); line-height: 1.6; min-height: 100vh; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { background: var(--gradient-primary); color: white; padding: 40px 20px; text-align: center; margin-bottom: 30px; border-radius: 12px; box-shadow: 0 8px 32px var(--shadow-color); }
        .header h1 { margin: 0 0 10px 0; font-size: 2.5rem; font-weight: 700; }
        .header .subtitle { margin: 0; font-size: 1.1rem; opacity: 0.9; font-weight: 300; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .stat-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; text-align: center; box-shadow: 0 4px 16px var(--shadow-color); transition: transform 0.2s ease, box-shadow 0.2s ease; }
        .stat-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px var(--shadow-color); }
        .stat-number { font-size: 2.5rem; font-weight: 700; margin-bottom: 8px; line-height: 1; }
        .stat-label { font-size: 0.9rem; color: var(--text-secondary); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
        .success { color: var(--success-color); }
        .failed { color: var(--error-color); }
        .results-section { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 12px; padding: 24px; box-shadow: 0 4px 16px var(--shadow-color); margin-bottom: 30px; }
        .results-section h2 { margin: 0 0 24px 0; font-size: 1.5rem; font-weight: 600; color: var(--text-primary); }
        .results-table { width: 100%; border-collapse: collapse; margin-top: 0; }
        .results-table th, .results-table td { padding: 16px; text-align: left; border-bottom: 1px solid var(--border-color); }
        .results-table th { background: var(--bg-secondary); font-weight: 600; color: var(--text-primary); font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.5px; }
        .results-table tr:hover { background: var(--hover-bg); }
        .results-table a { color: var(--info-color); text-decoration: none; font-weight: 500; border-bottom: 1px dotted var(--info-color); transition: all 0.2s ease; }
        .results-table a:hover { border-bottom: 1px solid var(--info-color); }
        .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; }
        .status-success { background: var(--success-bg); color: var(--success-color); border: 1px solid var(--success-border); }
        .status-failed { background: var(--error-bg); color: var(--error-color); border: 1px solid var(--error-border); }
        .footer { text-align: center; padding: 30px 20px; color: var(--text-muted); font-size: 0.9rem; border-top: 1px solid var(--border-color); }
        .footer p { margin: 8px 0; }
        .theme-toggle { position: fixed; top: 20px; right: 20px; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 50%; width: 50px; height: 50px; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 16px var(--shadow-color); transition: all 0.2s ease; z-index: 1000; }
        .theme-toggle:hover { transform: scale(1.1); }
        @media (max-width: 768px) {
            .container { padding: 10px; }
            .header { padding: 20px 15px; }
            .header h1 { font-size: 1.8rem; }
            .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 15px; }
            .stat-number { font-size: 2rem; }
            .results-table th, .results-table td { padding: 12px 8px; font-size: 0.9rem; }
        }
    </style>
</head>
<body>
    <div class="theme-toggle" onclick="toggleTheme()" title="Toggle Theme">🌙</div>
    <div class="container">
        <div class="header">
            <h1>Batch YAML Test Summary</h1>
            <div class="subtitle">Job: ${jobName} | Generated: ${endTime}</div>
        </div>
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-number">${yamlFiles}</div><div class="stat-label">Total Files</div></div>
            <div class="stat-card"><div class="stat-number success">${successFiles}</div><div class="stat-label">Success</div></div>
            <div class="stat-card"><div class="stat-number failed">${failedFiles}</div><div class="stat-label">Failed</div></div>
            <div class="stat-card"><div class="stat-number">${successRate}%</div><div class="stat-label">Success Rate</div></div>
        </div>
        <div class="results-section">
            <h2>Test Results</h2>
            <table class="results-table">
                <thead><tr><th>File Name</th><th>Status</th><th>Individual Report</th></tr></thead>
                <tbody>
                    ${results.map(result => `
                    <tr>
                        <td><strong>${result.fileName}</strong></td>
                        <td><span class="status-badge ${result.success ? 'status-success' : 'status-failed'}">${result.success ? '✅ SUCCESS' : '❌ FAILED'}</span></td>
                        <td>${result.reportPath ?
                          `<a href="${path.basename(result.reportPath)}">${path.basename(result.reportPath)}</a>` :
                          '<span style="color: var(--text-muted);">No report generated</span>'}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>
        <div class="footer">
            <p><strong>Execution Time:</strong> ${(duration / 1000).toFixed(2)}s | <strong>Start:</strong> ${startTime} | <strong>End:</strong> ${endTime}</p>
            <p>Generated by <strong>2uknow API Monitor System</strong></p>
        </div>
    </div>
    <script>
        function toggleTheme() {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme') || 'dark';
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', newTheme);
            const toggle = document.querySelector('.theme-toggle');
            toggle.textContent = newTheme === 'dark' ? '🌙' : '☀️';
            localStorage.setItem('theme', newTheme);
        }
        document.addEventListener('DOMContentLoaded', () => {
            const savedTheme = localStorage.getItem('theme') || 'dark';
            document.documentElement.setAttribute('data-theme', savedTheme);
            const toggle = document.querySelector('.theme-toggle');
            toggle.textContent = savedTheme === 'dark' ? '🌙' : '☀️';
        });
    </script>
</body>
</html>`;

  fs.writeFileSync(reportPath, htmlContent, 'utf8');
  console.log(`[BATCH_SUMMARY] Simple batch report saved: ${reportPath}`);

  return reportPath;
}

export { generateNewmanStyleBinaryReport, convertBinaryToScenarioResult, generateBinaryHtmlReport, generateSimpleBatchReport };
