import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CoreBrowserBridge,PERPLEXITY_GATEWAY_SESSION } from '../src/core-browser-bridge.mjs';
const crypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),
  decryptString:b=>b.toString('utf8')};
const command=(op,input,from=PERPLEXITY_GATEWAY_SESSION)=>({
  messageId:'msg_'+randomUUID(),threadId:'thr_'+randomUUID(),from,
  body:JSON.stringify({schema:'mnemos.browser.command.v1',operation:op,...input})
});
function env({approve=async()=>false, permitted=()=>true}={}){
  const saved=new Map([['coreBridge.verifier',Buffer.from('a'.repeat(64)).toString('base64')]]),actions=[];
  const grantId='00000000-0000-0000-0000-000000000001';
  const fetchImpl=async(_url,{body})=>permitted(JSON.parse(body))
    ?Response.json({grantId,expiresAt:new Date(Date.now()+60_000).toISOString()})
    :Response.json({code:'BROWSER_GRANT_DENIED'},{status:403});
  const bridge=new CoreBrowserBridge({store:{get:(k,d)=>saved.get(k)??d,set:(k,v)=>saved.set(k,v)},crypto,fetchImpl,
    getTabs:()=>[{id:'public',project:'mnemos',url:'https://jobs.example.com/apply',title:'Jobs',private:false},
      {id:'private',url:'https://jobs.example.com/private',private:true}],
    inspectTab:async()=>({title:'Jobs',text:'job listing'}),
    readAnswer:async(id,{offset,length})=>({kind:'PAGE_TEXT_ONLY',unverified:true,offset,
      total:14000,content:'Q'.repeat(14000).slice(offset,offset+length),
      nextOffset:offset+length<14000?offset+length:null}),
    openUrl:async()=>({id:'new'}),selectTab:async()=>{},
    performAction:async(id,action,scope)=>{if(scope)await scope.authorize();actions.push({id,action});return {triggered:true,
      submitted:action.operation==='tab.submit',verifiedSubmission:false}},
    approve});
  return {bridge,actions,saved};
}
test('authenticated gateway edits draft without prompt; only external submit prompts owner',async()=>{
  const approvals=[],x=env({approve:async a=>{approvals.push(a);return true}});
  const input={tabId:'public',expectedOrigin:'https://jobs.example.com',index:2,
    expectedName:'Full name',value:'Jane Example'};
  const message=command('tab.fill',input);
  const result=await x.bridge.answer(message);
  assert.equal(result.ok,true);
  assert.equal(x.actions.length,1);
  assert.equal(approvals.length,0,'draft editing must not require confirmation');
  assert.ok(x.saved.get('coreBridge.mutationStarted').includes(message.messageId));
  const replay=await x.bridge.answer(message);
  assert.equal(replay.error,'ACTION_ALREADY_STARTED_CHECK_SITE_MANUALLY');
  assert.equal(x.actions.length,1);
  const submit=await x.bridge.answer(command('tab.submit',{tabId:'public',expectedOrigin:'https://jobs.example.com',
    index:3,expectedText:'Submit'}));
  assert.equal(submit.ok,true);
  assert.equal(submit.data.verifiedSubmission,false);
  assert.equal(approvals.length,1);
  assert.equal(approvals[0].operation,'tab.submit');
  assert.equal(x.actions.length,2);
  const attachCommand=command('tab.attach',{tabId:'public',expectedOrigin:'https://jobs.example.com',
    index:0,expectedName:'Upload CV'});
  const uploaded=await x.bridge.answer(attachCommand);
  assert.equal(uploaded.ok,true);
  assert.equal(x.actions[2].action.operation,'tab.attach');
  assert.equal(x.actions[2].action.expectedPath,'/apply');
  // Native Windows file picker is the owner's consent gate: no duplicate popup.
  assert.equal(approvals.length,1);
  const replayed=await x.bridge.answer(attachCommand);
  assert.equal(replayed.error,'ACTION_ALREADY_STARTED_CHECK_SITE_MANUALLY');
  assert.equal(x.actions.length,3);
});
test('private tabs, mismatched origins, unknown sender, and declined requests do not execute',async()=>{
  const x=env();
  const d=await x.bridge.answer(command('tab.describe',{tabId:'private',expectedOrigin:'https://jobs.example.com'}));
  assert.equal(d.error,'TAB_NOT_ACCESSIBLE');
  const f=await x.bridge.answer(command('tab.fill',{tabId:'public',expectedOrigin:'https://attacker.example.com',
    index:0,expectedName:'Name',value:'New'}));
  assert.equal(f.error,'EXPECTED_ORIGIN_MISMATCH');
  const declined=await x.bridge.answer(command('tab.submit',{tabId:'public',expectedOrigin:'https://jobs.example.com',
    index:0,expectedText:'Submit'}));
  assert.equal(declined.error,'USER_DECLINED');
  const attacker=await x.bridge.answer(command('tabs.list',{},'untrusted-remote'));
  assert.equal(attacker.error,'UNTRUSTED_SENDER');
  const evalScript=await x.bridge.answer(command('tab.eval',{tabId:'public',script:'alert(1)'}));
  assert.equal(evalScript.error,'UNKNOWN_OPERATION');
  assert.equal(x.actions.length,0);
});

