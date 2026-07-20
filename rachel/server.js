const express = require('express');

// ── Kitchen location to client name mapping ────────────────────────────────
const KITCHEN_TO_CLIENT = {
  'Celonis - NYC': 'fooda',
  'Teterboro - NJ': 'airculinaire',
  'San Diego - CA': 'airculinaire',
  // Add more as needed
};
function getClientForKitchen(kitchen_location, default_client) {
  return KITCHEN_TO_CLIENT[kitchen_location] || default_client || 'airculinaire';
}

const { rachelChat } = require('./rachel.js');
const { getCustomerContext, getD2CSession, saveD2CSession } = require('./gbrain.js');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.RACHEL_PORT || 3500;
const sessions = {};
const packageCache = {}; // L1 cache for active packages

const RACHEL_PROMPT_PATH = path.join(__dirname, 'prompt.md');
let RACHEL_PROMPT = '';
try {
  RACHEL_PROMPT = fs.readFileSync(RACHEL_PROMPT_PATH, 'utf8');
  console.log(`[rachel] Loaded prompt (${RACHEL_PROMPT.length} chars)`);
} catch (e) {
  console.error('[rachel] WARNING: prompt.md not found');
}


function formatResponse(text, format) {
  // Claude now outputs in the correct format natively via channel notes.
  // This function is a lightweight safety net only.
  if (format === 'html') {
    return text
      // Catch any remaining markdown that Claude missed
      .replace(/^#{1,3} (.+)$/gm, '<b>$1</b>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/\n\[View\]\(([^)]+)\)/g, ' | <a href="$1" target="_blank">View</a>')
      .replace(/\[ \] /g, '')           // Remove checkboxes
      .replace(/^---+$/gm, '<hr>')         // Convert --- to hr
      .replace(/ \*$/gm, '')              // Remove trailing *
      .replace(/ \* /g, ' ')             // Remove inline *
      .replace(/[⭐➕★]/g, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/\n/g, '<br>')
      .replace(/<ul><br>/g, '<ul>')
      .replace(/<br><\/ul>/g, '</ul>')
      .replace(/<br><li>/g, '<li>')
      .replace(/<\/li><br>/g, '</li>');
  }
  if (format === 'slack') {
    return text
      .replace(/\*\*(.+?)\*\*/g, '*$1*')           // **bold** → *bold*
      .replace(/<b>(.*?)<\/b>/g, '*$1*')             // <b>text</b> → *text*
      .replace(/ \| \[View\]\([^)]+\)/g, '')        // remove | [View](url)
      .replace(/\[View\]\([^)]+\)/g, '')             // remove [View](url)
      .replace(/ \| <a href[^>]+>View<\/a>/g, '')    // remove | <a>View</a>
      .replace(/<a href[^>]+>([^<]+)<\/a>/g, '$1')   // strip other links
      .replace(/<[^>]+>/g, '')                        // strip remaining HTML
      .replace(/&nbsp;/g, ' ')                        // decode &nbsp;
      .replace(/\[([^\]]+)\]\((http[^)]+proposals[^)]+)\)/g, '<$2|$1>')  // convert proposal links to Slack format
      .replace(/[Tt]o add everything to your cart[^.\n]*[.\n]?/g, '')  // remove cart suggestion
      .replace(/just say ["']add all to cart["'][^.\n]*[.\n]?/gi, '')  // remove cart instruction
      .replace(/["']add all to cart["']/gi, '');          // remove cart phrase
  }
  if (format === 'webchat') {
    // Strip all links
    return text
      .replace(/\[View\]\([^)]+\)/g, '')
      .replace(/ \| \[View\]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/<a href[^>]+>([^<]+)<\/a>/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\n/g, '<br>');
  }
  if (format === 'plain') {
    return text
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  }
  if (format === 'webchat') {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,3} (.+)$/gm, '<b>$1</b>')
      .replace(/\[View\]\([^)]+\)/g, '')
      .replace(/ \| \[View\]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/^---+$/gm, '<hr>')
      .replace(/^[-•] \[ \] /gm, '')
      .replace(/^[-•] /gm, '')
      .replace(/[⭐➕★]/g, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/\n/g, '<br>');
  }
  return text; // markdown default
}

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    console.error('[rachel] JSON parse error:', err.message);
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  next(err);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', prompt_loaded: RACHEL_PROMPT.length > 0, prompt_chars: RACHEL_PROMPT.length, version: '1.0.0', sessions: Object.keys(sessions).length });
});

