/**
 * Bevvi Nightly Watchdog
 */
const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

const SLACK_WEBHOOK = process.env.BEVVI_SLACK_WEBHOOK || '';
const LOG_FILE = '/home/ubuntu/logs/watchdog.log';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function slackAlert(msg, isError) {
  if (!SLACK_WEBHOOK) { log('No Slack webhook configured'); return; }
  try {
    const url = new URL(SLACK_WEBHOOK);
    const body = JSON.stringify({ text: (isError ? ':rotating_light: ' : ':white_check_mark: ') + msg });
    await new Promise((resolve, reject) => {
      const req = require('https').request({ hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch(e) { log('Slack alert failed: ' + e.message); }
}

function checkLogSuccess(logFile) {
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n');
    // Find the last Success line with success > 0
    const successLines = lines.filter(l => l.includes('Success:'));
    if (successLines.length === 0) return { ok: false, reason: 'No Success line found' };
    // Check if any recent run was successful
    const lastSuccess = [...successLines].reverse().find(l => {
      const m = l.match(/Success: (\d+)/);
      return m && parseInt(m[1]) > 0;
    });
    if (!lastSuccess) return { ok: false, reason: 'No successful run found' };
    const successMatch = lastSuccess.match(/Success: (\d+)/);
    const failedMatch = lastSuccess.match(/Failed: (\d+)/);
    const success = successMatch ? parseInt(successMatch[1]) : 0;
    const failed = failedMatch ? parseInt(failedMatch[1]) : 0;
    return { ok: true, success, failed };
  } catch(e) { return { ok: false, reason: 'Log error: ' + e.message }; }
}

function serviceActive(svc) {
  try { return execSync('sudo systemctl is-active ' + svc + ' 2>/dev/null').toString().trim() === 'active'; }
  catch(e) { return false; }
}

function restartSvc(svc) {
  try { execSync('sudo systemctl restart ' + svc); return true; }
  catch(e) { return false; }
}

function runSeed(script, logFile) {
  try {
    log('Retrying ' + script);
    execSync('sudo systemctl stop gbrain-mcp; sleep 5; node ' + script + ' >> ' + logFile + ' 2>&1; sudo systemctl start gbrain-mcp', { timeout: 900000 });
    return true;
  } catch(e) { log('Retry failed: ' + e.message); return false; }
}

async function main() {
  log('=== Watchdog Starting ===');
  const issues = [];

  // Check retailer seed
  const rc = checkLogSuccess('/home/ubuntu/logs/gbrain-retailers.log');
  if (!rc.ok) {
    log('Retailer seed issue: ' + rc.reason);
    if (!runSeed('/home/ubuntu/seed_retailers.js', '/home/ubuntu/logs/gbrain-retailers.log'))
      issues.push('Retailer seed failed after retry');
    else log('Retailer seed retry OK');
  } else log('Retailer seed OK: ' + rc.success + ' written');

  // Check customer seed
  const cc = checkLogSuccess('/home/ubuntu/logs/gbrain-customers.log');
  if (!cc.ok) {
    log('Customer seed issue: ' + cc.reason);
    if (!runSeed('/home/ubuntu/seed_customers.js', '/home/ubuntu/logs/gbrain-customers.log'))
      issues.push('Customer seed failed after retry');
    else log('Customer seed retry OK');
  } else log('Customer seed OK: ' + cc.success + ' written');

  // Check services
  const services = ['rachel', 'shopping-agent', 'rachel-mcp', 'rachel-slack', 'gbrain-mcp'];
  for (const svc of services) {
    if (!serviceActive(svc)) {
      log(svc + ' is DOWN — restarting');
      if (!restartSvc(svc)) issues.push(svc + ' failed to restart');
      else log(svc + ' restarted OK');
    } else log(svc + ': OK');
  }

  // Wait for GBrain to fully start
  await new Promise(r => setTimeout(r, 5000));

  // Check GBrain HTTP health
  try {
    const data = await httpGet('http://127.0.0.1:7700/health');
    if (data.status !== 'ok') { issues.push('GBrain unhealthy'); restartSvc('gbrain-mcp'); }
    else log('GBrain health: OK v' + data.version);
  } catch(e) { issues.push('GBrain unreachable'); restartSvc('gbrain-mcp'); }

  // Slack alert
  if (issues.length > 0) {
    const msg = 'Nightly sync issues (' + new Date().toDateString() + '):\n' + issues.map(i => '• ' + i).join('\n');
    log('ISSUES FOUND: ' + issues.join(', '));
    await slackAlert(msg, true);
  } else {
    await slackAlert('Nightly sync completed successfully (' + new Date().toDateString() + ') — all services healthy', false);
    log('All checks passed');
  }
  log('=== Watchdog Complete ===');
}

main().catch(e => { log('Watchdog error: ' + e.message); process.exit(1); });
