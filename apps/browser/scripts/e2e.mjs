import {_electron as electron} from 'playwright-core';
import electronPath from 'electron';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fixtures} from '../test/fixtures.mjs';
import {CollaborationStore} from '../connectors/perplexity/collaboration-store.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(process.env.MNEMOS_BROWSER_E2E_OUT??path.join(root,'artifacts'));await mkdir(out,{recursive:true});
const profileBase=path.join(out,'browser-test-profiles');await mkdir(profileBase,{recursive:true});
const profile=await mkdtemp(path.join(profileBase,'profile-'));
const f=await fixtures(),checks=[],errors=[];
let app,page;
const env={...process.env,MNEMOS_TEST_PROFILE:profile,MNEMOS_TEST_CORE_ORIGIN:f.core.origin,MNEMOS_TEST_OLLAMA_ORIGIN:f.model.origin,MNEMOS_TEST_WEB_ORIGIN:f.web.origin};delete env.ELECTRON_RUN_AS_NODE;
async function launch(){app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>!!window.mnemos);await page.waitForFunction(()=>document.getElementById('core-state')?.textContent.includes('fixture'));}
async function waitState(predicate){for(let n=0;n<150;n++){const s=await call('snapshot');if(predicate(s))return s;await page.waitForTimeout(100);}throw new Error('State condition timed out');}
async function check(name,fn){await fn();checks.push({name,passed:true});console.log('PASS '+name);}
async function call(op,payload={}){return page.evaluate(([op,p])=>window.mnemos.invoke(op,p),[op,payload]);}
async function waitWeb(suffix=''){for(let n=0;n<100;n++){const ready=await app.evaluate(({webContents},{origin,suffix})=>webContents.getAllWebContents().some(w=>w.getURL().startsWith(origin)&&(!suffix||w.getURL()===origin+suffix)&&!w.isLoading()),{origin:f.web.origin,suffix});if(ready)return;await page.waitForTimeout(150);}throw new Error('Native web navigation did not complete: '+JSON.stringify(await call('snapshot')));}
async function webEval(script){return app.evaluate(({webContents},{origin,script})=>{const wc=webContents.getAllWebContents().filter(w=>w.getURL().startsWith(origin)).sort((a,b)=>a.id-b.id).at(-1);if(!wc)throw new Error('No web content');return wc.executeJavaScript(script,true);},{origin:f.web.origin,script});}
async function authStatus(url){
  return app.evaluate(({webContents},url)=>{
    const target=webContents.getAllWebContents().find(w=>w.getURL()===url);
    if(!target)throw new Error('Authentication fixture tab not found');
    return target.executeJavaScript("fetch('/fixture-auth/session').then(response=>response.status)");
  },url);
}
let savedProject,privateId,authenticatedTabId;
try{
  await launch();
  await page.waitForSelector('.dashboard-unit');
  assert.equal(await page.locator('.core-workspace').count(),0,'Original Atomic Age UI must be default');
  await page.evaluate(()=>localStorage.setItem('mnemos.coreFirstPreview','1'));
  await page.reload();
  await check('Core-first Browser workspace is real, source-attributed, isolated and inference-idle',async()=>{
    await page.waitForFunction(()=>document.querySelector('.core-workspace')&&
      document.querySelector('.core-live-state.online'));
    const result=await page.evaluate(()=>{
      const css=getComputedStyle(document.documentElement);
      return {
        brand:document.querySelector('.brand')?.textContent,
        nav:document.querySelectorAll('#nav button').length,
        coreStatus:document.querySelector('.core-live-state')?.textContent,
        coreRail:document.querySelector('.core-rail-content')?.textContent,
        coreSource:document.querySelector('.core-source-line')?.textContent,
        contextHidden:getComputedStyle(document.querySelector('.context')).display==='none',
        shellSecure:typeof require==='undefined'&&typeof process==='undefined',
        loaded:[...document.styleSheets].some(s=>s.href?.endsWith('/core-workspace.css')),
        body:document.body.classList.contains('core-workspace-mode')
      };
    });
    assert.match(result.brand,/ATOMIC AGE/);
    assert.equal(result.nav,6);
    assert.equal(result.loaded,true);
    assert.equal(result.body,true);
    assert.equal(result.contextHidden,true);
    assert.equal(result.shellSecure,true);
    assert.match(result.coreStatus,/CORE/);
    assert.match(result.coreSource,/GLOBĀLS CORE SKATS/);
    assert.match(result.coreRail,/Pārbaudīt MNEMOS Core-first arhitektūru/);
    assert.equal(f.observed.coreChatCalls,0,'No inference on startup');
    await page.waitForFunction(()=>document.querySelector('#boot-stage')?.classList.contains('ready'));
  });
  await check('Core-first surface and local settings follow reduced motion and scope transitions',async()=>{
    await call('section',{name:'memory'});
    assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('core-workspace-mode')),false);
    await page.emulateMedia({reducedMotion:'reduce'});
    await call('section',{name:'workspace'});
    await page.waitForSelector('.core-workspace');
    assert.equal(await page.locator('.core-workspace').evaluate(el=>getComputedStyle(el).animationName),'none');
    assert.equal(await page.locator('#boot-stage').evaluate(el=>getComputedStyle(el).display),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
  });
  await page.evaluate(()=>localStorage.removeItem('mnemos.coreFirstPreview'));
  await page.reload();
  await page.waitForSelector('.dashboard-unit');
  await check('privileged shell is isolated and CSP blocks network',async()=>{const prefs=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());assert.equal(prefs.sandbox,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);assert.equal(await page.evaluate(()=>typeof require),'undefined');assert.equal(await page.evaluate(()=>typeof process),'undefined');assert.equal(await page.evaluate(async url=>{try{await fetch(url);return 'REACHED';}catch{return 'BLOCKED';}},f.core.origin),'BLOCKED');});
  await check('create project and local task through the real UI',async()=>{await page.locator('#new-project').click();await page.locator('#dialog-input').fill('Browser izstrāde');await page.locator('#input-form button[type=submit]').click();await waitState(s=>s.local.projects.some(p=>p.name==='Browser izstrāde')&&s.section==='workspace');savedProject=(await call('snapshot')).activeProject;await call('section',{name:'goals'});const taskForm=page.locator('form.inline-form').filter({has:page.getByPlaceholder('Nākamais konkrētais solis')});await taskForm.locator('input').fill('Pārbaudīt cilņu un konteksta izolāciju');await taskForm.locator('button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('.record-title')?.textContent.includes('konteksta izolāciju'));});
  await check('native Chromium tab has no Node, preload or MNEMOS bridge',async()=>{await page.locator('#address').fill(f.web.origin+'/first');await page.locator('#address-form').evaluate(form=>form.requestSubmit());await waitWeb();const result=await webEval('({node:typeof require,process:typeof process,bridge:typeof mnemos,title:document.title})');assert.equal(result.node,'undefined');assert.equal(result.process,'undefined');assert.equal(result.bridge,'undefined');assert.match(result.title,/testa lapa/);const prefs=await app.evaluate(({webContents},origin)=>webContents.getAllWebContents().find(w=>w.getURL().startsWith(origin)).getLastWebPreferences(),f.web.origin);assert.equal(prefs.sandbox,true);assert.equal(prefs.nodeIntegration,false);assert.ok(!prefs.preload);});
  await check('web page cannot fetch loopback Core or navigate to shell scheme',async()=>{const before=f.observed.core.length;assert.equal(await webEval(`fetch('${f.core.origin}/api/health').then(()=> 'REACHED').catch(()=> 'BLOCKED')`),'BLOCKED');assert.equal(f.observed.core.length,before);await webEval("location.href='mnemos://app/index.html';true");await page.waitForTimeout(300);assert.match((await call('snapshot')).tabs[0].url,/\/first/);});
  await check('native navigation, back and forward work',async()=>{await webEval("document.querySelector('a').click();true");await waitWeb('/second');assert.equal((await call('snapshot')).tabs[0].canBack,true);await call('tab.back');await waitWeb('/first');assert.equal((await call('snapshot')).tabs[0].url,f.web.origin+'/first');await call('tab.forward');await waitWeb('/second');assert.equal((await call('snapshot')).tabs[0].url,f.web.origin+'/second');});
  await check('project profiles isolate website cookies',async()=>{await webEval("document.cookie='identity=projectA;path=/;max-age=3600;SameSite=Lax';true");const p=await call('project.create',{name:'Atsevišķa sesija'});await call('tab.open',{input:f.web.origin+'/other',project:p.id});await waitWeb('/other');assert.equal(await webEval('document.cookie'),'');await webEval("document.cookie='identity=projectB;path=/;max-age=3600;SameSite=Lax';true");await call('tab.select',{id:(await call('snapshot')).tabs[0].id});assert.equal(await app.evaluate(({webContents},origin)=>webContents.getAllWebContents().find(w=>w.getURL()===origin+'/second').executeJavaScript('document.cookie'),f.web.origin),'identity=projectA');});
  await check('D controlled test account is authenticated only in its project partition',async()=>{
    const login=await call('tab.open',{input:f.web.origin+'/fixture-auth/login',project:savedProject});
    authenticatedTabId=login.id;
    await waitWeb('/fixture-auth/login');
    await call('tab.navigate',{id:login.id,input:f.web.origin+'/fixture-auth/home'});
    await waitWeb('/fixture-auth/home');
    assert.equal(await authStatus(f.web.origin+'/fixture-auth/home'),204);
    assert.equal(await authStatus(f.web.origin+'/other'),401);
  });
  await check('private tab starts without project cookies and is not persisted',async()=>{const tab=await call('tab.open',{input:f.web.origin+'/private',private:true,project:savedProject});privateId=tab.id;await waitWeb('/private');assert.equal(await webEval('document.cookie'),'');assert.equal((await call('snapshot')).tabs.find(t=>t.id===tab.id).private,true);});
  await check('keyboard address focus works while native web content has focus',async()=>{await app.evaluate(({webContents},origin)=>{const wc=webContents.getAllWebContents().filter(w=>w.getURL().startsWith(origin)).sort((a,b)=>a.id-b.id).at(-1);wc.focus();wc.sendInputEvent({type:'keyDown',keyCode:'L',modifiers:['control']});wc.sendInputEvent({type:'keyUp',keyCode:'L',modifiers:['control']});},f.web.origin);await page.waitForTimeout(200);assert.equal(await page.locator('#address').evaluate(el=>el===document.activeElement),true);});
  await check('modal can be used over a native web tab',async()=>{await page.locator('#new-project').click();await page.locator('#dialog-input').fill('Modalitātes pārbaude');await page.locator('#dialog-cancel').click();assert.equal(await page.locator('#input-dialog').evaluate(d=>d.open),false);});
  await call('project.select',{id:savedProject});
  await call('section',{name:'goals'}); // Local Ollama remains an explicit secondary capability, not the Core home.
  await check('streaming result reaches actual Frontier Bus, is ACKed and can become project memory',async()=>{await page.locator('#prompt').fill('Pārbaudes pieprasījums — nevis īsts AI rezultāts');await page.locator('#send').click();await waitState(s=>s.local.turns[0]?.status==='COMPLETED'&&s.frontier.counts.messages===1&&s.frontier.counts.pending===0&&s.local.outbox.length===0);const s=await call('snapshot');assert.equal(s.frontier.counts.pending,0);assert.equal(s.local.turns[0].output,'Pārbaudīta testa atbilde. Ā😀');assert.equal(f.observed.modelCalls,1);await page.locator('.remember').click();await page.locator('[data-section=memory]').click();await page.waitForFunction(()=>document.querySelector('.record-title')?.textContent.includes('Ā😀'));});
  await check('duplicate turn request never runs inference twice',async()=>{const t=(await call('snapshot')).local.turns[0];await call('turn.submit',{key:t.request_key,model:t.model,prompt:t.prompt});assert.equal(f.observed.modelCalls,1);});
  await check('explicitly selected project memory reaches only that request with untrusted provenance',async()=>{await page.locator('.attachment input').check();await page.locator('#prompt').fill('Izmanto manu izvēlēto pārbaudes kontekstu');await page.locator('#send').click();await waitState(s=>s.local.turns[0]?.status==='COMPLETED'&&s.local.outbox.length===0&&s.frontier.counts.messages===2);const payload=f.observed.modelRequests.at(-1);assert.equal(payload.messages.length,3);const references=JSON.parse(payload.messages[1].content).attachedReferences;assert.equal(references.length,1);assert.equal(references[0].trust,'UNTRUSTED_REFERENCE');assert.match(references[0].text,/testa atbilde/);assert.equal(f.observed.modelRequests[0].messages.length,1);});
  await check('model transport can be cancelled from the UI',async()=>{f.control.slow=true;await page.locator('#prompt').fill('Pārtraukt testa straumi');await page.locator('#send').click();await page.waitForSelector('.cancel-turn');await page.locator('.cancel-turn').click();await waitState(s=>s.local.turns[0]?.status==='CANCELLED');f.control.slow=false;});
  await check('I desktop navigation renders workspace, tasks, memory, models, coordination and system',async()=>{
    for(const name of ['workspace','goals','memory','agents','bus','coordination','settings']){
      const control=name==='settings'?'#settings':`[data-section=${name}]`;
      await page.locator(control).click();
      await waitState(s=>s.section===name);
      assert.ok(await page.locator('h1').textContent());
    }
  });
  await check('Perplexity MCP onboarding displays authenticated HTTPS without exposing key',async()=>{
    await call('section',{name:'agents'});
    await page.waitForSelector('.mcp-card');
    const text=await page.locator('.mcp-card').first().innerText();
    assert.match(text,/https:\/\/homostation-1\.tail09a323\.ts\.net:10000\/mcp/);
    assert.match(text,/API Key/);
    assert.equal(await page.locator('.mcp-card').first().locator('.mcp-controls button').count(),3);
    assert.ok(!text.includes('vault:dpapi'));
    await assert.rejects(()=>call('perplexity.mcp.prepare'),/PERPLEXITY_MCP_LIVE_ONLY/);
    await call('error.clear');
  });
  await check('Gemini OAuth setup card is present and cannot reveal owner secret in test mode',async()=>{
    await call('section',{name:'agents'});
    assert.equal(await page.locator('.mcp-card').count(),2);
    const body=await page.locator('.mcp-card').last().innerText();
    assert.match(body,/Gemini/);
    assert.match(body,/OAuth/);
    assert.ok(!body.includes('vault:dpapi'));
    await assert.rejects(()=>call('gemini.mcp.copyConsent'),/GEMINI_OAUTH_LIVE_ONLY/);
    await call('error.clear');
  });
  await check('980px and 1500px layouts fit without horizontal overflow',async()=>{for(const width of [980,1500]){await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,960),width);await page.waitForTimeout(150);const overflow=await page.evaluate(()=>{const m=document.getElementById('main'),c=document.getElementById('context');return {main:m.scrollWidth>m.clientWidth,context:c.scrollWidth>c.clientWidth,body:document.body.scrollWidth>window.innerWidth};});assert.deepEqual(overflow,{main:false,context:false,body:false});}});
  await check('offline Core is shown honestly while local workspace remains usable',async()=>{f.control.coreOffline=true;await call('refresh');assert.equal((await call('snapshot')).core.online,false);await call('item.create',{kind:'goal',title:'Darbs bez Core'});assert.ok((await call('snapshot')).local.items.find(i=>i.title==='Darbs bez Core'));f.control.coreOffline=false;await call('refresh');});
  await call('error.clear');await call('section',{name:'workspace'});await page.waitForTimeout(200);await page.screenshot({path:path.join(out,'workspace-fixture.png')});
  const first=(await call('snapshot')).tabs[0];await call('tab.select',{id:first.id});await page.waitForTimeout(150);const captured=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));await writeFile(path.join(out,'browser-fixture.png'),Buffer.from(captured,'base64'));
  const destroyedTabUrl=f.web.origin+'/destroyed-tab';
  await check('native WebContents destruction removes its tab and updates the shell',async()=>{
    const {id}=await call('tab.open',{input:destroyedTabUrl,project:savedProject});
    await waitWeb('/destroyed-tab');
    const viewLostContents=await app.evaluate(async({BrowserWindow},url)=>{
      const view=BrowserWindow.getAllWindows()[0].contentView.children
        .find(child=>child.webContents?.getURL()===url);
      const wc=view.webContents;
      const destroyed=new Promise(resolve=>wc.once('destroyed',resolve));
      wc.close();
      await destroyed;
      return view.webContents===undefined;
    },destroyedTabUrl);
    assert.equal(viewLostContents,true,'Electron must expose the stale WebContentsView case');
    const s=await call('snapshot');
    assert.equal(s.activeId,'home');
    assert.ok(!s.tabs.some(t=>t.id===id));
    assert.ok(s.tabs.some(t=>t.url===f.web.origin+'/second'));
    await page.waitForFunction(()=>document.querySelector('#tabs [aria-selected="true"]')?.textContent.includes('MNEMOS'));
  });
  await check('restart restores project data, persistent tabs and cookies while dropping private tabs',async()=>{await app.close();await launch();await waitWeb('/second');const s=await call('snapshot');assert.ok(s.local.projects.find(p=>p.id===savedProject));assert.equal(s.tabs.some(t=>t.id===privateId||t.private),false);assert.ok(s.local.items.find(i=>i.kind==='memory'));assert.ok(s.local.turns.find(t=>t.status==='CANCELLED'));assert.ok(s.tabs.some(t=>t.url===f.web.origin+'/second'));assert.ok(!s.tabs.some(t=>t.url===destroyedTabUrl));const cookie=await app.evaluate(({webContents},origin)=>webContents.getAllWebContents().find(w=>w.getURL()===origin+'/second').executeJavaScript('document.cookie'),f.web.origin);assert.equal(cookie,'identity=projectA');});
  await check('D server recognizes the same authenticated test account after Electron restart',async()=>{
    await waitWeb('/fixture-auth/home');
    const restored=(await call('snapshot')).tabs.find(tab=>tab.id===authenticatedTabId);
    assert.equal(restored?.project,savedProject);
    assert.equal(await authStatus(f.web.origin+'/fixture-auth/home'),204);
    assert.equal(await authStatus(f.web.origin+'/other'),401);
  });
  await check('Core receives only the three allowlisted GET projections',async()=>{assert.ok(f.observed.core.every(r=>r.method==='GET'&&['/api/health','/api/cockpit/snapshot','/api/owner-goals'].includes(r.url)));});
  await check('explicit Perplexity handoff inserts a bounded project draft without submitting',async()=>{
    await call('project.select',{id:savedProject});
    const tab=await call('tab.open',{input:f.web.origin+'/handoff-fixture'});
    await waitWeb('/handoff-fixture');
    await call('section',{name:'agents'});
    await page.locator('.handoff-card:not(.mcp-card) button').first().click();
    await page.locator('#handoff-dialog[open]').waitFor();
    const preview=await page.locator('#handoff-preview').inputValue();
    assert.match(preview,/MNEMOS_CONTEXT_JSON/);
    assert.match(preview,/Browser izstrāde/);
    assert.ok(preview.length<4800);
    assert.ok(!preview.includes('Pārbaudīta testa atbilde.'));
    await page.locator('#handoff-insert').click();
    await waitState(s=>s.activeId===tab.id);
    const contents=await app.evaluate(({webContents},origin)=>{
      const wc=webContents.getAllWebContents().find(w=>w.getURL()===origin+'/handoff-fixture');
      if(!wc)throw new Error('Fixture webview not found');
      return wc.executeJavaScript('({body:document.getElementById("composer").innerText,submitted:window.submitted})',true);
    },f.web.origin);
    assert.equal(contents.submitted,false);
    assert.equal(contents.body.includes('MNEMOS_CONTEXT_JSON:'),true);
    const prepared=await call('perplexity.handoff.preview');
    await assert.rejects(
      ()=>call('perplexity.handoff.insert',{nonce:prepared.nonce}),
      /PERPLEXITY_DRAFT_NOT_EMPTY/);
    const second=await app.evaluate(({webContents},origin)=>webContents.getAllWebContents()
      .find(w=>w.getURL()===origin+'/handoff-fixture')
      .executeJavaScript('document.getElementById("composer").innerText',true),f.web.origin);
    assert.equal(second,contents.body);
    await call('tab.close',{id:tab.id});
    await call('error.clear');
  });
  await check('owner-approved Perplexity task and reviewed result persist with provenance',async()=>{
    const q=new CollaborationStore(path.join(profile,'collaboration-fixture.sqlite'));
    const proposal=q.propose({requestId:'browser-e2e-perplexity-00001',kind:'task',
      title:'Perplexity testpriekšlikums',details:'Ierosināts bez tiesībām palaist jebkuru aģenta izpildi.'}).id;
    q.close();
    await app.evaluate(({dialog})=>{globalThis.__originalCollaborationMessageBox=dialog.showMessageBox;dialog.showMessageBox=async()=>({response:1});});
    await call('section',{name:'agents'});
    const original=await call('collaboration.list');
    assert.ok(original.pending.some(p=>p.id===proposal));
    await page.waitForFunction(()=>document.querySelector('.collaboration-row strong')?.textContent.includes('Perplexity'));
    await call('collaboration.decide',{id:proposal,choice:'approve'});
    const approved=await call('collaboration.list');
    assert.equal(approved.recent.find(p=>p.id===proposal)?.status,'APPROVED');
    const item=(await call('snapshot')).local.items.find(i=>i.source==='perplexity:proposal:'+proposal);
    assert.ok(item);
    assert.equal(item.kind,'task');
    const q2=new CollaborationStore(path.join(profile,'collaboration-fixture.sqlite'));
    const resultId=q2.submitResult({proposalId:proposal,requestId:'browser-e2e-result-00001',
      summary:'Perplexity rezultāta pārbaude',details:'Šis ir ārējs neuzticams rezultāts un to nepievieno atmiņai automātiski.'}).id;
    q2.close();
    const pending=await call('collaboration.list');
    assert.ok(pending.results.some(r=>r.id===resultId));
    assert.equal((await call('snapshot')).local.items.some(i=>i.title.includes('Perplexity rezultāta pārbaude')),false);
    await call('collaboration.decide',{id:resultId,choice:'accept-result'});
    const after=await call('snapshot');
    assert.ok(after.local.items.some(i=>i.source==='perplexity:untrusted:'+proposal && i.kind==='memory'));
    assert.equal((await call('collaboration.list')).results.length,0);
    await app.evaluate(({dialog})=>{dialog.showMessageBox=globalThis.__originalCollaborationMessageBox;},undefined);
  });
  await check('real Electron Chromium accepts one locally selected CV file through scoped CDP input',async()=>{
    const fixtureFile=path.join(profile,'e2e-resume.txt');
    await writeFile(fixtureFile,'This is an isolated test CV; not a real application.');
    const tab=await call('tab.open',{input:f.web.origin+'/file-upload-fixture'});
    await waitWeb('/file-upload-fixture');
    const uploaded=await app.evaluate(async({webContents},{origin,fixtureFile})=>{
      const wc=webContents.getAllWebContents().find(w=>w.getURL()===origin+'/file-upload-fixture');
      if(!wc||wc.isDestroyed())throw new Error('FILE_TEST_TAB_MISSING');
      if(wc.debugger.isAttached())throw new Error('DEBUGGER_ALREADY_ATTACHED');
      wc.debugger.attach('1.3');
      try{
        const {root}=await wc.debugger.sendCommand('DOM.getDocument',{depth:0,pierce:false});
        const {nodeId}=await wc.debugger.sendCommand('DOM.querySelector',{
          nodeId:root.nodeId,selector:'input[type="file"]'});
        if(!nodeId)throw new Error('FILE_INPUT_NOT_FOUND');
        await wc.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[fixtureFile]});
      }finally{if(wc.debugger.isAttached())wc.debugger.detach();}
      return wc.executeJavaScript('({count:document.getElementById("cv").files.length,name:document.getElementById("cv").files[0]?.name,changed:document.body.dataset.fileName})',true);
    },{origin:f.web.origin,fixtureFile});
    assert.equal(uploaded.count,1);
    assert.equal(uploaded.name,'e2e-resume.txt');
    assert.equal(uploaded.changed,'e2e-resume.txt');
    await call('tab.close',{id:tab.id});
  });
  assert.deepEqual(errors,[]);
}catch(error){checks.push({name:'Execution failure',passed:false,error:error.stack});console.error(error);process.exitCode=1;try{await page?.screenshot({path:path.join(out,'failure.png')});}catch{}}
finally{if(app)await app.close().catch(()=>{});await f.close();await writeFile(path.join(out,'e2e-results.json'),JSON.stringify({capturedAt:new Date().toISOString(),fixtureMode:true,realAI:false,productionWrites:false,profile,checks,pageErrors:errors,observed:f.observed},null,2));console.log(JSON.stringify({passed:checks.filter(t=>t.passed).length,failed:checks.filter(t=>!t.passed).length}));}
