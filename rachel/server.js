const express = require('express');
const { rachelChat } = require('./rachel.js');
const { getCustomerContext, getD2CSession, saveD2CSession, saveBasket, getPackage } = require('./gbrain.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  flowState[sessionKey] = { step: 'age', ageVerified: false, addrConfirmed: false, zip: '', address: '', pendingIntent: null, lastFingerprint: '', lastZip: '' };
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

const channelNotes = {
  slack: `\n\n## OUTPUT FORMAT: SLACK\n- Use *bold* for product names and totals\n- Use line breaks between sections\n- No HTML tags\n- Keep responses concise\n- For payment links use: <url|Complete your payment here>\n- NEVER mention AddToCart or cart operations`,
  voiceflow: `\n\n## OUTPUT FORMAT: VOICEFLOW\n- Use <b>bold</b> for emphasis\n- Use <br> for line breaks`,
  plain: `\n\n## OUTPUT FORMAT: PLAIN TEXT\n- No formatting whatsoever`
};

// ── Rachel chat wrapper ────────────────────────────────────────────────────
async function callRachel({ sessionKey, message, context, format, gbrainContext, addressRule, email }) {
  const messages = sessions[sessionKey] || [];
  const channelNote = channelNotes[format] || channelNotes.plain;
  const result = await rachelChat({
    messages: [...messages, { role: 'user', content: message }],
    context,
    rachelPrompt: RACHEL_PROMPT,
    gbrain_context: gbrainContext || '',
    address_rule: addressRule + channelNote,
    channel_format: format,
    onPackageBuilt: (em, lineItems, fmt) => {
      const state = getState(sessionKey);
      const key = makeCacheKey(em || email, state.zip, state.lastFingerprint);
      packageCache[key] = lineItems;
      state.lastLineItems = lineItems;
      saveFlowState();
      console.log('[package] L1 cached:', key);
      try { saveBasket(em || email, lineItems, '', fmt || format).catch(() => {}); } catch(e) {}
    }
  });
  sessions[sessionKey] = result.messages;
  return formatResponse(result.response, format);
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
    const msgLower = message.toLowerCase().trim();
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

      if (s.ageVerified) {
        s.step = s.address ? 'ready' : 'addr_new';
        greet += '\u2713 Age verified.\n\nHow can I help you today?';
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

    // ── STATE: age ─────────────────────────────────────────────────────────
    if (state.step === 'age') {
      if (state.ageVerified) {
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
        state.zip = zipMatch[1];
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
          const reply = await callRachel({ sessionKey, message: pending, context, format, gbrainContext, addressRule: addrRule, email });
          const prefix = `Got it! Delivering to ${state.address}.\n\n`;
          return res.json({ text: prefix + reply, response: prefix + reply });
        }
        const ok = `Got it! Delivering to ${state.address}. How can I help you today?`;
        return res.json({ text: ok, response: ok });
      } else if (noWords.some(w => msgLower === w)) {
        state.step = 'addr_new';
        state.pendingIntent = null;
        const ask = 'No problem! What is your delivery address? (Include street, city, state, and zip)';
        return res.json({ text: ask, response: ask });
      } else {
        // Store intent and ask for address confirmation
        state.pendingIntent = message;
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

    // ── Proposal state machine ──────────────────────────────────────────────
    const proposalTriggers = ['generate a pdf', 'generate proposal', 'pdf proposal', 'create a proposal', 'make a proposal', 'send a proposal'];
    if (proposalTriggers.some(t => msgLower.includes(t)) && !state.proposalStep) {
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
      const proposalMsg = `Generate a PDF proposal for client "${pd.client_name}" event date "${pd.event_date}" quantity ${pd.qty} bottles using the last product search results. Pass line_items with qty updated to ${pd.qty}.`;
      const fp2 = fingerprint(proposalMsg);
      state.lastFingerprint = fp2;
      const gbrainContext2 = email ? await getCustomerContext('', '', context?.client_id || 'airculinaire', email).catch(() => '') : '';
      context.saved_zip = state.zip;
      const addrRule2 = '\n\n## DELIVERY\nZip: ' + state.zip + '. Address: ' + state.address + '. Never ask about address or age.';
      const proposalOutput = await callRachel({ sessionKey, message: proposalMsg, context, format, gbrainContext: gbrainContext2, addressRule: addrRule2, email });
      state.proposalStep = null;
      state.proposalData = null;
      state.packageShown = false;
      state.mixerAsked = false;
      state.mixerAnswered = false;
      saveFlowState();

      // Extract download URL from Rachel's response
      const urlMatch = proposalOutput.match(/http[^\s)|>]+\.pdf/) || proposalOutput.match(/<(http[^|>]+\.pdf)/);
      const downloadUrl = urlMatch ? urlMatch[0] : '';

      // Build deterministic summary with full fee breakdown
      console.log('[proposal-debug] lastLineItems:', JSON.stringify(state.lastLineItems || 'null').slice(0,100), 'pd:', JSON.stringify(pd));
      const qty = pd.qty || 1;
      let productName = 'Products';
      let unitPrice = 0;
      // Use lastLineItems from state if available
      if (state.lastLineItems) {
        try {
          const items = typeof state.lastLineItems === 'string' ? JSON.parse(state.lastLineItems) : state.lastLineItems;
          if (items && items.length > 0) {
            productName = items[0].name || items[0].label || 'Products';
            unitPrice = parseFloat(items[0].price || items[0].unit_price || 0);
          }
        } catch(e) {}
      }
      const productTotal = Math.round(unitPrice * qty * 100) / 100;
      const tax = Math.round(productTotal * 0.10 * 100) / 100;
      const service = Math.round(productTotal * 0.10 * 100) / 100;
      const tip = Math.round(productTotal * 0.05 * 100) / 100;
      const delivery = 25.00;
      const grandTotal = Math.round((productTotal + tax + service + tip + delivery) * 100) / 100;

      const summary = format === 'slack'
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
          '\n\nWould you like to *place the order* or make any changes?'
        : proposalOutput;

      return res.json({ text: summary, response: summary });
    }

    // Cache invalidation check
    const fp = fingerprint(message);
    if (fp !== state.lastFingerprint || state.zip !== state.lastZip) {
      if (state.lastFingerprint && state.lastZip) {
        // Request changed — clear cache and lastLineItems
        clearCache(email, format);
        state.lastLineItems = null;
        console.log('[cache] invalidated: new request or zip changed');
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
    const packageJustShown = isEventPackage || output.includes('Estimated total') || output.includes('estimated total');
    const hasCTA = output.includes('place the order') || output.includes('PDF proposal') || output.includes('make any changes');

    // Update state based on output
    if (packageJustShown) state.packageShown = true;
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

    if (!hasCTA && !hasProposal && state.packageShown) {
      if (isEventPackage && !state.mixerAsked) {
        // Event package — ask about mixers first
        finalOutput += format === 'slack'
          ? '\n\nWould you also like to add mixers, water, soda, ice, or cups?'
          : '\n\nWould you also like to add mixers, water, soda, ice, or cups?';
        state.mixerAsked = true;
        saveFlowState();
      } else if (!isEventPackage || state.mixerAnswered || state.mixerAsked) {
        // Single product or mixer already handled — show CTA
        finalOutput += format === 'slack'
          ? '\n\nWould you like to *place the order*, *generate a PDF proposal*, or make any changes?'
          : '\n\nWould you like to place the order, generate a PDF proposal, or make any changes?';
      }
    }

    return res.json({ text: finalOutput, response: finalOutput });

  } catch(e) {
    console.error('[rachel] error:', e.message);
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
