// Proposal guard: every proposal PDF a reply carries is checked against what the customer said, BEFORE the reply
// leaves; a mismatch is corrected in code (session fixed, PDF regenerated, link swapped) and logged to
// RACHEL_DATA_DIR/self-corrections.jsonl -> monitor detector self_correction -> nightly fixer fixes the cause.
// DC (Oct 13): "a self correcting loop where if you see discrepancies like this, it corrects by itself" — Sean's
// Liquid Labs quote (NYC items, "to address 1460 Broadway, New York, NY") went out billed to "Gen II Fund" with the
// Boston delivery address of the thread it was wrongly linked to.
//
// check(pi, ctx) -> [{ field, printed, expected, why, fixable }]
//   pi:  the proposal's saved items file (generate-proposal.js): { client_name, event_date, notes, line_items }
//   ctx: { message, subject, threadFirst, senderName, stated: { address, zip } | null, printedStore, statedStore, now }
// Checks (each only when the customer's own words give the expected value):
//   address — an address in THIS message that isn't the printed one
//   store   — the lines come from another store than the one serving the printed address (fixable only when the
//             address the customer stated is served by the lines' store: then the address is what's wrong)
//   client  — the email subject names a client the PDF doesn't, and neither this message nor the thread's first
//             email names the printed client (a client the customer chose is never overridden)
//   date    — a date in THIS message that isn't the printed one
const { clientFromSubject } = require('./email-subject.js');
const ED = require('./event-date.js');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const GENERIC = new Set('the of and a an fund funds inc llc ltd co company corp corporation group services service partners holdings team office event qa'.split(' '));
const tokens = s => norm(s).split(/[^a-z0-9]+/).filter(w => w.length > 1 && !GENERIC.has(w));
const names = (text, client) => { const t = ' ' + norm(text).replace(/[^a-z0-9]+/g, ' ') + ' ', k = tokens(client); return k.length > 0 && k.every(w => t.includes(' ' + w + ' ')); };
const streetKey = a => (norm(a).match(/^\s*(\d+[a-z]?)\s+([a-z]+)/) || []).slice(1).join(' ');
const zipOf = a => (String(a || '').match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/) || [])[1] || '';

// "Delivery: 1460 Broadway, New York, NY 10036." -> the address ('' when the PDF prints none)
function printedAddress(notes) {
  const m = String(notes || '').match(/\bDelivery:\s*(.+?\b\d{5}(?:-\d{4})?)\b/i);
  return m ? m[1].trim() : '';
}
// The store most of the lines come from.
function linesStore(items) {
  const n = {};
  for (const li of items || []) if (li && li.establishmentId) n[li.establishmentId] = (n[li.establishmentId] || 0) + 1;
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || '';
}
const sameDate = (a, b, now) => {
  const x = ED.normalizeEventDate(a, now), y = ED.normalizeEventDate(b, now);
  return x.date && y.date ? x.text === y.text : norm(a).trim() === norm(b).trim();
};

