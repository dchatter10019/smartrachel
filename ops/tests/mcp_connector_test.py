#!/usr/bin/env python3
"""Rachel MCP connector, end to end on the PUBLIC URL (mcp.getbevvi.com/rachel/mcp) with QA identities (no real email,
dry-run orders, no LLM tokens): OAuth sign-in as claude.ai does it, then the API-key path with the two-step order.
Run by qa/nightly.sh. Exit 1 on any failure."""
import sys
FAILS=[]
def oauth():
    import json, re, hashlib, base64, secrets, urllib.request, urllib.parse, http.client
    B='https://mcp.getbevvi.com'
    class NoRedir(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*a,**k): return None
    op=urllib.request.build_opener(NoRedir)
    def req(method,url,data=None,headers=None,form=False):
        h=dict(headers or {}); body=None
        if data is not None:
            if form: body=urllib.parse.urlencode(data).encode(); h['Content-Type']='application/x-www-form-urlencoded'
            else: body=json.dumps(data).encode(); h['Content-Type']='application/json'
        try: r=op.open(urllib.request.Request(url,data=body,headers=h,method=method),timeout=60); return r.status,dict(r.headers),r.read().decode()
        except urllib.error.HTTPError as e: return e.code,dict(e.headers),e.read().decode()
    prm=json.loads(req('GET',B+'/.well-known/oauth-protected-resource/rachel/mcp')[2]); asm=json.loads(req('GET',B+'/.well-known/oauth-authorization-server/rachel')[2])
    s,h,b=req('POST',asm['registration_endpoint'],{'redirect_uris':['https://claude.ai/api/mcp/auth_callback'],'client_name':'QA test client'}); cid=json.loads(b)['client_id']; print('register',s,cid[:6]+'…')
    ver=secrets.token_urlsafe(48); ch=base64.urlsafe_b64encode(hashlib.sha256(ver.encode()).digest()).rstrip(b'=').decode()
    q=urllib.parse.urlencode({'response_type':'code','client_id':cid,'redirect_uri':'https://claude.ai/api/mcp/auth_callback','code_challenge':ch,'code_challenge_method':'S256','state':'xyz','scope':'rachel','resource':prm['resource']})
    s,h,b=req('GET',asm['authorization_endpoint']+'?'+q); rid=re.search(r'name="req" value="([^"]+)"',b).group(1); print('authorize page',s,'has email form', 'type="email"' in b)
    s,h,b=req('POST',B+'/rachel/authorize/email',{'req':rid,'email':'qa-oauth@getbevvi.com'},form=True); print('email ->',s,'code form' if 'name="code"' in b else b[:200])
    s,h,b=req('POST',B+'/rachel/authorize/code',{'req':rid,'code':'000000'},form=True); print('wrong code ->',s,'Incorrect code' in b)
    code=json.load(open('/home/ubuntu/config/mcp-pending-verifications.json'))['qa-oauth@getbevvi.com']['code']
    s,h,b=req('POST',B+'/rachel/authorize/code',{'req':rid,'code':code},form=True); loc=h.get('Location',''); print('right code ->',s,loc.split('?')[0], 'state=xyz' in loc)
    ac=urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)['code'][0]
    s,h,b=req('POST',asm['token_endpoint'],{'grant_type':'authorization_code','code':ac,'client_id':cid,'redirect_uri':'https://claude.ai/api/mcp/auth_callback','code_verifier':'wrong'},form=True); print('token bad PKCE ->',s,json.loads(b)['error'])
    s,h,b=req('POST',asm['token_endpoint'],{'grant_type':'authorization_code','code':ac,'client_id':cid,'redirect_uri':'https://claude.ai/api/mcp/auth_callback','code_verifier':ver},form=True); print('token reused code ->',s,json.loads(b).get('error'))
    # fresh run for the happy path
    s,h,b=req('GET',asm['authorization_endpoint']+'?'+q); rid=re.search(r'name="req" value="([^"]+)"',b).group(1)
    req('POST',B+'/rachel/authorize/email',{'req':rid,'email':'qa-oauth@getbevvi.com'},form=True)
    code=json.load(open('/home/ubuntu/config/mcp-pending-verifications.json'))['qa-oauth@getbevvi.com']['code']
    s,h,b=req('POST',B+'/rachel/authorize/code',{'req':rid,'code':code},form=True); ac=urllib.parse.parse_qs(urllib.parse.urlparse(h['Location']).query)['code'][0]
    s,h,b=req('POST',asm['token_endpoint'],{'grant_type':'authorization_code','code':ac,'client_id':cid,'redirect_uri':'https://claude.ai/api/mcp/auth_callback','code_verifier':ver},form=True); tok=json.loads(b); print('token ->',s,tok['token_type'],tok['expires_in'],'refresh' if tok.get('refresh_token') else '')
    H={'Authorization':'Bearer '+tok['access_token'],'Accept':'application/json, text/event-stream'}
    s,h,b=req('POST',B+'/rachel/mcp',{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'t','version':'1'}}},H); print('mcp initialize with token ->',s,json.loads(b)['result']['serverInfo'])
    s,h,b=req('POST',B+'/rachel/mcp',{'jsonrpc':'2.0','id':2,'method':'tools/list'},H); print('tools ->',len(json.loads(b)['result']['tools']))
    s,h,b=req('POST',asm['token_endpoint'],{'grant_type':'refresh_token','refresh_token':tok['refresh_token'],'client_id':cid},form=True); t2=json.loads(b); print('refresh ->',s,'new token' if t2.get('access_token')!=tok['access_token'] else 'SAME')
    s,h,b=req('POST',asm['token_endpoint'],{'grant_type':'refresh_token','refresh_token':tok['refresh_token'],'client_id':cid},form=True); print('old refresh reused ->',s,json.loads(b).get('error'))
    s,h,b=req('POST',B+'/rachel/mcp',{'jsonrpc':'2.0','id':3,'method':'tools/list'},{'Authorization':'Bearer rat_forged'}); print('forged token ->',s)
