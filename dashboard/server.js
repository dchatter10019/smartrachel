const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PORT = 9000;
const LOG_DIR = '/home/ubuntu/logs';

const SERVICES = [
  { name: 'Rachel AI',       port: 3500, log: 'rachel.log',                service: 'rachel' },
  { name: 'Rachel MCP',      port: 3600, log: 'rachel-mcp.log',            service: 'rachel-mcp' },
  { name: 'Rachel Slack',    port: null, log: 'slack-rachel.log',          service: 'rachel-slack' },
  { name: 'Rachel Email',    port: null, log: 'email-agent.log',           service: 'rachel-email' },
  { name: 'Shopping Agent',  port: 8300, log: 'shopping-agent.log',        service: 'shopping-agent' },
  { name: 'Orchestrator',    port: 8200, log: 'orchestrator.log',          service: 'orchestrator' },
  { name: 'GBrain MCP',      port: 7700, log: 'gbrain-mcp.log',           service: 'gbrain-mcp' },
  { name: 'Manor NYC',       port: 8101, log: 'store-agent-manor.log',     service: 'store-agent-manor' },
  { name: 'LiquorMaster NJ', port: 8102, log: 'store-agent-liqmaster.log',service: 'store-agent-liqmaster' },
];

function checkHealth(port) {
  return new Promise(resolve => {
    if (!port) { resolve(null); return; }
    const req = http.request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET' }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function checkSystemd(service) {
  try { return execSync(`systemctl is-active ${service} 2>/dev/null`).toString().trim() === 'active'; }
  catch(e) { return false; }
}

function getLogTail(logFile, lines = 100) {
  try { return execSync(`tail -n ${lines} "${path.join(LOG_DIR, logFile)}" 2>/dev/null`).toString(); }
  catch(e) { return ''; }
}

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/api/health') {
    const results = await Promise.all(SERVICES.map(async svc => {
      const up = svc.port ? await checkHealth(svc.port) : checkSystemd(svc.service);
      return { ...svc, up };
    }));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(results));
    return;
  }

  if (url.pathname === '/api/logs') {
    const svc = SERVICES.find(s => s.service === url.searchParams.get('svc'));
    if (!svc) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/plain');
    res.end(getLogTail(svc.log));
    return;
  }

  if (url.pathname === '/api/stream') {
    const svc = SERVICES.find(s => s.service === url.searchParams.get('svc'));
    if (!svc) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(':ok\n\n');
    if (!svc.log) { return; }
    const tail = spawn('tail', ['-f', '-n', '0', path.join(LOG_DIR, svc.log)]);
    tail.stdout.on('data', d => res.write('data: ' + JSON.stringify(d.toString()) + '\n\n'));
    tail.on('error', e => console.error('[stream] tail error:', e.message));
    const keepalive = setInterval(() => res.write(':ping\n\n'), 15000);
    req.on('close', () => { tail.kill(); clearInterval(keepalive); });
    return;
  }

  if (url.pathname === '/api/file') {
    const type = url.searchParams.get('type');
    const svc = url.searchParams.get('svc');
    const FILES = {
      'rachel':              { code: '/home/ubuntu/rachel/rachel.js',              prompt: '/home/ubuntu/rachel/prompt.md',  config: '/etc/systemd/system/rachel.service' },
      'rachel-mcp':          { code: '/home/ubuntu/rachel/rachel-mcp.js',          prompt: '/home/ubuntu/rachel/prompt.md',  config: '/etc/systemd/system/rachel-mcp.service' },
      'rachel-slack':        { code: '/home/ubuntu/rachel/rachel_slack_bot.py',    prompt: '/home/ubuntu/rachel/prompt.md',  config: '/etc/systemd/system/rachel-slack.service' },
      'rachel-email':        { code: '/home/ubuntu/rachel/email-agent.py',         prompt: '/home/ubuntu/rachel/prompt.md',  config: '/etc/systemd/system/rachel-email.service' },
      'shopping-agent':      { code: '/home/ubuntu/store-agent/shopping-agent.js', prompt: null,                             config: '/etc/systemd/system/shopping-agent.service' },
      'orchestrator':        { code: '/home/ubuntu/store-agent/orchestrator.js',   prompt: null,                             config: '/etc/systemd/system/orchestrator.service' },
      'gbrain-mcp':          { code: '/home/ubuntu/rachel/gbrain.js',              prompt: null,                             config: '/etc/systemd/system/gbrain-mcp.service' },
      'store-agent-manor':   { code: '/home/ubuntu/store-agent/agent.js',          prompt: null,                             config: '/etc/systemd/system/store-agent-manor.service' },
      'store-agent-liqmaster':{ code: '/home/ubuntu/store-agent/agent.js',          prompt: null,                             config: '/etc/systemd/system/store-agent-liqmaster.service' },
    };
    const svcFiles = FILES[svc];
    if (!svcFiles || !svcFiles[type]) { res.writeHead(404); res.end('not available'); return; }
    try {
      const content = fs.readFileSync(svcFiles[type], 'utf8');
      res.setHeader('Content-Type', 'text/plain');
      res.end(content);
    } catch(e) { res.writeHead(404); res.end('file not found: ' + svcFiles[type]); }
    return;
  }

  if (url.pathname === '/react.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.end(fs.readFileSync(path.join(__dirname, 'react.js')));
    return;
  }
  if (url.pathname === '/react-dom.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.end(fs.readFileSync(path.join(__dirname, 'react-dom.js')));
    return;
  }
  if (url.pathname === '/reactflow.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.end(fs.readFileSync(path.join(__dirname, 'reactflow.js')));
    return;
  }
  if (url.pathname === '/reactflow.css') {
    res.setHeader('Content-Type', 'text/css');
    res.end(fs.readFileSync(path.join(__dirname, 'reactflow.css')));
    return;
  }
  if (url.pathname === '/flow') {
    res.setHeader('Content-Type', 'text/html');
    res.end(fs.readFileSync(path.join(__dirname, 'flow.html'), 'utf8'));
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
});

server.listen(PORT, '0.0.0.0', () => console.log('[dashboard] port ' + PORT));
