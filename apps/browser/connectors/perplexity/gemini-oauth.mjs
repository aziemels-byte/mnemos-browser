/**
 * Owner-authorized OAuth 2.1 / PKCE for Gemini's private custom Connected App.
 * Separate from Perplexity's static API key. Only known Google OAuth redirect origins,
 * a pre-provisioned client ID, and an owner-held DPAPI consent secret are accepted.
 * Tokens are random; only SHA-256 hashes are persisted.
 */
import {readFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import { connectorPaths, requireConnectorOrigin } from '../../src/connector-config.mjs';

const now=()=>Date.now();
const digest=x=>createHash('sha256').update(String(x??'')).digest('hex');
const random=(n=32)=>randomBytes(n).toString('base64url');
const matches=(a,b)=>/^[a-f0-9]{64}$/.test(a??'')&&/^[a-f0-9]{64}$/.test(b??'')&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const err=(code,status=400)=>Object.assign(new Error(code),{status});
const redirectAllowed=input=>{
  let u;try{u=new URL(input);}catch{throw err('INVALID_REDIRECT_URI');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||
    !['oauth-redirect.googleusercontent.com','oauth-redirect-sandbox.googleusercontent.com',
      'oauth-redirect-test.googleusercontent.com'].includes(u.hostname)||
      !/^\/[ra]\/[a-zA-Z0-9_%./-]{1,250}$/.test(u.pathname)||
      u.search)throw err('REDIRECT_URI_NOT_ALLOWLISTED');
  return u.href;
};
function htmlEscape(s){
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function json(res,status,obj){
  res.writeHead(status,{'content-type':'application/json;charset=utf-8',
    'cache-control':'no-store','pragma':'no-cache','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(obj));
}
function noCache(res,loc){
  res.writeHead(302,{location:loc,'cache-control':'no-store','referrer-policy':'no-referrer'});
  res.end();
}
function formData(body){
  if(body.length>12000)throw err('REQUEST_TOO_LARGE',413);
  return new URLSearchParams(body);
}
async function readBody(req){
  const chunks=[];let size=0;
  for await (const c of req){
    size+=c.length;if(size>12000)throw err('REQUEST_TOO_LARGE',413);
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export class GeminiOAuth {
  constructor({configFile=connectorPaths().geminiConfig,
    dbFile=connectorPaths().geminiDatabase,issuer=requireConnectorOrigin()}={}){
    this.config=JSON.parse(readFileSync(configFile,'utf8'));
    if(typeof this.config.clientId!=='string'||!matches(this.config.consentSha,this.config.consentSha))
      throw new Error('GEMINI_OAUTH_NOT_PROVISIONED');
    this.issuer=issuer;
    mkdirSync(path.dirname(dbFile),{recursive:true});
    this.db=new DatabaseSync(dbFile);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pending(ticket_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,state TEXT NOT NULL,challenge TEXT NOT NULL,
        scope TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS code(code_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,challenge TEXT NOT NULL,scope TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access(token_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL,
        scope TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS refresh(token_hash TEXT PRIMARY KEY,client_id TEXT NOT NULL,
        scope TEXT NOT NULL,expires INTEGER NOT NULL);`);
    this.rate={window:now(),fails:0};
  }
  close(){this.db.close();}
  metadata(){
    return {issuer:this.issuer,authorization_endpoint:this.issuer+'/oauth/authorize',
      token_endpoint:this.issuer+'/oauth/token',
      revocation_endpoint:this.issuer+'/oauth/revoke',
      response_types_supported:['code'],
      grant_types_supported:['authorization_code','refresh_token'],
      token_endpoint_auth_methods_supported:['none','client_secret_post','client_secret_basic'],
      code_challenge_methods_supported:['S256'],
      scopes_supported:['mnemos'],
      service_documentation:this.issuer+'/.well-known/oauth-protected-resource'};
  }
  resourceMetadata(){return {resource:this.issuer+'/mcp',authorization_servers:[this.issuer],
    scopes_supported:['mnemos'],bearer_methods_supported:['header']};}
  isAuthorizedBearer(token){
    if(typeof token!=='string'||token.length<40||token.length>128)return false;
    const row=this.db.prepare('SELECT expires FROM access WHERE token_hash=?').get(digest(token));
    return !!row&&row.expires>now();
  }
  clean(){
    this.db.prepare('DELETE FROM pending WHERE created<?').run(now()-300000);
    for(const table of ['code','access','refresh'])
      this.db.prepare('DELETE FROM '+table+' WHERE expires<?').run(now());
  }
  rateLimit(){
    if(now()-this.rate.window>60000)this.rate={window:now(),fails:0};
    if(this.rate.fails>25)throw err('TOO_MANY_FAILED_ATTEMPTS',429);
  }
  wrong(){
    this.rate.fails++;throw err('ACCESS_DENIED',403);
  }
  authorizeStart(req,res,url){
    this.clean();this.rateLimit();
    const q=url.searchParams;
    if(q.get('response_type')!=='code'||q.get('client_id')!==this.config.clientId)
      throw err('UNSUPPORTED_CLIENT_OR_RESPONSE');
    const redirectUri=redirectAllowed(q.get('redirect_uri'));
    const challenge=q.get('code_challenge')??'';
    if(q.get('code_challenge_method')!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(challenge))
      throw err('PKCE_S256_REQUIRED');
    const state=q.get('state')??'',scope=q.get('scope')||'mnemos';
    if(state.length<8||state.length>1000||scope!=='mnemos')throw err('INVALID_STATE_OR_SCOPE');
    const ticket=random(32),ticketHash=digest(ticket);
    this.db.prepare('INSERT INTO pending VALUES(?,?,?,?,?,?,?)').run(
      ticketHash,this.config.clientId,redirectUri,state,challenge,scope,now());
    const html='<!doctype html><html lang="lv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'+
      '<title>MNEMOS — Gemini piekļuves apstiprināšana</title>'+
      '<style>body{background:#111;color:#eee;font:15px system-ui;max-width:560px;margin:8vh auto;padding:24px}'+
      'form{padding:22px;border:1px solid #666}input{box-sizing:border-box;width:100%;padding:13px;background:#222;color:#fff;border:1px solid #777}'+
      'button{padding:12px;margin-top:18px;background:#eee;color:#111;border:0;cursor:pointer}</style></head><body>'+
      '<h1>MNEMOS → Gemini</h1><p>Google Gemini pieprasa tiesības izsaukt MNEMOS MCP rīkus. '+
      'Pārlūkošana un melnraksti darbojas bez papildu apstiprinājuma. Formas nosūtīšana tavā vārdā prasa vienreizēju apstiprinājumu; faila pievienošanai nepieciešama paša lietotāja izvēle.</p>'+
      '<p><b>Klients:</b> '+htmlEscape(this.config.clientId)+'</p>'+
      '<p><b>Galapunkts:</b> '+htmlEscape(this.issuer)+'</p>'+
      '<form method="post" action="/oauth/authorize"><input type="hidden" name="ticket" value="'+ticket+'">'+
      '<label for="consent">Ievadi savu MNEMOS Gemini autorizācijas kodu (nekopē to Gemini čatā):</label>'+
      '<input id="consent" type="password" name="consent" required autocomplete="off">'+
      '<button name="decision" value="approve" type="submit">Piešķirt piekļuvi</button> '+
      '<button name="decision" value="deny" type="submit">Noraidīt</button></form></body></html>';
    res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store',
      'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'x-frame-options':'DENY','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});
    res.end(html);
  }
  async authorizeFinish(req,res){
    this.rateLimit();
    const form=formData(await readBody(req));
    const ticket=String(form.get('ticket')??'');
    if(!/^[A-Za-z0-9_-]{40,60}$/.test(ticket))this.wrong();
    const row=this.db.prepare('SELECT * FROM pending WHERE ticket_hash=?').get(digest(ticket));
    if(!row||now()-row.created>300000)this.wrong();
    const decision=form.get('decision');
    if(decision!=='approve'){
      this.db.prepare('DELETE FROM pending WHERE ticket_hash=?').run(digest(ticket));
      const u=new URL(row.redirect_uri);u.searchParams.set('error','access_denied');
      u.searchParams.set('state',row.state);return noCache(res,u.href);
    }
    const consent=form.get('consent')??'';
    if(typeof consent!=='string'||!matches(digest(consent),this.config.consentSha))this.wrong();
    const removed=this.db.prepare('DELETE FROM pending WHERE ticket_hash=?').run(digest(ticket));
    if(removed.changes!==1)throw err('CONSENT_TICKET_REPLAY');
    const code=random(32);
    this.db.prepare('INSERT INTO code VALUES(?,?,?,?,?,?)').run(
      digest(code),row.client_id,row.redirect_uri,row.challenge,row.scope,now()+90000);
    const u=new URL(row.redirect_uri);u.searchParams.set('code',code);
    u.searchParams.set('state',row.state);return noCache(res,u.href);
  }
  authenticateClient(req,params){
    let id=params.get('client_id'),secret=params.get('client_secret');
    const basic=String(req.headers.authorization??'').match(/^Basic (.+)$/);
    if(basic){
      const raw=Buffer.from(basic[1],'base64').toString('utf8');
      const pos=raw.indexOf(':');
      if(pos<0)throw err('INVALID_CLIENT',401);
      id=decodeURIComponent(raw.slice(0,pos));
      secret=decodeURIComponent(raw.slice(pos+1));
    }
    if(id!==this.config.clientId)throw err('INVALID_CLIENT',401);
    // A public PKCE client uses no secret; a configured secret is required
    // for confidential client mode. Both modes are restricted to this one ID.
    if(this.config.clientSecretSha&&(!secret||!matches(digest(secret),this.config.clientSecretSha)))
      throw err('INVALID_CLIENT',401);
    return id;
  }
  async token(req,res){
    this.clean();this.rateLimit();
    const params=formData(await readBody(req)),id=this.authenticateClient(req,params),grant=params.get('grant_type');
    if(grant==='authorization_code'){
      const rawCode=params.get('code')??'',verifier=params.get('code_verifier')??'';
      if(!/^[A-Za-z0-9_-]{43,128}$/.test(verifier))throw err('PKCE_VERIFIER_INVALID');
      const row=this.db.prepare('SELECT * FROM code WHERE code_hash=?').get(digest(rawCode));
      if(!row||row.client_id!==id||row.expires<=now()||
        row.redirect_uri!==redirectAllowed(params.get('redirect_uri')))throw err('INVALID_GRANT');
      const computed=createHash('sha256').update(verifier).digest('base64url');
      if(computed!==row.challenge)throw err('PKCE_MISMATCH');
      const changed=this.db.prepare('DELETE FROM code WHERE code_hash=?').run(digest(rawCode));
      if(changed.changes!==1)throw err('CODE_REPLAY');
      const access=random(32),refresh=random(32);
      this.db.prepare('INSERT INTO access VALUES(?,?,?,?)').run(digest(access),id,row.scope,now()+3600000);
      this.db.prepare('INSERT INTO refresh VALUES(?,?,?,?)').run(digest(refresh),id,row.scope,now()+30*86400000);
      return json(res,200,{access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope:row.scope});
    }
    if(grant==='refresh_token'){
      const refresh=params.get('refresh_token')??'';
      const row=this.db.prepare('SELECT * FROM refresh WHERE token_hash=?').get(digest(refresh));
      if(!row||row.client_id!==id||row.expires<=now())throw err('INVALID_GRANT');
      const access=random(32);
      this.db.prepare('INSERT INTO access VALUES(?,?,?,?)').run(digest(access),id,row.scope,now()+3600000);
      this.db.prepare('UPDATE refresh SET expires=? WHERE token_hash=?').run(now()+30*86400000,digest(refresh));
      return json(res,200,{access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope:row.scope});
    }
    throw err('UNSUPPORTED_GRANT_TYPE');
  }
  async revoke(req,res){
    const params=formData(await readBody(req));
    this.authenticateClient(req,params);
    const token=params.get('token')??'';
    this.db.prepare('DELETE FROM access WHERE token_hash=?').run(digest(token));
    this.db.prepare('DELETE FROM refresh WHERE token_hash=?').run(digest(token));
    res.writeHead(200,{'cache-control':'no-store'});res.end();
  }
  async handle(req,res,url){
    if(req.method==='GET'&&['/.well-known/oauth-authorization-server','/.well-known/openid-configuration'].includes(url.pathname))
      return json(res,200,this.metadata());
    if(req.method==='GET'&&url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json(res,200,this.resourceMetadata());
    if(req.method==='GET'&&url.pathname==='/oauth/authorize')return this.authorizeStart(req,res,url);
    if(req.method==='POST'&&url.pathname==='/oauth/authorize')return this.authorizeFinish(req,res);
    if(req.method==='POST'&&url.pathname==='/oauth/token')return this.token(req,res);
    if(req.method==='POST'&&url.pathname==='/oauth/revoke')return this.revoke(req,res);
    throw err('NOT_FOUND',404);
  }
}
