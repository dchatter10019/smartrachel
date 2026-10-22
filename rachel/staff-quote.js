// A bartender / mixologist / sommelier PRICE or QUOTE request (DC, Oct 21 — the Voiceflow agent's PRIORITY 0-STAFF-QUOTE,
// prompt v6.40). Rachel cannot price staff and never invents a figure: the reply is fixed, and ONE alert email per
// conversation goes to bevvi-support + the customer so the team follows up. A beverage request in the same message is
// still built (the alert is added to that reply). QA identities: logged, never sent.
const STAFF = /\b(bartend\w*|bar[- ]?tenders?|mixologists?|sommeliers?|bar[- ]?staff|bar[- ]?backs?|servers? for the bar)\b/i;
const PRICE = /\b(price|prices|pricing|priced|cost|costs|costing|rates?|quotes?|quoted|how much|fees?|charges?|estimate|ballpark)\b/i;

// Staff we don't need to price: the customer's own ("we have our own bartender, what's the price of Tito's?").
const OWN = /\b(our own|we have|we've got|we'll have|we already have|have our|bringing our|bring our)\s+(?:\w+\s+){0,2}(bartend\w*|bar[- ]?tenders?|mixologists?|sommeliers?|bar[- ]?staff)/i;

function staffQuoteAsk(msg) {
  // The staff word and the price word in the SAME sentence ("how much is a bartender?", "quote with a bartender").
  const s = String(msg || '').split(/[.?!\n]+/).find(x => STAFF.test(x) && PRICE.test(x) && !OWN.test(x));
  if (!s) return null;
  const w = (s.match(STAFF) || [''])[0].toLowerCase();
  const word = /mixolog/.test(w) ? 'mixologist' : /sommelier/.test(w) ? 'sommelier' : 'bartender';
  return { word };
}

function reply(word) {
  return 'I\'m not able to provide ' + (word || 'bartender') + ' pricing myself, but I\'ve alerted Bevvi Support and someone from the team will contact you with more information.';
}

// facts: { customerEmail, location, guests, hours, date, menu, message }
function alertEmail(word, facts) {
  const f = facts || {};
  const W = (word || 'bartender').replace(/^./, c => c.toUpperCase());
  const to = ['bevvi-support@getbevvi.com'].concat(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(f.customerEmail || '')) ? [String(f.customerEmail)] : []);
  const subject = W + ' Quote Request: ' + (f.guests ? f.guests + ' guests' : 'guest count not given') + ' - ' + (f.location || 'location not given');
  const body = [
    'Customer: ' + (f.customerEmail || 'not given'),
    'Location: ' + (f.location || 'not given'),
    'Guest count: ' + (f.guests || 'not given'),
    'Hours: ' + (f.hours || 'not given'),
    'Event date/time: ' + (f.date || 'not given'),
    f.menu ? 'Menu: ' + f.menu : '',
    'Customer\'s words: "' + String(f.message || '').slice(0, 500) + '"',
    '',
    'Customer asked for a ' + (word || 'bartender') + ' price/quote — please contact the customer.'
  ].filter(x => x !== '').join('\n');
  return { to, subject, body };
}

module.exports = { staffQuoteAsk, reply, alertEmail };
