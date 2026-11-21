// Saved baskets (DC, Nov 20: "a way to save a basket and name it and later retrieve it. Also ability to list the basket
// and date it was created"). Every /chat channel (Slack, WhatsApp, email, the connector's rachel_chat), handled IN CODE
// (server.js SAVED BASKETS, before the classifier / edit reader / LLM):
//   "save this basket as Holiday Party"  -> saved under the customer's email (all their channels), created date kept
//   "show my saved baskets"              -> each name, items, product total, created date (and updated, when re-saved)
//   "load my Holiday Party basket"       -> its lines are the cart again (prices refreshed from the store in server.js)
//   "delete the saved basket Holiday Party"
// Kept in RACHEL_DATA_DIR/saved-baskets.json: { "<email>": [ {name, items, created_at, updated_at, zip, address,
// client, fees, total, channel} ] }. A QA identity's baskets stay under its own address. Re-saving a name replaces its
// lines and keeps its created date.
const fs = require('fs');
const FILE = () => require('./data-dir.js').file('saved-baskets.json');
const MAX = 50;

const NOUN = '(?:basket|cart|order|list|selection|package|menu)';
const VERB_LOAD = '(?:load|retrieve|restore|reload|recall|open|pull up|bring back|bring up|use|get|switch to|go back to|re-?use)';
const VERB_DEL = '(?:delete|remove|discard|forget|erase|drop)';

