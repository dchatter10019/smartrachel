/**
 * Rachel MCP Server (port 3600)
 * Exposes Rachel as an MCP tool for Claude Desktop, agents, and other MCP clients
 */

const http = require('http');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const PORT = 3600;
const RACHEL_URL = 'http://127.0.0.1:3500';

const TOOLS = [
  {
    name: 'rachel_verify_age',
    description: 'Verify that a customer is 21 or older. MUST be called before any other rachel tool. Returns verified:true if age is confirmed and saved to GBrain.',
    inputSchema: {
      type: 'object',
      properties: {
        email:     { type: 'string', description: 'Customer email' },
        confirmed: { type: 'boolean', description: 'Set to true if customer has confirmed they are 21 or older' }
      },
      required: ['email', 'confirmed']
    }
  },
  {
    name: 'rachel_chat',
    description: 'Send a message to Rachel, Bevvi\'s AI beverage specialist. Rachel can search for products, build event packages, make personalized recommendations, and place orders. Always pass customer email and zip code for personalized results.',
    inputSchema: {
      type: 'object',
      properties: {
        message:    { type: 'string', description: 'Customer message to Rachel' },
        email:      { type: 'string', description: 'Customer email for personalization and order placement' },
        zip:        { type: 'string', description: 'Delivery zip code' },
        session_id: { type: 'string', description: 'Session ID for conversation continuity (optional)' },
        channel:    { type: 'string', description: 'Channel: slack, html, webchat, plain (default: plain)' }
      },
      required: ['message']
    }
  },
  {
    name: 'rachel_search',
    description: 'Search for specific beverage products available for delivery to a zip code.',
    inputSchema: {
      type: 'object',
      properties: {
        products: { type: 'array', description: 'Array of product names to search for', items: { type: 'string' } },
        zip:      { type: 'string', description: 'Delivery zip code' },
        email:    { type: 'string', description: 'Customer email for personalization' }
      },
      required: ['products', 'zip']
    }
  },
  {
    name: 'rachel_build_package',
    description: 'Build a beverage package for an event. Returns product list with quantities, prices, and totals.',
    inputSchema: {
      type: 'object',
      properties: {
        guests:     { type: 'number', description: 'Number of guests' },
        hours:      { type: 'number', description: 'Event duration in hours' },
        budget:     { type: 'number', description: 'Total budget in USD' },
        categories: { type: 'array', description: 'Categories: beer, wine, spirits, champagne', items: { type: 'string' } },
        zip:        { type: 'string', description: 'Delivery zip code' },
        email:      { type: 'string', description: 'Customer email' }
      },
      required: ['guests', 'hours', 'zip']
    }
  },
  {
    name: 'rachel_recommend',
    description: 'Get personalized beverage recommendations based on customer purchase history.',
    inputSchema: {
      type: 'object',
      properties: {
        occasion: { type: 'string', description: 'Occasion or context (e.g. steak dinner, wedding, birthday)' },
        category: { type: 'string', description: 'Category: wine, beer, spirits, champagne' },
        zip:      { type: 'string', description: 'Delivery zip code' },
        email:    { type: 'string', description: 'Customer email for personalization' },
        budget:   { type: 'number', description: 'Budget per bottle' }
      },
      required: ['zip']
    }
  },
  {
    name: 'rachel_place_order',
    description: 'Place a beverage order for a customer. Requires confirmed line_items from a previous search or package build.',
    inputSchema: {
      type: 'object',
      properties: {
        line_items:           { type: 'string', description: 'JSON string of line_items from previous rachel_search or rachel_build_package' },
        first_name:           { type: 'string' },
        last_name:            { type: 'string' },
        email:                { type: 'string' },
        phone:                { type: 'string' },
        address:              { type: 'string', description: 'Full delivery address' },
        city:                 { type: 'string' },
        state:                { type: 'string' },
        zip:                  { type: 'string' },
        delivery_datetime:    { type: 'string', description: 'ISO datetime for delivery' },
        delivery_instructions:{ type: 'string' },
        tip_amount:           { type: 'number' }
      },
      required: ['line_items', 'email', 'address', 'zip']
    }
  },
  {
    name: 'rachel_generate_proposal',
    description: 'Generate a PDF proposal from an active basket/package. Returns a download URL for the PDF.',
    inputSchema: {
      type: 'object',
      properties: {
        email:       { type: 'string', description: 'Customer email' },
        client_name: { type: 'string', description: 'Client/company name for the proposal' },
        event_date:  { type: 'string', description: 'Event date e.g. 2026-07-20' },
        line_items:  { type: 'string', description: 'JSON string of line_items (optional — uses active session if not provided)' },
        notes:       { type: 'string', description: 'Any additional notes to include' }
      },
      required: ['email', 'client_name']
    }
  },
  {
    name: 'rachel_get_session',
    description: 'Get the current active basket/package for a customer session.',
    inputSchema: {
      type: 'object',
      properties: {
        email:   { type: 'string', description: 'Customer email' },
        channel: { type: 'string', description: 'Channel: slack, html, webchat (default: slack)' }
      },
      required: ['email']
    }
  }
];

