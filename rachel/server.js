
// Zip coverage via Bevvi's API, not the local store registry. The registry is the
// store-agent layer we no longer route orders through; product search and
// createCorpOrder both key on ?zipcode=. Real bug: 332 Pine St, San Francisco 94104
// was rejected as "no store" because the registry has no SF entry — Bevvi serves it
// (under client 'airculinaire'). Probe each known client; remember the one that works
// per zip so search/order use it too (fooda vs airculinaire differ by zip: the Bronx
// is fooda-only, SF is airculinaire-only).
const zipClientCache = {};
async function checkStoreCoverage(zip) {
  try {
    for (const client of ['bevvibot']) {   // single probe: the backend resolves the store from the zip
      const url = 'https://api-client.getbevvi.com/api/corpproducts/searchCorpProducts?zipcode=' + encodeURIComponent(zip) + '&searchBy=' + encodeURIComponent('wine') + '&client=bevvibot' + '&limit=1';
      const res = await fetch(url);
      const data = await res.json().catch(() => []);
      if (Array.isArray(data) && data.length > 0) {
        zipClientCache[zip] = client;
        console.log('[coverage] zip', zip, 'served by client', client);
        return { zip, store_count: 1, client, stores: [{ name: client }] };
      }
    }
    console.log('[coverage] zip', zip, 'not served by any known client');
    return { zip, store_count: 0, stores: [] };
  } catch (e) {
    console.error('[rachel] checkStoreCoverage error:', e.message);
    return null;
  }
}

const express = require('express');
const { rachelChat } = require('./rachel.js');
const { getCustomerContext, getD2CSession, saveD2CSession, saveBasket, clearBasket } = require('./gbrain.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chrono = require('chrono-node');

// ── Delivery time-slot validation ───────────────────────────────────────
function parseTimeWindow(windowStr) {
  const m = windowStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  const to24 = (h, mm, ap) => {
    h = parseInt(h, 10);
    if (ap.toUpperCase() === 'PM' && h !== 12) h += 12;
    if (ap.toUpperCase() === 'AM' && h === 12) h = 0;
    return h + parseInt(mm, 10) / 60;
  };
  return { start: to24(m[1], m[2], m[3]), end: to24(m[4], m[5], m[6]) };
}

async function checkDeliveryAvailability(establishmentId, dateStr) {
  try {
    const fetchFn = (url, opts) => import('node-fetch').then(({default: f}) => f(url, require('./log-tag.js').withQAHeader(url, opts)));
    const url = 'https://api-client.getbevvi.com/api/bevviutils/getDeliveryDateTimes?accountId=rachel&establishmentId=' + encodeURIComponent(establishmentId) + '&date=' + encodeURIComponent(dateStr);
    const res = await fetchFn(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('[delivery-check] checkDeliveryAvailability error:', e.message);
    return null;
  }
}

// ── Channel capabilities config (live-reloaded) ─────────────────────────────
const CHANNEL_CONFIG_PATH = '/home/ubuntu/rachel/channel-capabilities.json';
let channelConfigCache = null;
let channelConfigMtime = 0;

function getChannelConfig() {
  try {
    const stat = fs.statSync(CHANNEL_CONFIG_PATH);
    if (!channelConfigCache || stat.mtimeMs !== channelConfigMtime) {
      channelConfigCache = JSON.parse(fs.readFileSync(CHANNEL_CONFIG_PATH, 'utf8'));
      channelConfigMtime = stat.mtimeMs;
      console.log('[channel-config] (re)loaded, mtime:', stat.mtimeMs);
    }
  } catch (e) {
    console.error('[channel-config] failed to load, falling back to permissive defaults:', e.message);
    channelConfigCache = null;
  }
  return channelConfigCache;
}

function getCapabilities(format) {
  const config = getChannelConfig();
  const defaults = { can_place_order: true, can_generate_proposal: true, can_add_to_cart: true, can_email_support: true, requires_age_verification: true, mention_saved_address: false };
  if (!config) return defaults;
  return Object.assign({}, defaults, config[format] || {});
}

// ── Email sending — extracted to email-utils.js so rachel-mcp.js can share it ──
const { sendEmail, sendSupportEmail } = require('./email-utils.js');
const { categorySubtotals, applySubtotals } = require('./package-subtotals.js');

const KITCHEN_TO_CLIENT = {
  'Celonis - NYC': 'fooda',
  'Teterboro - NJ': 'airculinaire',
  'San Diego - CA': 'airculinaire',
};

const app = express();
app.use(express.json({ limit: '25mb' }));   // base64 photos of order lists
// QA sessions: tag every log line of the request with the session (rachel/log-tag.js), so the QA
// runner can run scenarios in parallel and still assert on just its own log lines.
const logTag = require('./log-tag.js'); logTag.install();
app.use('/chat', (req, res, next) => logTag.runTagged(req.body && req.body.session_id, next));
const events = require('./events.js');   // per-turn event record (events.jsonl) — see the EVENT LOG wrapper in /chat
app.use('/chat', (req, res, next) => events.run(next));

const PORT = process.env.RACHEL_PORT || 3500;

// ── Session stores ─────────────────────────────────────────────────────────
const sessions = {};       // sessionKey -> messages[]
// Real, definitive root cause found tonight: sessions[sessionKey] (the raw Claude API
// conversation history) does NOT reliably contain the actual formatted reply text shown
// to the customer — confirmed via direct diagnostic logging that most "assistant"
// entries in it are EMPTY STRINGS or filler text, since a turn's only model output can
// be a tool_use block with no accompanying text. The real, substantive reply is
// constructed/returned separately as { text, response } via res.json() and never
// written back into sessions[sessionKey] at all. Track the actual outgoing reply text
// per session here instead — this is what candidate-extraction (for the substitute-
// merge logic) needs to scan, not the internal API conversation history.
const lastRepliesBySession = {}; // sessionKey -> array of recent outgoing reply texts
// Write the ACTUAL outgoing reply into the LLM history. Real bug: the final assistant
// entry in sessions[] is often empty (a turn's only model output can be a tool_use),
// and deterministic replies never touch the history at all — so hours later the LLM
// saw an earlier question with a blank answer and answered it AGAIN before the new one.
// Retire pending substitutes that an added item resolves (real bug: 'Dry Rose 750 mL'
// stayed pending after Whispering Angel was added via the pick list, so a later bare
// 'Yes' reopened the substitute gate on an unrelated question).
function retirePendingFor(state, addedName) {
  try {
    if (!state || !Array.isArray(state.pendingSubstitutes) || !state.pendingSubstitutes.length) return;
    const norm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const addedWords = new Set(norm(addedName).split(/[^a-z]+/).filter(w => w.length > 3));
    const before = state.pendingSubstitutes.length;
    state.pendingSubstitutes = state.pendingSubstitutes.filter(pn => !norm(pn).split(/[^a-z]+/).some(w => w.length > 3 && addedWords.has(w)));
    if (state.pendingSubstitutes.length !== before) console.log('[substitute-tracking] retired pending after add:', addedName, '->', JSON.stringify(state.pendingSubstitutes));
  } catch (e) {}
}
// Resolve a typed address with Google Geocoding: returns { formatted, zip, city, state,
// lat, lng } or null. Real case: a new invited user typed '3300 Admiral Boland Way, San
// Diego CA' (no zip) and the flow stalled on a repeated generic prompt. Google resolves
// it (92101); we hand the existing parser the normalized address so nothing downstream
// changes. Key: GOOGLE_MAPS_API_KEY in /etc/rachel.env (Geocoding API, restricted).
// Read a photo/scan of an order (handwritten list, printed order sheet, past invoice)
// into a shopping list with Claude vision. Returns { is_order, list, note }.
async function transcribeOrderImages(images, caption) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const vc = new Anthropic.Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const content = [];
    for (const im of images.slice(0, 4)) {
      if (/^application\/pdf$/i.test(im.media_type)) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: im.data } });
      else content.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } });
    }
    content.push({ type: 'text', text: 'This was sent to a beverage-ordering assistant' + (caption ? ' with the caption: "' + caption + '"' : '') + `.
If it contains a list of drinks to order (handwritten, printed, an invoice, a receipt, an order form), transcribe it as a shopping list — ONE item per line, in the form "<qty> x <product name> <size if shown>". Use the quantities shown; if a quantity is missing, use 1. Correct obvious misspellings of well-known brands. When a line is a category rather than a brand, write it as a clean search phrase with the distinctive term first and NO parentheses — e.g. "2 x Burgundy red wine 750 mL", "1 x Napa Cabernet 750 mL", "6 x IPA beer". Ignore prices, totals, dates, and non-drink lines.
If it is NOT a list of drinks to order (a menu photo, a bottle photo, a screenshot, something unrelated), do not invent a list.
Reply ONLY with JSON: {"is_order": true|false, "list": "<lines joined with \\n, or empty>", "note": "<one short sentence about what the image is, or what was unclear>"}` });
    const r = await vc.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content }] });
    const txt = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const m = txt.match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null;
    if (!j) return { is_order: false, list: '', note: 'could not read the image' };
    return { is_order: !!j.is_order && !!(j.list || '').trim(), list: String(j.list || '').trim(), note: String(j.note || '').trim() };
  } catch (e) { console.log('[vision] error:', e.message); return { is_order: false, list: '', note: 'error reading the image' }; }
}
async function geocodeAddress(text) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !text) return null;
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('https://maps.googleapis.com/maps/api/geocode/json?region=us&address=' + encodeURIComponent(text) + '&key=' + key, { signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    if (d.status !== 'OK' || !d.results || !d.results[0]) { console.log('[geocode] no match:', d.status, JSON.stringify(text).slice(0, 60)); return null; }
    const g = d.results[0]; const comp = {};
    for (const c of (g.address_components || [])) for (const ty of c.types) comp[ty] = c.short_name;
    if (!comp.postal_code || !comp.street_number) { console.log('[geocode] partial (no zip/street number):', g.formatted_address); return null; }
    // Built from components (address-extract.js formatGeocoded): formatted_address can lead with a building
    // name ("100 Federal Street, 100 Federal St #6, ...") and drops the customer's "Floor 6".
    const formatted = require('./address-extract.js').formatGeocoded(g.address_components, text) || String(g.formatted_address || '').replace(/,\s*USA$/i, '');
    if (comp.premise) console.log('[geocode] building name dropped from the echo: ' + JSON.stringify(comp.premise) + ' (Google: ' + JSON.stringify(g.formatted_address) + ')');
    return { formatted, zip: comp.postal_code, city: comp.locality || comp.sublocality || comp.neighborhood || '', state: comp.administrative_area_level_1 || '', lat: g.geometry.location.lat, lng: g.geometry.location.lng };
  } catch (e) { console.log('[geocode] error:', e.message); return null; }
}
function recordTurn(sessionKey, userText, replyText) {
  try {
    if (!replyText || /^__/.test(String(userText || ''))) return;
    const hist = sessions[sessionKey] = sessions[sessionKey] || [];
    const textOf = m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('') : String(m.content || '');
    const last = hist[hist.length - 1];
    if (last && last.role === 'assistant') {
      const hasTool = Array.isArray(last.content) && last.content.some(b => b.type === 'tool_use');
      if (!hasTool && textOf(last).trim().length < 40) last.content = [{ type: 'text', text: replyText }];
    } else {
      if (!(last && last.role === 'user' && textOf(last) === userText)) hist.push({ role: 'user', content: String(userText) });
      hist.push({ role: 'assistant', content: [{ type: 'text', text: replyText }] });
    }
    // Trim to ~40 messages, cutting only at a plain user text message so tool_use /
    // tool_result pairs are never split (the API rejects orphaned tool_results).
    if (hist.length > 40) {
      let i = hist.length - 40;
      while (i < hist.length && !(hist[i].role === 'user' && (typeof hist[i].content === 'string' || (Array.isArray(hist[i].content) && hist[i].content.every(b => b.type === 'text'))))) i++;
      if (i > 0 && i < hist.length) hist.splice(0, i);
    }
  } catch (e) {}
}
const packageCache = {};   // cacheKey -> line_items (L1)

// flowState persisted to disk
const FLOW_STATE_PATH = '/home/ubuntu/logs/flow-state.json';
const IDLE_HOURS = Number(process.env.RACHEL_IDLE_HOURS) || 4;   // silence after which the next message starts a fresh conversation
const CONFIRM_ADD_PRICE = Number(process.env.RACHEL_CONFIRM_ADD_PRICE) || 200;   // a single search match at/above this per-bottle price is offered, not added (add-item)
const usd = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let flowState = {};
try {
  flowState = JSON.parse(fs.readFileSync(FLOW_STATE_PATH, 'utf8'));
  console.log('[flowState] loaded', Object.keys(flowState).length, 'sessions');
} catch(e) { flowState = {}; }

function saveFlowState() {
  try { fs.writeFileSync(FLOW_STATE_PATH, JSON.stringify(flowState)); } catch(e) {}
}

// Conversation history persisted to disk. Real bug (DC, Sep 27): sessions[] and the recent-reply
// buffer lived only in memory, so every deploy/restart wiped live conversations mid-flow — the
// next Slack message arrived with "messages: 0", Rachel no longer knew which wines "those" were,
// and multi-pick / substitute matching lost the list it resolves against. The basket and flow
// state already survived (flow-state.json); now the conversation does too. Written atomically,
// debounced after each reply, flushed on SIGTERM; pruned by the idle rule.
const CHAT_SESSIONS_PATH = '/home/ubuntu/logs/chat-sessions.json';
try {
  const saved = JSON.parse(fs.readFileSync(CHAT_SESSIONS_PATH, 'utf8'));
  Object.assign(sessions, saved.messages || {});
  Object.assign(lastRepliesBySession, saved.replies || {});
  console.log('[sessions] loaded', Object.keys(saved.messages || {}).length, 'conversation(s) from disk');
} catch (e) { if (e.code !== 'ENOENT') console.error('[sessions] load failed:', e.message); }
function pruneChatSessions() {
  const now = Date.now();
  for (const k of new Set([...Object.keys(sessions), ...Object.keys(lastRepliesBySession)])) {
    const last = (flowState[k] && flowState[k].lastActive) || 0;
    const keepMs = /^email-/.test(k) ? 14 * 24 * 3600e3 : /^qa-/.test(k) ? 3600e3 : IDLE_HOURS * 3600e3;
    if (!last || now - last > keepMs) { delete sessions[k]; delete lastRepliesBySession[k]; }
  }
}
function saveChatSessionsNow() {
  try {
    pruneChatSessions();
    const tmp = CHAT_SESSIONS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), messages: sessions, replies: lastRepliesBySession }));
    fs.renameSync(tmp, CHAT_SESSIONS_PATH);
  } catch (e) { console.error('[sessions] save failed:', e.message); }
}
let chatSaveTimer = null;
function scheduleChatSessionsSave() {
  if (chatSaveTimer) return;
  chatSaveTimer = setTimeout(() => { chatSaveTimer = null; saveChatSessionsNow(); }, 500);
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { if (chatSaveTimer) clearTimeout(chatSaveTimer); saveChatSessionsNow(); saveFlowState(); console.log('[sessions] saved on ' + sig); } catch (e) {} process.exit(0); });
}

// ── Prompt ─────────────────────────────────────────────────────────────────
const RACHEL_PROMPT_PATH = path.join(__dirname, 'prompt.md');
let RACHEL_PROMPT = '';
try {
  RACHEL_PROMPT = fs.readFileSync(RACHEL_PROMPT_PATH, 'utf8');
  console.log(`[rachel] Loaded prompt (${RACHEL_PROMPT.length} chars)`);
} catch(e) {
  console.error('[rachel] Failed to load prompt:', e.message);
}
fs.watch(RACHEL_PROMPT_PATH, () => {
  try {
    RACHEL_PROMPT = fs.readFileSync(RACHEL_PROMPT_PATH, 'utf8');
    console.log(`[rachel] Prompt reloaded (${RACHEL_PROMPT.length} chars)`);
  } catch(e) {}
});

// ── Cache helpers ──────────────────────────────────────────────────────────
// A shopping-agent MCP tool, called from code (no LLM): the parsed result object.
async function callShoppingTool(name, args) {
  const rr = await fetch('http://127.0.0.1:8300/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const rt = await rr.text(); const rl = rt.split('\n').find(l => l.startsWith('data:'));
  return rl ? JSON.parse(JSON.parse(rl.replace('data:', '').trim()).result.content[0].text) : null;
}
// Catalog rows for a name in the store serving zip (shopping-agent product_query, first 12 + the product fields).
async function catalogSearch(zip, name, category) {
  const r = await callShoppingTool('product_query', { queries: [{ name, category: category || '', limit: 12 }], zip, email: 'line-resolve@getbevvi.com' });
  return ((r && r.results) || []).flatMap(x => x.products || []);
}
// A placed order (API success) leaves the cart; kept on placedOrder for reopen. Shared by the LLM's place_order
// (onOrderPlaced) and the email order path (placeEmailOrder) so both record it the same way.
function recordPlacedOrder(sessionKey, email, format, result, lineItems, orderData) {
      const st = getState(sessionKey);
      const prev = st.placedOrder;
      if (prev && prev.reopened) console.log('[order] ' + (result.order_id || '?') + ' replaces reopened order ' + prev.order_id + ' — no cancel API; the earlier order stays in Bevvi unpaid');
      st.placedOrder = { order_id: result.order_id || '', payment_url: result.payment_url || '', line_items: typeof lineItems === 'string' ? lineItems : JSON.stringify(lineItems || []), placedAt: Date.now(), dry_run: !!result.dry_run, replaces: prev && prev.reopened ? prev.order_id : null };
      st.lastLineItems = '[]';   // '[]', not '': an empty string triggers the getPackage() rehydrate
      if ((orderData || st.orderData) && (orderData || st.orderData).name) { const odP = orderData || st.orderData; contacts.save(email, { name: odP.name, phone: odP.phone, email: odP.email }); };
      st.pendingSubstitutes = []; st.pendingAddOffer = null; st.pendingQtyFor = null; st.savedTipChoice = null; st.tipAsk = false;   // the next order asks for its own tip
      if (email) { Object.keys(packageCache).forEach(k => { if (k.startsWith(email + ':')) delete packageCache[k]; }); clearBasket(email, format || 'slack'); }
      saveFlowState();
      events.action('placed_order');
      console.log('[order] placed ' + (result.order_id || '?') + (result.dry_run ? ' (QA dry run)' : '') + ' — basket cleared, kept on placedOrder for reopen');
    }
function makeCacheKey(email, zip, fingerprint) {
  return email + ':' + zip + ':' + fingerprint;
}

function fingerprint(message) {
  return crypto.createHash('md5').update(message.toLowerCase().trim()).digest('hex').slice(0, 8);
}

function clearCache(email, channel) {
  // Clear L1
  Object.keys(packageCache).forEach(k => {
    if (k.startsWith(email + ':')) delete packageCache[k];
  });
  // Clear L2 async
  try {
    saveBasket(email, null, '', channel || 'slack').catch(() => {});
  } catch(e) {}
  console.log('[cache] cleared for:', email);
}

// ── Age answer (COMPLIANCE) ────────────────────────────────────────────────
// Real bug: the gate treated a message as "yes" if it CONTAINED any of 'yes','ok','sure',
// 'i am','over 21' — checked before "no". "I am 17", "I'm not sure", "no I'm not over 21" and
// "nope, 19. is that ok?" all passed, while "I'm 25" and "21" were re-asked forever.
// Order matters: a stated age decides; then doubt; then negation; only then an affirmative
// at the START of the message (or an explicit "I'm over 21" anywhere).
function parseAgeAnswer(raw) {
  const m = String(raw || '').toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  const bare = m.replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
  // A stated age: the whole message is a number, or a number with an age cue around it.
  // (Never a bare leading number — "3 bottles of Tito's" is not an age.)
  const ageM = bare.match(/^(\d{1,3})(?: years?(?: old)?| yrs?| yo)?$/) ||
               m.match(/\b(?:i'?m|im|i am|age(?: is)?|aged|turned|just turned)\s+(?:only\s+|just\s+)?(\d{1,3})\b/) ||
               m.match(/\b(\d{1,3})\s*(?:years? old|yrs? old|y\/o|yo)\b/) ||
               m.match(/^(?:no|nope|nah|yes|yeah|yep)[,.!\s]+(\d{1,3})\b/);
  if (ageM) { const n = Number(ageM[1]); if (n >= 21 && n <= 120) return { answer: 'yes', why: 'stated age ' + n }; if (n > 0 && n < 21) return { answer: 'no', why: 'stated age ' + n }; }
  if (/\b(not sure|unsure|don'?t know|dunno|idk|no idea|maybe|not certain)\b/.test(m)) return { answer: 'unclear', why: 'unsure' };
  if (/\b(under|younger than|less than|below)\s*21\b|\bnot\s+(?:yet\s+)?(?:21|over 21|old enough|of age)\b|\bminor\b|\bnot yet\b|\bunderage\b/.test(m)) return { answer: 'no', why: 'negated' };
  if (/^(no|nope|nah|negative|i'?m not|im not|i am not)\b/.test(bare)) return { answer: 'no', why: 'starts with no' };
  if (/^(yes|yeah|yep|yup|yea|ya|y|sure|ok|okay|correct|absolutely|definitely|of course|certainly|confirmed|affirmative|i am|i'?m over|im over|over 21|21 ?\+|i'?m 21|i am 21)\b/.test(bare)) return { answer: 'yes', why: 'affirmative' };
  if (/\b(i'?m|im|i am)\s+(over|above|older than)\s+21\b|\b21\s*\+|\b(i'?m|i am) of (legal )?(drinking )?age\b/.test(m)) return { answer: 'yes', why: 'states over 21' };
  return { answer: 'unclear', why: 'no age answer' };
}
// Strip the age answer off a message that also carries a request ("yes I'm over 21, deliver
// to ..., I need 2 Tito's") so the request can be replayed after the gate.
function stripAgeAnswer(raw) {
  return String(raw || '')
    .replace(/^\s*(yes|yeah|yep|yup|sure|ok|okay|correct|absolutely|actually)\b[,.!\s]*/i, '')
    .replace(/\b(actually\s+)?(i'?m|im|i am)\s+(over|above|older than)\s+21\b/ig, '')
    .replace(/\b(actually\s+)?(i'?m|im|i am)\s+\d{1,3}(\s*(years?|yrs?)(\s+old)?)?\b/ig, '')
    .replace(/\b(over|above)\s+21\b|\b21\s*\+|\b\d{1,3}\s*(years?|yrs?)\s+old\b|\byears?\s+old\b/ig, '')
    .replace(/^\s*(i am|i'?m)\b\.?\s*$/i, '').replace(/^\s*\d{1,3}\s*$/, '')
    .replace(/^[,.!\s]+|[,\s]+$/g, '').replace(/^and\s+/i, '').trim();
}

// ── Flow state helpers ─────────────────────────────────────────────────────
function getState(sessionKey) {
  if (!flowState[sessionKey]) {
    flowState[sessionKey] = { step: 'age', ageVerified: false, addrConfirmed: false, zip: '', address: '', pendingIntent: null, lastFingerprint: '', lastZip: '', mixerAsked: false, mixerAnswered: false, packageShown: false, proposalStep: null };
  }
  return flowState[sessionKey];
}

function resetState(sessionKey, email) {
  // COMPLIANCE: a stated under-21 refusal survives "reset" (and idle expiry) for 24h — a minor
  // could otherwise type reset and answer "yes".
  const prevRefused = flowState[sessionKey] && flowState[sessionKey].ageRefusedAt;
  flowState[sessionKey] = { step: 'age', ageVerified: false, addrConfirmed: false, zip: '', address: '', pendingIntent: null, lastFingerprint: '', lastZip: '', mixerAsked: false, mixerAnswered: false, packageShown: false, proposalStep: null, proposalData: null, orderStep: null, orderData: null };
  if (prevRefused && Date.now() - prevRefused < 24 * 3600 * 1000) flowState[sessionKey].ageRefusedAt = prevRefused;
  sessions[sessionKey] = [];
  // Clear L1 cache for this user
  if (email) Object.keys(packageCache).forEach(k => { if (k.startsWith(email + ':')) delete packageCache[k]; });
}

// ── Format helpers ─────────────────────────────────────────────────────────
function formatResponse(text, format) {
  if (!text) return '';
  if (format === 'voiceflow') {
    return text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*(.*?)\*/g, '<b>$1</b>');
  }
  if (format === 'slack') return text;
  return text;
}

const CHANNEL_FORMAT_NOTES = {
  slack: `\n\n## OUTPUT FORMAT: SLACK\n- Use *bold* for product names and totals\n- Use line breaks between sections\n- No HTML tags\n- Keep responses concise\n- For payment links use: <url|Complete your payment here>\n- NEVER mention AddToCart or cart operations`,
  voiceflow: `\n\n## OUTPUT FORMAT: VOICEFLOW\n- Use <b>bold</b> for emphasis\n- Use <br> for line breaks`,
  webchat: `\n\n## OUTPUT FORMAT: WEBCHAT\n- Use <b>bold</b> for emphasis, <br> for line breaks`,
  plain: `\n\n## OUTPUT FORMAT: PLAIN TEXT\n- No formatting whatsoever`
};

function scrubDisabledOffers(text, format) {
  if (!text) return text;
  const caps = getCapabilities(format);
  if (caps.can_place_order && caps.can_generate_proposal) return text;

  const disabledPhrases = [];
  if (!caps.can_place_order) disabledPhrases.push('place (the |an |your )?order', 'checkout', 'complete (your |)purchase');
  if (!caps.can_generate_proposal) disabledPhrases.push('generate (a |the |)(pdf )?proposal', '(pdf |)proposal');
  if (disabledPhrases.length === 0) return text;

  const combined = disabledPhrases.join('|');
  // Remove any "...would you like to ... <disabled action> ...?" clause, up to the next sentence boundary or newline
  const ctaRegex = new RegExp('would you like to[^.!?\\n]*(' + combined + ')[^.!?\\n]*[.!?]?', 'gi');
  let cleaned = text.replace(ctaRegex, '');
  // Also catch shorter standalone offers not phrased as "would you like to..." (e.g. "Shall I place the order?")
  const shortRegex = new RegExp('[^.!?\\n]*\\b(' + combined + ')\\b[^.!?\\n]*\\?', 'gi');
  cleaned = cleaned.replace(shortRegex, '');
  // Collapse resulting blank lines/spaces from removed clauses
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return cleaned;
}

function getChannelNote(format) {
  const base = CHANNEL_FORMAT_NOTES[format] || CHANNEL_FORMAT_NOTES.plain;
  const caps = getCapabilities(format);
  let restrictions = '';
  if (!caps.can_place_order) {
    restrictions += '\n- Do NOT offer to place the order, finalize checkout, or mention completing a purchase as a next step on this channel — these actions are not available here. If the customer explicitly asks to place an order anyway, let them know checkout isn\'t available on this channel and suggest completing it through the Bevvi app or website instead.';
  }
  if (!caps.can_generate_proposal) {
    restrictions += '\n- Do NOT offer to generate a PDF proposal as a next step on this channel — this action is not available here. If the customer explicitly asks for one anyway, let them know that isn\'t available on this channel and suggest contacting bevvi-support@getbevvi.com for a formal proposal.';
  }
  return base + (restrictions ? '\n\n## CHANNEL RESTRICTIONS' + restrictions : '');
}

// ── Rachel chat wrapper ────────────────────────────────────────────────────
// Hoisted so BOTH the confirm_substitute tool path and the deterministic pick-list
// handler (in the request handler, outside callRachel's scope) share one implementation.
async function applyBasketSubstitute(sessionKey, email, originalItem, replacementName, replacementPrice, replacementSize, opts) {
      // The LLM calls this explicitly whenever it recognizes the customer has confirmed
      // a substitute, in ANY phrasing — replacing the earlier, fundamentally fragile
      // approach of trying to detect confirmations by regex-matching the customer's raw
      // text after the fact (which missed real phrasings across many rounds of tonight's
      // testing). The LLM already understands intent correctly; this just makes sure
      // that understanding reliably becomes a real state change, not just narration.
      try {
        const state = getState(sessionKey);
        if (!replacementName) return { success: false, error: 'replacement_name required' };
        let items = [];
        try { items = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
        // No original named: a replacement stands in for the ONLY other basket line of its spirit type
        // that wasn't itself just swapped in. Real bug (Sep 29, Slack): "Don Julio and Casamigos as their
        // two options" — Don Julio replaced Mi Campo, then Casamigos came with no original_item and was
        // added at 1 bottle beside the 4 Patron it was meant to replace.
        if (!originalItem && !(opts && opts.add)) {   // opts.add: a plain add (an accepted CTA), never an inferred replacement
          try {
            const { spiritType } = require('./spirit-type.js');
            const t = spiritType(replacementName);
            const nk0 = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const cands = t ? items.filter(it => spiritType(it.name || it.label) === t && nk0(it.name).indexOf(nk0(replacementName).slice(0, 10)) < 0 && !(it.subst_at && Date.now() - it.subst_at < 30 * 60 * 1000)) : [];
            if (cands.length === 1) { originalItem = cands[0].name; console.log('[confirm-substitute] no original given — ' + replacementName + ' replaces the only other ' + t + ' in the basket: ' + originalItem + ' (qty ' + (cands[0].qty || cands[0].quantity || 1) + ')'); }
            else if (t) console.log('[confirm-substitute] no original given — ' + cands.length + ' other ' + t + ' line(s) ' + JSON.stringify(cands.map(c => c.name)) + ', adding as a new line');
          } catch (e) {}
        }
        // A cross-type original must come from the customer. Real bug (Sep 29 QA, scenario 26): for
        // "Don Julio Blanco and Casamigos Blanco" the LLM sent original_item = the Bacardi (a rum still
        // waiting for its whiskey swap) for the Casamigos, leaving the 4 Patron in place. Allowed only
        // when one of the customer's recent lines names the original together with the replacement's
        // type or brand ("Instead of Bacardi – … whiskey"); otherwise the only other line of the
        // replacement's type is the original.
        if (originalItem) {
          try {
            const { spiritType } = require('./spirit-type.js');
            const tR = spiritType(replacementName), tO = spiritType(originalItem);
            if (tR && tO && tR !== tO) {
              const nrm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
              const userLines = (sessions[sessionKey] || []).filter(m => m.role === 'user' && typeof m.content === 'string').slice(-6).map(m => m.content)
                .concat(state.currentUserMessage || '').flatMap(c => String(c).split(/\n+|•/)).map(nrm);
              const oWord = nrm(originalItem).split(/[^a-z0-9']+/).find(w => w.length >= 3) || '';
              const rWords = [tR].concat(tR === 'whiskey' ? ['whisky', 'bourbon', 'scotch', 'rye'] : []).concat(nrm(replacementName).split(/[^a-z0-9']+/).filter(w => w.length >= 4).slice(0, 2));
              const said = userLines.some(l => l.includes(oWord) && rWords.some(w => new RegExp('\\b' + w + '\\b').test(l)));
              if (!said) {
                const nk0 = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const cands = items.filter(it => spiritType(it.name || it.label) === tR && nk0(it.name).indexOf(nk0(replacementName).slice(0, 10)) < 0 && !(it.subst_at && Date.now() - it.subst_at < 30 * 60 * 1000));
                console.log('[confirm-substitute] ' + replacementName + ' (' + tR + ') for ' + originalItem + ' (' + tO + ') — the customer never asked for that cross-type swap; ' + (cands.length === 1 ? 'replacing ' + cands[0].name + ' instead' : cands.length + ' ' + tR + ' line(s) fit — treated as no original'));
                originalItem = cands.length === 1 ? cands[0].name : '';
              }
            }
          } catch (e) { console.log('[confirm-substitute] cross-type check failed: ' + e.message); }
        }
        const originalBrandWord = originalItem ? originalItem.split(' ')[0].toLowerCase() : null;
        let qtyToUse = 1;
        let categoryToUse = '';
        if (originalBrandWord) {
          const removeIdx = items.findIndex(it => (it.name || it.label || '').toLowerCase().includes(originalBrandWord));
          if (removeIdx >= 0) {
            qtyToUse = items[removeIdx].qty || items[removeIdx].quantity || 1;
            categoryToUse = items[removeIdx].category || '';
            items.splice(removeIdx, 1);
          }
        }
        // Resolve the replacement to a REAL catalog product. Real bug: the LLM called
        // confirm_substitute without a price, and this pushed a hollow placeholder —
        // $0.00, empty product_id/upc/establishmentId — which showed as "pending
        // confirmation (currently $0.00)" in the basket and could never be ordered.
        // Look the product up by name so a swapped item is always orderable; use the
        // LLM-supplied size/price only to pick the right variant among matches.
        let resolved = null;
        // First: the products Rachel just showed. Same price (to the cent) + a shared distinctive
        // word is the product the customer picked, whatever name the LLM displayed.
        try {
          const shown = JSON.parse(state.lastShownProducts || '[]');
          const GENERICW = /^(wine|wines|vodka|tequila|gin|rum|whiskey|whisky|bourbon|scotch|beer|reserve|estate|vintner|vintners|the|and|bottle|750ml|red|white|blend)$/;
          const wordsR = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !GENERICW.test(w));
          const want = new Set(wordsR(replacementName));
          const cands = shown.filter(x => replacementPrice && Math.abs((parseFloat(x.price) || 0) - replacementPrice) < 0.01)
            .map(x => ({ x, hit: wordsR(x.name).filter(w => want.has(w)).length })).filter(c => c.hit > 0).sort((a, b) => b.hit - a.hit);
          if (cands.length && (cands.length === 1 || cands[0].hit > cands[1].hit)) {
            const x = cands[0].x;
            resolved = { name: x.name, price: parseFloat(x.price) || 0, salePrice: parseFloat(x.price) || 0, size: x.size || '', sizeStr: x.size || '', url: x.url || '', product_id: x.product_id || '', id: x.product_id || '', upc: x.upc || '', establishmentId: x.establishmentId || '', category: x.category || '' };
            console.log('[confirm-substitute] resolved from the products just shown:', JSON.stringify(replacementName), '->', x.name, '$' + x.price);
          }
        } catch (e) {}
        if (!resolved) try {
          const rr = await fetch('http://127.0.0.1:8300/mcp', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'product_query', arguments: { queries: [{ name: replacementName, limit: 8 }], zip: state.zip || '', email: email } } })
          });
          const rt = await rr.text();
          const rl = rt.split('\n').find(l => l.startsWith('data:'));
          const rd = rl ? JSON.parse(rl.replace('data:', '').trim()) : null;
          const rres = rd ? JSON.parse(rd.result.content[0].text) : null;
          const prods = (rres && rres.results && rres.results[0] && rres.results[0].products) || [];
          // Strip size/pack suffixes BEFORE comparing names, otherwise the catalog name
          // "Angostura Bitters - 4 OZ" reads as "angosturabitters4oz" and gets treated as
          // a different variant of "angosturabitters" (real regression: the correct plain
          // bitters scored negative and the swap stored a $0 placeholder).
          const stripSize = s => String(s || '').replace(/\s*[-—]?\s*\d+(\.\d+)?\s*(ml|l|oz|liter|litre)\b.*$/i, '').replace(/\s*\d+\s*x\s*\d+\s*oz.*$/i, '');
          const norm = s => stripSize(s).toLowerCase().replace(/[^a-z0-9]/g, '');
          const wantSize = String(replacementSize || '').toLowerCase().replace(/[^a-z0-9]/g, ''), wantName = norm(replacementName);
          const scored = prods.map(p => {
            const pn = norm(p.name), ps = norm(p.sizeStr || p.size || '');
            let s = 0;
            // Exact match wins. A candidate that CONTAINS the wanted name with extra words
            // ("angosturabitterscocoa" for wanted "angosturabitters") is a DIFFERENT product
            // — penalize it, don't reward it (real bug: plain Angostura Bitters resolved to
            // the Cocoa variant, so the displayed swap silently didn't happen at the
            // product level). Only reward the reverse (wanted name has extra descriptors).
            if (pn === wantName) s += 100;
            else if (wantName.indexOf(pn) >= 0) s += 40;      // candidate is a shorter core of the wanted name
            else if (pn.indexOf(wantName) >= 0) s -= 30;      // candidate has extra words = different variant
            if (wantSize && ps && ps.indexOf(wantSize) >= 0) s += 30;
            const pp = parseFloat(p.salePrice || p.price) || 0;
            if (replacementPrice && pp && Math.abs(pp - replacementPrice) < 0.01) s += 20;
            return { p, s };
          }).sort((a, b) => b.s - a.s);
          if (scored.length && scored[0].s > 0) resolved = scored[0].p;
        } catch (e) { console.log('[confirm-substitute] product lookup failed:', e.message); }
        if (resolved) {
          console.log('[confirm-substitute] resolved', JSON.stringify(replacementName), '->', resolved.name, '$' + (resolved.salePrice || resolved.price));
        } else {
          // Never store an unresolved name. Real bug: the LLM invented "Kendall-Jackson
          // Vintner's Reserve Sauvignon Blanc" (catalog: "Kendall Jackson Sauvignon
          // Blanc"), the lookup failed, and this stored a bare line with no product_id
          // or establishmentId — which then skipped delivery validation (summary showed
          // the raw "tomorrow at 5 pm") and would be refused at placement. Return a
          // structured failure the LLM must act on instead.
          console.log('[confirm-substitute] REFUSED: could not resolve', JSON.stringify(replacementName), 'to a catalog product — not added');
          events.unmatched(replacementName);
          return { success: false, unresolved_replacement: replacementName, error: 'Could not find "' + replacementName + '" in the catalog. Search for it and present the real matches so the customer can pick one; do not assume a product name.' };
        }
        const rp = resolved ? (parseFloat(resolved.salePrice || resolved.price) || replacementPrice || 0) : (replacementPrice || 0);
        const newPid = resolved ? ((resolved.corpProductFilter && resolved.corpProductFilter.corpProductId) || resolved.product_id || resolved.id || '') : '';
        const newName = resolved ? resolved.name : replacementName;
        const normN = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        // Duplicate guard: if this product is ALREADY in the basket (same product_id, or
        // same normalized name when no id), merge into that line instead of pushing a
        // second one. Real bug: a basket held "2x Kendall Jackson" AND "4x Kendall
        // Jackson" (same id) plus two "1x Bacardi" lines — $426 real vs $339 quoted; an
        // order would have charged for 6 Chardonnays and 2 Bacardis.
        const dupIdx = items.findIndex(it => (newPid && it.product_id === newPid) || (!newPid && normN(it.name) === normN(newName)));
        if (dupIdx >= 0) {
          const ex = items[dupIdx];
          // A replace sets the quantity; an add (no original) tops it up.
          ex.qty = originalItem ? qtyToUse : ((ex.qty || ex.quantity || 1) + (qtyToUse || 1));
          ex.quantity = ex.qty; ex.subst_at = Date.now();
          if (rp) ex.price = rp;
          console.log('[confirm-substitute] merge into existing line:', ex.name, '-> qty', ex.qty);
        } else {
          items.push({
            label: replacementName, name: newName, qty: qtyToUse, quantity: qtyToUse, subst_at: Date.now(),
            price: rp, size: resolved ? (resolved.sizeStr || resolved.size || replacementSize || '') : (replacementSize || ''),
            url: resolved ? (resolved.url || '') : '', product_id: newPid,
            upc: resolved ? (resolved.upc || '') : '', establishmentId: resolved ? (resolved.establishmentId || '') : '',
            // Bevvi's category rides along (real bug: Patron Silver and Mount Gay landed under
            // OTHER on the PDF because add paths wrote items with no category).
            category: categoryToUse || (resolved ? (resolved.category || resolved.subCategory || resolved.subcategory || '') : '')
          });
        }
        const newLineItems = JSON.stringify(items);
        const key2 = makeCacheKey(email, state.zip, state.lastFingerprint);
        packageCache[key2] = newLineItems;
        state.lastLineItems = newLineItems;
        if (originalItem && state.pendingSubstitutes) {
          state.pendingSubstitutes = state.pendingSubstitutes.filter(p => p !== originalItem);
        }
        saveFlowState();
        try { saveBasket(email, newLineItems, '', 'slack').catch(() => {}); } catch (e) {}
        console.log('[confirm-substitute-tool] replaced', JSON.stringify(originalItem), 'with', JSON.stringify(replacementName), 'qty', qtyToUse);
        return { success: true, replaced: originalItem, with: replacementName, qty: qtyToUse };
      } catch (e) {
        console.error('[confirm-substitute-tool] error:', e.message);
        return { success: false, error: e.message };
      }
}
// Convert a wall-clock time in America/New_York to a UTC ISO string (DST-aware via
// Intl). The server runs in UTC, so chrono's parse of "5 pm" is 17:00 UTC = 1 PM
// Eastern — every delivery time was silently 4-5h off. Stores are US/Eastern; Bevvi
// wants deliveryDateTime as 2026-09-13T17:00:00.000Z (a UTC instant).
// Store timezone from the delivery address's state. Real bug: an SF order ("11 am PST")
// was parsed by chrono as 19:00 UTC, matched the "07:00 PM" window by bare number, and
// was sent as 23:00Z (4 PM PST) — five hours off for a real customer.
const STATE_TZ = { CA:'America/Los_Angeles', WA:'America/Los_Angeles', OR:'America/Los_Angeles', NV:'America/Los_Angeles',
  AZ:'America/Phoenix', CO:'America/Denver', UT:'America/Denver', NM:'America/Denver', MT:'America/Denver', ID:'America/Denver', WY:'America/Denver',
  TX:'America/Chicago', IL:'America/Chicago', MN:'America/Chicago', WI:'America/Chicago', MO:'America/Chicago', LA:'America/Chicago', OK:'America/Chicago', KS:'America/Chicago', NE:'America/Chicago', IA:'America/Chicago', AR:'America/Chicago', MS:'America/Chicago', AL:'America/Chicago', TN:'America/Chicago', KY:'America/Chicago', SD:'America/Chicago', ND:'America/Chicago',
  HI:'Pacific/Honolulu', AK:'America/Anchorage' };
function zoneForAddress(addr) {
  const m = String(addr || '').match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\s*$/i);
  const st = m ? m[1].toUpperCase() : '';
  return STATE_TZ[st] || 'America/New_York';
}
// Explicit zone the customer typed (e.g. "11 am PST") -> IANA. Returns '' if none.
function explicitZoneIn(text) {
  const m = String(text || '').match(/\b(PST|PDT|PT|MST|MDT|MT|CST|CDT|CT|EST|EDT|ET)\b/i);
  if (!m) return '';
  const z = m[1].toUpperCase();
  return /^P/.test(z) ? 'America/Los_Angeles' : /^M/.test(z) ? 'America/Denver' : /^C/.test(z) ? 'America/Chicago' : 'America/New_York';
}
// ASSUMPTION (confirm with Bevvi): getDeliveryDateTimes windows are STORE-LOCAL wall-clock
// times with a hardcoded "EST" label — the SF and NYC stores return identical window
// strings, which fits a mislabeled local schedule far better than an SF store genuinely
// opening at 8 AM Pacific. If Bevvi says windows are always Eastern, set this to
// 'America/New_York' and the matching converts accordingly.
const WINDOWS_ARE_STORE_LOCAL = true;
// Wall-clock in an arbitrary IANA zone -> UTC ISO.
function zonedToUtcIso(dateStr, hour, minute, zone) {
  const guess = new Date(Date.UTC(+dateStr.slice(0,4), +dateStr.slice(5,7)-1, +dateStr.slice(8,10), hour, minute));
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour12: false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(guess).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month-1, +parts.day, +parts.hour % 24, +parts.minute);
  return new Date(guess.getTime() - (asUtc - guess.getTime())).toISOString();
}
// Re-express a store window ("04:00 PM - 05:00 PM EST", in windowZone) in the
// customer's zone for DISPLAY. The instant we send is already correct; this is so a
// West-Coast customer who said "1 pm PST" sees "1:00 PM - 2:00 PM PT", not "04:00 PM
// EST" (correct underneath, but reads as "Rachel ignored my timezone").
function fmtWindowInZone(windowStr, dateStr, windowZone, custZone) {
  try {
    if (!custZone || custZone === windowZone) return windowStr;
    const win = parseTimeWindow(windowStr); if (!win) return windowStr;
    const abbr = { 'America/Los_Angeles': 'PT', 'America/Denver': 'MT', 'America/Chicago': 'CT', 'America/New_York': 'ET', 'America/Phoenix': 'MST', 'Pacific/Honolulu': 'HST', 'America/Anchorage': 'AKT' }[custZone] || custZone;
    const fmtOne = (h) => {
      const iso = zonedToUtcIso(dateStr, Math.floor(h), Math.round((h - Math.floor(h)) * 60), windowZone);
      return new Intl.DateTimeFormat('en-US', { timeZone: custZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
    };
    return fmtOne(win.start) + ' - ' + fmtOne(win.end) + ' ' + abbr + ' (' + windowStr.replace(/\s*EST\s*$/i, ' ET') + ')';
  } catch (e) { return windowStr; }
}

// Hoisted so the details block, the fast-path re-entry, and the no-total reconfirm all
// render the IDENTICAL summary. Previously the builder was inline in the details block;
// callers later in the file (fast-path via a message sentinel, reconfirm) could never
// reach it in-turn, so the fast-path never rendered and reconfirm showed '$0.00'.
// ── Tip ────────────────────────────────────────────────────────────────────
// The customer chooses the driver tip (asked once per order, before the summary; changeable
// any time). Before this the tip was a fixed 5% and Rachel falsely promised "tip set to $0".
// choice: { pct } or { amount }. No choice yet = the 5% estimate shown on basket totals.
function parseTip(raw) {
  const m = String(raw || '').toLowerCase().replace(/,/g, '').trim();
  if (/^(no|none|nope|no tip|zero|0|0%|\$0|skip|nothing|no thanks|no thank you)\b/.test(m) || /\b(no tip|without (a )?tip|skip the tip|tip of (0|zero)|0 tip|zero tip)\b/.test(m)) return { pct: 0 };
  const pc = m.match(/(\d{1,3}(?:\.\d+)?)\s*(?:%|percent|pct)/);
  if (pc) return Number(pc[1]) <= 100 ? { pct: Number(pc[1]) } : null;
  const am = m.match(/\$\s*(\d{1,4}(?:\.\d{1,2})?)/) || m.match(/\b(\d{1,4}(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd)\b/);
  if (am) return { amount: Math.round(Number(am[1]) * 100) / 100 };
  if (/\b(standard|default|usual)\b/.test(m)) return { pct: 5 };
  const bare = m.replace(/[.!]+$/, '').match(/^(?:(?:ok(?:ay)?|sure|yes)[, ]+)?(?:make it |let'?s do |lets do |i'?ll do |go with |do |add |tip )?(\d{1,3}(?:\.\d{1,2})?)(?: please)?$/);
  if (bare) { const n = Number(bare[1]); return [5, 10, 15, 18, 20, 25].includes(n) ? { pct: n } : { ambiguous: n }; }
  return null;
}
// ── Event serving mix ──────────────────────────────────────────────────────
// DC: when an event mixes drink types (wine + beer + liquor, wine + beer + cocktails),
// ask what the customer wants to serve more of, and build the package on that mix.
// Keys are the package builder's categories: wine, beer (seltzer/cider count as beer),
// spirits (liquor, cocktails, mixed drinks).
const MIX_SYN = {
  wine: /\b(wines?|vino|reds?|whites?|ros[eé]|champagne|prosecco|bubbly|sparkling)\b/i,
  beer: /\b(beers?|brews?|lagers?|ipas?|seltzers?|hard seltzers?|ciders?)\b/i,
  spirits: /\b(cocktails?|mixed drinks?|liquor|spirits|hard liquor|booze|vodka|tequila|whiske?y|bourbon|rum|gin|shots?|full bar)\b/i
};
function eventDrinkCats(msg) {
  const m = String(msg || '');
  if (!/\b(\d+\s*(people|guests|persons|ppl|attendees|folks|pax)|party|event|wedding|reception|happy hour|gathering|celebration|offsite|off-site|mixer|bar package|open bar)\b/i.test(m)) return null;
  const cats = Object.keys(MIX_SYN).filter(k => MIX_SYN[k].test(m));
  if (/\bfull bar\b/i.test(m)) { for (const k of ['wine', 'beer', 'spirits']) if (!cats.includes(k)) cats.push(k); }
  return cats.length >= 2 ? cats : null;
}
// requireCue: in the ORIGINAL request the categories are just listed, so only a preference
// word ("mostly wine") counts; in the ANSWER to our question, naming a category is enough.
function parseServingMix(msg, cats, requireCue) {
  const m = String(msg || '').toLowerCase();
  const out = {}; cats.forEach(k => { out[k] = 0; });
  // explicit percentages: "50% wine", "wine 50%"
  let pctFound = 0;
  for (const k of cats) {
    const src = MIX_SYN[k].source.replace(/^\\b|\\b$/g, '');
    const a = m.match(new RegExp('(\\d{1,3})\\s*%\\s*(?:of\\s+)?(?:\\w+\\s+)?' + src)) || m.match(new RegExp(src + '\\s*(?:at\\s+|:)?\\s*(\\d{1,3})\\s*%'));
    if (a) { out[k] = Number(a[1] || a[a.length - 1]); pctFound++; }
  }
  if (pctFound >= 1) { const sum = Object.values(out).reduce((x, y) => x + y, 0); const rest = cats.filter(k => !out[k]); const left = Math.max(0, 100 - sum); rest.forEach(k => { out[k] = left / rest.length; }); const tot = Object.values(out).reduce((x, y) => x + y, 0) || 1; cats.forEach(k => { out[k] = out[k] / tot; }); return { mix: out, why: 'percentages' }; }
  const cue = /\b(most|mostly|mainly|primarily|majority|more|heavier|heavy on|lean(?:ing)?|bigger preference|prefer|preference|favorite|love|big on)\b/.test(m);
  if (/\b(even|evenly|equal|equally|balanced|no preference|doesn'?t matter|don'?t care|all the same|a bit of everything|mix of everything|split it)\b/.test(m)) { cats.forEach(k => { out[k] = 1 / cats.length; }); return { mix: out, why: 'even' }; }
  if (requireCue && !cue) return null;
  // "less beer", "not much beer", "no beer" pull a category down
  const low = cats.filter(k => new RegExp('\\b(no|not much|not a lot of|less|light on|little|hardly any|few|minimal)\\s+(?:\\w+\\s+)?' + MIX_SYN[k].source.replace(/^\\b|\\b$/g, '')).test(m));
  // With a preference word, the category right after it ranks first ("some wine, but mostly
  // beer" -> beer > wine); otherwise the order they were named in.
  const cueIdx = cue ? m.search(/\b(most|mostly|mainly|primarily|majority|more|heavier|heavy on|lean(?:ing)?|bigger preference|prefer|preference|favorite|love|big on)\b/) : -1;
  const rank = k => { const i = m.search(MIX_SYN[k]); return cueIdx >= 0 ? (i >= cueIdx ? i - cueIdx : 10000 + i) : i; };
  const named = cats.filter(k => !low.includes(k) && MIX_SYN[k].test(m)).sort((a, b) => rank(a) - rank(b));
  if (!named.length && !low.length) return null;
  if (!named.length) { const others = cats.filter(k => !low.includes(k)); low.forEach(k => { out[k] = 0.1; }); others.forEach(k => { out[k] = (1 - 0.1 * low.length) / others.length; }); return { mix: out, why: 'less ' + low.join('/') }; }
  const ranked = cue || /\b(then|followed by|than|after that|next)\b|>/.test(m);
  const W3 = { 1: [0.5], 2: ranked ? [0.5, 0.3] : [0.4, 0.4], 3: ranked ? [0.5, 0.3, 0.2] : null };
  const W2 = { 1: [0.65], 2: ranked ? [0.65, 0.35] : null };
  const w = (cats.length >= 3 ? W3 : W2)[Math.min(named.length, cats.length)];
  if (!w) { cats.forEach(k => { out[k] = 1 / cats.length; }); return { mix: out, why: 'all named, no order: even' }; }
  named.forEach((k, i) => { out[k] = w[i]; });
  const restK = cats.filter(k => !named.includes(k)); const left = 1 - w.reduce((x, y) => x + y, 0);
  restK.forEach(k => { out[k] = low.includes(k) ? Math.min(0.1, left) : left / restK.length; });
  const tot = Object.values(out).reduce((x, y) => x + y, 0) || 1; cats.forEach(k => { out[k] = out[k] / tot; });
  return { mix: out, why: 'most: ' + named.join(' > ') };
}
const mixText = mx => Object.entries(mx).map(([k, v]) => (k === 'spirits' ? 'liquor/cocktails' : k) + ' ' + Math.round(v * 100) + '%').join(' / ');

function tipFor(state, base) {
  const c = (state.orderData && state.orderData.tipChoice) || state.savedTipChoice || null;
  if (!c) return { tip: Math.round(base * 5) / 100, label: 'Tip (5%)', choice: null };
  if (c.pct != null) return { tip: Math.round(base * c.pct) / 100, label: c.pct === 0 ? 'Tip (none)' : 'Tip (' + c.pct + '%)', choice: c };
  return { tip: c.amount, label: 'Tip', choice: c };
}
const tipText = c => c.pct != null ? (c.pct === 0 ? 'no tip' : c.pct + '%') : '$' + c.amount.toFixed(2);

function renderOrderSummary(state, email, format, res) {
  state.orderStep = 'confirm';
  // One line per product in what the customer approves (and what place_order sends — it uses
  // this same basket). DC, Sep 27: an order must never carry the same product twice.
  try {
    const { mergeOrderLines } = require('/home/ubuntu/store-agent/order-lines.js');
    const cur = typeof state.lastLineItems === 'string' ? JSON.parse(state.lastLineItems || '[]') : (state.lastLineItems || []);
    const mr = mergeOrderLines(cur);
    if (mr.merged.length) {
      mr.merged.forEach(m => console.log('[order] merged duplicate line before the summary: "' + m.dropped + '" into "' + m.kept + '" -> qty ' + m.qty + ' (' + m.reason + ')'));
      state.lastLineItems = JSON.stringify(mr.items);
      if (mr.items.length === 1 && state.orderData) state.orderData.qty = mr.items[0].qty || mr.items[0].quantity || state.orderData.qty;
    }
  } catch (e) { console.error('[order] line merge failed:', e.message); }
  saveFlowState();
    // Build order summary
    let productName = 'Product';
    let unitPrice = 0;
    if (state.lastLineItems) {
      try {
        const items = typeof state.lastLineItems === 'string' ? JSON.parse(state.lastLineItems) : state.lastLineItems;
        if (items && items.length > 0) {
          productName = items[0].name || 'Product';
          unitPrice = parseFloat(items[0].price || items[0].unit_price || 0);
        }
      } catch(e) {}
    }
    const qty = state.orderData.qty;
    // Multi-item basket: sum all lines and build an itemized summary
    let multiLines = null;
    let multiTotal = 0;
    try {
      const allItems = typeof state.lastLineItems === 'string' ? JSON.parse(state.lastLineItems) : state.lastLineItems;
      if (allItems && allItems.length > 1) {
        multiLines = allItems.map(it => {
          const q = it.qty || it.quantity || 1;
          const p = parseFloat(it.price || it.unit_price || 0);
          const lt = Math.round(q * p * 100) / 100;
          multiTotal += lt;
          return q + 'x ' + (it.name || it.label) + ' — $' + p.toFixed(2) + ' ea = $' + lt.toFixed(2);
        });
        multiTotal = Math.round(multiTotal * 100) / 100;
      }
    } catch(e) {}
    const productTotal = multiLines ? multiTotal : Math.round(unitPrice * qty * 100) / 100;
    // Every path to the summary comes through here (details, fast-path re-entry, time or
    // instruction changes), so this is the one place the tip question is asked.
    if (!state.orderData.tipChoice && !state.savedTipChoice) {
      state.orderStep = 'tip'; state.orderData.tipBase = productTotal; saveFlowState();
      const a = p => '$' + (Math.round(productTotal * p) / 100).toFixed(2);
      console.log('[tip] asking before the summary (product total $' + productTotal.toFixed(2) + ')');
      const askT = 'Would you like to add a tip for your driver? 10% (' + a(10) + '), 15% (' + a(15) + '), 20% (' + a(20) + '), a custom amount (e.g. "$8"), or "no tip".';
      return res.json({ text: askT, response: askT });
    }
    if (!state.orderData.tipChoice) state.orderData.tipChoice = state.savedTipChoice;
    const tax = Math.round(productTotal * 0.10 * 100) / 100;
    const service = Math.round(productTotal * 0.10 * 100) / 100;
    const { tip, label: tipLabel } = tipFor(state, productTotal);
    const delivery = 25.00; // Quoted as an ESTIMATE only; not sent on the order (Bevvi backend to apply delivery)
    const grandTotal = Math.round((productTotal + tax + service + tip + delivery) * 100) / 100;
    state.orderData.grandTotal = grandTotal;
    state.orderData.productName = productName;
    state.orderData.unitPrice = unitPrice;
    state.orderData.productTotal = productTotal;
    state.orderData.tax = tax;
    state.orderData.service = service;
    state.orderData.tip = tip;
    saveFlowState();
    const summary = format === 'slack'
      ? '*Order Summary*\n\n' +
        (multiLines ? multiLines.join('\n') : productName + ' x' + qty + ' — $' + unitPrice.toFixed(2) + ' ea = $' + productTotal.toFixed(2)) + '\n' +
        'For: ' + (state.orderData.name || '') + (state.orderData.phone ? ' | ' + state.orderData.phone : '') + '\n' +
        'Recipient email: ' + (state.orderData.email || email || '') + '\n' +
        'Delivery to: ' + state.address + '\n' +
        'Delivery: ' + (state.orderData.delivery_date_label ? state.orderData.delivery_date_label + ', ' : '') + (state.orderData.delivery_window_display || state.orderData.delivery_datetime) + '\n' +
        (state.orderData.delivery_instructions ? 'Delivery instructions: ' + state.orderData.delivery_instructions + '\n' : '') + '\n' +
        'Product total: $' + productTotal.toFixed(2) + '\n' +
        'Estimated tax (10%): $' + tax.toFixed(2) + '\n' +
        'Service charge (10%): $' + service.toFixed(2) + '\n' +
        tipLabel + ': $' + tip.toFixed(2) + '\n' +
        'Estimated delivery: $' + delivery.toFixed(2) + '\n' +
        '*Estimated grand total: $' + grandTotal.toFixed(2) + '*\n\n' +
        'Shall I go ahead and place this order?'
      : 'Order summary ready. Grand total: $' + grandTotal.toFixed(2) + '. Confirm?';
    return res.json({ text: summary, response: summary });
}
// Hoisted so the details step AND the time-change handlers (which sit later in the file)
// can validate a delivery time from the message they already have, in the same turn.
// Real complaint: 'change the delivery time to 3 pm tomorrow' re-asked for the time
// because validation was inline in the details block and unreachable from the confirm
// handler. Returns a res.json(...) response when it must ask (unparseable / unavailable),
// or null on success with the validated window stored on state.orderData.
// The store's delivery windows on a date phrase ("Monday, October 5th"): { label, options, none }.
async function deliveryWindowsOn(state, datePhrase) {
  const r = chrono.parse(String(datePhrase || ''), new Date(), { forwardDate: true })[0];
  if (!r) return { label: '', options: [], none: false };
  const d = r.start.date();
  const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  let label = dateStr; try { label = new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); } catch (e) {}
  let est = ''; try { const it = JSON.parse(state.lastLineItems || '[]'); est = (it.find(li => li.establishmentId) || {}).establishmentId || ''; } catch (e) {}
  if (!est) return { label, options: [], none: false };
  const avail = await checkDeliveryAvailability(est, dateStr);
  if (!avail || !Array.isArray(avail.deliveryTimes)) return { label, options: [], none: false };
  const windowZone = WINDOWS_ARE_STORE_LOCAL ? zoneForAddress(state.address) : 'America/New_York';
  return { label, options: avail.deliveryTimes.map(w => fmtWindowInZone(w.displayTime, dateStr, windowZone, null)), none: avail.deliveryTimes.length === 0 };
}
async function validateDeliveryTime(state, message, email, format, res) {
  // Parse as WALL-CLOCK. If the customer typed a zone ("11 am PST"), record it but
  // strip it before chrono sees it — otherwise chrono converts to UTC and the bare
  // hour no longer means what the customer said.
  const custZone = explicitZoneIn(message);
  const storeZone = zoneForAddress(state.address);
  const msgForParse = message.replace(/\b(PST|PDT|PT|MST|MDT|MT|CST|CDT|CT|EST|EDT|ET)\b/gi, '').replace(/\s+/g, ' ').trim();
  const parsedResults = chrono.parse(msgForParse, new Date(), { forwardDate: true });
  if (!parsedResults.length || !parsedResults[0].start.isCertain('hour')) {
    const ask = 'Could you give me a specific delivery date and time? (e.g. \"tomorrow at 5pm\" or \"August 5th at 2pm\")';
    return res.json({ text: ask, response: ask });
  }
  const parsedDate = parsedResults[0].start.date();
  let requestedHour = parsedDate.getHours() + parsedDate.getMinutes() / 60;
  // The customer's stated hour is in custZone (if given) else the store zone. Windows
  // are in windowZone. Shift the hour between zones for matching when they differ.
  const windowZone = WINDOWS_ARE_STORE_LOCAL ? storeZone : 'America/New_York';
  const fromZone = custZone || storeZone;
  if (fromZone !== windowZone) {
    try {
      const iso = zonedToUtcIso(parsedDate.getFullYear() + '-' + String(parsedDate.getMonth()+1).padStart(2,'0') + '-' + String(parsedDate.getDate()).padStart(2,'0'), parsedDate.getHours(), parsedDate.getMinutes(), fromZone);
      const inWin = new Intl.DateTimeFormat('en-US', { timeZone: windowZone, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
      const h = +inWin.find(x => x.type === 'hour').value % 24, mi = +inWin.find(x => x.type === 'minute').value;
      requestedHour = h + mi / 60;
      console.log('[delivery-tz] customer', fromZone, parsedDate.getHours() + ':' + parsedDate.getMinutes(), '-> window zone', windowZone, h + ':' + mi);
    } catch (e) {}
  }
  // Use the parsed calendar fields directly (the date the customer stated), not
  // toISOString() — which is UTC and shifts evening times to the next day.
  const dateStr = parsedDate.getFullYear() + '-' + String(parsedDate.getMonth() + 1).padStart(2, '0') + '-' + String(parsedDate.getDate()).padStart(2, '0');
  // A time in the past is not a delivery request. Real bug: "yesterday at 5pm" was checked
  // against yesterday's windows and the customer was offered "06:00 PM - 07:00 PM" on a
  // date that had already gone.
  try {
    const whenUtc = new Date(zonedToUtcIso(dateStr, parsedDate.getHours(), parsedDate.getMinutes(), fromZone)).getTime();
    if (whenUtc < Date.now()) {
      console.log('[delivery] requested time is in the past (' + dateStr + ' ' + parsedDate.getHours() + ':' + String(parsedDate.getMinutes()).padStart(2, '0') + ' ' + fromZone + ') — re-asking');
      const askP = 'That time has already passed — what upcoming date and time would you like? (e.g. "tomorrow at 5pm")';
      return res.json({ text: askP, response: askP });
    }
  } catch (e) { console.error('[delivery] past-time check failed:', e.message); }

  let establishmentId = '';
  try {
    const items = typeof state.lastLineItems === 'string' ? JSON.parse(state.lastLineItems) : state.lastLineItems;
    if (items && items.length > 0) establishmentId = items[0].establishmentId || '';
  } catch(e) {}

  let finalDeliveryText = message.trim();
  if (establishmentId) {
    const avail = await checkDeliveryAvailability(establishmentId, dateStr);
    if (avail && Array.isArray(avail.deliveryTimes)) {
      if (avail.deliveryTimes.length === 0) {
        const ask = 'Looks like there\'s no delivery availability on ' + dateStr + ' for this store. Could you try a different date?';
        return res.json({ text: ask, response: ask });
      }
      let matchedWindow = null;
      for (const w of avail.deliveryTimes) {
        const win = parseTimeWindow(w.deliveryTime);
        if (win && requestedHour >= win.start && requestedHour < win.end) {
          matchedWindow = w;
          break;
        }
      }
      if (!matchedWindow) {
        const optionsText = avail.deliveryTimes.map(w => fmtWindowInZone(w.displayTime, dateStr, windowZone, custZone)).join(', ');
        const ask = 'That time isn\'t available on ' + dateStr + '. Here are the available delivery windows: ' + optionsText + '. Which one works for you?';
        return res.json({ text: ask, response: ask });
      }
      finalDeliveryText = matchedWindow.deliveryTime;
      state.orderData.delivery_window_display = fmtWindowInZone(matchedWindow.deliveryTime, dateStr, windowZone, custZone);
      try { state.orderData.delivery_date_label = new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); } catch (e) {}
      // Bevvi needs a real datetime, not a window string with no date. Real bug: we
      // sent deliveryDateTime '03:00 PM - 04:00 PM EST' — no day at all. Combine
      // the validated date with the window's start time into an ISO datetime.
      try {
        const win = parseTimeWindow(matchedWindow.deliveryTime);
        if (win) {
          const hh = Math.floor(win.start), mm = Math.round((win.start - hh) * 60);
          state.orderData.delivery_datetime_iso = zonedToUtcIso(dateStr, hh, mm, windowZone);   // window start in the store's zone -> UTC instant
        }
      } catch (e) {}
    }
  }

  state.orderData.delivery_datetime = finalDeliveryText;
  return null;
}
const cta = require('./cta.js');
const QE = require('./quote-edits.js');   // edits to a quote the customer already has, applied in code
const EO = require('./email-order.js');
const LR = require('./line-resolve.js');   // unlinked basket lines (a hand-built quote) -> catalog products, exact matches only   // "create the order" / "payment link" from an email, placed in code
const listReply = require('./list-reply.js');   // shopping-list replies composed in code (see the NEXT-BEST-ACTION wrapper)
const contacts = require('./customer-contacts.js');   // name/phone from the last placed order + channel profile name (order flow)
const isInternalMsgEarly = m => /^__/.test(m) || /^\d{1,2}:\d{2}\s*[AP]M\s*-\s*\d{1,2}:\d{2}\s*[AP]M/i.test(m);
// The CTA table's view of a turn: which state row applies, and the facts its conditions read.
const OPTION_LINE_RE = /^\s*(?:\d+[.)]\s*|[A-Z][.)]\s+)?[*_]*([^*_\n—]+?)[*_]*\s+—\s+([^—\n$]*?\d[^—\n$]*?)\s+—\s+\$([\d,]+(?:\.\d+)?)(?!\s*ea\s*=)[^\n=]*$/gm;
function ctaTurn(st, body, question, msg, context) {
  const { spiritType } = require('./spirit-type.js');
  const e = events.ctx() || { actions: [], unmatched: [] };
  const label = events.stateLabel(st);
  if (question || label !== 'ready') return { kind: label !== 'ready' ? label : 'question', question: true, stateLabel: label };
  const captured = !!(e.ev && e.ev.discussed_capture);   // [product-discussed]: the searched product held as context
  const changed = !captured && (e.basket0 ? events.basketOf(st).sig !== e.basket0.sig : false);
  const opts = [...String(body).matchAll(OPTION_LINE_RE)].filter(m => !/^\s*\d+\s*x\b/i.test(m[0])).map(m => ({ name: m[1].trim(), size: m[2].trim(), price: parseFloat(m[3].replace(/,/g, '')) }));
  const has = a => e.actions.includes(a);
  const base = { stateLabel: label, corporate: !!((context && context.kitchen_location) || st.lastProposalUrl || st.savedClientName), orderStarted: !!st.orderStep, prevCta: st.ctaPrevId || null };
  let items = []; try { items = JSON.parse(st.lastLineItems || '[]'); } catch (x) {}
  if (has('placed_order')) return Object.assign(base, { kind: 'order_placed', basketItems: items.length });
  if (has('generated_proposal')) return Object.assign(base, { kind: 'proposal_sent' });
  // Something the customer named isn't available: offering its substitute beats the basket follow-up.
  if (e.unmatched.length) return Object.assign(base, { kind: 'item_unavailable', unmatchedName: e.unmatched[0], substitute: opts[0] || null });
  if (has('built_basket')) return Object.assign(base, { kind: 'basket_built' });
  if (has('updated_basket') || has('showed_basket') || changed) return Object.assign(base, { kind: 'basket_updated' });
  if (opts.length >= 2) return Object.assign(base, { kind: 'search_multi', options: opts.length });
  // A single search result held as context ([product-discussed]) IS the product — known in code, whatever
  // the reply's layout (Sep 29 QA: "Yes! *Tito's Handmade Vodka 1.75 L* is available — $43.99" has no
  // "Name — size — $price" line and was read as informational). Else one bold name + price on a line.
  if (!opts.length && captured && items.length === 1) {
    const it = items[0];
    opts.push({ name: String(it.name || it.label || '').replace(/\s*-\s*[\d.]+\s*(?:ML|L|OZ)\s*$/i, ''), size: it.size || ((String(it.name || '').match(/[\d.]+\s*(?:ML|L|OZ)\s*$/i) || [''])[0]), price: parseFloat(it.price) || 0 });
  } else if (!opts.length && has('searched')) {
    const one = [...String(body).matchAll(/^[^\n]*?\*([^*\n]{3,80})\*[^\n$]*\$(\d+(?:\.\d\d)?)[^\n]*$/gm)];
    if (one.length === 1) { const sz = (one[0][1].match(/\d+(?:\.\d+)?\s*(?:ml|l|oz)\b/i) || [''])[0]; opts.push({ name: one[0][1].replace(sz, '').trim(), size: sz, price: parseFloat(one[0][2]) }); }
  }
  if (opts.length === 1 && (captured || !items.some(it => String(it.name || '').toLowerCase().indexOf(opts[0].name.toLowerCase().slice(0, 12)) >= 0))) {
    const nm = opts[0].name + ' ' + opts[0].size;
    const category = spiritType(nm) ? 'spirits' : /wine|pinot|cabernet|chardonnay|sauvignon|merlot|ros[eé]|prosecco|champagne|riesling|malbec|zinfandel|syrah/i.test(nm) ? 'wine' : '';
    const qM = String(msg || '').match(/\b(\d{1,3})\s*(?:bottles?|x)\b/i);
    const statedQty = qM ? parseInt(qM[1]) : 0;
    const offerQty = statedQty || (category === 'wine' ? 6 : 3);
    return Object.assign(base, { kind: 'search_single', category, statedQty, offerQty, product: opts[0] });
  }
  // No question and nothing changed, but a basket exists: never a dead end (cta.js basket_idle).
  return Object.assign(base, { kind: items.length ? 'basket_idle' : 'informational', basketItems: items.length });
}

// In-stock stand-in for an item the customer named that isn't available: the same product search
// without the size; offered only when the top result carries the item's own brand words (never an
// unrelated product). Capped at 5 s — the reply goes out with the generic sub.offer_search otherwise.
async function findSubstitute(name, zip, email) {
  const words = n => String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz|cl)\b/g, ' ').split(/[^a-z0-9']+/).filter(w => w.length >= 3 && !/^(vodka|tequila|rum|gin|whiskey|whisky|bourbon|wine|beer|bottle|bottles|the|and)$/.test(w));
  const key = words(name).slice(0, 2);
  if (!key.length || !zip) { console.log('[cta] substitute lookup skipped for ' + JSON.stringify(name) + (zip ? ' (no brand words)' : ' (no zip)')); return null; }
  const q = String(name).replace(/\b\d+(?:\.\d+)?\s*(?:ml|l|oz|cl)\b/gi, ' ').replace(/^\s*\d{1,3}\s*(?:x\s*)?/, '').replace(/\s+/g, ' ').trim();
  const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 5000);
  try {
    const rr = await fetch('http://127.0.0.1:8300/mcp', { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'product_query', arguments: { queries: [{ name: q, limit: 3 }], zip, email } } }) });
    const rt = await rr.text(); const rl = rt.split('\n').find(l => l.startsWith('data:'));
    const res = rl ? JSON.parse(JSON.parse(rl.replace('data:', '').trim()).result.content[0].text) : null;
    const prods = (res && res.results && res.results[0] && res.results[0].products) || [];
    const p = prods.find(pr => { const pw = ' ' + words(pr.name).join(' ') + ' '; return key.every(k => pw.includes(' ' + k + ' ')); });
    if (!p) { console.log('[cta] no same-brand substitute in stock for ' + JSON.stringify(name) + ' (searched ' + JSON.stringify(q) + ': ' + prods.map(x => x.name).join(' | ') + ')'); return null; }
    const sub = { name: String(p.name).replace(/\s*-\s*[\d.]+\s*(ML|L|OZ)\s*$/i, ''), size: p.sizeStr || p.size || ((String(p.name).match(/[\d.]+\s*(?:ML|L|OZ)\s*$/i) || [''])[0]).replace(/ML$/i, 'mL'), price: parseFloat(p.salePrice || p.price) || 0 };
    console.log('[cta] substitute for ' + JSON.stringify(name) + ': ' + sub.name + ' ' + sub.size + ' $' + sub.price);
    return sub.price > 0 ? sub : null;
  } catch (e) { console.log('[cta] substitute lookup failed for ' + JSON.stringify(name) + ': ' + e.message); return null; }
  finally { clearTimeout(tm); }
}

async function callRachel({ sessionKey, message, context, format, gbrainContext, addressRule, email, onProposalGenerated, alreadyConfirmed }) {
  events.note({ handled_by: 'llm' });   // event log: the LLM wrote this turn's reply
  const messages = sessions[sessionKey] || [];
  let channelNote = getChannelNote(format);
  const stateForEmail = getState(sessionKey);
  // Several instructions in one message: tell the LLM the checklist, then check the reply (below).
  stateForEmail.currentUserMessage = message;   // read by applyBasketSubstitute's cross-type check (same-turn instructions)
  const instrs = require('./instructions.js').splitInstructions(message);
  let basketBefore = []; try { basketBefore = JSON.parse(stateForEmail.lastLineItems || '[]'); } catch (e) {}
  if (instrs.length) {
    console.log('[instructions] ' + instrs.length + ' in one message: ' + JSON.stringify(instrs));
    const work = basketBefore.map(it => Object.assign({}, it));
    const done = require('./instructions.js').applyCountInstructions(instrs, work);
    if (done.length) { stateForEmail.lastLineItems = JSON.stringify(work); saveFlowState(); try { saveBasket(email, stateForEmail.lastLineItems, '', format || 'slack').catch(() => {}); } catch (e) {} }
    channelNote += '\n\nThe customer\'s message has ' + instrs.length + ' separate instructions:\n' + instrs.map((x, i) => { const d = done.find(z => z.instr === x); return (i + 1) + '. ' + x + (d ? '  [You just changed this in the basket: ' + d.name + ' from ' + d.from + ' to ' + d.to + '. Tell the customer you updated it from ' + d.from + ' to ' + d.to + ' (never "already set" or "no change needed"); do not change it again]' : ''); }).join('\n') + '\nHandle EVERY one this turn — apply it, or ask the question you need to apply it. Never skip one.';
  }
  const result = await rachelChat({
    messages: [...messages, { role: 'user', content: message }],
    context,
    rachelPrompt: RACHEL_PROMPT,
    gbrain_context: gbrainContext || '',
    address_rule: addressRule + channelNote,
    channel_format: format,
    onProposalGenerated: onProposalGenerated || null,
    currentLineItems: stateForEmail.lastLineItems || '',
    eventParams: stateForEmail.eventParams || null,
    sessionState: stateForEmail,
    customerMessage: message,
    alreadyConfirmed: alreadyConfirmed || false,
    sendEmailFn: sendEmail,
    lastProposalUrl: stateForEmail.lastProposalUrl || '',
    // A placed order leaves the active cart. Real bug: after "Your order has been placed",
    // the basket stayed live — "what's in my cart?" showed the ordered items and "place the
    // order" started checkout for them again (a duplicate order). Fired only on a real
    // place_order success (rachel.js); the items are kept on placedOrder so the customer
    // can reopen the order (see PLACED ORDER below) — they may not have paid yet.
    onOrderPlaced: (result, lineItems) => recordPlacedOrder(sessionKey, email, format, result, lineItems),
    onPackageBuilt: (em, lineItems, fmt, saInput, saResult) => {
      // Full-bar note (DC: keep one bottle of each spirit type, but tell the customer when that's
      // more than they need). Appended to this turn's reply in code — not left to the LLM.
      try { if (saResult && saResult.full_bar_note) { getState(sessionKey).replyNote = saResult.full_bar_note; } } catch (e) {}
      // The totals of the latest build this turn, so the reply always shows them (see [reply] totals below).
      try { if (saResult && saResult.product_total) { getState(sessionKey).builtTotals = { pt: saResult.product_total, tax: saResult.estimated_tax, svc: saResult.estimated_service, tip: saResult.estimated_tip, del: saResult.delivery_fee, grand: saResult.estimated_grand_total, budget: saInput && saInput.budget, lineItems: saResult.line_items }; } } catch (e) {}
      // A successful build supersedes any prior "unavailable" state. Real bug: two
      // beers were falsely flagged unavailable on one rebuild (stale pendingSubstitutes
      // entries), then restored fine on the NEXT rebuild — but the pending list was
      // never cleared. A later, unrelated bitters swap then fell into the regex merge
      // block, which "replaced Stella Artois" with the bitters and knocked the beer out
      // of the basket ("4x 3x Angostura ... has replaced Stella Artois 24x12 Oz").
      try {
        const stPS = getState(sessionKey);
        if (stPS.pendingSubstitutes && stPS.pendingSubstitutes.length) {
          console.log('[package-built] clearing stale pendingSubstitutes:', JSON.stringify(stPS.pendingSubstitutes));
          stPS.pendingSubstitutes = []; // fresh build supersedes prior unavailable state
        }
      } catch (e) {}
      // Persist the event parameters alongside the basket. Real bug: after a service
      // restart the LLM's conversation memory (sessions[]) was gone, and "budget is now
      // $2,500, everything else is the same" got "I don't have the details from a
      // previous build" — the basket had survived (flowState on disk) but guests/hours/
      // categories had not. Storing them here and injecting them each turn (see
      // ## EVENT PARAMETERS below) lets a single-parameter change rebuild without re-asking.
      try {
        if (saInput && (saInput.guests || saInput.hours || saInput.budget)) {
          const st = getState(sessionKey);
          // MERGE into existing params — never overwrite a known value with null. Real
          // bug: a budget-only rebuild (no guests/hours on the call) succeeded as a tool
          // call, so this fired and REPLACED guests=150/hours=3 with nulls, poisoning
          // the persisted state for every subsequent rebuild.
          const prev = st.eventParams || {};
          const merged = Object.assign({}, prev);
          const isInitial = !prev.guests;                 // first real build: capture everything
          const pc = saInput._paramChange || null;         // explicit customer param change
          // Guests/hours are only ever set from (a) the initial customer-driven build or
          // (b) a field the customer explicitly changed. A reconstructed rebuild — where
          // the LLM re-typed values from memory — never touches them. Real bug: a
          // hallucinated menu_build with guests=50 overwrote the customer's 150 and
          // poisoned every later rebuild.
          if (isInitial) {
            if (saInput.guests) merged.guests = saInput.guests;
            if (saInput.hours) merged.hours = saInput.hours;
            if (saInput.drinks_per_person) merged.drinks_per_person = saInput.drinks_per_person;
            if (saInput.categories) merged.categories = saInput.categories;
            if (saInput.intent) merged.intent = saInput.intent;
            if (saInput.named_products && saInput.named_products.length) merged.named_products = JSON.stringify(saInput.named_products);
          } else if (pc) {
            if (pc.guests) merged.guests = pc.guests;
            if (pc.hours) merged.hours = pc.hours;
          }
          // Budget follows the latest explicit value (initial, or a customer change).
          if (isInitial || (pc && pc.budget)) { if (saInput.budget) merged.budget = saInput.budget; }
          st.eventParams = merged;
          saveFlowState();
        }
      } catch (e) {}
      const state = getState(sessionKey);
      const key = makeCacheKey(em || email, state.zip, state.lastFingerprint);
      packageCache[key] = lineItems;
      state.lastLineItems = lineItems;
      saveFlowState();
      console.log('[package] L1 cached:', key);
      const caps = getCapabilities(fmt || format);
      if (caps.can_add_to_cart) {
        try { saveBasket(em || email, lineItems, '', fmt || format).catch(() => {}); } catch(e) {}
      } else {
        console.log('[package] cart persistence skipped (can_add_to_cart disabled for channel):', fmt || format);
      }
    },
    onUnavailableItems: (unavailableStr) => {
      try { events.unmatched(String(unavailableStr || '').split(/\s*[,;\n]\s*/).map(x => x.replace(/^[-•*\s]+/, '')).filter(x => x.length > 1)); } catch (e) {}
      // Real bug found tonight: this used to REPLACE the entire pendingSubstitutes
      // list on every call, including calls that had nothing to do with the original
      // substitution search — e.g. the LLM's own follow-up "let me search for gin
      // alternatives" product_query succeeds (unavailable: ""), which was silently
      // WIPING OUT tracking of a still-unresolved item (like DeKuyper Triple Sec)
      // before the customer ever got a chance to confirm their pick for it. Merge/
      // union new unavailable items into the EXISTING list instead of replacing it —
      // an item should only ever be cleared from pendingSubstitutes by the merge step
      // actually resolving it, never as a side effect of a different, unrelated
      // search happening to succeed.
      const state = getState(sessionKey);
      const newItems = (unavailableStr || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      const existing = state.pendingSubstitutes || [];
      const merged = [...existing];
      for (const item of newItems) {
        if (!merged.some(e => e.toLowerCase() === item.toLowerCase())) merged.push(item);
      }
      state.pendingSubstitutes = merged;
      saveFlowState();
      if (state.pendingSubstitutes.length > 0) {
        console.log('[substitute-tracking] pending:', state.pendingSubstitutes.join(', '));
      }
    },
    onProductDiscussed: (em, lineItems, fmt) => {
      // Remember the products just SHOWN (real catalog names, ids, prices), separately from the
      // basket, so a pick from Rachel's list resolves to the product actually offered even when
      // the LLM displayed a tidied name ("Kendall-Jackson Vintner's Reserve Pinot Noir" for the
      // catalog's "Kendall Jackson Pinot Noir Vint Rs"). Searches in the same turn accumulate.
      try {
        const stS = getState(sessionKey); const now = Date.now();
        const prev = (stS.lastShownAt && now - stS.lastShownAt < 120000) ? JSON.parse(stS.lastShownProducts || '[]') : [];
        const add = JSON.parse(lineItems || '[]');
        const seenS = new Set(prev.map(x => x.product_id || x.name));
        stS.lastShownProducts = JSON.stringify(prev.concat(add.filter(x => !seenS.has(x.product_id || x.name))).slice(-60));
        stS.lastShownAt = now;
      } catch (e) {}
      // Separate from onPackageBuilt on purpose — a real, severe bug found tonight:
      // treating EVERY product_query/recommendation result as "the new active order"
      // (the old behavior) meant a narrow "here are 2 gin options to pick from" search
      // during mid-order substitution silently REPLACED the customer's entire ~20-item
      // order with just those 2 options, which then became the actual order sent to
      // place_order — while Rachel's own displayed "here's your updated full order" text
      // (pure LLM narration from conversation memory, no real merge ever happened) looked
      // completely correct to the customer even though the real saved state was wrong.
      //
      // Only allow this to become the active order when there ISN'T already a substantive
      // basket in progress — this is what the original fix was actually meant to handle: a
      // simple "do you have Opus One" -> "yes" -> "place the order" flow starting from
      // nothing. If a real multi-item order already exists, skip the overwrite entirely and
      // leave it alone — safer to require the customer to explicitly resolve a pending
      // substitution than to silently destroy 18 correct items.
      const state = getState(sessionKey);
      let existingCount = 0;
      try { existingCount = JSON.parse(state.lastLineItems || '[]').length; } catch (e) {}
      if (existingCount > 0) {
        console.log('[product-discussed] SKIPPED overwrite — existing basket has', existingCount, 'item(s), narrow search result not saved as active order');
        return;
      }
      // A multi-option pick list is NOT an order. Real bug: "need a KJ Chardonnay and
      // a 12-pack Corona" returned 5 candidates (two KJ sizes, two Corona sizes, Corona
      // Light); all 5 were captured as the basket, the customer's pick of two was only
      // narrated, and the order placed with all five (\$215 instead of ~\$60). Only
      // auto-capture an unambiguous result: at most one candidate per requested item.
      try {
        const arr = JSON.parse(lineItems || '[]');
        const byLabel = {};
        arr.forEach(it => { const k = String(it.label || it.name || '').toLowerCase(); byLabel[k] = (byLabel[k] || 0) + 1; });
        const hasMultiPerRequest = Object.values(byLabel).some(n => n > 1);
        // Stricter: ANY multi-result search is a pick list, never an order. The label-
        // based check missed 3 distinct-name Kim Crawford options (no shared label,
        // not >3), captured all three, and the order shipped with four items.
        if (hasMultiPerRequest || arr.length > 1) {
          console.log('[product-discussed] SKIPPED capture — multi-option pick list (' + arr.length + ' candidates), waiting for the customer to choose');
          return;
        }
      } catch (e) {}
      const key = makeCacheKey(em || email, state.zip, state.lastFingerprint);
      packageCache[key] = lineItems;
      state.lastLineItems = lineItems;
      saveFlowState();
      console.log('[product-discussed] captured as active context (no prior basket):', key);
      events.note({ discussed_capture: true });   // a search result held as context — not a basket change the customer made (cta.js)
    },
    // show_basket: return the AUTHORITATIVE current basket. Real gap found: the LLM had
    // no way to READ state.lastLineItems — "show me the basket" only ever worked when
    // the basket happened to still be in the LLM's recent context. After a swap via
    // confirm_substitute (a state change the LLM doesn't see as line items), its memory
    // went stale and it fell back to order history, telling the customer it "can't
    // display the basket." This is the same authoritative source place_order and
    // generate_proposal now use, formatted like a package summary.
    // update_quantity: set the qty of one or more existing basket items. Real bug: the
    // customer said "reduce the beers to 6 cases total", confirmed "yes" three times,
    // and Rachel just re-asked for confirmation each time — there was no tool to change
    // a quantity (confirm_substitute replaces a product; custom_list rebuilds everything),
    // so she had nothing to call. Accepts a list so a split ("3 Stella + 3 Corona") is
    // one call. Matches items by name substring (case-insensitive); qty 0 removes.
    onUpdateQuantity: (updates) => {
      try {
        const state = getState(sessionKey);
        let items = [];
        try { items = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
        if (!items.length) return { success: false, error: 'No active basket' };
        const list = Array.isArray(updates) ? updates : [];
        const applied = [], notFound = [];
        for (const u of list) {
          const want = String((u && u.item) || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
          const qty = parseInt(u && u.qty);
          if (!want || isNaN(qty) || qty < 0) { notFound.push(String((u && u.item) || '?')); continue; }
          // Best match: the item whose name contains the most words of the request.
          const wantWords = want.split(' ').filter(w => w.length > 1);
          let best = -1, bestScore = 0;
          items.forEach((it, i) => {
            const nm = String(it.name || it.label || '').toLowerCase();
            const score = wantWords.filter(w => nm.indexOf(w) >= 0).length;
            if (score > bestScore) { bestScore = score; best = i; }
          });
          if (best < 0 || bestScore === 0) { notFound.push(u.item); continue; }
          const it = items[best];
          const before = it.qty || it.quantity || 1;
          if (qty === 0) { items.splice(best, 1); applied.push(it.name + ': removed'); }
          else { it.qty = qty; it.quantity = qty; applied.push(it.name + ': ' + before + ' -> ' + qty); }
        }
        const newLineItems = JSON.stringify(items);
        const key3 = makeCacheKey(email, state.zip, state.lastFingerprint);
        packageCache[key3] = newLineItems;
        state.lastLineItems = newLineItems;
        saveFlowState();
        console.log('[update-quantity]', JSON.stringify(applied), notFound.length ? '| not found: ' + JSON.stringify(notFound) : '');
        const total = items.reduce((s, li) => s + (li.qty || li.quantity || 1) * (parseFloat(li.price) || 0), 0);
        return { success: true, applied, not_found: notFound, line_items: newLineItems, product_total: total.toFixed(2) };
      } catch (e) { return { success: false, error: e.message }; }
    },
    onShowBasket: () => {
      try {
        const state = getState(sessionKey);
        let items = [];
        try { items = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
        // Self-heal duplicates left by earlier sessions: collapse lines sharing a
        // product_id (or normalized name) by summing quantities, and persist.
        {
          const seen = new Map(); const merged = [];
          const nk = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          for (const it of items) {
            const k = it.product_id || ('n:' + nk(it.name));
            if (seen.has(k)) { const ex = seen.get(k); ex.qty = (ex.qty || ex.quantity || 1) + (it.qty || it.quantity || 1); ex.quantity = ex.qty; }
            else { seen.set(k, it); merged.push(it); }
          }
          if (merged.length !== items.length) {
            console.log('[show-basket] collapsed', items.length - merged.length, 'duplicate line(s)');
            items = merged; state.lastLineItems = JSON.stringify(items); saveFlowState();
          }
        }
        if (!items.length) return { success: true, empty: true, line_items: '[]', line_items_display: '', product_total: '0.00' };
        const disp = items.map(li => {
          const qty = li.qty || li.quantity || 1, price = parseFloat(li.price) || 0;
          return qty + 'x ' + String(li.name || li.label || '').replace(/ \*$/, '') + (li.size ? ' \u2014 ' + li.size : '') + ' \u2014 $' + price.toFixed(2) + ' ea = $' + (qty * price).toFixed(2);
        });
        const total = items.reduce((s, li) => s + (li.qty || li.quantity || 1) * (parseFloat(li.price) || 0), 0);
        return { success: true, empty: false, line_items: JSON.stringify(items), line_items_display: disp.join('\n'), product_total: total.toFixed(2), item_count: items.length };
      } catch (e) { return { success: false, error: e.message }; }
    },
    onSubstituteConfirmed: async (originalItem, replacementName, replacementPrice, replacementSize) => applyBasketSubstitute(sessionKey, email, originalItem, replacementName, replacementPrice, replacementSize)
  });
  sessions[sessionKey] = result.messages;
  const out = scrubDisabledOffers(formatResponse(result.response, format), format);
  let numbered = require('./multipick.js').numberOptionLines(out);
  if (numbered !== out) console.log('[reply] numbered an unnumbered options list (LLM left it bare) so a "3" can pick from it');
  if (instrs.length) {
    let basketAfter = []; try { basketAfter = JSON.parse(getState(sessionKey).lastLineItems || '[]'); } catch (e) {}
    const missed = require('./instructions.js').unaddressed(instrs, numbered, basketBefore, basketAfter);
    if (missed.length) {
      console.log('[instructions] UNADDRESSED by the reply — asked about, not dropped: ' + JSON.stringify(missed));
      numbered += '\n\nI haven\'t done ' + (missed.length === 1 ? 'this one' : 'these') + ' yet:\n' + missed.map(x => '• ' + x).join('\n') + '\nWant me to go ahead' + (missed.length === 1 ? '' : ' with ' + (missed.length === 2 ? 'both' : 'all of them')) + '?';
    } else console.log('[instructions] all ' + instrs.length + ' handled');
  }
  return numbered;
}

// ── POST /chat ─────────────────────────────────────────────────────────────
const REQUEST_REPLIES = new Map();   // session|request_id -> { at, payload, done } (idempotent retries; see /chat)
app.post('/chat', async (req, res) => {
  // `let`, not `const`: the proposal flow re-dispatches into the date handler by
  // reassigning `message = state.savedEventDate` when client+date are already saved.
  // As a const this threw "Assignment to constant variable" at runtime — a TypeError
  // that node --check cannot catch — on exactly the path where both were remembered.
  let { message, context, gbrain_context, session_id, format = 'markdown', skip_gbrain = false, images = null } = req.body;
  // Photos / scans of an order (from WhatsApp media or Slack file uploads): transcribe
  // with vision, show the customer what was read, and run the list through the normal
  // pipeline (age/address gating and the custom_list build all apply unchanged).
  // QA DRY-RUN: a session id starting with 'qa-' (or qa:true) never places real orders
  // or sends real email — place_order and SendEmail simulate success. Everything else
  // (search, builds, proposals) runs for real so tests exercise the actual catalog.
  const isQA = !!(req.body.qa) || /^qa-/i.test(String(session_id || '')) || /^(qa-[^@]*|rachel_qa)@getbevvi\.com$/i.test(String((context && context.user_email) || ''));   // QA identities are dry-run on EVERY channel
  // IDEMPOTENT RETRY: a caller's request_id (email: the Gmail message id) runs ONCE per session. Real bug
  // (Sep 29): Sean's email timed out on the agent's side while Rachel finished; the retry fed the same email
  // into the session again and Rachel replied to it as edits ("couldn't find 1x Oyster Bay"). A repeat gets
  // the first run's reply — waiting for it if it's still running.
  const reqId = req.body.request_id ? String(session_id || '') + '|' + String(req.body.request_id) : '';
  if (reqId) {
    const prev = REQUEST_REPLIES.get(reqId);
    if (prev) {
      console.log('[request] repeat of ' + reqId + ' — ' + (prev.payload ? 'returning the stored reply' : 'waiting for the first run') + ', not running it again');
      // The first run may have crashed without replying: wait at most 4 min, then run it fresh (logged).
      const payload = prev.payload || await Promise.race([prev.done, new Promise(r => setTimeout(() => r(null), 240e3))]);
      if (payload) return res.json(payload);
      console.log('[request] first run of ' + reqId + ' never replied — running it again');
      REQUEST_REPLIES.delete(reqId);
    }
    let resolveDone; const entry = { at: Date.now(), payload: null, done: new Promise(r => { resolveDone = r; }) };
    REQUEST_REPLIES.set(reqId, entry);
    for (const [k, v] of REQUEST_REPLIES) if (Date.now() - v.at > 6 * 3600e3) REQUEST_REPLIES.delete(k);
    const _jR = res.json.bind(res);
    res.json = (payload) => { entry.payload = payload; resolveDone(payload); return _jR(payload); };
  }
  let imagePrefix = '';
  if (Array.isArray(images) && images.length) {
    const caption = String(message || '').trim();
    const t = await transcribeOrderImages(images, caption);
    console.log('[vision] is_order=' + t.is_order + ' lines=' + (t.list ? t.list.split('\n').length : 0) + ' | ' + t.note);
    if (t.is_order) {
      message = t.list + (caption && !/^(here|this is|my order|order|list|photo|image)/i.test(caption) ? '\n' + caption : '');
      imagePrefix = 'From your photo I read:\n' + t.list + '\n\n(Tell me if anything\'s off.)\n\n';
    } else {
      const rNI = 'I looked at the photo but didn\'t see a drinks list to order from' + (t.note ? ' — ' + t.note : '') + '. Send a photo of a written or printed list and I\'ll build it, or just type what you\'d like.';
      return res.json({ text: rNI, response: rNI });
    }
  }
  if (imagePrefix) { const _j0 = res.json.bind(res); res.json = (payload) => { try { if (payload && typeof payload.text === 'string') { payload.text = imagePrefix + payload.text; payload.response = imagePrefix + (payload.response || ''); } } catch (e) {} return _j0(payload); }; }

  if (!message) return res.status(400).json({ error: 'message required' });

  // EMAIL: act on the new text (+ a forwarded message), never the quoted history below it (email-body.js).
  // Real case (Sep 29, Gen II Fund): a forwarded edit request also carried the customer's ORIGINAL order list.
  if (/^email-/.test(String(session_id || '')) || (context && context.email_subject)) {
    const eb = require('./email-body.js').latest(message);
    if (eb.trimmed) { console.log('[email-body] ' + (eb.forwarded ? 'forwarded message kept, ' : '') + 'quoted history cut: ' + String(message).length + ' -> ' + eb.text.length + ' chars'); message = eb.text; }
  }

  if (context && context.kitchen_location && KITCHEN_TO_CLIENT[context.kitchen_location]) {
    context.client_id = KITCHEN_TO_CLIENT[context.kitchen_location];
  }

  console.log(`[rachel] format: ${format} session: ${session_id}`);
  console.log(`[rachel] context:`, JSON.stringify({ kitchen_location: context?.kitchen_location, client_id: context?.client_id, user_email: context?.user_email }));

  const sessionKey = session_id || `${context?.account_id || 'anon'}-${context?.kitchen_location || 'noloc'}`;
  const _originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      const outText = body && (body.text || body.response);
      if (outText && sessionKey) {
        if (!lastRepliesBySession[sessionKey]) lastRepliesBySession[sessionKey] = [];
        lastRepliesBySession[sessionKey].push(outText);
        if (lastRepliesBySession[sessionKey].length > 6) lastRepliesBySession[sessionKey].shift();
      }
      scheduleChatSessionsSave();   // the history is complete by now (recordTurn wraps outside this)
    } catch (e) {}
    return _originalJson(body);
  };
  if (!sessions[sessionKey]) sessions[sessionKey] = [];

  const email = context?.user_email || '';
  const isD2C = !context?.kitchen_location;
  // Email sessions remember who wrote and the subject, so a later NEW thread (a forward) can be linked back
  // to this quote (/internal/email-link, email-link.js).
  if (/^email-/.test(String(sessionKey)) || (context && context.email_subject)) {
    const stE = getState(sessionKey);
    if (email) stE.userEmail = String(email).toLowerCase();
    if (context && context.email_subject && !stE.emailSubject) stE.emailSubject = String(context.email_subject);   // the FIRST subject names the client; a forward's ("Fwd: ... - Drinks order") doesn't
  }

  // IDLE EXPIRY: a conversation ends after IDLE_HOURS of silence and the next message starts
  // fresh, exactly as if the customer had typed "reset". Real complaint: flowState lives on
  // disk and never expired, so a customer coming back hours or days later landed in an old
  // basket / half-finished order and had to type "reset" before every use. The age gate is
  // asked again on the new conversation (compliance: per session), and a substantive first
  // message is kept through it (pendingIntent). Email is exempt: the thread IS the
  // conversation, and a reply days later continues it on purpose.
  {
    const st0 = flowState[sessionKey];
    const idleH = st0 && st0.lastActive ? (Date.now() - st0.lastActive) / 3600000 : 0;
    const forced = isQA && req.body.simulate_idle && st0;   // QA: test the expiry without waiting
    if (st0 && message !== '__greeting__' && !/^email-/.test(sessionKey) && (idleH > IDLE_HOURS || forced)) {
      console.log(`[session] idle ${forced ? '(simulated)' : idleH.toFixed(1) + 'h'} > ${IDLE_HOURS}h — fresh conversation for ${sessionKey} (was step=${st0.step}${st0.orderStep ? ' orderStep=' + st0.orderStep : ''}${st0.proposalStep ? ' proposalStep=' + st0.proposalStep : ''})`);
      resetState(sessionKey, email);
    }
    getState(sessionKey).lastActive = Date.now(); saveFlowState();
  }
  // EVENT LOG (events.js): one line per turn to logs/events.jsonl. Installed before the other reply
  // wrappers so it sees the final text; state_in is taken after the idle reset.
  {
    const evSt0 = getState(sessionKey), evIn = events.stateLabel(evSt0), evBasket0 = events.basketOf(evSt0);
    if (events.ctx()) events.ctx().basket0 = evBasket0;
    const _jE = res.json.bind(res);
    res.json = (payload) => {
      try { if (message !== '__greeting__') events.finish({ st: flowState[sessionKey], stateIn: evIn, basketBefore: evBasket0, sessionKey, format, context, email, isQA, reply: payload && (payload.text || payload.response) }); } catch (e) {}
      return _jE(payload);
    };
  }
  // A note produced while building this turn (e.g. the full-bar note) is added to the reply — before a
  // closing question ("Would you also like to add mixers…?") so that question stays last.
  { const _jN = res.json.bind(res); res.json = (payload) => { try { const stN = flowState[sessionKey]; if (stN && stN.replyNote && payload && typeof payload.text === 'string') { console.log('[reply] appended note: ' + stN.replyNote.slice(0, 80)); const addNote = (t) => { const paras = String(t || '').trimEnd().split(/\n\s*\n/); if (paras.length > 1 && /\?\s*\**\s*$/.test(paras[paras.length - 1])) paras.splice(paras.length - 1, 0, stN.replyNote); else paras.push(stN.replyNote); return paras.join('\n\n'); }; payload.text = addNote(payload.text); payload.response = addNote(payload.response || ''); stN.replyNote = null; saveFlowState(); } } catch (e) {} return _jN(payload); }; }

  console.log(`[rachel] chat — session: ${sessionKey} messages: ${sessions[sessionKey].length} — "${message}"`);

  try {
    // ── B2B flow (kitchen_location set) — pass straight to Rachel ─────────
    if (!isD2C) {
      let gbrainContext = '';
      if (email) {
        gbrainContext = await getCustomerContext(context.account_id || context.client_id, context.kitchen_location, context.client_id, email);
      }
      const result = await rachelChat({
        messages: [...sessions[sessionKey], { role: 'user', content: message }],
        context,
        rachelPrompt: RACHEL_PROMPT,
        gbrain_context: skip_gbrain ? gbrain_context : (gbrainContext || gbrain_context || ''),
        address_rule: '',
        channel_format: format,
        onPackageBuilt: (em, lineItems, fmt, saInput) => {
      // A successful build supersedes any prior "unavailable" state. Real bug: two
      // beers were falsely flagged unavailable on one rebuild (stale pendingSubstitutes
      // entries), then restored fine on the NEXT rebuild — but the pending list was
      // never cleared. A later, unrelated bitters swap then fell into the regex merge
      // block, which "replaced Stella Artois" with the bitters and knocked the beer out
      // of the basket ("4x 3x Angostura ... has replaced Stella Artois 24x12 Oz").
      try {
        const stPS = getState(sessionKey);
        if (stPS.pendingSubstitutes && stPS.pendingSubstitutes.length) {
          console.log('[package-built] clearing stale pendingSubstitutes:', JSON.stringify(stPS.pendingSubstitutes));
          stPS.pendingSubstitutes = []; // fresh build supersedes prior unavailable state
        }
      } catch (e) {}
      // Persist the event parameters alongside the basket. Real bug: after a service
      // restart the LLM's conversation memory (sessions[]) was gone, and "budget is now
      // $2,500, everything else is the same" got "I don't have the details from a
      // previous build" — the basket had survived (flowState on disk) but guests/hours/
      // categories had not. Storing them here and injecting them each turn (see
      // ## EVENT PARAMETERS below) lets a single-parameter change rebuild without re-asking.
      try {
        if (saInput && (saInput.guests || saInput.hours || saInput.budget)) {
          const st = getState(sessionKey);
          // MERGE into existing params — never overwrite a known value with null. Real
          // bug: a budget-only rebuild (no guests/hours on the call) succeeded as a tool
          // call, so this fired and REPLACED guests=150/hours=3 with nulls, poisoning
          // the persisted state for every subsequent rebuild.
          const prev = st.eventParams || {};
          const merged = Object.assign({}, prev);
          const isInitial = !prev.guests;                 // first real build: capture everything
          const pc = saInput._paramChange || null;         // explicit customer param change
          // Guests/hours are only ever set from (a) the initial customer-driven build or
          // (b) a field the customer explicitly changed. A reconstructed rebuild — where
          // the LLM re-typed values from memory — never touches them. Real bug: a
          // hallucinated menu_build with guests=50 overwrote the customer's 150 and
          // poisoned every later rebuild.
          if (isInitial) {
            if (saInput.guests) merged.guests = saInput.guests;
            if (saInput.hours) merged.hours = saInput.hours;
            if (saInput.drinks_per_person) merged.drinks_per_person = saInput.drinks_per_person;
            if (saInput.categories) merged.categories = saInput.categories;
            if (saInput.intent) merged.intent = saInput.intent;
            if (saInput.named_products && saInput.named_products.length) merged.named_products = JSON.stringify(saInput.named_products);
          } else if (pc) {
            if (pc.guests) merged.guests = pc.guests;
            if (pc.hours) merged.hours = pc.hours;
          }
          // Budget follows the latest explicit value (initial, or a customer change).
          if (isInitial || (pc && pc.budget)) { if (saInput.budget) merged.budget = saInput.budget; }
          st.eventParams = merged;
          saveFlowState();
        }
      } catch (e) {}
          packageCache[(em || email) + ':b2b'] = lineItems;
        }
      });
      sessions[sessionKey] = result.messages;
      return res.json({ text: formatResponse(result.response, format), response: formatResponse(result.response, format) });
    }

    // ── D2C flow — state machine ───────────────────────────────────────────
    const state = getState(sessionKey);
    let msgLower = message.toLowerCase().trim().replace(/\*/g, '').replace(/_/g, '');

    // Capture a mentioned quantity from ANY message (e.g. "need a bottle of opus", "get me
    // 2 bottles") and persist it on state, since the actual "how many bottles?" question may
    // come several turns later (after address confirmation, after choosing order vs proposal,
    // etc.) by which point the original message's wording is no longer available to parse.
    (function captureQty() {
      const wordToNumQ = { 'a': 1, 'an': 1, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
        'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10 };
      const digitMatchQ = message.match(/\b(\d+)\s*(bottle|bottles|case|cases|pack|packs)\b/i);
      if (digitMatchQ) {
        state.lastDetectedQty = parseInt(digitMatchQ[1]);
        return;
      }
      const wordMatchQ = msgLower.match(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+bottle/);
      if (wordMatchQ) state.lastDetectedQty = wordToNumQ[wordMatchQ[1]];
    })();
    const yesWords = ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'correct', 'confirmed', 'use it', 'go ahead', 'absolutely', 'i am', 'i\'m over', 'over 21'];
    const noWords = ['no', 'nope', 'not yet', 'i\'m not', 'im not', 'under 21'];

    // ── GREETING ──────────────────────────────────────────────────────────
    if (message === '__greeting__') {
      resetState(sessionKey, email);
      const s = getState(sessionKey);

      // Load D2C session
      if (email) {
        try {
          const d2c = await getD2CSession(email);
          if (d2c) {
            // COMPLIANCE: age verification is per-session and per-person. Never inherit it
            // from a saved profile (invited users are bound to another account's email).
            s.ageVerified = false;
            // Do NOT inherit the profile's delivery address either — each user sets their own.
            s.zip = '';
            s.address = '';
          }
        } catch(e) {}
      }

      let greet = "Hi! I\'m Rachel, your personal beverage specialist. I can help you find the perfect wines, spirits, and beers for any occasion.\n\n";

      const capsGreet = getCapabilities(format);
      if (s.ageVerified || !capsGreet.requires_age_verification) {
        s.zip = s.zip || '';
        if (s.address && capsGreet.mention_saved_address) {
          // Don't auto-confirm — let the existing 'addr' state ask to confirm,
          // check store coverage, and replay the customer's first real request.
          s.addrConfirmed = false;
        } else {
          s.addrConfirmed = !!s.address;
        }
        if (s.ageVerified && capsGreet.requires_age_verification) {
          greet += '\u2713 Age verified.\n\n';
        }
        // Ask for the delivery address up front (business decision): every later search
        // is then scoped to the right store/client, and the customer isn't interrupted
        // mid-request. The existing 'addr' / 'addr_new' handlers take the answer, check
        // coverage, and reply "Got it! Delivering to X. How can I help you today?". If
        // the customer types a product request here instead, those handlers stash it
        // as pendingIntent and replay it once the address is confirmed.
        if (s.address && capsGreet.mention_saved_address) {
          s.step = 'addr';
          greet += 'I have your delivery address on file as ' + s.address + ' \u2014 shall I use this for your order?';
        } else if (s.address) {
          s.step = 'ready';
          greet += 'How can I help you today?';
        } else {
          s.step = 'addr_new';
          greet += 'What is your delivery address? (Include street, city, state, and zip)';
        }
      } else {
        s.step = 'age';
        greet += 'Before we get started — are you 21 or older?';
      }

      return res.json({ text: greet, response: greet });
    }

    // ── Load D2C session if not already loaded ─────────────────────────────
    if (!state.zip && email) {
      try {
        const d2c = await getD2CSession(email);
        if (d2c) {
          // COMPLIANCE: do not inherit age verification from the saved profile.
          state.ageVerified = state.ageVerified || false;
          // Do not inherit the saved address; the user sets their own this session.
        }
      } catch(e) {}
    }

    // ── Order history bypass ──────────────────────────────────────────────
    // "What did I buy before/yesterday/last time" etc. doesn't need delivery address
    // or age re-verification — it's a read-only lookup keyed by email. Intercept it
    // before the onboarding gate so it isn't blocked behind "what's your zip code".
    // Route to the LLM (not a hardcoded reply) so relative date phrases like
    // "yesterday" or "last week" get parsed naturally and passed as since/until
    // to the order_history tool, rather than always returning the last 5 orders.
    const orderHistoryTriggers = ['what did i buy', 'what did i order', 'my past order', 'my previous order',
      'my order history', 'order history', 'my last order', 'reorder', 'buy before', 'ordered before',
      'purchase history', 'my purchases', 'did i ever buy', 'did i ever order', 'did i buy', 'did i order',
      'have i bought', 'have i ordered', 'have i purchased', 'have i ever bought', 'have i ever ordered'];
    if (email && orderHistoryTriggers.some(t => msgLower.includes(t))) {
      const today = new Date().toISOString().split('T')[0];
      const gbrainContextOH = await getCustomerContext('', '', context?.client_id || 'airculinaire', email).catch(() => '');
      const addressRuleOH = `\n\n## DELIVERY ADDRESS\nZip: ${state.zip}. Address: ${state.address}. NEVER ask about address or age for an order-history lookup — this is a read-only question, not an order.\n\n## AGE\nCustomer is verified 21+. Never ask for age.\n\n## TODAY'S DATE\n${today} — use this to compute since/until ISO dates for relative phrases like "yesterday", "last week", "this month" when calling ShoppingAgent intent="order_history".`;
      const outputOH = await callRachel({ sessionKey, message, context, format, gbrainContext: gbrainContextOH, addressRule: addressRuleOH, email });
      return res.json({ text: outputOH, response: outputOH });
    }

    // ── STATE: age ─────────────────────────────────────────────────────────
    const AGE_BYE = 'I\'m sorry, I can only assist customers who are 21 or older. Have a great day!';
    if (state.ageRefusedAt && Date.now() - state.ageRefusedAt < 24 * 3600 * 1000 && getCapabilities(format).requires_age_verification) {
      // COMPLIANCE: a refusal sticks — "no" then "yes" (or "actually I'm 22") never passes.
      console.log('[age] refused earlier in this session — still refusing: ' + JSON.stringify(message).slice(0, 60));
      return res.json({ text: AGE_BYE, response: AGE_BYE });
    }
    if (state.step === 'age') {
      const capsAge = getCapabilities(format);
      const age = parseAgeAnswer(message);
      if (!capsAge.requires_age_verification) {
        state.step = state.address ? 'ready' : 'addr_new';
      } else if (state.ageVerified) {
        state.step = state.address ? 'ready' : 'addr_new';
      } else if (age.answer === 'yes') {
        console.log('[age] verified (' + age.why + '): ' + JSON.stringify(message).slice(0, 60));
        state.ageVerified = true;
        state.step = state.address ? 'ready' : 'addr_new';
        // Save to GBrain
        if (email) {
          try {
            const d2c = await getD2CSession(email) || {};
            await saveD2CSession(email, Object.assign({}, d2c, { age_verified: true, onboarded: true }));
          } catch(e) {}
        }
        // The yes may carry the whole request ("yes I'm over 21, deliver to 425 W 53rd St, NY
        // 10019, I need 2 Tito's"). Real bug: the entire sentence was stored as the ADDRESS and
        // the items were dropped. Keep the rest as the pending request; the address extraction
        // below pulls an address out of it, and the rest replays once the address is in.
        const rest = stripAgeAnswer(message);
        if (rest.replace(/[^a-z0-9]/gi, '').length > 8) {
          state.pendingIntent = [rest, state.pendingIntent].filter(Boolean).join('. ');
          console.log('[age] request carried with the yes, held for after the address: ' + JSON.stringify(rest).slice(0, 80));
          if (state.step === 'addr_new' && !require('./address-extract.js').findAddress(state.pendingIntent)) {
            saveFlowState();
            const askA = 'Thanks! What\'s your delivery address? (street, city, state and zip) — I\'ll pick up your request right after.';
            return res.json({ text: askA, response: askA });
          }
        } else if (state.step === 'addr_new' && !(state.pendingIntent && require('./address-extract.js').findAddress(state.pendingIntent))) {
          saveFlowState();
          const askA = 'What is your delivery address? (Please include street, city, state, and zip code)';
          return res.json({ text: askA, response: askA });
        }
        saveFlowState();
      } else if (age.answer === 'no') {
        console.log('[age] REFUSED (' + age.why + '): ' + JSON.stringify(message).slice(0, 60));
        state.ageRefusedAt = Date.now(); state.pendingIntent = null; saveFlowState();
        return res.json({ text: AGE_BYE, response: AGE_BYE });
      } else {
        console.log('[age] no clear answer (' + age.why + ') — asking again: ' + JSON.stringify(message).slice(0, 60));
        // A question about the gate itself gets a real answer, not the canned line.
        if (/\b(why|what for|how come|do you need|is (this|that) (necessary|required))\b/i.test(message) && /\b(age|old|21|birthday|id)\b/i.test(message)) {
          const why = 'It\'s the law — Bevvi can only sell alcohol to adults, so I\'m required to confirm you\'re 21 or older before we continue. Are you 21 or older?';
          return res.json({ text: why, response: why });
        }
        if (age.why === 'unsure') {
          const u = 'No problem — I just need a yes or no: are you 21 or older?';
          return res.json({ text: u, response: u });
        }
        const ask = 'Before we get started — are you 21 or older?';
        // A substantive first message (an order, a question) is kept and replayed after the
        // gate instead of being discarded — real gap on email/WhatsApp, where the first
        // message usually IS the order. Only the FIRST one: a later off-script reply at the
        // gate must not overwrite the customer's actual request.
        const greetingOnly = msgLower.length < 12 || /^(hi|hello|hey|yo|hola|good (morning|afternoon|evening)|reset)[\s!.,]*$/i.test(msgLower);
        if (!greetingOnly && !state.pendingIntent) {
          state.pendingIntent = message; saveFlowState();
          const ack = 'Thanks — I have your request and will pick it up right after one quick check. Are you 21 or older?';
          return res.json({ text: ack, response: ack });
        }
        return res.json({ text: ask, response: ask });
      }
    }
    // Pre-gate message stashed above: if it contains a delivery address, run that through
    // the address step now and replay the rest once the address is accepted; if the flow is
    // already ready (saved address), replay it whole.
    if (state.pendingIntent && state.step === 'addr_new') {
      // address-extract.js: line breaks and unit lines inside the address (Sep 29: "Floor 6\r\nBoston" became "6, Boston").
      const addrF = require('./address-extract.js').findAddress(state.pendingIntent);
      const am = addrF ? [addrF, addrF] : null;
      if (am) {
        // Cut the address out of the original text (it still has its line breaks): street start .. zip end.
        const pi = state.pendingIntent, st0 = pi.indexOf(addrF.split(',')[0]), zm = addrF.match(/\d{5}(?:-\d{4})?$/);
        const en0 = zm && st0 >= 0 ? pi.indexOf(zm[0], st0) : -1;
        const cut = st0 >= 0 && en0 > st0 ? pi.slice(0, st0) + pi.slice(en0 + zm[0].length) : pi.replace(addrF, '');
        const rest = cut.replace(/\b(deliver(?:ed|y)?\s+(?:to|at)|ship(?:ped)?\s+to|address(?: is)?:?)\s*(?=,|\.|\s+on\b|\s*$)/i, '').trim();
        message = am[1]; msgLower = message.toLowerCase();
        state.pendingIntent = rest.replace(/\s+/g, ' ').length > 8 ? rest : null; saveFlowState();
        console.log('[age] pre-gate message: address', JSON.stringify(message), '| replaying rest:', JSON.stringify((state.pendingIntent || '').slice(0, 80)));
      }
    } else if (state.pendingIntent && state.step === 'ready' && state.ageVerified) {
      message = state.pendingIntent; msgLower = message.toLowerCase(); state.pendingIntent = null; saveFlowState();
    }

    // ── STATE: addr_new ────────────────────────────────────────────────────
    // Address normalization via Google at the address steps (and an address change at
    // confirm). A zip-less address gets its zip; a sloppy one ('425 west 53rd st, NY, NY
    // 10019') becomes a clean one. The parser below then sees a complete address.
    if ((['addr', 'addr_new'].includes(state.step) || (state.orderStep === 'confirm' && /\b(address|deliver to|delivery location)\b/i.test(message)))
        && /\b\d{1,6}\s+[A-Za-z]/.test(message) && !/^\s*(yes|yeah|yep|no|nope|same)\b[\s.!]*$/i.test(message)) {   // only a BARE yes/no is skipped; 'no, use 11 Broadway...' is geocoded
      const addrText = message.replace(/^.*?\b(address|deliver to|delivery location|ship to)\b\s*(to|is|:)?\s*/i, '').replace(/^(no|nope|use|instead)[,.\s]+/i, '').trim();
      const geo = await geocodeAddress(addrText);
      if (geo) {
        const hadZip = (message.match(/\b(\d{5})\b/) || [])[1];
        if (!hadZip || hadZip === geo.zip) {
          console.log('[geocode]', JSON.stringify(addrText).slice(0, 60), '->', geo.formatted);
          message = message.replace(addrText, geo.formatted);
          state.geocoded = { formatted: geo.formatted, zip: geo.zip, lat: geo.lat, lng: geo.lng };
        } else console.log('[geocode] zip mismatch, keeping typed address:', hadZip, 'vs', geo.zip);
      } else if (!/\b\d{5}\b/.test(message) && ['addr', 'addr_new'].includes(state.step)) {
        // No match and no zip: ask specifically rather than repeating the generic prompt.
        const rG = 'I couldn\'t find that address — could you double-check the street number and city, or add the zip code? (e.g. "' + addrText + ', 10019")';
        return res.json({ text: rG, response: rG });
      }
    }
    if (state.step === 'addr_new') {
      // Strip a conversational prefix so "address is 425 W 53rd St" is stored as the
      // address, not the sentence (real bug: summary read "Delivery to: address is 425...").
      message = message.replace(/^\s*(?:my |the |our )?(?:new |delivery |shipping )?address(?: is|:)?\s*/i, '').replace(/^\s*(?:deliver(?: it)? to|ship(?: it)? to|send(?: it)? to)\s*:?\s*/i, '').trim();
      const zipMatch = message.match(/\b(\d{5})\b/);
      if (zipMatch) {
        const candidateZip = zipMatch[1];
        const coverage = await checkStoreCoverage(candidateZip);
        if (coverage && coverage.store_count === 0) {
          const noStoreMsg = `Sorry, it looks like we don't currently have a store serving the ${candidateZip} zip code, so I'm unable to fulfill orders there yet. I'd recommend reaching out to our support team at bevvi-support@getbevvi.com — they can look into delivery options for your area. Would you like to try a different delivery address?`;
          return res.json({ text: noStoreMsg, response: noStoreMsg });
        }
        // A zip alone is not a delivery address. Real bug: "90210" was accepted ("Got it —
        // delivering to 90210") and the order would have gone out with no street.
        if (!/\b\d{1,6}\s+[A-Za-z]/.test(message.replace(/\b\d{5}(-\d{4})?\b/g, ''))) {
          console.log('[addr] zip only, no street — asking for the street address: ' + JSON.stringify(message).slice(0, 60));
          const askS = 'Thanks — I need the full street address for delivery. What\'s the street address in ' + candidateZip + '? (e.g. "425 W 53rd St, New York, NY ' + candidateZip + '")';
          return res.json({ text: askS, response: askS });
        }
        state.zip = candidateZip;
        state.address = message;
        state.addrConfirmed = true;
        state.step = 'ready';
        // Save to GBrain
        if (email) {
          try {
            const d2c = await getD2CSession(email) || {};
            await saveD2CSession(email, Object.assign({}, d2c, { delivery_address: message, delivery_zip: state.zip }));
          } catch(e) {}
        }
        // Always ECHO the accepted address (QA caught the reply falling through to the LLM's
        // generic greeting with no address shown). If the customer had typed a request
        // before giving the address, replay it with the confirmation on top.
        saveFlowState();
        const addrOk = 'Got it — delivering to ' + state.address + '.';
        if (state.pendingIntent) {
          const pend = state.pendingIntent; state.pendingIntent = null; saveFlowState();
          message = pend;
          { const _jA = res.json.bind(res); res.json = (payload) => { try { if (payload && typeof payload.text === 'string') { payload.text = addrOk + '\n\n' + payload.text; payload.response = addrOk + '\n\n' + (payload.response || ''); } } catch (e) {} return _jA(payload); }; }
        } else {
          const rOk = addrOk + ' How can I help you today?';
          return res.json({ text: rOk, response: rOk });
        }
      } else {
        // Not an address. A request ("I want some beer") is held and replayed after the
        // address, as at the age gate; anything else gets a concrete example, not the same line.
        const looksLikeRequest = !/\d/.test(message) && message.split(/\s+/).length >= 2 && /\b(want|need|order|looking|do you|have|show|price|how much|bottle|wine|beer|vodka|tequila|whiskey|champagne|spirits|party|event|recommend)\b/i.test(message);
        if (looksLikeRequest && !state.pendingIntent) {
          state.pendingIntent = message; saveFlowState();
          console.log('[addr] request at the address step — held for after the address: ' + JSON.stringify(message).slice(0, 70));
          const askR = 'Happy to help with that — first, what\'s your delivery address? (street, city, state and zip, e.g. "425 W 53rd St, New York, NY 10019")';
          return res.json({ text: askR, response: askR });
        }
        console.log('[addr] no address in reply — asking with an example: ' + JSON.stringify(message).slice(0, 60));
        const ask = 'To deliver, I need a street address — street, city, state and zip (e.g. "425 W 53rd St, New York, NY 10019"). Where should we deliver?';
        return res.json({ text: ask, response: ask });
      }
    }

    // ── STATE: addr (has saved address, needs confirmation) ────────────────
    if (state.step === 'addr') {
      if (yesWords.some(w => msgLower.includes(w))) {
        const coverage = await checkStoreCoverage(state.zip);
        if (coverage && coverage.store_count === 0) {
          state.step = 'addr_new';
          state.pendingIntent = null;
          const noStoreMsg = `Sorry, it looks like we don't currently have a store serving the ${state.zip} zip code on file. Could you provide a different delivery address? Or reach out to bevvi-support@getbevvi.com for help.`;
          return res.json({ text: noStoreMsg, response: noStoreMsg });
        }
        state.addrConfirmed = true;
        state.step = 'ready';
        // Replay pending intent if any
        if (state.pendingIntent) {
          const pending = state.pendingIntent;
          state.pendingIntent = null;
          const fp = fingerprint(pending);
          state.lastFingerprint = fp;
          state.lastZip = state.zip;
          const gbrainContext = email ? await getCustomerContext('', '', context?.client_id || 'airculinaire', email).catch(() => '') : '';
          context.saved_zip = state.zip;
          const addrRule = `\n\n## DELIVERY\nZip: ${state.zip}. Address: ${state.address}. Use this zip for ALL ShoppingAgent calls. Never ask about address or age.`;
          let reply = await callRachel({ sessionKey, message: pending, context, format, gbrainContext, addressRule: addrRule, email });
          // Apply the same CTA logic as the main flow, since this replay path bypasses it otherwise
          const replayHasProposal = reply.toLowerCase().includes('your proposal') || reply.includes('proposals/bevvi-proposal') || reply.includes('download proposal');
          // Case-insensitive: replies say "Product Total" / "Estimated Grand Total" (title
          // case), which the old lowercase substring checks never matched — so packageShown
          // stayed false and the deterministic mixer-decline gate never fired on the
          // first "no" (real bug: "no" to mixers re-displayed the package twice).
          const replayIsEventPackage = /product total|estimated (grand )?total|grand total/i.test(reply);
          const replayIsSingleProduct = !replayIsEventPackage && reply.includes('$') && (reply.match(/\d+ML/i) !== null || reply.match(/\d+L\b/) !== null) && reply.split('$').length <= 3;
          const replayCtaPatterns = [
            'place the order', 'place an order', 'placing the order', 'placing an order',
            'pdf proposal', 'generate a proposal', 'generate the proposal',
            'make any changes', 'any changes', 'anything else', 'would you like to',
            'shall i', 'let me know if'
          ];
          const replayHasCTA = reply.trim().endsWith('?') || replayCtaPatterns.some(p => reply.toLowerCase().includes(p));
          if (replayIsEventPackage || replayIsSingleProduct) state.packageShown = true;
          if (replayHasProposal) { state.packageShown = false; state.mixerAsked = false; state.mixerAnswered = false; }
          const replayHasMixerQuestion = reply.toLowerCase().includes('add mixers') || reply.toLowerCase().includes('mixers, water, soda');
          if (replayHasMixerQuestion) state.mixerAsked = true;
          if (!replayHasCTA && !replayHasProposal && !replayHasMixerQuestion && (state.packageShown || replayIsEventPackage || reply.includes('$'))) {
            if (replayIsEventPackage && !state.mixerAsked) {
              reply += '\n\nWould you also like to add mixers, water, soda, ice, or cups?';
              state.mixerAsked = true;
            } else if (!replayIsEventPackage || state.mixerAnswered || state.mixerAsked) {
              const replayCaps = getCapabilities(format);
              const replayCtaActions = [];
              if (replayCaps.can_place_order) replayCtaActions.push(format === 'slack' ? '*place the order*' : 'place the order');
              if (replayCaps.can_generate_proposal) replayCtaActions.push(format === 'slack' ? '*generate a PDF proposal*' : 'generate a PDF proposal');
              if (replayCtaActions.length > 0) {
                reply += '\n\nWould you like to ' + replayCtaActions.join(' or ') + ', or make any changes?';
              } else {
                reply += '\n\nWould you like to make any changes, or is there anything else I can help with?';
              }
            }
          }
          saveFlowState();
          const prefix = `Got it! Delivering to ${state.address}.\n\n`;
          return res.json({ text: prefix + reply, response: prefix + reply });
        }
        const ok = `Got it! Delivering to ${state.address}. How can I help you today?`;
        return res.json({ text: ok, response: ok });
      } else if (!/\b\d{5}\b/.test(message) && noWords.some(w => msgLower === w || msgLower.startsWith(w + ' '))) {
        // Only a BARE no asks again. 'No, use 100 Federal St, Boston, MA 02110' carries the
        // answer — the zip branch below handles it in one turn (real case: it re-asked).
        state.step = 'addr_new';
        // Keep pendingIntent as-is so the original request can still be replayed once a new address is confirmed
        const ask = 'No problem! What is your delivery address? (Include street, city, state, and zip)';
        return res.json({ text: ask, response: ask });
      } else if (/\b\d{5}\b/.test(message)) {
        // Customer provided a brand-new address directly (with or without "no" framing) — treat it as a new address instead of re-asking
        const zipMatch = message.match(/\b(\d{5})\b/);
        const candidateZip = zipMatch[1];
        const coverage = await checkStoreCoverage(candidateZip);
        if (coverage && coverage.store_count === 0) {
          const noStoreMsg = `Sorry, it looks like we don't currently have a store serving the ${candidateZip} zip code, so I'm unable to fulfill orders there yet. I'd recommend reaching out to our support team at bevvi-support@getbevvi.com. Would you like to try a different delivery address?`;
          return res.json({ text: noStoreMsg, response: noStoreMsg });
        }
        state.zip = candidateZip;
        state.address = message;
        state.addrConfirmed = true;
        state.step = 'ready';
        if (email) {
          try {
            const d2c = await getD2CSession(email) || {};
            await saveD2CSession(email, Object.assign({}, d2c, { delivery_address: message, delivery_zip: state.zip }));
          } catch(e) {}
        }
        if (state.pendingIntent) {
          const pending = state.pendingIntent;
          state.pendingIntent = null;
          const fp = fingerprint(pending);
          state.lastFingerprint = fp;
          state.lastZip = state.zip;
          const gbrainContext = email ? await getCustomerContext('', '', context?.client_id || 'airculinaire', email).catch(() => '') : '';
          context.saved_zip = state.zip;
          const addrRule = `\n\n## DELIVERY\nZip: ${state.zip}. Address: ${state.address}. Use this zip for ALL ShoppingAgent calls. Never ask about address or age.`;
          let reply = await callRachel({ sessionKey, message: pending, context, format, gbrainContext, addressRule: addrRule, email });
          const replayHasProposal = reply.toLowerCase().includes('your proposal') || reply.includes('proposals/bevvi-proposal') || reply.includes('download proposal');
          // Case-insensitive: replies say "Product Total" / "Estimated Grand Total" (title
          // case), which the old lowercase substring checks never matched — so packageShown
          // stayed false and the deterministic mixer-decline gate never fired on the
          // first "no" (real bug: "no" to mixers re-displayed the package twice).
          const replayIsEventPackage = /product total|estimated (grand )?total|grand total/i.test(reply);
          const replayIsSingleProduct = !replayIsEventPackage && reply.includes('$') && (reply.match(/\d+ML/i) !== null || reply.match(/\d+L\b/) !== null) && reply.split('$').length <= 3;
          const replayCtaPatterns = [
            'place the order', 'place an order', 'placing the order', 'placing an order',
            'pdf proposal', 'generate a proposal', 'generate the proposal',
            'make any changes', 'any changes', 'anything else', 'would you like to',
            'shall i', 'let me know if'
          ];
          const replayHasCTA = reply.trim().endsWith('?') || replayCtaPatterns.some(p => reply.toLowerCase().includes(p));
          if (replayIsEventPackage || replayIsSingleProduct) state.packageShown = true;
          if (replayHasProposal) { state.packageShown = false; state.mixerAsked = false; state.mixerAnswered = false; }
          const replayHasMixerQuestion = reply.toLowerCase().includes('add mixers') || reply.toLowerCase().includes('mixers, water, soda');
          if (replayHasMixerQuestion) state.mixerAsked = true;
          if (!replayHasCTA && !replayHasProposal && !replayHasMixerQuestion && (state.packageShown || replayIsEventPackage || reply.includes('$'))) {
            if (replayIsEventPackage && !state.mixerAsked) {
              reply += '\n\nWould you also like to add mixers, water, soda, ice, or cups?';
              state.mixerAsked = true;
            } else if (!replayIsEventPackage || state.mixerAnswered || state.mixerAsked) {
              const replayCaps = getCapabilities(format);
              const replayCtaActions = [];
              if (replayCaps.can_place_order) replayCtaActions.push(format === 'slack' ? '*place the order*' : 'place the order');
              if (replayCaps.can_generate_proposal) replayCtaActions.push(format === 'slack' ? '*generate a PDF proposal*' : 'generate a PDF proposal');
              if (replayCtaActions.length > 0) {
                reply += '\n\nWould you like to ' + replayCtaActions.join(' or ') + ', or make any changes?';
              } else {
                reply += '\n\nWould you like to make any changes, or is there anything else I can help with?';
              }
            }
          }
          saveFlowState();
          const prefix = `Got it! Delivering to ${state.address}.\n\n`;
          return res.json({ text: prefix + reply, response: prefix + reply });
        }
        const ok = `Got it! Delivering to ${state.address}. How can I help you today?`;
        return res.json({ text: ok, response: ok });
      } else {
        // Store intent and ask for address confirmation (only if not already set, so we don't lose the original request)
        if (!state.pendingIntent) {
          state.pendingIntent = message;
        }
        const addrQ = `I have your delivery address on file as ${state.address} — shall I use this for your order?`;
        return res.json({ text: addrQ, response: addrQ });
      }
    }

    // ── STATE: ready — check if we need address confirmation first ─────────
    if (state.step === 'ready' && !state.addrConfirmed && state.address) {
      state.step = 'addr';
      state.pendingIntent = message;
      const addrQ = `I have your delivery address on file as ${state.address} — shall I use this for your order?`;
      return res.json({ text: addrQ, response: addrQ });
    }

    // ── Event menu: ask what the guests will drink most ─────────────────────
    // (not isInternalMsg: that const is declared further down — referencing it here threw a TDZ ReferenceError on every turn)
    if (state.step === 'ready' && !state.orderStep && !state.proposalStep && !state.pendingQtyFor && !/^__/.test(message)) {
      if (state.pendingMenu) {
        const pm = state.pendingMenu;
        const got = parseServingMix(message, pm.cats, false);
        if (got) {
          state.eventParams = Object.assign({}, state.eventParams || {}, { serving_mix: JSON.stringify(got.mix) });
          state.pendingMenu = null; saveFlowState();
          console.log('[menu] serving mix (' + got.why + '): ' + mixText(got.mix) + ' — building the held request: ' + JSON.stringify(pm.message).slice(0, 80));
          message = pm.message; msgLower = message.toLowerCase().trim();
          // No percentages in this note: given numbers, the LLM put them in category_splits and
          // switched the builder into SPLIT mode (spirits dropped, reviewer blocked the build).
          context.order_change_note = 'The customer answered which drinks their guests will have most (' + JSON.stringify(message).slice(0, 80) + '). That preference is applied automatically by the system. Build the event package now with intent=menu_build exactly as you normally would — do NOT set category_splits. In one short line, mention the package leans toward what they said.';
        } else if (!pm.reasked) {
          pm.reasked = true; saveFlowState();
          console.log('[menu] no serving preference in reply — asking once more: ' + JSON.stringify(message).slice(0, 60));
          const rQ = 'Just so I get the quantities right — which will your guests drink most: ' + pm.labels.join(', ') + '? You can say "mostly ' + pm.labels[0] + '", name two, or "about even".';
          return res.json({ text: rQ, response: rQ });
        } else {
          state.pendingMenu = null; saveFlowState();
          console.log('[menu] still no serving preference — building with the standard mix');
          message = pm.message; msgLower = message.toLowerCase().trim();
        }
      } else {
        const cats = eventDrinkCats(message);
        if (cats) {
          const stated = parseServingMix(message, cats, true);
          state.eventParams = Object.assign({}, state.eventParams || {}, { serving_mix: stated ? JSON.stringify(stated.mix) : null });   // a new event never inherits an old mix
          if (stated) {
            saveFlowState();
            console.log('[menu] serving mix stated in the request (' + stated.why + '): ' + mixText(stated.mix));
          } else {
            const said = k => { const mm = message.match(MIX_SYN[k]); return mm ? mm[0].toLowerCase() : k; };
            const labels = cats.map(k => k === 'spirits' ? (/\bcocktails?|mixed drinks?\b/i.test(message) ? 'cocktails' : said('spirits')) : said(k));
            state.pendingMenu = { message, cats, labels }; saveFlowState();
            console.log('[menu] mixed event (' + cats.join(' + ') + ') with no serving preference — asking what they\'ll drink most');
            const ask = 'Happy to put that together! To get the mix right — what will your guests drink most: ' + labels.slice(0, -1).join(', ') + ' or ' + labels[labels.length - 1] + '? (e.g. "mostly ' + labels[0] + '", "' + labels[0] + ' and ' + labels[1] + '", or "about even")';
            return res.json({ text: ask, response: ask });
          }
        }
      }
    }

    // ── Tip: set or change it any time ──────────────────────────────────────
    // "make the tip 15%", "no tip", "tip $8". At the tip step or the summary, re-render the
    // summary with the new tip; earlier, remember it for the order. Decided in code.
    if (state.step === 'ready' && state.orderStep !== 'tip' && (state.tipAsk || (/\btip\b/i.test(message) && /\b(make|set|change|add|leave|give|remove|no|zero|without|waive|skip|lower|reduce|increase|raise|bump|drop|less|more)\b[^.?!]*\btip\b|\btip\b[^.?!]*\b(to|at|of|is)\s*\$?\d|\btip\b\s*(?:=|:)?\s*\$?\d|\bno tip\b/i.test(message)))) {
      const tc = parseTip(message);
      if (tc && tc.ambiguous == null) {
        state.savedTipChoice = tc; state.tipAsk = false;
        if (state.orderData) state.orderData.tipChoice = tc;
        saveFlowState();
        console.log('[tip] set to ' + tipText(tc) + ' (' + JSON.stringify(message).slice(0, 50) + ')' + (state.orderStep ? ' during orderStep=' + state.orderStep : ''));
        if (state.orderStep === 'confirm') return renderOrderSummary(state, email, format, res);
        const rT = 'Done — ' + (tc.pct === 0 ? 'no tip on this order' : 'the driver tip is set to ' + tipText(tc)) + '. It\'ll show on your order summary. Anything else?';
        return res.json({ text: rT, response: rT });
      }
      if (!state.tipAsk) {
        state.tipAsk = true; saveFlowState();
        const rQ = tc && tc.ambiguous != null ? 'Is that ' + tc.ambiguous + '% or $' + tc.ambiguous + '?' : 'Sure — what tip would you like for the driver? (e.g. 15%, $8, or "no tip")';
        return res.json({ text: rQ, response: rQ });
      }
      state.tipAsk = false; saveFlowState();   // second unclear reply: drop it and carry on normally
      console.log('[tip] still no tip amount after asking — handling the message normally');
    }

    // ── STATE: ready — a new delivery address ──────────────────────────────
    // Real bug: after one address was set, a new full address went to the LLM, which said
    // "I'm not able to change the delivery address mid-conversation". Changing it is allowed:
    // check coverage, and if a different store serves it, the basket (built for the old
    // store's catalog) has to be rebuilt — say so.
    if (state.step === 'ready' && !state.orderStep && !state.proposalStep) {
      // address-extract.js, not a one-line pattern: "100 Federal Street, Floor 6, Boston, MA 02110" (a unit with a
      // number) didn't match, so the change fell through to the LLM (Sep 29, Gen II session).
      const afR = require('./address-extract.js').findAddress(message);
      const am = afR ? [afR, afR, (afR.match(/(\d{5})(?:-\d{4})?$/) || [])[1]] : null;
      // What's left once the address is taken out (letters only, so line breaks and commas don't matter).
      const lettersOf = x => String(x || '').replace(/[^a-z]/gi, '').toLowerCase();
      const rest = am ? lettersOf(String(message).replace(/\b(please|change|update|use|switch|new|my|the|delivery|address|deliver|ship|send|it|to|is|at|instead|actually|now)\b|[^a-z]/gi, '')).replace(lettersOf(afR), '') : 'x';
      if (am && rest.length <= 3) {
        const newZip = am[2];
        const cov = await checkStoreCoverage(newZip);
        if (cov && cov.store_count === 0) {
          const rNo = 'I can\'t deliver to ' + newZip + ' yet — no store serves that zip. I\'ll keep delivering to ' + state.address + ', or give me a different address.';
          return res.json({ text: rNo, response: rNo });
        }
        const prevCov = state.zip ? await checkStoreCoverage(state.zip) : null;
        let items = []; try { items = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
        const storeChanged = !!(prevCov && cov && prevCov.client && cov.client && prevCov.client !== cov.client);
        console.log('[addr] address changed at ready: ' + JSON.stringify(state.address) + ' -> ' + JSON.stringify(am[1]) + ' | store changed: ' + storeChanged + ' | basket items: ' + items.length);
        state.address = am[1]; state.zip = newZip; state.addrConfirmed = true; state.geocoded = null;
        if (storeChanged && items.length) { state.lastLineItems = '[]'; Object.keys(packageCache).forEach(k => { if (k.startsWith(email + ':')) delete packageCache[k]; }); }
        saveFlowState();
        if (email) { try { const d2c = await getD2CSession(email) || {}; await saveD2CSession(email, Object.assign({}, d2c, { delivery_address: state.address, delivery_zip: newZip })); } catch (e) {} }
        const rA = 'Updated — delivering to ' + state.address + '.' + (storeChanged && items.length ? ' That address is served by a different store, so your basket needs to be rebuilt — tell me what you\'d like and I\'ll put it together again.' : ' What can I get you?');
        return res.json({ text: rA, response: rA });
      }
    }

    // ── STATE: ready — pass to Rachel ──────────────────────────────────────
    console.log('[turn] state.step:', state.step, '| pendingSubstitutes:', JSON.stringify(state.pendingSubstitutes), '| message:', JSON.stringify(message).slice(0,80));
    { const _turnMsg = message; const _json = res.json.bind(res);
      res.json = (payload) => { try { recordTurn(sessionKey, _turnMsg, payload && (payload.text || payload.response)); } catch (e) {} return _json(payload); }; }
    // ── QUOTE EDITS (quote-edits.js) ─────────────────────────────────────────────────────────────────
    // "Remove the following ... remove all beer in bottles ... I only need 1 case ... resend the updated
    // quote" against a quote the customer already has: parsed and applied in code, every change listed,
    // the PDF regenerated. Real case (Sep 29, Gen II Fund): there was no deterministic path — the LLM's
    // update_quantity matched by substring ("Cantena" missed Catena), had no "all bottled beer" rule and
    // nothing re-sent the PDF. Scope: email sessions and sessions that already have a proposal; an edit
    // that also ADDS items goes to the LLM (adds need a catalog search). Removals/quantities only.
    let preText = '';   // quote edits applied this turn, shown above the order reply when the same email also orders
    if (!state.orderStep && !state.proposalStep && (/^email-/.test(sessionKey) || (context && context.email_subject) || state.lastProposalUrl)) {
      let qItems = []; try { qItems = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
      const qe = qItems.length ? QE.parseEdits(message) : null;
      if (qe && qe.count && qe.adds) console.log('[quote-edits] the request also adds items — left to the LLM (adds need a catalog search)');
      else if (qe && qe.count) {
        const r = QE.applyEdits(qItems, qe);
        console.log('[quote-edits] ' + qe.count + ' edit(s) -> ' + JSON.stringify(r.changes.map(c => c.kind + ': ' + c.name + (c.to != null ? ' ' + c.from + '->' + c.to : '') + (c.why && c.why !== 'asked' ? ' (' + c.why + ')' : '')))
          + (r.notFound.length ? ' | NOT FOUND (told the customer): ' + JSON.stringify(r.notFound) : '') + (r.ambiguous.length ? ' | AMBIGUOUS (asked): ' + JSON.stringify(r.ambiguous) : '')
          + ' | total $' + QE.total(qItems) + ' -> $' + QE.total(r.items));
        if (r.changes.length) {
          state.lastLineItems = JSON.stringify(r.items);
          packageCache[makeCacheKey(email, state.zip, state.lastFingerprint)] = state.lastLineItems;
          state.pendingSubstitutes = []; state.lastCta = null; saveFlowState();
        }
        let txt = QE.describe(r, qItems);
        const alsoOrder = EO.isOrderCommand(message) && !r.ambiguous.length && r.items.length;
        if (alsoOrder) { preText = txt; console.log('[quote-edits] the email also asks to create the order — continuing to the email order'); }
        else if (r.changes.length && r.items.length) {
          const subj = String(state.emailSubject || (context && context.email_subject) || '');
          const client = state.savedClientName || (subj.match(/\s[-–—|:]\s*([^-–—|:]{2,60})$/) || [])[1] || String((context && context.user_name) || '').trim();
          try {
            const url = await quotePdf(state, r.items, String(client || '').trim(), state.savedEventDate || '', r.items.filter(li => li.match && li.match.kind && li.match.kind !== 'exact').length);
            txt += '\n\nYour updated PDF proposal is attached: ' + url;
          } catch (e) {
            console.log('[quote-edits] PDF regeneration failed (changes kept, customer told): ' + e.message);
            txt += "\n\nI couldn't regenerate the PDF just now — reply \"send the proposal\" and I'll try again.";
          }
        }
        if (!alsoOrder) {
          if (!r.ambiguous.length) txt += '\n\nReply with any other changes, or say "place the order" when you\'re ready.';
          return res.json({ text: txt, response: txt });
        }
      }
    }
    // ── EMAIL ORDER (email-order.js) ─────────────────────────────────────────────────────────────────
    // DC (Sep 29): "create the order" / "send a payment link" in an email creates the order and the reply
    // carries the payment link. Contact = the customer in the email; everything missing is asked for in ONE
    // reply and the answer places it; tip 5% unless stated. Placed here in code (no LLM), QA = dry run.
    if ((/^email-/.test(sessionKey) || (context && context.email_subject)) && !state.orderStep && !state.proposalStep
        && (EO.isOrderCommand(message) || state.emailOrder)) {
      let oItems = []; try { oItems = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
      const cmd = EO.isOrderCommand(message), poE = state.placedOrder;
      const x = EO.extract(message, { name: context && context.user_name, email }, new Date());
      const provided = !!(x.name || x.phone || x.when || x.date || x.time || x.instructions || x.tip);   // a bare "2pm" answers the time question
      if (!oItems.length && cmd) {
        const t = poE && poE.payment_url
          ? 'This order was already created — order #' + poE.order_id + '. Payment link: ' + poE.payment_url + '\n\nIf something needs to change before paying, reply with the change and I\'ll create an updated order.'
          : 'There\'s no quote on this thread to order yet — send the list of items (and the delivery address) and I\'ll put it together.';
        console.log('[email-order] command with an empty basket — ' + (poE && poE.payment_url ? 'already placed ' + poE.order_id + ', link re-sent' : 'nothing to order, asked for the list'));
        return res.json({ text: t, response: t, email_cc: x.link_to || [] });
      }
      if (oItems.length && (cmd || provided)) {
        const od = Object.assign({}, state.emailOrder || {});
        for (const k of ['name', 'email', 'phone', 'instructions']) if (x[k]) od[k] = x[k];
        if (x.tip) od.tip = x.tip;
        if (x.source) od.source = x.source;
        if (x.link_to && x.link_to.length) od.link_to = [...new Set((od.link_to || []).concat(x.link_to))];
        let problem = '';
        // A date alone is kept; a time alone joins the kept date (Sep 29, Gen II: "the delivery date is Monday,
        // October 5th" was ignored and the date+time asked for again).
        if (!x.when && x.date) { od.delivery_date = x.date; od.delivery_ok = false; }
        const whenPhrase = x.when || (x.time && od.delivery_date ? od.delivery_date + ' at ' + x.time : '');
        if (!whenPhrase && od.delivery_date && !od.delivery_ok) {
          const w = await deliveryWindowsOn(state, od.delivery_date);
          od.delivery_date_label = w.label || od.delivery_date;
          if (w.none) { problem = "There's no delivery availability on " + od.delivery_date_label + ' — which other date works?'; od.delivery_date = ''; od.delivery_date_label = ''; }
          else if (w.options.length) problem = 'Delivery windows on ' + od.delivery_date_label + ': ' + w.options.join(', ') + '. Which one works?';
        }
        if (whenPhrase) {
          // The store's real delivery windows (validateDeliveryTime), captured instead of sent: a problem goes
          // into the ONE reply with the other questions.
          state.orderData = {}; let askedT = null;
          await validateDeliveryTime(state, whenPhrase, email, format, { json: pl => { askedT = pl && (pl.text || pl.response); return null; } });
          if (askedT) { problem = askedT; od.delivery_ok = false; }
          else {
            od.delivery_ok = true; od.delivery_iso = state.orderData.delivery_datetime_iso || ''; od.delivery_window = state.orderData.delivery_datetime || x.when;
            od.delivery_label = [state.orderData.delivery_date_label, state.orderData.delivery_window_display].filter(Boolean).join(', ') || whenPhrase;
          }
          state.orderData = null;
        }
        // Every line must be a catalog product before Bevvi can take the order: link what matches exactly (same
        // price + name), and ask about the rest in the same single reply — never a guess.
        let unlinked = [];
        if (oItems.some(LR.needsLink) && state.zip) {
          const rr = await LR.resolveLines(oItems, (n, c) => catalogSearch(state.zip, n, c));
          if (rr.linked.length) { oItems = rr.items; state.lastLineItems = JSON.stringify(oItems); saveFlowState(); }
          unlinked = rr.unresolved;
        }
        const miss = EO.missing(od);
        if (unlinked.length) {
          miss.push('which product you mean for ' + unlinked.length + ' item(s) I can\'t match exactly in this store\'s catalog');
          problem = (problem ? problem + '\n\n' : '') + unlinked.map(u => '• ' + u.name + ' — ' + u.reason + (u.options.length ? '. Closest: ' + u.options.join('; ') : '')).join('\n');
        }
        console.log('[email-order] ' + (cmd ? 'command' : 'details reply') + ' | contact: ' + JSON.stringify({ name: od.name, email: od.email, phone: od.phone, source: od.source }) + ' | delivery: ' + (od.delivery_ok ? od.delivery_label : (whenPhrase ? 'REJECTED "' + whenPhrase + '"' : od.delivery_date ? 'date only "' + od.delivery_date + '" (time asked)' : 'none')) + (od.link_to ? ' | link also to: ' + od.link_to.join(', ') : '') + ' | tip: ' + JSON.stringify(od.tip || 'default 5%') + (miss.length ? ' | MISSING (asked in one reply): ' + miss.join('; ') : ' | complete -> placing'));
        if (miss.length) {
          state.emailOrder = od; saveFlowState();
          const t = (preText ? preText + '\n\n' : '') + EO.askText(miss, od, problem);
          return res.json({ text: t, response: t, email_cc: od.link_to || [] });
        }
        const pt = QE.total(oItems);
        const tipAmt = od.tip ? (od.tip.amount != null ? od.tip.amount : Math.round(pt * od.tip.pct) / 100) : Math.round(pt * 5) / 100;
        const tipLabel = od.tip ? (od.tip.amount != null ? 'Tip' : 'Tip (' + od.tip.pct + '%)') : 'Tip (5% — standard, since none was given)';
        const nm = String(od.name).trim().split(/\s+/);
        let r = null;
        try {
          r = await callShoppingTool('place_order', {
            line_items: state.lastLineItems,
            customer: { firstName: nm[0], lastName: nm.slice(1).join(' '), email: od.email, phone: od.phone, address: state.address, zipcode: state.zip },
            account_email: email, email, tip_amount: tipAmt,
            delivery_datetime: od.delivery_iso || od.delivery_window, delivery_instructions: od.instructions || '',
            zip: state.zip, dry_run: isQA });
        } catch (e) { r = { success: false, error: e.message }; }
        if (!r || !r.success) {
          console.log('[email-order] place_order FAILED (customer told, details kept for a retry): ' + JSON.stringify(r).slice(0, 300));
          state.emailOrder = od; saveFlowState();
          const why = r && r.unresolved_items ? 'these items aren\'t linked to a catalog product yet: ' + r.unresolved_items.join(', ') : (r && r.error) || 'no response from the order service';
          const t = (preText ? preText + '\n\n' : '') + 'I couldn\'t create the order — ' + why + '. A member of the Bevvi team will follow up; your details are saved, so replying "create the order" will retry.';
          return res.json({ text: t, response: t, email_cc: od.link_to || [] });
        }
        recordPlacedOrder(sessionKey, email, format, r, state.lastLineItems, {});   // {}: a forwarded customer is not saved as the sender's own contact
        state.emailOrder = null; saveFlowState();
        const tax = Math.round(pt * 10) / 100, svc = Math.round(pt * 10) / 100, grand = Math.round((pt + tax + svc + tipAmt + 25) * 100) / 100;
        const m2 = n => QE.money(n);
        const t = (preText ? preText + '\n\n' : '') + 'Your order is created — order #' + r.order_id + (r.dry_run ? ' (QA dry run)' : '') + '.\n\nPayment link: ' + r.payment_url +
          '\n\nOrder for: ' + od.name + ', ' + od.phone + ', ' + od.email +
          '\nDelivery: ' + state.address + ' — ' + od.delivery_label + (od.instructions ? '\nInstructions: ' + od.instructions : '') +
          '\n\n' + oItems.length + ' item line(s). Product total ' + m2(pt) + '; estimated tax ' + m2(tax) + '; service charge (10%) ' + m2(svc) + '; ' + tipLabel + ' ' + m2(tipAmt) + '; estimated delivery ' + m2(25) + '. Estimated total ' + m2(grand) + '.' +
          '\n\nThe order is confirmed once the payment link is paid.';
        console.log('[email-order] placed ' + r.order_id + (r.dry_run ? ' (QA dry run)' : '') + ' — payment link sent: ' + r.payment_url + (od.link_to ? ' (also to ' + od.link_to.join(', ') + ')' : ''));
        return res.json({ text: t, response: t, email_cc: od.link_to || [] });
      }
    }
    // ── NEXT-BEST-ACTION (cta.js; Learning Phase 1, Part B) ──────────────────────────────────────────
    // Installed after recordTurn's wrapper so it runs FIRST: the history records the reply the customer
    // actually got. Every reply here: the old four-action trailer is stripped; a generic LLM closer is
    // replaced by the table's CTA; a real question stays and gets none (one question per turn).
    {
      const _jC = res.json.bind(res), turnMsg = message;
      res.json = (payload) => {
        try {
          if (payload && typeof payload.text === 'string' && !/^__/.test(turnMsg)) {
            const st = flowState[sessionKey] || state;
            const orig = payload.text;
            if (events.stateLabel(st) !== 'ready') {   // order / proposal / age / address steps own their question
              cta.chooseCta(st, { kind: events.stateLabel(st), question: true });
              st.lastCta = null; saveFlowState();
              return _jC(payload);
            }
            // A shopping list (custom_list) turn: the reply is composed in code from the real basket (list-reply.js).
            let listText = null;
            const evL = events.ctx();
            // An EMAIL quote request is always composed here with the PDF built in code, even when the LLM generated
            // its own proposal this turn. Real (Sep 29, QA 61): the classifier timed out, the LLM called
            // generate_proposal itself with client "airculinaire" (the context client_id) and its reply was kept.
            const subjQ = String((context && context.email_subject) || '');
            const emailQuote = !!((/^email-/.test(sessionKey) || subjQ) && /\b(quote|proposal|pdf|estimate)\b/i.test(turnMsg + ' ' + subjQ));
            if (emailQuote && evL && evL.ev && evL.ev.list_build && evL.actions.includes('generated_proposal')) console.log('[quote-pdf] the LLM generated its own proposal on an email quote turn — replaced by the reply and PDF built in code');
            if (evL && evL.ev && evL.ev.list_build && !evL.actions.includes('placed_order') && (!evL.actions.includes('generated_proposal') || emailQuote)) {
              let itL = []; try { itL = JSON.parse(st.lastLineItems || '[]'); } catch (e) {}
              if (itL.length) {
                const cL = listReply.compose({ items: itL, unmatched: evL.unmatched, llmText: orig });
                console.log(cL.log);
                evL.unmatched.sort((a, b) => (listReply.isNamed(b) ? 1 : 0) - (listReply.isNamed(a) ? 1 : 0));   // the CTA offers a substitute for [0]: a named product first
                listText = cL.text;
                // An EMAIL asking for a quote/proposal gets the PDF now, built in code from this basket (DC, Sep 29:
                // "just send the proper proposal"). Real gap: Sean's quote request got a basket and no PDF.
                const subj = String((context && context.email_subject) || '');
                if ((/^email-/.test(sessionKey) || subj) && /\b(quote|proposal|pdf|estimate)\b/i.test(turnMsg + ' ' + subj) && !cL.blocks.length) {
                  const client = (subj.match(/\s[-–—|:]\s*([^-–—|:]{2,60})$/) || [])[1] || String((context && context.user_name) || '').trim() || '';
                  const dm = String(turnMsg).match(cta.DATE_RE), eventDate = dm ? dm[0] : '';
                  const lt = listText;
                  quotePdf(st, itL, client.trim(), eventDate, cL.inexact.length).then(url => {
                    payload.text = lt + (url ? '\n\nYour PDF proposal is attached' + (eventDate ? '' : ' — reply with the event date and I\'ll add it') + ': ' + url : '');
                    if (typeof payload.response === 'string') payload.response = payload.text;
                    st.lastCta = null; saveFlowState();
                    _jC(payload);
                  }).catch(e => { console.log('[quote-pdf] failed (list sent without it): ' + e.message); payload.text = lt; payload.response = lt; _jC(payload); });
                  return res;
                }
              } else console.log('[list-reply] custom_list turn with an empty basket — LLM reply kept');
            }
            const orig0 = orig;
            const dn = cta.denumberBasketLines(orig);
            if (dn !== orig) console.log('[cta] removed list numbering from basket lines (they are not pick options)');
            let t = listText != null ? listText : cta.stripTrailer(dn);
            if (listText == null && t !== orig.trimEnd()) console.log('[cta] stripped the generic four-action trailer');
            const ga = cta.trimGenericAlternative(t);
            if (ga.cut.length) { t = ga.text; console.log('[cta] cut the generic alternative off a real question: ' + JSON.stringify(ga.cut.join(' | ').slice(0, 100))); }
            const cl = cta.splitCloser(t);
            if (cl.generic) { t = cl.body; console.log('[cta] removed generic closer ' + JSON.stringify(cl.closer.slice(0, 80)) + ' — the table decides the follow-up'); }
            else if (cl.question) console.log('[cta] kept the reply\'s own question ' + JSON.stringify(cl.closer.slice(0, 80)) + ' — no CTA (question turn)');
            const realQ = cl.question || cta.hasRealQuestion(t);
            if (realQ && !cl.question) console.log('[cta] the reply asks a real question earlier on — no CTA (question turn)');
            const turn = ctaTurn(st, t, realQ, turnMsg, context);
            if (turn.kind === 'item_unavailable' && !turn.substitute && turn.unmatchedName) {
              // sub.offer_named needs a real in-stock candidate: look it up, then send (the caller only returns res).
              const tt = t;
              findSubstitute(turn.unmatchedName, st.zip, email).then(sub => {
                turn.substitute = sub;
                finishCta(st, turn, tt, orig, payload);
                _jC(payload);
              }).catch(() => { finishCta(st, turn, tt, orig, payload); _jC(payload); });
              return res;
            }
            finishCta(st, turn, t, orig, payload);
          }
        } catch (e) { console.log('[cta] error (reply sent unchanged): ' + e.message); }
        return _jC(payload);
      };
    }
    // The quote PDF for an email list request: generate_proposal on the real basket (no LLM), logged.
    async function quotePdf(st, items, client, eventDate, inexactCount) {
      const rr = await fetch('http://127.0.0.1:8300/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_proposal', arguments: {
          line_items: JSON.stringify(items), client_name: client, event_date: eventDate, email, channel: format || 'plain',
          notes: (st.address ? 'Delivery: ' + st.address + '.' : '') + (inexactCount ? ' Some items are recommended alternatives to what was asked (see email).' : '')
            + (items.some(li => /\*\s*$/.test(String(li.name || ''))) ? ' * = recommended in place of a requested item this store does not carry.' : '') } } }) });
      const rt = await rr.text(); const rl = rt.split('\n').find(l => l.startsWith('data:'));
      const r = rl ? JSON.parse(JSON.parse(rl.replace('data:', '').trim()).result.content[0].text) : null;
      if (!r || !r.success) throw new Error((r && r.error) || 'no result');
      st.lastProposalUrl = r.download_url; if (client) st.savedClientName = client; if (eventDate) st.savedEventDate = eventDate;
      events.action('generated_proposal');
      console.log('[quote-pdf] email quote request -> proposal generated in code for ' + JSON.stringify(client) + ' (' + items.length + ' lines' + (eventDate ? ', event ' + eventDate : ', no event date') + '): ' + r.download_url);
      return r.download_url;
    }
    function finishCta(st, turn, t, orig, payload) {
      try {
            const c = cta.chooseCta(st, turn);
            st.lastCta = null;
            if (c) {
              const t0 = t; t = cta.scrubGenericQuestions(t);
              if (t !== t0.trimEnd()) console.log('[cta] removed generic question(s) from the body — the CTA is the one question');
              t = t.trimEnd() + '\n\n' + c.text;
              st.lastCta = { id: c.id, product: turn.product || null, qty: turn.offerQty || 0, substitute: turn.substitute || null, at: Date.now() };
              events.note({ cta_id: c.id });
            }
            let nB = 0; try { nB = JSON.parse(st.lastLineItems || '[]').length; } catch (e) {}
            const fb = cta.fallbackIfEmpty(t, st, turn, nB);
            if (fb) {
              t = fb.text;
              if (fb.cta) { st.lastCta = { id: fb.cta.id, product: null, qty: 0, substitute: null, at: Date.now() }; events.note({ cta_id: fb.cta.id }); }
            }
            saveFlowState();
            if (t !== orig) { payload.text = t; if (typeof payload.response === 'string') payload.response = t; }
      } catch (e) { console.log('[cta] error (reply sent unchanged): ' + e.message); }
    }
    // Did the customer act on the previous turn's CTA? Recorded on THIS turn's event (cta_taken); a CTA
    // not taken is not offered again this session. An accepted CTA is carried out here, in code.
    if (!isInternalMsgEarly(message)) state.ctaPrevId = state.lastCta ? state.lastCta.id : null;   // the CTA offered on the previous turn (basket_idle isn't repeated back to back)
    if (state.lastCta && state.step === 'ready' && !isInternalMsgEarly(message)) {
      const lc = state.lastCta; state.lastCta = null;
      const took = cta.accepted(lc.id, message);
      events.note({ cta_taken: took, cta_prev: lc.id });

      // Declined = an explicit no. Moving on ("show my basket", a new question) is not taken (cta_taken:
      // false, counted in the digest) but doesn't ban the CTA for the session — viewing the basket would
      // otherwise have killed the checkout offer for good (Sep 29 QA).
      const said_no = !took && /^\s*(?:no|nope|nah|not (?:yet|now|right now)|later|maybe later|no thanks?|not really|i'?m good|all good|that'?s (?:it|all))\b/i.test(message);
      console.log('[cta] previous ' + lc.id + ' ' + (took ? 'TAKEN' : said_no ? 'not taken — declined, not offered again this session' : 'not taken (customer moved on)') + ' — ' + JSON.stringify(message.slice(0, 60)));
      if (said_no) state.ctaDeclined = [...new Set([...(state.ctaDeclined || []), lc.id])];
      saveFlowState();
      // "yes" to "place the order, or send you a PDF proposal?" names neither: ask which, in code (the LLM
      // would guess). "place the order" / "send the proposal" route normally below.
      if (took && lc.id === 'basket.offer_order_or_proposal' && !/\bplace\b|\border\b|checkout|proposal|\bpdf\b|\bquote\b/i.test(message)) {
        console.log('[cta] basket.offer_order_or_proposal: bare yes — asking which');
        const rW = 'Sure — shall I place the order, or send you the PDF proposal?';
        return res.json({ text: rW, response: rW });
      }
      if (took && !state.orderStep && !state.proposalStep) {
        const pr = lc.id === 'sub.offer_named' ? lc.substitute : lc.product;
        if ((lc.id === 'search.offer_qty' || lc.id === 'search.add_more' || lc.id === 'sub.offer_named') && pr && pr.name) {
          const nM = message.match(/^\s*(\d{1,3})\b/) || message.match(/\b(\d{1,3})\s*(?:bottles?|x)\b/i);
          const q = lc.id === 'search.offer_qty' ? (nM ? parseInt(nM[1]) : lc.qty) : 0;
          const r = await applyBasketSubstitute(sessionKey, email, '', pr.name, pr.price, pr.size, { add: true });
          if (r && r.success) {
            let nm = r.with || pr.name;
            try { const it = JSON.parse(state.lastLineItems || '[]'); const nk = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); const row = it.find(x => nk(x.name).indexOf(nk(nm).slice(0, 12)) >= 0); if (row) { nm = row.name; if (q > 0) { row.qty = q; row.quantity = q; row.qty_confirmed = true; state.lastLineItems = JSON.stringify(it); } } } catch (e) {}
            if (q > 0) {
              saveFlowState(); events.action('updated_basket');
              console.log('[cta] ' + lc.id + ' accepted -> ' + q + 'x ' + nm + ' added');
              const rA = 'Got it — ' + q + 'x ' + nm + ' added to your order.';
              return res.json({ text: rA, response: rA });
            }
            state.pendingQtyFor = nm; saveFlowState(); events.action('updated_basket');
            console.log('[cta] ' + lc.id + ' accepted -> ' + nm + ' added, asking how many');
            const rH = 'Added *' + nm + '*. How many would you like?';
            return res.json({ text: rH, response: rH });
          }
          console.log('[cta] ' + lc.id + ' accepted but the add failed (' + ((r && r.error) || '?') + ') — falling through');
        } else if ((lc.id === 'basket.offer_checkout' || lc.id === 'proposal.offer_order') && !/\bplace\b.*\border\b/i.test(message)) {
          console.log('[cta] ' + lc.id + ' accepted -> continuing as "place the order"');
          message = 'place the order'; msgLower = message;
        } else if (lc.id === 'basket.offer_proposal' && !/\b(proposal|pdf|quote)\b/i.test(message)) {
          console.log('[cta] ' + lc.id + ' accepted -> continuing as a proposal request');
          message = 'generate a PDF proposal'; msgLower = message.toLowerCase();
        }
      }
    }
    // SHADOW classify: label every turn with the LLM classifier and log it beside what
    // the regex/state-machine path does — acting on NOTHING yet. Once real traffic shows
    // agreement (or shows where the classifier is better), it takes over routing.
    const isInternalMsg = /^__/.test(message) || /^\d{1,2}:\d{2}\s*[AP]M\s*-\s*\d{1,2}:\d{2}\s*[AP]M/i.test(message) || (state.orderData && message === state.orderData.delivery_datetime);
    if (!isInternalMsg) try {   // skip internal sentinels / replayed windows
      const { classifyIntent } = require('./classify-intent.js');
      const lastR = (lastRepliesBySession[sessionKey] || []).slice(-1)[0] || '';
      // numbered_list = a PRICED option list; "1. How long is the event? 2. What's your budget?" is questions, not picks.
      const lastKind = /how many/i.test(lastR) ? 'how_many' : /^\s*1[\.\)]\s[^\n]*\$\s?\d/m.test(lastR) ? 'numbered_list' : /shall i (go ahead|place)|\(yes\/no\)/i.test(lastR) ? 'yes_no' : /full name|phone number|email/i.test(lastR) ? 'contact_question' : /date and time|what time/i.test(lastR) ? 'time_question' : 'other';
      let bsz = 0; try { bsz = JSON.parse(state.lastLineItems || '[]').length; } catch (e) {}
      classifyIntent(message, { lastKind, orderStep: state.orderStep, basketSize: bsz, lastQuestion: lastR.slice(0, 160) }).then(c => {
        console.log('[classify] ' + c.intent + ' (' + c.confidence.toFixed(2) + (c.ref ? ', ref=' + JSON.stringify(c.ref) : '') + (c.qty ? ', qty=' + c.qty : '') + ') [' + c.source + '] lastKind=' + lastKind + ' step=' + (state.orderStep || '-') + ' | ' + JSON.stringify(message).slice(0, 60));
      }).catch(() => {});
    } catch (e) {}
    if (state.step !== 'ready') {
      // Shouldn\'t happen but fallback
      const ask = 'What is your delivery address? (Include street, city, state, and zip)';
      state.step = 'addr_new';
      return res.json({ text: ask, response: ask });
    }

    // ── PLACED ORDER: reopen only with the customer's permission ───────────
    // After an order is placed the cart is empty (onOrderPlaced). The customer may not have
    // paid yet and may want to change it. When they refer to the basket/order with nothing
    // new in the cart, say the order is already placed and ASK: reopen it (items go back in
    // the basket, their request then runs on it) or start a new, separate order. Decided
    // here, in code — the LLM never re-populates a placed order on its own.
    if (state.placedOrder && !state.placedOrder.resolved && !state.orderStep && !state.proposalStep && !isInternalMsg) {
      const po = state.placedOrder;
      let cartN = 0; try { cartN = JSON.parse(state.lastLineItems || '[]').length; } catch (e) {}
      const heldRequest = () => { const h = po.heldMessage; message = h; msgLower = h.toLowerCase().trim().replace(/\*/g, '').replace(/_/g, ''); };
      if (po.awaitingReopen) {
        const wantsNew = /^(no|nope|nah|2|new|separate|fresh)\b/.test(msgLower) || /\b(new|separate|another|different) order\b|\bstart (a )?(new|fresh|over)\b/.test(msgLower);
        const wantsReopen = !wantsNew && (/^(yes|yeah|yep|yup|sure|ok|okay|please|1|reopen|re-open|go ahead)\b/.test(msgLower) || /\b(re-?open|change (it|that|the order)|modify|edit (it|the order)|update (it|the order))\b/.test(msgLower));
        if (wantsReopen) {
          state.lastLineItems = po.line_items; po.reopened = true; po.resolved = true; po.awaitingReopen = false;
          console.log('[order] reopened ' + po.order_id + ' at customer request — basket restored; replaying: ' + JSON.stringify(po.heldMessage).slice(0, 80));
          heldRequest(); saveFlowState();
          context.order_change_note = 'The customer\'s order #' + po.order_id + ' was already placed and they just asked to REOPEN it: its items are back in the basket. Handle their request on that basket. When they place it again, a NEW order and payment link are created — tell them to pay only the new link, not the earlier one.';
        } else if (wantsNew) {
          po.resolved = true; po.awaitingReopen = false;
          console.log('[order] customer chose a new order; ' + po.order_id + ' left as placed — replaying: ' + JSON.stringify(po.heldMessage).slice(0, 80));
          heldRequest(); saveFlowState();
        } else if (!po.reasked) {
          po.reasked = true; saveFlowState();
          console.log('[order] reopen answer unclear — asking once more: ' + JSON.stringify(message).slice(0, 60));
          const rq = 'Just to check — should I *reopen* order #' + po.order_id + ' so you can change it, or start a *new* separate order?';
          return res.json({ text: rq, response: rq });
        } else {
          po.resolved = true; po.awaitingReopen = false; saveFlowState();
          console.log('[order] reopen still unclear after re-ask — leaving ' + po.order_id + ' as placed, handling message as new');
        }
      } else if (cartN === 0 && /\b(add|also|remove|drop|take out|swap|replace|change|instead|more|less|fewer|update|edit|increase|decrease|cart|basket|my order|the order|this order|that order|place (the |an |my )?order|order it|check ?out|re-?order)\b/i.test(message)) {
        po.awaitingReopen = true; po.heldMessage = message; saveFlowState();
        let items = []; try { items = JSON.parse(po.line_items || '[]'); } catch (e) {}
        const summary = items.slice(0, 3).map(i => (i.qty || i.quantity || 1) + 'x ' + i.name).join(', ') + (items.length > 3 ? ' and ' + (items.length - 3) + ' more' : '');
        const link = po.payment_url ? (format === 'slack' ? '<' + po.payment_url + '|payment link>' : po.payment_url) : '';
        console.log('[order] request touches placed order ' + po.order_id + ' with an empty cart — asking before reopening: ' + JSON.stringify(message).slice(0, 80));
        const rq = 'Heads up — I already placed your order #' + po.order_id + (summary ? ' (' + summary + ')' : '') + '.' + (link ? ' Payment is still open: ' + link + '.' : '') +
          '\n\nWould you like me to *reopen* it? I\'ll put those items back in your basket so you can make changes and place an updated order (you\'d then pay the new link instead). Or I can start a *new*, separate order.' +
          '\n\nIf you\'ve already paid, reply *new* and contact bevvi-support@getbevvi.com to change the paid order.';
        return res.json({ text: rq, response: rq });
      }
    }

    // ── Email support request ───────────────────────────────────────────────
    const emailSupportTriggers = ['email support', 'contact support', 'notify the team', 'notify support', 'request this product', 'can you email support', 'reach out to support', 'request that we carry'];
    if (emailSupportTriggers.some(t => msgLower.includes(t)) && !state.orderStep && !state.proposalStep) {
      const caps = getCapabilities(format);
      if (!caps.can_email_support) {
        const noEmail = 'I\'m not able to send a request to our support team from this channel right now — you can reach them directly at bevvi-support@getbevvi.com. Anything else I can help with?';
        return res.json({ text: noEmail, response: noEmail });
      }
      try {
        const subject = 'Customer request via Rachel (' + format + ')';
        const body = 'Channel: ' + format + '\n' +
          'Customer email: ' + (email || 'unknown') + '\n' +
          'Location: ' + (context?.kitchen_location || 'unknown') + '\n' +
          'Delivery zip: ' + (state.zip || 'unknown') + '\n' +
          'Delivery address: ' + (state.address || 'unknown') + '\n' +
          'Timestamp: ' + new Date().toISOString() + '\n\n' +
          'Customer message:\n' + message;
        await sendSupportEmail(subject, body);
        const confirmMsg = 'Done — I\'ve sent your request to our support team at bevvi-support@getbevvi.com. They\'ll follow up with you directly. Anything else I can help with?';
        return res.json({ text: confirmMsg, response: confirmMsg });
      } catch (e) {
        console.error('[email-support] send failed:', e.message);
        const errMsg = 'Sorry, I ran into an issue sending that to our support team — you can reach them directly at bevvi-support@getbevvi.com. Anything else I can help with?';
        return res.json({ text: errMsg, response: errMsg });
      }
    }

    // ── Order state machine ────────────────────────────────────────────────────
    const orderTriggers = ['place the order', 'place order', 'place an order', 'order it', 'buy it', 'purchase', 'order this', 'checkout', 'i want to order', 'want to place', 'create the order', 'create order', 'create an order', 'want to create the order', 'submit the order', 'go ahead with the order', 'proceed with the order'];
    // Also catch "order a bottle of X" / "order 2 bottles of X" / "order me a X" — a direct
    // request to order a specific product, not just the fixed confirmation phrases above.
    // Anchored on "order" near the start of the message (not "in order to...") followed by
    // a quantity word, to avoid misfiring on unrelated sentences that merely contain "order".
    const orderProductPattern = /^(order|buy|get|i want|i'd like|i need)\s+(me\s+)?(a|an|\d+|one|two|three|four|five)\s+\w/i;
    const isDirectOrderRequest = orderProductPattern.test(message.trim()) && /\border\b|\bbuy\b/i.test(message.slice(0, 15));
    // ORDER INTENT (regex), not a literal phrase list. Real bug: "lets order" matched
    // none of the fixed phrases, so the deterministic order flow never engaged and the
    // LLM improvised its own — different wording, different question order, none of
    // the pre-fill/skip/validation safeguards. Natural forms now all route here.
    const orderIntentRe = /^\s*(?:ok(?:ay)?[,!]?\s*)?(?:(?:let'?s|lets)\s+(?:order|do it|go(?!\s+with\b)|place|buy|proceed|finalize|check ?out)|(?:i(?:'m| am)\s+)?ready\s+to\s+(?:order|buy|check ?out|place)|place\s+(?:the|this|my|an?)?\s*order|order\s+(?:it|this|now|that|these)|go\s+ahead(?:\s+and\s+(?:order|place|buy))?|proceed(?:\s+with\s+(?:the\s+)?order)?|finali[sz]e(?:\s+(?:the|my)\s+order)?|check ?out|buy\s+(?:it|this|these|now)|i(?:'ll| will)\s+take\s+(?:it|them|these|that)|submit(?:\s+(?:the|my)\s+order)?|confirm\s+(?:the|my)\s+order|complete\s+(?:the|my)\s+order|make\s+(?:the|it\s+an?)\s+order|purchase(?:\s+(?:it|this|these))?)\b/i;
    // CLASSIFIER ROUTING (safe subset). Awaited here — only for messages not already
    // inside a deterministic step — and only high-confidence labels for intents where
    // the classifier is clearly better than regex ('lets order' missed the phrase list;
    // 'can you ensure the quantities are correct' is a basket check). Everything else
    // falls through to the existing path unchanged; regex remains the fallback.
    if (isQA) { state.qa = true; state.eventParams = Object.assign({}, state.eventParams || {}, { qa: true }); }
    // Proposal modifiers said WITH the request ('generate the proposal without the subtotals',
    // 'just the total', 'tax exempt') are captured here and injected into the generate call
    // deterministically — the proposal flow asks client/date first, and by the time the
    // tool call is built the LLM had lost the modifier (real bug: subtotals still shown).
    if (/\b(proposal|pdf|quote)\b/i.test(message)) {
      const po = Object.assign({}, state.proposalOpts || {});
      if (/\b(without|no|drop|hide|skip|remove)\b[^.]{0,30}\bsub-?totals?\b/i.test(message) || /\bsub-?totals?\b[^.]{0,20}\b(off|out|removed|hidden)\b/i.test(message)) po.hide_subtotals = true;
      if (/\b(just|only)\s+(the\s+)?(grand\s+)?total\b|\btotals?\s+only\b|\bno\s+(fee\s+)?breakdown\b|\bwithout\s+(the\s+)?(fee\s+)?breakdown\b|\b(don'?t|do not)\s+show\s+(the\s+)?(tax|tip|service|fees)\b/i.test(message)) po.totals_only = true;
      if (/\btax[- ]?exempt\b|\bno\s+(sales\s+)?tax\b|\bset\s+tax\s+to\s+(0|zero)\b/i.test(message)) po.tax_exempt = true;
      if (Object.keys(po).length) { state.proposalOpts = po; state.eventParams = Object.assign({}, state.eventParams || {}, { proposalOpts: po }); saveFlowState(); console.log('[proposal] options captured:', JSON.stringify(po)); }
    }
    // Answer to the add-item confirmation ("I found X — $1,099.99 a bottle. Want me to add it? If so,
    // how many bottles?"). A yes or a quantity adds it; anything else lets the offer lapse (logged)
    // and the message is handled normally.
    if (state.pendingAddOffer && state.pendingAddOffer.confirm && !state.orderStep && !state.proposalStep && !isInternalMsg) {
      const off = state.pendingAddOffer; state.pendingAddOffer = null; saveFlowState();
      const NW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, 'a dozen': 12, dozen: 12 };
      const qm = msgLower.trim().replace(/[.!]+$/, '').match(/^(?:(?:yes|yeah|yep|sure|ok(?:ay)?|please)[,!\s]+)?(?:(?:add|get|give me|i'?ll take|make it|let'?s do|lets do)\s+)?(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a dozen|dozen)(?:\s*x)?(?:\s+(?:bottles?|of (?:them|it|those)))?(?:\s+please)?$/);
      const yes = /^\s*(yes|yes please|yeah|yep|sure|ok|okay|please|do it|do that|add it|go ahead|absolutely|sounds good)\b/i.test(message);
      if (qm || yes) {
        const q = qm ? (NW[qm[1]] || parseInt(qm[1])) : off.qty;
        await applyBasketSubstitute(sessionKey, email, '', off.name, off.price, off.size);
        retirePendingFor(state, off.name);
        const nzA = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const labelA = off.name + (off.size && nzA(off.name).indexOf(nzA(off.size)) < 0 ? ' — ' + off.size : '') + ' — ' + usd(off.price);
        console.log('[add-confirm] accepted ' + JSON.stringify(message.slice(0, 40)) + ' -> ' + off.name + (q ? ' x' + q : ' (quantity to ask)'));
        if (q > 0) {
          try { const it = JSON.parse(state.lastLineItems || '[]'); const row = it.find(x => nzA(x.name) === nzA(off.name)); if (row) { row.qty = q; row.quantity = q; row.qty_confirmed = true; state.lastLineItems = JSON.stringify(it); } } catch (e) {}
          saveFlowState();
          const rQ = 'Added ' + q + 'x ' + labelA + (q > 1 ? ' (' + usd(off.price * q) + ')' : '') + '. Would you like to see the estimated full price, place the order, generate a PDF proposal, or make any changes?';
          return res.json({ text: rQ, response: rQ });
        }
        state.pendingQtyFor = off.name; saveFlowState();
        const rY = 'Added ' + labelA + '. How many bottles would you like?';
        return res.json({ text: rY, response: rY });
      }
      console.log('[add-confirm] offer for ' + off.name + ' lapsed — reply is not a yes or a quantity: ' + JSON.stringify(message.slice(0, 60)));
    }
    let clsIntent = null, clsRef = '';
    // clear stale classifier label: eventParams persists across turns (guests/budget for
    // rebuilds), so last turn's 'recommend' must not rewrite this turn's product query.
    if (state.eventParams && state.eventParams.classified_intent) { delete state.eventParams.classified_intent; delete state.eventParams.classified_ref; }
    // A pending "how many?" only owns QUANTITY-shaped replies (handled below); anything else is
    // classified. Real bug (Sep 28 QA): "Kendall Pinot" while a quantity was pending skipped
    // routing and the LLM claimed the Pinot was "already in your basket".
    const qtyShaped = /^\s*(\d{1,3}|one|two|three|four|five|six|a dozen)\s*(?:x|bottles?|cases?|packs?)?\s*\.?\s*$/i.test(message);
    // The LLM's own "How many bottles?" gets a code-owned answer too. Real bug (Sep 29 QA): after
    // "do you have Tito's 1.75 L?" (search result captured as the basket at qty 1), "3" went to the
    // LLM, which replied "adding 3 bottles" and made no tool call — the basket stayed at 1. Bind the
    // quantity to the one line the question is about, then the pendingQtyFor handler below sets it.
    if (qtyShaped && !state.pendingQtyFor && !state.pendingQtyChange && !state.orderStep && !state.proposalStep && !isInternalMsg) {
      const lastRq = (lastRepliesBySession[sessionKey] || []).slice(-1)[0] || '';
      // Only a BOTTLE question: "How many guests?" answered "30" must never become 30 bottles.
      const qtyQ = (lastRq.match(/[^?\n]*\bhow many\b[^?\n]*\?/gi) || []).pop() || '';
      if (/\bhow many\s+(?:bottles?|cases?|packs?|cans?|of (?:those|them|these|it)|would you like|do you (?:want|need))\b/i.test(qtyQ) && !/\b(guests?|people|persons|hours?|attendees)\b/i.test(qtyQ) && !/^\s*\d+[.)]\s/m.test(lastRq)) {
        let itq = []; try { itq = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
        const nq = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const named = itq.filter(x => !x.qty_confirmed && nq(lastRq).indexOf(nq(String(x.name || '').replace(/\s*-\s*[\d.]+\s*(?:ml|l|oz)\s*$/i, '')).slice(0, 12)) >= 0);
        const line = named.length === 1 ? named[0] : itq.length === 1 && !itq[0].qty_confirmed ? itq[0] : null;
        if (line) { state.pendingQtyFor = line.name; saveFlowState(); console.log('[qty] answer to the LLM\'s "how many" bound to ' + JSON.stringify(line.name) + ' (' + (named.length === 1 ? 'named in the question' : 'only basket line') + ')'); }
        else console.log('[qty] "how many" answer not bound — ' + (itq.length ? named.length + ' unconfirmed lines named in the question, ' + itq.length + ' in the basket' : 'basket empty') + '; LLM handles it');
      }
    }
    if (!state.orderStep && !state.proposalStep && !(state.pendingQtyFor && qtyShaped) && !state.pendingQtyChange && !isInternalMsg) {   // a pending change-vs-add answer is handled below (pendingQtyChange)
      try {
        const { classifyIntent, groundedRef } = require('./classify-intent.js');
        const lastR2 = (lastRepliesBySession[sessionKey] || []).slice(-1)[0] || '';
        let bsz2 = 0; try { bsz2 = JSON.parse(state.lastLineItems || '[]').length; } catch (e) {}
        const cr = await classifyIntent(message, { lastKind: 'other', orderStep: null, basketSize: bsz2, lastQuestion: lastR2.slice(0, 160) });
        // Per-intent thresholds: the cost of a wrong route differs. show_basket is harmless
        // if wrong (0.65); place_order starts a multi-step flow (0.75); add_item changes
        // the basket (0.8).
        const THRESH = { place_order: 0.75, show_basket: 0.65, change_time: 0.75, change_instructions: 0.75, change_contact: 0.75, recommend: 0.65, add_item: 0.8 };
        // place_order with an EMPTY basket and named products is a build request, not a
        // checkout (real bug: "I'd like to order 3 bottles of Tito's…" at 0.78 jumped to
        // "What is your full name?" with nothing in the basket).
        const clsUsable = /^(llm|rule)/.test(cr.source);
        // A product ref must be words the customer wrote — never one the classifier copied from
        // Rachel's list ("Put it in the cart" -> ref "Kendall-Jackson ... Cabernet", added unasked).
        if (clsUsable && (cr.intent === 'add_item' || cr.intent === 'select_option') && cr.ref) {
          const g = groundedRef(cr.ref, message);
          if (!g) { console.log('[classify] ref ' + JSON.stringify(cr.ref) + ' is not in the message — dropped (no product named)'); cr.ref = ''; }
        }
        // A pick by NAME is resolved like an add: the add_item handler checks Rachel's recent
        // option lists first (matchListedByName), then the catalog. Real bug (Sep 28 QA): the same
        // "Kendall Pinot" was labeled add_item once and select_option once; select_option was not
        // routed, the pick-list gate saw no list (it was two replies back) and the LLM improvised.
        // Numbered/grouped picks ("2", "Pinot Noir 2") stay with the pick-list/multi-pick resolvers.
        // The MESSAGE must be one pick too: the classifier sometimes names one product for a
        // several-pick message (Sep 29 smoke: "Sauvignon Blanc 1, Pinot Noir 1, rosé 1" -> ref
        // "Justin Sauvignon Blanc"; add_item took the turn and the other two picks were lost).
        const selParts = require('./multipick.js').splitSelection(message);
        if (clsUsable && cr.intent === 'select_option' && cr.ref && (selParts.length >= 2 || /\?/.test(message))) {
          console.log('[classify] select_option by name ' + JSON.stringify(cr.ref) + ' NOT routed to add_item — message has ' + (selParts.length >= 2 ? selParts.length + ' parts' : 'a question') + ' (multi-pick resolver / LLM)');
        } else if (clsUsable && cr.intent === 'select_option' && cr.ref && !/\d/.test(cr.ref) && !/[,;&]/.test(cr.ref)) {
          console.log('[classify] select_option by name ' + JSON.stringify(cr.ref) + ' -> add_item (resolved against the listed options)');
          cr.intent = 'add_item';
        }
        if (clsUsable && cr.intent === 'place_order' && bsz2 === 0 && (cr.ref || /\b\d+\s*(bottles?|cases?|x)\b/i.test(message))) {
          console.log('[classify] place_order with empty basket + products -> treated as build, not checkout');
          cr.intent = 'custom_list';
        }
        if (!(clsUsable && THRESH[cr.intent] !== undefined && cr.confidence >= THRESH[cr.intent])) {
          if (clsUsable && THRESH[cr.intent] !== undefined) events.note({ low_conf_intent: cr.intent, intent_conf: Math.round(cr.confidence * 100) / 100 });
          console.log('[classify->no-route] ' + cr.intent + ' ' + cr.confidence.toFixed(2) + ' [' + cr.source + '] — ' + (!clsUsable ? 'classifier failed' : THRESH[cr.intent] === undefined ? 'not a routed intent' : 'below threshold ' + THRESH[cr.intent]) + ' | ' + JSON.stringify(message).slice(0, 60));
        }
        if (clsUsable && THRESH[cr.intent] !== undefined && cr.confidence >= THRESH[cr.intent]) {
          clsIntent = cr.intent; clsRef = cr.ref || ''; var clsQty = cr.qty || 0;
          events.note({ intent: clsIntent, intent_conf: Math.round(cr.confidence * 100) / 100 });
          console.log('[classify->route]', clsIntent, cr.confidence.toFixed(2), '[' + cr.source + ']', (clsRef ? 'ref=' + JSON.stringify(clsRef) : ''), '|', JSON.stringify(message).slice(0, 60));
          // Hand the label to rachel.js's executeTool via eventParams (already threaded
          // through; context is not) so the recommendation rewrite fires on it.
          state.eventParams = Object.assign({}, state.eventParams || {}, { classified_intent: clsIntent, classified_ref: clsRef });
        }
      } catch (e) { console.log('[classify->no-route] error:', e.message); }
    }
    const hasOrderIntent = clsIntent === 'place_order' || orderIntentRe.test(message) || orderTriggers.some(t => msgLower.includes(t));
    if ((hasOrderIntent || isDirectOrderRequest) && state.orderStep && state.orderStep !== 'placing' && !state.proposalStep) {
      // An explicit order request always restarts the flow. Real bug: a crash mid-entry
      // left orderStep='confirm' on disk; the next 'place the order' didn't trigger and
      // fell into the stale confirm handler ('$0.00 estimated'). Same guard proposals have.
      console.log('[order] explicit re-request while orderStep=' + state.orderStep + ' — resetting stale flow (details preserved)');
      { const od0 = state.orderData || {};
        if (od0.name || od0.phone) state.savedCustomer = { name: od0.name || (state.savedCustomer || {}).name || '', phone: od0.phone || (state.savedCustomer || {}).phone || '', email: od0.email || (state.savedCustomer || {}).email || '' };
        if (od0.delivery_datetime_iso) { state.savedDeliveryIso = od0.delivery_datetime_iso; state.savedDeliveryWindow = od0.delivery_window_display || od0.delivery_datetime; state.savedDeliveryLabel = od0.delivery_date_label || ''; }
        if (od0.delivery_instructions) state.savedInstructions = od0.delivery_instructions; }
      state.orderStep = null; state.orderData = null; saveFlowState();
    }
    // Checkout starts: link any basket line with no catalog product NOW (line-resolve.js, exact matches only).
    // The delivery-time check reads the store from the lines, so an unlinked basket couldn't even confirm a
    // delivery window (Sep 29 QA: "I couldn't confirm a delivery window" on a hand-built basket). Unmatched
    // lines are asked about before any checkout question.
    if ((hasOrderIntent || isDirectOrderRequest) && !state.orderStep && !state.proposalStep && state.zip) {
      let itemsE = []; try { itemsE = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
      if (itemsE.some(LR.needsLink)) {
        const rr = await LR.resolveLines(itemsE, (n, c) => catalogSearch(state.zip, n, c));
        if (rr.linked.length) { state.lastLineItems = JSON.stringify(rr.items); saveFlowState(); }
        if (rr.unresolved.length) {
          console.log('[order] checkout held — ' + rr.unresolved.length + ' line(s) not linked to the catalog, customer asked: ' + JSON.stringify(rr.unresolved.map(u => u.name)));
          const tE = 'Before I start the order I need you to confirm ' + (rr.unresolved.length === 1 ? 'one item' : rr.unresolved.length + ' items') + " I can't match exactly in this store's catalog:\n" +
            rr.unresolved.map(u => '• ' + u.name + ' — ' + u.reason + (u.options.length ? '. Closest: ' + u.options.join('; ') : '')).join('\n') +
            '\n\nWhich product should I use for ' + (rr.unresolved.length === 1 ? 'it' : 'each') + ' — or should I remove ' + (rr.unresolved.length === 1 ? 'it' : 'them') + '?';   // a real question: no CTA appended after it
          return res.json({ text: tE, response: tE });
        }
      }
    }
    if (clsIntent === 'show_basket') {
      events.action('showed_basket');
      try {
        const items = JSON.parse(state.lastLineItems || '[]');
        // single-product estimate: if the previous reply was a lookup of ONE product that
        // isn't in the basket, 'estimated price' means THAT product (real confusion:
        // 'price of a Duckhorn cab' -> 'estimated price' -> got the basket total instead).
        {
          const lastR = (lastRepliesBySession[sessionKey] || []).slice(-1)[0] || '';
          const one = lastR.replace(/\*/g, '').match(/^\s*([^\n]+?)\s+—\s+([^\n—$]*?)\s*—\s*\$([\d,.]+)\s*$/m);
          const nk = x => String(x||'').toLowerCase().replace(/[^a-z0-9]/g,'');
          const isList = /^\s*1[\.\)]\s/m.test(lastR);
          // Never when the customer names the basket: "show my basket" after Rachel quoted one
          // product got that product's estimate plus 'say "show my basket"' (Sep 29 QA).
          const asksBasket = /\b(basket|cart|my order|order so far)\b/i.test(message);
          if (one && !isList && !asksBasket && !items.some(it => nk(it.name).indexOf(nk(one[1]).slice(0, 12)) >= 0)) {
            const pp = parseFloat(one[3].replace(/,/g, '')) || 0;
            const tax1 = Math.round(pp * 10) / 100, svc1 = Math.round(pp * 10) / 100, { tip: tip1, label: tipL1 } = tipFor(state, pp), del1 = 25.00;
            const g1 = Math.round((pp + tax1 + svc1 + tip1 + del1) * 100) / 100;
            const r1 = 'Estimated all-in for 1x ' + one[1].trim() + (one[2] ? ' — ' + one[2].trim() : '') + ':\n\n' +
              'Product: $' + pp.toFixed(2) + '\nEstimated tax (10%): $' + tax1.toFixed(2) + '\nService charge (10%): $' + svc1.toFixed(2) +
              '\n' + tipL1 + ': $' + tip1.toFixed(2) + '\nEstimated delivery: $' + del1.toFixed(2) + '\n*Estimated total: $' + g1.toFixed(2) + '*' +
              '\n\nEstimates — actual totals may vary.' +
              (items.length ? '\n\n(Your basket has ' + items.length + ' other item' + (items.length === 1 ? '' : 's') + ' — say "show my basket" for that total.)' : '') +
              '\n\nWant me to add it to your order?';
            state.pendingAddOffer = { name: one[1].trim(), size: (one[2] || '').trim(), price: pp }; saveFlowState();
            return res.json({ text: r1, response: r1 });
          }
        }
        if (items.length) {
          const lines = items.map(li => (li.qty || li.quantity || 1) + 'x ' + li.name + ' — $' + (parseFloat(li.price) || 0).toFixed(2) + ' ea = $' + ((li.qty || li.quantity || 1) * (parseFloat(li.price) || 0)).toFixed(2));
          const tot = items.reduce((a, li) => a + (li.qty || li.quantity || 1) * (parseFloat(li.price) || 0), 0);
          // Full estimate, same math as the order summary. Real regression: 'estimated
          // price' routed here (show_basket 0.90) and got only the product total — no tax,
          // service, tip, or delivery.
          const tax = Math.round(tot * 10) / 100, svc = Math.round(tot * 10) / 100, { tip, label: tipL } = tipFor(state, tot), del = 25.00;
          const grand = Math.round((tot + tax + svc + tip + del) * 100) / 100;
          const reply = 'Here\'s your current basket:\n\n' + lines.join('\n') +
            '\n\nProduct total: $' + tot.toFixed(2) +
            '\nEstimated tax (10%): $' + tax.toFixed(2) +
            '\nService charge (10%): $' + svc.toFixed(2) +
            '\n' + tipL + ': $' + tip.toFixed(2) +
            '\nEstimated delivery: $' + del.toFixed(2) +
            '\n*Estimated grand total: $' + grand.toFixed(2) + '*' +
            '\n\nEstimates — actual totals may vary.\n\nWould you like to place the order, generate a PDF proposal, or make any changes?';
          return res.json({ text: reply, response: reply });
        }
      } catch (e) {}
    }
    // ADD_ITEM (deterministic). Real gap: 'I want to add a Macallan 18' -> the LLM found
    // exactly one match and asked 'Would you like to add this?' — the customer had
    // already said add, moved on, and the basket never got it. One match -> add now
    // (qty from the message, else ask); several -> numbered list (the pick-list handler
    // resolves it); none -> say so.
    // A multi-item list is not an add. Real bug: a five-line shopping list was labeled
    // add_item with the WHOLE list as ref; one search returned six vodkas, presented as
    // "options for vodka x3, St-Germain x1, ..." — the customer rightly asked why she was
    // being asked item by item. Two or more quantity tokens or lines -> custom_list path.
    const qtyTokens = (message.match(/\b\d+\s*(?:x\b|bottles?|cases?|packs?|btls?)\b|\b\d+x\b/gi) || []).length;
    const listLines = message.split(/\n/).map(l => l.trim()).filter(Boolean).length;
    // Bare quantities count too, one per comma/"and" part: "5 Bacardi ... 750ml and 4 Patron Silver
    // 750ml" (Sep 29 QA) was added as the Bacardi alone — the Patron was silently dropped.
    const qtyParts = message.split(/\s*(?:,|;|\band\b|\bplus\b|&)\s*/i)
      .filter(pt => /^(?:(?:i\s+)?(?:need|want|add|get|order|take|have|also|plus)\s+)*\d{1,3}\s+(?!(?:ml|l|oz|year|yr|years)\b)[a-z]/i.test(pt.trim())).length;
    const isMultiItem = qtyTokens >= 2 || listLines >= 2 || qtyParts >= 2;
    // Several names in one ref ('Decoy, Louis Jadot, Wolffer') are picks, not one product —
    // real bug: searched as one string, 0 matches, "couldn't find" after Rachel had just
    // listed all three. Defer to the multi-pick resolver / LLM.
    const multiName = clsRef && clsRef.split(/\s*(?:,|;|\band\b|\bplus\b|&)\s*/i).filter(x => x.trim().length > 1).length >= 2;
    if (clsIntent === 'add_item' && (isMultiItem || multiName)) { console.log('[add-item] multi-item/multi-name — deferring'); clsIntent = null; }
    if (clsIntent === 'add_item' && clsRef && !state.orderStep && !state.proposalStep) {
      try {
        // A name from Rachel's own recent option list is that product — never re-searched
        // (multipick.js matchListedByName). Several listed fits -> ask among THOSE only.
        const listedM = require('./multipick.js').matchListedByName(require('./classify-intent.js').groundedRef(clsRef, message) || clsRef, (lastRepliesBySession[sessionKey] || []).slice(-3));
        const listed = listedM && listedM.matches.length ? listedM.matches.map(o => ({ name: o.name, price: o.price, salePrice: o.price, sizeStr: o.size })) : null;
        if (listedM) console.log('[add-item] listed-name ' + JSON.stringify(clsRef) + ': ' + listedM.matches.length + ' of ' + listedM.listSize + ' listed options fit' + (listed ? ' -> ' + JSON.stringify(listed.map(p => p.name)) : ' — searching the catalog'));
        let prods = listed;
        if (!prods) {
          const rr = await fetch('http://127.0.0.1:8300/mcp', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'product_query', arguments: { queries: [{ name: clsRef.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim(), limit: 8 }], zip: state.zip || '', email: email } } })
          });
          const rt = await rr.text(); const rl = rt.split('\n').find(l => l.startsWith('data:'));
          const rd = rl ? JSON.parse(rl.replace('data:', '').trim()) : null;
          const rres = rd ? JSON.parse(rd.result.content[0].text) : null;
          prods = (rres && rres.results && rres.results[0] && rres.results[0].products) || [];
        }
        // Relevance on DESCRIPTIVE requests. Real case: 'Red Wine (French Burgundy) 750ml'
        // matched the generic words and returned Chiantis and Merlots, presented as if they
        // fit. Keep only products whose names carry the request's distinctive terms (with
        // synonyms: Burgundy<->Bourgogne); if none do, say so and show the closest.
        const WINE_SYN = { burgundy: ['bourgogne','burgundy'], bourgogne: ['bourgogne','burgundy'], bordeaux: ['bordeaux','medoc','pauillac','margaux','st julien','saint julien','pomerol','st emilion','saint emilion'], chianti: ['chianti'], rioja: ['rioja'], champagne: ['champagne'], prosecco: ['prosecco'], cava: ['cava'], sancerre: ['sancerre'], chablis: ['chablis'], barolo: ['barolo'], brunello: ['brunello'], napa: ['napa'], sonoma: ['sonoma'], provence: ['provence'], tuscan: ['tuscan','toscana'], rhone: ['rhone','rhône','cotes du rhone'], malbec: ['malbec'], pinot: ['pinot'], cabernet: ['cabernet'], chardonnay: ['chardonnay'], sauvignon: ['sauvignon'], riesling: ['riesling'], syrah: ['syrah','shiraz'], zinfandel: ['zinfandel'], merlot: ['merlot'], tempranillo: ['tempranillo'], sangiovese: ['sangiovese'], nebbiolo: ['nebbiolo'] };
        const GENERIC = new Set(['red','white','rose','rosé','wine','wines','bottle','bottles','ml','l','oz','x','french','italian','spanish','californian','american','dry','sweet','sparkling','still','of','the','a','an','nice','good','some','case','pack']);
        const cleanRef = clsRef.replace(/[()]/g, ' ').toLowerCase();
        const distinct = cleanRef.split(/[^a-zà-ÿ]+/).filter(w => w.length > 2 && !GENERIC.has(w) && !/^\d+$/.test(w));
        const regionTerms = distinct.filter(w => WINE_SYN[w]);
        if (regionTerms.length && !listed) {
          const syns = [].concat(...regionTerms.map(w => WINE_SYN[w]));
          const nzr = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          // Search the synonyms themselves: 'french burgundy' matched 'I Love French' and
          // champagnes while the Louis Jadot BOURGOGNE never came back. Query each synonym
          // and merge before filtering.
          try {
            const seen = new Set(prods.map(pr => pr.product_id || pr.id || pr.name));
            const rrS = await fetch('http://127.0.0.1:8300/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'product_query', arguments: { queries: syns.slice(0, 3).map(sy => ({ name: sy, limit: 6 })), zip: state.zip || '', email: email } } }) });
            const rtS = await rrS.text(); const rlS = rtS.split('\n').find(l => l.startsWith('data:'));
            const rdS = rlS ? JSON.parse(rlS.replace('data:', '').trim()) : null;
            const rresS = rdS ? JSON.parse(rdS.result.content[0].text) : null;
            for (const q of ((rresS && rresS.results) || [])) for (const pr of (q.products || [])) { const k = pr.product_id || pr.id || pr.name; if (!seen.has(k)) { seen.add(k); prods.push(pr); } }
          } catch (e) { console.log('[add-item] synonym search error:', e.message); }
          // ALL region/varietal terms must appear ('napa cabernet' must not pass a Napa Merlot or a
          // Bonterra Cabernet); cap the list so 13 options never happen.
          const relevant = prods.filter(pr => regionTerms.every(t => WINE_SYN[t].some(sy => nzr(pr.name).indexOf(nzr(sy)) >= 0))).slice(0, 6);
          if (relevant.length) prods = relevant;
          else {
            const closest = prods.slice(0, 4).map((pr, i) => (i + 1) + '. ' + pr.name + ' — $' + (parseFloat(pr.salePrice || pr.price) || 0).toFixed(2)).join('\n');
            const rNR = 'I don\'t have a ' + regionTerms.join(' ') + ' wine in this store\'s catalog right now. The closest matches I found:\n\n' + closest + '\n\nWant one of these, or should I look for something else?';
            return res.json({ text: rNR, response: rNR });
          }
        }
        // Honor a stated size ("vodka 750ml" must not offer 1 L / 375 mL).
        const sizeM = clsRef.match(/(\d+(?:\.\d+)?)\s*(ml|l|oz)\b/i);
        if (sizeM && prods.length > 1) {
          const want = (sizeM[1] + sizeM[2]).toLowerCase();
          const nz = x => String(x || '').toLowerCase().replace(/\s+/g, '');
          const bySize = prods.filter(pr => nz(pr.sizeStr || pr.size).indexOf(want) >= 0 || nz(pr.name).indexOf(want) >= 0);
          if (bySize.length) prods = bySize;
        }
        console.log('[add-item] ref=' + JSON.stringify(clsRef) + ' matches=' + prods.length);
        events.note({ path: 'add_item' });
        if (prods.length === 1) {
          const pr = prods[0]; const price = parseFloat(pr.salePrice || pr.price) || 0; const size = pr.sizeStr || pr.size || '';
          const nz = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          let itemsA = []; try { itemsA = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
          // Already in the basket: say so, don't add a duplicate line.
          const same = itemsA.find(it => nz(it.name) === nz(pr.name) || nz(it.name).indexOf(nz(pr.name).slice(0, 14)) === 0);
          if (same) {
            const q0 = same.qty || same.quantity || 1;
            const bl = n => n + ' bottle' + (n === 1 ? '' : 's');
            // A stated quantity with set-wording IS the change. Real bug (Sep 29, Slack): "no make it to 5
            // bottles of Mount Gay Black Barrel" got "already in your order (4 bottles). Want to change the
            // quantity?", and the answer "change the quantity" then lost the 5 entirely.
            const setWords = /\b(make|change|chnage|update|set|bump|increase|decrease|reduce|instead|total|should be)\b|\bto\s+\d/i.test(message);
            if (clsQty > 0 && clsQty !== q0 && setWords) {
              try { const it = JSON.parse(state.lastLineItems || '[]'); const row = it.find(x => nz(x.name) === nz(same.name)); if (row) { row.qty = clsQty; row.quantity = clsQty; row.qty_confirmed = true; state.lastLineItems = JSON.stringify(it); } } catch (e) {}
              saveFlowState();
              console.log('[add-item] already in basket + stated qty with set-wording -> ' + same.name + ' ' + q0 + ' -> ' + clsQty);
              const rQ = 'Done — ' + same.name + ' updated from ' + bl(q0) + ' to ' + bl(clsQty) + '. Would you like to see the estimated full price, place the order, generate a PDF proposal, or make any changes?';
              return res.json({ text: rQ, response: rQ });
            }
            if (clsQty > 0 && clsQty !== q0) {
              state.pendingQtyChange = { name: same.name, qty: clsQty, from: q0 }; saveFlowState();
              console.log('[add-item] already in basket, qty ' + clsQty + ' stated without set-wording -> asking change vs add more');
              const rC = same.name + ' is already in your order (' + bl(q0) + '). Change it to ' + clsQty + ', or add ' + clsQty + ' more (' + (q0 + clsQty) + ' total)?';
              return res.json({ text: rC, response: rC });
            }
            state.pendingQtyFor = same.name; saveFlowState();
            const rS = pr.name + ' is already in your order (' + bl(q0) + '). How many would you like in total? (Or tell me what else to add.)';
            return res.json({ text: rS, response: rS });
          }
          // Replace-in-varietal: "let's go with Tito's for vodka" when the basket holds another
          // vodka means REPLACE it and keep the quantity (3 bottles stay 3), not add a new line.
          const VARS2 = ['sauvignon','blanc','pinot','noir','grigio','gris','chardonnay','cabernet','merlot','rose','riesling','malbec','syrah','shiraz','zinfandel','champagne','prosecco','cava','tequila','vodka','gin','rum','bourbon','whiskey','whisky','scotch','mezcal','sparkling','liqueur'];
          const nv2 = x => new Set(String(x||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/[^a-z]+/).filter(w => VARS2.includes(w)));
          const pvA = nv2(pr.name + ' ' + (pr.category || '') + ' ' + (pr.subCategory || '') + ' ' + message);
          const targetA = pvA.size ? itemsA.find(it => { const iv = nv2(it.name); return [...pvA].some(v => iv.has(v)); }) : null;
          const labelR = pr.name + (size && nz(pr.name).indexOf(nz(size)) < 0 ? ' — ' + size : '') + ' — $' + price.toFixed(2);
          if (targetA) {
            const rr2 = await applyBasketSubstitute(sessionKey, email, targetA.name, pr.name, price, size);
            if (!(rr2 && rr2.success === false)) {
              retirePendingFor(state, pr.name);
              const kq = targetA.qty || targetA.quantity || 1;
              const rT = 'Got it — ' + kq + 'x ' + labelR + ' (replacing ' + targetA.name + '). Would you like to see the estimated full price, place the order, generate a PDF proposal, or make any changes?';
              return res.json({ text: rT, response: rT });
            }
          }
          // CONFIRM BEFORE ADDING a costly or vintage-specific bottle the customer didn't name exactly.
          // Real bug (DC, Sep 29, Slack): "I need an opus" put Opus One 2017 at $1,099.99 straight into
          // the cart. Search picked it, not the customer — so it is offered, and added only on a yes or
          // a number (pendingAddOffer.confirm, answered before the classifier).
          if (!listed) {
            const vintage = (pr.name.match(/\b(19[5-9]\d|20[0-4]\d)\b/) || [])[1];
            const why = price >= CONFIRM_ADD_PRICE ? 'price $' + price.toFixed(2) + ' >= $' + CONFIRM_ADD_PRICE
              : (vintage && message.indexOf(vintage) < 0 ? 'vintage ' + vintage + ' not in the request' : '');
            if (why) {
              state.pendingAddOffer = { name: pr.name, price, size, qty: clsQty > 1 ? clsQty : 0, confirm: true };
              saveFlowState();
              console.log('[add-item] single match NOT added — confirming first (' + why + '): ' + pr.name);
              const lbl = pr.name + (size && nz(pr.name).indexOf(nz(size)) < 0 ? ' — ' + size : '') + ' — ' + usd(price) + ' a bottle';
              const rF = 'I found ' + lbl + '. ' + (clsQty > 1 ? 'Add ' + clsQty + ' bottles (' + usd(price * clsQty) + ')?' : 'Want me to add it? If so, how many bottles?');
              return res.json({ text: rF, response: rF });
            }
          }
          await applyBasketSubstitute(sessionKey, email, '', pr.name, price, size);
            retirePendingFor(state, pr.name);
          const label = pr.name + (size && nz(pr.name).indexOf(nz(size)) < 0 ? ' — ' + size : '') + ' — $' + price.toFixed(2);
          if (clsQty > 1) {
            try { const it = JSON.parse(state.lastLineItems || '[]'); const nk = x => String(x||'').toLowerCase().replace(/[^a-z0-9]/g,''); const row = it.find(x => nk(x.name) === nk(pr.name)); if (row) { row.qty = clsQty; row.quantity = clsQty; row.qty_confirmed = true; state.lastLineItems = JSON.stringify(it); saveFlowState(); } } catch (e) {}
            const rA = 'Added ' + clsQty + 'x ' + label + ' to your order. Would you like to see the estimated full price, place the order, generate a PDF proposal, or make any changes?';
            return res.json({ text: rA, response: rA });
          }
          state.pendingQtyFor = pr.name; saveFlowState();
          const rB = 'Added ' + label + '. How many bottles would you like?';
          return res.json({ text: rB, response: rB });
        }
        if (prods.length > 1) {
          const lines = prods.map((pr, i) => (i + 1) + '. ' + pr.name + (pr.sizeStr && pr.name.indexOf(pr.sizeStr) < 0 ? ' — ' + pr.sizeStr : '') + ' — $' + (parseFloat(pr.salePrice || pr.price) || 0).toFixed(2));
          const rC = 'I found a few options for ' + clsRef + ':\n\n' + lines.join('\n') + '\n\nWhich one would you like to add?';
          return res.json({ text: rC, response: rC });
        }
        const rD = 'I couldn\'t find ' + clsRef + ' at this store. Want me to look for something similar?';
        return res.json({ text: rD, response: rD });
      } catch (e) { console.log('[add-item] error, falling through:', e.message); }
    }
    // change_instructions outside confirm: update the saved instructions (used at the next
    // summary) in one step, from the classifier's extracted ref.
    // Only with delivery-instruction words in the message. Real bug (Sep 29 QA, swap-to-category-and-brands):
    // the classifier's network call failed, the retry labeled "Instead of Bacardi – replace with a higher
    // end whiskey / Don Julio and Casamigos" change_instructions (0.75) and the basket's product names were
    // saved as the driver instructions. A label the message doesn't support is dropped, not acted on.
    if (clsIntent === 'change_instructions' && !/\b(instructions?|notes?|driver|deliver(?:y|ing)?|door(?:man)?|buzz(?:er)?|lobby|concierge|front desk|reception|leave (?:it|them|the)|gate|code|floor|suite|apt|apartment|unit|loading dock|call (?:me|when|on arrival)|text (?:me|when)|ring|knock|security|mailroom)\b/i.test(message)) {
      console.log('[order] change_instructions label ignored — no delivery-instruction words in the message: ' + JSON.stringify(message.slice(0, 80)));
      clsIntent = null;
    }
    if (!state.orderStep && !state.proposalStep && (clsIntent === 'change_instructions' || (/\b(instruction|instructions|note|notes|tell the driver|for the driver)\b/i.test(message) && /\b(change|update|set|add|make it|use)\b/i.test(message)))) {
      const txt = (clsRef || message.replace(/^.*?\b(instructions?|notes?|driver)\b\s*(to|:|-|—|should|is|are)?\s*/i, '')).trim();
      state.savedInstructions = /^(none|no|nothing|remove|clear)\b/i.test(txt) ? '' : txt;
      if (state.orderData) state.orderData.delivery_instructions = state.savedInstructions;
      saveFlowState();
      console.log('[order] instructions change outside confirm ->', JSON.stringify(state.savedInstructions));
      const r1 = state.savedInstructions ? ('Got it — delivery instructions set to "' + state.savedInstructions + '". They\'ll be on the order when you place it.') : 'Got it — delivery instructions cleared.';
      return res.json({ text: r1, response: r1 });
    }
    // change_contact outside confirm: update the saved name/phone/email in one step.
    if (!state.orderStep && !state.proposalStep && (clsIntent === 'change_contact' || (/\b(phone|number|email|e-mail|name)\b/i.test(message) && /\b(change|update|use|switch|correct|fix|set)\b/i.test(message)))) {
      const cm = message.replace(/<tel:[^|>]*\|([^>]*)>/g, '$1').replace(/<mailto:[^|>]*\|([^>]*)>/g, '$1').replace(/<([^>]+)>/g, '$1');
      const sc = Object.assign({}, state.savedCustomer || {});
      const ph = cm.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/), em = cm.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const nm = /\bname\b/i.test(cm) ? cm.match(/\bname\b\s*(?:to|is|:)?\s*([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)+)/) : null;
      const changed = [];
      if (ph && /\b(phone|number|cell|mobile|contact)\b/i.test(cm)) { sc.phone = ph[0].replace(/\D/g, ''); changed.push('phone ' + sc.phone); }
      if (em && /\b(email|e-mail|mail)\b/i.test(cm)) { sc.email = em[0]; changed.push('email ' + sc.email); }
      if (nm) { sc.name = nm[1].trim(); changed.push('name ' + sc.name); }
      if (changed.length) {
        state.savedCustomer = sc; saveFlowState();
        console.log('[order] contact change outside confirm ->', changed.join(', '));
        const r2 = 'Got it — updated ' + changed.join(', ') + '. I\'ll use that on the order.';
        return res.json({ text: r2, response: r2 });
      }
    }
    // time change outside confirm: with a basket and saved contact details, "change the
    // delivery time" is an order-flow request even when not at the summary. Enter at
    // the date step (contact skipped) instead of letting the LLM say "no time saved".
    if (!state.orderStep && !state.proposalStep && (state.savedCustomer || {}).name &&
        (clsIntent === 'change_time' ||
        (/\b(time|date|slot|window|\d{1,2}\s*(am|pm))\b/i.test(message) && /\b(change|different|instead|move|make it|update|reschedule|switch)\b/i.test(message) && !/\b(instruction|note|address)\b/i.test(message)))) {
      let bcT = 0; try { bcT = (JSON.parse(state.lastLineItems || '[]') || []).length; } catch (e) {}
      if (bcT >= 1) {
        const sc = state.savedCustomer;
        state.orderData = { qty: null, name: sc.name, phone: sc.phone, email: sc.email || email || '', account_email: email || '' };
        state.orderStep = 'details';
        state.savedDeliveryIso = null; state.savedDeliveryWindow = null; state.savedDeliveryLabel = null;
        saveFlowState();
        console.log('[order] time change outside confirm — entering at the date step');
        if (/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\bnoon\b|\bmidnight\b/i.test(message)) {
          const stripped = message.replace(/\b(change|update|move|switch|reschedule)\b\s*(the|my)?\s*(delivery\s+)?(time|date|slot|window)?\s*(to|for)?\s*/i, '').trim();
          const askResp = await validateDeliveryTime(state, stripped, email, format, res);
          if (askResp) return askResp;
          state.orderData.instructions_asked = true; state.orderData.delivery_instructions = state.savedInstructions || '';
          return renderOrderSummary(state, email, format, res);
        }
        const askT = 'Sure — what delivery date and time would you like instead?';
        return res.json({ text: askT, response: askT });
      }
    }
    if ((hasOrderIntent || isDirectOrderRequest) && !state.orderStep && !state.proposalStep) {
      const caps = getCapabilities(format);
      if (!caps.can_place_order) {
        // Capability disabled — never start the real order state machine. Let Rachel
        // respond naturally instead of a canned message (channel restriction is in her prompt).
        let gbrainContextOB = '';
        if (email && !skip_gbrain) {
          gbrainContextOB = await getCustomerContext('', '', context?.client_id || 'airculinaire', email).catch(() => '');
        }
        const addressRuleOB = `\n\n## DELIVERY ADDRESS\nZip: ${state.zip}. Address: ${state.address}. Use this zip for ALL ShoppingAgent calls. NEVER ask about address or age — both are already confirmed.\n\n## AGE\nCustomer is verified 21+. Never ask for age.`;
        const outputOB = await callRachel({ sessionKey, message, context, format, gbrainContext: gbrainContextOB, addressRule: addressRuleOB, email });
        return res.json({ text: outputOB, response: outputOB });
      }
      state.orderData = {};
      // FAST-PATH re-entry: if the customer's details AND a validated delivery instant
      // are already known (saved when they changed course at the confirm step, or from a
      // prior order this session), don't walk the five questions again. Real bug: after
      // 'add a red wine' at confirm, 'place the order' re-asked name, email, phone, and
      // date — everything given two minutes earlier — because the pre-fill only existed
      // in one of the three entry branches. This runs before all of them.
      {
        const sc = state.savedCustomer || {};
        let bc = 0; try { bc = (JSON.parse(state.lastLineItems || '[]') || []).length; } catch (e) {}
        if (bc >= 1 && sc.name && sc.phone && state.savedDeliveryIso) {
          state.orderData = { qty: null, name: sc.name, phone: sc.phone, email: sc.email || email || '', account_email: email || '',
            delivery_datetime: state.savedDeliveryWindow || '', delivery_window_display: state.savedDeliveryWindow || '',
            delivery_date_label: state.savedDeliveryLabel || '', delivery_datetime_iso: state.savedDeliveryIso,
            delivery_instructions: state.savedInstructions || '', instructions_asked: true, datetime_validated: true };
          state.orderStep = 'confirm';
          saveFlowState();
          console.log('[order] FAST-PATH re-entry — all details known, going straight to summary');
          return renderOrderSummary(state, email, format, res);
        }
      }
      // fast-path must not fall through: the entry branches below each return their own
      // prompt (or crashed, stranding orderStep='confirm'). Skip them when the fast path
      // has already set the state; execution continues to the __show_summary__ hook.
      if (message !== '__show_summary__') {
      // Hydrate basket up front so we know if this is a multi-item package order
      if (email && !state.lastLineItems) {
        try {
          const { getPackage } = require('./gbrain.js');
          const basket = await getPackage(email, format || 'slack');
          if (basket) { state.lastLineItems = typeof basket === 'string' ? basket : JSON.stringify(basket); }
        } catch(e) {}
      }
      let basketItemCount = 0;
      try {
        const bi = typeof state.lastLineItems === 'string' ? JSON.parse(state.lastLineItems) : state.lastLineItems;
        basketItemCount = (bi && bi.length) || 0;
      } catch(e) {}
      if (basketItemCount > 1) {
        // Multi-item package: quantities are already per-line in the basket. Skip qty.
        state.orderData.qty = null;
        { const skipped = contactKnownSkip(); if (skipped) return skipped; }
        return askNameStep();
      }
      // Check whether the customer already specified a quantity in the message that
      // triggered this order (e.g. "order a bottle of opus", "get me 2 bottles") —
      // no need to ask again if we can already parse it.
      const wordToNum = { 'a': 1, 'an': 1, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
        'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10 };
      let preParsedQty = null;
      const digitMatch = message.match(/\b(\d+)\s*(bottle|bottles|case|cases|pack|packs)?\b/i);
      if (digitMatch) {
        preParsedQty = parseInt(digitMatch[1]);
      } else {
        const wordMatch = message.toLowerCase().match(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+bottle/);
        if (wordMatch) preParsedQty = wordToNum[wordMatch[1]];
      }
      const finalQtyForOrder = preParsedQty || state.lastDetectedQty || null;
      if (finalQtyForOrder && finalQtyForOrder > 0) {
        state.orderData.qty = finalQtyForOrder;
        // Pre-fill from what we already know: name/phone from the previous successful
        // order, email from the profile, delivery date from the event/proposal date.
        // Then ask ONLY for what's genuinely missing, in one message — previously every
        // order was 4 sequential questions even for a repeat customer with a known date.
        {
          const sc = knownContact();
          const knownDate = state.savedEventDate || (state.eventParams && state.eventParams.event_date) || '';
          state.orderData.name = sc.name || contacts.profileName(context && context.user_name);
          if (!sc.name && state.orderData.name) { state.orderData.namePrefilled = (format || 'channel') + ' profile'; console.log('[order] name prefilled from ' + state.orderData.namePrefilled + ': ' + JSON.stringify(state.orderData.name) + ' — not asked'); }
          state.orderData.phone = sc.phone || '';
          state.orderData.email = email || sc.email || '';
          state.orderData.known_date = knownDate;
          const missing = [];
          if (!state.orderData.name) missing.push('your full name (first and last)');
          if (!state.orderData.phone) missing.push('your phone number');
          if (missing.length === 0) {
            // Everything known -> one confirmation turn that doubles as the correction point.
            state.orderStep = 'confirm_known';
            saveFlowState();
            const dateBit = knownDate ? (' delivering on ' + knownDate) : '';
            const askK = 'I\'ll place this as ' + state.orderData.name + ', ' + state.orderData.phone + ', ' + state.orderData.email + dateBit + '.\n' +
              (knownDate ? 'What delivery time works, and any delivery instructions for the driver (buzzer/door code, loading dock, floor/suite, on-site contact)? If any of those details should change, just tell me.'
                         : 'What delivery date and time works? If any of those details should change, just tell me.');
            return res.json({ text: askK, response: askK });
          }
          state.orderStep = 'name';
          saveFlowState();
          const askM = (state.orderData.namePrefilled ? 'I\'ll put the order under *' + state.orderData.name + '* (tell me if it should be someone else). ' : '') + 'Almost there — I just need ' + missing.join(' and ') + ' for the person placing the order. (An on-site contact for the driver can go in the delivery instructions.)';
          return res.json({ text: askM, response: askM });
        }
      }
      // Skip the quantity question if it was already set at pick time (or stated).
      // Real bug: the customer answered "how many bottles?" when picking, then
      // "lets order" asked it AGAIN — the entry branch didn't know it was confirmed.
      { let one = null; try { const it = JSON.parse(state.lastLineItems || '[]'); if (it.length === 1) one = it[0]; } catch (e) {}
        if (one && one.qty_confirmed) {
          state.orderData.qty = one.qty || 1;
          { const skipped = contactKnownSkip(); if (skipped) return skipped; }
          return askNameStep();
        } }
      state.orderStep = 'qty';
      saveFlowState();
      const ask = 'How many bottles would you like to order?';
      return res.json({ text: ask, response: ask });
      } // end fast-path guard
    }
    if (state.orderStep === 'qty') {
      const qtyMatch = message.match(/\b(\d+)\b/);
      state.orderData.qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
      { const skipped = contactKnownSkip(); if (skipped) return skipped; }
      // Load basket to get product info
      if (email && !state.lastLineItems) {
        try {
          const { getPackage } = require('./gbrain.js');
          const basket = await getPackage(email, format || 'slack');
          if (basket) { state.lastLineItems = typeof basket === 'string' ? basket : JSON.stringify(basket); saveFlowState(); }
        } catch(e) {}
      }
      return askNameStep();
    }

    // Strip Slack markup before any order-step parsing. Slack delivers phone links as
    // <tel:3475702280|347-570-2280> (the number twice -> digit-stripping produced
    // "34757022803475702280"), blockquotes as &gt;, bold as *...*. Real order state had
    // name "&gt; *Shaminka Smith*" and a 20-digit phone from one instructions message.
    const cleanSlackText = (s) => String(s || '')
      .replace(/<tel:[^|>]*\|([^>]*)>/g, '$1').replace(/<mailto:[^|>]*\|([^>]*)>/g, '$1')
      .replace(/<(https?:[^|>]*)\|[^>]*>/g, '$1').replace(/<([^>]+)>/g, '$1')
      .replace(/&gt;/g, '').replace(/&lt;/g, '').replace(/&amp;/g, '&')
      .replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1')
      .replace(/^\s*>\s*/gm, '').replace(/\s+/g, ' ').trim();
    if (state.orderStep) message = cleanSlackText(message);
    if (state.orderStep === 'confirm_known') {
      const t = message.trim();
      // Inline corrections override the pre-filled values.
      const em = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (em) state.orderData.email = em[0];
      const ph = t.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      if (ph) state.orderData.phone = ph[0].replace(/\D/g, '');
      const nm = t.match(/(?:name is|i'?m|it'?s)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
      if (nm) state.orderData.name = nm[1];
      // Route the rest (time and/or instructions) into the existing details handler.
      // If we know the date, combine it with the stated time so validation sees a full datetime.
      const timeOnly = t.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight)\b/i);
      const kd = state.orderData.known_date;
      if (kd && timeOnly && !/\d{1,2}\/\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december|tomorrow|today/i.test(t)) {
        message = kd + ' at ' + timeOnly[1];
      } else {
        message = t;
      }
      // Anything after the time phrase is treated as instructions (customers often say
      // "5pm, buzzer 4B"). If none, the details step will ask.
      if (timeOnly) {
        const after = t.slice(t.toLowerCase().indexOf(timeOnly[1].toLowerCase()) + timeOnly[1].length).replace(/^[\s,;.\-—]+/, '').trim();
        if (after && !/^(none|no|nothing)$/i.test(after)) { state.orderData.delivery_instructions = after; state.orderData.instructions_asked = true; }
      }
      state.orderStep = 'details';
      saveFlowState();
    }
    // ── ORDER STEP: tip ─────────────────────────────────────────────────────
    if (state.orderStep === 'tip') {
      let tc = parseTip(message);
      const amb = state.orderData.tipAmbiguous;
      if (!tc && amb != null && /\b(percent|%|pct)\b/i.test(message)) tc = { pct: amb };
      if (!tc && amb != null && /\b(dollars?|bucks|\$)/i.test(message)) tc = { amount: amb };
      if (tc && tc.ambiguous != null) {
        state.orderData.tipAmbiguous = tc.ambiguous; saveFlowState();
        const rA = 'Is that ' + tc.ambiguous + '% or $' + tc.ambiguous + '?';
        return res.json({ text: rA, response: rA });
      }
      if (tc) {
        state.orderData.tipChoice = tc; state.savedTipChoice = tc; state.orderData.tipAmbiguous = null; saveFlowState();
        console.log('[tip] customer chose ' + tipText(tc) + ': ' + JSON.stringify(message).slice(0, 50));
        return renderOrderSummary(state, email, format, res);
      }
      const isCmd = /\b(add|remove|swap|replace|change|cancel|stop|basket|cart|show|proposal)\b/i.test(message) && !/\btip\b/i.test(message);
      if (!isCmd) {
        const base = state.orderData.tipBase || 0; const a = p => '$' + (Math.round(base * p) / 100).toFixed(2);
        console.log('[tip] no tip amount in reply — asking again: ' + JSON.stringify(message).slice(0, 50));
        const rR = (/\?\s*$/.test(message) ? 'The tip goes to your delivery driver, and it\'s up to you. ' : '') + 'How much would you like to tip? 10% (' + a(10) + '), 15% (' + a(15) + '), 20% (' + a(20) + '), a custom amount like "$8", or "no tip".';
        return res.json({ text: rR, response: rR });
      }
      // a real command (add/remove/cancel...) falls through to the non-answer exit below
    }
    // A question ABOUT the step being asked ("why do you need my name?", "I'd rather not give
    // my phone") is answered in place and the same question re-asked — the order flow stays.
    // Real bug: it was treated as a command, the flow was dropped, the LLM said "I don't need
    // your name at all!", and every later answer (name, "same", phone) was misread.
    if (['name', 'recipient_email', 'phone'].includes(state.orderStep)) {
      const FIELD = { name: /\b(name|who)\b/i, recipient_email: /\b(e-?mail|address)\b/i, phone: /\b(phone|number|cell|mobile|call|text)\b/i }[state.orderStep];
      const aboutStep = /\b(why|what for|what'?s (it|that|this) for|how come|do you (really )?need|do i (have|need) to|necessary|required|mandatory|rather not|prefer not|don'?t want|do not want|won'?t give|skip|privacy|private)\b/i.test(message);
      if (aboutStep && (FIELD.test(message) || /\b(rather not|prefer not|skip|don'?t want|do not want)\b/i.test(message))) {
        const refusing = /\b(rather not|prefer not|don'?t want|do not want|won'?t give|skip|no thanks)\b/i.test(message);
        const who = email || 'your account email';
        const A = {
          name: 'The store needs the name of the person placing the order — it goes on the order and your receipt, and it\'s how the driver checks the delivery. ' + (refusing ? 'I can\'t place the order without it. ' : '') + 'What\'s your full name (first and last)?',
          recipient_email: 'That\'s where the order confirmation and delivery updates go. Reply "same" to use ' + who + ', or give me another email.',
          phone: 'The driver uses it to reach the recipient when they arrive — Bevvi requires a phone number to place a delivery order. ' + (refusing ? 'Without one I can\'t place the order, but I can still make you a PDF proposal of this basket. ' : '') + 'What\'s the best number?'
        }[state.orderStep];
        console.log('[order] question about the ' + state.orderStep + ' step — answered, staying in the order flow: ' + JSON.stringify(message).slice(0, 70));
        return res.json({ text: A, response: A });
      }
    }
    // A command or question at a contact-detail step is NOT the answer. Real bug: at
    // "What is your full name?", "Show me the basket" was stored as the customer's name
    // and the flow moved on to email. Recognize it, exit the order flow (details kept),
    // and let the command run normally; the customer says 'place the order' to resume.
    const isOrderStepNonAnswer = /^\s*(show|what|where|how|can you|could you|do you|is there|list|display|view|cancel|stop|never ?mind|forget it|go back|help|reset)\b/i.test(message) || /\?\s*$/.test(message)
      || /\b(estimated?|price|pricing|basket|cart|total|cost|quote|proposal|recommend|add|remove|swap|change)\b/i.test(message);   // 'estimated price' at the name step is not a name
    if ((state.orderStep === 'name' || state.orderStep === 'recipient_email' || state.orderStep === 'phone' || state.orderStep === 'tip') && isOrderStepNonAnswer) {
      const od0 = state.orderData || {};
      if (od0.name || od0.phone) state.savedCustomer = { name: od0.name || (state.savedCustomer || {}).name || '', phone: od0.phone || (state.savedCustomer || {}).phone || '', email: od0.email || (state.savedCustomer || {}).email || '' };
      state.orderStep = null; state.orderData = null;
      saveFlowState();
      console.log('[order] non-answer at contact step — exiting order flow, handling as a normal request');
      // fall through: the message is handled below as a normal request
    }
    if (state.orderStep === 'name') {
      // The "missing info" reply may contain name AND phone in one message.
      const t = message.trim();
      const ph = t.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
      if (ph) { state.orderData.phone = ph[0].replace(/\D/g, ''); }
      const nameOnly = ph ? t.replace(ph[0], '').replace(/[,;]+/g, ' ').trim() : t;
      if (!state.orderData.name && nameOnly) state.orderData.name = nameOnly;
      else if (state.orderData.namePrefilled && nameOnly) {   // "I'll put the order under X" was stated with this ask
        const fix = contacts.nameCorrection(nameOnly);
        if (fix) { console.log('[order] prefilled name ' + JSON.stringify(state.orderData.name) + ' corrected -> ' + JSON.stringify(fix)); state.orderData.name = fix; state.orderData.namePrefilled = null; }
        else if (contacts.refusesName(nameOnly)) {
          state.orderData.name = ''; state.orderData.namePrefilled = null; saveFlowState();
          console.log('[order] prefilled name refused — asking for it');
          const rN = 'Who should the order be under? (first and last name)';
          return res.json({ text: rN, response: rN });
        }
      }
      // Recipient email is a required step (business decision): asked right after the
      // name; if the customer skips it, it falls back to the account email. This
      // replaces the old 'email_confirm' step (which asked a weaker version later).
      state.orderStep = 'recipient_email';
      saveFlowState();
      const askE = 'What email should we use for the delivery recipient? (Reply "same" to use ' + (email || 'your account email') + '.)';
      return res.json({ text: askE, response: askE });
    }
    if (state.orderStep === 'recipient_email') {
      const em = message.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      // The name was prefilled (askNameStep) and stated with this question: a reply that corrects or
      // refuses it is about the NAME, not the email — never fall back to the account email on it.
      if (state.orderData.namePrefilled && !em) {
        const fix = contacts.nameCorrection(message);
        if (fix || contacts.refusesName(message)) {
          state.orderData.namePrefilled = null;
          if (!fix) {
            state.orderData.name = ''; state.orderStep = 'name'; saveFlowState();
            console.log('[order] prefilled name refused — asking for it');
            const rN = 'Who should the order be under? (first and last name)';
            return res.json({ text: rN, response: rN });
          }
          console.log('[order] prefilled name ' + JSON.stringify(state.orderData.name) + ' corrected -> ' + JSON.stringify(fix));
          state.orderData.name = fix; saveFlowState();
          const rE = 'Got it — the order will be under *' + fix + '*. What email should we use for the delivery recipient? (Reply "same" to use ' + (email || 'your account email') + '.)';
          return res.json({ text: rE, response: rE });
        }
      }
      // Fallback to the account email on "same"/skip/no email found. Lowercased: phone
      // keyboards capitalize the first letter and Bevvi's account lookup is case-sensitive
      // (real failure: 'Dipanjan@getbevvi.com' -> 'Invalid accountId').
      state.orderData.email = (em ? em[0] : (email || '')).toLowerCase();
      state.orderData.account_email = email || '';
      if (!em) console.log('[order] recipient email not given — falling back to account email');
      if (state.orderData.phone) {
        state.orderStep = 'details';
        saveFlowState();
        const kd = state.orderData.known_date;
        const ask = kd ? ('Thanks! Delivering on ' + kd + ' — what time works, and any delivery instructions for the driver?') : 'Thanks! What delivery date and time would you like?';
        return res.json({ text: ask, response: ask });
      }
      state.orderStep = 'phone';
      saveFlowState();
      const ask = 'And your phone number (for the person placing the order)?';
      return res.json({ text: ask, response: ask });
    }
    if (state.orderStep === 'phone') {
      state.orderData.phone = message.replace(/\D/g, '');
      if (!state.orderData.email) state.orderData.email = email || '';
      state.orderData.account_email = state.orderData.account_email || email || '';
      state.orderStep = 'details';
      saveFlowState();
      const kd = state.orderData.known_date;
      const askD = kd ? ('Thanks! Delivering on ' + kd + ' — what time works, and any delivery instructions for the driver?') : 'Thanks! What delivery date and time would you like?';
      return res.json({ text: askD, response: askD });
    }
    if (state.orderStep === 'email_confirm') {
      // If yes or empty, use existing email. Otherwise use provided email
      if (yesWords.some(w => msgLower.includes(w))) {
        state.orderData.email = email;
      } else {
        const emailMatch = message.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        state.orderData.email = emailMatch ? emailMatch[0] : email;
      }
      state.orderStep = 'details';
      saveFlowState();
      const ask = 'What delivery date and time would you like?';
      return res.json({ text: ask, response: ask });
    }
    if (state.orderStep === 'instructions') {
      const raw = message.trim();
      state.orderData.delivery_instructions = /^(none|no|nope|n\/a|na|nothing|skip)\.?$/i.test(raw) ? '' : raw;
      // The datetime was already validated and stored as the matched window text
      // (e.g. "02:00 PM - 03:00 PM EST"). Replaying THAT into the details handler
      // made chrono re-parse the window string and land on the wrong hour (real
      // bug: customer said 2 PM, summary showed 7-8 PM). Skip re-validation.
      state.orderData.datetime_validated = true;
      state.orderStep = 'details';
      saveFlowState();
      message = state.orderData.delivery_datetime;
    }
    if (state.orderStep === 'details') {
     if (!state.orderData.datetime_validated) {
      const askResp = await validateDeliveryTime(state, message, email, format, res);
      if (askResp) return askResp;
     } // end !datetime_validated — a validated replay skips parse+availability, keeps the stored window
      // New step: delivery instructions (buzzer/door code, loading dock, on-site contact).
      // agent.js already accepts delivery_instructions and sends it to the Bevvi API as
      // deliveryInstructions — the flow just never collected it.
      if (!state.orderData.instructions_asked) {
        state.orderData.instructions_asked = true;
        state.orderStep = 'instructions';
        saveFlowState();
        const askI = 'Any delivery instructions for the driver? (e.g. buzzer or door code, loading dock, floor/suite, or an on-site contact) — or say "none".';
        return res.json({ text: askI, response: askI });
      }
      // Never present an unvalidated delivery time. If no ISO instant was produced (no
      // establishment to validate against, or validation skipped), do not fall through
      // to a summary that echoes the customer's raw words as if confirmed.
      if (!state.orderData.delivery_datetime_iso) {
        state.orderStep = 'details';
        saveFlowState();
        const askV = 'I couldn\'t confirm a delivery window for that time yet. Could you give me a specific date and time (e.g. "Sept 16 at 5pm")?';
        return res.json({ text: askV, response: askV });
      }
      return renderOrderSummary(state, email, format, res);
    }
    // Contact details already given this order (saved when the customer changed course
    // at confirm, or from the previous order): skip name/email/phone and go straight to
    // the date question. Used by every entry branch so no path re-asks.
    // `function`, not `const` arrow: it's called from order-entry branches ABOVE this
    // point, and a const isn't hoisted — real crash: "Cannot access 'contactKnownSkip'
    // before initialization" on "place the order" with a 2-item basket.
    // Contact from this conversation, else from the customer's last placed order (customer-contacts.js)
    // — savedCustomer alone was wiped by reset / idle expiry, so every order re-asked the name.
    function knownContact() {
      const sc = state.savedCustomer || {};
      if (sc.name && sc.phone) return sc;
      const stc = contacts.get(email);
      if (stc && stc.name && stc.phone) {
        state.savedCustomer = { name: stc.name, phone: stc.phone, email: stc.email || '' };
        console.log('[order] contact from the last placed order (saved ' + stc.savedAt + ')');
        return state.savedCustomer;
      }
      return sc;
    }
    // The name question. When a name is already known — this conversation, the last placed order, or
    // the channel profile's real name (Slack) — state it instead of asking; the customer can correct it
    // at the next step (recipient_email handles "no" / a different name). DC, Sep 29.
    function askNameStep() {
      const sc = state.savedCustomer || {}, stc = contacts.get(email) || {};
      const hit = [[sc.name, 'this conversation'], [stc.name, 'the last placed order'], [contacts.profileName(context && context.user_name), (format || 'channel') + ' profile']].find(c => c[0]);
      if (hit) {
        state.orderData.name = hit[0]; state.orderData.namePrefilled = hit[1];
        state.orderStep = 'recipient_email'; saveFlowState();
        console.log('[order] name prefilled from ' + hit[1] + ': ' + JSON.stringify(hit[0]) + ' — not asked');
        const a = 'I\'ll put the order under *' + hit[0] + '* (tell me if it should be someone else). What email should we use for the delivery recipient? (Reply "same" to use ' + (email || 'your account email') + '.)';
        return res.json({ text: a, response: a });
      }
      state.orderStep = 'name'; saveFlowState();
      const ask = 'What is your full name — the person placing the order? (first and last). If someone else will receive the delivery, you can give their contact in the delivery instructions later.';
      return res.json({ text: ask, response: ask });
    }
    function contactKnownSkip() {
      const sc = knownContact();
      if (!(sc.name && sc.phone)) return null;
      state.orderData.name = sc.name; state.orderData.phone = sc.phone;
      state.orderData.email = sc.email || email || ''; state.orderData.account_email = email || '';
      state.orderStep = 'details';
      saveFlowState();
      console.log('[order] contact known — skipping name/email/phone');
      const a = 'Ordering as ' + sc.name + ', ' + sc.phone + ', ' + state.orderData.email + ' — tell me if any of that should change. What delivery date and time would you like?';
      return res.json({ text: a, response: a });
    }
    if (state.orderStep === 'confirm' && message === '__show_summary__') {
      // Re-entry summary: rebuild from the saved details so the customer can confirm or change.
      state.orderStep = 'details';            // the details block below builds the summary
      state.orderData.datetime_validated = true;
      message = state.orderData.delivery_datetime || 'x';
    }
    if (state.orderStep === 'confirm') {
      // CHANGE REQUEST at confirm: "add a red wine", "remove X", "swap", "change the
      // date". Real bug: any non-yes/no reply got a rigid 'shall I place the order?
      // (yes/no)' re-ask — a dead end at exactly the moment a customer notices something
      // missing. Exit the order flow (keeping name/phone/email/date so they're
      // pre-filled next time), acknowledge, and let the request go through normally.
      // classifier-assisted confirm: await the label at this decision point (~1s) and let it
      // steer which handler runs; the regexes remain as fallback.
      let cls = null;
      try {
        const { classifyIntent } = require('./classify-intent.js');
        const lastRc = (lastRepliesBySession[sessionKey] || []).slice(-1)[0] || '';
        const cr = await classifyIntent(message, { lastKind: 'yes_no', orderStep: 'confirm', basketSize: 0, lastQuestion: lastRc.slice(0, 160) });
        if (/^(llm|rule)/.test(cr.source) && cr.confidence >= 0.7) cls = cr.intent;
        console.log('[classify@confirm]', cls || ('none — ' + cr.intent + ' ' + cr.confidence.toFixed(2)), '[' + cr.source + ']');
      } catch (e) {}
      // CONTACT CHANGE at confirm: "use the phone number at X", "change my email to Y".
      // Real bug: there was NO handler for this — the classifier labeled it change_contact
      // (0.82) but the message fell to the generic re-confirm and nothing changed.
      const cleanMsgC = message.replace(/<tel:[^|>]*\|([^>]*)>/g, '$1').replace(/<mailto:[^|>]*\|([^>]*)>/g, '$1').replace(/<([^>]+)>/g, '$1');
      const wantsContactChange = /\b(change|update|use|switch|different|instead|correct|fix|make it|set)\b/i.test(cleanMsgC) && /\b(phone|number|cell|mobile|email|e-mail|name)\b/i.test(cleanMsgC);
      if ((cls === 'change_contact' || wantsContactChange) && !yesWords.some(w => msgLower === w)) {
        const phoneM = cleanMsgC.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
        const emailM = cleanMsgC.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        const nameM  = /\bname\b/i.test(cleanMsgC) ? cleanMsgC.match(/\bname\b\s*(?:to|is|:)?\s*([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)+)/) : null;
        const changed = [];
        if (phoneM && /\b(phone|number|cell|mobile|contact)\b/i.test(cleanMsgC)) { state.orderData.phone = phoneM[0].replace(/\D/g, ''); changed.push('phone'); }
        if (emailM && /\b(email|e-mail|mail)\b/i.test(cleanMsgC)) { state.orderData.email = emailM[0]; changed.push('email'); }
        if (nameM) { state.orderData.name = nameM[1].trim(); changed.push('name'); }
        if (changed.length) {
          state.savedCustomer = { name: state.orderData.name, phone: state.orderData.phone, email: state.orderData.email };
          saveFlowState();
          console.log('[order] contact change at confirm ->', changed.join(','));
          return renderOrderSummary(state, email, format, res);
        }
      }
      // TIME CHANGE at confirm — handled in-flow, not exited to the LLM. Real bug:
      // "change the delivery time to 3 pm tomorrow" exited the order flow and the LLM
      // replied "there's no delivery time set to change" — nothing re-asked the time.
      // Keep the order, keep contact details, re-validate the new time, re-render.
      // ADDRESS CHANGE at confirm. Real bug: with no change_address label the classifier
      // picked change_instructions and the whole sentence was STORED as the driver
      // instructions. An address change can mean a different store (different client and
      // catalog), so: re-check coverage, clear the delivery time (windows are per store),
      // and if the serving client changed, the basket must be rebuilt — say so honestly.
      const isAddrChange = cls === 'change_address' || (/\b(address|deliver to|delivery location|ship to)\b/i.test(message) && /\b(change|update|different|instead|use|switch|move)\b/i.test(message) && /\b\d{5}\b/.test(message));
      if (isAddrChange && !yesWords.some(w => msgLower === w)) {
        const newAddr = message.replace(/^.*?\b(address|deliver to|delivery location|ship to)\b\s*(to|is|:)?\s*/i, '').trim();
        const zm = newAddr.match(/\b(\d{5})\b/);
        if (zm) {
          const prevCov = await checkStoreCoverage(state.zip);
          const cov = await checkStoreCoverage(zm[1]);
          if (!cov || !cov.store_count) {
            const rNo = 'I can\'t deliver to ' + zm[1] + ' yet — no store serves that zip. Keep the current address, or try a different one?';
            return res.json({ text: rNo, response: rNo });
          }
          const sameStore = prevCov && cov && prevCov.client === cov.client;
          state.address = newAddr; state.zip = zm[1]; state.addrConfirmed = true;
          state.orderData.delivery_datetime_iso = null; state.orderData.delivery_datetime = null; state.orderData.delivery_window_display = null; state.orderData.datetime_validated = false;
          state.savedDeliveryIso = null; state.savedDeliveryWindow = null; state.savedDeliveryLabel = null;
          const od0 = state.orderData;
          state.savedCustomer = { name: od0.name, phone: od0.phone, email: od0.email };
          if (od0.delivery_instructions && !/\b\d{5}\b/.test(od0.delivery_instructions)) state.savedInstructions = od0.delivery_instructions;
          console.log('[order] address change at confirm ->', newAddr, '| same store:', sameStore);
          if (sameStore) {
            state.orderStep = 'details'; saveFlowState();
            const rA = 'Delivery address updated to ' + newAddr + '. Delivery windows differ by address — what delivery date and time would you like?';
            return res.json({ text: rA, response: rA });
          }
          // Different store: the basket was built for the old one. Clear the order flow
          // and ask to rebuild rather than ship items the new store may not carry.
          state.orderStep = null; state.orderData = null; state.lastLineItems = '[]'; saveFlowState();
          const rB = 'Delivery address updated to ' + newAddr + '. That\'s served by a different store, so your basket needs to be rebuilt for it — tell me what you\'d like and I\'ll put it together again.';
          return res.json({ text: rB, response: rB });
        }
      }
      // INSTRUCTIONS CHANGE at confirm: "change the delivery instructions to X", "add a note:
      // X", "tell the driver X". Real bug: this matched the TIME-change pattern (it contains
      // "delivery" + "change") and asked for a time. Parse the new text, update, re-render.
      const isInstrChange = /\b(instruction|instructions|note|notes|tell the driver|driver should|for the driver)\b/i.test(message) && !yesWords.some(w => msgLower === w);
      if (cls === 'change_instructions' || isInstrChange) {
        const newInstr = message.replace(/^.*?\b(instructions?|notes?|driver)\b\s*(to|:|-|—|should|is|are)?\s*/i, '').trim();
        state.orderData.delivery_instructions = /^(none|no|nothing|remove|clear)\b/i.test(newInstr) ? '' : newInstr;
        state.savedInstructions = state.orderData.delivery_instructions;
        saveFlowState();
        console.log('[order] instructions change at confirm ->', JSON.stringify(state.orderData.delivery_instructions));
        return renderOrderSummary(state, email, format, res);
      }
      // Time change: require an explicit time/date word — "delivery" alone is not enough
      // (it also appears in "delivery instructions" / "delivery address").
      const isTimeChangeC = /\b(time|date|slot|window|when|\d{1,2}\s*(am|pm))\b/i.test(message) && /\b(change|different|instead|move|make it|update|reschedule|switch)\b/i.test(message) && !/\b(instruction|note|address)\b/i.test(message);
      if ((cls === 'change_time' || isTimeChangeC) && !yesWords.some(w => msgLower === w)) {
        const hasTime = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\bnoon\b|\bmidnight\b/i.test(message);
        state.orderData.delivery_datetime_iso = null; state.orderData.delivery_datetime = null;
        state.orderData.delivery_window_display = null; state.orderData.datetime_validated = false;
        state.orderStep = 'details';
        saveFlowState();
        console.log('[order] time change at confirm — re-validating in-flow; time in message:', hasTime);
        if (hasTime) {
          const stripped = message.replace(/\b(change|update|move|switch|reschedule)\b\s*(the|my)?\s*(delivery\s+)?(time|date|slot|window)?\s*(to|for)?\s*/i, '').trim();
          const askResp = await validateDeliveryTime(state, stripped, email, format, res);
          if (askResp) return askResp;
          state.orderData.instructions_asked = true;   // keep existing instructions
          return renderOrderSummary(state, email, format, res);
        }
        const askT = 'Sure — what delivery date and time would you like instead?';
        return res.json({ text: askT, response: askT });
      } else {
      const isChange = /\b(add|also|remove|drop|take out|swap|replace|change|instead|different|another|more|less|fewer|update|edit)\b/i.test(message) && !yesWords.some(w => msgLower === w);
      if (isChange) {
        const od0 = state.orderData || {};
        state.savedCustomer = { name: od0.name || (state.savedCustomer || {}).name || '', phone: od0.phone || (state.savedCustomer || {}).phone || '', email: od0.email || (state.savedCustomer || {}).email || '' };
        // A time-change at confirm ("change the delivery time", "make it 3 pm") must NOT
        // carry the old delivery instant into the fast-path; keep contact details, drop
        // the time so it's re-asked. An item change keeps everything.
        const isTimeChange = /\b(time|date|deliver(?:y)?\s+(?:time|date|slot|window)|when|earlier|later|tomorrow|today|am|pm)\b/i.test(message) && /\b(change|different|instead|move|make it|update)\b/i.test(message);
        if (od0.delivery_datetime_iso && !isTimeChange) { state.savedDeliveryIso = od0.delivery_datetime_iso; state.savedDeliveryWindow = od0.delivery_window_display || od0.delivery_datetime; state.savedDeliveryLabel = od0.delivery_date_label || ''; }
        else if (isTimeChange) { state.savedDeliveryIso = null; state.savedDeliveryWindow = null; state.savedDeliveryLabel = null; console.log('[order] time-change at confirm — contact kept, delivery time will be re-asked'); }
        if (od0.delivery_instructions) state.savedInstructions = od0.delivery_instructions;
        state.orderStep = null; state.orderData = null;
        saveFlowState();
        console.log('[order] change request at confirm — exiting order flow, details saved for re-entry');
        // Fall through: the message is handled as a normal request below (add/swap/etc.),
        // and the LLM is told to prompt for 'place the order' once done.
        context.order_change_note = 'The customer was at the order-confirmation step and asked for a change. Make the change, then say: "Done — say \'place the order\' when you\'re ready and I\'ll show the updated summary."';
      } else
      if (yesWords.some(w => msgLower.includes(w))) {
        state.orderStep = 'placing';
        saveFlowState();
        // Build place_order message for Rachel with all details
        const od = state.orderData;
        const nameParts = (od.name || '').split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';
        // Update line_items with correct qty
        let updatedLineItems = state.lastLineItems;
        if (updatedLineItems) {
          try {
            const items = typeof updatedLineItems === 'string' ? JSON.parse(updatedLineItems) : updatedLineItems;
            // Only overwrite qty for single-item orders where the customer was asked "how many".
            // Multi-item packages already carry per-line quantities — leave them untouched.
            if (od.qty && items.length === 1) {
              items.forEach(item => { item.qty = od.qty; item.quantity = od.qty; });
            } else {
              items.forEach(item => { item.qty = item.qty || item.quantity || 1; item.quantity = item.quantity || item.qty || 1; });
            }
            updatedLineItems = JSON.stringify(items);
          } catch(e) {}
        }
        // Lines with no catalog link (a hand-built quote given on any channel) are linked before placing — exact
        // matches only (line-resolve.js). Anything unmatched is asked about instead of sent: Bevvi refuses the
        // order otherwise, naming items the customer can't act on (Sep 29, Gen II Fund).
        try {
          const itemsR = JSON.parse(updatedLineItems || '[]');
          if (itemsR.some(LR.needsLink) && state.zip) {
            const rr = await LR.resolveLines(itemsR, (n, c) => catalogSearch(state.zip, n, c));
            if (rr.linked.length) { updatedLineItems = JSON.stringify(rr.items); state.lastLineItems = updatedLineItems; saveFlowState(); }
            if (rr.unresolved.length) {
              state.orderStep = 'confirm'; saveFlowState();
              console.log('[order] NOT placed — ' + rr.unresolved.length + ' line(s) not linked to the catalog, customer asked: ' + JSON.stringify(rr.unresolved.map(u => u.name)));
              const tU = 'Before I place this order I need you to confirm ' + (rr.unresolved.length === 1 ? 'one item' : rr.unresolved.length + ' items') + " I can't match exactly in this store's catalog:\n" +
                rr.unresolved.map(u => '• ' + u.name + ' — ' + u.reason + (u.options.length ? '. Closest: ' + u.options.join('; ') : '')).join('\n') +
                '\n\nWhich product should I use for ' + (rr.unresolved.length === 1 ? 'it' : 'each') + ' — or should I remove ' + (rr.unresolved.length === 1 ? 'it' : 'them') + '?';
              return res.json({ text: tU, response: tU });
            }
          }
        } catch (e) { console.log('[order] line linking failed (placing as is; Bevvi names any unlinked item): ' + e.message); }
        // Parse the address robustly. Real bug: a two-line address ("101 E 150th St" /
        // "Bronx, NY 10451") was stored with the line break collapsed to a space, so the
        // old comma-split produced city="NY 10451" and no state — Bevvi rejected it
        // ("should be street address, city, state zip"). State was also hardcoded 'NY',
        // which would break every Boston/Dallas/Scottsdale/Miami order.
        // Strip a conversational prefix here too — an address saved BEFORE the entry-time
        // strip existed still carried it ("streetAddress: 'address is 425 west 53rd st'").
        const addrRaw = String(state.address || '').replace(/\s+/g, ' ').replace(/^\s*(?:my |the |our )?(?:new |delivery |shipping )?address(?: is|:)?\s*/i, '').trim();
        let street = addrRaw, city = '', stateCode = '', zipc = state.zip || '';
        {
          // Comma before the city: unambiguous.
          let m = addrRaw.match(/^(.*?),\s*([A-Za-z .'-]+?)[,\s]+([A-Z]{2})[,\s]+(\d{5})(?:-\d{4})?\s*$/);
          if (m) { street = m[1].trim(); city = m[2].trim(); stateCode = m[3]; zipc = m[4]; }
          // "425 W 53rd St, NY, NY 10019": the comma-anchored city is the state code. Map
          // the common abbreviations to their city; otherwise leave it for the fallback.
          if (m && /^[A-Za-z]{2,3}$/.test(city)) { city = ({ NY: 'New York', NYC: 'New York', LA: 'Los Angeles', SF: 'San Francisco', DC: 'Washington' })[city.toUpperCase()] || ''; }
          if (!m || !city) {
            // No comma between street and city (a two-line address collapsed to one line):
            // split on the LAST street-suffix word, so "101 E 150th St Bronx" -> St | Bronx
            // and "1250 Broadway 2nd Floor New York" -> Floor | New York.
            m = addrRaw.match(/^(.*?)[,\s]+([A-Z]{2})[,\s]+(\d{5})(?:-\d{4})?\s*$/);
            if (m) {
              const pre = m[1].replace(/,\s*$/, ''); stateCode = m[2]; zipc = m[3];
              const SUFFIX = /\b(street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|way|place|pl|court|ct|terrace|ter|parkway|pkwy|highway|hwy|broadway|floor|fl|suite|ste|apt|unit|#\d+)\.?\b/i;
              const words = pre.split(' '); let cut = -1;
              for (let i = words.length - 1; i >= 0; i--) { if (SUFFIX.test(words[i])) { cut = i; break; } }
              if (cut >= 0 && cut < words.length - 1) { street = words.slice(0, cut + 1).join(' '); city = words.slice(cut + 1).join(' '); }
              else { street = pre; }
            } else {
              const m2 = addrRaw.match(/^(.*?),\s*([^,]+?)\s*$/);
              if (m2) { street = m2[1].trim(); city = m2[2].trim(); }
            }
          }
        }
        const customerObj = {
          firstName: firstName,
          lastName: lastName,
          email: od.email || email,
          phone: od.phone,
          address: [street, city, [stateCode, zipc].filter(Boolean).join(' ')].filter(Boolean).join(', '),
          streetAddress: street,
          city: city,
          state: stateCode || 'NY',
          zipcode: zipc
        };
        console.log('[order] parsed address ->', JSON.stringify({ street, city, state: stateCode, zip: zipc }));
        const placeMsg = JSON.stringify({
          _system: 'place_order',
          line_items: updatedLineItems || '[]',
          customer: customerObj,
          account_email: od.account_email || email || '',   // top-level createCorpOrder email = the logged-in user
          tip_amount: typeof od.tip === 'number' ? od.tip : undefined,   // the customer's chosen tip (enforced in rachel.js)
          delivery_datetime: od.delivery_datetime_iso || od.delivery_datetime,
          delivery_window: od.delivery_datetime,
          delivery_instructions: od.delivery_instructions || '',
          zip: state.zip,
          // The exact figures the customer just approved in the summary. The post-order
          // confirmation must quote THESE — the createCorpOrder response carries no tip
          // field, and the LLM was narrating "Tip: $0.00" against an approved $113.91.
          approved_totals: {
            product_total: od.productTotal, tax: od.tax, service: od.service, tip: od.tip,
            delivery: 25.00,   // estimate; Bevvi applies the real fee at checkout. Real bug: a second `delivery: 0` key overrode this, so the LLM got delivery $0 beside a grand total that includes $25
            grand_total: Math.round(((od.productTotal || 0) + (od.tax || 0) + (od.service || 0) + (od.tip || 0) + 25) * 100) / 100
          }
        });
        // Full, untruncated log of exactly what we hand to the LLM for placement — the
        // tool-call log is sliced and orderData is cleared on success, which left no way
        // to tell whether a field (e.g. delivery_instructions) was dropped or never given.
        console.log('[order] place_order payload:', JSON.stringify({ delivery_datetime: od.delivery_datetime, delivery_datetime_iso: od.delivery_datetime_iso, delivery_instructions: od.delivery_instructions, name: od.name, phone: od.phone, items: (JSON.parse(updatedLineItems || '[]')).length }));
        const fp2 = fingerprint(placeMsg);
        state.lastFingerprint = fp2;
        const gbrainCtx = email ? await getCustomerContext('', '', context?.client_id || 'airculinaire', email).catch(() => '') : '';
        context.saved_zip = state.zip;
        const addrRule2 = '\n\n## DELIVERY\nZip: ' + state.zip + '. Address: ' + state.address + '. Age and address verified.\n\n## ORDER INSTRUCTION\nThe user message contains a JSON system instruction. Parse it and immediately call ShoppingAgent with intent=place_order using the line_items, customer, delivery_datetime, delivery_instructions and zip from the JSON (pass delivery_instructions through verbatim, even if empty). Do not ask for any more information. In your confirmation reply, quote the amounts from approved_totals EXACTLY (product total, tax, service charge, tip, grand total) — never recompute them; the tip is the customer\'s choice and may be $0.00. Label the delivery line "Estimated delivery: $25.00" (it is an estimate; the final delivery charge is confirmed at checkout); the API response does not include these figures and the customer already approved them.';
        const orderOutput = await callRachel({ sessionKey, message: placeMsg, context, format, gbrainContext: gbrainCtx, addressRule: addrRule2, email, alreadyConfirmed: true });
        // Persist the customer's contact details for repeat orders. GBrain stores no
        // name/phone, so the previous successful order is the only source — without
        // this every order re-asked name and phone from scratch.
        if (od.name || od.phone) {
          state.savedCustomer = { name: od.name || '', phone: od.phone || '', email: od.email || email || '' };
        }
        state.orderStep = null;
        state.orderData = null;
        saveFlowState();
        // A reopened order was placed again: the earlier one can't be cancelled via the API,
        // so say plainly which payment link to use (in code — not left to the LLM).
        const poR = state.placedOrder;
        if (poR && poR.replaces && Date.now() - poR.placedAt < 5 * 60 * 1000 && !poR.replaceNoted) {
          poR.replaceNoted = true; saveFlowState();
          const note = '\n\nThis updated order replaces your earlier order #' + poR.replaces + ' — please pay only the new link above, not the earlier one.';
          return res.json({ text: orderOutput + note, response: orderOutput + note });
        }
        return res.json({ text: orderOutput, response: orderOutput });
      } else if (noWords.some(w => msgLower.includes(w))) {
        state.orderStep = null;
        state.orderData = null;
        saveFlowState();
        const cancel = 'No problem! Would you like to make any changes, or is there anything else I can help with?';
        return res.json({ text: cancel, response: cancel });
      } else {
        // Re-show confirmation
        const od = state.orderData;
        if (!od.grandTotal) {
          // No computed total means the summary never rendered; render it now instead of
          // asking the customer to confirm '$0.00'.
          return renderOrderSummary(state, email, format, res);
        }
        let itemCountRC = 1; try { itemCountRC = JSON.parse(state.lastLineItems || '[]').length || 1; } catch (e) {}
        const reconfirm = 'Please confirm — shall I place this order (' + itemCountRC + ' item' + (itemCountRC === 1 ? '' : 's') + ', $' + (od.grandTotal || 0).toFixed(2) + ' estimated)? Reply yes to place it, no to cancel, or tell me what to change.';
        return res.json({ text: reconfirm, response: reconfirm });
      }
      } // end non-time-change branch
    }

    // ── Order state machine ────────────────────────────────────────────────────
    // ── Proposal state machine ──────────────────────────────────────────────
    const proposalTriggers = ['generate a pdf', 'generate the pdf', 'generate proposal', 'generate a proposal',
      'generate the proposal', 'pdf proposal', 'create a proposal', 'create the proposal', 'make a proposal',
      'make the proposal', 'send a proposal', 'send the proposal', 'build a proposal', 'get me a proposal',
      'want a proposal', 'want the proposal'];
    const isProposalTrigger = proposalTriggers.some(t => msgLower.includes(t));
    // An explicit proposal request ALWAYS restarts the flow. Previously it was ignored
    // whenever a step was already in progress (`&& !state.proposalStep`), so a request
    // that crashed mid-flow left proposalStep stuck (e.g. 'qty') and the customer's next
    // "generate a proposal" fell into the stale handler and asked "how many bottles?".
    // An unambiguous re-request should never be swallowed by leftover state.
    if (isProposalTrigger && state.proposalStep) {
      console.log('[proposal] explicit re-request while proposalStep=' + state.proposalStep + ' — resetting stale flow');
      state.proposalStep = null;
      state.proposalData = null;
      saveFlowState();
    }
    if (isProposalTrigger) {
      const caps = getCapabilities(format);
      if (!caps.can_generate_proposal) {
        // Capability disabled — never start the real proposal state machine. Let Rachel
        // respond naturally instead of a canned message (channel restriction is in her prompt).
        let gbrainContextPB = '';
        if (email && !skip_gbrain) {
          gbrainContextPB = await getCustomerContext('', '', context?.client_id || 'airculinaire', email).catch(() => '');
        }
        const addressRulePB = `\n\n## DELIVERY ADDRESS\nZip: ${state.zip}. Address: ${state.address}. Use this zip for ALL ShoppingAgent calls. NEVER ask about address or age — both are already confirmed.\n\n## AGE\nCustomer is verified 21+. Never ask for age.`;
        const outputPB = await callRachel({ sessionKey, message, context, format, gbrainContext: gbrainContextPB, addressRule: addressRulePB, email });
        return res.json({ text: outputPB, response: outputPB });
      }
      // Skip the quantity question when a real basket already exists — each item already
      // has its own specified quantity, so a single "how many bottles" number doesn't apply
      // and would incorrectly overwrite per-item quantities in a multi-item order.
      // state.lastLineItems may have been cleared by cache invalidation since it was last set,
      // so reload it from the persisted GBrain basket first if it's currently empty.
      if (!state.lastLineItems && email) {
        try {
          const { getPackage } = require('./gbrain.js');
          const reloadedBasket = await getPackage(email, format || 'slack');
          if (reloadedBasket) {
            state.lastLineItems = typeof reloadedBasket === 'string' ? reloadedBasket : JSON.stringify(reloadedBasket);
          }
        } catch(e) {}
      }
      let existingItemCount = 0;
      if (state.lastLineItems) {
        try {
          const existingItems = typeof state.lastLineItems === 'string' ? JSON.parse(state.lastLineItems) : state.lastLineItems;
          existingItemCount = Array.isArray(existingItems) ? existingItems.length : 0;
        } catch(e) {}
      }
      if (existingItemCount > 1) {
        // Issue C fix: if client name AND event date were already collected for an
        // earlier proposal in this session, don't re-ask — reuse them and go straight
        // to generating. The customer can still say "change the client/date" to update.
        if (state.savedClientName && state.savedEventDate) {
          state.proposalData = { qty: null, client_name: state.savedClientName, event_date: state.savedEventDate };
          state.proposalStep = 'date';
          message = state.savedEventDate;
        } else {
          state.proposalStep = 'client';
          state.proposalData = { qty: null };
          saveFlowState();
          const ask = state.savedClientName
            ? 'What is the event date?'
            : 'What is the client or company name?';
          if (state.savedClientName) { state.proposalData.client_name = state.savedClientName; state.proposalStep = 'date'; }
          return res.json({ text: ask, response: ask });
        }
      }
      if (state.lastDetectedQty && state.lastDetectedQty > 0) {
        state.proposalStep = 'client';
        state.proposalData = { qty: state.lastDetectedQty };
        saveFlowState();
        const ask = 'What is the client or company name?';
        return res.json({ text: ask, response: ask });
      }
      state.proposalStep = 'qty';
      state.proposalData = {};
      saveFlowState();
      const ask = 'How many bottles would you like on the proposal?';
      return res.json({ text: ask, response: ask });
    }
    if (state.proposalStep === 'qty') {
      const qtyMatch = message.match(/\b(\d+)\b/);
      state.proposalData.qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
      state.proposalStep = 'client';
      saveFlowState();
      const ask = 'What is the client or company name?';
      return res.json({ text: ask, response: ask });
    }

    // A re-issued command ("generate the pdf", "proposal") or an explicit skip is NOT an
    // answer to the client/date question. Real bug: the customer replied "generate the
    // pdf" to both prompts and the state machine stored that literal text as the client
    // name and event date (PDF showed "—"), and would have remembered it for the rest of
    // the session. Treat it as "proceed with this field blank" and never persist it.
    const isNonAnswer = (m) => /^\s*(generate|create|make|build)\b.*(pdf|proposal|quote)|^\s*(proposal|pdf|quote|skip|none|n\/a|na|no|-)\s*$/i.test(m || '');
    if (state.proposalStep === 'client') {
      if (isNonAnswer(message)) {
        state.proposalData.client_name = '';
      } else {
        // Strip any date that might be in the client name
        state.proposalData.client_name = message.split(',')[0].trim();
        // Persist durably so later proposals in this session don't re-ask (Issue C).
        state.savedClientName = state.proposalData.client_name;
      }
      // If the event date is already known from an earlier proposal, skip asking again.
      if (state.savedEventDate) {
        state.proposalData.event_date = state.savedEventDate;
        state.proposalStep = 'date';
        // Re-dispatch into the date handler with the remembered value.
        message = state.savedEventDate;
      } else {
        state.proposalStep = 'date';
        saveFlowState();
        const ask = 'What is the event date?';
        return res.json({ text: ask, response: ask });
      }
    }
    if (state.proposalStep === 'date') {
      if (isNonAnswer(message)) {
        state.proposalData.event_date = '';
      } else {
        state.proposalData.event_date = message.trim();
        state.savedEventDate = state.proposalData.event_date;
      }
      state.proposalStep = 'generating';
      // Load basket now before building summary
      if (email && !state.lastLineItems) {
        try {
          const { getPackage } = require('./gbrain.js');
          const basket = await getPackage(email, format || 'slack');
          if (basket) {
            state.lastLineItems = typeof basket === 'string' ? basket : JSON.stringify(basket);
            console.log('[proposal] basket loaded:', state.lastLineItems.slice(0,80));
          }
        } catch(e) {}
      }
      saveFlowState();
      const pd = state.proposalData;
      let existingItemsForProposal = [];
      if (state.lastLineItems) {
        try {
          existingItemsForProposal = typeof state.lastLineItems === 'string' ? JSON.parse(state.lastLineItems) : state.lastLineItems;
          if (!Array.isArray(existingItemsForProposal)) existingItemsForProposal = [];
        } catch(e) {}
      }
      const isMultiItemProposal = existingItemsForProposal.length > 1;
      const proposalMsg = isMultiItemProposal
        ? `Generate a PDF proposal for client "${pd.client_name}" event date "${pd.event_date}" using the existing line items from the last product search results exactly as-is — do NOT change any quantities.`
        : `Generate a PDF proposal for client "${pd.client_name}" event date "${pd.event_date}" quantity ${pd.qty} bottles using the last product search results. Pass line_items with qty updated to ${pd.qty}.`;
      const fp2 = fingerprint(proposalMsg);
      state.lastFingerprint = fp2;
      const gbrainContext2 = email ? await getCustomerContext('', '', context?.client_id || 'airculinaire', email).catch(() => '') : '';
      context.saved_zip = state.zip;
      const addrRule2 = '\n\n## DELIVERY\nZip: ' + state.zip + '. Address: ' + state.address + '. Never ask about address or age.';
      let capturedProposalUrl = '';
      const proposalOutput = await callRachel({ sessionKey, message: proposalMsg, context, format, gbrainContext: gbrainContext2, addressRule: addrRule2, email, onProposalGenerated: (url) => { capturedProposalUrl = url; } });
      state.proposalStep = null;
      state.proposalData = null;
      state.packageShown = false;
      state.mixerAsked = false;
      state.mixerAnswered = false;
      saveFlowState();

      // Prefer the URL captured directly from the Shopping Agent's tool result — reliable regardless
      // of whether the LLM happened to restate it in its own text. Regex extraction is kept only as a fallback.
      const urlMatch = proposalOutput.match(/http[^\s)|>]+\.pdf/) || proposalOutput.match(/<(http[^|>]+\.pdf)/);
      const downloadUrl = capturedProposalUrl || (urlMatch ? urlMatch[0] : '');
      if (downloadUrl) {
        state.lastProposalUrl = downloadUrl;
        saveFlowState();
      }

      let summary;
      if (isMultiItemProposal) {
        // Multi-item basket — use Rachel's own comprehensive summary (which correctly lists every
        // item with its real quantity) rather than the single-product template below, which only
        // ever shows one item. Still guarantee the download link is present either way.
        summary = (downloadUrl && !proposalOutput.includes(downloadUrl))
          ? proposalOutput + (format === 'slack' ? '\n\n<' + downloadUrl + '|Download proposal>' : '\n\nDownload proposal: ' + downloadUrl)
          : proposalOutput;
      } else {
        // Build deterministic summary with full fee breakdown
        console.log('[proposal-debug] lastLineItems:', JSON.stringify(state.lastLineItems || 'null').slice(0,100), 'pd:', JSON.stringify(pd));
        const qty = pd.qty || 1;
        let productName = 'Products';
        let unitPrice = 0;
        if (existingItemsForProposal.length > 0) {
          productName = existingItemsForProposal[0].name || existingItemsForProposal[0].label || 'Products';
          unitPrice = parseFloat(existingItemsForProposal[0].price || existingItemsForProposal[0].unit_price || 0);
        }
        const productTotal = Math.round(unitPrice * qty * 100) / 100;
        const tax = Math.round(productTotal * 0.10 * 100) / 100;
        const service = Math.round(productTotal * 0.10 * 100) / 100;
        const tip = Math.round(productTotal * 0.05 * 100) / 100;
        const delivery = 25.00; // Quoted as an ESTIMATE only; not sent on the order (Bevvi backend to apply delivery)
        const grandTotal = Math.round((productTotal + tax + service + tip + delivery) * 100) / 100;

        summary = format === 'slack'
          ? 'Your proposal is ready!\n\n' +
            '*Client:* ' + pd.client_name + '\n' +
            '*Event Date:* ' + pd.event_date + '\n\n' +
            productName + ' x' + qty + ' — $' + unitPrice.toFixed(2) + ' ea = $' + productTotal.toFixed(2) + '\n\n' +
            'Product total: $' + productTotal.toFixed(2) + '\n' +
            'Estimated tax (10%): $' + tax.toFixed(2) + '\n' +
            'Service charge (10%): $' + service.toFixed(2) + '\n' +
            'Tip (5%): $' + tip.toFixed(2) + '\n' +
            'Estimated delivery: $' + delivery.toFixed(2) + '\n' +
            '*Estimated grand total: $' + grandTotal.toFixed(2) + '*' +
            (downloadUrl ? '\n\n<' + downloadUrl + '|Download proposal>' : '') +
            '\n\nWould you like me to email this to anyone, place the order, or make any changes?'
          : (downloadUrl && !proposalOutput.includes(downloadUrl)
              ? proposalOutput + '\n\nDownload proposal: ' + downloadUrl
              : proposalOutput);
      }

      return res.json({ text: summary, response: summary });
    }

    // ── Deterministic mixer yes/no interception ──────────────────────────
    // Previously a plain "no" here went straight to the LLM with no structured
    // package context (cache invalidation below wipes lastLineItems on every new
    // message), so the LLM would improvise — sometimes re-narrating the whole
    // package and mixer question from scratch instead of just moving on. Handle
    // a clear yes/no answer here, deterministically, without an LLM call at all.
    // Gate on mixerAsked only: if the question was asked, the answer applies. packageShown
    // was merely a proxy for "a package exists" and its detection has been fragile.
    if (state.mixerAsked && !state.mixerAnswered) {
      const mixerNoWords = ['no', 'nope', 'no thanks', 'no worries', "that's all", 'thats all', "i'm good", 'im good', 'nothing else', 'none'];
      const mixerMsgLower = message.toLowerCase().trim().replace(/\*/g, '');
      // Real bug found tonight: a message like "no find a 750 ML gin around $25" was
      // being swallowed here — it starts with "no" but is clearly a substantial,
      // unrelated follow-up request (about a gin substitute, not mixers), not a mixer
      // decline. Only treat "no ..." as a mixer decline if what follows is SHORT (a
      // brief trailing phrase like "no thanks" or "no, that's it") — a longer message
      // means the customer is answering something else entirely and should fall
      // through to normal processing instead of being cut off here.
      const mixerMsgWordCount = mixerMsgLower.split(/\s+/).filter(Boolean).length;
      if (mixerNoWords.some(w => mixerMsgLower === w || ((mixerMsgLower.startsWith(w + ' ') || mixerMsgLower.startsWith(w + ',')) && mixerMsgWordCount <= 4))) {
        state.mixerAnswered = true;
        saveFlowState();
        const ctaCapsM = getCapabilities(format);
        const ctaActionsM = [format === 'slack' ? 'see the estimated full price' : 'see the estimated full price'];
        if (ctaCapsM.can_place_order) ctaActionsM.push(format === 'slack' ? '*place the order*' : 'place the order');
        if (ctaCapsM.can_generate_proposal) ctaActionsM.push(format === 'slack' ? '*generate a PDF proposal*' : 'generate a PDF proposal');
        const mixerNoReply = 'No problem! Would you like to ' + ctaActionsM.join(', ') + ', or make any changes?';
        return res.json({ text: mixerNoReply, response: mixerNoReply });
      }
      // A clear "yes" still needs a real product search (mixers/water/soda/ice), so
      // that case intentionally falls through to the normal LLM path below.
    }

    // ── Deterministic substitute-confirmation interception ──────────────────
    // A plain "yes"/"yes find a substitute" here previously went straight to the
    // LLM with lastLineItems about to be wiped (cache invalidation just below),
    // causing it to hallucinate an answer from unrelated earlier conversation
    // history instead of actually searching — confirmed via logs: iteration 1
    // stop_reason: end_turn, zero tool calls, and it answered about a completely
    // different item discussed several turns earlier. Perform the real search
    // here deterministically instead of trusting the LLM's judgment on whether/
    // what to search for. Guarded by requiring Rachel's own last message to have
    // actually mentioned "substitute", so a stray unrelated "yes" (answering some
    // other pending question) doesn't misfire this.
    if (state.pendingSubstitutes && state.pendingSubstitutes.length > 0) {
      // Use the actual last outgoing reply (tracked via lastRepliesBySession), not
      // sessions[sessionKey] — confirmed via direct diagnostic logging tonight that the
      // raw API conversation history does not reliably contain the real reply text.
      const lastAssistantText = (lastRepliesBySession[sessionKey] || []).slice(-1)[0] || '';
      const lastMentionedSubstitute = lastAssistantText.toLowerCase().includes('substitute');
      const subConfirmWords = ['yes', 'yeah', 'yep', 'sure', 'please', 'ok', 'okay'];
      const subMsgLower = message.toLowerCase().trim().replace(/\*/g, '');
      // Real bug found tonight: now that confirm_substitute exists as an explicit LLM
      // tool call, a bare "yes" replying to "I found a substitute... would you like to
      // add this instead?" should reach the LLM (which correctly calls confirm_substitute)
      // — not re-trigger THIS search block, which was only meant to handle the initial
      // "yes, find a substitute" request. Without this guard, a bare "yes" after a
      // candidate was already found kept re-searching and re-presenting the same
      // candidate forever, never letting the LLM actually confirm it.
      const alreadyFoundCandidate = /i found a substitute|here.s (a|the) substitute/i.test(lastAssistantText);
      const isSubConfirm = lastMentionedSubstitute && !alreadyFoundCandidate && (subMsgLower.includes('substitut') || subConfirmWords.some(w => subMsgLower === w || subMsgLower.startsWith(w + ' ') || subMsgLower.startsWith(w + ',')));
      if (isSubConfirm) {
        const itemToSubstitute = state.pendingSubstitutes[0];
        // Real bug found tonight: searching for the ORIGINAL unavailable item's exact
        // name (e.g. "DeKuyper Triple Sec 30 proof 1 L") often finds nothing, since
        // that specific brand genuinely isn't in the catalog — but plenty of OTHER
        // triple secs are, just under different names. This search path (shopping-
        // agent.js's product_query) doesn't have the same category-broadening fuzzy
        // fallback built into functions.js's doSearch earlier tonight, so it correctly
        // (but unhelpfully) reports "not found" instead of surfacing real alternatives.
        // Extract a broader category/type term (e.g. "Triple Sec", "Gin") to search
        // with instead of the specific unavailable brand — this is what we actually
        // want for a substitute search anyway.
        const SUBSTITUTE_TYPE_KEYWORDS = ['triple sec', 'vodka', 'gin', 'rum', 'tequila', 'whiskey', 'whisky', 'bourbon', 'scotch', 'cognac', 'brandy', 'liqueur', 'wine', 'beer', 'seltzer', 'champagne', 'cider'];
        const itemLower = itemToSubstitute.toLowerCase();
        const matchedType = SUBSTITUTE_TYPE_KEYWORDS.find(t => itemLower.includes(t));
        const substituteSearchTerm = matchedType || itemToSubstitute;
        console.log('[substitute-deterministic] searching real replacement for:', itemToSubstitute, '| search term:', substituteSearchTerm);
        try {
          const subRes = await fetch('http://127.0.0.1:8300/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'product_query', arguments: { queries: [{ name: substituteSearchTerm, limit: 5 }], zip: state.zip || '', email: email } } })
          });
          const subText = await subRes.text();
          const subLine = subText.split('\n').find(l => l.startsWith('data:'));
          const subData = subLine ? JSON.parse(subLine.replace('data:', '').trim()) : null;
          const subResult = subData ? JSON.parse(subData.result.content[0].text) : null;
          // Real bug found tonight: this used to remove the item from pendingSubstitutes
          // immediately upon FINDING a candidate, before the customer confirmed it —
          // meaning a customer who rejected the first suggestion and asked for something
          // else left tracking permanently broken for that item. Only remove it once the
          // customer actually confirms a specific candidate — the substitute-merge block
          // handles that removal correctly; this search step should only ever look.
          const foundProducts = subResult && subResult.results && subResult.results[0] && subResult.results[0].products;
          if (foundProducts && foundProducts.length > 0) {
            // Real regression found tonight: this used to always show just the single
            // first result, even when several good options exist — a worse experience
            // than the LLM's own free-form searches, which naturally present multiple
            // options as a numbered list. Show up to 3 options here too when available.
            const topOptions = foundProducts.slice(0, 3);
            let subReply;
            if (topOptions.length === 1) {
              const p = topOptions[0];
              subReply = 'I found a substitute for ' + itemToSubstitute + ': ' + p.name + ' — ' + (p.size || '') + ' — $' + (p.price || p.salePrice || 0) + '. Would you like to add this instead?';
            } else {
              const optionLines = topOptions.map((p, i) => (i + 1) + '. ' + p.name + ' — ' + (p.size || '') + ' — $' + (p.price || p.salePrice || 0)).join('\n');
              subReply = 'Here are some options for ' + itemToSubstitute + ':\n\n' + optionLines + '\n\nWhich would you like to go with?';
            }
            return res.json({ text: subReply, response: subReply });
          } else {
            const noSubReply = "Unfortunately I couldn't find a substitute for " + itemToSubstitute + ' either. Would you like to skip it, or try something else?';
            return res.json({ text: noSubReply, response: noSubReply });
          }
        } catch (e) {
          console.error('[substitute-deterministic] search error:', e.message);
          // Fall through to the normal LLM path on error rather than failing the turn.
        }
      }
    }

    // ── Deterministic substitute-SELECTION merge ─────────────────────────────
    // Real, severe bug found tonight via a live conversation: after a customer picks
    // one of several presented substitute options (e.g. "lets go with bombay"), NOTHING
    // ever actually wrote that choice into state.lastLineItems — the LLM's own narrated
    // "here's your updated order with the substitution" text looked completely correct,
    // but the real saved basket still held the ORIGINAL unavailable item. This surfaced
    // downstream as an infinite place_order confirmation loop: the deterministic
    // order-confirm step built its place_order payload from the stale real basket, which
    // didn't match what had just been narrated, and the LLM kept re-presenting/re-asking
    // instead of ever calling the tool. This block performs the real merge deterministically
    // — parsing the candidate options from Rachel's own last message, matching the
    // customer's pick, and actually rewriting state.lastLineItems — rather than relying on
    // the LLM to both pick correctly AND remember to persist it, which it wasn't doing.
    // Real gap found tonight: an AD-HOC single-item substitution (not part of a full
    // custom_list order — e.g. a standalone "do you have X" -> unavailable -> "here are
    // 2 options" flow) never populates pendingSubstitutes at all (that's specific to
    // custom_list's unavailable tracking), so a customer picking one of the presented
    // options had NO deterministic backstop — confirmed via direct trace logging that
    // the LLM was stuck looping, re-presenting the same 2 options forever instead of
    // recognizing the customer's clear selection. Broaden the gate: also enter when
    // Rachel's most recent message clearly asked the customer to pick from options,
    // even with no pendingSubstitutes entry — in that case we ADD the matched item
    // directly rather than replacing anything (there's no "original" to remove).
    // Use the actual last outgoing reply (tracked via lastRepliesBySession), not
    // sessions[sessionKey] — confirmed via direct diagnostic logging tonight that the
    // raw API conversation history does not reliably contain the real reply text.
    const lastAssistantTextGate = (lastRepliesBySession[sessionKey] || []).slice(-1)[0] || '';

    // Affirmative to a deterministic add offer ('Want me to add it?' -> 'yes do that').
    // Real bug: the 'yes' went to the LLM, which didn't know what was offered and
    // re-searched instead of adding. Any offer our code makes, our code must answer.
    if (state.pendingAddOffer && !state.orderStep && !state.proposalStep) {
      const off = state.pendingAddOffer; state.pendingAddOffer = null; saveFlowState();
      if (/^\s*(yes|yes please|yeah|yep|sure|ok|okay|please|do it|do that|yes do that|add it|go ahead|absolutely)\b/i.test(message)) {
        await applyBasketSubstitute(sessionKey, email, '', off.name + (off.size ? ' - ' + off.size : ''), off.price, off.size);
            retirePendingFor(state, off.name);
        state.pendingQtyFor = off.name; saveFlowState();
        const rY = 'Added ' + off.name + (off.size ? ' — ' + off.size : '') + ' — $' + off.price.toFixed(2) + '. How many bottles would you like?';
        return res.json({ text: rY, response: rY });
      }
      // any other message: the offer lapses and the message is handled normally
    }
    // Off-script quantity answers at "How many bottles?". Real bug: "enough for 20 people"
    // was taken as an EVENT (asked hours and budget) and "make it a dozen" re-showed the pick
    // list. Number words are a quantity; a head count gets a suggested quantity with the
    // arithmetic shown, which the customer confirms (or replaces with a number).
    if (state.pendingQtyFor && !state.orderStep && !state.proposalStep) {
      const QW = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, 'a dozen': 12, 'half a dozen': 6, 'half dozen': 6, 'two dozen': 24, 'a case': 12, 'one case': 12 };
      const mw = msgLower.replace(/[.!]+$/, '').match(/^(?:ok(?:ay)?,?\s+)?(?:make it |just |i'?ll take |give me |i want |let'?s do |lets do |how about )?(half a dozen|half dozen|two dozen|a dozen|a case|one case|dozen|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,3})(?:\s+(?:bottles?|of them|please))?$/);
      const mp = msgLower.match(/\b(\d{1,4})\s*(people|guests|persons|ppl|folks|attendees)\b/);
      if (state.qtySuggest && /^(yes|yeah|yep|sure|ok|okay|sounds good|perfect|that works|do it|go with that)\b/.test(msgLower)) {
        message = String(state.qtySuggest); msgLower = message; console.log('[qty] suggested quantity accepted: ' + state.qtySuggest);
      } else if (mw) {
        message = String(QW[mw[1]] || parseInt(mw[1])); msgLower = message;
        console.log('[qty] quantity from wording ' + JSON.stringify(mw[0]) + ' -> ' + message);
      } else if (mp) {
        const n = parseInt(mp[1]); let cat = '';
        try { const it = JSON.parse(state.lastLineItems || '[]'); const nk = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, ''); const row = it.find(x => nk(x.name).indexOf(nk(state.pendingQtyFor).slice(0, 12)) >= 0); cat = String((row && row.category) || '').toLowerCase(); } catch (e) {}
        const spirits = /liquor|spirit|vodka|tequila|whisk|gin|rum|bourbon|scotch/.test(cat + ' ' + state.pendingQtyFor.toLowerCase());
        const q = Math.max(1, spirits ? Math.ceil(n * 2 / 16) : Math.ceil(n * 2 / 5));
        state.qtySuggest = q; saveFlowState();
        console.log('[qty] head count ' + n + ' -> suggested ' + q + ' (' + (spirits ? 'spirits: 2 drinks each, 16 per bottle' : 'wine: 2 glasses each, 5 per bottle') + ')');
        const rS = 'For ' + n + ' people I\'d suggest *' + q + ' bottle' + (q > 1 ? 's' : '') + '* of ' + state.pendingQtyFor + ' — ' + (spirits ? 'about 2 drinks each, ~16 per 750 mL bottle' : 'about 2 glasses each, 5 per 750 mL bottle') + '. Want ' + q + ', or a different number?';
        return res.json({ text: rS, response: rS });
      }
    }
    // Answer to "Change it to N, or add N more?" (add-item on a product already in the basket).
    if (state.pendingQtyChange && !state.orderStep && !state.proposalStep) {
      const pc = state.pendingQtyChange; state.pendingQtyChange = null; saveFlowState();
      const m = String(message || '').toLowerCase();
      const n = /\b(add|more|extra|another|on top|plus)\b/.test(m) ? pc.from + pc.qty : /\b(change|chnage|yes|yeah|yep|sure|ok|okay|make|set|update|replace|that)\b/.test(m) ? pc.qty : 0;
      if (n) {
        try { const it = JSON.parse(state.lastLineItems || '[]'); const nk = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); const row = it.find(x => nk(x.name) === nk(pc.name)); if (row) { row.qty = n; row.quantity = n; row.qty_confirmed = true; state.lastLineItems = JSON.stringify(it); } } catch (e) {}
        saveFlowState();
        console.log('[qty-change] ' + pc.name + ' ' + pc.from + ' -> ' + n + ' (answer: ' + JSON.stringify(message.slice(0, 40)) + ')');
        const reply = 'Done — ' + pc.name + ' is now ' + n + ' bottle' + (n === 1 ? '' : 's') + '. Would you like to see the estimated full price, place the order, generate a PDF proposal, or make any changes?';
        return res.json({ text: reply, response: reply });
      }
      console.log('[qty-change] pending change for ' + pc.name + ' dropped — reply is neither change nor add: ' + JSON.stringify(message.slice(0, 60)));
    }
    // "change the quantity" after "already in your order ... how many in total?" — ask the number
    // for THAT product, never start over (Sep 29: Rachel asked which rum and offered Bacardi back).
    if (state.pendingQtyFor && /^\s*(?:(?:i\s+)?(?:want|would like|like)\s+to\s+)?(?:change|chnage|update|adjust|edit)\s+(?:the\s+)?(?:quantity|qty|amount|count|number)\b[\s.!]*$/i.test(message) && !state.orderStep && !state.proposalStep) {
      const rH = 'How many bottles of ' + state.pendingQtyFor + ' would you like in total?';
      console.log('[qty-change] "change the quantity" -> asking the number for ' + state.pendingQtyFor);
      return res.json({ text: rH, response: rH });
    }
    // Quantity answer for the item just picked (see pendingQtyFor below).
    if (state.pendingQtyFor && /^\s*(\d{1,3})\s*(?:x|bottles?|cases?|packs?)?\s*\.?\s*$/i.test(message) && !state.orderStep && !state.proposalStep) {
      state.qtySuggest = null;
      const q = parseInt(message.match(/\d{1,3}/)[0]);
      const nm = state.pendingQtyFor; state.pendingQtyFor = null;
      try { const it = JSON.parse(state.lastLineItems || '[]'); const nk = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); const row = it.find(x => nk(x.name).indexOf(nk(nm).slice(0,12)) >= 0); if (row) { row.qty = q; row.quantity = q; row.qty_confirmed = true; state.lastLineItems = JSON.stringify(it); } } catch (e) {}
      saveFlowState();
      const reply = 'Got it — ' + q + 'x ' + nm + ' in your order. Would you like to see the estimated full price, place the order, generate a PDF proposal, or make any changes?';
      return res.json({ text: reply, response: reply });
    }
    // DETERMINISTIC PICK-LIST selection. Prompt guidance alone kept failing: after a
    // numbered option list, the customer's "1" or a restated option name produced no
    // confirm_substitute call — the LLM just re-searched and re-listed forever. Resolve
    // the choice here, without the LLM: parse "N. Name — size — $price" lines from the
    // last reply, match the message by number or name, and add via the same real-product
    // resolution path (onSubstituteConfirmed). Skipped if the basket already has it.
    try {
      // ── MULTI-PICK RESOLVER ────────────────────────────────────────────────────
      // Handles what the flat parser can't: several picks in one message ('give me decoy,
      // louis jadot and wolffer'; 'Sauv Blanc 1, Pinot noir 2, rose 4') and GROUPED option
      // lists (a heading per varietal, each numbered from 1). Names are resolved against
      // what Rachel just listed — never re-searched. A pick whose varietal is already in
      // the basket REPLACES that item (a re-price), keeping its quantity.
      try {
        // Parsing + pick resolution live in multipick.js (pure, unit-tested on real replies:
        // qa/unit/multipick.test.js). Real bug fixed there: headings that carried a price
        // ("Sauvignon Blanc alternatives (~$20):") were not recognised, so grouped picks all
        // took global option #1 and a replacement was added as a new line.
        const MP = require('./multipick.js');
        const groups = MP.parseOptionGroups(lastAssistantTextGate);
        const realGroups = groups.filter(g => g.options.length);
        const allOpts = realGroups.flatMap(g => g.options.map(o => Object.assign({ heading: g.heading }, o)));
        const partsRaw = MP.splitSelection(message);
        const isGrouped = realGroups.length >= 2;
        // GUARDS (real failure: 'is it possible to have two brands of vodka, tequila, and rum?'
        // was split on commas and matched against the BASKET listing in the previous reply).
        const lastRTxt = String(lastAssistantTextGate || '');
        const looksLikeOptionList = /\b(which (one|ones|would you)|options?|alternatives?|choose|pick one|would you like to add)\b/i.test(lastRTxt) && /^\s*\d{1,2}[.)]\s/m.test(lastRTxt);
        const looksLikeSelection = !/\?/.test(message) && message.length <= 120 && partsRaw.every(pt => pt.split(/\s+/).length <= 6)
          && !/\b(is it possible|can (we|you)|could (we|you)|sounds like|prefer|would like|i think|maybe|instead of|what about|how about|let'?s have|two brands|more of|less of)\b/i.test(message)
          && !(clsIntent && !['select_option', 'add_item'].includes(clsIntent));
        if (allOpts.length && looksLikeOptionList && looksLikeSelection && (partsRaw.length >= 2 || isGrouped) && !state.orderStep && !state.proposalStep) {
          const rp = MP.resolvePicks(message, groups);
          const picks = rp.picks; const done = rp.notes.slice();
          const resolvedParts = new Set(partsRaw.filter(p => !rp.unmatched.includes(p)));
          if (rp.notes.length) console.log('[multi-pick] notes:', JSON.stringify(rp.notes));
          if (picks.length && (partsRaw.length >= 2 || picks.length >= 2 || isGrouped)) {
            let items = []; try { items = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
            for (const pk of picks) {
              // The group heading names what is replaced ("Sauvignon Blanc alternatives" -> the
              // Sauvignon Blanc line), even when the pick is another varietal.
              const target = MP.replacementTarget(pk, items);
              // Catalog lookup needs a clean name: drop emoji/markers ('⭐', '✓') and fold
              // accents ('Rosé' -> 'Rose'; Bevvi's search doesn't fold diacritics).
              const cleanName = pk.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
              const repl = cleanName + (pk.size && cleanName.indexOf(pk.size) < 0 ? ' - ' + pk.size : '');
              const r = await applyBasketSubstitute(sessionKey, email, target ? target.name : '', repl, pk.price, pk.size);
              if (r && r.success === false) { done.push('could not resolve ' + pk.name); continue; }
              retirePendingFor(state, pk.name);
              done.push((target ? (target.qty || target.quantity || 1) + 'x ' + pk.name + ' (replacing ' + target.name + ')' : '1x ' + pk.name) + ' — $' + pk.price.toFixed(2));
              try { items = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
            }
            // Never silently drop a pick: say which names didn't match anything listed.
            const unmatched = partsRaw.filter(part => !resolvedParts.has(part));
            if (unmatched.length) done.push('couldn\'t match ' + unmatched.join(', ') + ' to anything I listed — tell me the exact name or number and I\'ll add it');
            console.log('[multi-pick]', JSON.stringify(partsRaw), '->', JSON.stringify(done));
            events.note({ path: 'multi_pick' });
            const lines2 = items.map(li => (li.qty || li.quantity || 1) + 'x ' + li.name + ' — $' + (parseFloat(li.price) || 0).toFixed(2) + ' ea = $' + ((li.qty || li.quantity || 1) * (parseFloat(li.price) || 0)).toFixed(2));
            const tot2 = items.reduce((a, li) => a + (li.qty || li.quantity || 1) * (parseFloat(li.price) || 0), 0);
            const rMP = 'Got it:\n' + done.map(d => '• ' + d).join('\n') + '\n\nUpdated basket:\n' + lines2.join('\n') + '\n\nProduct total: $' + tot2.toFixed(2) + '\n\nWould you like to see the estimated full price, place the order, generate a PDF proposal, or make any changes?';
            return res.json({ text: rMP, response: rMP });
          }
        }
      } catch (e) { console.log('[multi-pick] error, falling through:', e.message); }
      const pickLines = [];
      const reLine = /^\s*(\d{1,2})[\.\)]\s*\*?([^\n*—$]+?)\*?\s*(?:—\s*([^—$\n]*?))?\s*—?\s*\$([\d.]+)/gm;
      let pm;
      while ((pm = reLine.exec(lastAssistantTextGate)) !== null) {
        // Strip Slack bold markers that can cling to the edges ("750 ML*" showed in a reply).
        pickLines.push({ n: parseInt(pm[1]), name: pm[2].replace(/\*/g, '').trim(), size: (pm[3] || '').replace(/\*/g, '').trim(), price: parseFloat(pm[4]) });
      }
      console.log('[pick-list] gate — lines:', pickLines.length, '| orderStep:', state.orderStep, '| proposalStep:', state.proposalStep, '| msg:', JSON.stringify(message).slice(0, 30));
      if (pickLines.length >= 2 && !state.orderStep && !state.proposalStep) {
        const msgClean = message.replace(/\*/g, '').trim();
        const norm = s => String(s || '').toLowerCase().replace(/\s*[-—]?\s*\d+(\.\d+)?\s*(ml|l|oz)\b.*$/i, '').replace(/[^a-z0-9]/g, '');
        let picked = null;
        const numM = msgClean.match(/^(?:option\s*|#\s*)?(\d{1,2})\s*\.?$/i);
        if (numM) picked = pickLines.find(l => l.n === parseInt(numM[1])) || null;
        if (!picked) {
          const mN = norm(msgClean);
          // Tolerant match — fuzzy prefix/overlap, not exact. Real bug: the customer typed
          // "La Crema Chardonnay Sonoma Coas" (one letter short) and the exact-name check
          // failed, so the options were re-listed. Accept if the message is a prefix of
          // the option (>= 8 chars), the option is a prefix of the message, or they share
          // >= 70% of meaningful words.
          const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !/^\d+$/.test(w) && !/^(the|and|with|ml|oz|bottle|can|pack)$/.test(w));
          const mW = words(msgClean);
          const scored = pickLines.map(l => {
            const lN = norm(l.name), lW = words(l.name);
            const prefix = (mN.length >= 8 && lN.indexOf(mN) === 0) || (lN.length >= 8 && mN.indexOf(lN) === 0);
            const overlap = lW.length ? lW.filter(w => mW.includes(w)).length / lW.length : 0;
            return { l, s: prefix ? 1 : overlap };
          }).filter(x => x.s >= 0.7).sort((a, b) => b.s - a.s);
          const exact = scored.length && (scored.length === 1 || scored[0].s > scored[1].s) ? [scored[0].l] : scored.map(x => x.l);
          if (exact.length === 1) picked = exact[0];
          else if (exact.length > 1) { // prefer size match when several share a name
            const sz = (msgClean.match(/\d+(\.\d+)?\s*(mL|ML|L|oz|OZ)\b/) || [''])[0].toLowerCase().replace(/\s+/g, '');
            picked = exact.find(l => l.size.toLowerCase().replace(/\s+/g, '') === sz) || exact[0];
          }
        }
        if (picked && /^\d+(\.\d+)?\s*(ml|l|oz)$/i.test(picked.name)) {
          // Size-only option lines ("1. 50 mL — $4.39"): the product name is in the heading
          // ("Tito's Handmade Vodka is available in several sizes:"). Recover it, or hand
          // off to the LLM rather than add a bare "750 mL".
          const head = lastAssistantTextGate.replace(/\*/g, '').match(/([A-Z][^\n:]{2,60}?)\s+(?:is available|comes in|is offered|options|sizes)/);
          if (head) { picked = Object.assign({}, picked, { size: picked.name, name: head[1].trim() }); }
          else { console.log('[pick-list] size-only option with no product heading — deferring to LLM'); picked = null; }
        }
        if (picked) {
          // Only a message that is JUST this pick is resolved here; anything more (a question,
          // a second pick, a swap instruction) goes to the LLM whole. Real bug (Sep 28): a pick +
          // "Do you have regular Don Julio blanco?" + "Casamigos look good" lost the last two.
          const leftover = require('./multipick.js').pickLeftover(msgClean, picked);
          if (leftover.length) { console.log('[pick-list] DEFERRED to LLM — message is more than a pick of #' + picked.n + ' (leftover: ' + JSON.stringify(leftover.slice(0, 12)) + ')'); picked = null; }
        }
        if (picked) {
          let already = false;
          try { already = JSON.parse(state.lastLineItems || '[]').some(it => norm(it.name) === norm(picked.name)); } catch (e) {}
          if (!already) {
            console.log('[pick-list] deterministic selection:', JSON.stringify(picked));
            events.note({ path: 'pick_list' });
            state.lastPickResolved = { name: picked.name, size: picked.size, at: Date.now() };
            // Replace-in-varietal (same rule as the multi-pick resolver): if the basket already
            // holds a wine/spirit of this varietal, the pick REPLACES it and keeps the quantity.
            // Real bug: Whispering Angel 2x -> Wölffer picked via this path -> added at 1x.
            let replTarget = null;
            try {
              const VARS = ['sauvignon','blanc','pinot','noir','grigio','gris','chardonnay','cabernet','merlot','rose','riesling','malbec','syrah','shiraz','zinfandel','champagne','prosecco','cava','tequila','vodka','gin','rum','bourbon','whiskey','whisky','scotch','mezcal','sparkling'];
              const nv = x => new Set(String(x||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').split(/[^a-z]+/).filter(w => VARS.includes(w)));
              const heading = (lastAssistantTextGate.replace(/\*/g,'').match(/([A-Z][^\n:]{2,60}?)\s+(?:options|alternatives|is available|comes in)/) || [])[1] || '';
              const pv = nv(heading + ' ' + picked.name);
              const items0 = JSON.parse(state.lastLineItems || '[]');
              const nk0 = x => String(x||'').toLowerCase().replace(/[^a-z0-9]/g,'');
              if (pv.size) replTarget = items0.find(it => { const iv = nv(it.name); return [...pv].some(v => iv.has(v)) && nk0(it.name) !== nk0(picked.name); }) || null;
            } catch (e) {}
            const r = await applyBasketSubstitute(sessionKey, email, replTarget ? replTarget.name : '', picked.name + (picked.size ? ' - ' + picked.size : ''), picked.price, picked.size);
            retirePendingFor(state, picked.name);
            if (replTarget && !(r && r.success === false)) {
              const keptQty = replTarget.qty || replTarget.quantity || 1;
              const rR = 'Got it — ' + keptQty + 'x ' + picked.name + (picked.size ? ' — ' + picked.size : '') + ' — $' + picked.price.toFixed(2) + ' (replacing ' + replTarget.name + '). Would you like to see the estimated full price, place the order, generate a PDF proposal, or make any changes?';
              return res.json({ text: rR, response: rR });
            }
            const added = picked.name + (picked.size ? ' — ' + picked.size : '') + ' — $' + picked.price.toFixed(2);
            // Ask quantity ONCE, at pick time — never silently default to 1 (real
            // complaint: a red wine was added at 1x with no question, while the white
            // got asked at order time). If the customer stated a number, use it.
            // A number inside the product's own name ("Knob Creek 12 Year") is not a quantity.
            const statedQty = /^\d{1,2}$/.test(msgClean.trim()) ? 0 : require('./multipick.js').statedPickQty(msgClean, picked);
            if (statedQty > 1) {
              try { const it = JSON.parse(state.lastLineItems || '[]'); const nk = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); const row = it.find(x => nk(x.name).indexOf(nk(picked.name).slice(0,12)) >= 0); if (row) { row.qty = statedQty; row.quantity = statedQty; row.qty_confirmed = true; state.lastLineItems = JSON.stringify(it); saveFlowState(); } } catch (e) {}
              const reply = 'Got it — ' + statedQty + 'x ' + added + ' added to your order. Would you like to see the estimated full price, place the order, generate a PDF proposal, or make any changes?';
              return res.json({ text: reply, response: reply });
            }
            state.pendingQtyFor = picked.name;
            saveFlowState();
            const reply = 'Got it — ' + added + '. How many bottles would you like?';
            return res.json({ text: reply, response: reply });
          }
        }
      }
    } catch (e) { console.log('[pick-list] error:', e.message); }
    // Loop fix: once a selection has been resolved (a merge succeeded), the same
    // "which would you like?" prompt must not keep re-opening the gate on every later
    // message — that caused the LLM to re-present the already-chosen options forever.
    const alreadyResolved = state.resolvedSelectionPrompt && state.resolvedSelectionPrompt === lastAssistantTextGate;
    const looksLikeSelectionPrompt = !alreadyResolved && /which (one|option|would)|would you like to (go with|choose|add)|works for you/i.test(lastAssistantTextGate);
    const hasPendingSub = state.pendingSubstitutes && state.pendingSubstitutes.length > 0;
    // Gate narrowed to genuine unavailable-item substitution ONLY. This block used to
    // also fire on any "which would you like?" reply (looksLikeSelectionPrompt), but
    // with no pending item it can't know what's being replaced, so it just ADDED qty 1
    // of whatever name it matched — the source of every stray 1x entry and duplicate
    // (real session: "Alamos Malbec" -> stray 1x; "replace Yellow Tail with Alamos" ->
    // added the item being REMOVED). Voluntary swaps and list selections now go to the
    // LLM's confirm_substitute, which resolves the real product and the right quantity.
    if (hasPendingSub) {
      console.log('[substitute-merge] gate: hasPendingSub:', hasPendingSub, '| looksLikeSelectionPrompt:', looksLikeSelectionPrompt, '| message:', JSON.stringify(message).slice(0, 100));
      // Real gap found tonight: options are sometimes offered several turns apart
      // (e.g. gin options in one turn, triple sec options several turns earlier),
      // and the customer can confirm both together later — scanning only the single
      // most recent assistant message misses anything presented earlier. Scan the
      // last several assistant turns instead, so an option is still matchable even
      // if it wasn't the very last thing said.
      // Real root cause found tonight: sessions[sessionKey] stores each step of the
      // LLM's multi-step tool-use loop as a SEPARATE assistant message — including
      // trivial filler text like "Let me search for both simultaneously!" emitted
      // before a tool call. Scanning the last N raw assistant messages was picking up
      // these filler turns instead of the actual substantive reply (the one with real
      // candidate options and prices) that the customer saw in Slack — confirmed via
      // direct diagnostic logging showing recentAssistantTextSel as just filler text
      // with zero candidates ever extractable from it. Fix: extract text from EVERY
      // assistant message first, then filter to only those containing a "$" (any
      // genuine candidate-presenting reply will have a price; filler/procedural text
      // won't) before taking the last few for candidate extraction.
      // Use the ACTUAL outgoing reply texts tracked via lastRepliesBySession (see
      // definition near the top of the file) — NOT sessions[sessionKey], which does not
      // reliably contain the real formatted reply text (confirmed via direct diagnostic
      // logging: most "assistant" entries there are empty strings or filler, since a
      // turn's only model output can be a tool_use block with no accompanying text).
      const substantiveAssistantTexts = (lastRepliesBySession[sessionKey] || []).slice().reverse().filter(t => t.includes('$')).slice(0, 4);
      const recentAssistantTextSel = substantiveAssistantTexts.join(String.fromCharCode(10));

      // Extract candidate options Rachel presented, across two formats:
      // 1) Line-based "Name — Size — $Price" (bullets/numbered lists)
      // 2) Free-flowing prose "Name at $Price" or "Name — $Price" inline mentions
      // (real bug found tonight: prose like "Bombay Gin — 750 mL — $27.49. ... or
      // stick with Plymouth at $37.39, Drumshanbo at $43.99" mixes both styles in
      // one paragraph — a pure line-split regex misses the inline mentions entirely).
      const candidateLines = recentAssistantTextSel.split(String.fromCharCode(10));
      let candidates = []; // let: reassigned by the fragment filter below
      for (const line of candidateLines) {
        // Format 1: dash-separated, one option per visual line
        const priceMatch = line.match(/\$([\d.]+)/);
        if (priceMatch) {
          const beforePrice = line.slice(0, priceMatch.index);
          const dashSplit = beforePrice.split(/[—-](?!\s*\$)/);
          if (dashSplit.length >= 2) {
            let namePart = dashSplit[0];
            // Trim to only the text after the LAST sentence-boundary punctuation
            // (. ! ? :) — otherwise a preceding sentence like "Here's a more
            // affordable option: Bombay Gin" gets captured as the whole "name",
            // breaking brand-word matching entirely (confirmed a real bug tonight).
            const sentenceBoundary = namePart.match(/.*[.!?:]\s*/);
            if (sentenceBoundary) namePart = namePart.slice(sentenceBoundary[0].length);
            let name = namePart.replace(/^\s*\d+[\.\)]\s*/, '').replace(/\*/g, '').trim();
            if (name && name.split(' ').length <= 8) {
              const sizeMatch = beforePrice.match(/\d+(\.\d+)?\s*(mL|ML|L|oz|OZ)\b/);
              candidates.push({ name, price: parseFloat(priceMatch[1]), size: sizeMatch ? sizeMatch[0] : '' });
            }
          }
        }
        // Format 2: inline "Name at $Price" or "Name (— )?$Price" mentions, possibly
        // several per line/sentence — global match to catch all of them.
        const inlineRe = /([A-Za-z][A-Za-z0-9'’.\s]{2,40}?)\s*(?:—\s*)?(?:at\s+)?\$([\d.]+)/g;
        let m;
        while ((m = inlineRe.exec(line)) !== null) {
          let name = m[1].replace(/^\s*\d+[\.\)]\s*/, '').replace(/\*/g, '').trim();
          // Skip if this looks like a duplicate of something format-1 already caught,
          // or if the "name" is just leftover connector words with nothing brand-like.
          if (!name || name.split(' ').length > 8) continue;
          const alreadyHave = candidates.some(c => c.name.toLowerCase() === name.toLowerCase());
          if (alreadyHave) continue;
          candidates.push({ name, price: parseFloat(m[2]), size: '' });
        }
      }

      // Reject fragment "candidates". The inline regex can start matching mid-token,
      // producing junk like "x12 Oz", "ML", "OZ", "Got it", "Well within your" — and
      // one of those junk fragments once WON a merge and replaced real Stella Artois
      // with a phantom "x12 Oz" item. A real product name starts with a letter that
      // isn't glued to a preceding digit, is not just a size unit, and isn't filler.
      function isPlausibleProductName(n) {
        const s = String(n || '').trim();
        if (!s) return false;
        if (/^(x\d|ML|L|OZ|mL|oz)\b/i.test(s)) return false;              // "x12 Oz", "ML", "OZ"
        if (/^(got it|well within|of your|at|hmm|keep as|is and|for the|within|here's|spirits bumped)/i.test(s)) return false; // filler
        if (!/[A-Za-z]{3,}/.test(s)) return false;                           // needs a real word
        if (/^\d/.test(s)) return true;                                     // "3x Rittenhouse..." is fine
        return true;
      }
      candidates = candidates.filter(c => isPlausibleProductName(c.name));
      if (candidates.length > 0) {
        const msgLowerSel = message.toLowerCase().replace(/\*/g, '');
        // Real false-positive risk found tonight: a compound message like "Hiram Walker
        // is good, but I need a gin same price as New Amsterdam" mentions "New Amsterdam"
        // (a REJECTED option) alongside confirming a different one — matching on "does
        // the candidate's first word appear ANYWHERE in the message" would incorrectly
        // treat the rejected option as the customer's pick. Now require a genuine
        // confirmation phrase to appear NEAR the candidate's mention (within ~40 chars
        // after it), not just anywhere in the message — "New Amsterdam" appearing in a
        // "same price as X" clause, far from any confirmation language, correctly won't
        // match; "Hiram Walker ... is good" (confirmation immediately after) will.
        // Real, definitive root cause found tonight (traced through every single failed
        // test): requiring an explicit confirmation phrase near the candidate mention was
        // TOO STRICT — it silently blocked the single most common way customers actually
        // confirm a choice: simply restating the option verbatim (e.g. "Bombay Original —
        // 750 mL — $27.49"), with no "is good"/"works"/etc at all. Two-tier matching now:
        // Tier 1 — if the customer's message is short and dominated by ONE candidate's
        // name (no confirmation phrase required — restating the option IS the
        // confirmation). Tier 2 — for longer/compound messages that mention a candidate's
        // brand word alongside other content, still require nearby confirmation language,
        // since that's exactly the scenario that caused a real false positive earlier
        // tonight ("...same price as New Amsterdam" incorrectly matching the rejected item).
        const wordsInMsg = msgLowerSel.replace(/[^a-z0-9\s]/gi, ' ').split(/\s+/).filter(Boolean);
        const isShortMsg = wordsInMsg.length <= 10;
        const confirmPhrases = ['is good', 'sounds good', 'i like', 'works', "let's go", 'lets go', "i'll take", 'ill take', 'yes', 'good choice', 'perfect', 'great'];

        // Match on the first TWO words when available, not just one — real ambiguity
        // found tonight: two candidates sharing a brand ("Bombay Original" vs "Bombay
        // Sapphire") both matched on "bombay" alone, leaving Tier 1 unable to pick either.
        function candidateWordMatch(c) {
          const nameWords = c.name.split(' ').filter(w => w.length > 2);
          const phrase = nameWords.slice(0, 2).join(' ').toLowerCase();
          if (!phrase) return null;
          const phraseRe = new RegExp(phrase.replace(/[^a-z0-9\s]/gi, '').split(/\s+/).join('\\s+'), 'i');
          const twoWordMatch = phraseRe.exec(msgLowerSel);
          if (twoWordMatch) return twoWordMatch;
          // Fall back to single-word match only if there's just one word to work with
          // (e.g. a one-word product name) — otherwise require the fuller phrase above.
          if (nameWords.length === 1) {
            const wordRe = new RegExp('\\b' + nameWords[0].toLowerCase().replace(/[^a-z0-9]/gi, '') + '\\b', 'i');
            return wordRe.exec(msgLowerSel);
          }
          return null;
        }

        let matched = null;

        // Tier 0.5 — EXACT full-name match, checked before every heuristic. The 2-word
        // heuristic below is still ambiguous when candidates share their first two
        // words ("Angostura Bitters" vs "Angostura Bitters Cocoa"): "swap with Angostura
        // Bitters" matched both, so Rachel re-asked three times. If the message contains
        // a candidate's complete name as a whole phrase, that candidate wins outright.
        // Where one name is a prefix of another, prefer the LONGEST name the message
        // actually contains — so "Angostura Bitters" (no "Cocoa" in the message) picks
        // the plain bitters, while "Angostura Bitters Cocoa" picks the cocoa one.
        {
          const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
          const msgN = ' ' + norm(msgLowerSel) + ' ';
          let exact = candidates
            .filter(c => { const n = norm(c.name.replace(/^\d+x\s*/i, '')); return n.length >= 4 && msgN.indexOf(' ' + n + ' ') >= 0; })
            .sort((a, b) => b.name.length - a.name.length);
          // "replace X with Y" / "swap X for Y" / "Y instead of X": the message contains
          // BOTH names; longest-wins picked X (the item being removed). Prefer the
          // candidate positioned as the replacement.
          if (exact.length > 1) {
            const withM = msgN.match(/\b(?:replace|swap|change|switch)\b.*?\b(?:with|for|to)\b(.*)$/);
            const insteadM = msgN.match(/^(.*?)\binstead of\b/);
            const tail = withM ? withM[1] : (insteadM ? insteadM[1] : null);
            if (tail) {
              const inTail = exact.filter(c => (' ' + tail + ' ').indexOf(' ' + norm(c.name.replace(/^\d+x\s*/i, '')) + ' ') >= 0);
              if (inTail.length) exact = inTail;
            }
          }
          if (exact.length > 0) {
            matched = exact[0];
            console.log('[substitute-merge] Tier 0.5 exact full-name match:', JSON.stringify(matched.name));
          }
        }

        // Tier 0: bare affirmative with NO item name at all (e.g. "sounds good", "yes")
        // replying to a single-candidate proposal question (e.g. "Bombay London Dry
        // Gin — 750 mL — $27.49. Works for you?") — real gap found tonight: this is a
        // completely normal way to confirm, but neither Tier 1 nor Tier 2 can match it
        // since both require the candidate's name to appear in the CUSTOMER's own
        // message, and here it doesn't at all — the item is identified purely by
        // Rachel's immediately preceding question. Only look at Rachel's SINGLE most
        // recent message (not the wider multi-turn scan) so a bare "yes" doesn't
        // accidentally confirm some OLDER option from several turns back.
        const bareAffirmatives = ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'good', 'fine'];
        const isBareAffirmative = !isShortMsg ? false : (
          confirmPhrases.some(p => msgLowerSel.trim() === p || msgLowerSel.trim().startsWith(p + ' ') || msgLowerSel.trim().startsWith(p + '.') || msgLowerSel.trim().startsWith(p + '!')) ||
          bareAffirmatives.some(w => msgLowerSel.trim() === w)
        );
        if (isBareAffirmative && substantiveAssistantTexts.length > 0) {
          const singleMsgText = substantiveAssistantTexts[0];
          const singleMsgPriceMatches = [...singleMsgText.matchAll(/\$([\d.]+)/g)];
          if (singleMsgPriceMatches.length === 1) {
            const onlyPriceMatch = singleMsgPriceMatches[0];
            const beforeOnlyPrice = singleMsgText.slice(0, onlyPriceMatch.index);
            const dashSplitSingle = beforeOnlyPrice.split(/[—-](?!\s*\$)/);
            if (dashSplitSingle.length >= 2) {
              let namePartSingle = dashSplitSingle[0];
              const sentenceBoundarySingle = namePartSingle.match(/.*[.!?:]\s*/);
              if (sentenceBoundarySingle) namePartSingle = namePartSingle.slice(sentenceBoundarySingle[0].length);
              const nameSingle = namePartSingle.replace(/^\s*\d+[\.\)]\s*/, '').replace(/\*/g, '').trim();
              // Real bug: 'Yes' to Rachel's clarifying question "To clarify — ... around
              // $20/bottle ...?" was read as accepting a product named "To clarify" at $20.
              // Require an offer shape: no question/clarifier lead-in, and a price that is
              // a line/list price (not "around $20", "$20/bottle", "$20 per bottle").
              const lastTxtT0 = substantiveAssistantTexts[substantiveAssistantTexts.length - 1] || '';
              const looksLikeQuestionName = /^(to clarify|just to (confirm|clarify)|do you|would you|should i|shall i|which|can i|could i|are you|is that|so you)/i.test(nameSingle);
              const priceIsRate = /(around|about|approx\.?|roughly|under|over|up to|~)\s*\$\s*[\d.,]+/i.test(lastTxtT0) || /\$\s*[\d.,]+\s*(\/|per\b|a bottle|each bottle|apiece)/i.test(lastTxtT0);
              const looksLikeOffer = !looksLikeQuestionName && !priceIsRate;
              if (!looksLikeOffer) console.log('[substitute-merge] Tier 0 skipped — last reply is a question/rate, not a product offer:', JSON.stringify(nameSingle));
              if (looksLikeOffer && nameSingle && nameSingle.split(' ').length <= 8) {
                const sizeMatchSingle = beforeOnlyPrice.match(/\d+(\.\d+)?\s*(mL|ML|L|oz|OZ)\b/);
                if (!matched) matched = { name: nameSingle, price: parseFloat(onlyPriceMatch[1]), size: sizeMatchSingle ? sizeMatchSingle[0] : '' };
                console.log('[substitute-merge] Tier 0 (bare affirmative to single-candidate question) matched:', nameSingle);
              }
            }
          }
        }

        if (!matched && isShortMsg) {
          // Tier 1: short message — a single matching candidate is treated as a direct
          // restatement/confirmation, no extra phrase needed.
          const tier1Matches = candidates.filter(c => candidateWordMatch(c) !== null);
          if (!matched && tier1Matches.length === 1) matched = tier1Matches[0];
        }
        if (!matched) {
          // Tier 2: longer/compound message — require genuine confirmation language
          // near the mention, to avoid matching a candidate referenced only in passing
          // or in a rejecting/comparative context.
          matched = candidates.find(c => {
            const wordMatch = candidateWordMatch(c);
            if (!wordMatch) return false;
            const windowAfter = msgLowerSel.slice(wordMatch.index, wordMatch.index + 60);
            return confirmPhrases.some(p => windowAfter.includes(p));
          }) || null;
        }

        if (matched) {
          try {
            // Real bug found tonight: with multiple items pending substitution
            // simultaneously (e.g. both a Gin AND a Triple Sec), blindly using
            // pendingSubstitutes[0] as "the original item this replaces" credited the
            // WRONG item — a chosen Triple Sec candidate was reported as replacing the
            // Gin, just because Gin happened to be first in the array. Match the
            // candidate's own category/type (vodka, gin, triple sec, etc.) against each
            // pending item to find the one it actually corresponds to, falling back to
            // index 0 only if no type-based match is found.
            const TYPE_MATCH_KEYWORDS = ['triple sec', 'vodka', 'gin', 'rum', 'tequila', 'whiskey', 'whisky', 'bourbon', 'scotch', 'cognac', 'brandy', 'liqueur', 'wine', 'beer', 'seltzer', 'champagne', 'cider'];
            const matchedNameLower = matched.name.toLowerCase();
            const matchedCandidateType = TYPE_MATCH_KEYWORDS.find(t => matchedNameLower.includes(t));
            const hasOriginalToReplace = state.pendingSubstitutes && state.pendingSubstitutes.length > 0;
            let originalItemName = null;
            if (hasOriginalToReplace) {
              if (matchedCandidateType) {
                originalItemName = state.pendingSubstitutes.find(p => p.toLowerCase().includes(matchedCandidateType)) || state.pendingSubstitutes[0];
              } else {
                originalItemName = state.pendingSubstitutes[0];
              }
            }
            const originalBrandWord = originalItemName ? originalItemName.split(' ')[0].toLowerCase() : null;
            let items = [];
            try { items = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
            let qtyToUse = 1;
            // Route through applyBasketSubstitute so the item is RESOLVED to a real catalog
            // product (productId/upc/establishmentId). This block used to hand-build the
            // line item with product_id:'', upc:'', establishmentId:'' — real bug: a
            // "yes" to a Tito's substitute pushed a bare name, and createCorpOrder failed
            // on a product with no identifiers ("system error placing the order").
            if (originalBrandWord) {
              const removeIdx = items.findIndex(it => (it.name || it.label || '').toLowerCase().includes(originalBrandWord));
              if (removeIdx >= 0) qtyToUse = items[removeIdx].qty || items[removeIdx].quantity || 1;
            }
            const subRes = await applyBasketSubstitute(sessionKey, email, hasOriginalToReplace ? originalItemName : '', matched.name + (matched.size ? ' - ' + matched.size : ''), matched.price, matched.size);
            if (subRes && subRes.success === false) {
              // Never claim a replacement that was refused (unresolved product).
              const rRef = 'I couldn\'t find "' + matched.name + '" in the catalog, so nothing was changed. Tell me the product you\'d like and I\'ll look it up.';
              return res.json({ text: rRef, response: rRef });
            }
            // applyBasketSubstitute adds at qty 1 (or the replaced item's qty when it finds
            // the original); enforce the intended qty explicitly.
            try {
              const itemsAfter = JSON.parse(state.lastLineItems || '[]');
              const normQ = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              const added = itemsAfter.find(it => normQ(it.name).indexOf(normQ(matched.name).slice(0, 12)) >= 0);
              if (added && qtyToUse > 1) { added.qty = qtyToUse; added.quantity = qtyToUse; state.lastLineItems = JSON.stringify(itemsAfter); }
            } catch (e) {}
            const newLineItems = state.lastLineItems;
            if (hasOriginalToReplace) state.pendingSubstitutes = state.pendingSubstitutes.filter(p => p !== originalItemName);
            saveFlowState();
            try { saveBasket(email, newLineItems, '', format).catch(() => {}); } catch (e) {}
            // Mark this selection prompt as resolved so the gate won't re-open on it.
            state.resolvedSelectionPrompt = lastAssistantTextGate;
            saveFlowState();
            console.log('[substitute-merge]', hasOriginalToReplace ? 'replaced' : 'added (ad-hoc, no original to replace)', hasOriginalToReplace ? JSON.stringify(originalItemName) + ' with' : '', JSON.stringify(matched.name), 'qty', qtyToUse);

            const stillPending = hasOriginalToReplace && state.pendingSubstitutes.length > 0;
            const confirmReply = 'Got it — ' + qtyToUse + 'x ' + matched.name + (matched.size ? ' (' + matched.size + ')' : '') +
              ' at $' + matched.price.toFixed(2) + ' ea ' + (hasOriginalToReplace ? 'has replaced ' + originalItemName + ' in your order.' : 'has been added to your order.') +
              (stillPending ? ' Still need a substitute for: ' + state.pendingSubstitutes.join(', ') + '.' : ' Would you like to place the order, generate a PDF proposal, or make any changes?');
            return res.json({ text: confirmReply, response: confirmReply });
          } catch (e) {
            console.error('[substitute-merge] error:', e.message);
            // Fall through to the normal LLM path on error rather than failing the turn.
          }
        }
      }
    }

    // Search-result cache invalidation check — this clears the L1/L2 SEARCH-RESULT
    // caches only, NOT the active order (state.lastLineItems). A genuine, severe bug
    // found and fixed tonight: fingerprint(message) hashes the raw message TEXT, so it
    // changes on virtually every single turn (customers essentially never repeat the
    // exact same message) — the previous code nulled state.lastLineItems here too,
    // meaning the customer's ENTIRE active order was silently wiped on almost every
    // turn, "masked" only when that same turn's tool call happened to rebuild the
    // basket from scratch (e.g. custom_list/menu_build) — but permanently destroyed on
    // any turn that didn't (e.g. a plain product_query while resolving a substitution),
    // which is exactly what caused a real ~20-item order to collapse down to just 2
    // leftover search-result items. The active order must persist across turns
    // regardless of what the customer's raw message text was — only explicit actions
    // (a fresh custom_list/menu_build build, a zip change, an explicit reset) should
    // ever clear it, never an incidental hash-of-the-message-text change.
    const fp = fingerprint(message);
    if (fp !== state.lastFingerprint || state.zip !== state.lastZip) {
      if (state.lastFingerprint && state.lastZip) {
        clearCache(email, format);
        console.log('[cache] search-result cache invalidated: new request or zip changed (active order preserved)');
      }
      state.lastFingerprint = fp;
      state.lastZip = state.zip;
      saveFlowState();
    }

    // Load GBrain context
    let gbrainContext = '';
    if (email && !skip_gbrain) {
      gbrainContext = await getCustomerContext('', '', context?.client_id || 'airculinaire', email).catch(() => '');
    } else if (skip_gbrain && gbrain_context) {
      gbrainContext = gbrain_context;
    }

    // Load cached package if available
    const cacheKey = makeCacheKey(email, state.zip, fp);
    if (packageCache[cacheKey]) {
      context.saved_package = packageCache[cacheKey];
      console.log('[package] L1 cache hit:', cacheKey);
    }

    // Build address rule for Rachel
    context.saved_zip = state.zip;
    const addressRule = `\n\n## DELIVERY ADDRESS\nZip: ${state.zip}. Address: ${state.address}. Use this zip for ALL ShoppingAgent calls. NEVER ask about address or age — both are already confirmed.\n\n## AGE\nCustomer is verified 21+. Never ask for age.`;

    // Append saved package rule if exists
    let fullAddrRule = addressRule;
    if (context.saved_package) {
      fullAddrRule += `\n\n## ACTIVE PACKAGE\nline_items: ${context.saved_package}\nFor brand swaps: keep quantities, swap only requested item. Call ShoppingAgent intent=custom_list with updated named_products.`;
    }
    // Once the customer has answered the mixers question, say so explicitly — otherwise
    // the LLM re-asks "would you also like to add mixers...?" on every later turn.
    try {
      const stMx = getState(sessionKey);
      // After a deterministic pick-list add, the LLM's context still holds the option
      // list with no sign it was answered, so it re-presents the options on every later
      // request (real loop: "add a grey goose" re-listed the Kendall Jackson options;
      // "estimated full price" re-listed BOTH lists). Tell it the pick is resolved and
      // show the live basket so additions are treated as additions.
      if (stMx.lastPickResolved && Date.now() - stMx.lastPickResolved.at < 30 * 60 * 1000) {
        fullAddrRule += `\n\n## PICK LIST RESOLVED\nThe customer already chose "${stMx.lastPickResolved.name}${stMx.lastPickResolved.size ? ' ' + stMx.lastPickResolved.size : ''}" from the options you presented; it is IN the basket. Do NOT re-present those options or ask which one they want again. Treat any new product request as an ADDITION to the basket.`;
      }
      try {
        const liveItems = JSON.parse(stMx.lastLineItems || '[]');
        if (liveItems.length) fullAddrRule += `\n\n## CURRENT BASKET (authoritative)\n` + liveItems.map(li => `${li.qty || li.quantity || 1}x ${li.name} — $${(parseFloat(li.price) || 0).toFixed(2)}`).join('\n') + `\nWhen the customer asks for the estimate, price, or to place the order, use THESE items — never re-list options for items already here.`;
      } catch (e) {}
      if (stMx.mixerAnswered) fullAddrRule += `\n\n## MIXERS ALREADY ANSWERED\nThe customer has already answered the mixers/water/soda/ice/cups question for this package. Do NOT ask it again. End replies with the place-order / proposal / changes options instead.`;
    } catch (e) {}
      // Inject the persisted event parameters (OUTSIDE the saved_package branch: that
      // branch depends on an in-memory cache that is empty after every restart, which
      // is exactly when these persisted params are needed). Fires whenever they exist.
      // Inject the persisted event parameters so a single-parameter change (new budget,
      // new headcount) can rebuild using everything else already known — even after a
      // restart wiped the LLM's conversation memory.
      try {
        const stEP = getState(sessionKey);
        if (stEP.eventParams) {
          const ep = stEP.eventParams;
          fullAddrRule += `\n\n## EVENT PARAMETERS (already established — REUSE these, do not re-ask)\nguests: ${ep.guests || 'unknown'} | hours: ${ep.hours || (ep.drinks_per_person ? ep.drinks_per_person + ' drinks/person' : 'unknown')} | budget: ${ep.budget ? '$' + ep.budget : 'unknown'}` + (ep.categories ? ` | categories: ${JSON.stringify(ep.categories)}` : '') + (ep.named_products ? `\nnamed_products: ${ep.named_products}` : '') + `\nIf the customer changes ONE of these (e.g. a new budget), rebuild with the SAME intent (${ep.intent || 'custom_list'}) using all the other values above unchanged.`;
        }
      } catch (e) {}


    // Call Rachel
    try { getState(sessionKey).builtTotals = null; } catch (e) {}
    let output = await callRachel({ sessionKey, message, context, format, gbrainContext, addressRule: fullAddrRule, email });
    // A package built this turn is always shown with its totals — in code, not left to the LLM.
    // Real bug (event-serving-mix, Sep 27 nightly): the custom_list build succeeded but ginger
    // beer and lime juice were unavailable; the LLM narrated the gap, listed the items and
    // dropped the Product total / grand total block entirely.
    try {
      const bt = getState(sessionKey).builtTotals;
      // Only when the reply presents the package ("8x Name — $x" lines, also "Red: 8x ..."); an options list after a
      // build (reprice: "1. Name — $24.19") is not a package and gets no totals.
      const pkgLines = (output.match(/(?:^|[\s:])[*_]?\d{1,3}x\s[^\n]*\$\d/gm) || []).length;
      if (bt && pkgLines >= 2 && !/product total/i.test(output)) {
        const b = format === 'slack' ? '*' : '';
        const block = 'Product total: $' + bt.pt + '\nEstimated Tax (10%): $' + bt.tax + '\nEstimated Delivery: $' + bt.del + '\nService Charge (10%): $' + bt.svc + '\nTip (5%): $' + bt.tip + '\n' + b + 'Estimated grand total: $' + bt.grand + (bt.budget ? ' of your $' + bt.budget + ' budget' : '') + b;
        const paras = output.trimEnd().split(/\n\s*\n/);
        if (paras.length > 1 && /\?\s*\**\s*$/.test(paras[paras.length - 1])) paras.splice(paras.length - 1, 0, block); else paras.push(block);
        output = paras.join('\n\n');
        console.log('[reply] totals added in code — the LLM omitted them for this turn\'s build (product total $' + bt.pt + ')');
      }
    } catch (e) { console.error('[reply] totals insert failed:', e.message); }
    // Category subtotals ("Wine total: $X") on every package reply — computed from the build, not left to
    // the LLM (it wrote them in about half the Sep 27-28 QA runs). See package-subtotals.js.
    try {
      const bt = getState(sessionKey).builtTotals;
      const pkgLines = (output.match(/(?:^|[\s:])[*_]?\d{1,3}x\s[^\n]*\$\d/gm) || []).length;
      if (bt && bt.lineItems && pkgLines >= 2) {
        const subs = categorySubtotals(bt.lineItems, bt.pt);
        if (subs.skip) console.log('[reply] subtotals SKIPPED (' + subs.skip + ')');
        else if (subs.length) {
          const r = applySubtotals(output, subs, format === 'slack');
          output = r.text;
          console.log('[reply] subtotals in code: ' + subs.map(c => c.label + ' $' + c.total.toFixed(2)).join(', ') + (r.fallback.length ? ' | no section header for ' + r.fallback.join(', ') + ' — placed before Product total' : ''));
        }
      }
    } catch (e) { console.error('[reply] subtotals insert failed:', e.message); }

    // ── Post-process: mixer/CTA using explicit state ─────────────────────
    const noKw = ['no', 'nope', 'no thanks', 'no worries', "that's all", 'thats all', "i'm good", 'im good', 'nothing else'];
    const hasProposal = output.toLowerCase().includes('your proposal') || output.includes('proposals/bevvi-proposal') || output.includes('download proposal');
    const isEventPackage = output.includes('Product total') || output.includes('Estimated grand total') || output.includes('grand total');
    const isSingleProduct = !isEventPackage && output.includes('$') && (output.match(/\d+ML/i) !== null || output.match(/\d+L\b/) !== null) && output.split('$').length <= 3;
    // Real bug: replies said "Estimated Grand Total", which does NOT contain the
    // substring 'Estimated total', so packageShown never got set, the deterministic
    // mixer-decline handler stayed gated off, and "no" to mixers looped forever.
    const packageJustShown = isEventPackage || /estimated (grand )?total|product total/i.test(output);
    // A keyword list can never keep up with the LLM's open-ended phrasing (it improvises
    // freely — "want me to go ahead?", "shall I get this started?", "ready to order?", etc.
    // are all valid ways to ask the same thing, and new phrasings appear constantly). The
    // robust, general signal: if the LLM's reply already ends with a question mark, it
    // already asked the customer something — never append a second question on top of it.
    const trimmedOutputForCTA = output.trim();
    const endsWithQuestion = trimmedOutputForCTA.endsWith('?');
    const ctaPatterns = [
      'place the order', 'place an order', 'placing the order', 'placing an order',
      'pdf proposal', 'generate a proposal', 'generate the proposal',
      'make any changes', 'any changes', 'anything else', 'would you like to',
      'shall i', 'let me know if'
    ];
    const outputLowerForCTA = trimmedOutputForCTA.toLowerCase();
    const hasCTA = endsWithQuestion || ctaPatterns.some(p => outputLowerForCTA.includes(p));

    // Update state based on output
    if (packageJustShown) state.packageShown = true;
    if (isSingleProduct) state.packageShown = true;
    if (hasProposal) { state.packageShown = false; state.mixerAsked = false; state.mixerAnswered = false; }

    // Detect if customer just answered mixer question
    if (state.mixerAsked && !state.mixerAnswered) {
      if (noKw.some(w => msgLower.includes(w)) || yesWords.some(w => msgLower.includes(w))) {
        state.mixerAnswered = true;
      }
    }
    if (output.includes('mixer') || output.includes('water, soda') || output.includes('ice, or cups')) {
      state.mixerAsked = true;
    }
    saveFlowState();

    let finalOutput = output;

    const packageWasShown = isEventPackage || output.includes('Estimated total') || output.includes('estimated total') || (output.includes('$') && !hasCTA && !hasProposal);
    if (!hasCTA && !hasProposal && (state.packageShown || packageWasShown)) {
      if (isEventPackage && !state.mixerAsked) {
        // Event package — ask about mixers first
        finalOutput += format === 'slack'
          ? '\n\nWould you also like to add mixers, water, soda, ice, or cups?'
          : '\n\nWould you also like to add mixers, water, soda, ice, or cups?';
        state.mixerAsked = true;
        saveFlowState();
      } else if (!isEventPackage || state.mixerAnswered || state.mixerAsked) {
        // Single product or mixer already handled — show CTA (capability-aware)
        const ctaCaps = getCapabilities(format);
        const ctaActions = [];
        if (ctaCaps.can_place_order) ctaActions.push(format === 'slack' ? '*place the order*' : 'place the order');
        if (ctaCaps.can_generate_proposal) ctaActions.push(format === 'slack' ? '*generate a PDF proposal*' : 'generate a PDF proposal');
        if (ctaActions.length > 0) {
          finalOutput += '\n\nWould you like to ' + ctaActions.join(' or ') + ', or make any changes?';
        } else {
          finalOutput += '\n\nWould you like to make any changes, or is there anything else I can help with?';
        }
      }
    }

    // Log complete session on successful outcome
    if (finalOutput.includes('BEV-') || finalOutput.includes('seaforth.getbevvi.com') ||
        finalOutput.includes('Download proposal') || finalOutput.includes('bevvi-proposal')) {
      try {
        const fs2 = require('fs');
        const convLog = {
          ts: new Date().toISOString(),
          session_id: sessionKey,
          email: email,
          channel: format,
          outcome: finalOutput.includes('BEV-') || finalOutput.includes('seaforth') ? 'order_placed' : 'proposal_generated',
          messages: (sessions[sessionKey] || []).map(function(m) {
            return {
              role: m.role,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            };
          }),
          final_response: finalOutput.slice(0, 500)
        };
        fs2.appendFileSync('/home/ubuntu/logs/conversations.jsonl', JSON.stringify(convLog) + '\n');
        console.log('[conv] logged', convLog.outcome, 'for', email);
      } catch(e) { console.error('[conv] log error:', e.message); }
    }

    return res.json({ text: finalOutput, response: finalOutput });

  } catch(e) {
    console.error('[rachel] error:', e.message, '\n', e.stack);
    return res.json({ text: 'Sorry, I hit a snag — try again in a second.', response: 'Sorry, I hit a snag — try again in a second.' });
  }
});

// ── POST /reset ────────────────────────────────────────────────────────────
app.post('/reset', (req, res) => {
  const { session_id, email } = req.body;
  if (session_id) resetState(session_id, email);
  res.json({ success: true });
});

// ── GET /health ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', port: PORT }));
// Operator correction (localhost only — the server binds 127.0.0.1): replace a session's basket with what was
// actually sent to the customer, and record that message in the conversation, so their next reply starts from
// it. Used when a person answered for Rachel (Sep 29: Sean's quote was sent by hand after Rachel's wrong list).
// Which earlier email session a NEW thread continues (email-agent.py asks before starting a fresh session).
// Localhost only, like session-basket. Decided in email-link.js; the decision and reason are logged.
app.post('/internal/email-link', (req, res) => {
  const { sender_email, subject, body } = req.body || {};
  if (!sender_email) return res.status(400).json({ session_id: null, reason: 'sender_email required' });
  const local = String(sender_email).toLowerCase().split('@')[0];
  const candidates = [];
  for (const [k, st] of Object.entries(flowState)) {
    if (!/^email-/.test(k) || !st) continue;
    // Sessions from before userEmail was recorded: the sender's local part is in the id (email-<thread>-<local>).
    const who = st.userEmail || (k.split('-').slice(2).join('-') === local ? String(sender_email).toLowerCase() : '');
    if (!who) continue;
    let n = 0; try { n = JSON.parse(st.lastLineItems || '[]').length; } catch (e) {}
    candidates.push({ session_id: k, sender_email: who, client: st.savedClientName || '', subject: st.emailSubject || '', last_active: st.lastActive || 0, has_quote: n > 0 });
  }
  const r = require('./email-link.js').pick({ sender_email, subject, body: require('./email-body.js').latest(body).text }, candidates);
  console.log('[email-link] ' + JSON.stringify(String(subject || '').slice(0, 60)) + ' from ' + sender_email + ' -> ' + (r.session_id || 'new session') + ' — ' + r.reason);
  res.json(r);
});

app.post('/internal/session-basket', async (req, res) => {
  const { session_id, sent_text, from_proposal } = req.body || {};
  let line_items = req.body && req.body.line_items, prop = null;
  // from_proposal: a proposal PDF's file name -> the line items it was generated from (generate-proposal.js).
  if (from_proposal) {
    try { prop = JSON.parse(fs.readFileSync(path.join('/home/ubuntu/logs/proposal-items', path.basename(String(from_proposal)) + '.json'), 'utf8')); line_items = prop.line_items; }
    catch (e) { return res.status(404).json({ ok: false, error: 'no saved line items for ' + from_proposal }); }
  }
  if (!session_id || !Array.isArray(line_items) || !line_items.length) return res.status(400).json({ ok: false, error: 'session_id and line_items (or from_proposal) required' });
  const st = getState(session_id);
  // Lines with no catalog link (a hand-built quote) are linked now, exact matches only, so the session can be
  // ORDERED on any channel (Sep 29: the Gen II basket loaded from its PDF had 0 of 19 orderable lines).
  const zipR = st.zip || (req.body && req.body.zip) || '';
  let resolveNote = '';
  if (zipR && line_items.some(LR.needsLink)) {
    const rr = await LR.resolveLines(line_items, (n, c) => catalogSearch(zipR, n, c));
    line_items = rr.items;
    resolveNote = rr.linked.length + ' line(s) linked to the catalog' + (rr.unresolved.length ? ', NOT linked: ' + rr.unresolved.map(u => u.name + ' (' + u.reason + ')').join('; ') : '');
  }
  if (prop) { st.lastProposalUrl = 'http://3.138.180.46/proposals/' + prop.pdf; if (prop.client_name) st.savedClientName = prop.client_name; if (prop.event_date) st.savedEventDate = prop.event_date; }
  st.lastLineItems = JSON.stringify(line_items); st.pendingSubstitutes = []; st.pendingAddOffer = null; st.pendingQtyFor = null; st.lastCta = null;
  if (!sessions[session_id]) sessions[session_id] = [];
  if (sent_text) sessions[session_id].push({ role: 'assistant', content: String(sent_text) });
  saveFlowState();
  console.log('[internal] session-basket: ' + session_id + ' basket replaced with ' + line_items.length + ' line(s)' + (prop ? ' from proposal ' + prop.pdf : '') + (sent_text ? ', sent message recorded' : '') + (resolveNote ? ' | ' + resolveNote : ''));
  res.json({ ok: true, lines: line_items.length, orderable: line_items.filter(li => !LR.needsLink(li)).length, resolve: resolveNote });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[rachel] Server running on http://127.0.0.1:${PORT}`);
  console.log(`[rachel] Health: http://127.0.0.1:${PORT}/health`);
  console.log(`[rachel] Chat:   http://127.0.0.1:${PORT}/chat`);
});
