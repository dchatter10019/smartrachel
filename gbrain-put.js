// Write a gbrain page through the RUNNING server's MCP endpoint (put_page).
// Real bug (Sep 28): seed_customers.js / seed_retailers.js wrote with the gbrain CLI, which opens
// the pglite database directly — so their cron jobs stopped gbrain-mcp for an hour every night
// (Rachel had no customer memory 02:00-03:00 UTC). The CLI `put` also fails on brand-new slugs
// ("Page not found"): the last completed customer seed (Jul 20) wrote 42 of 166.
// Same call rachel/gbrain.js and seed_order_history.js use. Needs GBRAIN_TOKEN (/etc/gbrain.env).
const GBRAIN_URL = 'http://127.0.0.1:7700';

async function gbrainPutPage(slug, content) {
  if (!process.env.GBRAIN_TOKEN) throw new Error('GBRAIN_TOKEN not set — source /etc/gbrain.env');
  const res = await fetch(`${GBRAIN_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GBRAIN_TOKEN}`,
      'Accept': 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'tools/call',
      params: { name: 'put_page', arguments: { slug, content } }
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`gbrain MCP HTTP ${res.status}`);
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data:'));
  if (!line) throw new Error('No response from gbrain MCP');
  const msg = JSON.parse(line.replace('data:', '').trim());
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  // Tool errors come back as result.isError with the message in content[0].text, not msg.error.
  const resultText = msg.result?.content?.[0]?.text || null;
  if (msg.result?.isError) throw new Error(resultText || 'put_page returned isError with no message');
  return resultText;
}

module.exports = { gbrainPutPage };
