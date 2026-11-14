import test from 'node:test';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright-core';
import electronPath from 'electron';
import {createHash} from 'node:crypto';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtures} from './fixtures.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('Running main process exposes its actual boot SHA and settings never claims a disk update is active',{timeout:85000},async()=>{
 const f=await fixtures();let app,profile;
 try{
  const dir=path.join(root,'artifacts','runtime-fingerprint');
  await mkdir(dir,{recursive:true});
  profile=await mkdtemp(path.join(dir,'profile-'));
  const env={...process.env,MNEMOS_TEST_PROFILE:profile,
   MNEMOS_TEST_CORE_ORIGIN:f.core.origin,MNEMOS_TEST_OLLAMA_ORIGIN:f.model.origin,
   MNEMOS_TEST_WEB_ORIGIN:f.web.origin};
  delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
  const page=await app.firstWindow();
  await page.waitForFunction(()=>window.mnemos?.invoke,undefined,{timeout:20000});
  const snapshot=await page.evaluate(()=>window.mnemos.invoke('snapshot',{}));
  const expected=createHash('sha256').update(await readFile(path.join(root,'src','main.mjs'))).digest('hex').slice(0,16);
  assert.equal(snapshot.runtime?.mainBuild,expected,'main process fingerprint must come from loaded executable source');
  assert.ok(Number.isFinite(Date.parse(snapshot.runtime?.startedAt)));
  await page.locator('#settings').click();
  await page.waitForFunction(code=>document.querySelector('#main')?.textContent.includes(code),expected,{timeout:18000});
  const text=await page.locator('#main').innerText();
  assert.match(text,/Aktīvā procesa SHA-256/);
  assert.match(text,/Processa palaišana/);
  assert.doesNotMatch(text,/Aktīvā Electron procesa versija nav nosakāma/);
  assert.equal(f.observed.coreChatCalls,0);
  assert.equal(f.observed.modelCalls,0);
  console.log('BOOT_FINGERPRINT_VERIFIED',JSON.stringify({build:expected,startedAt:snapshot.runtime.startedAt,authTabsUntouched:true}));
 }finally{await app?.close().catch(()=>{});await f.close();if(profile)await rm(profile,{recursive:true,force:true}).catch(()=>{});}
});
