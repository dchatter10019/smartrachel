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
    name: "ShoppingAgent",
    description: "THE single interface for ALL product and order operations. Use for: product search (do you have X), menu building (event packages), custom lists (named products with qty), recommendations (suggest something), placing orders, and generating proposals. Pass intent + customer context. Never use BuildPackage or CreateOrder directly.\n\nintents:\nintent=\"product_query\" → search for specific products (do you have X, show me X)\nintent=\"recommendation\" → use when customer asks for suggestions (show me some nice tequila, recommend a wine) — uses purchase history\nintent=\"menu_build\" → build standard event package when customer says generic categories\nintent=\"custom_list\" → USE THIS when customer names specific products OR specific spirits (bourbon not just spirits)\nintent=\"place_order\" → place order after customer confirms\nintent=\"generate_proposal\" → generate PDF proposal — call when customer asks for a proposal/PDF/quote",
    input_schema: {
      type: "object",
      properties: {
        intent:    { type: "string", enum: ["product_query","menu_build","custom_list","recommendation","place_order","generate_proposal"] },
        zip:       { type: "string", description: "Delivery zip code" },
        email:     { type: "string", description: "Customer email" },
        queries:   { type: "array",  description: "For product_query: [{name, category, limit}]" },
        guests:    { type: "number", description: "For menu_build/custom_list" },
        hours:     { type: "number", description: "For menu_build/custom_list" },
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
        min_price: { type: "number" },
        max_price:  { type: "number" }
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

async function executeTool(toolName, toolInput, onPackageBuilt) {
  console.log(`[tool] ${toolName}`, JSON.stringify(toolInput).slice(0, 500));
  try {
    switch (toolName) {
      case 'AddToCart':
        return await addToCart(toolInput);

      case 'ShoppingAgent': {
        const saRes = await fetch('http://127.0.0.1:8300/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolInput.intent, arguments: toolInput } })
        });
        const saText = await saRes.text();
        const saLine = saText.split('\n').find(l => l.startsWith('data:'));
        if (!saLine) return { success: false, error: 'No response from shopping agent' };
        const saData = JSON.parse(saLine.replace('data:', '').trim());
        const result = JSON.parse(saData.result.content[0].text);
        console.log('[ShoppingAgent] intent:', toolInput.intent, 'success:', result.success);
        if (result.success && result.line_items && ['menu_build','custom_list'].includes(toolInput.intent) && onPackageBuilt) {
          onPackageBuilt(toolInput.email || '', result.line_items);
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

async function rachelChat({ messages, context, rachelPrompt, gbrain_context = '', channel_format = 'voiceflow', address_rule = '', onPackageBuilt = null }) {
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
          const result = await executeTool(block.name, block.input, onPackageBuilt);
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
