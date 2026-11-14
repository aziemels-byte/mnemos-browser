import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserGateway,GATEWAY_SESSION} from '../connectors/perplexity/browser-gateway.mjs';
import {validateBrowserAction} from '../src/browser-actions.mjs';
const session='mnemos-browser-'+ 'a'.repeat(24), messageId='msg_'+'1'.repeat(36),threadId='thr_'+'2'.repeat(36),replyId='msg_'+'3'.repeat(36);
const verifier='f'.repeat(64);
test('Browser action validator blocks unsafe origins, hidden or ambiguous targets, and oversized values',()=>{
  assert.equal(validateBrowserAction({operation:'tab.describe',expectedOrigin:'https://example.com'}).operation,'tab.describe');
  for(const origin of ['http://example.com','file:///etc/passwd','https://example.com/path','https://u:p@example.com']){
    assert.throws(()=>validateBrowserAction({operation:'tab.describe',expectedOrigin:origin}));
  }
  assert.throws(()=>validateBrowserAction({operation:'tab.fill',expectedOrigin:'https://example.com',index:-1,expectedName:'Name',value:'John'}));
  assert.throws(()=>validateBrowserAction({operation:'tab.fill',expectedOrigin:'https://example.com',index:1,expectedName:'Name',value:'A'.repeat(3000)}));
  assert.throws(()=>validateBrowserAction({operation:'tab.evaluate',expectedOrigin:'https://example.com'}),/OPERATION_DENIED/);
  assert.deepEqual(validateBrowserAction({operation:'tab.attach',expectedOrigin:'https://jobs.example.com',index:1,expectedName:'Upload CV'}),
    {operation:'tab.attach',expectedOrigin:'https://jobs.example.com',index:1,expectedName:'Upload CV'});
});
test('Perplexity gateway authenticates to Core, sends only scoped commands, signs poll token and validates replies',async()=>{
  const calls=[];
  let stored=null,step=0;
  const secretStore={
    resolve:async()=>{if(stored)return stored;const e=new Error('ENOENT');e.code='ENOENT';throw e;},
    put:async(_name,value)=>{stored=value;}
  };
  const fetchImpl=async(url,opt={})=>{
    const parsed=new URL(url);
    const body=opt.body?JSON.parse(opt.body):null;
    calls.push({path:parsed.pathname,headers:opt.headers,body});
    let result;
    if(parsed.pathname.endsWith('/register'))result={sessionId:GATEWAY_SESSION,verifier};
    else if(parsed.pathname==='/api/frontier-sessions')
      result={sessions:[{sessionId:session,role:'browser_client',status:'ONLINE',liveness:'RECENT',
        metadata:{client:'mnemos-browser'},capabilities:['browser.tabs.list']}]};
    else if(parsed.pathname.endsWith('/send'))result={messageId,threadId};
    else if(parsed.pathname.startsWith('/api/frontier-threads/')){
      result={messages:[{messageId,kind:'browser_command',from:GATEWAY_SESSION,to:session},
        ...(step? [{messageId:replyId,kind:'browser_result',from:session,replyTo:messageId,
          body:JSON.stringify({schema:'mnemos.browser.result.v1',commandMessageId:messageId,ok:true,
          data:{tabs:[{title:'Example',url:'https://example.com',id:'tab'}]}})}]:[])]};
    }else if(parsed.pathname.endsWith('/ack'))result={status:'ACKNOWLEDGED'};
    else throw new Error('Unexpected route '+parsed.pathname);
    return {ok:true,status:200,text:async()=>JSON.stringify(result)};
  };
  const gateway=new BrowserGateway({secretStore,fetchImpl});
  const sent=await gateway.request({operation:'tabs.list'});
  assert.equal(sent.status,'AWAITING_BROWSER');
  assert.equal(sent.approvalRequired,false);
  assert.equal(stored,verifier);
  assert.equal(calls.filter(c=>c.path.endsWith('/register')).length,1);
  assert.equal(calls.find(c=>c.path.endsWith('/send')).body.to,session);
  assert.equal(calls.find(c=>c.path.endsWith('/send')).body.from,GATEWAY_SESSION);
  const pending=await gateway.result(sent.requestToken);
  assert.equal(pending.complete,false);
  assert.equal(pending.status,'AWAITING_BROWSER');
  const tabId='a'.repeat(36),expectedOrigin='https://example.com';
  const navigation=[
    {operation:'tab.inspect',tabId,expectedOrigin},
    {operation:'tab.answer',tabId,expectedOrigin,offset:0,length:6000},
    {operation:'tab.describe',tabId,expectedOrigin},
    {operation:'tab.fill',tabId,expectedOrigin,index:0,expectedName:'Prompt',value:'Draft only'},
    {operation:'tab.choose',tabId,expectedOrigin,index:0,expectedName:'Language',value:'lv'},
    {operation:'tab.toggle',tabId,expectedOrigin,index:0,expectedName:'Enabled',checked:true},
    {operation:'tab.click',tabId,expectedOrigin,index:0,expectedText:'Open menu'},
    {operation:'tab.select',tabId},
    {operation:'tab.open',url:'https://example.com/new'}
  ];
  for(const op of navigation){
    const request=await gateway.request(op);
    assert.equal(request.approvalRequired,false,op.operation+' should not block on an approval');
  }
  await assert.rejects(()=>gateway.request({operation:'tab.answer',tabId,expectedOrigin,offset:32769,length:6000}),/INVALID_ANSWER_PAGE/);
  await assert.rejects(()=>gateway.request({operation:'tab.answer',tabId,expectedOrigin,offset:0,length:9000}),/INVALID_ANSWER_PAGE/);
  for(const op of [
    {operation:'tab.submit',tabId,expectedOrigin,index:0,expectedText:'Send'},
    {operation:'tab.attach',tabId,expectedOrigin,index:0,expectedName:'Upload'}
  ]){
    const request=await gateway.request(op);
    assert.equal(request.approvalRequired,true,op.operation+' must still have a human gate');
  }
  await assert.rejects(()=>gateway.result(sent.requestToken.replace(/.$/,x=>x==='0'?'1':'0')),/REQUEST_TOKEN_AUTH_FAILED/);
  step=1;
  const result=await gateway.result(sent.requestToken);
  assert.equal(result.complete,true);
  assert.equal(result.ok,true);
  assert.equal(result.data.tabs.length,1);
  assert.equal(calls.filter(c=>c.path.endsWith('/ack')).length,1);
  await assert.rejects(()=>gateway.request({operation:'tab.executeScript',script:'process.exit()'}),/NOT_ALLOWED/);
});
