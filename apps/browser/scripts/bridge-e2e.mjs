import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { OWNER_SESSION, PERPLEXITY_GATEWAY_SESSION } from '../src/core-browser-bridge.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.env.MNEMOS_BROWSER_BRIDGE_E2E_OUTPUT??path.join(root,'artifacts','bridge'));
const profileBase=path.join(output,'profiles');
await mkdir(profileBase,{recursive:true});
const profile=await mkdtemp(path.join(profileBase,'profile-'));
const verifier='b'.repeat(64),queue=[],sent=[],ack=[],calls=[];
const threadId='thr_'+randomUUID();
const checks=[];
let server,app,page,origin,grantDecision;
const grantId=randomUUID();
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
const handler=async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),chunks=[];
  for await(const part of req)chunks.push(part);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};
  calls.push({method:req.method,path:url.pathname,authorization:!!req.headers['x-mnemos-frontier-verifier']});
  if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{version:'bridge-test'});
  if(req.method==='GET'&&url.pathname==='/api/cockpit/snapshot')return json(res,200,{tasks:[],providers:[],frontierSessions:{counts:{}}});
  if(req.method==='GET'&&url.pathname==='/api/owner-goals')return json(res,200,{goals:[]});
  if(req.method==='GET'&&url.pathname==='/api/tags')return json(res,200,{models:[]});
  if(/^\/fixture(?:\/next|\/focus)?$/.test(url.pathname)){
    res.writeHead(200,{'content-type':'text/html'});
    return res.end('<html><title>Bridge fixture</title><body>Safe test page '+url.pathname+'</body></html>');
  }
  if(url.pathname==='/api/frontier-sessions/register')return json(res,201,{sessionId:body.sessionId,verifier});
  if(url.pathname==='/api/browser/action-grants/authorize'){
    if(req.headers['x-mnemos-frontier-verifier']!==verifier||!queue.some(message=>message.messageId===body.messageId))
      return json(res,403,{code:'BROWSER_GRANT_DENIED'});
    if(grantDecision&&!await grantDecision(body))return json(res,403,{code:'BROWSER_GRANT_DENIED'});
    return json(res,200,{grantId,expiresAt:new Date(Date.now()+60_000).toISOString()});
  }
  if(url.pathname.endsWith('/inbox')&&req.method==='GET'){
    if(req.headers['x-mnemos-frontier-verifier']!==verifier)return json(res,403,{error:'invalid verifier'});
    return json(res,200,{messages:queue.filter(m=>!ack.includes(m.messageId))});
  }
  if(url.pathname==='/api/frontier-sessions/send'){
    if(body.verifier!==verifier)return json(res,403,{error:'invalid verifier'});
    sent.push(body);return json(res,201,{messageId:'msg_reply'});
  }
  if(url.pathname.endsWith('/ack')){
    if(body.verifier!==verifier)return json(res,403,{error:'invalid verifier'});
    ack.push(body.messageId);return json(res,200,{status:'ACKNOWLEDGED'});
  }
  return json(res,404,{error:'not found'});
};
async function call(operation,payload={}){return page.evaluate(([op,p])=>window.mnemos.invoke(op,p),[operation,payload]);}
async function enqueue(operation,args={},from=OWNER_SESSION){
  const messageId='msg_'+randomUUID();
  queue.push({messageId,threadId,from,expectsReply:true,
    body:JSON.stringify({schema:'mnemos.browser.command.v1',operation,...args})});
  return messageId;
}
async function receipt(messageId){
  for(let n=0;n<100&&!ack.includes(messageId);n++)await page.waitForTimeout(100);
  assert.ok(ack.includes(messageId),'Core fixture must receive ACK');
  const result=sent.find(row=>row.replyTo===messageId);
  assert.ok(result,'Core fixture must receive the matching result');
  return JSON.parse(result.body);
}
const command=async(operation,args={},from)=>receipt(await enqueue(operation,args,from));
async function waitTab(predicate){
  for(let n=0;n<100;n++){
    const state=await call('snapshot');
    if(predicate(state))return state;
    await page.waitForTimeout(100);
  }
  throw new Error('Expected browser state did not arrive');
}
async function check(test_id,actions,expected_result,fn){
  const record={test_id,environment:'Electron Chromium and loopback HTTP fixture',
    components:['Browser main','CoreBrowserBridge','fixture Frontier transport'],
    actions,expected_result,evidence_location:path.join(output,'bridge-results.json')};
  try {
    record.actual_result=await fn();
    record.pass_or_fail='VERIFIED';
    console.log('PASS '+test_id+' '+actions);
  } catch(error) {
    record.actual_result=error.message;
    record.pass_or_fail='FAILED';
    throw error;
  } finally { checks.push(record); }
}
try {
  server=http.createServer((req,res)=>{handler(req,res).catch(error=>json(res,500,{error:error.message}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin='http://127.0.0.1:'+server.address().port;
  const env={...process.env,MNEMOS_TEST_PROFILE:profile,MNEMOS_TEST_CORE_ORIGIN:origin,
    MNEMOS_TEST_OLLAMA_ORIGIN:origin,MNEMOS_TEST_WEB_ORIGIN:origin};
  delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
  page=await app.firstWindow();
  await page.waitForFunction(()=>!!window.mnemos);
  await page.waitForFunction(()=>document.getElementById('core-state')?.textContent.includes('bridge-test'));
  const tab=await call('tab.open',{input:origin+'/fixture?access_token=DO_NOT_EXPORT'});
  assert.ok(tab.id);
  await waitTab(state=>state.tabs.some(row=>row.id===tab.id&&!row.loading));
  const initial=await enqueue('tabs.list');
  await call('section',{name:'settings'});
  await page.getByRole('button',{name:'Savienot',exact:true}).click();
  const response=await receipt(initial);
  assert.equal(response.schema,'mnemos.browser.result.v1');
  assert.equal(response.ok,true);
  assert.equal(response.data.tabs.length,1);
  assert.equal(response.data.tabs[0].url,origin+'/fixture');
  assert.ok(!JSON.stringify(response).includes('DO_NOT_EXPORT'));
  const browserInstanceId=response.data.browserInstanceId;
  assert.equal((await call('snapshot')).bridge.sessionId,browserInstanceId);
  assert.equal((await call('snapshot')).bridge.connected,true);
  assert.ok(calls.some(c=>c.path==='/api/frontier-sessions/register'));
  const target={browserInstanceId,tabId:tab.id,expectedOrigin:origin};
  await app.evaluate(({dialog})=>{
    globalThis.browserLifecycleDecision=1;
    globalThis.browserLifecyclePrompts=[];
    dialog.showMessageBox=async (_window,options)=>{
      globalThis.browserLifecyclePrompts.push(options.detail);
      return {response:globalThis.browserLifecycleDecision};
    };
  });

  await check('A','Discover window, inspect page and exercise native navigation history',
    'The Chromium tab returns fixture text and remains bound to the same browser and tab ID',async()=>{
    const windows=await command('windows.list',{browserInstanceId});
    assert.deepEqual(windows.data.windows,[{id:'main',tabCount:1}]);
    const inspected=await command('tab.inspect',target);
    assert.equal(inspected.data.text,'Safe test page /fixture');
    for(const [operation,args,location] of [
      ['tab.navigate',{url:origin+'/fixture/next'},'/fixture/next'],
      ['tab.back',{},'/fixture'],
      ['tab.forward',{},'/fixture/next'],
      ['tab.reload',{},'/fixture/next']
    ]){
      const reply=await command(operation,{...target,...args});
      assert.equal(reply.error,undefined,operation);
      assert.equal(reply.data.readiness,'READY',operation);
      assert.equal(reply.data.url,origin+location,operation);
      await waitTab(state=>state.tabs.some(row=>row.id===tab.id&&new URL(row.url).pathname===location&&!row.loading));
    }
    return 'Window discovery, redacted inspect, navigate, back, forward, and reload verified';
  });

  const project=await call('project.create',{name:'Second browser profile'});
  const focus=await call('tab.open',{input:origin+'/fixture/focus',project:project.id});
  await waitTab(state=>state.activeId===focus.id&&state.tabs.some(row=>row.id===focus.id&&!row.loading));

  await check('C','Navigate a background tab while a second profile tab is focused',
    'Only the named tab navigates. Missing or wrong instance IDs never target the focused tab',async()=>{
    assert.equal((await command('tab.status',{...target,browserInstanceId:'unrelated'})).error,'BROWSER_INSTANCE_MISMATCH');
    assert.equal((await command('tab.status',{tabId:tab.id,expectedOrigin:origin})).error,'BROWSER_INSTANCE_REQUIRED');
    const result=await command('tab.navigate',{...target,url:origin+'/fixture'});
    assert.equal(result.error,undefined);
    const state=await waitTab(value=>value.tabs.some(row=>row.id===tab.id&&row.url===origin+'/fixture'&&!row.loading));
    assert.equal(state.activeId,focus.id);
    assert.equal(state.tabs.find(row=>row.id===focus.id).url,origin+'/fixture/focus');
    return 'Background tab changed, focused tab URL and focus stayed intact';
  });

  await check('G','Attempt lifecycle operations with an unauthorized actor and a different destination origin',
    'Unauthorized requests never reach the native approval prompt. A declined owner action leaves the tab intact',async()=>{
    const denied=await command('tab.close',target,PERPLEXITY_GATEWAY_SESSION);
    assert.equal(denied.error,'BROWSER_LIFECYCLE_SCOPE_DENIED');
    const crossOrigin=await command('tab.navigate',{...target,url:'https://example.org/'});
    assert.equal(crossOrigin.error,'NAVIGATION_SCOPE_DENIED');
    const before=await app.evaluate(()=>globalThis.browserLifecyclePrompts.length);
    assert.equal(before,5,'unauthorized actions must not open a prompt');
    await app.evaluate(()=>{globalThis.browserLifecycleDecision=0;});
    try {
      assert.equal((await command('tab.close',target)).error,'USER_DECLINED');
    } finally {
      await app.evaluate(()=>{globalThis.browserLifecycleDecision=1;});
    }
    assert.deepEqual(await app.evaluate(()=>globalThis.browserLifecyclePrompts.slice(-1)),[origin+'/fixture']);
    assert.ok((await call('snapshot')).tabs.some(row=>row.id===tab.id&&row.url===origin+'/fixture'));
    return 'Gateway close, cross-origin navigation, and locally declined owner close were blocked';
  });

  await check('H','Kill the Chromium renderer and recover it through the named tab',
    'Crash state is reported, recovery reloads the same tab and a saved task remains available',async()=>{
    const task=await call('item.create',{kind:'task',title:'Persist through renderer crash'});
    await app.evaluate(({webContents},url)=>{
      const contents=webContents.getAllWebContents().find(wc=>wc.getURL()===url);
      if(!contents)throw new Error('Fixture tab missing');
      contents.forcefullyCrashRenderer();
    },origin+'/fixture');
    await waitTab(state=>state.tabs.some(row=>row.id===tab.id&&row.crashed));
    assert.equal((await command('tab.status',target)).data.readiness,'CRASHED');
    const recovered=await command('tab.recover',target);
    assert.equal(recovered.error,undefined);
    assert.deepEqual(recovered.data,{tabId:tab.id,readiness:'READY',url:origin+'/fixture'});
    const state=await waitTab(value=>value.tabs.some(row=>row.id===tab.id&&!row.crashed&&!row.loading));
    assert.ok(state.local.items.some(item=>item.id===task.id));
    assert.equal((await command('tab.inspect',target)).data.text,'Safe test page /fixture');
    return 'Real renderer killed and reloaded on the same tab ID with the task intact';
  });

  await check('A','Close the exact tab through owner confirmation and verify cleanup',
    'The approval path closes only the named tab and leaves its sibling active',async()=>{
    const closed=await command('tab.close',target);
    assert.equal(closed.error,undefined);
    assert.deepEqual(closed.data,{tabId:tab.id,readiness:'CLOSED'});
    const state=await call('snapshot');
    assert.ok(!state.tabs.some(row=>row.id===tab.id));
    assert.equal(state.activeId,focus.id);
    assert.ok(!await app.evaluate(({webContents},url)=>webContents.getAllWebContents().some(wc=>wc.getURL()===url),origin+'/fixture'));
    return 'Test-controlled owner confirmation closed the intended WebContents and preserved the sibling';
  });

  await check('B','Describe, fill, toggle and click controls through the Chromium bridge',
    'A scoped HTTPS fixture receives the intended draft values and displays the preview',async()=>{
    const formOrigin='https://forms.mnemos.invalid';
    const project=await call('project.create',{name:'Form fixture profile'});
    const formTab=await call('tab.open',{input:origin+'/fixture/focus',project:project.id});
    await waitTab(state=>state.tabs.some(row=>row.id===formTab.id&&!row.loading));
    await app.evaluate(({session},{projectId,formOrigin})=>{
      const partition=session.fromPartition('persist:mnemos-project-'+projectId);
      partition.webRequest.onBeforeRequest((details,respond)=>{
        respond({cancel:new URL(details.url).origin!==formOrigin});
      });
      partition.protocol.handle('https',request=>{
        if(![formOrigin+'/draft',formOrigin+'/changed'].includes(request.url))
          return new Response('Fixture route not found',{status:404});
        return new Response([
          '<title>Native form fixture</title>',
          '<form><label for="name">Project name</label><input id="name">',
          '<label for="review">Include review</label><input id="review" type="checkbox">',
          '<button type="button" id="preview">Preview draft</button>',
          '<output id="result"></output></form>',
          '<script>document.getElementById("preview").addEventListener("click",()=>{',
          'const name=document.getElementById("name").value;',
          'const review=document.getElementById("review").checked;',
          'document.getElementById("result").textContent="Preview: "+name+" / "+review;',
          '});</script>'
        ].join(''),{headers:{'content-type':'text/html; charset=utf-8'}});
      });
    },{projectId:project.id,formOrigin});
    await call('tab.navigate',{id:formTab.id,input:formOrigin+'/draft'});
    await waitTab(state=>state.tabs.some(row=>row.id===formTab.id&&row.url===formOrigin+'/draft'&&!row.loading));
    const formTarget={browserInstanceId,tabId:formTab.id,expectedOrigin:formOrigin};
    const description=await command('tab.describe',formTarget);
    assert.equal(description.error,undefined);
    const name=description.data.fields.find(field=>field.name==='Project name');
    const review=description.data.fields.find(field=>field.name==='Include review');
    const preview=description.data.buttons.find(button=>button.text==='Preview draft');
    assert.ok(name&&review&&preview);
    const operations=[
      ['tab.fill',{index:name.index,expectedName:name.name,value:'MNEMOS fixture'}],
      ['tab.toggle',{index:review.index,expectedName:review.name,checked:true}],
      ['tab.click',{index:preview.index,expectedText:preview.text}]
    ];
    for(const [operation,arguments_] of operations){
      const reply=await command(operation,{...formTarget,...arguments_});
      assert.equal(reply.error,undefined,operation);
    }
    const inspected=await command('tab.inspect',formTarget);
    assert.ok(inspected.data.text.includes('Preview: MNEMOS fixture / true'));
    return 'Production bridge described and operated controls in an Electron-only HTTPS fixture';
  });

  await check('G2','Recheck a grant at dispatch and block a same-origin page change',
    'Revocation and a replaced page both prevent the click',async()=>{
    const snapshot=await call('snapshot');
    const form=snapshot.tabs.find(tab=>tab.url==='https://forms.mnemos.invalid/draft');
    const target={browserInstanceId,tabId:form.id,expectedOrigin:new URL(form.url).origin,
      index:0,expectedText:'Preview draft'};
    try{
      grantDecision=body=>!body.grantId;
      const revoked=await command('tab.click',target);
      assert.equal(revoked.error,'BROWSER_GRANT_DENIED');
      grantDecision=async body=>{
        if(body.grantId){
          const changed=target.expectedOrigin+'/changed';
          await call('tab.navigate',{id:form.id,input:changed});
          await waitTab(state=>state.tabs.some(tab=>tab.id===form.id&&tab.url===changed&&!tab.loading));
        }
        return true;
      };
      const changed=await command('tab.click',target);
      assert.equal(changed.error,'TAB_PAGE_CHANGED');
      const view=await command('tab.inspect',{tabId:form.id,expectedOrigin:target.expectedOrigin});
      assert.ok(!view.data.text.includes('Preview:'));
    }finally{
      grantDecision=null;
      await call('tab.close',{id:form.id});
    }
    return 'Revoked lease and document replacement both stopped the requested click';
  });

  await call('section',{name:'settings'});
  await page.getByRole('button',{name:'Atvienot',exact:true}).click();
  assert.equal((await call('snapshot')).bridge.enabled,false);
  console.log(JSON.stringify({passed:checks.length,bridgeConnected:true,tabRead:true,redacted:true,acknowledged:true}));
} catch(error){
  console.error(error);
  process.exitCode=1;
} finally {
  if(app)await app.close().catch(()=>{});
  if(server)await new Promise(resolve=>server.close(resolve));
  await writeFile(path.join(output,'bridge-results.json'),JSON.stringify({
    capturedAt:new Date().toISOString(),fixtureCore:true,externalProvider:false,
    checks
  },null,2));
}