// Slack / email link markup as plain text (Nov 20, DC on Slack: the name answer "WAT - 707 Roy Moore Rd, Ona, FL 33865"
// arrived as "WAT - <https://www.google.com/maps/search/...|707 Roy Moore Rd, Ona, FL 33865>" — Slack linked the address —
// and was refused as too long; the model then said "Saved!" with nothing saved). "<url|label>" -> label, "<url>" -> url.
function unwrap(s) {
  return String(s || '').replace(/<((?:https?|mailto|tel):[^|>\s]*)\|([^>]*)>/gi, '$2').replace(/<((?:https?|mailto|tel):[^>\s]*)>/gi, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// A name as the customer typed it: quotes, trailing punctuation and politeness removed.
function cleanName(s) {
  let n = String(s || '').replace(/\s+/g, ' ').trim();
  n = n.replace(/\s*(?:,?\s*(?:please|pls|plz|thanks?|thank you|for (?:later|now|next time|the future)))+\s*[.!]*$/i, '');
  n = n.replace(/^(?:as|under|named|called|titled|the name)\s+/i, '');
  n = n.replace(/^["“”'‘’`*_]+|["“”'‘’`*_.!?]+$/g, '').trim();
  return n.length >= 1 && n.length <= 60 ? n : '';
}
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// What the message asks, or null. Only short, one-line messages (a list or a brief is never a saved-basket command).
//   { kind: 'save', name } (name '' = ask for it) | { kind: 'list' } | { kind: 'load', name, explicit } | { kind: 'delete', name, explicit }
// explicit = the customer said "saved" / used load / retrieve / restore — an unknown name is answered, not passed on.
// An email's greeting / sign-off lines around the one command line are allowed ("Hi Rachel,\n\nPlease save this basket as
// X.\n\nThanks,\nDC"); any other second line = not a command.
const FILLER = /^(?:(?:hi|hey|hello|dear|good (?:morning|afternoon|evening))\b[^\n]{0,30}|(?:thanks?|thank you|thx|cheers|best|regards|best regards|warmly|sincerely|kind regards)\b[^\n]{0,30}|[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,2}[,.]?|-+|--\s*)$/;
function parse(message) {
  const lines = unwrap(message).replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1) return parseLine(lines[0] || '');
  if (lines.length > 8) return null;
  const hits = lines.map(parseLine);
  const at = hits.map((h, i) => h ? i : -1).filter(i => i >= 0);
  return at.length === 1 && lines.every((l, i) => i === at[0] || FILLER.test(l)) ? hits[at[0]] : null;
}
function parseLine(m) {
  if (!m || m.length > 160) return null;
  // A leading "no" / "actually" / "ok" correcting Rachel's last offer ("no save the basket" after "email this to anyone?" —
  // Nov 20, DC on Slack: the model showed the basket and saved nothing) is not part of the command.
  const t = m.replace(/^(?:hi|hey|hello)[,!]?\s+/i, '').replace(/^(?:rachel[,:]?\s+)/i, '')
    .replace(/^(?:no|nope|nah|actually|ok(?:ay)?|instead|just)\b[,.!]*\s+(?=(?:(?:can|could|would) you\s+|please\s+|pls\s+|i want (?:you )?to\s+|i(?:'d| would) like (?:you )?to\s+|just\s+)?(?:save|store|bookmark|name|call|label|show|list|load|retrieve|restore|delete)\b)/i, '').replace(/^(?:(?:can|could|would) you|please|pls|i(?:'d| would) like (?:you )?to|i want (?:you )?to|let'?s)\s+/i, '').replace(/^please\s+/i, '');
  const saved = /\bsaved\b/i.test(t);
  // LIST
  if (/\b(?:list|show|see|view|display|what(?:'s| are| is)?|which|any|all)\b[^.?!]{0,30}\bsaved\s+(?:baskets?|carts?|lists?|orders?|packages?|menus?)\b/i.test(t) ||
      /\b(?:list|show|see|view|display)\s+(?:me\s+)?(?:all\s+)?(?:of\s+)?(?:my|our)\s+(?:baskets|carts)\b/i.test(t) ||
      // "show me all the baskets" / "list all baskets" / "what baskets do I have" (Nov 21, DC on Slack: not read as a list,
      // so after the fresh start it was asked the delivery address). Plural "baskets" only — "show me the basket" is the cart.
      /^(?:list|show|see|view|display)\s+(?:me\s+)?(?:all\s+)?(?:of\s+)?(?:the\s+)?(?:baskets|carts)\s*[.!?]?$/i.test(t) ||
      /^(?:what|which)\s+baskets\s+(?:do|have)\s+(?:i|we)\b/i.test(t) ||
      /\b(?:baskets?|carts?)\s+(?:i|we)(?:'ve|\s+have)?\s+saved\b/i.test(t) || /\b(?:baskets?|carts?)\s+(?:have|did)\s+(?:i|we)\s+save(?:d)?\b/i.test(t) || /^\s*(?:my\s+)?saved\s+(?:baskets|carts)\s*\??\s*$/i.test(t))
    return { kind: 'list' };
  // SAVE
  let s = t.match(new RegExp('^(?:save|store|bookmark)\\s+(?:this|my|the|our|that)?\\s*(?:current\\s+)?' + NOUN + '\\b(?:\\s+(?:for later|for next time|for the future))?(?:\\s*(?:as|under|with the name|named|called|titled|:|-|—)\\s*(.+))?\\s*[.!]?$', 'i'));
  if (s) return { kind: 'save', name: cleanName(s[1] || '') };
  s = t.match(new RegExp('^(?:name|call|label|title)\\s+(?:this|my|the|our|that)\\s*(?:current\\s+)?' + NOUN + '\\s+(?:as\\s+)?(.+)$', 'i'));
  if (s) { const n = cleanName(s[1]); if (n) return { kind: 'save', name: n }; }
  s = t.match(/^save\s+(?:it|this)\s+(?:as|under)\s+(.+)$/i);
  if (s) { const n = cleanName(s[1]); if (n) return { kind: 'save', name: n }; }
  // DELETE (before LOAD: "remove my saved basket X")
  s = t.match(new RegExp('^' + VERB_DEL + '\\s+(?:my|the|our|that)?\\s*(?:saved\\s+)?(?:basket|cart|list|package|menu)\\s+(?:called|named|titled)?\\s*(.+)$', 'i')) ||
      t.match(new RegExp('^' + VERB_DEL + '\\s+(?:my|the|our|that)?\\s*(.+?)\\s+(?:saved\\s+)?(?:basket|cart|list|package|menu)\\s*[.!]?$', 'i'));
  if (s) { const n = cleanName(s[1]); if (n && !/^(?:saved|this|it)$/i.test(n)) return { kind: 'delete', name: n, explicit: saved }; }
  // LOAD
  const explicitVerb = /^(?:load|retrieve|restore|reload|recall|pull up|bring back|bring up|re-?use)\b/i.test(t);
  s = t.match(new RegExp('^' + VERB_LOAD + '\\s+(?:up\\s+)?(?:my|the|our|that)?\\s*(?:saved\\s+)?(?:basket|cart|list|order|package|menu)\\s+(?:called|named|titled|for)?\\s*(.+)$', 'i')) ||
      t.match(new RegExp('^' + VERB_LOAD + '\\s+(?:up\\s+)?(?:my|the|our|that)?\\s*(.+?)\\s+(?:saved\\s+)?(?:basket|cart|list|order|package|menu)\\s*(?:again)?\\s*[.!?]?$', 'i')) ||
      t.match(/^(?:load|retrieve|restore|reload|recall)\s+(.+)$/i);
  if (s) { const n = cleanName(s[1].replace(/\s+(?:again|back)$/i, '')); if (n && !/^(?:saved|it|this|that|my|the)$/i.test(n)) return { kind: 'load', name: n, explicit: saved || explicitVerb }; }
  return null;
}

// "what should I call it?" answered: a short line that is a name, not a request.
function nameAnswer(message) {
  const m = unwrap(message).trim();
  if (!m || m.length > 60 || /\n|\?/.test(m) || m.split(/\s+/).length > 12) return '';
  if (/^(?:no|nope|cancel|never ?mind|skip|forget it|don'?t)\b/i.test(m)) return '';
  if (/\b(?:add|remove|swap|replace|order|checkout|proposal|deliver|address|show|basket|cart)\b/i.test(m)) return '';
  return cleanName(m.replace(/^(?:call it|name it|save it as|it'?s|as)\s+/i, ''));
}

const keyOf = email => String(email || '').toLowerCase().trim();
function readAll() { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { return {}; } }
function writeAll(all) { const f = FILE(); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(all, null, 1)); fs.renameSync(tmp, f); }
function list(email) { return (readAll()[keyOf(email)] || []).slice().sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))); }

// Exact (case / punctuation-insensitive) first, else the ONE saved name that starts with / contains it.
function find(email, name) {
  const all = list(email), n = norm(name);
  if (!n) return { entry: null, matches: [] };
  const ex = all.filter(b => norm(b.name) === n);
  if (ex.length) return { entry: ex[0], matches: ex };
  const part = all.filter(b => norm(b.name).startsWith(n) || (' ' + norm(b.name) + ' ').includes(' ' + n + ' ') || n.startsWith(norm(b.name) + ' '));
  return { entry: part.length === 1 ? part[0] : null, matches: part };
}

const qtyOf = li => Number(li.qty || li.quantity || 1) || 1;
const totalOf = items => Math.round((items || []).reduce((a, li) => a + qtyOf(li) * (parseFloat(li.price) || 0), 0) * 100) / 100;

// -> { entry, replaced: bool }
function save(email, name, items, extra = {}) {
  const k = keyOf(email);
  if (!k) throw new Error('no customer email');
  const all = readAll(), arr = all[k] || (all[k] = []);
  const now = new Date().toISOString();
  const i = arr.findIndex(b => norm(b.name) === norm(name));
  const entry = Object.assign({}, i >= 0 ? arr[i] : { created_at: now }, extra, { name, items, total: totalOf(items), updated_at: now });
  if (i >= 0) arr[i] = entry; else arr.push(entry);
  if (arr.length > MAX) { arr.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at))); arr.splice(0, arr.length - MAX); }
  writeAll(all);
  return { entry, replaced: i >= 0 };
}
function remove(email, name) {
  const k = keyOf(email), all = readAll(), arr = all[k] || [];
  const i = arr.findIndex(b => norm(b.name) === norm(name));
  if (i < 0) return null;
  const [gone] = arr.splice(i, 1); all[k] = arr; writeAll(all);
  return gone;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso) { const d = new Date(iso); return isNaN(d) ? '' : MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); }
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lineText = li => qtyOf(li) + 'x ' + li.name + ' — ' + money(parseFloat(li.price) || 0) + ' ea = ' + money(qtyOf(li) * (parseFloat(li.price) || 0));

// A reply that tells the customer their basket was saved (the model's own words; only the code saves).
const SAVED_CLAIM = /\b(?:saved|i'?ve saved|i saved|is saved|has been saved)\b[^.\n]{0,60}\b(?:basket|cart)\b|\b(?:basket|cart)\b[^.\n]{0,60}\b(?:saved|is ready to go whenever)\b/i;
function claimsSaved(text) { return SAVED_CLAIM.test(String(text || '')); }

// Bullets, never "1." — a numbered list would be read by the multi-pick resolver as options to pick from.
function listText(email) {
  const all = list(email);
  if (!all.length) return 'You don\'t have any saved baskets yet. When your cart looks right, say "save this basket as <name>" and I\'ll keep it for you.';
  const rows = all.map(b => {
    const n = (b.items || []).length, c = fmtDate(b.created_at), u = fmtDate(b.updated_at);
    return '• *' + b.name + '* — ' + n + ' item' + (n === 1 ? '' : 's') + ', ' + money(b.total) + ' — saved ' + c + (u && u !== c ? ' (updated ' + u + ')' : '') + (b.zip ? ' — delivery ' + b.zip : '');
  });
  return 'Your saved baskets (' + all.length + '):\n\n' + rows.join('\n') + '\n\nSay "load <name>" to put one in your cart, or "delete saved basket <name>" to remove one.';
}
function namesText(email) { return list(email).map(b => '"' + b.name + '"').join(', '); }

module.exports = { parse, nameAnswer, unwrap, claimsSaved, cleanName, list, find, save, remove, listText, namesText, lineText, totalOf, fmtDate, money, FILE };