app.get('/sessions', (req, res) => {
  res.json({ keys: Object.keys(sessions) });
});

app.post('/chat', async (req, res) => {
  const { message, context, gbrain_context, session_id, format = 'markdown', skip_gbrain = false, suggested_products = [] } = req.body;
    console.log('[rachel] format:', format, 'session:', session_id);
    // Override client_id based on kitchen_location
    if (context?.kitchen_location && KITCHEN_TO_CLIENT[context.kitchen_location]) {
      context.client_id = KITCHEN_TO_CLIENT[context.kitchen_location];
    }
    console.log('[rachel] context:', JSON.stringify({kitchen_location: context?.kitchen_location, client_id: context?.client_id, account_id: context?.account_id, user_email: context?.user_email}));

  if (!message) return res.status(400).json({ error: 'message required' });
  // Rule 3: client_id optional — handled via URL stripping if empty

  const sessionKey = session_id || `${context.account_id || 'anon'}-${context.kitchen_location}`;
  if (!sessions[sessionKey]) sessions[sessionKey] = [];
  const messages = sessions[sessionKey];

  console.log(`[rachel] chat — session: ${sessionKey} messages: ${messages.length} — "${message}"`);

  try {

    // ── Pre-flight: load D2C session zip if no kitchen_location ────────────
    if (!context.kitchen_location && context.user_email) {
      try {
        const { getD2CSession } = require('./gbrain.js');
        const d2cSession = await getD2CSession(context.user_email);
        if (d2cSession && d2cSession.delivery_zip) {
          context.saved_zip = d2cSession.delivery_zip;
          context.age_verified = d2cSession.age_verified || false;
          context.saved_address = d2cSession.delivery_address;
          console.log('[rachel] D2C session found — saved zip:', d2cSession.delivery_zip);
          // Load saved package
          try {
// L1 cache first, L2 GBrain fallback
            const cacheKey = context.user_email + ':' + (format || 'slack');
            if (packageCache[cacheKey]) {
              context.saved_package = packageCache[cacheKey];
              console.log('[package] loaded from L1 cache');
            } else {
              try {
                const { getPackage } = require('./gbrain.js');
                const savedPkg = await getPackage(context.user_email, format || 'slack');
                if (savedPkg) {
                  context.saved_package = savedPkg;
                  packageCache[cacheKey] = savedPkg; // warm L1
                  console.log('[package] loaded from GBrain L2');
                }
              } catch(e) {}
            }
          } catch(e) {}
        }
      } catch(e) {}
    }
    // Query GBrain — skip if proactive agent already provided context or if D2C channel first message
    let gbrainContext = '';
    const isD2C = format === 'slack' || format === 'webchat' || format === 'plain';
    // Rule 2: No email — ask for it on first message
    if (!context.user_email && messages.length === 0) {
      const msg = 'Before I can help, could I get your email address?';
      return res.json({ text: msg, response: msg });
    }

    const isFirstMessage = messages.length === 0;
    if (skip_gbrain && gbrain_context) {
      gbrainContext = gbrain_context;
      console.log('[gbrain] skipped — using pre-built context (' + gbrainContext.length + ' chars)');
    } else if (!context.user_email) {
      console.log('[gbrain] skipped — no user email');
    } else {
      gbrainContext = await getCustomerContext(
        context.account_id || context.client_id,
        context.kitchen_location,
        context.client_id,
        context.user_email
      );
      if (gbrainContext) console.log('[gbrain] context loaded:', gbrainContext.length, 'chars');
    }

    // Build address verification rule
    // Slack hard rule: no cart operations
    if (format === 'slack') {
      const slackRule = '\n\nSLACK RULE: Never mention "add to cart", "cart", or "AddToCart". For orders use CreateOrder only. Never suggest cart operations on this channel.';
      // Append to system prompt via addressRule
    }
    let addressRule = '';
    // Add post-package CTA rule
    addressRule += '\n\n## AFTER PACKAGE PRESENTATION\nWhen customer says no/yes to the mixers question: respond with ONLY the CTA — do NOT ask what they want to change, do NOT list options, do NOT say anything else. Just say: "Would you like to *place the order*, *generate a PDF proposal*, or make any changes?"';

    // Add age verification status
    if (context.age_verified) {
      addressRule += '\n\n## AGE VERIFICATION\nCustomer age is verified (21+). Never ask for age again. Do not add any age verification message yourself — it is handled automatically.';
    }
    // Inject saved package for brand swap reference
    if (context.saved_package) {
      addressRule += '\n\n## ACTIVE PACKAGE\nThe customer has an active package. line_items: ' + context.saved_package + '\nFor brand swaps: use these line_items, keep quantities unchanged, swap only the requested item. Call ShoppingAgent intent=custom_list with updated named_products keeping same qty.';
    }
    if (!context.kitchen_location) {
      if (context.saved_address) {
        addressRule += '\n\n## DELIVERY ADDRESS — MANDATORY CONFIRMATION\nCustomer has a saved delivery address: "' + context.saved_address + '" (zip: ' + context.saved_zip + ').\nYou MUST ask this BEFORE calling ShoppingAgent for ANY reason (search, recommendation, package build, proposal): "I have your delivery address on file as ' + context.saved_address + ' — shall I use this for your order?"\nDO NOT call ShoppingAgent until customer confirms. This applies to ALL intents including recommendations and product searches.\nIf customer says no, ask for new address then call GetZipCode + SaveD2CSession.';
      } else {
        addressRule = '\n\n## MANDATORY ADDRESS COLLECTION\nNo delivery address on file. You MUST ask for the customer delivery address BEFORE doing any product search. Do NOT search until you have an address and zip code.';
      }
    }

    const result = await rachelChat({
      onPackageBuilt: (email, lineItems, fmt) => {
        const key = (email || '') + ':' + (fmt || 'slack');

        // Detect swaps by comparing old vs new package
        if (packageCache[key] && email) {
          try {
            const oldItems = JSON.parse(packageCache[key]);
            const newItems = JSON.parse(lineItems);
            // Only detect swaps if same number of items (pure swap, not rebuild)
            if (oldItems.length === newItems.length) {
              for (let i = 0; i < oldItems.length; i++) {
                const o = oldItems[i];
                const n = newItems[i];
                if (o.name !== n.name && o.qty === n.qty) {
                  const signal = {
                    ts: new Date().toISOString(), email,
                    category: o.category || "",
                    from_product: o.name, from_price: o.price,
                    to_product: n.name, to_price: n.price,
                    price_direction: n.price > o.price ? "up" : n.price < o.price ? "down" : "same"
                  };
                  console.log("[swap-signal]", JSON.stringify(signal));
                  require("fs").appendFileSync("/home/ubuntu/logs/swap-signals.jsonl", JSON.stringify(signal) + "\n");
                }
              }
            }
          } catch(e) { console.error("[swap-signal] error:", e.message); }
        }

        packageCache[key] = lineItems;
        console.log('[package] saved to L1 cache:', key);
      },
      messages: [...messages, { role: 'user', content: message }],
      context,
      rachelPrompt: RACHEL_PROMPT,
      gbrain_context: gbrainContext || gbrain_context || '',
      address_rule: addressRule,
      channel_format: format
    });

    sessions[sessionKey] = result.messages;

    let output = formatResponse(result.response, format);
    // Prepend age verified badge on first message of session
    if (context.age_verified && isFirstMessage) {
      output = '✓ Age verified. You are over 21\n\n' + output;
    }

    // Append CTA after mixer response if not already present
    const lastMsg = message.toLowerCase().trim();
    const yesKeywords = ['yes', 'yeah', 'sure', 'yep', 'please', 'ok', 'okay'];
    const noKeywords = ['no', 'nope', 'no thanks', 'no worries', "that's all", 'thats all', "i'm good", 'im good', 'nothing else'];
    const mixerKeywords = [...yesKeywords, ...noKeywords];
    const hasProposal = output.includes('proposals/bevvi-proposal') || output.includes('proposal is ready') || output.includes('Download') || output.toLowerCase().includes('your proposal');
    const hasCTA = output.includes('place the order') || output.includes('PDF proposal') || output.includes('generate a proposal');
    
    // If customer said yes to mixers but Rachel didn't add them, append a note
    const prevMsgAskedMixers = messages.length >= 1 && messages[messages.length-1] && 
      JSON.stringify(messages[messages.length-1]).includes('mixers');
    if (yesKeywords.includes(lastMsg) && prevMsgAskedMixers && !output.includes('water') && !output.includes('ice') && !output.includes('soda')) {
      output = output + (format === 'slack' 
        ? '\n\nFor mixers I can add: still water, sparkling water, soda (Coke/Sprite/Tonic), ice bags, and plastic cups. Which would you like?'
        : '\n\nFor mixers I can add: still water, sparkling water, soda, ice bags, and cups. Which would you like?');
    }
    
    if (!hasCTA && mixerKeywords.includes(lastMsg) && messages.length >= 2) {
      const cta = format === 'slack'
        ? '\n\nWould you like to *place the order*, *generate a PDF proposal*, or make any changes?'
        : '\n\nWould you like to place the order, generate a PDF proposal, or make any changes?';
      output = output + cta;
    }
    // After proposal generated, add simplified CTA
    if (hasProposal) {
      // Remove any "generate a PDF proposal" CTA that was appended
      output = output.replace(/\n\nWould you like to \*place the order\*, \*generate a PDF proposal\*, or make any changes\?/g, '');
      output = output.replace(/\n\nWould you like to place the order, generate a PDF proposal, or make any changes\?/g, '');
      if (!output.includes('place the order')) {
        const cta = format === 'slack'
          ? '\n\nReady to *place the order*, or would you like to make any changes first?'
          : '\n\nReady to place the order, or would you like to make any changes first?';
        output = output + cta;
      }
    }
    // Rule 3: No client_id → strip all product URLs
    if (!context?.client_id) {
      output = output
        .replace(/ \| <a href[^>]+>View<\/a>/g, '')
        .replace(/<a href[^>]+>View<\/a>/g, '')
        .replace(/ \| \[View\]\([^)]+\)/g, '')
        .replace(/\[View\]\([^)]+\)/g, '');
    }
    // Rule 4: No account_id → AddToCart already removed from tools (no URL stripping needed)

    res.json({
      text: output,
      response: output,
      session_id: sessionKey
    });
  } catch (err) {
    console.error('[rachel] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/session/clear', (req, res) => {
  const { session_id } = req.body;
  if (session_id && sessions[session_id]) {
    delete sessions[session_id];
    res.json({ cleared: true, session_id });
  } else {
    res.json({ cleared: false });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[rachel] Server running on http://127.0.0.1:${PORT}`);
  console.log(`[rachel] Health: http://127.0.0.1:${PORT}/health`);
  console.log(`[rachel] Chat:   http://127.0.0.1:${PORT}/chat`);
});
