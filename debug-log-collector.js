/**
 * Debug Log Collector for TDB_SKT Job Issue Analysis
 * 2025-09-02
 * 
 * This script will capture all console output and system events during TDB_SKT job execution
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';

class DebugLogCollector {
    constructor(jobName = 'TDB_SKT') {
        this.jobName = jobName;
        this.logFile = path.join(__dirname, 'logs', `debug_${jobName}_${this.getTimestamp()}.log`);
        this.startTime = Date.now();
        
        // Ensure logs directory exists
        const logsDir = path.dirname(this.logFile);
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        
        this.log(`=== Debug Log Collection Started for ${jobName} ===`);
        this.log(`Log file: ${this.logFile}`);
        this.log(`Start time: ${new Date().toISOString()}`);
        this.log('');
        
        // Intercept console methods
        this.interceptConsole();
    }
    
    getTimestamp() {
        const now = new Date();
        return now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    }
    
    log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(3);
        const logLine = `[${timestamp}] [+${elapsed}s] [${level}] ${message}`;
        
        // Write to file
        fs.appendFileSync(this.logFile, logLine + '\n');
        
        // Also output to console
        console.log(logLine);
    }
    
    interceptConsole() {
        const originalMethods = {
            log: console.log,
            error: console.error,
            warn: console.warn,
            info: console.info,
            debug: console.debug
        };
        
        const self = this;
        
        console.log = (...args) => {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            self.log(`CONSOLE.LOG: ${message}`);
            originalMethods.log.apply(console, args);
        };
        
        console.error = (...args) => {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            self.log(`CONSOLE.ERROR: ${message}`, 'ERROR');
            originalMethods.error.apply(console, args);
        };
        
        console.warn = (...args) => {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            self.log(`CONSOLE.WARN: ${message}`, 'WARN');
            originalMethods.warn.apply(console, args);
        };
        
        console.info = (...args) => {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            self.log(`CONSOLE.INFO: ${message}`, 'INFO');
            originalMethods.info.apply(console, args);
        };
        
        console.debug = (...args) => {
            const message = args.map(arg => 
                typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
            ).join(' ');
            self.log(`CONSOLE.DEBUG: ${message}`, 'DEBUG');
            originalMethods.debug.apply(console, args);
        };
        
        // Store original methods for cleanup
        this.originalMethods = originalMethods;
    }
    
    logSystemInfo() {
        this.log('=== System Information ===');
        this.log(`Node.js version: ${process.version}`);
        this.log(`Platform: ${process.platform}`);
        this.log(`Architecture: ${process.arch}`);
        this.log(`Working directory: ${process.cwd()}`);
        this.log(`Memory usage: ${JSON.stringify(process.memoryUsage())}`);
        this.log('');
    }
    
    logJobConfiguration() {
        this.log('=== Job Configuration ===');
        try {
            const jobFile = path.join(__dirname, 'jobs', `${this.jobName}.json`);
            if (fs.existsSync(jobFile)) {
                const jobConfig = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
                this.log(`Job config: ${JSON.stringify(jobConfig, null, 2)}`);
            } else {
                this.log(`Job file not found: ${jobFile}`, 'WARN');
            }
        } catch (error) {
            this.log(`Error reading job config: ${error.message}`, 'ERROR');
        }
        this.log('');
    }
    
    logAvailableYamlFiles() {
        this.log('=== Available YAML Files ===');
        try {
            const collectionsDir = path.join(__dirname, 'collections');
            const files = fs.readdirSync(collectionsDir)
                .filter(file => file.endsWith('.yaml'))
                .sort();
            
            files.forEach(file => {
                const filePath = path.join(collectionsDir, file);
                const stats = fs.statSync(filePath);
                this.log(`  ${file} (${stats.size} bytes, modified: ${stats.mtime.toISOString()})`);
            });
        } catch (error) {
            this.log(`Error listing YAML files: ${error.message}`, 'ERROR');
        }
        this.log('');
    }
    
    logServerStatus() {
        this.log('=== Server Status Check ===');
        try {
            // Check if server is running by looking for PID file or process
            const pidFiles = ['server.pid', '.pid', 'app.pid'];
            for (const pidFile of pidFiles) {
                const pidPath = path.join(__dirname, pidFile);
                if (fs.existsSync(pidPath)) {
                    const pid = fs.readFileSync(pidPath, 'utf8').trim();
                    this.log(`Found PID file ${pidFile}: ${pid}`);
                }
            }
            
            // Check for running node processes (Windows)
            if (process.platform === 'win32') {
                const tasklist = spawn('tasklist', ['/fi', 'imagename eq node.exe', '/fo', 'csv']);
                
                let output = '';
                tasklist.stdout.on('data', (data) => {
                    output += data.toString();
                });
                
                tasklist.on('close', (code) => {
                    this.log(`Running Node.js processes:\n${output}`);
                });
            }
        } catch (error) {
            this.log(`Error checking server status: ${error.message}`, 'ERROR');
        }
        this.log('');
    }
    
    cleanup() {
        this.log('');
        this.log('=== Debug Log Collection Completed ===');
        this.log(`Total execution time: ${((Date.now() - this.startTime) / 1000).toFixed(3)}s`);
        this.log(`Log file saved: ${this.logFile}`);
        
        // Restore original console methods
        if (this.originalMethods) {
            console.log = this.originalMethods.log;
            console.error = this.originalMethods.error;
            console.warn = this.originalMethods.warn;
            console.info = this.originalMethods.info;
            console.debug = this.originalMethods.debug;
        }
    }
    
    static async runJobWithLogging(jobName = 'TDB_SKT') {
        const collector = new DebugLogCollector(jobName);
        
        // Log initial system state
        collector.logSystemInfo();
        collector.logJobConfiguration();
        collector.logAvailableYamlFiles();
        collector.logServerStatus();
        
        try {
            // Import and run the server or job execution logic
            collector.log('=== Starting Job Execution ===');
            
            // For now, we'll simulate the execution by making HTTP request
            const postData = JSON.stringify({});
            
            const options = {
                hostname: 'localhost',
                port: 3000,
                path: `/api/run/${jobName}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
            
            return new Promise((resolve, reject) => {
                const req = http.request(options, (res) => {
                    collector.log(`HTTP Response status: ${res.statusCode}`);
                    collector.log(`HTTP Response headers: ${JSON.stringify(res.headers)}`);
                    
                    let body = '';
                    res.on('data', (chunk) => {
                        body += chunk;
                        collector.log(`HTTP Response chunk: ${chunk}`);
                    });
                    
                    res.on('end', () => {
                        collector.log(`HTTP Response complete: ${body}`);
                        collector.cleanup();
                        resolve(body);
                    });
                });
                
                req.on('error', (err) => {
                    collector.log(`HTTP Request error: ${err.message}`, 'ERROR');
                    collector.cleanup();
                    reject(err);
                });
                
                req.write(postData);
                req.end();
            });
            
        } catch (error) {
            collector.log(`Job execution error: ${error.message}`, 'ERROR');
            collector.log(`Error stack: ${error.stack}`, 'ERROR');
            collector.cleanup();
            throw error;
        }
    }
}

// Export for use in other modules
export default DebugLogCollector;

// If run directly, execute the job with logging
if (import.meta.url === `file://${process.argv[1]}`) {
    DebugLogCollector.runJobWithLogging('TDB_SKT')
        .then(result => {
            console.log('Job execution completed');
        })
        .catch(error => {
            console.error('Job execution failed:', error);
            process.exit(1);
        });
}