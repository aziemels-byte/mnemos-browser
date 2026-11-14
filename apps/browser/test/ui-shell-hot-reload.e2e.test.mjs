import test from 'node:test';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright-core';
import electronPath from 'electron';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtures} from './fixtures.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('UI-only reload preserves live authenticated WebContentsView and projects',{timeout:100000},async()=>{
 const fixture=await fixtures();
 let app,profile;
 try{
  const output=path.join(root,'artifacts','ui-hot-reload');
  await mkdir(output,{recursive:true});
  profile=await mkdtemp(path.join(output,'profile-'));
  const env={...process.env,MNEMOS_TEST_PROFILE:profile,
    MNEMOS_TEST_CORE_ORIGIN:fixture.core.origin,
    MNEMOS_TEST_OLLAMA_ORIGIN:fixture.model.origin,
    MNEMOS_TEST_WEB_ORIGIN:fixture.web.origin};
  delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
  const page=await app.firstWindow(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>document.querySelector('#boot-stage')?.classList.contains('ready'),null,{timeout:20000});
  const tab=await page.evaluate(url=>window.mnemos.invoke('tab.open',{input:url}),fixture.web.origin+'/fixture-auth/login');
  assert.ok(tab?.id,'fixture tab must open');
  await page.waitForFunction(expected=>document.querySelectorAll('#tabs .tab').length>=2,tab.id);
  // Auth cookie is a synthetic local-only test token, never an actual external login.
  const observe=async()=>app.evaluate(async({webContents},origin)=>{
    const list=webContents.getAllWebContents().filter(w=>w.getURL().startsWith(origin));
    if(list.length!==1)return {count:list.length};
    const w=list[0];
    const cookies=await w.session.cookies.get({url:origin});
    return {count:1,contentsId:w.id,url:w.getURL(),
      cookieNames:cookies.map(c=>c.name).sort(),loading:w.isLoading()};
  },fixture.web.origin);
  let before;
  for(let n=0;n<30;n++){
   before=await observe();
   if(before.count===1&&!before.loading&&before.cookieNames?.includes('fixture_session'))break;
   await page.waitForTimeout(100);
  }
  assert.equal(before.count,1);
  assert.ok(before.cookieNames.includes('fixture_session'));
  await page.evaluate(()=>window.mnemos.invoke('tab.select',{id:'home'}));
  await page.locator('#settings').click();
  await page.waitForSelector('#main button');
  const control=page.getByRole('button',{name:'Pārlādēt MNEMOS saskarni'});
  assert.equal(await control.count(),1);
  const loaded=page.waitForEvent('load',{timeout:12000});
  await control.click();
  await loaded;
  await page.waitForFunction(()=>typeof window.mnemos?.invoke==='function'&&
     document.querySelector('.chrome')&&document.querySelector('#settings'),null,{timeout:14000});
  const after=await observe();
  assert.equal(after.count,1);
  assert.equal(after.contentsId,before.contentsId,'web tab must be the exact same WebContents');
  assert.equal(after.url,before.url,'web navigation must not restart');
  assert.deepEqual(after.cookieNames,before.cookieNames,'authenticated tab must retain its session');
  const state=await page.evaluate(()=>window.mnemos.invoke('snapshot',{}));
  assert.equal(state.tabs.length,1);
  assert.equal(state.tabs[0].id,tab.id,'tab identity must survive UI reload');
  assert.deepEqual(errors,[]);
  assert.equal(fixture.observed.coreChatCalls,0);
  assert.equal(fixture.observed.modelCalls,0);
  console.log('UI_HOT_RELOAD_E2E',JSON.stringify({
    cookiePersisted:true,sameWebContents:true,tabIdUnchanged:true,
    tabUrl:after.url,webTabCount:after.count,inferences:0,errors
  }));
 }catch(error){
  await writeFile(path.join(root,'artifacts','ui-hot-reload','last-error.txt'),String(error?.stack??error)).catch(()=>{});
  throw error;
 }finally{
  await app?.close().catch(()=>{});
  await fixture.close();
  if(profile)await rm(profile,{recursive:true,force:true}).catch(()=>{});
 }
});
