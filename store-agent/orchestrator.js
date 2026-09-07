/**
 * Bevvi Orchestrator — broadcasts RFQ to all store agents serving a zip code
 * and returns the winning bid (best coverage, then best price)
 */

const http = require('http');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const PORT = parseInt(process.env.PORT) || 8200;

// ── Store Registry ─────────────────────────────────────────────────────────────
// Maps store name → { url, zips }
const STORE_REGISTRY = [
  {
    name: 'LiquorMaster NJ',
    url:  'http://127.0.0.1:8102',
    zips: ['07608','07631','07652','07666','07670','07024','07010','07026','07047']
  },
  {
    name: 'Manor - NYC',
    url:  'http://127.0.0.1:8101',
    // Full Manhattan (10001–10282) + Bronx (10451–10475). Verified: Bevvi's
    // ?zipcode= lookup returns products for Bronx zips (e.g. 10451), so the only
    // thing blocking those addresses was this partial local list. The API remains
    // the source of truth for fulfillment; this registry only routes the RFQ.
    zips: ['10001','10002','10003','10004','10005','10006','10007','10008','10009','10010','10011','10012',
           '10013','10014','10015','10016','10017','10018','10019','10020','10021','10022','10023','10024',
           '10025','10026','10027','10028','10029','10030','10031','10032','10033','10034','10035','10036',
           '10037','10038','10039','10040','10041','10042','10043','10044','10045','10046','10047','10048',
           '10049','10050','10051','10052','10053','10054','10055','10056','10057','10058','10059','10060',
           '10061','10062','10063','10064','10065','10066','10067','10068','10069','10070','10071','10072',
           '10073','10074','10075','10076','10077','10078','10079','10080','10081','10082','10083','10084',
           '10085','10086','10087','10088','10089','10090','10091','10092','10093','10094','10095','10096',
           '10097','10098','10099','10100','10101','10102','10103','10104','10105','10106','10107','10108',
           '10109','10110','10111','10112','10113','10114','10115','10116','10117','10118','10119','10120',
           '10121','10122','10123','10124','10125','10126','10127','10128','10129','10130','10131','10132',
           '10133','10134','10135','10136','10137','10138','10139','10140','10141','10142','10143','10144',
           '10145','10146','10147','10148','10149','10150','10151','10152','10153','10154','10155','10156',
           '10157','10158','10159','10160','10161','10162','10163','10164','10165','10166','10167','10168',
           '10169','10170','10171','10172','10173','10174','10175','10176','10177','10178','10179','10180',
           '10181','10182','10183','10184','10185','10186','10187','10188','10189','10190','10191','10192',
           '10193','10194','10195','10196','10197','10198','10199','10200','10201','10202','10203','10204',
           '10205','10206','10207','10208','10209','10210','10211','10212','10213','10214','10215','10216',
           '10217','10218','10219','10220','10221','10222','10223','10224','10225','10226','10227','10228',
           '10229','10230','10231','10232','10233','10234','10235','10236','10237','10238','10239','10240',
           '10241','10242','10243','10244','10245','10246','10247','10248','10249','10250','10251','10252',
           '10253','10254','10255','10256','10257','10258','10259','10260','10261','10262','10263','10264',
           '10265','10266','10267','10268','10269','10270','10271','10272','10273','10274','10275','10276',
           '10277','10278','10279','10280','10281','10282','10451','10452','10453','10454','10455','10456',
           '10457','10458','10459','10460','10461','10462','10463','10464','10465','10466','10467','10468',
           '10469','10470','10471','10472','10473','10474','10475']
  },
  {
    name: "Sam's Liquor & Market",
    url:  'http://127.0.0.1:8106',
    zips: ['85250','85251','85252','85253','85254','85255','85256','85257','85258','85259','85260','85261','85262','85266','85267','85268','85269','85271']
  },
  {
    name: 'Aficionados',
    url:  'http://127.0.0.1:8105',
    zips: ['33101','33109','33125','33126','33127','33128','33129','33130','33131','33132',
           '33133','33134','33135','33136','33137','33138','33139','33140','33141','33142',
           '33143','33144','33145','33146','33147','33149','33150','33154','33155','33156',
           '33157','33158','33160','33161','33162','33165','33166','33167','33168','33169',
           '33170','33172','33173','33174','33175','33176','33177','33178','33179','33180',
           '33181','33182','33183','33184','33185','33186','33187','33189','33190','33193',
           '33194','33196','33199','33222','33231','33233','33234','33238','33239','33242',
           '33245','33255','33256','33257','33261','33265','33266','33269','33280','33283',
           '33296','33299']
  },
  {
    name: 'Dallas Fine Wine',
    url:  'http://127.0.0.1:8103',
    zips: ['75201','75202','75203','75204','75205','75206','75207','75208','75209','75210']
  },
  {
    name: 'Mavy, Boston',
    url:  'http://127.0.0.1:8104',
    zips: ['01730','01731','01741','01742','01760','01770','01773','01776','01778','01801','01803','01805','01813','01815','01821','01822','01825','01862','01864','01865','01866','01867','01876','01880','01887','01888','01889','01890','01901','01902','01903','01904','01905','01906','01907','01908','01910','01915','01923','01937','01940','01945','01949','01960','01965','01970','01982','01983','01984','02018','02021','02025','02026','02027','02030','02032','02040','02043','02044','02045','02052','02055','02060','02061','02062','02066','02067','02072','02081','02090','02108','02109','02110','02111','02112','02113','02114','02115','02116','02117','02118','02119','02120','02121','02122','02123','02124','02125','02126','02127','02128','02129','02130','02131','02132','02133','02134','02135','02136','02137','02138','02139','02140','02141','02142','02143','02144','02145','02148','02149','02150','02151','02152','02153','02155','02156','02163','02169','02170','02171','02176','02180','02184','02185','02186','02187','02188','02189','02190','02191','02196','02199','02201','02203','02204','02205','02206','02210','02211','02212','02215','02217','02222','02238','02241','02266','02269','02283','02284','02293','02297','02298','02302','02303','02304','02305','02322','02339','02343','02351','02368','02370','02420','02421','02445','02446','02447','02451','02452','02453','02454','02455','02457','02458','02459','02460','02461','02462','02464','02465','02466','02467','02468','02471','02472','02474','02475','02476','02477','02478','02479','02481','02482','02492','02493','02494','02495']
  },
  // Add more stores here as they come online
];

