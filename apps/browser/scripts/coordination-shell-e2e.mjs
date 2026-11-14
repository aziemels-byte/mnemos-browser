import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {_electron as electron} from 'playwright-core';
import electronPath from 'electron';
import {fixtures} from '../test/fixtures.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tempRoot=path.resolve(root,'artifacts/test-profiles');
test('Isolated Electron coordination UI renders with explicit opt-in; it never silently submits', {timeout:70000},async()=>{
  const f=await fixtures();await mkdir(tempRoot,{recursive:true});
  const profile=await mkdtemp(path.join(tempRoot,'coordination-'));
  const env={...process.env,MNEMOS_TEST_PROFILE:profile,MNEMOS_TEST_CORE_ORIGIN:f.core.origin,
    MNEMOS_TEST_OLLAMA_ORIGIN:f.model.origin,MNEMOS_TEST_WEB_ORIGIN:f.web.origin};
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try{
    app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
    const page=await app.firstWindow();
    const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.waitForFunction(()=>!!window.mnemos);
    const invoke=(op,p={})=>page.evaluate(([op,p])=>window.mnemos.invoke(op,p),[op,p]);
    await invoke('section',{name:'coordination'});
    await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='Modeļu sadarbība');
    assert.equal(await page.locator('#nav [data-section="coordination"]').count(),1);
    assert.equal(await page.locator('.coordination-option').count(),0);
    assert.equal(await page.locator('.coordination-prompt').count(),1);
    assert.match(await page.locator('.coordination-page').innerText(),/PILNS CIKLS = VIENREIZĒJA NOSŪTĪŠANA/);
    const fake={tabIds:['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']};
    await assert.rejects(()=>invoke('coordination.collect',fake),/COORDINATION_RUN_ID_INVALID/);
    assert.deepEqual(await invoke('coordination.list'),[]);
    assert.match(await page.locator('.coordination-history').innerText(),/nav saglabātu sesiju/i);
    await assert.rejects(()=>invoke('coordination.prepare',{...fake,prompt:'Sagatavo melnrakstu'}),/COLLABORATION_TAB_NOT_ACCESSIBLE/);
    await assert.rejects(()=>invoke('coordination.submit',{runId:'11111111-1111-4111-8111-111111111111'}),/COORDINATION_EXTERNAL_SUBMISSION_LIVE_ONLY/);
    const simulated=await invoke('coordination.testFixture');
    assert.equal(simulated.testFixture,true);
    assert.equal(simulated.synthesis.schema,'mnemos.coordination.synthesis.v1');
    assert.equal(simulated.synthesis.summary.observed,3);
    assert.equal(simulated.synthesis.summary.isolatedAssistantCandidates,2);
    assert.equal(simulated.synthesis.summary.promptRelativeFallbacks,1);
    assert.ok(simulated.synthesis.lexicalMatches.length>=1);
    const saved=await invoke('coordination.structured',{runId:simulated.runId});
    assert.equal(saved.project,'mnemos');
    assert.equal(saved.verified,false);
    assert.equal(saved.semanticAnalysis,false);
    const history=await invoke('coordination.list');
    assert.equal(history.length,1);
    assert.equal(history[0].synthesisStatus,'PARTIAL_PROVENANCE');
    await page.waitForFunction(()=>
      document.querySelector('.coordination-history')?.textContent?.includes('Fixture: assess MNEMOS'));
    await page.locator('.coordination-history-row button').first().click();
    await page.waitForFunction(()=>
      document.querySelector('.coordination-page')?.textContent?.includes('Strukturēts projekta rezultāts'));
    assert.match(await page.locator('.coordination-page').innerText(),/AUTOMĀTISKI SAGLABĀTS PROJEKTA ŽURNĀLĀ/);
    assert.match(await page.locator('.coordination-page').innerText(),/Līdzīgi formulējumi/);
    await page.getByRole('button',{name:'Kopēt strukturēto rezultātu (JSON)'}).click();
    const clipboardText=await app.evaluate(({clipboard})=>clipboard.readText());
    assert.equal(JSON.parse(clipboardText).runId,simulated.runId);
    assert.equal(f.observed.modelCalls,0,'fixture integration must never call external model');
    await app.close();app=null;
    app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
    const recoveredPage=await app.firstWindow();
    await recoveredPage.waitForFunction(()=>!!window.mnemos);
    const recovered=await recoveredPage.evaluate(id=>window.mnemos.invoke('coordination.get',{runId:id}),simulated.runId);
    assert.equal(recovered.synthesis.schema,'mnemos.coordination.synthesis.v1');
    assert.equal(recovered.synthesis.summary.observed,3);
    assert.equal(recovered.synthesis.status,'PARTIAL_PROVENANCE');
    assert.equal(f.observed.modelCalls,0);
    const state=await recoveredPage.evaluate(()=>window.mnemos.invoke('snapshot',{}));
    assert.equal(state.local.turns.length,0);
    assert.equal(f.observed.modelCalls,0);
    assert.ok(pageErrors.length===0,'Uncaught renderer exceptions: '+pageErrors.join(' | '));
    console.log('COORDINATION_UI_SMOKE_PASS',JSON.stringify({
      section:state.section,navButtons:await recoveredPage.locator('#nav button').count(),
      modelCalls:f.observed.modelCalls,errors:pageErrors.length,
      consentToSubmitNeverRequested:true
    }));
  }finally{
    if(app)await app.close().catch(()=>{});
    await f.close();
    await rm(profile,{recursive:true,force:true}).catch(()=>{});
  }
});
