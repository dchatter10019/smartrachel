// Unit tests for order-file.js — order lists sent as files (DC, Oct 22): CSV / Excel / Google Sheets rows read in code
// into "<qty> x <product>" lines; blank-quantity, total and unreadable rows skipped with a reason. (precheck runs these.)
const OF = require('../../order-file.js');
const fs = require('fs');
let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok ? '' : '\n      got:  ' + JSON.stringify(got) + '\n      want: ' + JSON.stringify(want)));
}
const L = csv => OF.rowsToList(OF.parseCsv(csv)).lines;

eq('header product/qty/size', L('Product,Size,Qty\nTito\'s Handmade Vodka,750ml,3\nStella Artois,12 x 11.2 oz,2\n'), ["3 x Tito's Handmade Vodka 750ml", '2 x Stella Artois 12 x 11.2 oz']);
eq('order form: blank qty rows skipped', L('Item,Quantity\nVeuve Clicquot,2\nMoet,\nLa Marca Prosecco,0\n'), ['2 x Veuve Clicquot']);
eq('title row above the header', L('Smith wedding drinks,,\n,,\nDescription,Qty,Price\nCasamigos Blanco,4,$55\n'), ['4 x Casamigos Blanco']);
eq('size already in the name is not repeated', L('Name,Size,Qty\nTito\'s 750ml,750ml,2\n'), ["2 x Tito's 750ml"]);
eq('quoted cells with commas', L('Product,Qty\n"Fever-Tree Ginger Beer, 4 pack",6\n'), ['6 x Fever-Tree Ginger Beer, 4 pack']);
eq('a Cases column -> cases of', L('Beer,Cases\nStella Artois,2\nModelo,1\n'), ['2 cases of Stella Artois', 'a case of Modelo']);
eq('total / fee rows skipped', L('Product,Qty\nTito\'s,2\nSubtotal,2\nDelivery,1\n'), ["2 x Tito's"]);
eq('"12 bottles" quantity', L('Wine,Bottles\nWhispering Angel,12 bottles\n'), ['12 x Whispering Angel']);
eq('no qty column -> 1 each', L('Product\nAperol\nCampari\n'), ['1 x Aperol', '1 x Campari']);
eq('no header: number + name', L('3,Tito\'s Handmade Vodka\n2,Hendrick\'s Gin\n'), ["3 x Tito's Handmade Vodka", "2 x Hendrick's Gin"]);
eq('no header: typed list lines', L('3 x Tito\'s 750ml\n2 x Stella\n'), ["3 x Tito's 750ml", '2 x Stella']);
const odd = OF.rowsToList(OF.parseCsv('Product,Qty\nTito\'s,a few\nAperol,2\n'));
eq('a quantity that is not a number is skipped and reported', [odd.lines, odd.skipped.map(x => x.why)], [['2 x Aperol'], ['quantity not a number']]);
eq('empty sheet', L(''), []);
eq('BOM + CRLF', L('﻿Product,Qty\r\nAperol,2\r\n'), ['2 x Aperol']);

const x = OF.rowsToList(OF.parseXlsx(fs.readFileSync(__dirname + '/fixtures/order-list.xlsx')));
eq('xlsx: first sheet via workbook rels, shared strings, blank qty + subtotal skipped', x.lines, ["3 x Tito's Handmade Vodka 750ml", '6 x Whispering Angel Rosé 750ml']);
eq('xlsx: skipped reasons', x.skipped.map(s => s.why), ['no quantity', 'a total / fee row']);

eq('sheet link + gid', OF.sheetLinksIn('here: https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=778 thanks'), [{ id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', gid: '778', url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=778' }]);
eq('Slack-wrapped link, deduped', OF.sheetLinksIn('<https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit> and https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345').length, 1);
eq('a Docs link is not a sheet', OF.sheetLinksIn('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit'), []);
eq('kinds', ['a.csv', 'b.XLSX', 'c.pdf', 'd.xls'].map(n => OF.kindOf({ name: n })).concat(OF.kindOf({ media_type: 'image/png' })), ['csv', 'xlsx', 'pdf', 'xls', 'image']);

if (failed) { console.log(failed + ' FAILED'); process.exit(1); }
console.log('all passed');