async function callRachel(message, email, zip, session_id, channel) {
  const res = await fetch(`${RACHEL_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      session_id: session_id || `mcp-${email || 'anon'}-${Date.now()}`,
      format: channel || 'plain',
      context: {
        kitchen_location: '',
        client_id: 'airculinaire',
        account_id: '',
        user_email: email || ''
      }
    })
  });
  const data = await res.json();
  return data.text || data.response || '';
}

async function callShoppingAgent(intent, args) {
  const res = await fetch('http://127.0.0.1:8300/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: intent, arguments: args }
    })
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data:'));
  if (!line) throw new Error('No response from Shopping Agent');
  const data = JSON.parse(line.replace('data:', '').trim());
  return JSON.parse(data.result.content[0].text);
}

async function checkAgeVerified(email) {
  if (!email) return false;
  try {
    const { getD2CSession } = require('./gbrain.js');
    const session = await getD2CSession(email);
    return session && session.age_verified === true;
  } catch(e) { return false; }
}

async function executeTool(name, input) {
  console.log(`[rachel-mcp] tool: ${name}`, JSON.stringify(input).slice(0, 150));

  // Age verification tool
  if (name === 'rachel_verify_age') {
    if (!input.confirmed) {
      return { verified: false, message: 'Customer must confirm they are 21 or older to proceed.' };
    }
    try {
      const { getD2CSession, saveD2CSession } = require('./gbrain.js');
      const existing = await getD2CSession(input.email) || {};
      await saveD2CSession(input.email, { ...existing, age_verified: true });
      return { verified: true, message: 'Age verified. Customer is confirmed 21 or older.' };
    } catch(e) {
      return { verified: false, error: e.message };
    }
  }

  // Gate all other tools behind age verification
  const unprotected = ['rachel_verify_age'];
  if (!unprotected.includes(name)) {
    const email = input.email || (input.customer && input.customer.email) || '';
    if (!email) {
      return { error: 'Email is required. Please provide customer email.' };
    }
    const ageVerified = await checkAgeVerified(email);
    if (!ageVerified) {
      return { 
        error: 'Age not verified. Call rachel_verify_age first to confirm the customer is 21 or older.',
        action_required: 'Call rachel_verify_age with confirmed:true after customer confirms age'
      };
    }
  }

  if (name === 'rachel_chat') {
    const response = await callRachel(
      input.message, input.email, input.zip,
      input.session_id, input.channel
    );
    return { response, session_id: input.session_id || `mcp-${input.email || 'anon'}` };
  }

  if (name === 'rachel_search') {
    const queries = input.products.map(p => ({ name: p, limit: 3 }));
    const result = await callShoppingAgent('product_query', {
      queries, zip: input.zip, email: input.email || ''
    });
    // Remove internal fields
    delete result.kitchen;
    delete result.client;
    if (result.results) {
      result.results.forEach(function(r) {
        r.products && r.products.forEach(function(p) {
          delete p.establishmentId;
          delete p.product_id;
        });
      });
    }
    return result;
  }

  if (name === 'rachel_build_package') {
    const result = await callShoppingAgent('custom_list', {
      named_products: (input.categories || ['beer', 'wine', 'spirits']).map(c => ({ name: c, category: c })),
      guests: input.guests,
      hours: input.hours,
      budget: input.budget || 999999,
      zip: input.zip,
      email: input.email || ''
    });
    return result;
  }

  if (name === 'rachel_recommend') {
    const result = await callShoppingAgent('recommendation', {
      occasion: input.occasion || '',
      category: input.category || 'wine',
      zip: input.zip,
      email: input.email || '',
      budget_per_bottle: input.budget || null
    });
    return result;
  }

  if (name === 'rachel_place_order') {
    const result = await callShoppingAgent('place_order', {
      line_items: input.line_items,
      zip: input.zip,
      customer: {
        firstName: input.first_name || '',
        lastName:  input.last_name  || '',
        email:     input.email      || '',
        phone:     input.phone      || '',
        address:   input.address    || '',
        city:      input.city       || '',
        state:     input.state      || '',
        zipcode:   input.zip        || ''
      },
      tip_amount:            input.tip_amount || 0,
      delivery_datetime:     input.delivery_datetime || '',
      delivery_instructions: input.delivery_instructions || ''
    });
    return result;
  }

  if (name === 'rachel_generate_proposal') {
    const ageVerified = await checkAgeVerified(input.email);
    if (!ageVerified) return { error: 'Age not verified. Call rachel_verify_age first.' };

    // Get line_items from input or active session
    let lineItems = input.line_items;
    if (!lineItems) {
      const { getPackage } = require('./gbrain.js');
      lineItems = await getPackage(input.email, 'slack');
    }
    if (!lineItems) return { error: 'No active package found. Build a package first.' };

    // Generate PDF
    const { generateProposal } = require('./generate-proposal.js');
    const timestamp = Date.now();
    const filename = `bevvi-proposal-${timestamp}.pdf`;
    const outputPath = `/home/ubuntu/logs/${filename}`;
    await generateProposal({
      client_name: input.client_name,
      event_date: input.event_date || '',
      line_items: lineItems,
      notes: input.notes || ''
    }, outputPath);

    return {
      success: true,
      filename,
      download_url: `http://3.138.180.46/proposals/${filename}`,
      message: `Proposal generated for ${input.client_name}`
    };
  }

  if (name === 'rachel_get_session') {
    const { getPackage } = require('./gbrain.js');
    const pkg = await getPackage(input.email, input.channel || 'slack');
    return { email: input.email, active_package: pkg || null, has_package: !!pkg };
  }

  return { error: `Unknown tool: ${name}` };
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PORT, service: 'rachel-mcp', tools: TOOLS.length }));
    return;
  }

  // JSON endpoint for Voiceflow and other REST clients
  if (req.method === 'POST' && req.url === '/api') {
    const auth = req.headers['authorization'] || '';
    if (auth !== 'Bearer rachel_mcp_bevvi_2026') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { tool, args } = JSON.parse(body);
        const result = await executeTool(tool, args || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/mcp') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const msg = JSON.parse(body);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        if (msg.method === 'initialize') {
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'bevvi-rachel', version: '1.0.0' },
            capabilities: { tools: {} }
          }});
        } else if (msg.method === 'tools/list') {
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
        } else if (msg.method === 'tools/call') {
          const { name, arguments: args } = msg.params;
          const result = await executeTool(name, args || {});
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, result: {
            content: [{ type: 'text', text: JSON.stringify(result) }]
          }});
        } else {
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
        }
        res.end();
      } catch(e) {
        console.error('[rachel-mcp] error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[rachel-mcp] Rachel MCP Server on http://0.0.0.0:${PORT}`);
  console.log(`[rachel-mcp] Tools: ${TOOLS.map(t => t.name).join(', ')}`);
});
