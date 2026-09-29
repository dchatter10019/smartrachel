// Spirit type of a product name: 'tequila' | 'rum' | 'vodka' | 'gin' | 'whiskey' | 'mezcal' | 'cognac' | ''.
// Basket lines carry only category 'spirits' and names like "Patron Silver" / "Casamigos Blanco" never
// say tequila, so a type word in the name wins, then the brand. Used to find WHICH basket line a
// replacement stands in for when the LLM doesn't say (Sep 29: Casamigos went in at 1 bottle instead
// of replacing the 4 Patron).
const WORDS = [
  ['mezcal', /\bmezcal\b/], ['tequila', /\btequila\b/], ['vodka', /\bvodka\b/], ['gin', /\bgin\b/],
  ['rum', /\b(rum|rhum)\b/], ['whiskey', /\b(whiske?y|bourbon|scotch|rye)\b/], ['cognac', /\b(cognac|brandy|armagnac)\b/],
];
const BRANDS = {
  tequila: ['patron', 'don julio', 'casamigos', 'clase azul', 'espolon', 'herradura', 'jose cuervo', 'mi campo', '1800', 'hornitos',
    'milagro', 'cazadores', 'el jimador', 'teremana', 'lunazul', 'olmeca', 'altos', 'avion', 'cazcanes', 'fortaleza', 'tres generaciones', 'codigo'],
  rum: ['bacardi', 'mount gay', 'captain morgan', 'malibu', 'kraken', 'diplomatico', 'appleton', 'havana club', 'sailor jerry',
    'myers', 'goslings', 'plantation', 'ron zacapa', 'zacapa', 'flor de cana', 'brugal', 'cruzan', 'barrell craft spirits cask strength rum'],
  vodka: ['grey goose', 'ketel one', 'belvedere', "tito's", 'titos', 'absolut', 'ciroc', 'stolichnaya', 'smirnoff', 'chopin', 'svedka', 'deep eddy'],
  gin: ['hendrick', 'tanqueray', 'bombay', 'beefeater', 'aviation', 'monkey 47', 'the botanist', 'plymouth', 'roku', 'drumshanbo', 'nolet'],
  whiskey: ['macallan', 'glenlivet', 'glenfiddich', 'lagavulin', 'laphroaig', 'johnnie walker', 'jameson', 'bushmills', "maker's mark",
    'makers mark', 'buffalo trace', 'woodford', 'bulleit', 'knob creek', 'jack daniel', 'jim beam', 'wild turkey', 'four roses',
    'crown royal', 'high west', 'elijah craig', 'angel\'s envy', 'basil hayden', 'blanton', 'eagle rare', '1792', 'balvenie', 'dalmore', 'redbreast'],
  cognac: ['hennessy', 'remy martin', 'courvoisier', 'martell'],
};
function spiritType(name) {
  const n = ' ' + String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') + ' ';
  for (const [t, re] of WORDS) if (re.test(n)) return t;
  for (const [t, list] of Object.entries(BRANDS)) if (list.some(b => n.includes(' ' + b + ' ') || n.includes(' ' + b + '-') || n.startsWith(' ' + b))) return t;
  return '';
}
module.exports = { spiritType };
