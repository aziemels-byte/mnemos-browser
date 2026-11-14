import test from 'node:test';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright-core';
import electronPath from 'electron';
import {mkdtemp,mkdir,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtures} from './fixtures.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('Real collaboration-stage agents react to captured history, not unrelated open tabs',{timeout:100000},async()=>{
 const fx=await fixtures();let app,profile;
 const artifacts=path.join(root,'artifacts','provider-avatars');
 try{
  await mkdir(artifacts,{recursive:true});
  profile=await mkdtemp(path.join(artifacts,'council-stage-profile-'));
  const env={...process.env,
   MNEMOS_TEST_PROFILE:profile,MNEMOS_TEST_CORE_ORIGIN:fx.core.origin,
   MNEMOS_TEST_OLLAMA_ORIGIN:fx.model.origin,MNEMOS_TEST_WEB_ORIGIN:fx.web.origin};
  delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
  const page=await app.firstWindow();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1500,height:920});
  await page.waitForFunction(()=>document.querySelector('#boot-stage')?.classList.contains('ready'),null,{timeout:18000});
  await page.locator('nav [data-section="coordination"]').click();
  await page.waitForSelector('.persona-lineup');
  const state=await page.evaluate(()=>{
   const api=window.MNEMOSProviderAvatars;
   const fixture={activeProject:'mnemos',models:[],local:{turns:[]},
    tabs:[
     {url:'https://chatgpt.com/c/real',private:false,loading:false},
     {url:'https://gemini.google.com/app',private:false,loading:false},
     {url:'https://claude.ai/chat',private:false,loading:false}],
    council:{status:'RUNNING',turns:[
     {model:'ChatGPT',status:'CAPTURED'},
     {model:'Gemini',status:'AWAITING_RESPONSE'}]}};
   api.refresh(document,fixture);
   const members=[...document.querySelectorAll('.persona-member')].map(member=>{
    const a=member.querySelector('[data-provider-avatar]');
    return {model:a.dataset.providerAvatar,status:a.dataset.avatarState,
     caption:member.querySelector('.persona-state')?.textContent,
     gazeX:a.style.getPropertyValue('--gaze-x'),
     gazeY:a.style.getPropertyValue('--gaze-y')};
   });
   return {members,accent:getComputedStyle(document.documentElement)
     .getPropertyValue('--accent').trim()};
  });
  const by=Object.fromEntries(state.members.map(m=>[m.model,m]));
  assert.equal(by.chatgpt.status,'listening','previous captured council participant listens');
  assert.equal(by.gemini.status,'waiting','current model is actually waiting');
  assert.equal(by.claude.status,'ready','open but unrelated model must not fake participation');
  const loginStatus=await page.evaluate(()=>{
    const api=window.MNEMOSProviderAvatars;
    const next={activeProject:'mnemos',models:[],local:{turns:[]},
      tabs:[{url:'https://claude.ai/login',private:false,loading:false}],
      council:null};
    api.refresh(document,next);
    const claude=document.querySelector('.persona-member [data-provider-avatar=claude]');
    return {state:claude.dataset.avatarState,
      label:claude.closest('.persona-member').querySelector('.persona-state').textContent};
  });
  assert.deepEqual(loginStatus,{state:'login',label:'Nepieciešama pierakstīšanās'});
  // Restore the active fixture, not an invented ongoing user session.
  await page.evaluate(()=>{
    window.MNEMOSProviderAvatars.refresh(document,{
      activeProject:'mnemos',models:[],local:{turns:[]},
      tabs:[{url:'https://chatgpt.com/c/real',private:false,loading:false},
       {url:'https://gemini.google.com/app',private:false,loading:false},
       {url:'https://claude.ai/chat',private:false,loading:false}],
      council:{status:'RUNNING',turns:[{model:'ChatGPT',status:'CAPTURED'},
        {model:'Gemini',status:'AWAITING_RESPONSE'}]}
    });
  });
  assert.equal(by.perplexity.status,'inactive');
  assert.equal(state.accent,'#e6e6e6');
  assert.ok(parseFloat(by.chatgpt.gazeX)>0,
   'avatar must look toward stage Gemini rather than browser tab duplicate');
  const file=path.join(artifacts,'persona-council-active-real-electron.jpg');
  const shot=await page.screenshot({path:file,type:'jpeg',quality:90,animations:'disabled'});
  await writeFile(path.join(artifacts,'persona-council-active-real-electron.base64.txt'),shot.toString('base64'));
  assert.ok((await stat(file)).size>20000);
  assert.equal(fx.observed.coreChatCalls,0);
  assert.equal(fx.observed.modelCalls,0);
  assert.deepEqual(errors,[]);
  console.log('PERSONA_COUNCIL_STAGE_EVIDENCE',JSON.stringify({state,file,screenshotBytes:shot.length,errors}));
 }finally{
  await app?.close().catch(()=>{});
  await fx.close();
  if(profile)await rm(profile,{force:true,recursive:true}).catch(()=>{});
 }
});
