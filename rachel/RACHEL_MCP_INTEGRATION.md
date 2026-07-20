# Rachel MCP Integration Guide

Rachel is Bevvi's AI beverage specialist. This guide explains how to integrate Rachel into your application using the MCP (Model Context Protocol) interface.

## Prerequisites

- A bearer token from Bevvi (contact dipanjan@getbevvi.com)
- Customer email address
- Customer delivery zip code

## Endpoint
Test connectivity:
```bash
curl http://3.138.180.46:3600/health
# Expected: {"status":"ok","port":3600,"service":"rachel-mcp","tools":7}
```

---

## Available Tools

| Tool | Description | Required First? |
|------|-------------|-----------------|
| `rachel_verify_age` | Verify customer is 21+ | ✅ Always call first |
| `rachel_chat` | Conversational interface | After age verified |
| `rachel_search` | Search specific products | After age verified |
| `rachel_build_package` | Build event package | After age verified |
| `rachel_recommend` | Personalized recommendations | After age verified |
| `rachel_place_order` | Place an order | After age verified |
| `rachel_get_session` | Get active basket | After age verified |

> ⚠️ All tools except `rachel_verify_age` are blocked until age is verified for the customer's email.

---

## Required Flow
---

## Integration Options

### Option 1 — Claude Desktop

**Step 1:** Save this proxy script as `~/bevvi-mcp/rachel-proxy.js`:

```javascript
#!/usr/bin/env node
const http = require('http');

const RACHEL_URL = 'http://3.138.180.46:3600/mcp';
const AUTH = 'Bearer YOUR_TOKEN_HERE';

process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  lines.forEach(line => {
    if (!line.trim()) return;
    try { forward(JSON.parse(line)); } catch(e) {}
  });
});

function forward(msg) {
  const body = JSON.stringify(msg);
  const req = http.request(RACHEL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': AUTH,
      'Content-Length': Buffer.byteLength(body)
    }
  }, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      data.split('\n').forEach(line => {
        if (line.startsWith('data: ')) process.stdout.write(line.slice(6) + '\n');
      });
    });
  });
  req.write(body);
  req.end();
}
```

**Step 2:** Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rachel": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/bevvi-mcp/rachel-proxy.js"]
    }
  }
}
```

**Step 3:** Restart Claude Desktop. Rachel tools will appear automatically.

**Step 4:** Just talk naturally:
> "I'm over 21, my email is john@example.com. Find me a nice red wine for delivery to zip 10010"

---

### Option 2 — Python

```python
import requests
import json

RACHEL_URL = 'http://3.138.180.46:3600/mcp'
RACHEL_TOKEN = 'YOUR_TOKEN_HERE'

def call_rachel(tool, args):
    res = requests.post(
        RACHEL_URL,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {RACHEL_TOKEN}'
        },
        json={
            'jsonrpc': '2.0',
            'id': 1,
            'method': 'tools/call',
            'params': {'name': tool, 'arguments': args}
        }
    )
    for line in res.text.split('\n'):
        if line.startswith('data:'):
            result = json.loads(line[5:])
            return json.loads(result['result']['content'][0]['text'])
    return None

# Step 1 — verify age (required)
verify = call_rachel('rachel_verify_age', {
    'email': 'customer@example.com',
    'confirmed': True
})
print(verify)
# {"verified": true, "message": "Age verified. Customer is confirmed 21 or older."}

# Step 2 — search products
products = call_rachel('rachel_search', {
    'products': ['Opus One', 'Veuve Clicquot'],
    'zip': '10010',
    'email': 'customer@example.com'
})

# Step 3 — get recommendations
recs = call_rachel('rachel_recommend', {
    'occasion': 'wedding',
    'category': 'wine',
    'zip': '10010',
    'email': 'customer@example.com'
})

# Step 4 — build event package
package = call_rachel('rachel_build_package', {
    'guests': 50,
    'hours': 3,
    'budget': 2000,
    'categories': ['wine', 'beer', 'champagne'],
    'zip': '10010',
    'email': 'customer@example.com'
})

