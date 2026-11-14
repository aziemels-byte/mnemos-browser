import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {GeminiOAuth} from '../connectors/perplexity/gemini-oauth.mjs';

test('Gemini OAuth PKCE: consent, code exchange, replay denial, refresh & revocation',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mnemos-gemini-oauth-'));
 const consent=randomBytes(24).toString('base64url');
 const clientId='mnemos-gemini-test-'+randomBytes(8).toString('hex');
 const config=path.join(dir,'auth.json'),dbFile=path.join(dir,'auth.sqlite');
 const issuer='https://connector.example.invalid:10000';
 const redirect='https://oauth-redirect.googleusercontent.com/r/valid-app-test';
 await writeFile(config,JSON.stringify({clientId,consentSha:createHash('sha256').update(consent).digest('hex')}));
 const service=new GeminiOAuth({configFile:config,dbFile,issuer});
 const srv=createServer(async(req,res)=>{
  try{await service.handle(req,res,new URL(req.url,'http://127.0.0.1'));}
  catch(e){res.writeHead(e.status??400,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}))}
 });
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+srv.address().port;
 const sha=v=>createHash('sha256').update(v).digest('base64url');
 const verifier=randomBytes(32).toString('base64url'),challenge=sha(verifier);
 const oauthUrl=new URL('/oauth/authorize',url);
 Object.entries({client_id:clientId,response_type:'code',redirect_uri:redirect,
   code_challenge:challenge,code_challenge_method:'S256',state:'secure-state-example',scope:'mnemos'})
   .forEach(([k,v])=>oauthUrl.searchParams.set(k,v));
 const runForm=async(p,data)=>fetch(url+p,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams(data),redirect:'manual'});
 try{
  const meta=await(await fetch(url+'/.well-known/oauth-authorization-server')).json();
  assert.ok(meta.authorization_endpoint.endsWith('/oauth/authorize'));
  assert.ok(meta.code_challenge_methods_supported.includes('S256'));
  const rm=await(await fetch(url+'/.well-known/oauth-protected-resource/mcp')).json();
  assert.deepEqual(rm.authorization_servers,[issuer]);
  const blocked=new URL(oauthUrl);
  blocked.searchParams.set('redirect_uri','https://evil.example/r/attack');
  assert.equal((await fetch(blocked)).status,400);
  const begun=await fetch(oauthUrl);
  assert.equal(begun.status,200);
  const html=await begun.text();
  const ticket=html.match(/name="ticket" value="([a-zA-Z0-9_-]+)"/)?.[1];
  assert.ok(ticket);
  const wrong=await runForm('/oauth/authorize',{ticket,decision:'approve',consent:'WRONG'});
  assert.equal(wrong.status,403);
  const response=await runForm('/oauth/authorize',{ticket,decision:'approve',consent});
  assert.equal(response.status,302);
  const callback=new URL(response.headers.get('location'));
  assert.equal(callback.origin,'https://oauth-redirect.googleusercontent.com');
  assert.equal(callback.searchParams.get('state'),'secure-state-example');
  const code=callback.searchParams.get('code');assert.ok(code);
  const exchange={grant_type:'authorization_code',client_id:clientId,code,redirect_uri:redirect,code_verifier:verifier};
  const tokensResponse=await runForm('/oauth/token',exchange);
  assert.equal(tokensResponse.status,200);
  const t=await tokensResponse.json();
  assert.equal(t.token_type,'Bearer');
  assert.ok(t.access_token.length>=40&&t.refresh_token.length>=40);
  assert.equal(service.isAuthorizedBearer(t.access_token),true);
  assert.equal((await runForm('/oauth/token',exchange)).status,400);
  const refreshed=await runForm('/oauth/token',{grant_type:'refresh_token',client_id:clientId,refresh_token:t.refresh_token});
  assert.equal(refreshed.status,200);
  const tt=await refreshed.json();
  assert.equal(tt.refresh_token,t.refresh_token);
  assert.equal(service.isAuthorizedBearer(tt.access_token),true);
  const revoked=await runForm('/oauth/revoke',{client_id:clientId,token:tt.access_token});
  assert.equal(revoked.status,200);
  assert.equal(service.isAuthorizedBearer(tt.access_token),false);
  assert.equal(service.isAuthorizedBearer(t.access_token),true);
  // The client must not authorize a different redirect after beginning a flow.
  const wrongRedirect=await runForm('/oauth/token',{...exchange,code,redirect_uri:'https://oauth-redirect-test.googleusercontent.com/r/different'});
  assert.equal(wrongRedirect.status,400);
 }finally{
  await new Promise(resolve=>srv.close(resolve));service.close();
  await rm(dir,{recursive:true,force:true});
 }
});
