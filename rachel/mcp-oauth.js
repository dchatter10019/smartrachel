// OAuth 2.1 for the Rachel MCP connector, so claude.ai's "Add custom connector" can sign in (DC, Oct 3). claude.ai web
// connectors cannot send an API-key header; they discover the authorization server, register themselves, and run an
// authorization-code flow with PKCE. The sign-in itself is the same email-code check as the API keys (mcp-auth.js):
// the person types their email, gets a 6-digit code, and the token is bound to that verified email.
//
//   Discovery: /.well-known/oauth-protected-resource[/rachel/mcp] (RFC 9728), /.well-known/oauth-authorization-server[/rachel] (RFC 8414)
//   POST /register (RFC 7591 dynamic client registration, public clients), GET+POST /authorize (sign-in page), POST /token
// Paths here are as rachel-mcp sees them: nginx strips the /rachel prefix and proxies the well-known paths.
// Tokens are stored hashed (config/mcp-oauth.json). Access tokens: 30 days; refresh tokens: 90 days, rotated on use.
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');
const { requestKey, verifyCode } = require('./mcp-auth.js');

const BASE = process.env.RACHEL_MCP_PUBLIC_BASE || 'https://mcp.getbevvi.com';
const ISSUER = BASE + '/rachel';
const RESOURCE = BASE + '/rachel/mcp';
const STORE = '/home/ubuntu/config/mcp-oauth.json';
const ACCESS_TTL = 30 * 864e5, REFRESH_TTL = 90 * 864e5, CODE_TTL = 5 * 60e3, REQ_TTL = 15 * 60e3;

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const rnd = (p, n = 24) => p + crypto.randomBytes(n).toString('hex');
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function load() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { return { clients: {}, access: {}, refresh: {} }; } }
function save(d) { const t = STORE + '.tmp'; fs.writeFileSync(t, JSON.stringify(d, null, 1), { mode: 0o600 }); fs.renameSync(t, STORE); }
function prune(d) { const now = Date.now(); for (const k of ['access', 'refresh']) for (const [h, v] of Object.entries(d[k] || {})) if (v.exp < now) delete d[k][h]; }

const authReqs = new Map();   // sign-in in progress: id -> { client_id, redirect_uri, state, challenge, scope, exp, email }
const codes = new Map();      // authorization codes: sha(code) -> { email, client_id, redirect_uri, challenge, exp }

const asMetadata = () => ({
  issuer: ISSUER,
  authorization_endpoint: ISSUER + '/authorize',
  token_endpoint: ISSUER + '/token',
  registration_endpoint: ISSUER + '/register',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: ['rachel'],
});
const prMetadata = () => ({ resource: RESOURCE, authorization_servers: [ISSUER], bearer_methods_supported: ['header'], scopes_supported: ['rachel'], resource_name: 'Rachel — Bevvi beverage specialist' });
const wwwAuthenticate = () => 'Bearer resource_metadata="' + BASE + '/.well-known/oauth-protected-resource/rachel/mcp"';

// The email bound to a valid OAuth access token, or null.
function emailForToken(token) {
  if (!token || !/^rat_/.test(token)) return null;
  const d = load(), v = (d.access || {})[sha(token)];
  return v && v.exp > Date.now() ? v.email : null;
}

