// Lasting preferences a customer states ("always cans, not bottles", "we prefer West Coast wines", "from now on send the
// payment link to accounts@...") — remembered across conversations and channels (DC, Oct 3: "learn customers' habits").
// Kept in RACHEL_DATA_DIR/customer-prefs.json under the customer's email and, when known, the client ("client:goody").
// Bevvi staff writing for a client (an @getbevvi.com sender in a client's email thread) are stored under the CLIENT only —
// DC's note for one client must never follow him to every other client's quote.
// The preferences ride on the LLM's per-turn notes (never the cached system block). Code decides what is a preference
// and logs it; the LLM applies them. A QA identity's preferences stay under its own address (never a real client).
const fs = require('fs');
const FILE = require('./data-dir.js').file('customer-prefs.json');
const QA_RE = /^(qa-[^@]*|rachel_qa)@getbevvi\.com$/i;
const MAX = 15;

// A sentence that states a lasting habit, not a one-off ("always", "from now on", "we prefer", "we never", ...).
const LASTING = /\b(?:always|every time|from now on|going forward|in (?:the )?future|for future (?:orders|events)|next time(?:s)?|as a rule|by default)\b|\b(?:we|i|our (?:team|office|company|guests))\s+(?:usually|typically|generally|normally|always|never|prefer|only (?:drink|order|want|serve))\b|\b(?:we|i)\s+(?:do ?n[o']t|do not)\s+(?:drink|serve|want|like|order)\b|\bplease (?:never|always|don'?t ever)\b/i;
const NOT_A_PREF = /\?\s*$|\b(?:this time|for this (?:order|event)|today|tomorrow|tonight)\b|^\s*(?:always happy|thanks? as always)\b/i;

function sentences(text) {
  return String(text || '').replace(/\r/g, '').split('\n').filter(l => !/^\s*>/.test(l)).join(' ')
    .split(/(?<=[.!?])\s+|\s*[;•]\s*/).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length >= 8 && s.length <= 220);
}
function extract(message) {
  // a request for a standing behaviour is a preference even as a question ("Can you always send the payment link as a link?")
  const ASK = /^(?:can|could|would|will) you (?:please )?(?:always|never|from now on|going forward)\b/i;
  return sentences(message).filter(s => LASTING.test(s) && (ASK.test(s) || !NOT_A_PREF.test(s)));
}
// "forget my preferences" -> all; "forget that we prefer cans" / "you can forget the cans preference" -> matching ones
function forgetAsk(message) {
  const m = String(message || '').match(/\b(?:forget|stop remembering|don'?t remember|remove)\s+(?:(?:all\s+)?(?:my|our)\s+preferences|(?:that|the)\s+(.{3,80}?)(?:\s+preference)?)(?=[.!?]|$)/i);
  if (!m) return null;
  return { all: !m[1], words: m[1] ? m[1].toLowerCase().split(/\W+/).filter(w => w.length > 3) : [] };
}

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; } }
function writeAll(all, log) { try { fs.writeFileSync(FILE, JSON.stringify(all, null, 1)); return true; } catch (e) { log('[prefs] save failed: ' + e.message); return false; } }
const clientKey = c => c ? 'client:' + String(c).toLowerCase().replace(/\s+/g, ' ').trim() : '';

// Which keys a message's preferences belong to.
function keysFor({ email, client, staff }) {
  // a QA identity keeps preferences under its own address only — never a real client's ("client:goody")
  if (QA_RE.test(String(email || ''))) return [String(email).toLowerCase()];
  const k = [];
  if (email && !staff) k.push(String(email).toLowerCase());
  if (client) k.push(clientKey(client));
  return k;
}

// Reads the message; saves new preferences / applies a "forget". -> { added: [..], forgot: n }
function learn(message, who, log = console.log) {
  const keys = keysFor(who);
  const out = { added: [], forgot: 0 };
  if (!keys.length) return out;
  const all = readAll(); let changed = false;
  const fa = forgetAsk(message);
  if (fa) {
    for (const k of keys) {
      const before = (all[k] || []).length;
      all[k] = fa.all ? [] : (all[k] || []).filter(p => !fa.words.some(w => p.text.toLowerCase().includes(w)));
      out.forgot += before - all[k].length;
    }
    if (out.forgot) { changed = true; log('[prefs] forgot ' + out.forgot + ' preference(s) for ' + keys.join(', ') + ' — ' + JSON.stringify(String(message).slice(0, 80))); }
  } else {
    for (const s of extract(message)) {
      for (const k of keys) {
        const list = all[k] || (all[k] = []);
        const n = s.toLowerCase().replace(/\W+/g, ' ').trim();
        if (list.some(p => p.text.toLowerCase().replace(/\W+/g, ' ').trim() === n)) continue;
        list.push({ text: s, at: new Date().toISOString().slice(0, 10), by: who.email || '' });
        if (list.length > MAX) list.splice(0, list.length - MAX);
        changed = true;
      }
      out.added.push(s);
    }
    if (out.added.length) log('[prefs] learned for ' + keys.join(', ') + ': ' + JSON.stringify(out.added));
  }
  if (changed) writeAll(all, log);
  return out;
}

// The preferences for this customer/client, as a note for the LLM ('' when none).
function render({ email, client }) {
  const all = readAll(), seen = new Set(), lines = [];
  for (const k of [email ? String(email).toLowerCase() : '', clientKey(client)].filter(Boolean)) {
    for (const p of all[k] || []) {
      const n = p.text.toLowerCase();
      if (seen.has(n)) continue; seen.add(n);
      lines.push('- "' + p.text + '" (' + (k.startsWith('client:') ? 'for ' + client : 'this customer') + ', ' + p.at + ')');
    }
  }
  return lines.length ? '## CUSTOMER PREFERENCES (stated by them in earlier messages — follow them unless they say otherwise now; mention one only when it changes what you do)\n' + lines.join('\n') : '';
}

module.exports = { extract, forgetAsk, learn, render, keysFor, FILE };
