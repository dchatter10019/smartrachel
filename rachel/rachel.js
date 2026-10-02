/**
 * Rachel Service — Bevvi AI Beverage Specialist
 * Express API wrapping Claude Sonnet with tool use
 */

const Anthropic = require('@anthropic-ai/sdk');
const { addToCart } = require('./functions.js');
const fetch = (url, opts) => import('node-fetch').then(({default: f}) => f(url, require('./log-tag.js').withQAHeader(url, opts)));   // QA turns tag shopping-agent's log lines too

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
    description: "THE single interface for ALL product and order operations. Use for: product search (do you have X), menu building (event packages), custom lists (named products with qty), recommendations (suggest something), placing orders, and generating proposals. Pass intent + customer context. Never use BuildPackage or CreateOrder directly.\n\nintents:\nintent=\"product_query\" → search for specific products (do you have X, show me X)\nintent=\"recommendation\" → use when customer asks for suggestions (show me some nice tequila, recommend a wine) — uses purchase history\nintent=\"alternatives\" → USE THIS for alternatives/similar/substitutes to SPECIFIC products the store does not carry (\"not available — show me alternatives\"). Pass originals=[{name, category}] with the ORIGINAL product names exactly as the customer gave them. Results are ranked by price tier (anchored to the original's market price) and region, each tagged with the original it replaces — present them grouped per original, in the given order, with honest tier labels.\nintent=\"menu_build\" → build standard event package when customer says generic categories\nintent=\"custom_list\" → USE THIS when customer names specific products OR specific spirits (bourbon not just spirits)\nintent=\"place_order\" → place order after customer confirms\nintent=\"order_history\" → use when customer asks what they bought before, their past orders, order history, or wants to reorder something from a previous order. Returns itemized past orders with dates, products, and totals.\nintent=\"confirm_substitute\" → MANDATORY for ANY replacement of an existing basket item — BOTH (a) confirming a substitute for a previously-flagged unavailable item, AND (b) a voluntary swap between available products ('use X instead of Y', 'swap Y for X', 'replace Y with X', 'switch to X', 'I'd rather have X'). This is the ONLY way to actually change the basket; narrating a swap in text does NOT change it (a real customer asked to swap Angostura Bitters Cocoa for plain Angostura Bitters three times and Rachel just re-displayed the product each time because this tool was never called). Applies IN ANY PHRASING WHATSOEVER (a bare yes, restating the product name, looks good, sounds good, that works, anything at all indicating they want that specific option). PICK-LIST SELECTION: when you have shown the customer several options (sizes, variants, brands) and they choose one or more — e.g. '2. KJ Chardonnay 375 mL and Corona Extra 12x12' — call this ONCE PER CHOSEN ITEM with NO original_item (the basket is empty or the item is new), passing replacement_name/price/size from the option they picked. This ADDS the chosen items to the basket. Real bug: a customer picked 2 of 5 options, Rachel narrated the 2 but never called this, and the order went out with all 5. Selections are never just narrated. Call this IMMEDIATELY in the SAME turn, alongside or instead of narrating the change in text — never just describe the substitution without also calling this tool. Pass original_item (the exact unavailable item being replaced), replacement_name, replacement_price, and replacement_size if known.\nintent=\"update_quantity\" → MANDATORY whenever the customer changes the QUANTITY of an existing basket item ('reduce the beers to 6 cases', 'make it 3 cases each', 'double the wine', 'only 2 bottles of tequila', 'remove the bitters'). Pass quantity_updates with EVERY affected item in ONE call. Once the customer has stated the change clearly, CALL THIS — do not ask for confirmation again (a real customer said 'reduce to 6 cases total, 3 each', confirmed 'yes' THREE times, and Rachel kept re-asking because she never called a tool). This is the ONLY way to change a quantity; narrating it does nothing. Then present the updated basket.\nintent=\"show_basket\" → MANDATORY whenever the customer asks to see their current basket/order/items/package (show me the basket, what's in my order, show me all the items, what do I have so far, recap). Returns the AUTHORITATIVE current basket as line_items_display — present it verbatim. NEVER say you can't see the basket, NEVER fall back to order_history, and NEVER reconstruct the basket from memory (your memory goes stale after swaps).\nintent=\"generate_proposal\" → generate PDF proposal — call when customer asks for a proposal/PDF/quote. If the customer states the order is tax-exempt (e.g. \"no tax on alcohol in this state\", \"set tax to 0\", \"no sales tax\") pass tax_exempt=true on the ShoppingAgent call — this actually zeroes the tax on the generated PDF. Do NOT just say $0 tax in your reply without also passing tax_exempt=true; the PDF is built by a separate template and won't reflect a change you only mention in text. If the customer wants a proposal with JUST the grand total and no fee breakdown ('just the total', 'no breakdown', 'don't show tax/tip/service', 'totals only'), pass totals_only=true — again, the PDF template decides this, so saying it in text does nothing. If the customer says 'without the subtotals' / 'no subtotals' / 'no category totals', pass hide_subtotals=true (that removes the Wine Total / Spirits Total rows; it is different from totals_only).",
    input_schema: {
      type: "object",
      properties: {
        intent:    { type: "string", enum: ["product_query","menu_build","custom_list","recommendation","alternatives","place_order","generate_proposal","order_history","confirm_substitute","show_basket","update_quantity"] },
        zip:       { type: "string", description: "Delivery zip code" },
        email:     { type: "string", description: "Customer email" },
        queries:   { type: "array",  description: "For product_query: [{name, category, limit}]" },
        originals: { type: "array",  description: "For alternatives: the products the customer asked for that this store does not carry — [{name, category}], names exactly as the customer gave them. Alternatives are the SAME TYPE as the original (an aperitif for an aperitif, sparkling for sparkling). Only when the customer explicitly asks for another type (\"a sparkling wine close to Lillet's price\") add type: aperitif | fortified | sparkling | rose | red | white." },
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
        hide_subtotals: { type: "boolean", description: "For generate_proposal: set true when the customer does not want the per-category subtotal rows (Wine Total / Spirits Total / Beer Total) — 'without the subtotals', 'no subtotals', 'no category totals', 'drop the section totals'. Line items and the fee breakdown still appear. Real bug: the customer said 'without the subtotals' and the PDF still had them because this was never passed." },
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

async function executeTool(toolName, toolInput, onPackageBuilt, channelFormat, onProposalGenerated, customerMessage, alreadyConfirmed, requesterEmail, sendEmailFn, lastProposalUrl, onUnavailableItems, onProductDiscussed, onSubstituteConfirmed, currentLineItems, onShowBasket, eventParams, onUpdateQuantity, onOrderPlaced, sessionState, customerSaid = '') {
  console.log(`[tool] ${toolName}`, JSON.stringify(toolInput).slice(0, 500));
  try {
    switch (toolName) {
      case 'AddToCart':
        return await addToCart(toolInput);

      case 'SendEmail': {
        if (eventParams && eventParams.qa) { console.log('[QA] SendEmail simulated:', JSON.stringify(toolInput.to), toolInput.subject); return { success: true, simulated: true, message: 'Email sent to ' + [].concat(toolInput.to).join(', ') + ' (QA simulated)' }; }
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
        if (eventParams && eventParams.qa) toolInput.dry_run = true;   // QA: no real placement
        if (toolInput.intent === 'generate_proposal' && eventParams && eventParams.proposalOpts) {
          for (const k of ['hide_subtotals', 'totals_only', 'tax_exempt']) if (eventParams.proposalOpts[k] && toolInput[k] === undefined) toolInput[k] = true;
          console.log('[proposal] options injected into generate_proposal:', JSON.stringify(eventParams.proposalOpts));
        }
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
        // ALTERNATIVES ROUTING (deterministic). After a search found that named products aren't
        // carried here (sessionState.lastNotFound), "show me alternatives / something similar" goes
        // to the alternatives intent with those originals — anchored to their price and region.
        // Real complaint (DC, Sep 27): the LLM sent "yes show some altenatives" to recommendation
        // with occasion "Sonoma California Chardonnay premium" and no price; it led with La Crema
        // $21 for a ~$85 Paul Hobbs single-vineyard while Far Niente / Flowers were in stock.
        {
          const nf = sessionState && sessionState.lastNotFound;
          const normNF = x => String(x || '').toLowerCase().replace(/\s*[-—]?\s*\d+(\.\d+)?\s*(ml|l)\b.*$/i, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
          const fresh = nf && Array.isArray(nf.items) && nf.items.length && (Date.now() - (nf.at || 0)) < 60 * 60 * 1000;
          // "use another pinot noir" while "La Crema Pinot Noir" is pending as not carried: alternatives for THAT item
          // (same varietal, anchored to its price), not a plain search. Real bug (Sep 30, DC): product_query "Pinot Noir
          // 750 mL" led with Goldeneye at $73.49 for a ~$25 La Crema.
          {
            const pendAll = [].concat((sessionState && sessionState.pendingSubstitutes) || [], fresh ? nf.items.map(x => x.name) : []);
            const qs = Array.isArray(saInput.queries) ? saInput.queries : [];
            if (['product_query', 'recommendation'].includes(saInput.intent) && pendAll.length && qs.length <= 1 && /\b(another|other|different|use|swap|replace|instead)\b/i.test(String(customerMessage || ''))) {
              const { varietalOf: vOf } = (() => { try { return require('/home/ubuntu/store-agent/alternatives.js'); } catch (e) { return { varietalOf: () => '' }; } })();
              const qv = vOf((qs[0] && (qs[0].name || qs[0].term)) || saInput.occasion || '') || vOf(customerMessage);
              const hit = qv ? [...new Set(pendAll)].filter(pn => vOf(pn) === qv) : [];
              if (hit.length === 1) {
                console.log('[ShoppingAgent] ALTERNATIVES ROUTING: ' + saInput.intent + ' for ' + qv + ' -> alternatives for the not-carried ' + JSON.stringify(hit[0]));
                ['queries', 'occasion', 'category', 'budget_per_bottle', 'min_price', 'max_price'].forEach(k => delete saInput[k]);
                saInput.intent = 'alternatives';
                saInput.originals = [{ name: hit[0], category: /^(bourbon|rye|scotch|tequila|mezcal|vodka|gin|rum|cognac|brandy)$/.test(qv) ? 'spirits' : 'wine' }];
              }
            }
          }
          const ALT_RE = /\balt\w{0,3}nativ|\bsimilar\b|\bsubstitut|\bcomparable\b|\bequivalent|\bsomething (?:else )?like\b|\bclose to\b|\binstead\b|\blike (?:those|these|them|that|it)\b|\bnot even close\b|\bcloser\b/i;
          // A reprice of wines already in the basket ("find alternative wines around $20") is not an
          // alternatives search: those products ARE carried. Real bug (smoke, Sep 27): the LLM sent the
          // 3 basket wines to alternatives; Domaines Ott had no market price and got Dom Perignon Rosé
          // at $659. Every original in the basket -> a varietal product_query in the stated price range.
          let basketNow = [];
          try { basketNow = JSON.parse(currentLineItems || '[]') || []; } catch (e) {}
          const inBasket = o => basketNow.find(li => { const a = String(li.name || '').toLowerCase(), b = String((o && o.name) || '').toLowerCase().replace(/\s*[-—]?\s*\d+(\.\d+)?\s*(ml|l)\b.*$/i, '').trim(); return b.length > 3 && (a.includes(b) || b.includes(a.replace(/\s*[-—]?\s*\d+(\.\d+)?\s*(ml|l)\b.*$/i, '').trim())); });
          if (saInput.intent === 'alternatives' && Array.isArray(saInput.originals) && saInput.originals.length && basketNow.length && saInput.originals.every(inBasket) && !(fresh && saInput.originals.some(o => nf.items.some(x => x.name === o.name)))) {
            const { varietalOf } = (() => { try { return require('/home/ubuntu/store-agent/alternatives.js'); } catch (e) { return { varietalOf: () => '' }; } })();
            const m = String(customerMessage || '').match(/\$\s*(\d+(?:\.\d+)?)/);
            const target = m ? parseFloat(m[1]) : 0;
            saInput.queries = saInput.originals.map(o => ({ name: varietalOf(o.name) || o.name, category: o.category || 'wine', limit: 3 }));
            if (target && !saInput.min_price && !saInput.max_price) { saInput.min_price = Math.round(target * 0.75); saInput.max_price = Math.round(target * 1.25); }
            console.log('[ShoppingAgent] alternatives -> product_query: every original is in the basket (a reprice) — queries ' + saInput.queries.map(q => q.name).join(', ') + (target ? ' $' + saInput.min_price + '-' + saInput.max_price : ''));
            saInput.intent = 'product_query'; delete saInput.originals;
          } else if (saInput.intent === 'alternatives' && Array.isArray(saInput.originals)) {
            // Carry the basket price as a fallback anchor when the web has no market price.
            saInput.originals = saInput.originals.map(o => { const li = inBasket(o); return li ? Object.assign({}, o, { basket_price: parseFloat(li.price) || 0 }) : o; });
          }
          if (saInput.intent === 'alternatives' && !(Array.isArray(saInput.originals) && saInput.originals.length) && fresh) {
            saInput.originals = nf.items;
            console.log('[ShoppingAgent] alternatives: originals filled from the last not-found search: ' + nf.items.map(x => x.name).join(' | '));
          } else if (fresh && saInput.intent === 'product_query' && ALT_RE.test(String(customerMessage || '')) && (saInput.queries || []).some(q => !nf.items.some(x => normNF(x.name).includes(normNF(q.name || q.term || '').split(' ').slice(0, 2).join(' '))))) {
            // A search naming OTHER products is not a request for alternatives to the not-found ones.
            // Real bug (Sep 29, Slack): "Instead of Bacardi ..." + a not-found "high end whiskey"
            // rerouted Rachel's Macallan / Johnnie Walker / Woodford searches to alternatives for
            // "high end whiskey" (0 picks, 4 times) and she told DC search was broken.
            console.log('[ShoppingAgent] ALTERNATIVES ROUTING skipped — product_query names other products: ' + saInput.queries.map(q => q.name || q.term).join(' | '));
          } else if (fresh && ['product_query', 'recommendation'].includes(saInput.intent) && ALT_RE.test(String(customerMessage || ''))) {
            console.log('[ShoppingAgent] ALTERNATIVES ROUTING: ' + saInput.intent + ' -> alternatives for ' + nf.items.map(x => x.name).join(' | '));
            ['queries', 'occasion', 'category', 'budget_per_bottle', 'min_price', 'max_price'].forEach(k => delete saInput[k]);
            saInput.intent = 'alternatives';
            saInput.originals = nf.items;
          }
        }
        // RECOMMENDATION ROUTING (deterministic). The LLM routed "recommend a white wine"
        // to product_query, so only the customer's price tier was applied — their actual
        // top_products (the history that surfaces "Kendall Jackson", which they've bought
        // repeatedly) were never consulted. If the customer is asking for a suggestion,
        // force the recommendation intent and carry the category over.
        if (saInput.intent === 'product_query') {
          const m = String(customerMessage || '').toLowerCase();
          const wantsRec = /\b(recommend|recommendation|suggest|suggestion|what(?:'s| is) good|what do you (?:recommend|suggest|think)|pick (?:something|one|a)|any (?:good|nice)|your (?:pick|favorite)|something (?:nice|good))\b/.test(m);
          // Classifier label first ('show me a nice white wine' is a recommend ask with no
          // keyword); the regex remains the fallback when the classifier didn't run.
          const clsRec = eventParams && eventParams.classified_intent === 'recommend';
          // Only a GENERIC ask ("recommend a white wine") becomes a recommendation. Several
          // queries, or a query naming a varietal/brand, stay product_query. Real bug
          // (reprice-multipick, Sep 27): "find alternative wines around $20" sent Sauvignon Blanc,
          // Pinot Noir and Rosé queries with a $15-25 range; routing kept only "Sauvignon Blanc"
          // as a loose occasion and returned one generic wine list, so Rachel told the customer
          // no Sauvignon Blanc or rosé existed near $20 — the store has dozens.
          const qs = Array.isArray(saInput.queries) ? saInput.queries : [];
          const GENERIC_Q = /^\s*(?:(?:a|an|some|nice|good)\s+)*(?:(?:red|white|ros[eé]|sparkling|dry|sweet)\s+)?(?:wine|wines|beer|beers|spirits?|liquor|vodka|gin|rum|tequila|whiske?y|bourbon|scotch|seltzer|hard seltzer|champagne|prosecco|lager|ipa)\s*$/i;
          const specific = qs.length > 1 || qs.some(q => q && q.name && !GENERIC_Q.test(String(q.name)));
          if ((clsRec || wantsRec) && specific) console.log('[ShoppingAgent] RECOMMENDATION ROUTING skipped — specific product_query kept (' + qs.map(q => q && q.name).join(', ') + ')');
          if ((clsRec || wantsRec) && !specific) {
            const q = qs[0] || {};
            const cat = q.category || (/\bwine\b/.test(m) ? 'wine' : /\b(vodka|gin|rum|tequila|whisk|bourbon|scotch|spirit)/.test(m) ? 'spirits' : /\b(beer|lager|ipa|seltzer)\b/.test(m) ? 'beer' : '');
            const occ = q.name || '';
            console.log('[ShoppingAgent] RECOMMENDATION ROUTING: product_query ->', 'recommendation', '| category:', cat, '| occasion:', occ);
            saInput.intent = 'recommendation';
            if (cat) saInput.category = cat;
            if (occ) saInput.occasion = occ;
            delete saInput.queries;
          }
        }
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
          // The customer's answer to "what will your guests drink most?" (server.js) — applied in
          // code on every menu_build for this event, rebuilds included; the LLM never sets it.
          // menu_build, and custom_list for EVENTS (guests set) — cocktail events are built as custom_list.
          if ((saInput.intent === 'menu_build' || (saInput.intent === 'custom_list' && saInput.guests)) && eventParams.serving_mix && !saInput.serving_mix) { saInput.serving_mix = eventParams.serving_mix; filled.push('serving_mix=' + eventParams.serving_mix); }
          // The mix is applied inside the standard package builder. An LLM-set category_splits
          // would switch to SPLIT mode instead (real: spirits dropped, far too few bottles).
          if (saInput.intent === 'menu_build' && saInput.serving_mix && saInput.category_splits) { console.log('[ShoppingAgent] dropped LLM category_splits ' + saInput.category_splits + ' — the customer\'s serving mix is applied instead'); delete saInput.category_splits; }
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
              let mixR = {}; try { mixR = JSON.parse(eventParams.serving_mix || '{}') || {}; } catch (e) {}
              for (const pn of prev) {
                const cat = String(pn.category || '').toLowerCase();
                if (cat && mixR[cat] === 0) continue;   // the customer left that category out ("just beer + wine")
                if (cat && !haveCats.has(cat)) { saInput.named_products.push(pn); filled.push('restored ' + cat + ':' + pn.name); }
              }
            } catch (e) {}
          }
          if (filled.length) console.log('[ShoppingAgent] filled missing params from persisted eventParams:', filled.join(', '));
        }
        // DURATION IS NEVER ASSUMED. Real bug (Sep 29, QA replay of DC's Slack event): "event for 50 people for
        // $5000, liquor beer and wine" -> the LLM built with hours=5 the customer never gave (the prompt says
        // never default; it did anyway), then misread the customer's "2 hours" as a question. An event build's
        // hours must come from the customer — a message in this conversation, or a persisted earlier build.
        if ((saInput.intent === 'menu_build' || (saInput.intent === 'custom_list' && saInput.guests)) && saInput.hours && !saInput.drinks_per_person && !(eventParams && eventParams.hours) && !saInput._paramChange) {
          const said = String(customerSaid || '') + '\n' + String(customerMessage || '');
          const HOURS_RE = /\b\d+(?:\.\d+)?\s*(?:-|to)?\s*(?:\d+(?:\.\d+)?\s*)?(?:hours?|hrs?|hr)\b|\b(?:an?|one|two|three|four|five|six|seven|eight|half)[\s-]+(?:an?\s+)?(?:hours?|hrs?|day)\b|\ball[- ](?:day|night|evening)\b|\b\d{1,2}(?::\d\d)?\s*(?:am|pm)?\s*(?:-|to|until|till|–)\s*\d{1,2}(?::\d\d)?\s*(?:am|pm)\b|\bdrinks?\s+(?:per|a|each)\s+(?:person|head|guest)/i;
          if (!HOURS_RE.test(said)) {
            console.log('[ShoppingAgent] REFUSED ' + saInput.intent + ': hours=' + saInput.hours + ' was never stated by the customer — the LLM must ask the event length');
            return { success: false, error: 'NEED_DURATION: the customer has not said how long the event is. Do NOT assume or default the hours. Ask exactly one question: "How long is the event? (e.g. 3 hours)" — then build with their answer.' };
          }
        }
        // Stock the customer already has is not ordered (on-hand.js; DC, Oct 2) — the LLM put DC's on-hand wine in the list.
        if ((saInput.intent === 'custom_list' || saInput.intent === 'menu_build') && Array.isArray(saInput.named_products) && sessionState && sessionState.onHand && sessionState.onHand.length) {
          const OH = require('./on-hand.js');
          const left = [];
          saInput.named_products = saInput.named_products.filter(np => {
            const o = OH.isOnHand(np && np.name, sessionState.onHand);
            if (o) { left.push((o.qty ? o.qty + 'x ' : '') + o.name); console.log('[on-hand] DROPPED ' + JSON.stringify(np.name) + ' (customer already has ' + JSON.stringify(o.name) + ')'); }
            return !o;
          });
          if (left.length) sessionState.replyNote = 'Not ordered — you already have: ' + left.join(', ') + '.';
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
          // A quantity the customer SAID in words is theirs, not the calculator's. Real bug:
          // "2 bottles of Tito's 750ml and a Whispering Angel" — the LLM omitted qty for the
          // rosé and the system sized it to 3. Only for non-event lists (no guests), and only
          // when the number word sits right before a distinctive word of that product's name.
          if (!saInput.guests && customerMessage) {
            const WORDS = { a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, 'a dozen': 12, 'half a dozen': 6, 'half dozen': 6 };
            const GENERIC_W = /^(wine|vodka|tequila|gin|rum|whiskey|whisky|bourbon|scotch|beer|rose|rosé|red|white|brut|champagne|bottle|bottles|the|and|of|750ml|ml)$/i;
            const msgQ = String(customerMessage).toLowerCase().replace(/[’']/g, '');
            for (const np of saInput.named_products) {
              if (!np || np.qty) continue;
              const key = String(np.name || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9éè]+/).filter(w => w.length >= 4 && !GENERIC_W.test(w))[0];
              if (!key) continue;
              const re = new RegExp('\\b(half a dozen|half dozen|a dozen|a|an|one|single|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)\\s+(?:bottles?\\s+of\\s+|btls?\\s+of\\s+|cases?\\s+of\\s+)?(?:the\\s+)?(?:[a-z0-9éè]+\\s+){0,2}?' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
              const mq = msgQ.match(re);
              if (mq && WORDS[mq[1]]) {
                np.qty = WORDS[mq[1]]; np.qty_from_customer = true;
                console.log('[ShoppingAgent] qty from customer wording: ' + JSON.stringify(mq[0]) + ' -> ' + np.qty + 'x ' + np.name);
              }
            }
          }
        }
        // LISTED PRODUCTS SIZED FOR AN EVENT (server.js: the answer to "what will your guests drink most?" for a held
        // product list + guest count). Real case (Sep 30, DC): a photo of 10 products + "create a menu for 100 people
        // for a 3 hour event", then "take the same ones listed but change the quantities, the guests just want beer +
        // wine" — the LLM rebuilt the photo's own quantities (qty_from_customer) with the vodka and gin still in.
        // Here, in code: every listed line is sized by the event calculator, and lines of a category the customer
        // left out are dropped (logged, and listed in the reply).
        const ls = eventParams && eventParams.list_scale;
        if (ls && saInput.intent === 'menu_build') {
          console.log('[list-scale] REFUSED menu_build — the customer\'s listed products are sized with custom_list');
          return { success: false, error: 'NOT_NEEDED: the customer wants THEIR LISTED products sized for the event. Build them with intent=custom_list (one call, every listed product, no qty) — the system sizes the quantities.' };
        }
        // The list was just built for the event: left-out lines stay out and stand-ins are already chosen. Real bug
        // (QA replay of DC's case): after the build the LLM called confirm_substitute for the dropped vodka and gin
        // and the not-carried Lillet, putting them back at 1 each.
        if (ls && ls.built && (saInput.intent === 'confirm_substitute' || saInput.intent === 'update_quantity' || saInput.intent === 'custom_list')) {
          console.log('[list-scale] REFUSED ' + saInput.intent + ' after the event build this turn' + (saInput.original_item ? ' (' + JSON.stringify(saInput.original_item) + ')' : ''));
          return { success: false, error: 'NOT_NEEDED: the listed products were just sized for the event. Items of a category the customer left out stay out, and not-carried items already have a stand-in. Do not add, swap or re-size anything now — present the list as built and let the customer ask for changes.' };
        }
        if (ls && saInput.intent === 'custom_list' && Array.isArray(saInput.named_products)) {
          if (!saInput.guests && ls.guests) saInput.guests = ls.guests;
          if (!saInput.hours && !saInput.drinks_per_person && ls.hours) saInput.hours = ls.hours;
          if (!saInput.serving_mix && eventParams.serving_mix) saInput.serving_mix = eventParams.serving_mix;
          let mixL = {}; try { mixL = JSON.parse(eventParams.serving_mix || '{}') || {}; } catch (e) {}
          const kept = [], dropped = [];
          const DTl = require('./drink-type.js');
          for (const np of saInput.named_products) {
            // An aperitif (Lillet, vermouth, Aperol) counts as LIQUOR for the serving mix, whatever the LLM called it.
            // DC (Sep 30): "just beer + wine" still listed 3x Lillet Blanc (the LLM filed it as wine; Bevvi as Liquor/Aperitif).
            const cat0 = String((np && np.category) || '').toLowerCase();
            const cat = DTl.typeOf({ name: np && np.name }) === 'aperitif' ? 'spirits' : cat0;
            if (cat !== cat0) console.log('[list-scale] ' + JSON.stringify(np.name) + ' is an aperitif: counted as liquor, not ' + cat0);
            // "just beer and wine" leaves hard seltzer out too (DC, Sep 30), though it sits in the beer category.
            if (ls.no_seltzer && /\b(?:hard\s+)?seltzers?\b|white claw|\btruly\b|high noon|vizzy|bon\s*&\s*viv/i.test(String((np && np.name) || ''))) {
              dropped.push(np.name); console.log('[list-scale] DROPPED ' + JSON.stringify(np.name) + ' (hard seltzer — the customer said just ' + Object.keys(mixL).filter(k => mixL[k] > 0).join(' and ') + ')'); continue;
            }
            if (mixL[cat] === 0) { dropped.push(np.name); console.log('[list-scale] DROPPED ' + JSON.stringify(np.name) + ' (' + cat + ' — left out of the customer\'s serving mix)'); continue; }
            if (np.qty) console.log('[list-scale] qty ' + np.qty + ' for ' + JSON.stringify(np.name) + ' -> sized by the event calculator (' + saInput.guests + ' guests)');
            np.qty_from_customer = false; delete np.qty;
            kept.push(np);
          }
          saInput.named_products = kept;
          const inCats = Object.keys(mixL).filter(k => mixL[k] > 0).map(k => k === 'spirits' ? 'liquor' : k);
          if (dropped.length && sessionState) sessionState.replyNote = 'Left out, since your guests will drink ' + inCats.join(' and ') + ' only: ' + dropped.join(', ') + '.';
          console.log('[list-scale] custom_list: ' + kept.length + ' listed line(s) sized for ' + saInput.guests + ' guests / ' + (saInput.hours || '?') + 'h, mix ' + eventParams.serving_mix + (dropped.length ? ', ' + dropped.length + ' dropped' : ''));
        }
        // The LIVE basket, not the one this turn started with. Real bug (Oct 1, DC's Goody quote): one LLM
        // turn added lemon juice + simple syrup, then generated the proposal — the PDF had the turn-start
        // basket (14 lines, $1,056.50) while the reply listed 16 lines, $1,123.22.
        if (sessionState && sessionState.lastLineItems && sessionState.lastLineItems !== currentLineItems) {
          console.log('[ShoppingAgent] basket changed earlier this turn — ' + saInput.intent + ' uses the live basket');
          currentLineItems = sessionState.lastLineItems;
        }
        // The saved event date / client, as the in-code proposal reuses them. Same session: the LLM's
        // generate_proposal sent no event_date and the PDF said "Event Date(s): —".
        if (saInput.intent === 'generate_proposal' && sessionState) {
          if (!saInput.event_date && sessionState.savedEventDate) { saInput.event_date = sessionState.savedEventDate; console.log('[proposal] saved event date added to the LLM proposal: ' + JSON.stringify(saInput.event_date)); }
          if (!saInput.client_name && sessionState.savedClientName) saInput.client_name = sessionState.savedClientName;
        }
        if ((saInput.intent === 'place_order' || saInput.intent === 'generate_proposal') && currentLineItems) {
          if (saInput.line_items && saInput.line_items !== currentLineItems) {
            console.log('[ShoppingAgent] overriding LLM-supplied line_items with authoritative current basket for', saInput.intent);
          }
          saInput.line_items = currentLineItems;
          // Same delivery line as the in-code proposal. Real bug (Oct 1, Sean): the LLM-built PDF had no "Delivery:" line.
          if (saInput.intent === 'generate_proposal' && sessionState && sessionState.address && !/\bdeliver/i.test(saInput.notes || '')) {
            saInput.notes = 'Delivery: ' + sessionState.address + '.' + (saInput.notes ? ' ' + saInput.notes : '');
            console.log('[proposal] delivery address added to the LLM proposal notes');
          }
          // Options the customer asked to have in the PDF (proposal-options.js) — same as the in-code proposal.
          if (saInput.intent === 'generate_proposal' && sessionState && sessionState.proposalWithOptions && !saInput.options) {
            let bkO = []; try { bkO = JSON.parse(currentLineItems || '[]'); } catch (e) {}
            const oO = require('./proposal-options.js').buildOptions(sessionState.shownOptions, bkO);
            if (oO.length) { saInput.options = JSON.stringify(oO); console.log('[options] listed in the LLM proposal PDF: ' + oO.map(o => o.label).join(', ')); }
          }
          // The customer-chosen tip rides in the server's place_order instruction; the LLM
          // may drop or change it (it used to be told never to show $0). Enforce it here.
          if (saInput.intent === 'place_order') {
            try { const sys = JSON.parse(customerMessage); if (sys && sys._system === 'place_order' && typeof sys.tip_amount === 'number') { console.log('[ShoppingAgent] place_order tip_amount ' + sys.tip_amount + ' from the approved summary' + (saInput.tip_amount !== sys.tip_amount ? ' (LLM passed ' + saInput.tip_amount + ')' : '')); saInput.tip_amount = sys.tip_amount; } } catch (e) {}
          }
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
        if (ls && saInput.intent === 'custom_list' && (result.success === true || result.success === 'true')) ls.built = true;   // [list-scale]: nothing re-added after this
        // Event log: what this tool call did (events.js keeps the strongest action of the turn).
        try {
          const EV = { product_query: 'searched', recommendation: 'searched', alternatives: 'searched', menu_build: 'built_basket', custom_list: 'built_basket',
            show_basket: 'showed_basket', confirm_substitute: 'updated_basket', update_quantity: 'updated_basket', generate_proposal: 'generated_proposal' };
          if (result.success && EV[saInput.intent]) require('./events.js').action(EV[saInput.intent]);
          if (result.success && saInput.intent === 'custom_list') require('./events.js').note({ list_build: true });
          // A price-tier concern from the critic is a downsell ("leans ultra-premium — rebuild at a moderate tier?")
          // and the goal is to spend the whole budget (DC, Sep 29). Dropped before the LLM sees it; other concerns
          // (wrong category, missing sparkling) stay.
          if (result.review_note && (saInput.intent === 'menu_build' || saInput.intent === 'custom_list') && /\b(expensive|pricey|premium|luxur\w*|splurg\w*|costly|price|priced|pricing|tier|budget|cheaper|high[- ]end|overspend\w*|extravagan\w*)\b/i.test(result.review_note)) {
            console.log('[ShoppingAgent] review_note dropped (price concern — the budget is meant to be spent): ' + String(result.review_note).slice(0, 120));
            delete result.review_note; delete result.review_layer;
          }   // server.js composes this turn's reply (list-reply.js)
        } catch (e) {}
        // NOT-FOUND detection for named products. The search falls back to broad terms and returns
        // SOMETHING, so found:true can mean "unrelated products". A query naming a producer counts as
        // found only if a result carries that producer's first two distinctive words; otherwise the
        // unrelated results are dropped (never presented as the product) and the original is kept on
        // the session, so "show me alternatives" can anchor to it (ALTERNATIVES ROUTING above).
        if (result.success && saInput.intent === 'product_query' && Array.isArray(result.results)) {
          const GENERICW = /^(the|and|of|de|du|la|le|wine|wines|red|white|rose|rosé|sparkling|vineyard|vineyards|valley|estate|reserve|bottle|bottles|ml|l|oz|pack|case|chardonnay|cabernet|sauvignon|blanc|pinot|noir|grigio|gris|merlot|malbec|zinfandel|syrah|shiraz|riesling|champagne|prosecco|brut|vodka|gin|rum|tequila|whiskey|whisky|bourbon|scotch|beer|lager|ipa|seltzer|blanco|reposado|anejo|añejo|high|higher|end|top|shelf|premium|luxury|upscale|fancy|nice|good|best|great|cheap|budget|affordable|mid|quality|expensive|smooth|popular|regular|standard|classic|something|some|any|brewing|brewery|breweries|brewers|brewer|company|winery|wineries|cellars|cellar|distillery|distillers|distilling|non|alcoholic|nonalcoholic)$/i;   // company suffixes too: "Athletic Brewing" was flagged not-found 3x (Oct 1, DC) — the catalog says "Athletic N/A ..."; descriptors are not a producer: "high end whiskey" was flagged not-found (Sep 29) and hijacked every later search
          const normW = x => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9' ]+/g, ' ');
          const notFound = [], checked = [];
          for (const r of result.results) {
            const qname = (r && (r.query || r.name)) || '';
            const words = normW(qname).split(/\s+/).filter(w => w.length >= 3 && !/^\d/.test(w) && !GENERICW.test(w));
            if (!words.length) continue;   // generic query ("Chardonnay", "red wine") — nothing to verify
            checked.push(qname);
            const key = words.slice(0, 2);
            const hit = (r.products || []).some(p => { const pn = ' ' + normW(p.name) + ' '; return key.every(k => pn.includes(' ' + k + ' ') || pn.includes(' ' + k.replace(/'/g, '') + ' ')); });
            if (!hit) {
              try { require('./events.js').unmatched(qname); } catch (e) {}
              console.log('[not-found] ' + JSON.stringify(qname) + ' — no result carries "' + key.join(' ') + '"; dropped ' + (r.products || []).length + ' unrelated result(s): ' + (r.products || []).map(p => p.name).join(' | '));
              r.found = false; r.products = [];
              r.note = 'NOT carried at this store (the search only returned unrelated products). Tell the customer it is not available here; offer alternatives (intent=alternatives) or to alert our team to source it.';
              notFound.push({ name: qname, category: (Array.isArray(saInput.queries) && (saInput.queries.find(q => q && (q.name === qname || q.term === qname)) || {}).category) || 'wine' });
            }
          }
          if (sessionState && checked.length) {
            sessionState.lastNotFound = notFound.length ? { items: notFound, at: Date.now() } : null;
          }
        }
        if (result.success && result.line_items && ['menu_build','custom_list'].includes(saInput.intent) && onPackageBuilt) {
          onPackageBuilt(saInput.email || '', result.line_items, saInput.channel, saInput, result);
        }
        // The full-bar note is appended to the reply in code (server.js replyNote). Real bug (Sep 28):
        // the model also read it here and wrote its own "heads-up" paragraph, so the customer got the
        // same trim offer twice. The model no longer sees it.
        if (result.full_bar_note) { console.log('[tool] full_bar_note withheld from the model — appended in code'); delete result.full_bar_note; }
        // Track unavailable items via the tool's own structured field, not by
        // trying to parse the LLM's eventual free-text reply — this is what lets
        // a later deterministic "yes, find a substitute" handler in server.js
        // fire a real search for the RIGHT item, instead of the LLM guessing
        // from conversation memory and confusing it with an unrelated item
        // discussed earlier (a real bug this was built to fix).
        if (result.success && onUnavailableItems && ['menu_build','custom_list','product_query'].includes(saInput.intent)) {
          onUnavailableItems(result.unavailable || '', result.unavailable_qty || '');
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
        if (result.success && onProductDiscussed && ['product_query','recommendation','alternatives'].includes(saInput.intent)) {
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
            // Grouped by query label ("Prosecco", "Sauvignon Blanc") for options listed in a later proposal PDF.
            onProductDiscussed(saInput.email || '', JSON.stringify(asLineItems), saInput.channel, require('./proposal-options.js').groupsFromResult(saInput.queries, result));
          }
        }
        if (result.success && result.download_url && saInput.intent === 'generate_proposal' && sessionState) {
          // The next proposal (in code) reuses what this PDF was billed to and dated.
          if (saInput.client_name) sessionState.savedClientName = saInput.client_name;
          if (result.event_date || saInput.event_date) sessionState.savedEventDate = result.event_date || saInput.event_date;
        }
        if (result.success && result.download_url && saInput.intent === 'generate_proposal' && onProposalGenerated) {
          onProposalGenerated(result.download_url);
        }
        // The order outcome is decided HERE from the API result — never from the LLM's
        // wording. Only a real success (Bevvi created the order / issued a payment link)
        // moves the basket out of the active cart; a failure leaves it for a retry.
        if (result.success && saInput.intent === 'place_order' && onOrderPlaced) {
          onOrderPlaced(result, saInput.line_items || currentLineItems || '[]');
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

// ─── RACHEL CHAT ──────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 10;

async function rachelChat({ messages, context, rachelPrompt, gbrain_context = '', channel_format = 'voiceflow', address_rule = '', onPackageBuilt = null, onProposalGenerated = null, sendEmailFn = null, lastProposalUrl = '', customerMessage = '', alreadyConfirmed = false, onUnavailableItems = null, onProductDiscussed = null, onSubstituteConfirmed = null, currentLineItems = '', onShowBasket = null, eventParams = null, onUpdateQuantity = null, onOrderPlaced = null, sessionState = null }) {
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
  // context.order_change_note (set by server.js for this turn) was never injected anywhere —
  // the "changed at confirm" instruction was silently dropped. It now reaches the model.
  const orderNote = context && context.order_change_note ? '\n\n## THIS TURN\n' + context.order_change_note : '';
  const fullSystem = address_rule + (gbrain_context
    ? systemPrompt + '\n\n## CUSTOMER CONTEXT FROM MEMORY\n' + gbrain_context + channelNote
    : systemPrompt + channelNote) + orderNote;

  let claudeMessages = [...messages];
  // Everything the customer has said this conversation (tool guards check stated facts against it, e.g. event hours).
  const customerSaid = messages.filter(mm => mm.role === 'user').map(mm => typeof mm.content === 'string' ? mm.content : (Array.isArray(mm.content) ? mm.content.filter(c => c && c.type === 'text').map(c => c.text).join(' ') : '')).join('\n');
  let finalResponse = '';
  let proposalUrlThisTurn = '';
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
          const result = await executeTool(block.name, block.input, onPackageBuilt, channel_format, onProposalGenerated, customerMessage, alreadyConfirmed, context.user_email || '', sendEmailFn, lastProposalUrl, onUnavailableItems, onProductDiscussed, onSubstituteConfirmed, currentLineItems, onShowBasket, eventParams, onUpdateQuantity, onOrderPlaced, sessionState, customerSaid);
          if (result && result.success && result.download_url && block.input && block.input.intent === 'generate_proposal') proposalUrlThisTurn = result.download_url;
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

  // A proposal generated this turn is always linked with its REAL URL. Real bug (Sep 30, DC, Slack): the reply said
  // "<url|Download proposal>" — the LLM wrote a placeholder, so there was no link at all.
  if (proposalUrlThisTurn && !finalResponse.includes(proposalUrlThisTurn)) {
    const link = channel_format === 'slack' ? '<' + proposalUrlThisTurn + '|Download proposal>' : proposalUrlThisTurn;
    const fixed = finalResponse.replace(/<(?!https?:)[^<>|\s]*\|([^>]*)>/g, '<' + proposalUrlThisTurn + '|$1>').replace(/\((?!https?:)[^()\s]*\)/g, m => /url|link/i.test(m) ? '(' + proposalUrlThisTurn + ')' : m);
    finalResponse = fixed.includes(proposalUrlThisTurn) ? fixed : link + '\n\n' + finalResponse;
    console.log('[proposal] reply had no real link to the PDF — ' + (fixed.includes(proposalUrlThisTurn) ? 'placeholder replaced' : 'link added') + ': ' + proposalUrlThisTurn);
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
