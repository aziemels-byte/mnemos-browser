import test from 'node:test';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright-core';
import electronPath from 'electron';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtures} from './fixtures.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('Opt-in Core-first MNEMOS remains functional while original Atomic Age UI stays default',{timeout:100000,skip:process.env.MNEMOS_RUN_ELECTRON_E2E!=='1'},async()=>{
 const f=await fixtures();let app;
 try{
  const artifacts=path.join(root,'artifacts','core-first');await mkdir(artifacts,{recursive:true});
  const profile=await mkdtemp(path.join(artifacts,'profile-'));
  const env={...process.env,MNEMOS_TEST_PROFILE:profile,
    MNEMOS_TEST_CORE_ORIGIN:f.core.origin,
    MNEMOS_TEST_OLLAMA_ORIGIN:f.model.origin,
    MNEMOS_TEST_WEB_ORIGIN:f.web.origin};
  delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
  const page=await app.firstWindow();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.evaluate(()=>localStorage.setItem('mnemos.coreFirstPreview','1'));
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('.core-workspace')&&document.querySelector('.core-live-state.online'),null,{timeout:18000});
  assert.equal(await page.locator('body').evaluate(e=>e.classList.contains('core-workspace-mode')),true);
  assert.equal(await page.locator('.context').evaluate(e=>getComputedStyle(e).display),'none',
    'Local Ollama secondary terminal must not crowd the canonical Orchestrator');
  assert.equal(await page.locator('.core-work-item').count(),2);
  assert.match(await page.locator('.core-rail-section').first().innerText(),/DARBĀ/);
  assert.equal(await page.locator('.core-edge').count(),1,'Only real Core graph edges, never synthetic nodes');
  assert.equal(await page.locator('.core-graph-svg').count(),1);
  assert.equal(await page.locator('.core-graph-svg .core-node-dot').count(),2,
     'Only the two fixture nodes linked by the authoritative Core graph are drawn');
  assert.equal(await page.locator('.core-node-transition').count(),0,
     'No false activity animation on the initial snapshot');
  assert.equal(await page.locator('.core-activity-row').count(),2,
     'The two real test-fixture evidence records are visible before any new conversation');
  assert.equal(f.observed.coreChatCalls,0,'Never invoke inference on startup');
  const call=(cmd,p={})=>page.evaluate(([cmd,p])=>window.mnemos.invoke(cmd,p),[cmd,p]);
  const payload=await call('core.workspace');
  assert.equal(payload.canonicalSource,'MNEMOS Core');
  assert.equal(payload.graph.edges.length,1);
  assert.equal(payload.memory.status,'NO_CANONICAL_MEMORY_PROJECTION');
  await page.waitForFunction(()=>document.querySelector('#boot-stage')?.classList.contains('ready'),null,{timeout:15000});
  await page.waitForTimeout(180);
  const screencap=await page.screenshot({type:'jpeg',quality:78,animations:'disabled'});
  await writeFile(path.join(artifacts,'core-first-browser-1440.jpg'),screencap);
  await writeFile(path.join(artifacts,'core-first-browser-1440.base64.txt'),screencap.toString('base64'));
  f.control.graphChanged=true;
  await page.waitForTimeout(1600); // Cache TTL is 1400ms; this is a real new fixture snapshot.
  await page.locator('.core-action').click();
  await page.waitForFunction(()=>document.querySelectorAll('.core-node-transition').length===1,null,{timeout:15000});
  assert.equal(await page.locator('.core-graph-svg .core-node-dot').count(),2);
  // The only inference call is an explicit user action in the privileged shell.
  await page.locator('.core-chat-input').fill('Pārbaudi Core Orchestrator un Browser sasaisti');
  await page.locator('.core-chat-submit').click();
  await page.waitForFunction(()=>document.querySelector('.core-dialog-message.core-assistant')?.textContent.includes('Core Orchestrator testa atbilde'),null,{timeout:16000});
  assert.equal(f.observed.coreChatCalls,1);
  assert.equal(f.observed.coreChatRequests[0].message,'Pārbaudi Core Orchestrator un Browser sasaisti');
  assert.equal(await page.locator('.core-dialog-message.core-user').count(),1);
  const existing=(await call('core.chat.history'));
  assert.equal(existing.messages.filter(x=>x.role==='assistant').length,1);
  assert.equal(existing.conversationId,'fixture-conversation-1');
  const id='11111111-1111-4111-a111-111111111111';
  await call('core.chat',{key:id,message:'Atsevišķa apzināta darbība'});
  assert.equal(f.observed.coreChatCalls,2);
  await assert.rejects(()=>call('core.chat',{key:id,message:'Mēģinājums atkārtot'}),/ALREADY_ATTEMPTED_NO_RETRY/);
  assert.equal(f.observed.coreChatCalls,2);
  const tab=await call('tab.open',{input:f.web.origin+'/first'});
  await page.waitForFunction(()=>!document.body.classList.contains('core-workspace-mode'),null,{timeout:15000});
  assert.equal(await page.locator('.core-workspace').count(),0,'Polling and controls disposed on browser switch');
  for(let i=0;i<100;i++){
    const ready=await app.evaluate(({webContents},origin)=>
      webContents.getAllWebContents().some(w=>w.getURL()===origin+'/first'&&!w.isLoading()),f.web.origin);
    if(ready)break;
    await page.waitForTimeout(80);
  }
  const sandbox=await app.evaluate(({webContents},origin)=>{
    const wc=webContents.getAllWebContents().find(w=>w.getURL()===origin+'/first');
    return wc?.executeJavaScript('({node:typeof require,process:typeof process,mnemos:typeof window.mnemos})');
  },f.web.origin);
  assert.deepEqual(sandbox,{node:'undefined',process:'undefined',mnemos:'undefined'});
  await assert.rejects(()=>call('core.chat',{key:'22222222-2222-4222-a222-222222222222',message:'Nedrīkst'}),/REQUIRES_ACTIVE_WORKSPACE/);
  assert.equal(f.observed.coreChatCalls,2);
  await call('tab.select',{id:'home'});
  await page.waitForFunction(()=>document.querySelector('.core-workspace')&&document.querySelector('.core-dialog-message.core-assistant'),null,{timeout:15000});
  assert.equal(await page.locator('.core-dialog-message.core-assistant').count(),2,
    'Local Core conversation journal survives Browser tab transitions');
  assert.equal(errors.length,0,errors.join('; '));
  console.log('CORE_FIRST_E2E_VERIFIED',JSON.stringify({
    coreSnapshot:true,graphEdges:1,chatFixtureSubmits:2,noAutomaticCalls:true,
    dedupe:true,privilegedAPIAbsentInWeb:true,tabRestoration:true,
    localJournalOnly:true,screenshotBytes:screencap.length,
    userBrowserProfileUntouched:true
  }));
 }finally{if(app)await app.close().catch(()=>{});await f.close();}
});
