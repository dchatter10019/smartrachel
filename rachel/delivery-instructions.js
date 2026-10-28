// Delivery instructions are for the DRIVER only (DC, Oct 28). claude.ai sent rachel_place_order delivery_instructions =
// "Company: Google. Call Diana Orozco at 415-629-2488 when you arrive. Replaces unpaid orders BEVVI-AI-INFO-20261028-031625
// and BEVVI-AI-INFO-20261028-032100." — the company belongs in the company field, and order bookkeeping (order numbers,
// "replaces ...", "ice swapped to ...") never goes to the driver. Cleaned in code on every channel (shopping-agent
// place_order) and in the connector's order summary; every removal is logged by the caller.

const COMPANY = /(?:^|[.;\n]\s*)(?:company|company name|business|organi[sz]ation|client)\s*[:\-–]\s*([^.;\n]{2,60}?)\s*(?=[.;\n]|$)/i;
// A sentence about OTHER orders or what changed — not something a driver acts on.
const BOOKKEEPING = /\bBEVVI-[A-Z0-9-]+|\b(?:replac\w*|supersed\w*|cancel\w*|duplicate|re-?placed|re-?order\w*)\b[^.;\n]{0,40}\border|\border\b[^.;\n]{0,30}\b(?:unpaid|not (?:yet )?paid)|\b(?:swapp?ed|switched|changed|updated|revised)\b[^.;\n]{0,40}\b(?:to|for|from)\b|\bprevious (?:order|version)\b|\bupdated order\b/i;

function clean(text) {
  let t = String(text || '').trim();
  const out = { text: '', company: '', removed: [] };
  if (!t) return out;
  const cm = t.match(COMPANY);
  if (cm) { out.company = cm[1].trim().replace(/^["']|["']$/g, ''); t = t.replace(cm[0], cm[0].match(/^[.;\n]/) ? cm[0][0] : ''); out.removed.push('company "' + out.company + '"'); }
  const parts = t.split(/(?<=[.;!])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const kept = [];
  for (const s of parts) {
    if (BOOKKEEPING.test(s)) out.removed.push(JSON.stringify(s));
    else kept.push(s);
  }
  out.text = kept.join(' ').replace(/^[\s.;,–-]+/, '').replace(/\s{2,}/g, ' ').trim();
  return out;
}

module.exports = { clean };
