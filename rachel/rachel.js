/**
 * Rachel Service — Bevvi AI Beverage Specialist
 * Express API wrapping Claude Sonnet with tool use
 */

const Anthropic = require('@anthropic-ai/sdk');
const { addToCart } = require('./functions.js');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const client = new Anthropic.Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────

const ALL_TOOLS = [
  {
    name: "AddToCart",
    description: "Add a product to the customer's Voiceflow cart. Only use when account_id is set (B2B Voiceflow sessions). Use product_id from ShoppingAgent results.",
    input_schema: {
      type: "object",
      properties: {
        accountId: { type: "string", description: "Voiceflow account ID" },
        client:    { type: "string", description: "Client name e.g. airculinaire" },
        location:  { type: "string", description: "Kitchen location e.g. San Diego - CA" },
        quantity:  { type: "number", description: "Quantity to add" },
        product_id:{ type: "string", description: "Product ID from ShoppingAgent" }
      },
      required: ["accountId", "client", "location", "quantity", "product_id"]
    }
  },
  {
    name: "SendEmail",
    description: "Send an email. Use when the customer asks to email a proposal, package, or any other information to one or more recipients. If a proposal was just generated, include its download link in the body — use {last_proposal_url} in the body text and it will be substituted automatically. ONLY claim the email was sent after this tool returns success=true; if it returns success=false, tell the customer the email failed and share the link directly instead.",
    input_schema: {
      type: "object",
      properties: {
        to:      { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        subject: { type: "string", description: "Email subject line" },
        body:    { type: "string", description: "Plain text email body. Use {last_proposal_url} as a placeholder for the most recently generated proposal's download link if relevant." }
      },
      required: ["to", "subject", "body"]
    }
  },
  {
    name: "ShoppingAgent",
    description: "THE single interface for ALL product and order operations. Use for: product search (do you have X), menu building (event packages), custom lists (named products with qty), recommendations (suggest something), placing orders, and generating proposals. Pass intent + customer context. Never use BuildPackage or CreateOrder directly.\n\nintents:\nintent=\"product_query\" → search for specific products (do you have X, show me X)\nintent=\"recommendation\" → use when customer asks for suggestions (show me some nice tequila, recommend a wine) — uses purchase history\nintent=\"menu_build\" → build standard event package when customer says generic categories\nintent=\"custom_list\" → USE THIS when customer names specific products OR specific spirits (bourbon not just spirits)\nintent=\"place_order\" → place order after customer confirms\nintent=\"order_history\" → use when customer asks what they bought before, their past orders, order history, or wants to reorder something from a previous order. Returns itemized past orders with dates, products, and totals.\nintent=\"confirm_substitute\" → MANDATORY whenever the customer confirms a substitute for a previously-flagged unavailable item, IN ANY PHRASING WHATSOEVER (a bare yes, restating the product name, looks good, sounds good, that works, anything at all indicating they want that specific option). Call this IMMEDIATELY in the SAME turn, alongside or instead of narrating the change in text — never just describe the substitution without also calling this tool. Pass original_item (the exact unavailable item being replaced), replacement_name, replacement_price, and replacement_size if known.\nintent=\"generate_proposal\" → generate PDF proposal — call when customer asks for a proposal/PDF/quote. If the customer states the order is tax-exempt (e.g. \"no tax on alcohol in this state\", \"set tax to 0\", \"no sales tax\") pass tax_exempt=true on the ShoppingAgent call — this actually zeroes the tax on the generated PDF. Do NOT just say $0 tax in your reply without also passing tax_exempt=true; the PDF is built by a separate template and won't reflect a change you only mention in text.",
    input_schema: {
      type: "object",
      properties: {
        intent:    { type: "string", enum: ["product_query","menu_build","custom_list","recommendation","place_order","generate_proposal","order_history","confirm_substitute"] },
        zip:       { type: "string", description: "Delivery zip code" },
        email:     { type: "string", description: "Customer email" },
        queries:   { type: "array",  description: "For product_query: [{name, category, limit}]" },
        guests:    { type: "number", description: "For menu_build/custom_list" },
        hours:     { type: "number", description: "For menu_build/custom_list — event duration in hours. Use this OR drinks_per_person, not both; if the customer gives drinks-per-person directly, omit hours entirely." },
        drinks_per_person: { type: "number", description: "For menu_build/custom_list — alternative to hours: use when the customer specifies how many drinks each person will have directly (e.g. 'each person will have about 2 drinks') instead of the event duration. Takes priority over hours if both are somehow present." },
        category_splits: { type: "string", description: "For menu_build ONLY, use when the customer gives explicit percentages for each category (e.g. 'wine 20%, beer 30%, hard seltzer 50%'). JSON string, keys must be among wine/beer/hard_seltzer/spirits, values are decimals that should sum to 1.0 (e.g. '{\"wine\":0.2,\"beer\":0.3,\"hard_seltzer\":0.5}'). Setting this switches menu_build into a fundamentally different allocation mode driven entirely by these percentages instead of the usual fixed category logic — do NOT set this unless the customer actually stated explicit percentages themselves." },
        category_brands: { type: "string", description: "Use alongside category_splits when the customer restricts a category to specific named brands/varietals (e.g. 'red wine should be Cabernet or Pinot Noir', 'beer brands are Michelob Ultra, Bud Light, Miller Lite'). JSON string with keys red/white/beer/seltzer/spirits, each an array of allowed name keywords (e.g. '{\"red\":[\"cabernet\",\"pinot noir\"],\"beer\":[\"michelob ultra\",\"bud light\",\"miller lite\"]}'). Omit a category's key entirely to allow any product in that category." },
        wine_price_target: { type: "number", description: "Use alongside category_splits when the customer states a target/around price per wine bottle (e.g. 'wine budget is around $10 per bottle')." },
        seltzer_max_price: { type: "number", description: "Use alongside category_splits when the customer states a max price per case for hard seltzer specifically." },
        beer_pack_size: { type: "number", description: "Use when the customer specifies the case/pack size directly (e.g. 'case is 24 x 12 Oz' means beer_pack_size=24). Applies to both beer and hard seltzer case-size calculations." },
        beer_max_price: { type: "number", description: "Use when the customer states a max price per case for beer (also applies as the default seltzer cap if seltzer_max_price isn't separately given)." },
        budget:    { type: "number", description: "Total budget" },
        categories:{ type: "array",  description: "For menu_build: [beer, wine, spirits]" },
        named_products: { type: "array", description: "For custom_list: [{name, category, qty}]" },
        occasion:  { type: "string", description: "For recommendation" },
        category:  { type: "string", description: "For recommendation" },
        budget_per_bottle: { type: "number", description: "For recommendation" },
        line_items:{ type: "string", description: "For place_order: JSON string from previous result" },
        customer:  { type: "object", description: "For place_order: {firstName, lastName, email, address, city, state, zipcode, phone}" },
        tip_amount:{ type: "number", description: "For place_order" },
        delivery_datetime: { type: "string", description: "For place_order: ISO datetime" },
        delivery_instructions: { type: "string" },
        client_name: { type: "string", description: "For generate_proposal: client/company name" },
        event_date:  { type: "string", description: "For generate_proposal: event date" },
        notes:       { type: "string", description: "For generate_proposal: additional notes" },
        tax_exempt:  { type: "boolean", description: "For generate_proposal: set true if the customer states the order/location is tax-exempt (e.g. no state tax on alcohol) — this sets tax to $0 on the actual PDF, not just in your reply text" },
        tax_rate:    { type: "number", description: "For generate_proposal: override the tax rate as a decimal (e.g. 0.0625 for 6.25%). Only use if the customer specifies an exact rate; use tax_exempt instead for a flat $0." },
        min_price: { type: "number" },
        max_price:  { type: "number" },
        original_item: { type: "string", description: "For confirm_substitute ONLY: the exact name of the originally unavailable/pending item being replaced (as previously flagged, e.g. 'New Amsterdam Gin 750 mL')." },
        replacement_name: { type: "string", description: "For confirm_substitute ONLY: the exact name of the product the customer confirmed as the replacement (e.g. 'Bombay London Dry Gin')." },
        replacement_price: { type: "number", description: "For confirm_substitute ONLY: the per-unit price of the confirmed replacement, as already shown to the customer." },
        replacement_size: { type: "string", description: "For confirm_substitute ONLY: the size of the confirmed replacement (e.g. '750 mL'), if known." }
      },
      required: ["intent", "zip"]
    }
  },
  {
    name: "GetZipCode",
    description: "Extract a 5-digit zip code from a street address string.",
    input_schema: {
      type: "object",
      properties: { address: { type: "string", description: "Full street address" } },
      required: ["address"]
    }
  },
  {
    name: "GetD2CSession",
    description: "Load saved customer session (delivery address, zip, age verification) from GBrain.",
    input_schema: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"]
    }
  },
  {
    name: "SaveD2CSession",
    description: "Save customer delivery address and zip to GBrain for future sessions.",
    input_schema: {
      type: "object",
      properties: {
        email:   { type: "string" },
        zip:     { type: "string" },
        address: { type: "string" }
      },
      required: ["email", "zip"]
    }
  }
];

