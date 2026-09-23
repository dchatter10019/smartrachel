// Intent classifier: "classify with the LLM, act with code."
// A small, constrained Sonnet call returning a fixed enum. The deterministic state
// machine acts on the label; the main LLM never interprets these messages free-form.
// Regex is the fallback when the call fails, times out, or confidence is low.
const INTENTS = ['place_order','add_item','select_option','set_quantity','change_time',
  'change_instructions','change_contact','change_address','remove_item','show_basket','recommend',
  'build_package','confirm_yes','confirm_no','cancel','answer','other'];

const SYSTEM = `You classify a customer's message to a beverage-ordering assistant. Return ONLY raw JSON: {"intent":"<one of: ${INTENTS.join('|')}>","ref":"<product name or option number the message refers to, or empty>","qty":<integer or 0>,"confidence":<0-1>}.
Definitions: place_order = wants to check out/order now ("lets order","go ahead","I'll take it"). add_item = add a product to the basket. select_option = picks one of options the assistant just listed (a number or a restated name). set_quantity = a bare number/quantity answering "how many". change_time = change the delivery date/time. change_instructions = change driver/delivery notes. change_contact = change name, phone, or email. change_address = change the delivery address (street/city/zip) — NOT instructions. remove_item = remove/drop something. show_basket = see what's in the basket/estimate/total. recommend = asks for a suggestion/recommendation. build_package = event package with guests/budget/hours. confirm_yes / confirm_no = answering a yes/no question. cancel = stop/abandon. answer = the message is simply the ANSWER to the question the assistant just asked (a name when asked for a name, a phone number when asked for a phone, an email or 'same' when asked for an email, a date/time when asked for a delivery time, instructions or 'none' when asked for delivery instructions) — NOT a request to change anything. other = anything else (questions, chit-chat, product lookups by name).
Use the context (what the assistant last asked, current step) to disambiguate. If the assistant just asked a direct question and the message plausibly answers it, the intent is 'answer' unless the message explicitly asks to CHANGE something already given. A bare number after "how many" is set_quantity; after a numbered list it is select_option.`;

async function classifyIntent(message, ctx = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { intent: 'other', ref: '', qty: 0, confidence: 0, source: 'no-key' };
  const user = `Context: last assistant question kind = ${ctx.lastKind || 'none'}; order step = ${ctx.orderStep || 'none'}; basket items = ${ctx.basketSize || 0}.\nThe assistant's last message was: ${JSON.stringify(ctx.lastQuestion || '')}\nMessage: ${JSON.stringify(String(message || '').slice(0, 400))}`;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 120, system: SYSTEM, messages: [{ role: 'user', content: user }] })
    });
    const d = await r.json();
    const txt = (d.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    const j = JSON.parse(txt);
    const intent = INTENTS.includes(j.intent) ? j.intent : 'other';
    return { intent, ref: String(j.ref || ''), qty: parseInt(j.qty) || 0, confidence: Math.max(0, Math.min(1, parseFloat(j.confidence) || 0)), source: 'llm' };
  } catch (e) {
    return { intent: 'other', ref: '', qty: 0, confidence: 0, source: 'error:' + (e.name === 'AbortError' ? 'timeout' : e.message) };
  } finally { clearTimeout(t); }
}
module.exports = { classifyIntent, INTENTS };
