/**
 * Bevvi Generic Store Agent — MCP Server
 * One instance per retailer, configured via environment variables
 */

const http = require('http');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const STORE_NAME      = process.env.STORE_NAME      || 'Generic Store';
const KITCHEN_LOCATION = process.env.KITCHEN_LOCATION || '';
const CLIENT_NAME     = process.env.CLIENT_NAME     || 'airculinaire';
const PORT            = parseInt(process.env.PORT)  || 8101;
const DELIVERY_ZIPS   = (process.env.DELIVERY_ZIPS || '').split(',').map(z => z.trim()).filter(Boolean);

console.log(`[store-agent] ${STORE_NAME} starting on port ${PORT}`);
console.log(`[store-agent] Kitchen: ${KITCHEN_LOCATION} | Client: ${CLIENT_NAME}`);
console.log(`[store-agent] Delivery zips: ${DELIVERY_ZIPS.join(', ') || 'ALL'}`);

// ── MCP Tools ─────────────────────────────────────────────────────────────────

const TOOLS = {
  get_store_info: {
    description: 'Get information about this store including name, location, and delivery zones',
    inputSchema: { type: 'object', properties: {} }
  },
  search_products: {
    description: 'Search for products available at this store',
    inputSchema: {
      type: 'object',
      properties: {
        query:     { type: 'string',  description: 'Product search term' },
        category:  { type: 'string',  description: 'Product category (wine/beer/spirits)' },
        min_price: { type: 'number',  description: 'Minimum price' },
        max_price: { type: 'number',  description: 'Maximum price' },
        limit:     { type: 'integer', description: 'Max results (default 10)' }
      },
      required: ['query']
    }
  },
  submit_bid: {
    description: 'Submit a bid for a basket of products. Returns pricing and availability for each item.',
    inputSchema: {
      type: 'object',
      properties: {
        basket: {
          type: 'array',
          description: 'Array of items to bid on',
          items: {
            type: 'object',
            properties: {
              name:     { type: 'string' },
              category: { type: 'string' },
              quantity: { type: 'integer' },
              max_price:{ type: 'number', description: 'Max price per unit customer will pay' }
            },
            required: ['name', 'quantity']
          }
        },
        delivery_zip: { type: 'string', description: 'Delivery zip code' }
      },
      required: ['basket', 'delivery_zip']
    }
  },
  place_order: {
    description: 'Place an order for a winning bid',
    inputSchema: {
      type: 'object',
      properties: {
        products:     { type: 'array',  description: 'Array of {name, upc, qty}' },
        customer:     { type: 'object', description: 'Customer details' },
        tip_amount:   { type: 'number' },
        delivery_datetime: { type: 'string' },
        delivery_instructions: { type: 'string' }
      },
      required: ['products', 'customer']
    }
  }
};

// ── Tool Implementations ───────────────────────────────────────────────────────

async function searchBevviProducts(query, minPrice, maxPrice, limit) {
  try {
    const url = `https://api.getbevvi.com/api/corpproducts/searchCorpProducts` +
      `?location=${encodeURIComponent(KITCHEN_LOCATION)}` +
      `&searchBy=${encodeURIComponent(query)}` +
      `&limit=${limit || 20}` +
      `&client=${encodeURIComponent(CLIENT_NAME)}`;

    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data
      .filter(p => {
        const price = p.salePrice || p.price || 0;
        if (minPrice && price < minPrice) return false;
        if (maxPrice && price > maxPrice) return false;
        return price > 0 && p.name;
      })
      .map(p => ({
        name:       p.name,
        upc:        p.upc || '',
        price:      p.salePrice || p.price || 0,
        size:       p.size && p.units ? `${p.size}${p.units}` : '',
        url:        p.url || (p.slug ? `https://airculinaire.getbevvi.com/productdetail/${p.slug}` : ''),
        product_id: (p.corpProductFilter && p.corpProductFilter.corpProductId) || p.id || '',
        category:   p.category || '',
        in_stock:   true
      }));
  } catch(e) {
    console.error('[store-agent] search error:', e.message);
    return [];
  }
}