# Step 5 — place order
order = call_rachel('rachel_place_order', {
    'line_items': json.dumps(package['line_items']),
    'first_name': 'John',
    'last_name': 'Smith',
    'email': 'customer@example.com',
    'phone': '2125551234',
    'address': '11 Madison Ave',
    'city': 'New York',
    'state': 'NY',
    'zip': '10010',
    'delivery_datetime': '2026-07-20T14:00:00.000Z',
    'tip_amount': 20
})
print(order)
# {"success": true, "order_id": "BEV-xxx", "payment_url": "https://..."}
```

---

### Option 3 — Node.js

```javascript
const fetch = require('node-fetch');

const RACHEL_URL = 'http://3.138.180.46:3600/mcp';
const RACHEL_TOKEN = 'YOUR_TOKEN_HERE';

async function callRachel(tool, args) {
  const res = await fetch(RACHEL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RACHEL_TOKEN}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args }
    })
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data:'));
  return JSON.parse(JSON.parse(line.slice(5)).result.content[0].text);
}

// Usage
async function main() {
  // Step 1 — verify age
  await callRachel('rachel_verify_age', {
    email: 'customer@example.com',
    confirmed: true
  });

  // Step 2 — search
  const result = await callRachel('rachel_search', {
    products: ['Opus One'],
    zip: '10010',
    email: 'customer@example.com'
  });
  console.log(result);

  // Step 3 — place order
  const order = await callRachel('rachel_place_order', {
    line_items: JSON.stringify(result.results[0].products),
    first_name: 'John',
    last_name: 'Smith',
    email: 'customer@example.com',
    phone: '2125551234',
    address: '11 Madison Ave',
    city: 'New York',
    state: 'NY',
    zip: '10010',
    delivery_datetime: '2026-07-20T14:00:00.000Z',
    tip_amount: 20
  });
  console.log(order);
}

main();
```

---

### Option 4 — Voiceflow

1. In Voiceflow, add a new **API tool**
2. Set URL to `http://3.138.180.46:3600/mcp`
3. Method: `POST`
4. Headers: `Authorization: Bearer YOUR_TOKEN_HERE`
5. Body:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "{{tool_name}}",
    "arguments": {{tool_args}}
  }
}
```

---

## Tool Reference

### rachel_verify_age
```json
{
  "email": "customer@example.com",
  "confirmed": true
}
```
Response: `{"verified": true, "message": "Age verified."}`

### rachel_search
```json
{
  "products": ["Opus One", "Veuve Clicquot"],
  "zip": "10010",
  "email": "customer@example.com"
}
```

### rachel_build_package
```json
{
  "guests": 50,
  "hours": 3,
  "budget": 2000,
  "categories": ["wine", "beer", "spirits"],
  "zip": "10010",
  "email": "customer@example.com"
}
```

### rachel_recommend
```json
{
  "occasion": "wedding dinner",
  "category": "wine",
  "zip": "10010",
  "email": "customer@example.com",
  "budget": 50
}
```

### rachel_place_order
```json
{
  "line_items": "[{\"name\":\"Opus One\",\"upc\":\"...\",\"qty\":1,\"price\":486.19}]",
  "first_name": "John",
  "last_name": "Smith",
  "email": "customer@example.com",
  "phone": "2125551234",
  "address": "11 Madison Ave",
  "city": "New York",
  "state": "NY",
  "zip": "10010",
  "delivery_datetime": "2026-07-20T14:00:00.000Z",
  "tip_amount": 20,
  "delivery_instructions": "Leave at front desk"
}
```

### rachel_chat
```json
{
  "message": "I need wine for a wedding of 100 people",
  "email": "customer@example.com",
  "zip": "10010",
  "session_id": "optional-session-id",
  "channel": "plain"
}
```

---

## Support

Contact dipanjan@getbevvi.com for:
- Bearer token
- Supported zip codes
- Custom integrations
