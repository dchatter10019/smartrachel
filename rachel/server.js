
// ── Store coverage check via Orchestrator ──────────────────────────────
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://127.0.0.1:8200';

async function checkStoreCoverage(zip) {
  try {
    const fetchFn = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    const res = await fetchFn(`${ORCHESTRATOR_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'tools/call',
        params: { name: 'get_stores_for_zip', arguments: { zip } }
      })
    });
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data:'));
    if (!line) return null;
    const msg = JSON.parse(line.replace('data:', '').trim());
    return JSON.parse(msg.result.content[0].text);
  } catch (e) {
    console.error('[rachel] checkStoreCoverage error:', e.message);
    return null; // null = "couldn't verify" — treated as fail-open below
  }
}

const express = require('express');
const { rachelChat } = require('./rachel.js');
const { getCustomerContext, getD2CSession, saveD2CSession, saveBasket, getPackage } = require('./gbrain.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
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
    const fetchFn = (...args) => import('node-fetch').then(({default: f}) => f(...args));
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

const KITCHEN_TO_CLIENT = {
  'Celonis - NYC': 'fooda',
  'Teterboro - NJ': 'airculinaire',
  'San Diego - CA': 'airculinaire',
};

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.RACHEL_PORT || 3500;

// ── Session stores ─────────────────────────────────────────────────────────
const sessions = {};       // sessionKey -> messages[]
const packageCache = {};   // cacheKey -> line_items (L1)

// flowState persisted to disk
const FLOW_STATE_PATH = '/home/ubuntu/logs/flow-state.json';
let flowState = {};
try {
  flowState = JSON.parse(fs.readFileSync(FLOW_STATE_PATH, 'utf8'));
  console.log('[flowState] loaded', Object.keys(flowState).length, 'sessions');
} catch(e) { flowState = {}; }

function saveFlowState() {
  try { fs.writeFileSync(FLOW_STATE_PATH, JSON.stringify(flowState)); } catch(e) {}
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

// ── Flow state helpers ─────────────────────────────────────────────────────
function getState(sessionKey) {
  if (!flowState[sessionKey]) {
    flowState[sessionKey] = { step: 'age', ageVerified: false, addrConfirmed: false, zip: '', address: '', pendingIntent: null, lastFingerprint: '', lastZip: '', mixerAsked: false, mixerAnswered: false, packageShown: false, proposalStep: null };
  }
  return flowState[sessionKey];
}

function setState(sessionKey, updates) {
  const state = getState(sessionKey);
  Object.assign(state, updates);
  saveFlowState();
  return state;
}

function resetState(sessionKey, email) {
  flowState[sessionKey] = { step: 'age', ageVerified: false, addrConfirmed: false, zip: '', address: '', pendingIntent: null, lastFingerprint: '', lastZip: '', mixerAsked: false, mixerAnswered: false, packageShown: false, proposalStep: null, proposalData: null, orderStep: null, orderData: null };
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
async function callRachel({ sessionKey, message, context, format, gbrainContext, addressRule, email, onProposalGenerated, alreadyConfirmed }) {
  const messages = sessions[sessionKey] || [];
  const channelNote = getChannelNote(format);
  const stateForEmail = getState(sessionKey);
  const result = await rachelChat({
    messages: [...messages, { role: 'user', content: message }],
    context,
    rachelPrompt: RACHEL_PROMPT,
    gbrain_context: gbrainContext || '',
    address_rule: addressRule + channelNote,
    channel_format: format,
    onProposalGenerated: onProposalGenerated || null,
    customerMessage: message,
    alreadyConfirmed: alreadyConfirmed || false,
    sendEmailFn: sendEmail,
    lastProposalUrl: stateForEmail.lastProposalUrl || '',
    onPackageBuilt: (em, lineItems, fmt) => {
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
      const key = makeCacheKey(em || email, state.zip, state.lastFingerprint);
      packageCache[key] = lineItems;
      state.lastLineItems = lineItems;
      saveFlowState();
      console.log('[product-discussed] captured as active context (no prior basket):', key);
    }
  });
  sessions[sessionKey] = result.messages;
  return scrubDisabledOffers(formatResponse(result.response, format), format);
}

// ── POST /chat ─────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { message, context, gbrain_context, session_id, format = 'markdown', skip_gbrain = false } = req.body;

  if (!message) return res.status(400).json({ error: 'message required' });

  if (context && context.kitchen_location && KITCHEN_TO_CLIENT[context.kitchen_location]) {
    context.client_id = KITCHEN_TO_CLIENT[context.kitchen_location];
  }

  console.log(`[rachel] format: ${format} session: ${session_id}`);
  console.log(`[rachel] context:`, JSON.stringify({ kitchen_location: context?.kitchen_location, client_id: context?.client_id, user_email: context?.user_email }));

  const sessionKey = session_id || `${context?.account_id || 'anon'}-${context?.kitchen_location || 'noloc'}`;
  if (!sessions[sessionKey]) sessions[sessionKey] = [];

  const email = context?.user_email || '';
  const isD2C = !context?.kitchen_location;

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
        onPackageBuilt: (em, lineItems, fmt) => {
          packageCache[(em || email) + ':b2b'] = lineItems;
        }
      });
      sessions[sessionKey] = result.messages;
      return res.json({ text: formatResponse(result.response, format), response: formatResponse(result.response, format) });
    }

    // ── D2C flow — state machine ───────────────────────────────────────────
    const state = getState(sessionKey);
    const msgLower = message.toLowerCase().trim().replace(/\*/g, '').replace(/_/g, '');

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
            s.ageVerified = d2c.age_verified || false;
            s.zip = d2c.delivery_zip || '';
            s.address = d2c.delivery_address || '';
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
        s.step = s.address ? 'ready' : 'addr_new';
        if (s.ageVerified && capsGreet.requires_age_verification) {
          greet += '\u2713 Age verified.\n\n';
        }
        greet += 'How can I help you today?';
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
          state.ageVerified = state.ageVerified || d2c.age_verified || false;
          if (!state.zip) state.zip = d2c.delivery_zip || '';
          if (!state.address) state.address = d2c.delivery_address || '';
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
    if (state.step === 'age') {
      const capsAge = getCapabilities(format);
      if (!capsAge.requires_age_verification) {
        state.step = state.address ? 'ready' : 'addr_new';
      } else if (state.ageVerified) {
        state.step = state.address ? 'ready' : 'addr_new';
      } else if (yesWords.some(w => msgLower.includes(w))) {
        state.ageVerified = true;
        state.step = state.address ? 'ready' : 'addr_new';
        // Save to GBrain
        if (email) {
          try {
            const d2c = await getD2CSession(email) || {};
            await saveD2CSession(email, Object.assign({}, d2c, { age_verified: true, onboarded: true }));
          } catch(e) {}
        }
      } else if (noWords.some(w => msgLower === w || msgLower.startsWith(w + ' '))) {
        const bye = 'I\'m sorry, I can only assist customers who are 21 or older. Have a great day!';
        return res.json({ text: bye, response: bye });
      } else {
        const ask = 'Before we get started — are you 21 or older?';
        return res.json({ text: ask, response: ask });
      }
    }

    // ── STATE: addr_new ────────────────────────────────────────────────────
    if (state.step === 'addr_new') {
      const zipMatch = message.match(/\b(\d{5})\b/);
      if (zipMatch) {
        const candidateZip = zipMatch[1];
        const coverage = await checkStoreCoverage(candidateZip);
        if (coverage && coverage.store_count === 0) {
          const noStoreMsg = `Sorry, it looks like we don't currently have a store serving the ${candidateZip} zip code, so I'm unable to fulfill orders there yet. I'd recommend reaching out to our support team at bevvi-support@getbevvi.com — they can look into delivery options for your area. Would you like to try a different delivery address?`;
          return res.json({ text: noStoreMsg, response: noStoreMsg });
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
      } else {
        const ask = 'What is your delivery address? (Please include street, city, state, and zip code)';
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
          const replayIsEventPackage = reply.includes('Product total') || reply.includes('Estimated grand total') || reply.includes('grand total');
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
      } else if (noWords.some(w => msgLower === w || msgLower.startsWith(w + ' '))) {
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
          const replayIsEventPackage = reply.includes('Product total') || reply.includes('Estimated grand total') || reply.includes('grand total');
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

    // ── STATE: ready — pass to Rachel ──────────────────────────────────────
    if (state.step !== 'ready') {
      // Shouldn\'t happen but fallback
      const ask = 'What is your delivery address? (Include street, city, state, and zip)';
      state.step = 'addr_new';
      return res.json({ text: ask, response: ask });
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
    if ((orderTriggers.some(t => msgLower.includes(t)) || isDirectOrderRequest) && !state.orderStep && !state.proposalStep) {
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
        state.orderStep = 'name';
        saveFlowState();
        const ask = 'What is your full name? (first and last)';
        return res.json({ text: ask, response: ask });
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
        state.orderStep = 'name';
        saveFlowState();
        const ask = 'What is your full name? (first and last)';
        return res.json({ text: ask, response: ask });
      }
      state.orderStep = 'qty';
      saveFlowState();
      const ask = 'How many bottles would you like to order?';
      return res.json({ text: ask, response: ask });
    }

    if (state.orderStep === 'qty') {
      const qtyMatch = message.match(/\b(\d+)\b/);
      state.orderData.qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
      state.orderStep = 'name';
      saveFlowState();
      // Load basket to get product info
      if (email && !state.lastLineItems) {
        try {
          const { getPackage } = require('./gbrain.js');
          const basket = await getPackage(email, format || 'slack');
          if (basket) { state.lastLineItems = typeof basket === 'string' ? basket : JSON.stringify(basket); saveFlowState(); }
        } catch(e) {}
      }
      const ask = 'What is your full name? (first and last)';
      return res.json({ text: ask, response: ask });
    }

    if (state.orderStep === 'name') {
      state.orderData.name = message.trim();
      state.orderStep = 'phone';
      saveFlowState();
      const ask = 'What is your phone number?';
      return res.json({ text: ask, response: ask });
    }

    if (state.orderStep === 'phone') {
      state.orderData.phone = message.replace(/\D/g, '');
      state.orderStep = 'email_confirm';
      saveFlowState();
      const ask = format === 'slack'
        ? 'Your email on file is *' + email + '* — shall I use this for the order, or would you like to use a different one?'
        : 'Your email on file is ' + email + ' — shall I use this, or provide a different one?';
      return res.json({ text: ask, response: ask });
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

    if (state.orderStep === 'details') {
      const parsedResults = chrono.parse(message, new Date(), { forwardDate: true });
      if (!parsedResults.length || !parsedResults[0].start.isCertain('hour')) {
        const ask = 'Could you give me a specific delivery date and time? (e.g. \"tomorrow at 5pm\" or \"August 5th at 2pm\")';
        return res.json({ text: ask, response: ask });
      }
      const parsedDate = parsedResults[0].start.date();
      const requestedHour = parsedDate.getHours() + parsedDate.getMinutes() / 60;
      const dateStr = parsedDate.toISOString().slice(0, 10);

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
            const optionsText = avail.deliveryTimes.map(w => w.displayTime).join(', ');
            const ask = 'That time isn\'t available on ' + dateStr + '. Here are the available delivery windows: ' + optionsText + '. Which one works for you?';
            return res.json({ text: ask, response: ask });
          }
          finalDeliveryText = matchedWindow.deliveryTime;
        }
      }

      state.orderData.delivery_datetime = finalDeliveryText;
      state.orderStep = 'confirm';
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
      const tax = Math.round(productTotal * 0.10 * 100) / 100;
      const service = Math.round(productTotal * 0.10 * 100) / 100;
      const tip = Math.round(productTotal * 0.05 * 100) / 100;
      const delivery = 25.00;
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
          'Delivery to: ' + state.address + '\n' +
          'Delivery: ' + state.orderData.delivery_datetime + '\n\n' +
          'Product total: $' + productTotal.toFixed(2) + '\n' +
          'Estimated tax (10%): $' + tax.toFixed(2) + '\n' +
          'Service charge (10%): $' + service.toFixed(2) + '\n' +
          'Tip (5%): $' + tip.toFixed(2) + '\n' +
          'Delivery: $' + delivery.toFixed(2) + '\n' +
          '*Estimated grand total: $' + grandTotal.toFixed(2) + '*\n\n' +
          'Shall I go ahead and place this order?'
        : 'Order summary ready. Grand total: $' + grandTotal.toFixed(2) + '. Confirm?';
      return res.json({ text: summary, response: summary });
    }

    if (state.orderStep === 'confirm') {
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
        const customerObj = {
          firstName: firstName,
          lastName: lastName,
          email: od.email || email,
          phone: od.phone,
          address: state.address,
          city: state.address.split(',').length > 1 ? state.address.split(',')[1].trim() : '',
          state: 'NY',
          zipcode: state.zip
        };
        const placeMsg = JSON.stringify({
          _system: 'place_order',
          line_items: updatedLineItems || '[]',
          customer: customerObj,
          delivery_datetime: od.delivery_datetime,
          zip: state.zip
        });
        const fp2 = fingerprint(placeMsg);
        state.lastFingerprint = fp2;
        const gbrainCtx = email ? await getCustomerContext('', '', context?.client_id || 'airculinaire', email).catch(() => '') : '';
        context.saved_zip = state.zip;
        const addrRule2 = '\n\n## DELIVERY\nZip: ' + state.zip + '. Address: ' + state.address + '. Age and address verified.\n\n## ORDER INSTRUCTION\nThe user message contains a JSON system instruction. Parse it and immediately call ShoppingAgent with intent=place_order using the line_items, customer, delivery_datetime and zip from the JSON. Do not ask for any more information.';
        const orderOutput = await callRachel({ sessionKey, message: placeMsg, context, format, gbrainContext: gbrainCtx, addressRule: addrRule2, email, alreadyConfirmed: true });
        state.orderStep = null;
        state.orderData = null;
        saveFlowState();
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
        const reconfirm = 'Please confirm — shall I place the order for ' + od.productName + ' x' + od.qty + ' for $' + (od.grandTotal || 0).toFixed(2) + '? (yes/no)';
        return res.json({ text: reconfirm, response: reconfirm });
      }
    }

    // ── Order state machine ────────────────────────────────────────────────────
    // ── Proposal state machine ──────────────────────────────────────────────
    const proposalTriggers = ['generate a pdf', 'generate the pdf', 'generate proposal', 'generate a proposal',
      'generate the proposal', 'pdf proposal', 'create a proposal', 'create the proposal', 'make a proposal',
      'make the proposal', 'send a proposal', 'send the proposal', 'build a proposal', 'get me a proposal',
      'want a proposal', 'want the proposal'];
    if (proposalTriggers.some(t => msgLower.includes(t)) && !state.proposalStep) {
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
        state.proposalStep = 'client';
        state.proposalData = { qty: null };
        saveFlowState();
        const ask = 'What is the client or company name?';
        return res.json({ text: ask, response: ask });
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

    if (state.proposalStep === 'client') {
      // Strip any date that might be in the client name
      state.proposalData.client_name = message.split(',')[0].trim();
      state.proposalStep = 'date';
      saveFlowState();
      const ask = 'What is the event date?';
      return res.json({ text: ask, response: ask });
    }

    if (state.proposalStep === 'date') {
      state.proposalData.event_date = message.trim();
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
        const delivery = 25.00;
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
            'Delivery: $' + delivery.toFixed(2) + '\n' +
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
    if (state.mixerAsked && !state.mixerAnswered && state.packageShown) {
      const mixerNoWords = ['no', 'nope', 'no thanks', 'no worries', "that's all", 'thats all', "i'm good", 'im good', 'nothing else', 'none'];
      const mixerMsgLower = message.toLowerCase().trim().replace(/\*/g, '');
      if (mixerNoWords.some(w => mixerMsgLower === w || mixerMsgLower.startsWith(w + ' ') || mixerMsgLower.startsWith(w + ','))) {
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
      const priorMsgs = sessions[sessionKey] || [];
      const lastAssistantMsg = [...priorMsgs].reverse().find(m => m.role === 'assistant');
      const lastAssistantText = lastAssistantMsg ? (Array.isArray(lastAssistantMsg.content) ? lastAssistantMsg.content.map(c => c.text || '').join(' ') : String(lastAssistantMsg.content || '')) : '';
      const lastMentionedSubstitute = lastAssistantText.toLowerCase().includes('substitute');
      const subConfirmWords = ['yes', 'yeah', 'yep', 'sure', 'please', 'ok', 'okay'];
      const subMsgLower = message.toLowerCase().trim().replace(/\*/g, '');
      const isSubConfirm = lastMentionedSubstitute && (subMsgLower.includes('substitut') || subConfirmWords.some(w => subMsgLower === w || subMsgLower.startsWith(w + ' ') || subMsgLower.startsWith(w + ',')));
      if (isSubConfirm) {
        const itemToSubstitute = state.pendingSubstitutes[0];
        console.log('[substitute-deterministic] searching real replacement for:', itemToSubstitute);
        try {
          const subRes = await fetch('http://127.0.0.1:8300/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'product_query', arguments: { queries: [{ name: itemToSubstitute, limit: 3 }], zip: state.zip || '', email: email } } })
          });
          const subText = await subRes.text();
          const subLine = subText.split('\n').find(l => l.startsWith('data:'));
          const subData = subLine ? JSON.parse(subLine.replace('data:', '').trim()) : null;
          const subResult = subData ? JSON.parse(subData.result.content[0].text) : null;
          state.pendingSubstitutes = state.pendingSubstitutes.slice(1);
          saveFlowState();
          const foundProducts = subResult && subResult.results && subResult.results[0] && subResult.results[0].products;
          if (foundProducts && foundProducts.length > 0) {
            const p = foundProducts[0];
            const subReply = 'I found a substitute for ' + itemToSubstitute + ': ' + p.name + ' — ' + (p.size || '') + ' — $' + (p.price || p.salePrice || 0) + '. Would you like to add this instead?';
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
    if (state.pendingSubstitutes && state.pendingSubstitutes.length > 0) {
      // Real gap found tonight: options are sometimes offered several turns apart
      // (e.g. gin options in one turn, triple sec options several turns earlier),
      // and the customer can confirm both together later — scanning only the single
      // most recent assistant message misses anything presented earlier. Scan the
      // last several assistant turns instead, so an option is still matchable even
      // if it wasn't the very last thing said.
      const priorMsgsSel = sessions[sessionKey] || [];
      const recentAssistantMsgsSel = [...priorMsgsSel].reverse().filter(m => m.role === 'assistant').slice(0, 4);
      const recentAssistantTextSel = recentAssistantMsgsSel.map(m => Array.isArray(m.content) ? m.content.map(c => c.text || '').join(' ') : String(m.content || '')).join(String.fromCharCode(10));

      // Extract candidate options Rachel presented, across two formats:
      // 1) Line-based "Name — Size — $Price" (bullets/numbered lists)
      // 2) Free-flowing prose "Name at $Price" or "Name — $Price" inline mentions
      // (real bug found tonight: prose like "Bombay Gin — 750 mL — $27.49. ... or
      // stick with Plymouth at $37.39, Drumshanbo at $43.99" mixes both styles in
      // one paragraph — a pure line-split regex misses the inline mentions entirely).
      const candidateLines = recentAssistantTextSel.split(String.fromCharCode(10));
      const candidates = [];
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
        if (isBareAffirmative && recentAssistantMsgsSel.length > 0) {
          const singleMsgText = Array.isArray(recentAssistantMsgsSel[0].content) ? recentAssistantMsgsSel[0].content.map(c => c.text || '').join(' ') : String(recentAssistantMsgsSel[0].content || '');
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
              if (nameSingle && nameSingle.split(' ').length <= 8) {
                const sizeMatchSingle = beforeOnlyPrice.match(/\d+(\.\d+)?\s*(mL|ML|L|oz|OZ)\b/);
                matched = { name: nameSingle, price: parseFloat(onlyPriceMatch[1]), size: sizeMatchSingle ? sizeMatchSingle[0] : '' };
                console.log('[substitute-merge] Tier 0 (bare affirmative to single-candidate question) matched:', nameSingle);
              }
            }
          }
        }

        if (!matched && isShortMsg) {
          // Tier 1: short message — a single matching candidate is treated as a direct
          // restatement/confirmation, no extra phrase needed.
          const tier1Matches = candidates.filter(c => candidateWordMatch(c) !== null);
          if (tier1Matches.length === 1) matched = tier1Matches[0];
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
            const originalItemName = state.pendingSubstitutes[0];
            const originalBrandWord = originalItemName.split(' ')[0].toLowerCase();
            let items = [];
            try { items = JSON.parse(state.lastLineItems || '[]'); } catch (e) {}
            const removeIdx = items.findIndex(it => (it.name || it.label || '').toLowerCase().includes(originalBrandWord));
            let qtyToUse = 1;
            let categoryToUse = '';
            if (removeIdx >= 0) {
              qtyToUse = items[removeIdx].qty || items[removeIdx].quantity || 1;
              categoryToUse = items[removeIdx].category || '';
              items.splice(removeIdx, 1);
            }
            items.push({
              label: matched.name, name: matched.name, qty: qtyToUse, quantity: qtyToUse,
              price: matched.price, size: matched.size, url: '', product_id: '', upc: '',
              establishmentId: '', category: categoryToUse
            });
            const newLineItems = JSON.stringify(items);
            const key = makeCacheKey(email, state.zip, state.lastFingerprint);
            packageCache[key] = newLineItems;
            state.lastLineItems = newLineItems;
            state.pendingSubstitutes = state.pendingSubstitutes.slice(1);
            saveFlowState();
            try { saveBasket(email, newLineItems, '', format).catch(() => {}); } catch (e) {}
            console.log('[substitute-merge] replaced', JSON.stringify(originalItemName), 'with', JSON.stringify(matched.name), 'qty', qtyToUse);

            const stillPending = state.pendingSubstitutes.length > 0;
            const confirmReply = 'Got it — ' + qtyToUse + 'x ' + matched.name + (matched.size ? ' (' + matched.size + ')' : '') +
              ' at $' + matched.price.toFixed(2) + ' ea has replaced ' + originalItemName + ' in your order.' +
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

    // Call Rachel
    const output = await callRachel({ sessionKey, message, context, format, gbrainContext, addressRule: fullAddrRule, email });

    // ── Post-process: mixer/CTA using explicit state ─────────────────────
    const noKw = ['no', 'nope', 'no thanks', 'no worries', "that's all", 'thats all', "i'm good", 'im good', 'nothing else'];
    const hasProposal = output.toLowerCase().includes('your proposal') || output.includes('proposals/bevvi-proposal') || output.includes('download proposal');
    const isEventPackage = output.includes('Product total') || output.includes('Estimated grand total') || output.includes('grand total');
    const isSingleProduct = !isEventPackage && output.includes('$') && (output.match(/\d+ML/i) !== null || output.match(/\d+L\b/) !== null) && output.split('$').length <= 3;
    const packageJustShown = isEventPackage || output.includes('Estimated total') || output.includes('estimated total');
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[rachel] Server running on http://127.0.0.1:${PORT}`);
  console.log(`[rachel] Health: http://127.0.0.1:${PORT}/health`);
  console.log(`[rachel] Chat:   http://127.0.0.1:${PORT}/chat`);
});
