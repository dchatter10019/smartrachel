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
    description: "THE single interface for ALL product and order operations. Use for: product search (do you have X), menu building (event packages), custom lists (named products with qty), recommendations (suggest something), placing orders, and generating proposals. Pass intent + customer context. Never use BuildPackage or CreateOrder directly.\n\nintents:\nintent=\"product_query\" → search for specific products (do you have X, show me X)\nintent=\"recommendation\" → use when customer asks for suggestions (show me some nice tequila, recommend a wine) — uses purchase history\nintent=\"menu_build\" → build standard event package when customer says generic categories\nintent=\"custom_list\" → USE THIS when customer names specific products OR specific spirits (bourbon not just spirits)\nintent=\"place_order\" → place order after customer confirms\nintent=\"order_history\" → use when customer asks what they bought before, their past orders, order history, or wants to reorder something from a previous order. Returns itemized past orders with dates, products, and totals.\nintent=\"confirm_substitute\" → MANDATORY for ANY replacement of an existing basket item — BOTH (a) confirming a substitute for a previously-flagged unavailable item, AND (b) a voluntary swap between available products ('use X instead of Y', 'swap Y for X', 'replace Y with X', 'switch to X', 'I'd rather have X'). This is the ONLY way to actually change the basket; narrating a swap in text does NOT change it (a real customer asked to swap Angostura Bitters Cocoa for plain Angostura Bitters three times and Rachel just re-displayed the product each time because this tool was never called). Applies IN ANY PHRASING WHATSOEVER (a bare yes, restating the product name, looks good, sounds good, that works, anything at all indicating they want that specific option). Call this IMMEDIATELY in the SAME turn, alongside or instead of narrating the change in text — never just describe the substitution without also calling this tool. Pass original_item (the exact unavailable item being replaced), replacement_name, replacement_price, and replacement_size if known.\nintent=\"update_quantity\" → MANDATORY whenever the customer changes the QUANTITY of an existing basket item ('reduce the beers to 6 cases', 'make it 3 cases each', 'double the wine', 'only 2 bottles of tequila', 'remove the bitters'). Pass quantity_updates with EVERY affected item in ONE call. Once the customer has stated the change clearly, CALL THIS — do not ask for confirmation again (a real customer said 'reduce to 6 cases total, 3 each', confirmed 'yes' THREE times, and Rachel kept re-asking because she never called a tool). This is the ONLY way to change a quantity; narrating it does nothing. Then present the updated basket.\nintent=\"show_basket\" → MANDATORY whenever the customer asks to see their current basket/order/items/package (show me the basket, what's in my order, show me all the items, what do I have so far, recap). Returns the AUTHORITATIVE current basket as line_items_display — present it verbatim. NEVER say you can't see the basket, NEVER fall back to order_history, and NEVER reconstruct the basket from memory (your memory goes stale after swaps).\nintent=\"generate_proposal\" → generate PDF proposal — call when customer asks for a proposal/PDF/quote. If the customer states the order is tax-exempt (e.g. \"no tax on alcohol in this state\", \"set tax to 0\", \"no sales tax\") pass tax_exempt=true on the ShoppingAgent call — this actually zeroes the tax on the generated PDF. Do NOT just say $0 tax in your reply without also passing tax_exempt=true; the PDF is built by a separate template and won't reflect a change you only mention in text. If the customer wants a proposal with JUST the grand total and no fee breakdown ('just the total', 'no breakdown', 'don't show tax/tip/service', 'totals only'), pass totals_only=true — again, the PDF template decides this, so saying it in text does nothing.",
    input_schema: {
      type: "object",
      properties: {
        intent:    { type: "string", enum: ["product_query","menu_build","custom_list","recommendation","place_order","generate_proposal","order_history","confirm_substitute","show_basket","update_quantity"] },
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
        named_products: { type: "array", description: "For custom_list: [{name, category, qty, qty_from_customer}]. IMPORTANT: only include qty when the customer EXPLICITLY stated a number for that item (e.g. '3 bottles of Grey Goose'), and in that case ALSO set qty_from_customer: true. If the customer named a product for an event WITHOUT stating a quantity, OMIT qty entirely so the system's calculator sizes it correctly from guests/hours. NEVER invent a qty — an invented qty bypasses the calculator and produces badly undersized packages (a real bug shipped 14 wine bottles for 150 guests when the calculator would have sized 54)." },
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
        totals_only: { type: "boolean", description: "For generate_proposal: set true when the customer wants a proposal showing ONLY the grand total — no breakdown of product total, tax, service charge, tip, or delivery (e.g. 'just the total', 'no breakdown', 'don't show the fees', 'totals only', 'hide the tax/tip'). Line items and category subtotals still appear; only the fee breakdown is hidden." },
        min_price: { type: "number" },
        max_price:  { type: "number" },
        original_item: { type: "string", description: "For confirm_substitute ONLY: the exact name of the basket item being replaced — either a previously-flagged unavailable item OR any currently-available item the customer wants swapped out (e.g. 'New Amsterdam Gin 750 mL', 'Angostura Bitters Cocoa')." },
        replacement_name: { type: "string", description: "For confirm_substitute ONLY: the exact name of the product the customer confirmed as the replacement (e.g. 'Bombay London Dry Gin')." },
        replacement_price: { type: "number", description: "For confirm_substitute ONLY: the per-unit price of the confirmed replacement, as already shown to the customer." },
        replacement_size: { type: "string", description: "For confirm_substitute ONLY: the size of the confirmed replacement (e.g. '750 mL'), if known." },
        quantity_updates: { type: "array", description: "For update_quantity ONLY: list of {item, qty} — item is the basket item's name (or a distinctive part of it, e.g. 'Stella Artois'), qty is the new quantity (0 removes the item). Send ALL items being changed in ONE call, e.g. a split: [{\"item\":\"Stella Artois\",\"qty\":3},{\"item\":\"Corona Extra\",\"qty\":3}].", items: { type: "object", properties: { item: { type: "string" }, qty: { type: "number" } } } }
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

async function executeTool(toolName, toolInput, onPackageBuilt, channelFormat, onProposalGenerated, customerMessage, alreadyConfirmed, requesterEmail, sendEmailFn, lastProposalUrl, onUnavailableItems, onProductDiscussed, onSubstituteConfirmed, currentLineItems, onShowBasket, eventParams, onUpdateQuantity) {
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
        // Same authoritative-basket override for BOTH place_order AND generate_proposal.
        // Real, severe bug found tonight from a live event-planning session: the customer's
        // proposal quantities kept drifting between regenerations (wine went 8 -> 12 -> 16
        // -> 8 across consecutive proposals the customer never approved). Root cause: the
        // LLM hand-types the entire line_items JSON from its own conversation memory each
        // time, so any wavering in its recollection of quantities gets faithfully rendered
        // onto the PDF. A proposal (like an order) must reflect the actual saved basket,
        // never the LLM's from-memory reconstruction. Override with the authoritative
        // state.lastLineItems whenever we have one — the only time we fall through to the
        // LLM's supplied line_items is when there's genuinely no saved basket yet.
        // Sanitize named_products: the LLM sometimes merges several products into ONE
        // entry when reconstructing a list from memory — real bug on a budget-change
        // rebuild: "Stella Artois 24x12 Oz Bottle + Corona Extra 24x12 Oz Bottle (3 cases
        // each)" was sent as a single product name, matched nothing, and both beers came
        // back "unavailable". Split such entries on " + " / " & " / " and ", strip any
        // trailing "(N cases each)" parenthetical, and carry the per-item qty through.
        // Fill missing event parameters from the persisted eventParams (authoritative).
        // Real bug: on a budget-change rebuild the LLM sent budget=2500 but OMITTED
        // guests and hours (and dropped the beer), so the calculator defaulted to 10
        // guests and sized everything at 1 unit. A prompt rule asks the LLM to reuse
        // them; this guarantees it. Only fills what's missing — never overrides a value
        // the LLM did supply (the customer may genuinely be changing it).
        // PARAM-CHANGE OVERRIDE: when the customer's message only changes ONE parameter
        // (budget / guests / hours), rebuild from the persisted eventParams VERBATIM and
        // apply just that change. The LLM only relays the new value. Real bug: on
        // "the budget is now 2500" the LLM chose intent=menu_build (discarding the
        // customer's whole custom cocktail package) and INVENTED guests=50 — a 5-spirit
        // bar for 50 people replaced a 150-guest Margarita/Old Fashioned package. A
        // fill-only override can't catch a wrong-but-present value; this one can.
        if ((saInput.intent === 'custom_list' || saInput.intent === 'menu_build') && eventParams && eventParams.named_products) {
          const m = String(customerMessage || '').toLowerCase();
          const numIn = (re) => { const x = m.match(re); return x ? parseFloat(String(x[1]).replace(/,/g, '')) : null; };
          let newBudget = numIn(/budget[^0-9$]*\$?\s*([\d,]+(?:\.\d+)?)\s*k?/i);
          if (newBudget && /\d\s*k\b/i.test(m)) newBudget = newBudget * 1000;
          const newGuests = numIn(/(\d+)\s*(?:people|guests|ppl|attendees|heads?)\b/i);
          const newHours  = numIn(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i);
          const mentionsItems = /\b(add|remove|swap|replace|instead|also|plus|drop|without)\b/i.test(m);
          const changes = [newBudget, newGuests, newHours].filter(v => v !== null).length;
          if (changes >= 1 && !mentionsItems) {
            try {
              saInput.intent = eventParams.intent || 'custom_list';
              saInput.named_products = JSON.parse(eventParams.named_products);
              saInput.guests = newGuests || eventParams.guests || saInput.guests;
              saInput.hours = newHours || eventParams.hours || saInput.hours;
              if (eventParams.drinks_per_person && !newHours) saInput.drinks_per_person = eventParams.drinks_per_person;
              saInput.budget = newBudget || eventParams.budget || saInput.budget;
              if (eventParams.categories && !saInput.categories) saInput.categories = eventParams.categories;
              // Tag which fields the CUSTOMER changed, so the capture only updates those.
              saInput._paramChange = { budget: newBudget, guests: newGuests, hours: newHours };
              console.log('[ShoppingAgent] PARAM-CHANGE OVERRIDE: rebuilt call from persisted eventParams; changes ->', JSON.stringify({ budget: newBudget, guests: newGuests, hours: newHours }), '| intent:', saInput.intent, '| guests:', saInput.guests, '| hours:', saInput.hours, '| budget:', saInput.budget);
            } catch (e) { console.log('[ShoppingAgent] PARAM-CHANGE OVERRIDE failed:', e.message); }
          }
        }
        if ((saInput.intent === 'custom_list' || saInput.intent === 'menu_build') && eventParams) {
          const filled = [];
          if (!saInput.guests && eventParams.guests) { saInput.guests = eventParams.guests; filled.push('guests=' + eventParams.guests); }
          if (!saInput.hours && !saInput.drinks_per_person) {
            if (eventParams.hours) { saInput.hours = eventParams.hours; filled.push('hours=' + eventParams.hours); }
            else if (eventParams.drinks_per_person) { saInput.drinks_per_person = eventParams.drinks_per_person; filled.push('dpp=' + eventParams.drinks_per_person); }
          }
          if (!saInput.budget && eventParams.budget) { saInput.budget = eventParams.budget; filled.push('budget=' + eventParams.budget); }
          // Restore whole categories the LLM dropped (e.g. the beer vanished from the
          // rebuild). Only adds items whose category is entirely absent from the new list.
          if (saInput.intent === 'custom_list' && Array.isArray(saInput.named_products) && eventParams.named_products) {
            try {
              const prev = JSON.parse(eventParams.named_products) || [];
              const haveCats = new Set(saInput.named_products.map(n => String(n.category || '').toLowerCase()));
              for (const pn of prev) {
                const cat = String(pn.category || '').toLowerCase();
                if (cat && !haveCats.has(cat)) { saInput.named_products.push(pn); filled.push('restored ' + cat + ':' + pn.name); }
              }
            } catch (e) {}
          }
          if (filled.length) console.log('[ShoppingAgent] filled missing params from persisted eventParams:', filled.join(', '));
        }
        if (saInput.intent === 'custom_list' && Array.isArray(saInput.named_products)) {
          const splitMergedNamedProducts = (list) => {
            const out = [];
            for (const np of list) {
              const rawName = String((np && np.name) || '');
              const eachMatch = rawName.match(/\((\d+)\s*(?:cases?|bottles?|packs?)?\s*each\)/i);
              const cleaned = rawName.replace(/\s*\([^)]*each\)\s*$/i, '').trim();
              // Split ONLY on " + " — real product names use "&" and "and" ("Bread & Butter
              // Chardonnay", "Martini & Rossi") and would be wrongly split on those.
              const parts = cleaned.split(/\s+\+\s+/).map(s => s.trim()).filter(Boolean);
              if (parts.length > 1) {
                console.log('[ShoppingAgent] splitting merged named_product', JSON.stringify(rawName), '->', JSON.stringify(parts));
                for (const p of parts) {
                  const item = Object.assign({}, np, { name: p });
                  if (eachMatch && !item.qty) { item.qty = parseInt(eachMatch[1]); item.qty_from_customer = true; }
                  out.push(item);
                }
              } else {
                out.push(np);
              }
            }
            return out;
          };
          saInput.named_products = splitMergedNamedProducts(saInput.named_products);
        }
        if ((saInput.intent === 'place_order' || saInput.intent === 'generate_proposal') && currentLineItems) {
          if (saInput.line_items && saInput.line_items !== currentLineItems) {
            console.log('[ShoppingAgent] overriding LLM-supplied line_items with authoritative current basket for', saInput.intent);
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
        // show_basket: read the authoritative basket in-process (see server.js onShowBasket).
        if (saInput.intent === 'update_quantity') {
          if (!onUpdateQuantity) return { success: false, error: 'update_quantity not available in this context' };
          return onUpdateQuantity(saInput.quantity_updates || []) || { success: false };
        }
        if (saInput.intent === 'show_basket') {
          if (!onShowBasket) return { success: false, error: 'show_basket not available in this context' };
          return onShowBasket() || { success: false };
        }
        if (saInput.intent === 'confirm_substitute') {
          if (!onSubstituteConfirmed) return { success: false, error: 'confirm_substitute not available in this context' };
          // Handler is async now (it resolves the replacement to a real catalog product).
          const result = await onSubstituteConfirmed(saInput.original_item || '', saInput.replacement_name || '', saInput.replacement_price || 0, saInput.replacement_size || '');
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
          onPackageBuilt(saInput.email || '', result.line_items, saInput.channel, saInput);
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

async function rachelChat({ messages, context, rachelPrompt, gbrain_context = '', channel_format = 'voiceflow', address_rule = '', onPackageBuilt = null, onProposalGenerated = null, sendEmailFn = null, lastProposalUrl = '', customerMessage = '', alreadyConfirmed = false, onUnavailableItems = null, onProductDiscussed = null, onSubstituteConfirmed = null, currentLineItems = '', onShowBasket = null, eventParams = null, onUpdateQuantity = null }) {
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
          const result = await executeTool(block.name, block.input, onPackageBuilt, channel_format, onProposalGenerated, customerMessage, alreadyConfirmed, context.user_email || '', sendEmailFn, lastProposalUrl, onUnavailableItems, onProductDiscussed, onSubstituteConfirmed, currentLineItems, onShowBasket, eventParams, onUpdateQuantity);
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