// ── MCP Tools ──────────────────────────────────────────────────────────────────
const TOOLS = {
  get_stores_for_zip: {
    description: 'Get all store agents that serve a given delivery zip code',
    inputSchema: {
      type: 'object',
      properties: {
        zip: { type: 'string', description: '5-digit delivery zip code' }
      },
      required: ['zip']
    }
  },
  broadcast_rfq: {
    description: 'Broadcast a basket RFQ to all stores serving the delivery zip in parallel. Returns all bids ranked by coverage then price.',
    inputSchema: {
      type: 'object',
      properties: {
        delivery_zip: { type: 'string', description: '5-digit delivery zip code' },
        basket: {
          type: 'array',
          description: 'Items to quote',
          items: {
            type: 'object',
            properties: {
              name:      { type: 'string' },
              category:  { type: 'string' },
              quantity:  { type: 'integer' },
              max_price: { type: 'number' }
            },
            required: ['name', 'quantity']
          }
        }
      },
      required: ['delivery_zip', 'basket']
    }
  },
  place_winning_order: {
    description: 'Place order with the winning store agent',
    inputSchema: {
      type: 'object',
      properties: {
        store_url:   { type: 'string', description: 'URL of the winning store agent' },
        products:    { type: 'array',  description: 'Array of {name, upc, qty}' },
        customer:    { type: 'object', description: 'Customer details' },
        tip_amount:  { type: 'number' },
        delivery_datetime:     { type: 'string' },
        delivery_instructions: { type: 'string' }
      },
      required: ['store_url', 'products', 'customer']
    }
  }
};

// ── Helper: call a store agent tool ───────────────────────────────────────────
async function callStoreAgent(storeUrl, toolName, args) {
  try {
    const res = await fetch(`${storeUrl}/mcp`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args }
      }),
      timeout: 10000
    });
    const text = await res.text();
    console.log('[orchestrator] callStoreAgent', toolName, 'response:', text.slice(0,200));
    const line = text.split('\n').find(l => l.startsWith('data:'));
    if (!line) return null;
    const msg = JSON.parse(line.replace('data:', '').trim());
    return JSON.parse(msg.result.content[0].text);
  } catch(e) {
    console.error(`[orchestrator] ${storeUrl} error:`, e.message);
    return null;
  }
}