test('revocation during native approval stops submission and missing grants stop the prompt',async()=>{
  let active=true, approvals=0;
  const x=env({permitted:()=>active,approve:async()=>{approvals++;active=false;return true;}});
  const submit=()=>x.bridge.answer(command('tab.submit',{tabId:'public',expectedOrigin:'https://jobs.example.com',index:0,expectedText:'Submit'}));
  assert.equal((await submit()).error,'BROWSER_GRANT_DENIED');
  assert.equal((await submit()).error,'BROWSER_GRANT_DENIED');
  assert.equal(approvals,1);
  assert.deepEqual(x.actions,[]);
});

test('paginated answer reads are read-only, bounded and scoped to permitted tabs',async()=>{
  const approvals=[],x=env({approve:async action=>{approvals.push(action);return false;}});
  const first=await x.bridge.answer(command('tab.answer',{
    tabId:'public',expectedOrigin:'https://jobs.example.com',offset:0,length:6000
  }));
  assert.equal(first.ok,true);
  assert.equal(first.data.content.length,6000);
  assert.equal(first.data.nextOffset,6000);
  assert.equal(first.data.unverified,true);
  const second=await x.bridge.answer(command('tab.answer',{
    tabId:'public',expectedOrigin:'https://jobs.example.com',offset:6000,length:6000
  }));
  assert.equal(second.data.content.length,6000);
  assert.equal(approvals.length,0);
  const privateTab=await x.bridge.answer(command('tab.answer',{
    tabId:'private',expectedOrigin:'https://jobs.example.com',offset:0,length:6000
  }));
  assert.equal(privateTab.error,'TAB_NOT_ACCESSIBLE');
  const invalid=await x.bridge.answer(command('tab.answer',{
    tabId:'public',expectedOrigin:'https://jobs.example.com',offset:0,length:8000
  }));
  assert.equal(invalid.error,'INVALID_ANSWER_PAGE');
  const wrongOrigin=await x.bridge.answer(command('tab.answer',{
    tabId:'public',expectedOrigin:'https://attacker.example.com',offset:0,length:6000
  }));
  assert.equal(wrongOrigin.error,'EXPECTED_ORIGIN_MISMATCH');
  assert.equal(x.actions.length,0);
});
test('trusted browser navigation, reading and draft interactions require zero confirmation dialogs',async()=>{
  const approvalCalls=[],x=env({approve:async a=>{approvalCalls.push(a);return false}});
  const common={tabId:'public',expectedOrigin:'https://jobs.example.com'};
  const actions=[
    ['tab.inspect',common],
    ['tab.describe',{...common,limit:5}],
    ['tab.fill',{...common,index:0,expectedName:'Full name',value:'Jane'}],
    ['tab.choose',{...common,index:0,expectedName:'Role',value:'engineering'}],
    ['tab.toggle',{...common,index:0,expectedName:'Remote',checked:true}],
    ['tab.click',{...common,index:0,expectedText:'Show details'}],
    ['tab.select',{tabId:'public'}],
    ['tab.open',{url:'https://jobs.example.com/list',project:'mnemos'}],
    ['tab.attach',{...common,index:1,expectedName:'Upload CV'}]
  ];
  for(const [op,input] of actions){
    const reply=await x.bridge.answer(command(op,input));
    assert.equal(reply.ok,true,op+' should proceed without a duplicate confirmation');
  }
  assert.equal(approvalCalls.length,0);
  assert.equal(x.actions.length,6);
  const submit=await x.bridge.answer(command('tab.submit',{...common,index:1,expectedText:'Submit application'}));
  assert.equal(submit.error,'USER_DECLINED');
  assert.equal(approvalCalls.length,1);
  assert.equal(approvalCalls[0].operation,'tab.submit');
  assert.equal(x.actions.length,6,'no external submission without owner confirmation');
});

