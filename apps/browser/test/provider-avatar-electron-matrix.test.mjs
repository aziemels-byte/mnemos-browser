import test from 'node:test';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright-core';
import electronPath from 'electron';
import {mkdir,mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtures} from './fixtures.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('Actual Electron renders five different personas without altering Atomic Age or triggering inference',{timeout:100000},async()=>{
  const fixture=await fixtures();
  let app=null,profile=null;
  const artifactDir=path.join(root,'artifacts','provider-avatars');
  try{
    await mkdir(artifactDir,{recursive:true});
    profile=await mkdtemp(path.join(artifactDir,'profile-'));
    const env={...process.env,MNEMOS_TEST_PROFILE:profile,
      MNEMOS_TEST_CORE_ORIGIN:fixture.core.origin,
      MNEMOS_TEST_OLLAMA_ORIGIN:fixture.model.origin,
      MNEMOS_TEST_WEB_ORIGIN:fixture.web.origin};
    delete env.ELECTRON_RUN_AS_NODE;
    app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
    const page=await app.firstWindow();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.setViewportSize({width:1320,height:770});
    await page.waitForFunction(()=>typeof window.MNEMOSProviderAvatars?.create==='function'&&
      document.querySelector('#boot-stage')?.classList.contains('ready'),null,{timeout:23000});
    const before=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    assert.equal(before,'#e6e6e6','approved monochrome accent must be untouched');
    const preview=await page.evaluate(()=>{
      const api=window.MNEMOSProviderAvatars;
      const models=['ChatGPT','Claude','Gemini','Perplexity','qwen3.5-4b'];
      const states=['inactive','ready','listening','waiting','working','verifying','error'];
      const panel=document.createElement('section');
      panel.id='avatar-visual-fixture';
      panel.style.cssText='position:fixed;inset:0;z-index:2147483600;background:#101010;color:#e6e6e6;font:13px Segoe UI,sans-serif;padding:26px 35px;box-sizing:border-box;overflow:auto';
      const heading=document.createElement('h1');
      heading.textContent='MNEMOS / PERSONĪBU VIZUĀLĀ MATRICA';
      heading.style.cssText='font-size:21px;letter-spacing:.12em;margin:0 0 8px';
      const note=document.createElement('p');
      note.textContent='IZOLĒTA ELECTRON PĀRBAUDE · STĀVOKĻI SIMULĒTI TIKAI VIZUĀLAM TESTAM';
      note.style.cssText='color:#999;font-size:10px;letter-spacing:.13em;margin:0 0 25px';
      panel.append(heading,note);
      const grid=document.createElement('div');
      grid.style.cssText='display:grid;grid-template-columns:130px repeat(7,minmax(105px,1fr));gap:1px;background:#434343;border:1px solid #505050';
      const cell=(content,title=false)=>{
        const el=document.createElement('div');
        el.style.cssText='background:#181818;min-height:88px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:6px;padding:6px;box-sizing:border-box';
        if(title)el.style.background='#222';
        if(typeof content==='string'){el.textContent=content;el.style.fontSize='11px';el.style.letterSpacing='.05em';}
        else el.append(content);
        grid.append(el);
      };
      cell('MODELIS',true);
      for(const state of states)cell(state.toUpperCase(),true);
      for(const model of models){
        cell(model,true);
        for(const state of states){
          const avatar=api.create(model);
          api.setState(avatar,state);
          cell(avatar);
        }
      }
      panel.append(grid);
      document.body.append(panel);
      const motion=Array.from(grid.querySelectorAll('[data-avatar-state=working] svg'),
         el=>getComputedStyle(el).animationName);
      const silhouettes=Array.from(grid.querySelectorAll('[data-avatar-state=ready] svg'),
         el=>el.outerHTML);
      const variants={};
      for(const state of ['ready','verifying','completed','error']){
        const a=api.create('ChatGPT');
        api.setState(a,state);
        variants[state]=a.querySelector('.model-avatar-mouth')?.getAttribute('d');
      }
      return {models:models.length,states:states.length,motion,variants,
        uniqueSilhouettes:new Set(silhouettes).size,
        totalAvatars:grid.querySelectorAll('[data-provider-avatar]').length};
    });
    assert.equal(preview.models,5);
    assert.equal(new Set(Object.values(preview.variants)).size,4,'UI task expressions must be visibly distinct');
    assert.equal(preview.totalAvatars,35);
    assert.equal(preview.uniqueSilhouettes,5,'silhouette uniqueness failed');
    assert.equal(new Set(preview.motion).size,5,'individual character motion is missing');
    assert.ok(preview.motion.every(n=>n!=='none'));
    const normal=path.join(artifactDir,'avatar-matrix-electron-100.jpg');
    const screenshot=await page.screenshot({path:normal,type:'jpeg',quality:91,animations:'disabled'});
    await writeFile(path.join(artifactDir,'avatar-matrix-electron-100.base64.txt'),screenshot.toString('base64'));
    const shotSize=(await stat(normal)).size;
    assert.ok(shotSize>10000,'screenshot was not actually rendered');
    await page.emulateMedia({reducedMotion:'reduce'});
    const reduced=await page.locator('#avatar-visual-fixture [data-avatar-state=working] svg')
      .evaluateAll(els=>els.map(e=>getComputedStyle(e).animationName));
    assert.ok(reduced.every(n=>n==='none'),'prefers-reduced-motion must disable all animated personae');
    const after=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    assert.equal(after,before);
    assert.equal(fixture.observed.coreChatCalls,0,'fixture must never send prompts');
    assert.equal(fixture.observed.modelCalls,0,'fixture must never load/trigger local model');
    assert.deepEqual(errors,[],'Electron page errors');
    console.log('AVATAR_ELECTRON_VISUAL_EVIDENCE',JSON.stringify({preview,screenshot:normal,shotSize,reducedMotion:true,accent:after,devicePixelRatio:await page.evaluate(()=>devicePixelRatio)}));
  }finally{
    if(app)await app.close().catch(()=>{});
    await fixture.close();
    if(profile)await rm(profile,{recursive:true,force:true}).catch(()=>{});
  }
});
