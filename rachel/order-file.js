// order-file.js — an order list sent as a FILE (DC, Oct 22: "email a google sheet with all the products they need, or a
// pdf that needs to be parsed and orders created"). Every channel that reaches /chat (email attachments, Slack files,
// WhatsApp media, a Google Sheets link in any message, rachel_chat on the connector).
// Spreadsheets (CSV, Excel .xlsx, a Google Sheet) are read IN CODE (rule 6: quantities must be reliable): a header row
// names the product / quantity / size columns, blank-quantity rows are skipped (an order form lists every product) and
// every skipped row is logged with its reason. PDFs and photos go to Claude (server.js transcribeOrderImages), as before.
// The result is plain "<qty> x <product> <size>" lines — the same list a customer types, so the email quote, email
// order, original-compare and custom_list paths all take it unchanged.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHEET_LINK = /https?:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]{20,})[^\s<>)"']*/gi;
const SHEET_MEDIA = /^(text\/csv|text\/comma-separated-values|application\/csv|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel)$/i;

function kindOf(f) {
  const t = String(f.media_type || '').toLowerCase(), n = String(f.name || '').toLowerCase();
  if (/\.csv$/.test(n) || /csv/.test(t)) return 'csv';
  if (/\.xlsx$/.test(n) || /spreadsheetml/.test(t)) return 'xlsx';
  if (/\.xls$/.test(n) || t === 'application/vnd.ms-excel') return 'xls';   // old binary Excel: not readable here, asked to resend
  if (/\.pdf$/.test(n) || t === 'application/pdf') return 'pdf';
  if (/^image\//.test(t)) return 'image';
  return '';
}

// ── CSV ──
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(x => x.trim()));
}

// ── XLSX (a zip of XML; read with the system unzip — no npm package) ──
const xmlText = s => String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
function colIndex(ref) {
  const m = String(ref).match(/^([A-Z]+)/); if (!m) return -1;
  let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseXlsx(buf) {
  const tmp = path.join(os.tmpdir(), 'rachel-xlsx-' + process.pid + '-' + Date.now() + '.xlsx');
  fs.writeFileSync(tmp, buf);
  const read = (member) => { try { return execFileSync('unzip', ['-p', tmp, member], { maxBuffer: 50 * 1024 * 1024 }).toString('utf8'); } catch (e) { return ''; } };
  try {
    const shared = [];
    for (const si of read('xl/sharedStrings.xml').match(/<si\b[\s\S]*?<\/si>/g) || []) {
      shared.push((si.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map(xmlText).join(''));
    }
    // The first sheet in the workbook's order (its r:id -> the rels target); sheet1.xml when that can't be read.
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const wb = read('xl/workbook.xml'), rels = read('xl/_rels/workbook.xml.rels');
    const first = wb.match(/<sheet\b[^>]*r:id="([^"]+)"/);
    if (first) {
      const rel = (rels.match(new RegExp('<Relationship\\b[^>]*Id="' + first[1] + '"[^>]*>')) || [''])[0].match(/Target="([^"]+)"/);
      if (rel) sheetPath = rel[1].startsWith('/') ? rel[1].slice(1) : 'xl/' + rel[1].replace(/^\.\//, '');
    }
    const sheet = read(sheetPath);
    const rows = [];
    for (const r of sheet.match(/<row\b[\s\S]*?<\/row>/g) || []) {
      const out = [];
      for (const c of r.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = (c.match(/\br="([A-Z]+\d+)"/) || [])[1], t = (c.match(/\bt="(\w+)"/) || [])[1];
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (t === 's') val = shared[+v] || '';
        else if (t === 'inlineStr') val = (c.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map(xmlText).join('');
        else if (v != null) val = xmlText(v);
        const i = ref ? colIndex(ref) : out.length;
        while (out.length < i) out.push('');
        out[i] = String(val).trim();
      }
      rows.push(out);
    }
    return rows;
  } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}

// ── rows -> list lines ──
const H_PRODUCT = /^(product|products|product name|item|items|item name|item description|description|name|brand|wine|wines|beer|beers|spirit|spirits|liquor|beverage|beverages|drink|drinks|sku name|label)\b/i;
const H_QTY = /^(qty|qty\.|quantity|quantities|units?|count|#|no\.?|number|order qty|order quantity|bottles?|cans?|cases?|amount|how many|need|order)\b/i;
const H_SIZE = /^(size|bottle size|unit size|volume|format|pack|pack size|ml|container)\b/i;
const H_SKIP = /^(price|unit price|cost|total|subtotal|amount \$|\$|notes?|comments?|category|type|sku|upc|vendor|supplier|link|url)\b/i;
const TOTAL_ROW = /^(sub)?total\b|^grand total|^tax\b|^tip\b|^delivery\b|^shipping\b/i;
const NUM = s => { const m = String(s || '').replace(/,/g, '').match(/^\s*(\d+(?:\.\d+)?)\s*(?:x|bottles?|btls?|cans?|cases?|cs|units?|ea|each|pcs?)?\s*$/i); return m ? +m[1] : null; };

function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i] || [];
    const prod = r.findIndex(c => H_PRODUCT.test(c) && !H_SKIP.test(c));
    const qty = r.findIndex((c, j) => j !== prod && H_QTY.test(c) && !/\$|price/i.test(c));
    if (prod >= 0 || (qty >= 0 && r.filter(Boolean).length >= 2)) {
      return { at: i, prod, qty, size: r.findIndex((c, j) => j !== prod && j !== qty && H_SIZE.test(c)), qtyLabel: qty >= 0 ? r[qty] : '' };
    }
  }
  return null;
}

