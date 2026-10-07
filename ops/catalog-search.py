#!/usr/bin/env python3
# Read-only catalog lookup for the nightly fixer (it may not curl): catalog-search.py <zip> <words...>
# -> name | size | price for up to 60 rows, the same search Rachel uses (client=bevvibot, zipcode=).
import sys, json, urllib.parse, urllib.request
if len(sys.argv) < 3: sys.exit('usage: catalog-search.py <zip> <words...>')
zp, q = sys.argv[1], ' '.join(sys.argv[2:])
import os   # CATALOG_API=getproducts: the getProducts API, as Rachel uses when set (rachel/catalog-api.js)
if os.environ.get('CATALOG_API', '').lower() == 'getproducts':
    url = os.environ.get('CATALOG_API_URL', 'https://dev-api-lb4.getbevvi.com') + '/api/corpproducts/getProducts?' + urllib.parse.urlencode({'zipcode': zp, 'name': q, 'page': 1, 'limit': 60})
else:
    url = 'https://api-client.getbevvi.com/api/corpproducts/searchCorpProducts?' + urllib.parse.urlencode({'zipcode': zp, 'searchBy': q, 'client': 'bevvibot', 'limit': 60})
d = json.load(urllib.request.urlopen(url, timeout=30))
rows = d if isinstance(d, list) else (d.get('data') or d.get('products') or [])
print('%d result(s) for %r at %s' % (len(rows), q, zp))
for r in rows: print('  %s | %s %s | $%s' % (r.get('name'), r.get('size', ''), r.get('units', ''), r.get('price', r.get('lowestPrice', ''))))