const okRedirect = u => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(x.hostname)); } catch (e) { return false; } };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{--bg:#f7f5f2;--card:#fff;--ink:#1d1b19;--muted:#6b645c;--accent:#7a2e3a;--line:#e4dfd8}
@media (prefers-color-scheme:dark){:root{--bg:#171513;--card:#211e1b;--ink:#f1ece6;--muted:#a59d94;--accent:#d98b97;--line:#38332e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;max-width:420px;width:100%}
h1{font-size:20px;margin:0 0 6px}p{color:var(--muted);margin:0 0 18px}label{display:block;font-size:14px;margin-bottom:6px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;font-size:16px;background:var(--bg);color:var(--ink)}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:9px;background:var(--accent);color:#fff;font-size:16px;cursor:pointer}
.err{color:#c0392b;font-size:14px;margin:10px 0 0}.small{font-size:13px;margin-top:16px}</style></head>
<body><main class="card">${inner}</main></body></html>`;
}
const emailForm = (id, err) => page('Sign in to Rachel', `<h1>Connect Rachel</h1><p>Rachel is Bevvi's beverage specialist. Enter your email and we'll send you a 6-digit code.</p>
<form method="post" action="${ISSUER}/authorize/email"><input type="hidden" name="req" value="${esc(id)}"><label for="e">Email</label>
<input id="e" name="email" type="email" autocomplete="email" required autofocus><button>Send code</button>${err ? `<p class="err">${esc(err)}</p>` : ''}</form>`);
const codeForm = (id, email, err) => page('Enter your code', `<h1>Check your email</h1><p>We sent a 6-digit code to <b>${esc(email)}</b>. It expires in 15 minutes.</p>
<form method="post" action="${ISSUER}/authorize/code"><input type="hidden" name="req" value="${esc(id)}"><label for="c">Code</label>
<input id="c" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus><button>Connect</button>${err ? `<p class="err">${esc(err)}</p>` : ''}</form>
<p class="small"><a href="${ISSUER}/authorize/restart?req=${esc(id)}">Use a different email</a></p>`);

function readBody(req) {
  return new Promise(resolve => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => resolve(b)); });
}
function parseBody(req, raw) {
  if (/application\/json/.test(req.headers['content-type'] || '')) { try { return JSON.parse(raw || '{}'); } catch (e) { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw || ''));
}
function json(res, code, obj, extra) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, extra || {})); res.end(JSON.stringify(obj)); }
function html(res, code, body) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' }); res.end(body); }
const oerr = (res, code, error, desc) => { console.log('[mcp-oauth] ' + error + ': ' + desc); json(res, code, { error, error_description: desc }); };

// -> true when the request was an OAuth route (and was answered)
async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (req.method === 'OPTIONS' && (/^\/\.well-known\//.test(p) || ['/register', '/token'].includes(p))) {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version' }); res.end(); return true;
  }
  if (req.method === 'GET' && /^\/\.well-known\/oauth-protected-resource(\/rachel\/mcp)?$/.test(p)) { json(res, 200, prMetadata()); return true; }
  if (req.method === 'GET' && /^\/\.well-known\/(oauth-authorization-server|openid-configuration)(\/rachel)?$/.test(p)) { json(res, 200, asMetadata()); return true; }

  if (req.method === 'POST' && p === '/register') {
    const b = parseBody(req, await readBody(req));
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length || !uris.every(okRedirect)) return oerr(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https (or http://localhost)'), true;
    const d = load(); const id = rnd('rc_', 12);
    d.clients[id] = { redirect_uris: uris, client_name: String(b.client_name || '').slice(0, 100), created: new Date().toISOString() };
    save(d);
    console.log('[mcp-oauth] client registered ' + id + ' "' + d.clients[id].client_name + '" ' + JSON.stringify(uris));
    json(res, 201, { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: uris, client_name: d.clients[id].client_name,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    return true;
  }

  if (req.method === 'GET' && p === '/authorize') {
    const q = Object.fromEntries(u.searchParams);
    const c = load().clients[q.client_id];
    if (!c) { html(res, 400, page('Sign-in error', '<h1>Unknown app</h1><p>This app is not registered with Rachel. Remove the connector and add it again.</p>')); return true; }
    if (!q.redirect_uri || !c.redirect_uris.includes(q.redirect_uri)) { html(res, 400, page('Sign-in error', '<h1>Wrong return address</h1><p>The app asked to return somewhere it did not register.</p>')); return true; }
    const back = (e, d) => { const r = new URL(q.redirect_uri); r.searchParams.set('error', e); r.searchParams.set('error_description', d); if (q.state) r.searchParams.set('state', q.state); res.writeHead(302, { Location: r.toString() }); res.end(); return true; };
    if (q.response_type !== 'code') return back('unsupported_response_type', 'only code');
    if (!q.code_challenge || (q.code_challenge_method || 'plain') !== 'S256') return back('invalid_request', 'PKCE with S256 is required');
    const id = rnd('ar_', 12);
    authReqs.set(id, { client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state || '', challenge: q.code_challenge, scope: q.scope || 'rachel', exp: Date.now() + REQ_TTL });
    html(res, 200, emailForm(id)); return true;
  }
  if (req.method === 'GET' && p === '/authorize/restart') {
    const ar = authReqs.get(u.searchParams.get('req'));
    html(res, ar ? 200 : 400, ar ? emailForm(u.searchParams.get('req')) : page('Expired', '<h1>This sign-in expired</h1><p>Go back to the app and connect again.</p>')); return true;
  }
  if (req.method === 'POST' && (p === '/authorize/email' || p === '/authorize/code')) {
    const b = parseBody(req, await readBody(req));
    const ar = authReqs.get(b.req);
    if (!ar || ar.exp < Date.now()) { authReqs.delete(b.req); html(res, 400, page('Expired', '<h1>This sign-in expired</h1><p>Go back to the app and connect again.</p>')); return true; }
    if (p === '/authorize/email') {
      const email = String(b.email || '').trim().toLowerCase();
      const r = await requestKey(email);
      if (!r.success) { html(res, 200, emailForm(b.req, r.error)); return true; }
      ar.email = email; console.log('[mcp-oauth] sign-in code requested for ' + email);
      html(res, 200, codeForm(b.req, email)); return true;
    }
    if (!ar.email) { html(res, 200, emailForm(b.req, 'Enter your email first.')); return true; }
    const v = verifyCode(ar.email, String(b.code || '').trim());
    if (!v.success) { html(res, 200, /request a new one|first/.test(v.error) ? emailForm(b.req, v.error) : codeForm(b.req, ar.email, v.error)); return true; }
    authReqs.delete(b.req);
    const code = rnd('ac_', 16);
    codes.set(sha(code), { email: ar.email, client_id: ar.client_id, redirect_uri: ar.redirect_uri, challenge: ar.challenge, exp: Date.now() + CODE_TTL });
    console.log('[mcp-oauth] signed in ' + ar.email + ' — authorization code issued to ' + ar.client_id);
    const r = new URL(ar.redirect_uri); r.searchParams.set('code', code); if (ar.state) r.searchParams.set('state', ar.state);
    res.writeHead(302, { Location: r.toString(), 'Cache-Control': 'no-store' }); res.end(); return true;
  }

  if (req.method === 'POST' && p === '/token') {
    const b = parseBody(req, await readBody(req));
    const d = load(); prune(d);
    const issue = (email, client_id) => {
      const at = rnd('rat_'), rt = rnd('rrt_');
      d.access[sha(at)] = { email, client_id, exp: Date.now() + ACCESS_TTL };
      d.refresh[sha(rt)] = { email, client_id, exp: Date.now() + REFRESH_TTL };
      save(d);
      return { access_token: at, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL / 1000), refresh_token: rt, scope: 'rachel' };
    };
    if (b.grant_type === 'authorization_code') {
      const c = codes.get(sha(b.code || ''));
      codes.delete(sha(b.code || ''));   // one use, even when wrong below
      if (!c || c.exp < Date.now()) return oerr(res, 400, 'invalid_grant', 'unknown or expired code'), true;
      if (c.client_id !== b.client_id || c.redirect_uri !== b.redirect_uri) return oerr(res, 400, 'invalid_grant', 'client or redirect_uri mismatch'), true;
      if (!b.code_verifier || b64url(crypto.createHash('sha256').update(b.code_verifier).digest()) !== c.challenge) return oerr(res, 400, 'invalid_grant', 'PKCE verification failed'), true;
      console.log('[mcp-oauth] token issued to ' + c.email + ' (' + c.client_id + ')');
      json(res, 200, issue(c.email, c.client_id)); return true;
    }
    if (b.grant_type === 'refresh_token') {
      const h = sha(b.refresh_token || ''), r = d.refresh[h];
      if (!r || r.exp < Date.now() || (b.client_id && b.client_id !== r.client_id)) return oerr(res, 400, 'invalid_grant', 'unknown or expired refresh token'), true;
      delete d.refresh[h];   // rotated
      console.log('[mcp-oauth] token refreshed for ' + r.email);
      json(res, 200, issue(r.email, r.client_id)); return true;
    }
    return oerr(res, 400, 'unsupported_grant_type', 'authorization_code or refresh_token'), true;
  }
  return false;
}

module.exports = { handle, emailForToken, wwwAuthenticate, ISSUER, RESOURCE };