// -> { lines: ["3 x Tito's Handmade Vodka 750ml", ...], skipped: [{row, why}], header: bool }
function rowsToList(rows) {
  rows = (rows || []).filter(r => r && r.some(c => String(c || '').trim()));
  const lines = [], skipped = [];
  if (!rows.length) return { lines, skipped, header: false };
  const h = findHeader(rows);
  let body = rows, prodCol = -1, qtyCol = -1, sizeCol = -1, perCase = false;
  if (h) {
    body = rows.slice(h.at + 1); prodCol = h.prod; qtyCol = h.qty; sizeCol = h.size; perCase = /^cases?\b/i.test(h.qtyLabel);
    if (prodCol < 0) {
      // No product header: the column with the most words in it.
      const score = j => body.reduce((n, r) => n + ((r[j] && /[a-z]{3}/i.test(r[j]) && NUM(r[j]) == null) ? 1 : 0), 0);
      const width = Math.max(...body.map(r => r.length));
      let best = -1; for (let j = 0; j < width; j++) if (j !== qtyCol && j !== sizeCol && (best < 0 || score(j) > score(best))) best = j;
      prodCol = best;
    }
  }
  for (const r of body) {
    let name, qty = null, size = '';
    if (h) {
      name = String(r[prodCol] || '').trim();
      if (qtyCol >= 0) qty = NUM(r[qtyCol]);
      if (sizeCol >= 0) size = String(r[sizeCol] || '').trim();
      if (qtyCol >= 0 && qty == null && String(r[qtyCol] || '').trim()) { skipped.push({ row: r.join(' | '), why: 'quantity not a number' }); continue; }
      if (qtyCol >= 0 && !qty) { if (name) skipped.push({ row: r.join(' | '), why: 'no quantity' }); continue; }
      if (qtyCol < 0) qty = 1;
    } else {
      // No header: the first plain number is the quantity, the longest text is the product.
      const cells = r.map(c => String(c || '').trim()).filter(Boolean);
      const qi = cells.findIndex(c => NUM(c) != null && !/\$/.test(c));
      qty = qi >= 0 ? NUM(cells[qi]) : 1;
      name = cells.filter((c, j) => j !== qi && !/^\$|\$\s*$/.test(c) && /[a-z]/i.test(c)).sort((a, b) => b.length - a.length)[0] || '';
      // A typed list line in one cell ("3 x Tito's 750ml") is already a line.
      if (cells.length === 1 && /^\s*\d+\s*(x|×)\s+\S/i.test(cells[0])) { lines.push(cells[0]); continue; }
    }
    if (!name) { skipped.push({ row: r.join(' | '), why: 'no product name' }); continue; }
    if (TOTAL_ROW.test(name)) { skipped.push({ row: r.join(' | '), why: 'a total / fee row' }); continue; }
    if (qty > 9999 || qty !== Math.round(qty)) { skipped.push({ row: r.join(' | '), why: 'quantity ' + qty + ' not a whole count' }); continue; }
    const withSize = size && !name.toLowerCase().includes(size.toLowerCase()) ? name + ' ' + size : name;
    lines.push(perCase ? (qty === 1 ? 'a case of ' : qty + ' cases of ') + withSize : qty + ' x ' + withSize);
  }
  return { lines, skipped, header: !!h };
}

// ── Google Sheets ──
function sheetLinksIn(text) {
  const out = [], seen = new Set();
  for (const m of String(text || '').matchAll(SHEET_LINK)) {
    if (seen.has(m[1])) continue; seen.add(m[1]);
    const gid = (m[0].match(/[#&?]gid=(\d+)/) || [])[1] || '';
    out.push({ id: m[1], gid, url: m[0] });
  }
  return out;
}
// A sheet shared "anyone with the link" exports as CSV with no sign-in. A private sheet shared with rachelai@ needs the
// Sheets read scope on the service account's domain-wide delegation (not granted as of Oct 22 — the export then returns
// Google's sign-in page and the customer is asked to share it). -> { ok, csv, via } | { ok:false, why }
async function fetchSheetCsv(link, timeoutMs = 15000) {
  const url = 'https://docs.google.com/spreadsheets/d/' + link.id + '/export?format=csv' + (link.gid ? '&gid=' + link.gid : '');
  const get = async (headers) => {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
      const body = await r.text();
      const html = /text\/html/i.test(r.headers.get('content-type') || '') || /^\s*<!doctype html|^\s*<html/i.test(body);
      return r.ok && !html ? body : null;
    } finally { clearTimeout(t); }
  };
  try {
    const pub = await get({});
    if (pub != null) return { ok: true, csv: pub, via: 'public link' };
  } catch (e) { console.log('[order-file] sheet ' + link.id.slice(0, 10) + '… public export failed: ' + e.message); }
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ keyFile: '/home/ubuntu/config/gmail-service-account.json', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'], clientOptions: { subject: 'rachelai@getbevvi.com' } });
    const tok = (await (await auth.getClient()).getAccessToken()).token;
    const priv = tok ? await get({ Authorization: 'Bearer ' + tok }) : null;
    if (priv != null) return { ok: true, csv: priv, via: 'shared with rachelai@' };
    return { ok: false, why: 'not shared' };
  } catch (e) {
    return { ok: false, why: /unauthorized_client/.test(e.message) ? 'not shared (private sheets need the Sheets scope on the service account)' : 'error: ' + e.message.slice(0, 80) };
  }
}

const SHARE_ASK = "I couldn't open the Google Sheet you sent — it isn't shared with me. Could you set its sharing to \"Anyone with the link can view\" and send the link again? Or attach it as an Excel, CSV or PDF file, and I'll put the order together right away.";

module.exports = { kindOf, parseCsv, parseXlsx, rowsToList, sheetLinksIn, fetchSheetCsv, SHEET_MEDIA, SHARE_ASK };
