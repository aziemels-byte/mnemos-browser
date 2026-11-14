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
test('Electron native pointer emits trusted click and does not stop at send-button focus',{timeout:75000},async()=>{
  const fixture=await fixtures();await mkdir(tempRoot,{recursive:true});
  const profile=await mkdtemp(path.join(tempRoot,'native-send-'));
  const env={...process.env,MNEMOS_TEST_PROFILE:profile,
    MNEMOS_TEST_CORE_ORIGIN:fixture.core.origin,
    MNEMOS_TEST_OLLAMA_ORIGIN:fixture.model.origin,
    MNEMOS_TEST_WEB_ORIGIN:fixture.web.origin};
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try{
    app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
    const shell=await app.firstWindow();
    await shell.waitForFunction(()=>Boolean(window.mnemos));
    const fixtureUrl=fixture.web.origin+'/handoff-fixture';
    const tab=await shell.evaluate(url=>window.mnemos.invoke('tab.open',{input:url}),fixtureUrl);
    assert.ok(tab.id);
    let ready=false;
    for(let n=0;n<60;n++){
      ready=await app.evaluate(({webContents},url)=>webContents.getAllWebContents()
        .some(w=>w.getURL()===url&&!w.isLoading()),fixtureUrl).catch(()=>false);
      if(ready)break;
      await shell.waitForTimeout(150);
    }
    assert.equal(ready,true,'fixture page must be loaded');
    // Replace the fixture's click handler so only trusted input can trigger submission.
    const before=await app.evaluate(async({webContents},url)=>{
      const wc=webContents.getAllWebContents().find(w=>w.getURL()===url);
      return wc.executeJavaScript(`(()=>{
        const send=document.getElementById('submit');
        window.trustedCount=0;window.untrustedCount=0;window.submitted=false;
        send.onclick=e=>{
          if(e.isTrusted){window.trustedCount++;window.submitted=true;}
          else window.untrustedCount++;
        };
        send.click();
        return {trusted:window.trustedCount,untrusted:window.untrustedCount,
          submitted:window.submitted};
      })()`,true);
    },fixtureUrl);
    assert.equal(before.trusted,0);
    assert.equal(before.untrusted,1);
    assert.equal(before.submitted,false);
    await shell.evaluate(id=>window.mnemos.invoke('tab.select',{id}),tab.id);
    const native=await app.evaluate(async({webContents,BrowserWindow},url)=>{
      const wc=webContents.getAllWebContents().find(w=>w.getURL()===url);
      const win=BrowserWindow.getAllWindows()[0];win.focus();wc.focus();
      const p=await wc.executeJavaScript(`(()=>{
        const b=document.querySelector('#submit'),r=b.getBoundingClientRect();
        return {x:Math.floor(r.left+r.width/2),y:Math.floor(r.top+r.height/2)};
      })()`,true);
      wc.sendInputEvent({type:'mouseMove',x:p.x,y:p.y});
      wc.sendInputEvent({type:'mouseDown',x:p.x,y:p.y,button:'left',clickCount:1});
      wc.sendInputEvent({type:'mouseUp',x:p.x,y:p.y,button:'left',clickCount:1});
      await new Promise(r=>setTimeout(r,350));
      return wc.executeJavaScript('({trusted:window.trustedCount,untrusted:window.untrustedCount,submitted:window.submitted})',true);
    },fixtureUrl);
    assert.equal(native.trusted,1,'native send must dispatch exactly one trusted click');
    assert.equal(native.untrusted,1);
    assert.equal(native.submitted,true);
    assert.equal(fixture.observed.modelCalls,0);
    console.log('TRUSTED_NATIVE_SUBMIT_E2E_PASS',JSON.stringify(native));
  }finally{
    if(app)await app.close().catch(()=>{});
    await fixture.close();
    await rm(profile,{recursive:true,force:true}).catch(()=>{});
  }
});