// ─── TOOL EXECUTOR ────────────────────────────────────────────────────────────

const ORDER_CONFIRMATION_WORDS = ['yes', 'yeah', 'yep', 'yup', 'confirm', 'confirmed', 'go ahead', 'place it', 'place the order', 'sounds good', 'that works', 'correct', 'do it', 'please place', 'looks good', 'lgtm', 'proceed', 'ok place', 'okay place'];

async function executeTool(toolName, toolInput, onPackageBuilt, channelFormat, onProposalGenerated, customerMessage, alreadyConfirmed, requesterEmail, sendEmailFn, lastProposalUrl, onUnavailableItems, onProductDiscussed, onSubstituteConfirmed, currentLineItems) {
  console.log(`[tool] ${toolName}`, JSON.stringify(toolInput).slice(0, 500));
  try {
    switch (toolName) {
      case 'AddToCart':
        return await addToCart(toolInput);

      case 'SendEmail': {
        if (!sendEmailFn) return { success: false, error: 'Email sending is not configured.' };
        const to = Array.isArray(toolInput.to) ? toolInput.to : [toolInput.to].filter(Boolean);
        if (to.length === 0) return { success: false, error: 'No recipient email address provided.' };
        let body = toolInput.body || '';
        if (lastProposalUrl) body = body.replace(/\{last_proposal_url\}/g, lastProposalUrl);
        try {
          await sendEmailFn(to, toolInput.subject || '(no subject)', body);
          return { success: true, sent_to: to };
        } catch (e) {
          console.error('[SendEmail] error:', e.message);
          return { success: false, error: 'Email send failed: ' + e.message };
        }
      }

      case 'ShoppingAgent': {
        const saInput = Object.assign({}, toolInput, { channel: channelFormat || toolInput.channel || 'slack' });
        if (requesterEmail) {
          if (saInput.email && saInput.email !== requesterEmail) {
            console.log('[ShoppingAgent] overriding LLM-supplied email', saInput.email, '->', requesterEmail);
          }
          saInput.email = requesterEmail;
        }
        // Real safety gap found tonight: place_order's line_items comes from the LLM's
        // own manual reconstruction of the order as a JSON string parameter — but the
        // LLM's "memory" of the order can drift from the ACTUAL current basket (e.g.
        // after several turns and substitutions), especially since confirm_substitute
        // updates are tracked in server.js's session state, not automatically reflected
        // back into the LLM's own working notion of the order. Never trust the LLM's
        // self-constructed line_items for an actual placement — always override with our
        // own authoritative, reliably-tracked current basket when we have one.
        if (saInput.intent === 'place_order' && currentLineItems) {
          if (saInput.line_items && saInput.line_items !== currentLineItems) {
            console.log('[ShoppingAgent] overriding LLM-supplied line_items with authoritative current basket for place_order');
          }
          saInput.line_items = currentLineItems;
        }
        // confirm_substitute is handled entirely in-process, not via the shopping-agent
        // HTTP service — it needs access to this session's pendingSubstitutes/
        // lastLineItems state, which lives only in server.js, not shopping-agent.js.
        // This replaces an earlier approach of trying to detect substitute confirmations
        // by regex-matching the customer's raw text after the fact — that missed many
        // real phrasings and was fundamentally fragile. Now the LLM itself (which
        // already understands intent correctly) explicitly calls this tool whenever it
        // recognizes a confirmation, and the actual state mutation happens reliably here.
        if (saInput.intent === 'confirm_substitute') {
          if (!onSubstituteConfirmed) return { success: false, error: 'confirm_substitute not available in this context' };
          const result = onSubstituteConfirmed(saInput.original_item || '', saInput.replacement_name || '', saInput.replacement_price || 0, saInput.replacement_size || '');
          return result || { success: true };
        }
        if (saInput.intent === 'place_order' && !alreadyConfirmed) {
          const msgLowerForConfirm = (customerMessage || '').toLowerCase();
          const hasExplicitConfirmation = ORDER_CONFIRMATION_WORDS.some(w => msgLowerForConfirm.includes(w));
          if (!hasExplicitConfirmation) {
            console.log('[order-confirm-gate] BLOCKED place_order — no explicit confirmation in customer message:', JSON.stringify(customerMessage || '').slice(0, 100));
            return { success: false, order_id: '', payment_url: '', error: 'Order placement blocked: no explicit customer confirmation detected for this turn.', action_required: 'Ask the customer to explicitly confirm (e.g. "yes, place the order") before calling place_order again.' };
          }
        }
        const saRes = await fetch('http://127.0.0.1:8300/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: saInput.intent, arguments: saInput } })
        });
        const saText = await saRes.text();
        const saLine = saText.split('\n').find(l => l.startsWith('data:'));
        if (!saLine) return { success: false, error: 'No response from shopping agent' };
        const saData = JSON.parse(saLine.replace('data:', '').trim());
        const result = JSON.parse(saData.result.content[0].text);
        console.log('[ShoppingAgent] intent:', saInput.intent, 'channel:', saInput.channel, 'success:', result.success);
        if (result.success && result.line_items && ['menu_build','custom_list'].includes(saInput.intent) && onPackageBuilt) {
          onPackageBuilt(saInput.email || '', result.line_items, saInput.channel);
        }
        // Track unavailable items via the tool's own structured field, not by
        // trying to parse the LLM's eventual free-text reply — this is what lets
        // a later deterministic "yes, find a substitute" handler in server.js
        // fire a real search for the RIGHT item, instead of the LLM guessing
        // from conversation memory and confusing it with an unrelated item
        // discussed earlier (a real bug this was built to fix).
        if (result.success && onUnavailableItems && ['menu_build','custom_list','product_query'].includes(saInput.intent)) {
          onUnavailableItems(result.unavailable || '');
        }
        // product_query / recommendation return `products` (or `results[].products`), not
        // `line_items`. Report what was just shown via a SEPARATE callback (onProductDiscussed),
        // NOT onPackageBuilt — a real, severe bug found tonight: onPackageBuilt unconditionally
        // overwrites the active saved order, so a narrow "here are 2 gin options to pick from"
        // search during mid-order substitution was silently destroying the customer's entire
        // ~20-item order, leaving only the last-searched options in state — which then became
        // the actual order sent to place_order, while the LLM's own displayed "here's your full
        // updated order" text (pure narration from conversation memory, no real merge ever
        // happened) looked correct to the customer even though the real saved state was wrong.
        // onProductDiscussed lets server.js decide whether it's safe to treat this as the
        // active order (no substantial existing basket) or should be kept separate (an existing
        // multi-item order is in progress, so a narrow options search must never replace it).
        if (result.success && onProductDiscussed && ['product_query','recommendation'].includes(saInput.intent)) {
          let flatProducts = [];
          if (Array.isArray(result.products)) {
            flatProducts = result.products;
          } else if (Array.isArray(result.results)) {
            for (const r of result.results) {
              if (r && Array.isArray(r.products)) flatProducts = flatProducts.concat(r.products);
            }
          }
          if (flatProducts.length > 0) {
            const asLineItems = flatProducts.map(p => ({
              label: p.name || p.label || '',
              name: p.name || '',
              qty: 1,
              price: p.salePrice || p.price || 0,
              size: p.size || '',
              url: p.url || '',
              product_id: p.product_id || p.id || '',
              upc: p.upc || '',
              establishmentId: p.establishmentId || '',
              category: p.category || ''
            }));
            onProductDiscussed(saInput.email || '', JSON.stringify(asLineItems), saInput.channel);
          }
        }
        if (result.success && result.download_url && saInput.intent === 'generate_proposal' && onProposalGenerated) {
          onProposalGenerated(result.download_url);
        }
        return result;
      }

      case 'GetZipCode': {
        const addr = toolInput.address || '';
        const match = addr.match(/\b(\d{5})\b/);
        if (match) return { zip: match[1], found: true };
        return { zip: '', found: false, error: 'No zip code found in address' };
      }

      case 'GetD2CSession': {
        const { getD2CSession } = require('./gbrain.js');
        const session = await getD2CSession(toolInput.email);
        return session || { onboarded: false, delivery_zip: '', delivery_address: '' };
      }

      case 'SaveD2CSession': {
        const { getD2CSession, saveD2CSession } = require('./gbrain.js');
        const existing = await getD2CSession(toolInput.email) || {};
        await saveD2CSession(toolInput.email, {
          ...existing,
          delivery_zip: toolInput.zip || existing.delivery_zip || '',
          delivery_address: toolInput.address || existing.delivery_address || ''
        });
        return { saved: true };
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch(e) {
    console.error(`[tool error] ${toolName}:`, e.message);
    return { error: e.message };
  }
}

// ─── TOOL FILTER ──────────────────────────────────────────────────────────────

function getTools(channel_format, context) {
  return ALL_TOOLS.filter(t => {
    // AddToCart only for Voiceflow with account_id
    if (t.name === 'AddToCart' && (!context || !context.account_id)) return false;
    // GetZipCode not needed when kitchen_location is set
    if (t.name === 'GetZipCode' && context && context.kitchen_location) return false;
    return true;
  });
}

module.exports = { executeTool, getTools, ALL_TOOLS };

// ─── RACHEL CHAT ──────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const MAX_ITERATIONS = 10;

async function rachelChat({ messages, context, rachelPrompt, gbrain_context = '', channel_format = 'voiceflow', address_rule = '', onPackageBuilt = null, onProposalGenerated = null, sendEmailFn = null, lastProposalUrl = '', customerMessage = '', alreadyConfirmed = false, onUnavailableItems = null, onProductDiscussed = null, onSubstituteConfirmed = null, currentLineItems = '' }) {
  const channelNotes = {
    html: `

## OUTPUT FORMAT: VOICEFLOW (HTML)
You are in a Voiceflow HTML widget that renders HTML natively.
- Bold: <b>text</b> — NEVER use ** or *
- Links: <a href="url" target="_blank">View</a>
- No markdown, no ---, no bullet dashes
PACKAGE DISPLAY — when ShoppingAgent returns line_items, format grouped by category with bold headers.
SINGLE PRODUCT — <b>Product Name</b> — size — $price | <a href="url" target="_blank">View</a>
IMPORTANT: After a recommendation intent result, present the products directly. Never call ShoppingAgent again with product_query.`,

    slack: `

## OUTPUT FORMAT: SLACK
- Bold: *text* — never use ** or <b> or __
- NO links, NO URLs, NO View links
- No HTML tags, no markdown headers (###)
PACKAGE DISPLAY — when ShoppingAgent returns line_items:
*WINE — N bottles*
Red: Nx Product Name — size — $price
SINGLE PRODUCT: *Product Name* — size — $price
RULES:
- NEVER mention cart, "add to cart", or any cart action
- Search immediately, no clarifying questions first
- When ShoppingAgent returns recommendation results, present them DIRECTLY — NEVER make a follow-up product_query call after a recommendation
- After presenting ANY package, ALWAYS ask: "Would you also like to add mixers, water, soda, ice, or cups?"
- When customer says YES to mixers: immediately call ShoppingAgent intent="product_query" with queries=[{name:"still water",category:"mixer"},{name:"sparkling water",category:"mixer"},{name:"soda variety pack",category:"mixer"},{name:"ice bag",category:"mixer"}] and zip from session. Present what's available and ask which they want.
- When customer says NO to mixers: respond with ONLY "Would you like to *place the order*, *generate a PDF proposal*, or make any changes?" — nothing else`,

    webchat: `

## OUTPUT FORMAT: WEBCHAT
- Bold: <b>text</b>
- NO links of any kind
- No markdown headers
- Clean plain layout with <br> for line breaks`,

    plain: `

## OUTPUT FORMAT: PLAIN TEXT
- No formatting whatsoever
- No bold, no links, no HTML`
  };

  const channelNote = channelNotes[channel_format] || channelNotes.plain;

  const systemPrompt = rachalPromptToSystem(rachelPrompt, context);
  const fullSystem = address_rule + (gbrain_context
    ? systemPrompt + '\n\n## CUSTOMER CONTEXT FROM MEMORY\n' + gbrain_context + channelNote
    : systemPrompt + channelNote);

  let claudeMessages = [...messages];
  let finalResponse = '';
  let iterations = 0;

  const tools = getTools(channel_format, context);

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      temperature: 0.3,
      system: fullSystem,
      tools,
      messages: claudeMessages
    });

    console.log(`[rachel] iteration ${iterations} stop_reason: ${response.stop_reason}`);

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      finalResponse = textBlock ? textBlock.text : '';
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const result = await executeTool(block.name, block.input, onPackageBuilt, channel_format, onProposalGenerated, customerMessage, alreadyConfirmed, context.user_email || '', sendEmailFn, lastProposalUrl, onUnavailableItems, onProductDiscussed, onSubstituteConfirmed, currentLineItems);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result)
          });
        }
      }
      claudeMessages = [
        ...claudeMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults }
      ];
    } else {
      const textBlock = response.content.find(b => b.type === 'text');
      finalResponse = textBlock ? textBlock.text : '';
      break;
    }
  }

  return { response: finalResponse, messages: claudeMessages };
}

function rachalPromptToSystem(prompt, context) {
  return prompt
    .replace(/\{kitchen_location\}/g, context.kitchen_location || '')
    .replace(/\{user_email\}/g,       context.user_email       || '')
    .replace(/\{age_verified\}/g,     context.age_verified ? 'true' : 'false')
    .replace(/\{account_id\}/g,       context.account_id       || '')
    .replace(/\{client_id\}/g,        context.client_id        || '');
}

module.exports = { rachelChat, executeTool, getTools };
