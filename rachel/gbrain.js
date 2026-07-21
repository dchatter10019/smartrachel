/**
 * GBrain MCP client for Rachel
 * Handles customer profile read/write for cross-channel continuity
 */

const GBRAIN_URL = 'http://127.0.0.1:7700';
const GBRAIN_TOKEN = 'gbrain_71d7392edf8a722d8816739407f1455d13fff00a0c7b12e3afa208b4d081ebf4';
const GBRAIN_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${GBRAIN_TOKEN}`,
  'Accept': 'application/json, text/event-stream'
};

async function gbrainCall(toolName, args) {
  try {
    const res = await fetch(`${GBRAIN_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GBRAIN_TOKEN}`,
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: args }
      })
    });
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data:'));
    if (!line) return null;
    const msg = JSON.parse(line.replace('data:', '').trim());
    return msg.result?.content?.[0]?.text || null;
  } catch(e) {
    console.error('[gbrain] error:', e.message);
    return null;
  }
}

// Get customer context by email (for Rachel's conversation personalization)
async function getCustomerContext(accountId, kitchenLocation, clientId, userEmail) {
  if (!userEmail) return '';
  try {
    const result = await gbrainCall('query', { query: `customer email ${userEmail}` });
    if (!result) return '';
    let pages;
    try { pages = JSON.parse(result); } catch(e) { return result; }
    if (!Array.isArray(pages) || pages.length === 0) return '';
    const matching = pages.filter(p =>
      p.compiled_truth?.includes(userEmail) ||
      p.frontmatter?.email === userEmail
    );
    if (matching.length === 0) return '';
    return matching.map(p => p.compiled_truth || JSON.stringify(p)).join('\n\n');
  } catch(e) {
    console.error('[gbrain] getCustomerContext error:', e.message);
    return '';
  }
}

// Build slug from email
function emailToSlug(email) {
  return 'd2c-sessions/' + email.replace('@', '-at-').replace(/\./g, '-');
}

// Get D2C session (onboarding + basket state)
async function getD2CSession(userEmail) {
  if (!userEmail) return null;
  try {
    const slug = emailToSlug(userEmail);
    const result = await gbrainCall('get_page', { slug, fuzzy: false });
    if (!result) return null;
    const page = JSON.parse(result);
    if (!page || page.deleted_at || page.error) return null;
    const fm = page.frontmatter || {};
    return {
      onboarded:        fm.onboarded === true || fm.onboarded === 'true',
      age_verified:     fm.age_verified === true || fm.age_verified === 'true',
      delivery_zip:     fm.delivery_zip || '',
      delivery_address: fm.delivery_address || '',
      last_search:      fm.last_search || '',
      last_basket:      fm.last_basket ? JSON.parse(fm.last_basket) : null,
      last_basket_total: fm.last_basket_total || '',
      last_seen:        fm.last_seen || '',
      last_channel:     fm.last_channel || '',
      last_thread_id:   fm.last_thread_id || ''
    };
  } catch(e) {
    return null;
  }
}

// Save full D2C session state
async function saveD2CSession(userEmail, sessionData) {
  if (!userEmail) return;
  try {
    const slug = emailToSlug(userEmail);
    const now = new Date().toISOString();
    const basket = sessionData.last_basket ? JSON.stringify(sessionData.last_basket) : '';

    const frontmatter = [
      '---',
      `email: "${userEmail}"`,
      `onboarded: ${sessionData.onboarded !== false}`,
      `age_verified: true`,
      `delivery_zip: "${sessionData.zip || sessionData.delivery_zip || ''}"`,
      `delivery_address: "${(sessionData.address || sessionData.delivery_address || '').replace(/"/g, "'")}"`,
      `last_search: "${sessionData.last_search || ''}"`,
      `last_basket: '${basket.replace(/'/g, '"')}'`,
      `last_basket_total: "${sessionData.last_basket_total || ''}"`,
      `last_seen: "${now}"`,
      `last_channel: "${sessionData.last_channel || ''}"`,
      `last_thread_id: "${sessionData.last_thread_id || ''}"`,
      '---'
    ].join('\n');

    const zip = sessionData.zip || sessionData.delivery_zip || '';
    const address = sessionData.address || sessionData.delivery_address || '';
    const lastSearch = sessionData.last_search || '';
    const lastBasket = sessionData.last_basket;

    const content = `${frontmatter}

# D2C Session — ${userEmail}

## Onboarding
- Email: ${userEmail}
- Age verified: true
- Delivery address: ${address}
- Delivery zip: ${zip}
- Last seen: ${now}

## Last Activity
- Last search: ${lastSearch || 'none'}
- Last basket total: ${sessionData.last_basket_total || 'none'}
${lastBasket ? `\n## Last Basket\n${lastBasket.map(i => `- ${i.qty || i.quantity || 1}x ${i.name} — ${i.price}`).join('\n')}` : ''}
`;

    await gbrainCall('put_page', { slug, content });
    console.log('[gbrain] D2C session saved for:', userEmail);
  } catch(e) {
    console.error('[gbrain] saveD2CSession error:', e.message);
  }
}

// Save basket to GBrain (called after product selection)
async function saveBasket(userEmail, basket, total, channel) {
  if (!userEmail || !basket) return;
  try {
    // Save basket to channel-specific page, address/zip stays on shared page
    const channelSlug = channel || 'default';
    const existing = await getD2CSession(userEmail) || {};
    // Update shared page with last_basket_channel reference only
    await saveD2CSession(userEmail, {
      ...existing,
      last_basket_channel: channelSlug,
      last_basket_total: total || ''
    });
    // Save actual basket to channel-specific page
    const basketSlug = emailToSlug(userEmail) + '-basket-' + channelSlug;
    const payload = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'put_page', arguments: {
        slug: basketSlug,
        frontmatter: { email: userEmail, channel: channelSlug, total: total || '', updated: new Date().toISOString() },
        content: typeof basket === 'string' ? basket : JSON.stringify(basket)
      }}
    };
    const res = await fetch(GBRAIN_URL, { method: 'POST', headers: GBRAIN_HEADERS, body: JSON.stringify(payload) });
    console.log('[gbrain] basket saved for:', userEmail, 'channel:', channelSlug);
  } catch(e) {
    console.error('[gbrain] saveBasket error:', e.message);
  }
}

async function getBasket(userEmail, channel) {
  if (!userEmail) return null;
  try {
    const channelSlug = channel || 'default';
    const basketSlug = emailToSlug(userEmail) + '-basket-' + channelSlug;
    const payload = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_page', arguments: { slug: basketSlug }}
    };
    const res = await fetch(GBRAIN_URL, { method: 'POST', headers: GBRAIN_HEADERS, body: JSON.stringify(payload) });
    for (const line of (await res.text()).split('\n')) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        return data?.result?.content?.[0]?.text || null;
      }
    }
  } catch(e) { return null; }
}

// Save last search query
async function saveSearch(userEmail, searchQuery) {
  if (!userEmail || !searchQuery) return;
  try {
    const existing = await getD2CSession(userEmail) || {};
    await saveD2CSession(userEmail, {
      ...existing,
      last_search: searchQuery
    });
  } catch(e) {
    console.error('[gbrain] saveSearch error:', e.message);
  }
}


async function savePackage(userEmail, lineItems, summary) {
  if (!userEmail || !lineItems) return;
  try {
    const slug = emailToSlug(userEmail) + '-package';
    const payload = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'put_page', arguments: {
        slug,
        frontmatter: {
          email: userEmail,
          updated: new Date().toISOString(),
          summary: summary || ''
        },
        content: typeof lineItems === 'string' ? lineItems : JSON.stringify(lineItems)
      }}
    };
    const res = await fetch(GBRAIN_URL, { method: 'POST', headers: GBRAIN_HEADERS, body: JSON.stringify(payload) });
    console.log('[gbrain] package saved for:', userEmail);
  } catch(e) { console.error('[gbrain] savePackage error:', e.message); }
}



async function getPackage(userEmail, channel) {
  if (!userEmail) return null;
  try {
    const channelSlug = channel || 'default';
    const basketSlug = emailToSlug(userEmail) + '-basket-' + channelSlug;
    const payload = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_page', arguments: { slug: basketSlug } }
    };
    const res = await fetch(GBRAIN_URL + '/mcp', { method: 'POST', headers: GBRAIN_HEADERS, body: JSON.stringify(payload) });
    const rawText = await res.text();
    for (const line of rawText.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          const data = JSON.parse(line.slice(line.indexOf(':')+1).trim());
          const pageText = data?.result?.content?.[0]?.text;
          if (pageText) {
            try {
              const page = JSON.parse(pageText);
              return page.compiled_truth || pageText;
            } catch(e) {
              return pageText;
            }
          }
        } catch(e) {}
      }
    }
  } catch(e) { return null; }
  return null;
}
module.exports = {
  getCustomerContext,
  getD2CSession,
  saveD2CSession,
  saveBasket,
  saveSearch,
  getPackage
};
