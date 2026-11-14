/** Authenticated MCP -> MNEMOS Core Frontier -> owner-controlled Electron tabs.
 * The gateway never sees Electron cookies. Authentication to Core uses a DPAPI-stored
 * Frontier verifier; remote MCP requests must pass the separate HTTPS bearer gate.
 */
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { connectorPaths } from '../../src/connector-config.mjs';

export const GATEWAY_SESSION='mnemos-perplexity-browser-gateway-20261111';
const CORE='http://127.0.0.1:4320';
const SHORT=(v,n=150)=>String(v??'').slice(0,n);
const operations=new Set([ 'tabs.list','tab.inspect','tab.answer','tab.describe','tab.fill','tab.choose','tab.toggle','tab.attach','tab.click','tab.submit','tab.select','tab.open']);

function validate(command){
  if(!command||typeof command!=='object'||!operations.has(command.operation))
    throw new Error('BROWSER_OPERATION_NOT_ALLOWED');
  if(JSON.stringify(command).length>5000)throw new Error('BROWSER_COMMAND_TOO_LARGE');
  const op=command.operation;
  if(op==='tabs.list')return {schema:'mnemos.browser.command.v1',operation:op};
  if(op==='tab.open'){
    const u=new URL(command.url);
    if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')throw new Error('URL_NOT_ALLOWED');
    const project=command.project??'mnemos';
    if(typeof project!=='string'||!/^[a-z0-9_-]{1,90}$/i.test(project))throw new Error('BROWSER_GRANT_PROJECT_REQUIRED');
    return {schema:'mnemos.browser.command.v1',operation:op,url:u.href,project};
  }
  if(!/^[a-f0-9-]{36}$/i.test(command.tabId??''))throw new Error('TAB_ID_INVALID');
  const result={schema:'mnemos.browser.command.v1',operation:op,tabId:command.tabId};
  if(op==='tab.select')return result;
  if(op==='tab.answer'){
    const u=new URL(command.expectedOrigin);
    if(u.protocol!=='https:'||u.origin!==command.expectedOrigin||
       u.username||u.password)throw new Error('EXPECTED_HTTPS_ORIGIN_REQUIRED');
    const offset=Number(command.offset??0),length=Number(command.length??6000);
    if(!Number.isInteger(offset)||offset<0||offset>32768||
       !Number.isInteger(length)||length<1||length>7000)
      throw new Error('INVALID_ANSWER_PAGE');
    return {...result,expectedOrigin:u.origin,offset,length};
  }
  if(op==='tab.inspect'){
    const u=new URL(command.expectedOrigin);
    if(u.protocol!=='https:'||u.origin!==command.expectedOrigin||u.username||u.password)
      throw new Error('EXPECTED_HTTPS_ORIGIN_REQUIRED');
    result.expectedOrigin=u.origin;
    return result;
  }
  const origin=new URL(command.expectedOrigin);
  if(origin.origin!==command.expectedOrigin||origin.protocol!=='https:'||origin.username||origin.password||origin.port&&origin.port!=='443')
    throw new Error('EXPECTED_HTTPS_ORIGIN_REQUIRED');
  result.expectedOrigin=origin.origin;
  if(op==='tab.describe'){
    const fieldOffset=Number(command.fieldOffset??0),buttonOffset=Number(command.buttonOffset??0),limit=Number(command.limit??16);
    if(!Number.isInteger(fieldOffset)||fieldOffset<0||fieldOffset>256||
      !Number.isInteger(buttonOffset)||buttonOffset<0||buttonOffset>256||
      !Number.isInteger(limit)||limit<1||limit>64)throw new Error('INVALID_CONTROL_PAGE');
    return {...result,fieldOffset,buttonOffset,limit};
  }
  if(!Number.isInteger(command.index)||command.index<0||command.index>255)
    throw new Error('ELEMENT_INDEX_INVALID');
  result.index=command.index;
  const labelName=['tab.fill','tab.choose','tab.toggle','tab.attach'].includes(op)?'expectedName':'expectedText';
  if(typeof command[labelName]!=='string'||command[labelName].length>120||!command[labelName].trim())
    throw new Error('CONTROL_LABEL_REQUIRED');
  result[labelName]=command[labelName];
  if(op==='tab.fill'){
    if(typeof command.value!=='string'||!command.value.trim()||command.value.length>2500)
      throw new Error('VALUE_LENGTH_INVALID');
    result.value=command.value;
  }
  if(op==='tab.choose'){
    if(typeof command.value!=='string'||command.value.length>90)throw new Error('OPTION_VALUE_INVALID');
    result.value=command.value;
  }
  if(op==='tab.toggle'){
    if(typeof command.checked!=='boolean')throw new Error('CHECKED_BOOLEAN_REQUIRED');
    result.checked=command.checked;
  }
  return result;
}