// ── Tool Implementations ───────────────────────────────────────────────────────
async function executeTool(name, input) {
  if (name === 'get_stores_for_zip') {
    const { zip } = input;
    const stores = STORE_REGISTRY.filter(s =>
      s.zips.length === 0 || s.zips.includes(zip)
    );
    return {
      zip,
      store_count: stores.length,
      stores: stores.map(s => ({ name: s.name, url: s.url }))
    };
  }

  if (name === 'broadcast_rfq') {
    const { delivery_zip, basket } = input;

    // Find stores serving this zip
    const stores = STORE_REGISTRY.filter(s =>
      s.zips.length === 0 || s.zips.includes(delivery_zip)
    );

    if (stores.length === 0) {
      return {
        success: false,
        error: `No stores found serving zip ${delivery_zip}`,
        bids: [],
        winner: null
      };
    }

    console.log(`[orchestrator] Broadcasting RFQ to ${stores.length} stores for zip ${delivery_zip}`);

    // Broadcast in parallel
    const bidPromises = stores.map(store =>
      callStoreAgent(store.url, 'submit_bid', { basket, delivery_zip })
        .then(bid => bid ? { ...bid, store_url: store.url } : null)
    );

    const rawBids = await Promise.all(bidPromises);
    let bids = rawBids.filter(b => b !== null && b.can_fulfill);

    if (bids.length === 0) {
      return {
        success: false,
        error: 'No stores can fulfill this basket',
        bids: rawBids,
        winner: null
      };
    }

    // ── Re-query pass: don't trust a single search_products call's "not available" ──
    // For items the store agent couldn't confidently match, strip pack-size/ABV/can
    // suffixes and try again against that same store before accepting it as missing.
    function loosenQuery(name) {
      return (name || '')
        .replace(/\b\d+(\.\d+)?\s*%\s*ABV\b/gi, '')
        .replace(/\b\d+\s*x\s*\d+(\.\d+)?\s*OZ\b/gi, '')
        .replace(/\b\d+\s*(pk|pack)\b/gi, '')
        .replace(/\b\d+(\.\d+)?\s*(OZ|ML|L)\b/gi, '')
        .replace(/\b(can|bottle|cans|bottles)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    await Promise.all(bids.map(async (bid) => {
      if (!bid.bid_items) return;
      for (let i = 0; i < bid.bid_items.length; i++) {
        const item = bid.bid_items[i];
        if (item.available) continue;
        const loosened = loosenQuery(item.requested);
        if (!loosened || loosened.toLowerCase() === (item.requested || '').toLowerCase()) continue;
        try {
          const reRes = await callStoreAgent(bid.store_url, 'search_products', { query: loosened, limit: 5 });
          const candidates = (reRes && Array.isArray(reRes.products)) ? reRes.products : (Array.isArray(reRes) ? reRes : []);
          if (candidates.length > 0) {
            // Surface the best re-query candidate without silently marking it available —
            // let shopping-agent/Rachel confirm with the customer, since this is a
            // loosened match and may not be exactly what they asked for.
            bid.bid_items[i] = Object.assign({}, item, {
              requeried: true,
              requery_candidate: candidates[0].name,
              requery_upc: candidates[0].upc || '',
              requery_url: candidates[0].url || '',
              requery_product_id: candidates[0].product_id || ''
            });
          }
        } catch (e) {
          console.error('[orchestrator] re-query failed for', item.requested, '—', e.message);
        }
      }
    }));

    // Rank: 1) highest coverage, 2) lowest grand total
    bids.sort((a, b) => {
      if (b.coverage_pct !== a.coverage_pct) return b.coverage_pct - a.coverage_pct;
      return a.estimated_grand_total - b.estimated_grand_total;
    });

    const winner = bids[0];
    console.log(`[orchestrator] Winner: ${winner.store} — coverage ${winner.coverage_pct}% — $${winner.estimated_grand_total}`);

    return {
      success: true,
      stores_queried: stores.length,
      bids_received:  bids.length,
      winner: {
        store:              winner.store,
        store_url:          winner.store_url,
        kitchen_location:   winner.kitchen_location,
        coverage_pct:       winner.coverage_pct,
        bid_items:          winner.bid_items,
        bid_total:          winner.bid_total,
        estimated_tax:      winner.estimated_tax,
        estimated_service:  winner.estimated_service,
        estimated_tip:      winner.estimated_tip,
        delivery_fee:       winner.delivery_fee,
        estimated_grand_total: winner.estimated_grand_total
      },
      all_bids: bids.map(b => ({
        store:        b.store,
        coverage_pct: b.coverage_pct,
        bid_total:    b.bid_total,
        grand_total:  b.estimated_grand_total
      }))
    };
  }

  if (name === 'place_winning_order') {
    const { store_url, products, customer, tip_amount, delivery_datetime, delivery_instructions, account_email } = input;
    const result = await callStoreAgent(store_url, 'place_order', {
      products, customer, tip_amount, delivery_datetime, delivery_instructions, account_email
    });
    return result || { success: false, error: 'Failed to reach store agent' };
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
    res.end(JSON.stringify({ status: 'ok', stores: STORE_REGISTRY.length, port: PORT }));
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
            serverInfo: { name: 'bevvi-orchestrator', version: '1.0.0' },
            capabilities: { tools: {} }
          }});
        } else if (msg.method === 'tools/list') {
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, result: {
            tools: Object.entries(TOOLS).map(([name, def]) => ({ name, ...def }))
          }});
        } else if (msg.method === 'tools/call') {
          const { name, arguments: args } = msg.params;
          console.log(`[orchestrator] tool: ${name}`, JSON.stringify(args).slice(0, 150));
          const result = await executeTool(name, args || {});
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, result: {
            content: [{ type: 'text', text: JSON.stringify(result) }]
          }});
        } else {
          sendSSE(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
        }
        res.end();
      } catch(e) {
        console.error('[orchestrator] error:', e.message);
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
  console.log(`[orchestrator] Bevvi Orchestrator listening on http://127.0.0.1:${PORT}`);
  console.log(`[orchestrator] Registered stores: ${STORE_REGISTRY.map(s => s.name).join(', ')}`);
});
