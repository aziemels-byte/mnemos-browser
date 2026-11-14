import test from 'node:test';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright-core';
import electronPath from 'electron';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtures} from './fixtures.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('capture native main-process diagnostics without prompts, secrets, UI changes or profile mutation',{timeout:90000},async()=>{
 const sandbox=path.join(root,'artifacts','runtime-diagnostics');
 await mkdir(sandbox,{recursive:true});
 const profile=await mkdtemp(path.join(sandbox,'profile-'));
 const f=await fixtures();
 let app;
 try{
  const env={...process.env,MNEMOS_TEST_PROFILE:profile,
    MNEMOS_TEST_CORE_ORIGIN:f.core.origin,MNEMOS_TEST_OLLAMA_ORIGIN:f.model.origin,
    MNEMOS_TEST_WEB_ORIGIN:f.web.origin};
  delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
  const page=await app.firstWindow();
  await page.waitForSelector('.dashboard-unit',{timeout:20000});
  assert.equal(await page.locator('.core-workspace').count(),0);
  assert.deepEqual(await page.evaluate(()=>window.mnemos.invoke('diagnostics.testFault',{})),{written:true});
  assert.deepEqual(await page.evaluate(()=>window.mnemos.invoke('diagnostics.testClosedStderr',{})),{stderrProtected:true});
  const raw=await readFile(path.join(profile,'logs','runtime-errors.jsonl'),'utf8');
  const items=raw.trim().split(/\r?\n/).map(JSON.parse);
  const evt=items.find(x=>x.kind==='test-diagnostic');
  assert.ok(evt,'native fault event must be persisted');
  assert.ok(items.some(x=>x.kind==='stdio-pipe-disconnected'&&x.context==='stderr'),'EPIPE must be recorded without crashing');
  assert.equal(await page.locator('body').count(),1,'Browser stays responsive after broken stderr');
  assert.equal(evt.schema,'mnemos.browser.runtime-error.v1');
  assert.equal(evt.context,'synthetic-only');
  assert.ok(evt.stack.includes('/[redacted]'));
  assert.ok(!raw.includes('do-not-log'));
  assert.ok(!raw.includes('token='));
  assert.equal(await page.locator('.bot-wave-arm').count(),1);
  assert.equal(f.observed.coreChatCalls,0);
  console.log('MNEMOS_NATIVE_RUNTIME_LOGGING_E2E_OK',JSON.stringify({events:items.length,redaction:true,epipeHandled:true,originalVisuals:true,logRel:'logs/runtime-errors.jsonl',testProfile:true}));
 }finally{
  if(app)await app.close().catch(()=>{});
  await f.close();
  await rm(profile,{recursive:true,force:true}).catch(()=>{});
 }
});