export class BrowserGateway{
  constructor({fetchImpl=fetch,secretStore=null,base=CORE}={}){
    if(base!==CORE&&!base.startsWith('http://127.0.0.1:'))throw new Error('CORE_LOOPBACK_ONLY');
    this.base=base;this.fetch=fetchImpl;this.storage=secretStore;
    this.verifier=null;this.registration=null;
  }
  async store(){
    if(this.storage)return this.storage;
    const {WindowsDpapiSecretStore}=await import('../../../../packages/core/src/providers/credential-store.mjs');
    this.storage=new WindowsDpapiSecretStore({root:connectorPaths().security});
    return this.storage;
  }
  async api(route,{method='GET',data,verifier=false}={}){
    const response=await this.fetch(this.base+route,{
      method,redirect:'error',signal:AbortSignal.timeout(6500),
      headers:{...(data!==undefined?{'content-type':'application/json'}:{}),
        ...(verifier?{'x-mnemos-frontier-verifier':this.verifier}:{})},
      ...(data===undefined?{}:{body:JSON.stringify(data)})
    });
    if(!response.ok)throw new Error('MNEMOS_CORE_HTTP_'+response.status);
    const txt=await response.text();
    if(txt.length>(route==='/api/frontier-sessions'?4000000:220000))throw new Error('CORE_REPLY_TOO_LARGE');
    return JSON.parse(txt);
  }
  async connect(){
    if(this.registration)return this.registration;
    this.registration=(async()=>{
      const storage=await this.store();
      let verifier;
      try{verifier=(await storage.resolve('vault:dpapi.perplexity-browser-gateway')).trim();}catch(e){
        if(!/NOT_FOUND|ENOENT|not found|unknown secret|no credential/i.test(String(e.message??e)))
          throw e;
      }
      const data=await this.api('/api/frontier-sessions/register',{method:'POST',data:{
        sessionId:GATEWAY_SESSION,role:'tool_gateway',displayName:'Perplexity MCP browser gateway',
        capabilities:['browser.tabs.list','browser.tab.inspect','browser.tab.answer','browser.tab.describe','browser.tab.fill',
          'browser.tab.choose','browser.tab.toggle','browser.tab.attach','browser.tab.click','browser.tab.submit','browser.tab.select','browser.tab.open'],
        metadata:{client:'perplexity-mcp',privileges:'read-draft-auto; submit-confirmed; file-picker-only'},
        ...(verifier?{verifier}:{})
      }});
      if(data.sessionId!==GATEWAY_SESSION)throw new Error('GATEWAY_SESSION_MISMATCH');
      if(data.verifier) {
        if(!/^[a-f0-9]{64}$/i.test(data.verifier))throw new Error('GATEWAY_VERIFIER_INVALID');
        verifier=data.verifier;
        await storage.put('perplexity-browser-gateway',verifier);
      }
      if(!/^[a-f0-9]{64}$/i.test(verifier??''))throw new Error('GATEWAY_VERIFIER_UNAVAILABLE');
      this.verifier=verifier;
      return {sessionId:GATEWAY_SESSION};
    })().catch(e=>{this.registration=null;throw e;});
    return this.registration;
  }
  async browserSession(){
    const s=await this.api('/api/frontier-sessions');
    const matches=(s.sessions??[]).filter(x=>x.role==='browser_client'&&x.status==='ONLINE'&&
      x.liveness==='RECENT'&&x.capabilities?.includes('browser.tabs.list')&&
      x.metadata?.client==='mnemos-browser');
    if(matches.length!==1)throw new Error(matches.length?'MULTIPLE_ACTIVE_BROWSERS':'NO_ACTIVE_MNEMOS_BROWSER');
    return matches[0].sessionId;
  }
  sign(threadId,messageId){
    return createHmac('sha256',this.verifier).update(threadId+'|'+messageId).digest('hex');
  }
  async request(command){
    const checked=validate(command);
    await this.connect();
    const target=await this.browserSession();
    const msg=await this.api('/api/frontier-sessions/send',{method:'POST',data:{
      from:GATEWAY_SESSION,to:target,kind:'browser_command',expectsReply:true,
      verifier:this.verifier,body:JSON.stringify(checked),
      metadata:{idempotencyKey:'perplexity-browser-'+randomUUID()}
    }});
    if(!/^thr_[a-f0-9-]{36}$/i.test(msg.threadId??'')||
      !/^msg_[a-f0-9-]{36}$/i.test(msg.messageId??''))throw new Error('CORE_RECEIPT_INVALID');
    // The browser evaluates the *actual* current page and composer at execution.
    // For known AI origins, approval may be automatic or may fall back to a modal.
    const delegatedCandidate=checked.operation==='tab.submit'&&
      ['https://chatgpt.com','https://gemini.google.com',
        'https://www.perplexity.ai','https://perplexity.ai'].includes(checked.expectedOrigin);
    return {status:'AWAITING_BROWSER',operation:checked.operation,
      requestToken:msg.threadId+'.'+msg.messageId+'.'+this.sign(msg.threadId,msg.messageId),
      approvalRequired:delegatedCandidate?null:['tab.submit','tab.attach'].includes(checked.operation),
      approvalConditional:delegatedCandidate,
      instruction:'Use mnemos_browser_result with requestToken. AI chat prompts can be delegated without a dialog after live composer checks; other external submissions require owner confirmation. File attachment requires native selection.'};
  }
  async result(token){
    await this.connect();
    const m=String(token??'').match(/^(thr_[a-f0-9-]{36})\.(msg_[a-f0-9-]{36})\.([a-f0-9]{64})$/i);
    if(!m)throw new Error('INVALID_REQUEST_TOKEN');
    const expected=this.sign(m[1],m[2]);
    if(!timingSafeEqual(Buffer.from(expected),Buffer.from(m[3])))throw new Error('REQUEST_TOKEN_AUTH_FAILED');
    const thread=await this.api('/api/frontier-threads/'+encodeURIComponent(m[1])+
      '?sessionId='+encodeURIComponent(GATEWAY_SESSION),{verifier:true});
    const outbound=(thread.messages??[]).find(x=>x.messageId===m[2]&&x.from===GATEWAY_SESSION);
    if(!outbound)throw new Error('GATEWAY_REQUEST_NOT_FOUND');
    const reply=(thread.messages??[]).find(x=>x.kind==='browser_result'&&x.replyTo===m[2]&&
      x.from===outbound.to);
    if(!reply)return {status:'AWAITING_BROWSER',requestToken:token,complete:false};
    let payload;
    try{payload=JSON.parse(reply.body);}catch{throw new Error('INVALID_BROWSER_RESPONSE_JSON');}
    if(payload.schema!=='mnemos.browser.result.v1'||payload.commandMessageId!==m[2])
      throw new Error('BROWSER_RESPONSE_INVALID');
    if(JSON.stringify(payload).length>18000)throw new Error('BROWSER_RESULT_TOO_LARGE');
    await this.api('/api/frontier-sessions/'+encodeURIComponent(GATEWAY_SESSION)+'/ack',
      {method:'POST',data:{messageId:reply.messageId,verifier:this.verifier}}).catch(()=>{});
    return {status:payload.ok?'COMPLETED':'REJECTED_OR_FAILED',complete:true,
      ok:payload.ok,...payload.ok?{data:payload.data}:{error:SHORT(payload.error,180)},
      capturedAt:payload.capturedAt};
  }
}
