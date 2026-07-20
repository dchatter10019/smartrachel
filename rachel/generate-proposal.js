/**
 * Bevvi Proposal Generator
 * Generates a PDF proposal from line_items
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BEVVI_RED = '#B71C1C';
const BEVVI_DARK = '#1A1A2E';

function groupByCategory(lineItems) {
  const groups = {};
  const categoryOrder = ['wine', 'spirits', 'beer', 'hard seltzer', 'soju', 'mixer', 'other'];
  
  lineItems.forEach(item => {
    const cat = (item.category || 'other').toLowerCase();
    const displayCat = cat.charAt(0).toUpperCase() + cat.slice(1);
    if (!groups[displayCat]) groups[displayCat] = [];
    groups[displayCat].push(item);
  });

  // Sort by category order
  const sorted = {};
  categoryOrder.forEach(c => {
    const key = c.charAt(0).toUpperCase() + c.slice(1);
    if (groups[key]) sorted[key] = groups[key];
  });
  Object.keys(groups).forEach(k => { if (!sorted[k]) sorted[k] = groups[k]; });
  return sorted;
}

function generateHTML(proposal) {
  const { client_name, event_date, line_items, notes } = proposal;
  const items = typeof line_items === 'string' ? JSON.parse(line_items) : line_items;
  const groups = groupByCategory(items);
  
  const grandTotal = items.reduce((sum, p) => sum + (p.qty * p.price), 0);
  
  let categorySections = '';
  Object.entries(groups).forEach(([cat, products]) => {
    const catTotal = products.reduce((sum, p) => sum + (p.qty * p.price), 0);
    const rows = products.map(p => `
      <tr>
        <td>${p.name || p.label || ''}</td>
        <td>${p.size || ''}</td>
        <td style="text-align:center">${p.qty}</td>
        <td style="text-align:right">$${parseFloat(p.price).toFixed(2)}</td>
        <td style="text-align:right">$${(p.qty * p.price).toFixed(2)}</td>
      </tr>`).join('');
    
    categorySections += `
      <tr class="cat-header">
        <td colspan="5">${cat.toUpperCase()}</td>
      </tr>
      <tr class="col-header">
        <td>NAME</td><td>SIZE</td><td style="text-align:center">QTY</td>
        <td style="text-align:right">UNIT PRICE</td><td style="text-align:right">TOTAL</td>
      </tr>
      ${rows}
      <tr class="cat-total">
        <td colspan="4"><strong>${cat} Total</strong></td>
        <td style="text-align:right"><strong>$${catTotal.toFixed(2)}</strong></td>
      </tr>`;
  });

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 12px; color: #333; padding: 40px; }
  .logo { color: ${BEVVI_RED}; font-size: 28px; font-weight: bold; margin-bottom: 20px; }
  .header-text { font-size: 13px; margin-bottom: 20px; color: #444; }
  .invoice-meta { display: flex; gap: 60px; margin-bottom: 24px; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd; padding: 12px 0; }
  .invoice-meta div { flex: 1; }
  .invoice-meta label { font-weight: bold; font-size: 11px; color: #666; display: block; margin-bottom: 4px; }
  .invoice-meta span { font-size: 13px; }
  h2 { font-size: 16px; margin-bottom: 12px; color: ${BEVVI_DARK}; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 0; }
  tr.cat-header td { background: ${BEVVI_RED}; color: white; font-weight: bold; font-size: 11px; padding: 6px 8px; }
  tr.col-header td { background: #f5f5f5; font-size: 10px; font-weight: bold; color: #555; padding: 5px 8px; border-bottom: 1px solid #ddd; }
  tbody tr td { padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 12px; }
  tbody tr:hover td { background: #fafafa; }
  tr.cat-total td { padding: 6px 8px; border-top: 1px solid #ddd; background: #f9f9f9; }
  .grand-total { margin-top: 20px; background: ${BEVVI_RED}; color: white; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; border-radius: 4px; }
  .grand-total .label { font-size: 14px; font-weight: bold; }
  .grand-total .amount { font-size: 20px; font-weight: bold; }
  .footer { margin-top: 20px; font-size: 10px; color: #888; font-style: italic; }
  .notes { margin-top: 16px; padding: 10px; background: #fff8e1; border-left: 3px solid #ffc107; font-size: 11px; }
</style>
</head>
<body>
  <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAAACXBIWXMAAAsTAAALEwEAmpwYAAAF8WlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMxNDAgNzkuMTYwNDUxLCAyMDE3LzA1LzA2LTAxOjA4OjIxICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6cGhvdG9zaG9wPSJodHRwOi8vbnMuYWRvYmUuY29tL3Bob3Rvc2hvcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RFdnQ9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZUV2ZW50IyIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ0MgKE1hY2ludG9zaCkiIHhtcDpDcmVhdGVEYXRlPSIyMDE5LTA0LTE3VDE1OjQ4OjExKzA1OjMwIiB4bXA6TW9kaWZ5RGF0ZT0iMjAxOS0wNC0xN1QxNzowMDo1NSswNTozMCIgeG1wOk1ldGFkYXRhRGF0ZT0iMjAxOS0wNC0xN1QxNzowMDo1NSswNTozMCIgZGM6Zm9ybWF0PSJpbWFnZS9wbmciIHBob3Rvc2hvcDpDb2xvck1vZGU9IjMiIHBob3Rvc2hvcDpJQ0NQcm9maWxlPSJzUkdCIElFQzYxOTY2LTIuMSIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDpjMjkxOTFjMS1hZTZmLTRiMzYtOTBlNS1jMDJiM2ZmNjEwYmMiIHhtcE1NOkRvY3VtZW50SUQ9ImFkb2JlOmRvY2lkOnBob3Rvc2hvcDplOTU1Y2E4Ny03MTQyLTIxNDMtODQ5YS00YmVhOTZmZTAxYTQiIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDpmZDUyOWQ4Mi1kMmFhLTQ4N2QtODE4Mi1kZDk2ZjQ4ZTQxNTkiPiA8eG1wTU06SGlzdG9yeT4gPHJkZjpTZXE+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJjcmVhdGVkIiBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOmZkNTI5ZDgyLWQyYWEtNDg3ZC04MTgyLWRkOTZmNDhlNDE1OSIgc3RFdnQ6d2hlbj0iMjAxOS0wNC0xN1QxNTo0ODoxMSswNTozMCIgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUGhvdG9zaG9wIENDIChNYWNpbnRvc2gpIi8+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJzYXZlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDpjMjkxOTFjMS1hZTZmLTRiMzYtOTBlNS1jMDJiM2ZmNjEwYmMiIHN0RXZ0OndoZW49IjIwMTktMDQtMTdUMTc6MDA6NTUrMDU6MzAiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCBDQyAoTWFjaW50b3NoKSIgc3RFdnQ6Y2hhbmdlZD0iLyIvPiA8L3JkZjpTZXE+IDwveG1wTU06SGlzdG9yeT4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz4DVUIdAAAeNElEQVR4nO2deZhU1bnu33dVdTdDo4gQHIlxAtm7ioY2GOd2eK5X1KBCVxfGIcfkxMxmvuY6XDRmODEnx1zjkGhyMmlXF+IQjYaTHCEOQZEW6KpiEJyTKIKigNLd1Xt95w/AtNh0d1WtXbWKXr/n8bG6au93fd2st9Za314DRQQOh6NvVKUDcDhsxhnE4egHZxCHox+cQRyOfnAGcTj6wRnE4egHZxCHox+cQRyOfnAGcTj6wRnE4egHZxCHox+cQRyOfnAGcTj6IVrpAPqC5Huv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" style="height:45px;margin-bottom:20px;" alt="Bevvi">
  <div class="header-text">
    <strong>Dear Valued Client,</strong><br>
    Please find below a Bevvi menu curated for your upcoming event. This proposal reflects beverage selections and quantities for your review.
  </div>
  <div class="invoice-meta">
    <div><label>Invoice From:</label><span>Bevvi</span></div>
    <div><label>Billed To:</label><span>${client_name || '—'}</span></div>
    <div><label>Event Date(s):</label><span>${event_date || '—'}</span></div>
  </div>
  <h2>Beverage Selection</h2>
  <table>
    <tbody>${categorySections}</tbody>
  </table>
  ${notes ? `<div class="notes">${notes}</div>` : ''}
  <div class="grand-total">
    <span class="label">TOTAL (inclusive of deposits and delivery)</span>
    <span class="amount">$${grandTotal.toFixed(2)}</span>
  </div>
  <div class="footer">This proposal is valid for 7 days. Prices may vary based on availability. Contact your Bevvi representative for questions.</div>
</body>
</html>`;
}

async function generateProposal(proposal, outputPath) {
  const html = generateHTML(proposal);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.pdf({
    path: outputPath,
    format: 'Letter',
    margin: { top: '20px', bottom: '20px', left: '20px', right: '20px' }
  });
  await browser.close();
  console.log('[proposal] Generated:', outputPath);
  return outputPath;
}

// CLI usage: node generate-proposal.js '<json>'
if (require.main === module) {
  const input = JSON.parse(process.argv[2] || '{}');
  const output = process.argv[3] || '/tmp/bevvi-proposal.pdf';
  generateProposal(input, output).then(() => console.log('Done:', output)).catch(console.error);
}

module.exports = { generateProposal };
