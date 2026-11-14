import test from 'node:test';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright-core';
import electronPath from 'electron';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtures} from './fixtures.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('Restore original Atomic Age UI as default; keep Core-first workspace as opt-in without fake startup activity',{timeout:100000,skip:process.env.MNEMOS_RUN_ELECTRON_E2E!=='1'},async()=>{
 const f=await fixtures();let app;let profile;
 try{
  const shots=path.join(root,'artifacts','visual-rollback');await mkdir(shots,{recursive:true});
  profile=await mkdtemp(path.join(shots,'test-profile-'));
  const env={...process.env,MNEMOS_TEST_PROFILE:profile,
   MNEMOS_TEST_CORE_ORIGIN:f.core.origin,MNEMOS_TEST_OLLAMA_ORIGIN:f.model.origin,
   MNEMOS_TEST_WEB_ORIGIN:f.web.origin};
  delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
  const page=await app.firstWindow();const pageErrors=[];
  page.on('pageerror',e=>pageErrors.push(String(e.message)));
  await page.waitForFunction(()=>document.querySelector('.dashboard-unit')&&document.querySelector('main#main .page-header'),null,{timeout:18000});
  assert.equal(await page.locator('.core-workspace').count(),0,'rejected Core-first interface is NOT default');
  assert.equal(await page.locator('.bot-wave-arm').count(),1,'original animated service automaton retained');
  assert.equal(await page.locator('[data-section="workspace"]').innerText().then(s=>s.replace(/\s+/g,' ').trim()),'01 DARBA TELPA');
  const appearance=await page.evaluate(()=>{
   const cs=getComputedStyle(document.documentElement);
   return {bodyBg:getComputedStyle(document.body).backgroundColor,
    accent:cs.getPropertyValue('--accent').trim(),
    tabText:document.querySelector('#tabs .tab-title')?.textContent,
    noGreenCore:!document.body.classList.contains('core-workspace-mode'),
    rotorAnimation:getComputedStyle(document.querySelector('.bot-wave-arm')).animationName};
  });
  assert.equal(appearance.noGreenCore,true);
  assert.equal(appearance.tabText,'Darba telpa');
  assert.equal(appearance.accent,'#e6e6e6');
  const shot=await page.screenshot({type:'jpeg',quality:82,animations:'disabled'});
  await writeFile(path.join(shots,'atomic-age-restored-1500.jpg'),shot);
  assert.equal(f.observed.coreChatCalls,0,'no inference automatically on startup');
  // The Core-first tool remains in source for testing/review, but is never forced on normal startup.
  await page.evaluate(()=>localStorage.setItem('mnemos.coreFirstPreview','1'));
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('.core-workspace')&&document.body.classList.contains('core-workspace-mode'),null,{timeout:20000});
  const core=await page.evaluate(()=>window.mnemos.invoke('core.workspace',{}));
  assert.equal(core.canonicalSource,'MNEMOS Core');
  assert.equal(f.observed.coreChatCalls,0);
  assert.deepEqual(pageErrors,[]);
  console.log('ATOMIC_AGE_RESTORED_E2E',JSON.stringify({normalStartupOriginal:true,noCoreGreen:true,restoredBot:true,appearance,optionalCoreWorks:true,noAutomaticInference:true,screenshotBytes:shot.length}));
 }finally{if(app)await app.close().catch(()=>{});await f.close();if(profile)await rm(profile,{recursive:true,force:true}).catch(()=>{});}
});