def apikey():
    import json, secrets, urllib.request, sys
    KF='/home/ubuntu/config/mcp-api-keys.json'
    keys=json.load(open(KF))
    key=next((k for k,v in keys.items() if v['email']=='qa-mcp@getbevvi.com'),None)
    if not key:
        key='rmcp_'+secrets.token_hex(24); keys[key]={'email':'qa-mcp@getbevvi.com','verified':True,'createdAt':'2026-10-03T00:00:00Z','note':'QA identity (dry-run orders)'}
        json.dump(keys,open(KF,'w'),indent=2)
    URL='https://mcp.getbevvi.com/rachel/mcp'
    def call(method,params=None,id=1,accept='application/json, text/event-stream'):
        body={'jsonrpc':'2.0','method':method}
        if id is not None: body['id']=id
        if params is not None: body['params']=params
        req=urllib.request.Request(URL,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','Accept':accept})
        try:
            r=urllib.request.urlopen(req,timeout=200); t=r.read().decode(); ct=r.headers.get('Content-Type','')
        except urllib.error.HTTPError as e: return e.code,None
        if not t: return r.status,None
        if t.startswith('data:'): t=t.split('data:',1)[1].strip()
        return r.status,(json.loads(t),ct)
    def tool(name,args):
        s,(j,_)=call('tools/call',{'name':name,'arguments':args})
        return json.loads(j['result']['content'][0]['text']), j['result'].get('isError')
    s,(j,ct)=call('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'t','version':'1'}})
    print('initialize', s, j['result']['protocolVersion'], j['result']['serverInfo'], ct)
    print('notification ->', call('notifications/initialized',id=None)[0])
    s,(j,ct)=call('tools/list',accept='text/event-stream'); print('tools/list (SSE)', ct, [t['name'] for t in j['result']['tools']])
    tool('rachel_verify_age',{'confirmed':False})   # age checks survive restarts now: start this key unverified
    r,err=tool('rachel_search',{'products':["Tito's Handmade Vodka 1.75 L"],'zip':'10019'})
    print('search before age ->', 'held' if r.get('age_verification_required') else 'NOT HELD', '| isError:', err)
    print('verify_age ->', tool('rachel_verify_age',{'confirmed':True})[0])
    c,_=tool('rachel_chat',{'message':'hi','zip':'10019','session_id':'qa-mcp-age-pass'})
    print('chat after age ->', 'no re-ask' if '21' not in c.get('response','') else 'ASKED AGAIN', '|', c.get('response','')[:120].replace(chr(10),' '))
    r,_=tool('rachel_search',{'products':["Tito's Handmade Vodka 1.75 L"],'zip':'10019'})
    p=r['results'][0]['products'][0]; print('search ->', p['name'], p['price'])
    print('search urls ->', 'LEAKED' if ('productdetail' in json.dumps(r) or '"url"' in json.dumps(r)) else 'none')
    q,_=tool('rachel_build_package',{'guests':10,'budget':2000,'zip':'10019','categories':['beer','wine','spirits']})
    print('package intake ->', 'asks' if q.get('needs_info') and 'hours' in q.get('ask_customer','') else 'NO QUESTION', '|', q.get('ask_customer'))
    q,_=tool('rachel_build_package',{'guests':10,'hours':4,'budget':2000,'zip':'10019','categories':['beer','wine','spirits']})
    print('package mix question ->', 'asks' if q.get('needs_info') and 'drink most' in q.get('ask_customer','') else 'NO QUESTION', '|', q.get('ask_customer'))
    ck={'guests':20,'hours':3,'budget':1500,'zip':'10019','categories':['wine','cocktails'],'serving_mix':'mostly wine'}
    q,_=tool('rachel_build_package',dict(ck,cocktails=[]))
    print('package cocktail question ->', 'asks' if q.get('needs_info') and 'Margarita' in q.get('ask_customer','') else 'NO QUESTION')
    q,qerr=tool('rachel_build_package',dict(ck,cocktails=['Margarita','Paper Plane']))
    names=' '.join(li.get('name','') for li in (q.get('line_items') or [])).lower()
    # NYC carries no lime/lemon juice (Rachel's own cocktail scenario lists it unavailable too): a mixer counts when it is
    # a line OR reported unavailable — never silently gone.
    unav=str(q.get('unavailable','')).lower()
    print('package cocktails built ->', 'asks' if (not qerr and 'triple sec' in names and 'bourbon' in names and 'amaro' in names and all(m in names or m in unav for m in ('lime','lemon'))) else 'MISSING INGREDIENTS', '|', names[:300], '| unavailable:', unav[:120])
    b,berr=tool('rachel_build_package',{'guests':10,'hours':4,'budget':2000,'zip':'10019','categories':['beer','wine','spirits'],'serving_mix':'mostly wine'})
    print('package urls ->', 'ERROR' if (berr or not b.get('line_items')) else ('LEAKED' if ('productdetail' in json.dumps(b) or 'url' in json.dumps(b).replace('download_url','')) else 'none'), '| items', len(b.get('line_items') or []), '| total', b.get('product_total'))
    li=json.dumps([{'name':p['name'],'price':p['price'],'qty':2}])
    r,_=tool('rachel_place_order',{'line_items':li,'first_name':'Pat','last_name':'Example','phone':'212-555-0100','address':'425 W 53rd St, New York, NY 10019','zip':'10019','delivery_datetime':'next Tuesday at 3am ET'})
    print('prepare (3am) ->', r.get('ready'), r.get('problems'))
    r,_=tool('rachel_place_order',{'line_items':li,'first_name':'Pat','last_name':'Example','phone':'212-555-0100','customer_email':'pat@example.com','address':'425 W 53rd St, New York, NY 10019','zip':'10019','delivery_datetime':'next Tuesday at 3pm ET'})
    print('prepare (3pm) ->', r.get('ready'), r.get('problems'), json.dumps(r.get('summary'))[:400])
    code=r.get('confirmation_code')
    print('confirm wrong code ->', tool('rachel_confirm_order',{'confirmation_code':'nope'})[0])
    c,_=tool('rachel_confirm_order',{'confirmation_code':code}); print('confirm ->', c.get('placed'), c.get('order_id'), c.get('dry_run'), (c.get('payment_link') or '')[:60])
    print('confirm again ->', tool('rachel_confirm_order',{'confirmation_code':code})[0].get('error'))

if __name__ == '__main__':
    import io, contextlib, traceback
    for name, fn in (('oauth', oauth), ('api key + two-step order', apikey)):
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf): fn()
            out = buf.getvalue()
            bad = [l for l in out.splitlines() if l.startswith('confirm ->') and ' True ' not in l] + [l for l in out.splitlines() if 'forged token ->' in l and '401' not in l] + [l for l in out.splitlines() if l.startswith(('search urls ->', 'package urls ->')) and '-> none' not in l] + [l for l in out.splitlines() if l.startswith(('chat after age ->', 'package intake ->', 'package mix question ->', 'package cocktail question ->', 'package cocktails built ->')) and '-> asks' not in l and '-> no re-ask' not in l] + [l for l in out.splitlines() if l.startswith('search before age ->') and not l.startswith('search before age -> held | isError: False')]
            print(('  ✗ ' if bad else '  ✓ ') + 'connector ' + name + (': ' + '; '.join(bad) if bad else ''))
            if bad: FAILS.append(name)
        except Exception as e:
            print('  ✗ connector ' + name + ': ' + repr(e)[:200]); FAILS.append(name)
    print('mcp connector test: ' + ('all passed' if not FAILS else '%d FAILED' % len(FAILS)))
    sys.exit(1 if FAILS else 0)