async function executeTool(name, input) {
  if (name === 'get_store_info') {
    return {
      store_name:       STORE_NAME,
      kitchen_location: KITCHEN_LOCATION,
      client_name:      CLIENT_NAME,
      delivery_zips:    DELIVERY_ZIPS,
      port:             PORT,
      status:           'active'
    };
  }

  if (name === 'search_products') {
    const products = await searchBevviProducts(
      input.query, input.min_price, input.max_price, input.limit || 10
    );
    return {
      store:        STORE_NAME,
      query:        input.query,
      found:        products.length > 0,
      result_count: products.length,
      products
    };
  }

  if (name === 'submit_bid') {
    const { basket, delivery_zip } = input;

    // Check if we serve this zip
    if (DELIVERY_ZIPS.length > 0 && !DELIVERY_ZIPS.includes(delivery_zip)) {
      return {
        store:        STORE_NAME,
        can_fulfill:  false,
        reason:       `We don't deliver to zip ${delivery_zip}`,
        bid_items:    [],
        bid_total:    0,
        coverage_pct: 0
      };
    }

    // Search for each basket item
    const bidItems = [];
    let bidTotal = 0;
    let fulfilled = 0;

    for (const item of basket) {
      const results = await searchBevviProducts(item.name, 0, item.max_price || 999999, 5);
      if (results.length > 0) {
        const best = results[0];
        const lineTotal = best.price * item.quantity;
        bidItems.push({
          requested:    item.name,
          matched:      best.name,
          upc:          best.upc,
          unit_price:   best.price,
          quantity:     item.quantity,
          line_total:   lineTotal,
          size:         best.size,
          url:          best.url,
          product_id:   best.product_id,
          available:    true
        });
        bidTotal += lineTotal;
        fulfilled++;
      } else {
        bidItems.push({
          requested:    item.name,
          matched:      null,
          available:    false,
          quantity:     item.quantity
        });
      }
    }

    const coveragePct = Math.round((fulfilled / basket.length) * 100);

    return {
      store:        STORE_NAME,
      kitchen_location: KITCHEN_LOCATION,
      can_fulfill:  fulfilled > 0,
      coverage_pct: coveragePct,
      items_found:  fulfilled,
      items_total:  basket.length,
      bid_items:    bidItems,
      bid_total:    Math.round(bidTotal * 100) / 100,
      estimated_tax:     Math.round(bidTotal * 0.10 * 100) / 100,
      estimated_service: Math.round(bidTotal * 0.10 * 100) / 100,
      estimated_tip:     Math.round(bidTotal * 0.05 * 100) / 100,
      delivery_fee:      25.00,
      estimated_grand_total: Math.round((bidTotal * 1.25 + 25) * 100) / 100
    };
  }

  if (name === 'place_order') {
    const { products, customer, tip_amount, delivery_datetime, delivery_instructions } = input;
    try {
      // Parse address string into components if city/state not provided
      let streetAddress = customer.address || '';
      let city = customer.city || '';
      let state = customer.state || '';
      let zipcode = customer.zipcode || '';
      if (streetAddress && !city) {
        const parts = streetAddress.split(',').map(s => s.trim());
        if (parts.length >= 4) {
          // "11 Madison Ave, New York, NY 10010" or "11 Madison Ave, NY, NY 10010"
          streetAddress = parts[0];
          city = parts[1];
          const stateZip = parts[2].trim().split(' ');
          state = stateZip[0] || '';
          zipcode = stateZip[1] || parts[3] || zipcode;
        } else if (parts.length === 3) {
          streetAddress = parts[0];
          city = parts[1];
          const stateZip = parts[2].trim().split(' ');
          state = stateZip[0] || '';
          zipcode = stateZip[1] || zipcode;
          // If city looks like a state abbreviation (2 chars), it might be "Street, NY, NY 10010"
          if (city.length === 2 && city === city.toUpperCase()) {
            state = city;
            city = '';
          }
        } else if (parts.length === 2) {
          streetAddress = parts[0];
          city = parts[1];
        }
      }

      const body = {
        products: products.map(p => ({ name: p.name, upc: p.upc, qty: p.qty || 1 })),
        customerData: {
          firstName:     customer.firstName || '',
          lastName:      customer.lastName  || '',
          email:         customer.email     || '',
          address:       streetAddress,
          suiteNumber:   '',
          streetAddress: streetAddress,
          city:          city,
          state:         state,
          zipcode:       zipcode,
          phoneNumber:   (customer.phone || customer.phoneNumber || '').replace(/\D/g, ''),
          companyName:   ''
        },
        tipAmount:            tip_amount || 0,
        deliveryDateTime:     delivery_datetime || '',
        deliveryInstructions: delivery_instructions || ''
      };

      const res = await fetch('https://api.getbevvi.com/api/bevvibot/createOrder', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body)
      });

      const data = await res.json();
      const arr  = Array.isArray(data) ? data[0] : data;
      const orderId    = arr.orderNumber || arr.order_id || '';
      const paymentUrl = arr.orderLink   || arr.payment_url || '';
      const success    = arr.success === true || arr.success === 'true';

      return { success, order_id: orderId, payment_url: paymentUrl, error: success ? '' : (arr.message || 'Order failed') };
    } catch(e) {
      return { success: false, order_id: '', payment_url: '', error: e.message };
    }
  }

  return { error: `Unknown tool: ${name}` };
}

// ── MCP HTTP Server ────────────────────────────────────────────────────────────

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', store: STORE_NAME, port: PORT }));
    return;
  }

  if (req.method === 'POST' && req.url === '/mcp') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const msg = JSON.parse(body);
        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive'
        });

        if (msg.method === 'initialize') {
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: `store-agent-${STORE_NAME.toLowerCase().replace(/\s+/g, '-')}`, version: '1.0.0' },
            capabilities: { tools: {} }
          }});
        } else if (msg.method === 'tools/list') {
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, result: {
            tools: Object.entries(TOOLS).map(([name, def]) => ({ name, ...def }))
          }});
        } else if (msg.method === 'tools/call') {
          const { name, arguments: args } = msg.params;
          console.log(`[store-agent] tool: ${name}`, JSON.stringify(args).slice(0, 100));
          const result = await executeTool(name, args || {});
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, result: {
            content: [{ type: 'text', text: JSON.stringify(result) }]
          }});
        } else {
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
        }

        res.end();
      } catch(e) {
        console.error('[store-agent] error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[store-agent] ${STORE_NAME} listening on http://127.0.0.1:${PORT}`);
});
