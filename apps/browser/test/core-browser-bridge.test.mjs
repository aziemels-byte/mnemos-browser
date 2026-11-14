import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CoreBrowserBridge, OWNER_SESSION, PERPLEXITY_GATEWAY_SESSION } from '../src/core-browser-bridge.mjs';

const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from('encrypted:' + text),
  decryptString: buffer => {
    const raw = buffer.toString();
    if (!raw.startsWith('encrypted:')) throw new Error('BAD_CIPHER');
    return raw.slice('encrypted:'.length);
  }
};
function setup({messages = [], registrationGate = null, approve = async () => false, performAction = null, performLifecycle = null, onConsultationReply = null, tabs = [], inspectTab = async () => ({title:'Test',text:'Test text'}), openUrl = async () => ({id:'new-tab'})} = {}) {
  const db = new Map();
  const store = {get:(k,d)=>db.has(k)?db.get(k):d,set:(k,v)=>db.set(k,v)};
  const calls = [];
  const sent = [];
  let failAck = false;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), p = url.pathname;
    const data = options.body ? JSON.parse(options.body) : {};
    calls.push({path:p, method:options.method??'GET',data});
    const response = x => new Response(JSON.stringify(x));
    if (p.endsWith('/register')) {
      await registrationGate;
      return response({sessionId:data.sessionId, verifier:data.verifier??'a'.repeat(64)});
    }
    if (p.endsWith('/authorize')) return response({grantId:'00000000-0000-0000-0000-000000000001',expiresAt:new Date(Date.now()+60_000).toISOString()});
    if (p.endsWith('/inbox')) return response({messages});
    if (p.endsWith('/send')) {sent.push(data); return response({messageId:'msg_reply'});}
    if (p.endsWith('/ack')) {
      if (failAck) return new Response('ack failed',{status:503});
      messages = messages.filter(m=>m.messageId!==data.messageId);
      return response({status:'ACKNOWLEDGED'});
    }
    return new Response('Not found',{status:404});
  };
  const bridge = new CoreBrowserBridge({store,crypto,fetchImpl, getTabs:()=>tabs, inspectTab, openUrl,
    selectTab: async()=>{},approve,performAction,performLifecycle,onConsultationReply});
  return {bridge,db,calls,sent,get messages(){return messages;}, failAck:value=>{failAck=value;}};
}
function request(operation, args={},from=OWNER_SESSION) {
  return {
    messageId:'msg_'+randomUUID(),threadId:'thr_'+randomUUID(),from,expectsReply:true,
    body:JSON.stringify({schema:'mnemos.browser.command.v1',operation,...args})
  };
}
test('ChatGPT consultation replies require trusted sender and ACK without browser-result echo',async()=>{
  const outbound='msg_'+randomUUID(),proposalId=randomUUID(),messageId='msg_'+randomUUID();
  const reply={messageId,threadId:'thr_'+randomUUID(),kind:'consultation_reply',from:OWNER_SESSION,
    replyTo:outbound,body:JSON.stringify({schema:'mnemos.collaboration.reply.v1',proposalId,answer:'Pārskatīta ChatGPT atbilde.'})};
  let ingested=0,last=null;
  const x=setup({messages:[reply],onConsultationReply:async value=>{ingested++;last=value;}});
  await x.bridge.setEnabled(true);x.bridge.stop();
  assert.equal(ingested,1);
  assert.equal(last.proposalId,proposalId);
  assert.equal(last.replyTo,outbound);
  assert.equal(last.sourceMessageId,messageId);
  assert.equal(x.messages.length,0);
  assert.equal(x.sent.length,0);
  const rejected=setup({messages:[{...reply,from:'untrusted-remote-agent'}],
    onConsultationReply:async()=>{throw new Error('NEVER_REACHED');}});
  await rejected.bridge.setEnabled(true);rejected.bridge.stop();
  assert.equal(rejected.messages.length,1);
  assert.match(rejected.bridge.snapshot().error,/CONSULTATION_SENDER_NOT_TRUSTED/);
});
test('bridge is opt-in and verifier is encrypted without exposing it in snapshots',async()=>{
  const x=setup();
  assert.equal(x.bridge.snapshot().enabled,false);
  assert.equal(x.calls.length,0);
  const result=await x.bridge.setEnabled(true);
  x.bridge.stop();
  assert.equal(result.connected,true);
  assert.equal(x.calls[0].path,'/api/frontier-sessions/register');
  assert.equal(x.db.get('coreBridge.verifier'),Buffer.from('encrypted:'+'a'.repeat(64)).toString('base64'));
  assert.ok(!JSON.stringify(result).includes('a'.repeat(64)));
  assert.equal(x.calls[1].method,'GET');
});
test('closing during Core registration waits for the verifier to be persisted without polling', async () => {
  const gate = Promise.withResolvers();
  const x = setup({ registrationGate: gate.promise });
  const connection = x.bridge.setEnabled(true);
  assert.equal(x.calls.length, 1);
  x.bridge.stop();
  const finished = x.bridge.finishRegistration();
  gate.resolve();
  await finished;
  await connection;
  assert.ok(x.db.get('coreBridge.verifier'));
  assert.equal(x.bridge.snapshot().connected, false);
  assert.equal(x.calls.length, 1);
});

