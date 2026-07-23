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
  { name: 'Dallas Fine Wine', port: 8103, log: 'store-agent-dallas-fine-wine.log', service: 'store-agent-dallas-fine-wine' },
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

  if (url.pathname === '/api/activity/stream') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(':ok\n\n');

    // Tail multiple logs and emit structured activity events
    const logs = [
      { file: 'rachel.log',         svc: 'rachel' },
      { file: 'slack-rachel.log',   svc: 'rachel-slack' },
      { file: 'email-agent.log',    svc: 'rachel-email' },
      { file: 'shopping-agent.log', svc: 'shopping-agent' },
    ];

    const tails = logs.map(l => {
      const tail = spawn('tail', ['-f', '-n', '0', path.join(LOG_DIR, l.file)]);
      tail.stdout.on('data', d => {
        const lines = d.toString().split('\n').filter(Boolean);
        lines.forEach(line => {
          let event = null;
          // Rachel receiving a message
          if (l.svc === 'rachel-slack' && line.includes('channel from') || line.includes('mention from')) {
            event = { type: 'message', from: 'rachel-slack', to: 'rachel' };
          } else if (l.svc === 'rachel-email' && line.includes('Processing:')) {
            event = { type: 'message', from: 'rachel-email', to: 'rachel' };
          } else if (l.svc === 'rachel' && line.includes('[tool] ShoppingAgent')) {
            const intent = line.match(/"intent":"([^"]+)"/);
            event = { type: 'tool', from: 'rachel', to: 'shopping-agent', intent: intent ? intent[1] : '' };
          } else if (l.svc === 'shopping-agent' && line.includes('place_order via orchestrator')) {
            event = { type: 'order', from: 'shopping-agent', to: 'orchestrator' };
          } else if (l.svc === 'rachel' && line.includes('[tool] GetD2CSession')) {
            event = { type: 'tool', from: 'rachel', to: 'gbrain-mcp' };
          } else if (l.svc === 'rachel' && line.includes('chat —') && line.includes('session:')) {
            const match = line.match(/session: (\S+)/);
            const channel = match && match[1].startsWith('slack') ? 'rachel-slack' : match && match[1].startsWith('email') ? 'rachel-email' : null;
            if (channel) event = { type: 'session', channel, active: true };
          }
          if (event) res.write('data: ' + JSON.stringify(event) + '\n\n');
        });
      });
      return tail;
    });

    const ka = setInterval(() => res.write(':ping\n\n'), 15000);
    req.on('close', () => { tails.forEach(t => t.kill()); clearInterval(ka); });
    return;
  }

  if (url.pathname === '/api/orders') {
    // Return last N orders from orders.jsonl
    try {
      const lines = execSync('tail -n 20 /home/ubuntu/logs/orders.jsonl 2>/dev/null').toString().trim().split('\n').filter(Boolean);
      const orders = lines.map(l => { try { return JSON.parse(l); } catch(e) { return null; } }).filter(Boolean).reverse();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(orders));
    } catch(e) { res.end('[]'); }
    return;
  }

  if (url.pathname === '/api/orders/stream') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(':ok\n\n');
    const tail = spawn('tail', ['-f', '-n', '0', '/home/ubuntu/logs/orders.jsonl']);
    tail.stdout.on('data', d => {
      const lines = d.toString().trim().split('\n').filter(Boolean);
      lines.forEach(line => {
        try { res.write('data: ' + line + '\n\n'); } catch(e) {}
      });
    });
    const ka = setInterval(() => res.write(':ping\n\n'), 15000);
    req.on('close', () => { tail.kill(); clearInterval(ka); });
    return;
  }

  if (url.pathname === '/api/save-file' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { svc, type, content } = JSON.parse(body);
        const FILES = {
          'rachel':       { prompt: '/home/ubuntu/rachel/prompt.md' },
          'rachel-mcp':   { prompt: '/home/ubuntu/rachel/prompt.md' },
          'rachel-slack': { prompt: '/home/ubuntu/rachel/prompt.md' },
          'rachel-email': { prompt: '/home/ubuntu/rachel/prompt.md' },
        };
        const svcFiles = FILES[svc];
        if (!svcFiles || !svcFiles[type]) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'not editable' }));
          return;
        }
        fs.writeFileSync(svcFiles[type], content, 'utf8');
        // Restart rachel after prompt save
        execSync('sudo systemctl restart rachel 2>&1');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(500);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/restart' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { service } = JSON.parse(body);
        if (!service || !service.match(/^[a-z0-9-]+$/)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid service name' }));
          return;
        }
        execSync('sudo systemctl restart ' + service + ' 2>&1');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
      } catch(e) {
        res.writeHead(500);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/deploy-store' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const cfg = JSON.parse(body);
        const slug = cfg.store_name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const envPath = '/home/ubuntu/store-agent/' + slug + '.env';
        const svcName = 'store-agent-' + slug;
        const logFile = '/home/ubuntu/logs/' + svcName + '.log';

        const clients = cfg.clients && cfg.clients.length > 0 ? cfg.clients : [cfg.client_name || 'fooda'];
        const envContent = [
          'STORE_NAME=' + cfg.store_name,
          'KITCHEN_LOCATION=' + cfg.kitchen_location,
          'CLIENT_NAME=' + clients[0],
          'CLIENT_NAMES=' + clients.join(','),
          'PORT=' + cfg.port,
          'DELIVERY_ZIPS=' + cfg.delivery_zips
        ].join('\n');
        fs.writeFileSync(envPath, envContent);

        const svcContent = [
          '[Unit]',
          'Description=Bevvi Store Agent - ' + cfg.store_name,
          'After=network.target',
          '',
          '[Service]',
          'Type=simple',
          'User=ubuntu',
          'WorkingDirectory=/home/ubuntu/store-agent',
          'EnvironmentFile=' + envPath,
          'ExecStart=/usr/bin/node /home/ubuntu/store-agent/agent.js',
          'Restart=always',
          'RestartSec=10',
          'StandardOutput=append:' + logFile,
          'StandardError=append:' + logFile,
          '',
          '[Install]',
          'WantedBy=multi-user.target'
        ].join('\n');
        fs.writeFileSync('/tmp/' + svcName + '.service', svcContent);
        execSync('sudo cp /tmp/' + svcName + '.service /etc/systemd/system/' + svcName + '.service');
        execSync('sudo systemctl daemon-reload');
        execSync('sudo systemctl enable ' + svcName);
        execSync('sudo systemctl start ' + svcName);

        const orchPath = '/home/ubuntu/store-agent/orchestrator.js';
        let orch = fs.readFileSync(orchPath, 'utf8');
        const zips = cfg.delivery_zips.split(',').map(z => "'" + z.trim() + "'").join(',');
        const newEntry = "  {\n    name: '" + cfg.store_name + "',\n    url:  'http://127.0.0.1:" + cfg.port + "',\n    zips: [" + zips + "]\n  },";
        orch = orch.replace('  // Add more stores here as they come online', newEntry + '\n  // Add more stores here as they come online');
        fs.writeFileSync(orchPath, orch);
        execSync('sudo systemctl restart orchestrator');

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, service: svcName, port: cfg.port }));
      } catch(e) {
        res.writeHead(500);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
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
