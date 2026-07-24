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
const flowState = {};      // sessionKey -> { step, ageVerified, addrConfirmed, zip, address, pendingIntent }
const packageCache = {};   // cacheKey -> line_items (L1)

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
    flowState[sessionKey] = { step: 'age', ageVerified: false, addrConfirmed: false, zip: '', address: '', pendingIntent: null, lastFingerprint: '', lastZip: '' };
  }
  return flowState[sessionKey];
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
      console.log('[package] L1 cached:', key);
      // Save to L2
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

    // Cache invalidation check
    const fp = fingerprint(message);
    if (fp !== state.lastFingerprint || state.zip !== state.lastZip) {
      if (state.lastFingerprint && state.lastZip) {
        // Request changed — clear cache
        clearCache(email, format);
        console.log(`[cache] invalidated: fp changed ${state.lastFingerprint} -> ${fp} or zip ${state.lastZip} -> ${state.zip}`);
      }
      state.lastFingerprint = fp;
      state.lastZip = state.zip;
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

    // Post-process: append mixer question or CTA
    const lastMsg = msgLower;
    const yesKw = ['yes', 'yeah', 'sure', 'yep', 'please', 'ok', 'okay'];
    const noKw = ['no', 'nope', 'no thanks', 'no worries', "that\'s all", 'thats all', "i\'m good", 'im good', 'nothing else'];
    const hasCTA = output.includes('place the order') || output.includes('PDF proposal') || output.includes('generate a proposal') || output.includes('make any changes');
    const hasProposal = output.toLowerCase().includes('your proposal') || output.includes('proposals/bevvi-proposal') || output.includes('Download');
    const isEventPackage = output.includes('Product total') || output.includes('Estimated grand total') || output.includes('grand total');
    const isSingleProduct = (output.includes('$') && !isEventPackage);
    const packageWasShown = isEventPackage || (isSingleProduct && (output.includes('Estimated total') || output.includes('estimated total')));

    const prevMsgs = JSON.stringify(sessions[sessionKey].slice(-6));
    const mixerWasAsked = prevMsgs.includes('mixer') || prevMsgs.includes('water') || prevMsgs.includes('soda');
    const mixerAnswered = mixerWasAsked && sessions[sessionKey].some((m, idx) => {
      if (m.role !== 'user') return false;
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (!noKw.some(w => c.toLowerCase().includes(w))) return false;
      for (let i = idx - 1; i >= 0; i--) {
        if (sessions[sessionKey][i].role === 'assistant') {
          const ac = typeof sessions[sessionKey][i].content === 'string' ? sessions[sessionKey][i].content : JSON.stringify(sessions[sessionKey][i].content);
          if (ac.includes('mixer')) return true;
          break;
        }
      }
      return false;
    });

    let finalOutput = output;

    if (!hasCTA && !hasProposal && packageWasShown && !mixerAnswered) {
      if (isEventPackage && !mixerWasAsked) {
        finalOutput += format === 'slack'
          ? '\n\nWould you also like to add mixers, water, soda, ice, or cups?'
          : '\n\nWould you also like to add mixers, water, soda, ice, or cups?';
      } else {
        finalOutput += format === 'slack'
          ? '\n\nWould you like to *place the order*, *generate a PDF proposal*, or make any changes?'
          : '\n\nWould you like to place the order, generate a PDF proposal, or make any changes?';
      }
    } else if (!hasCTA && !hasProposal && mixerAnswered) {
      finalOutput += format === 'slack'
        ? '\n\nWould you like to *place the order*, *generate a PDF proposal*, or make any changes?'
        : '\n\nWould you like to place the order, generate a PDF proposal, or make any changes?';
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