function check(pi, ctx) {
  const out = [], msg = String(ctx.message || ''), now = ctx.now || new Date();
  const pAddr = printedAddress(pi.notes);
  const st = ctx.stated;
  if (pAddr && st && st.address && st.zip && (st.zip !== zipOf(pAddr) || streetKey(st.address) !== streetKey(pAddr))) {
    out.push({ field: 'address', printed: pAddr, expected: st.address, zip: st.zip, why: 'the customer wrote this address in the message', fixable: true });
  }
  const itemsStore = linesStore(pi.line_items);
  if (pAddr && itemsStore && ctx.printedStore && ctx.printedStore !== itemsStore) {
    const viaStated = !!(st && ctx.statedStore && ctx.statedStore === itemsStore);
    if (!out.some(o => o.field === 'address') || !viaStated) {
      out.push({ field: 'store', printed: pAddr, expected: viaStated ? st.address : '', why: 'the products come from store ' + itemsStore + ', but ' + pAddr + ' is served by store ' + ctx.printedStore, fixable: false });
    }
  }
  const sc = clientFromSubject(ctx.subject || '');
  // The sender's own name is never "named by the customer" — it is in every email's signature (Oct 13: Sean's quote was
  // billed to "Sean Fitzgibbons" with "Liquid Labs" in the subject).
  const senderIsClient = !!(ctx.senderName && pi.client_name && (names(ctx.senderName, pi.client_name) || names(pi.client_name, ctx.senderName)));
  if (sc && pi.client_name && !names(pi.client_name, sc) && !names(sc, pi.client_name)
      && (senderIsClient || (!names(msg, pi.client_name) && !names(ctx.threadFirst || '', pi.client_name)))
      && !(ED.parseProposalFieldEdit(msg, pi.event_date, now) || {}).client) {
    out.push({ field: 'client', printed: pi.client_name, expected: sc, why: 'the email subject names ' + sc + ' and the customer never named ' + pi.client_name + ' in this thread', fixable: true });
  }
  const said = ED.findEventDateIn(msg, now);
  if (said && /\d/.test(said) && pi.event_date && !sameDate(said, pi.event_date, now)) {
    out.push({ field: 'date', printed: pi.event_date, expected: ED.normalizeEventDate(said, now).text, why: 'the customer wrote this date in the message', fixable: true });
  }
  return out;
}

// The estimate lines the reply states vs the PDF's (pi.totals, generate-proposal.js) -> { text, changed: [{ line, was, now }] }.
// A reply line "Tax (8.8875%): $676.74" whose amount differs from the PDF's is rewritten with the PDF's label and amount.
// Real (Oct 13, Sean): the LLM wrote tax $676.74 / tip $50 / delivery $0 / total $9,105.80; the PDF said 9% $676.99 / 5%
// $380.87 / $25 / $9,461.92. Lines without a "$" amount ("Delivery: 1460 Broadway") are never touched.
function fixTotals(text, totals) {
  if (!totals || typeof text !== 'string') return { text, changed: [] };
  const usd = v => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const KINDS = [
    [/^product\s+total\b/i, 'Product total', 'productTotal'],
    [/^(?:estimated\s+)?(?:sales\s+)?tax\b/i, totals.taxLabel, 'tax'],
    [/^service(?:\s+charge|\s+fee)?\b/i, totals.serviceLabel, 'service'],
    [/^(?:tip|gratuity)\b/i, totals.tipLabel, 'tip'],
    [/^(?:estimated\s+)?delivery(?:\s+fee|\s+charge)?\b/i, 'Delivery', 'delivery'],
    [/^(?:estimated\s+)?grand\s+total\b/i, 'Estimated grand total', 'grandTotal']];
  const changed = [];
  const out = text.split('\n').map(line => {
    const m = line.match(/^(\s*(?:[-•*]\s+)?\**)([A-Za-z][^:\n$]{0,40}?)\s*:\s*\**\s*\$\s*([\d,]+(?:\.\d{1,2})?)\**(.*)$/);
    if (!m) return line;
    const k = KINDS.find(x => x[0].test(m[2].trim()));
    if (!k || typeof totals[k[2]] !== 'number') return line;
    const was = parseFloat(m[3].replace(/,/g, '')), now = totals[k[2]];
    if (Math.abs(was - now) < 0.01) return line;
    const bold = /^\s*\*/.test(m[1]) ? '*' : '';
    const nl = m[1].replace(/\*+$/, '') + bold + k[1] + ': ' + usd(now) + bold + (/budget/i.test(m[4]) ? m[4].replace(/^\**/, '') : '');
    changed.push({ line: m[2].trim(), was, now });
    return nl;
  });
  return { text: out.join('\n'), changed };
}

const PDF_RE = /https?:\/\/[^\s<>|"]*\/proposals\/(bevvi-proposal[\w.-]*\.pdf)/;

module.exports = { check, fixTotals, printedAddress, linesStore, PDF_RE };