test('list returns redacted public tabs, never private tabs or URL secrets',async()=>{
  const message=request('tabs.list');
  const x=setup({messages:[message],tabs:[
    {id:'public',title:'Example',project:'mnemos',url:'https://example.org/path?q=API_SECRET#fragment',private:false},
    {id:'private',title:'Bank account',project:'mnemos',url:'https://bank.example/account',private:true}
  ]});
  await x.bridge.setEnabled(true);x.bridge.stop();
  assert.equal(x.sent.length,1);
  const result=JSON.parse(x.sent[0].body);
  assert.equal(result.ok,true);
  assert.equal(result.data.tabs.length,1);
  assert.equal(result.data.tabs[0].url,'https://example.org/path');
  assert.ok(!x.sent[0].body.includes('API_SECRET'));
  assert.ok(!x.sent[0].body.includes('Bank account'));
  assert.equal(x.messages.length,0);
});
test('foreign sender cannot read tabs; trusted public inspect does not need approval',async()=>{
  const bad=request('tabs.list',{},'untrusted-agent');
  const x=setup({messages:[bad],tabs:[{id:'x',url:'https://example.org/',private:false}],approve:async()=>false});
  await x.bridge.setEnabled(true);x.bridge.stop();
  assert.equal(JSON.parse(x.sent[0].body).error,'UNTRUSTED_SENDER');
  const blocked=await x.bridge.answer(request('tab.inspect',{tabId:'x'}));
  assert.equal(blocked.ok,true);
  assert.equal(blocked.data.text,'Test text');
});
test('inspect permitted tab returns bounded text and preserves source',async()=>{
  const x=setup({tabs:[{id:'x',title:'A',url:'https://example.org/p?secret=1',project:'p',private:false}],
    approve:async()=>true,inspectTab:async()=>({title:'Document',text:'T'.repeat(9000)})});
  const result=await x.bridge.answer(request('tab.inspect',{tabId:'x'}));
  assert.equal(result.ok,true);
  assert.equal(result.data.text.length,6000);
  assert.equal(result.data.tab.url,'https://example.org/p');
  assert.ok(!JSON.stringify(result).includes('secret=1'));
});
test('idempotent reply reuses encrypted receipt after ACK failure and never duplicates navigation',async()=>{
  const cmd=request('tab.open',{url:'https://example.org/',project:'mnemos'});
  let opened=0;
  const x=setup({messages:[cmd],approve:async()=>true,openUrl:async()=>{opened++;return {id:'new-tab'};}});
  x.failAck(true);
  await x.bridge.setEnabled(true);
  assert.equal(x.bridge.snapshot().connected,false);
  assert.equal(opened,1);
  x.failAck(false);
  await x.bridge.tick();x.bridge.stop();
  assert.equal(opened,1);
  assert.equal(x.sent.length,2);
  assert.equal(x.sent[0].body,x.sent[1].body);
  assert.equal(x.messages.length,0);
  assert.ok(x.db.get('coreBridge.receipts'));
});

test('owner lifecycle requires a matching instance, public tab and scope before dispatch', async () => {
  const calls = [];
  const x = setup({
    tabs: [
      {id:'target',url:'https://example.org/docs?secret=1',project:'one'},
      {id:'other',url:'https://other.example/',project:'two'},
      {id:'private',url:'https://example.org/docs',private:true}
    ],
    performLifecycle:async (tabId,action)=>{ calls.push({tabId,action});return {tabId,readiness:'READY'}; }
  });
  const list = await x.bridge.answer(request('tabs.list'));
  const browserInstanceId = list.data.browserInstanceId;
  assert.ok(browserInstanceId);
  assert.deepEqual(list.data.tabs.map(row=>row.id),['target','other']);
  assert.deepEqual((await x.bridge.answer(request('windows.list'))).data.windows,[{id:'main',tabCount:2}]);

  const command = {browserInstanceId,tabId:'target',expectedOrigin:'https://example.org',url:'https://example.org/next'};
  const execute = (changes,from) => x.bridge.answer(request('tab.navigate',{...command,...changes},from));
  assert.equal((await execute({browserInstanceId:'wrong'})).error,'BROWSER_INSTANCE_MISMATCH');
  assert.equal((await execute({browserInstanceId:undefined})).error,'BROWSER_INSTANCE_REQUIRED');
  assert.equal((await execute({tabId:'private'})).error,'TAB_NOT_ACCESSIBLE');
  assert.equal((await execute({expectedOrigin:'https://other.example'})).error,'EXPECTED_ORIGIN_MISMATCH');
  assert.equal((await execute({},PERPLEXITY_GATEWAY_SESSION)).error,'BROWSER_LIFECYCLE_SCOPE_DENIED');
  assert.equal(calls.length,0);

  const message = request('tab.navigate',command);
  const executed = await x.bridge.answer(message);
  assert.equal(executed.browserInstanceId,browserInstanceId);
  assert.deepEqual(executed.data,{tabId:'target',readiness:'READY'});
  assert.deepEqual(calls,[{tabId:'target',action:{
    operation:'tab.navigate',expectedOrigin:'https://example.org',expectedPath:'/docs',url:'https://example.org/next'
  }}]);
  assert.equal((await x.bridge.answer(message)).error,'ACTION_ALREADY_STARTED_CHECK_SITE_MANUALLY');
  assert.equal(calls.length,1);
});
