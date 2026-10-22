export default async function main(args) {
  // ParseRequest v1.5 — deterministic reader of the customer's request.
  // Input : customer_text — ALL the customer's messages so far, joined with spaces.
  // Output: hours_detected, drinks_per_person_detected, mocktails_requested,
  //         mocktails_named, mocktail_mixers_json, next_action, ask_text, build_text, wine_lean, mix_bias.
  var raw = String((args.inputVars && args.inputVars.customer_text) || "");
  var t = " " + raw.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ") + " ";

  var NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  function toNum(s) {
    s = String(s || "").trim();
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    if (NUM[s] !== undefined) return NUM[s];
    return 0;
  }
  var numWords = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|an|a";

  // ---- DURATION (hours) ----
  var hours = 0;
  var m;
  var reH = new RegExp("(\\d+(?:\\.\\d+)?|" + numWords + ")\\s*(?:-|\\s)?\\s*(?:and a half\\s*)?(hours?|hrs?|hr)\\b", "g");
  var best = 0;
  while ((m = reH.exec(t)) !== null) {
    var n = toNum(m[1]);
    if (n > 0 && n <= 24) {
      if (/and a half/.test(m[0])) n += 0.5;
      // ignore ratios like "1 drink per hour"
      var before = t.slice(Math.max(0, m.index - 12), m.index);
      if (/(per|a|each|an)\s*$/.test(before) && /^(a|an|one|1)$/.test(m[1])) continue;
      best = Math.max(best, n);
    }
  }
  hours = best;
  if (!hours) { // "half a day" / "all day"
    if (/\bhalf (a )?day\b/.test(t)) hours = 4;
  }
  if (!hours) { // clock range: "5 to 7 pm", "5pm-9pm", "from 6:30 to 9"
    var reR = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g;
    var r;
    while ((r = reR.exec(t)) !== null) {
      if (!r[3] && !r[6]) { if (!/\b(from|between|event|party|open bar|happy hour)\b/.test(t.slice(Math.max(0, r.index - 25), r.index))) continue; }
      var h1 = parseInt(r[1]) % 12 + 0, h2 = parseInt(r[4]) % 12 + 0;
      var a1 = r[3] || r[6] || "pm", a2 = r[6] || r[3] || "pm";
      var s1 = h1 + (a1 === "pm" ? 12 : 0) + (r[2] ? parseInt(r[2]) / 60 : 0);
      var s2 = h2 + (a2 === "pm" ? 12 : 0) + (r[5] ? parseInt(r[5]) / 60 : 0);
      var d = s2 - s1; if (d <= 0) d += 24;
      if (d > 0 && d <= 16) { hours = d; break; }
    }
  }

  // ---- DRINKS PER PERSON ----
  var dpp = 0;
  var reD = new RegExp("(\\d+(?:\\.\\d+)?|" + numWords.replace("|an|a", "") + ")\\s*(?:drinks?|cocktails?|servings?)?\\s*(?:per|a|each|/|for each)\\s*(?:person|guest|head|attendee)", "g");
  while ((m = reD.exec(t)) !== null) { var dn = toNum(m[1]); if (dn > 0 && dn <= 20) dpp = dn; }
  var reD2 = /(\d+(?:\.\d+)?)\s*(?:drinks?)\s*(?:each|pp)\b/g;
  while ((m = reD2.exec(t)) !== null) { var dn2 = parseFloat(m[1]); if (dn2 > 0 && dn2 <= 20) dpp = dn2; }

  // ---- MOCKTAILS ----
  // v1.2: "no mocktails" / "without mocktails" / "don't need mocktails" is a refusal, not a request.
  // v1.5: "skip the mocktails" too; mix_bias reads "heavy on the spirits" (the "the" stopped it) (only "any" was allowed between the verb and the word).
  var negMock = /\b(no|not|without|skip|don'?t (need|want)|do not (need|want)|zero|nor)\s+(any\s+|the\s+)?(mock-?tails?|virgin (cocktails?|drinks?)|non-?alcoholic (cocktails?|drinks?))/.test(t);
  var tPos = negMock ? t.replace(/\b(no|not|without|skip|don'?t (need|want)|do not (need|want)|zero|nor)\s+(any\s+|the\s+)?(mock-?tails?|virgin (cocktails?|drinks?)|non-?alcoholic (cocktails?|drinks?))/g, " ") : t;
  var requested = /mock-?tails?|virgin (cocktails?|drinks?|mojitos?|mules?)|non-?alcoholic cocktails?|zero-?proof (cocktails?|drinks?)/.test(tPos);
  var MOCKS = [
    { name: "virgin mojito", re: /virgin mojitos?|mojito mocktail|mocktail mojito/, mixers: ["Lime Juice", "Club Soda", "Mint", "Simple Syrup"] },
    { name: "virgin Moscow mule", re: /virgin (moscow )?mules?|moscow mule mocktail/, mixers: ["Ginger Beer", "Lime Juice"] },
    { name: "Shirley Temple", re: /shirley temples?/, mixers: ["Ginger Ale", "Grenadine"] },
    { name: "cranberry spritzer", re: /cranberry (spritz|spritzers?)/, mixers: ["Cranberry Juice", "Lime Juice", "Club Soda"] },
    { name: "sparkling citrus lemonade", re: /(sparkling )?(citrus )?lemonade/, mixers: ["Lemonade", "Orange Juice", "Club Soda"] },
    { name: "ginger-mint cooler", re: /ginger[- ]mint cooler/, mixers: ["Ginger Beer", "Mint", "Lime Juice"] },
    { name: "arnold palmer", re: /arnold palmers?/, mixers: ["Iced Tea", "Lemonade"] },
    { name: "virgin pina colada", re: /virgin pi(n|ñ)a coladas?/, mixers: ["Pineapple Juice", "Coconut Cream"] }
  ];
  var named = [], mixers = [];
  function addMixer(x) { if (mixers.indexOf(x) < 0) mixers.push(x); }
  for (var i = 0; i < MOCKS.length; i++) {
    if (MOCKS[i].re.test(t)) { named.push(MOCKS[i].name); for (var j = 0; j < MOCKS[i].mixers.length; j++) addMixer(MOCKS[i].mixers[j]); }
  }
  // explicit mixer-style lists ("citrus and berry mocktails") count as a choice
  var styleNamed = /(citrus|berry|tropical|herb|ginger|mint|basil)[- ]?(based|infused|flavou?red)?\s*(and|,|&)?\s*(citrus|berry|tropical|herb|ginger|mint|basil)?\s*mock-?tails?/.test(t);
  var youPick = /(you pick|you choose|you decide|your (call|choice|pick|recommendation)|whatever you (recommend|suggest|think)|surprise me|up to you|standard (ones|mocktails?)|any(thing)? (is )?fine)/.test(t);
  if (requested && named.length === 0 && (youPick || styleNamed)) {
    named = ["cranberry spritzer", "sparkling citrus lemonade"];
    mixers = ["Cranberry Juice", "Lime Juice", "Club Soda", "Lemonade", "Orange Juice"];
  }
  var mixersJson = JSON.stringify(mixers.map(function (x) { return { search: x, role: "mixer" }; }));

  // ---- NEXT ACTION ----
  var needHours = !(hours > 0) && !(dpp > 0);
  var needMock = requested && named.length === 0;
  var next = "BUILD";
  if (needHours && needMock) next = "ASK_HOURS_AND_MOCKTAILS";
  else if (needHours) next = "ASK_HOURS";
  else if (needMock) next = "ASK_MOCKTAILS";

  var Q_HOURS = "How many hours will your event run?";
  var Q_MOCK = "Which mocktails would you like? Popular picks: virgin mojitos, virgin Moscow mules, Shirley Temples, cranberry spritzers, sparkling citrus lemonade, ginger-mint coolers.";
  var askText = "";
  if (next === "ASK_HOURS_AND_MOCKTAILS") askText = Q_HOURS + "\n\n" + Q_MOCK;
  else if (next === "ASK_HOURS") askText = Q_HOURS;
  else if (next === "ASK_MOCKTAILS") askText = Q_MOCK;

  // wine_lean: "white" / "red" when the customer wants more of one colour
  var wineLean = "";
  if (/(more|mostly|mainly|heavier on|heavy on|lean(ing)? (toward|towards)?|prefer(ably)?|rather|majority)\s+(of\s+)?(the\s+)?white|white[- ]heavy|(more|mostly|mainly)\s+white|\bwhite (wine )?(over|than) red|\bless red\b/.test(t)) wineLean = "white";
  else if (/(more|mostly|mainly|heavier on|heavy on|prefer(ably)?|majority)\s+(of\s+)?(the\s+)?red|red[- ]heavy|\bred (wine )?(over|than) white|\bless white\b/.test(t)) wineLean = "red";

  // mix_bias: which category the customer wants MORE of. "beer>wine" = more beer than wine; "spirits" = more liquor.
  var mixBias = "";
  var CATW = "(beers?|wines?|spirits?|liquors?|booze|hard alcohol)";
  function catOf(w) { w = String(w || ""); if (/^beer/.test(w)) return "beer"; if (/^wine/.test(w)) return "wine"; return "spirits"; }
  if (!/\d+\s*%|percent/.test(t)) {
    var pm = t.match(new RegExp("(?:more|heavier on|heavy on|mostly|mainly|bigger|larger share of|emphasi[sz]e|focus on)\\s+" + CATW + "\\s+(?:than|over|vs\\.?|versus|compared to)\\s+" + CATW)) || t.match(new RegExp("\\b" + CATW + "\\s+(?:over|more than)\\s+" + CATW));
    if (pm && catOf(pm[1]) !== catOf(pm[2])) mixBias = catOf(pm[1]) + ">" + catOf(pm[2]);
    else {
      var sm = t.match(new RegExp("(?:add(?:ing)? more|more|extra|heavy on|heavier on|mostly|mainly|focus on|emphasi[sz]e|lean(?:ing)? (?:toward|towards|on))\\s+(?:the\\s+)?" + CATW)) || t.match(new RegExp("\\b" + CATW + "[- ]heavy"));
      if (sm) mixBias = catOf(sm[1]);
    }
  }

  return {
    outputVars: {
      mix_bias: mixBias,
      wine_lean: wineLean,
      hours_detected: hours > 0 ? String(hours) : "",
      drinks_per_person_detected: dpp > 0 ? String(dpp) : "",
      mocktails_requested: requested ? "true" : "false",
      mocktails_named: named.join(", "),
      mocktail_mixers_json: requested && named.length ? mixersJson : "",
      next_action: next,
      ask_text: askText,
      build_text: next === "BUILD" ? "Great — I've got everything I need! I'm building your custom package now — this usually takes under a minute, so hang tight and I'll drop the full breakdown right here." : ""
    }
  };
}
