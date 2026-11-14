import test from 'node:test';
import assert from 'node:assert/strict';
import {_electron as electron} from 'playwright-core';
import electronPath from 'electron';
import {mkdir,mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtures} from './fixtures.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('Real Electron collaboration shell displays distinct animated full-height personae without extra actions',{timeout:100000},async()=>{
 const f=await fixtures();
 let app,profile;
 const dir=path.join(root,'artifacts','provider-avatars');
 try{
  await mkdir(dir,{recursive:true});
  profile=await mkdtemp(path.join(dir,'shell-profile-'));
  const env={...process.env,MNEMOS_TEST_PROFILE:profile,
   MNEMOS_TEST_CORE_ORIGIN:f.core.origin,
   MNEMOS_TEST_OLLAMA_ORIGIN:f.model.origin,
   MNEMOS_TEST_WEB_ORIGIN:f.web.origin};
  delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({executablePath:electronPath,args:[root,'--test-mode'],env,timeout:30000});
  const page=await app.firstWindow(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1500,height:920});
  await page.waitForFunction(()=>document.querySelector('#boot-stage')?.classList.contains('ready'),null,{timeout:23000});
  await page.locator('nav [data-section="coordination"]').click();
  await page.waitForSelector('.persona-lineup .persona-member',{timeout:20000});
  await page.waitForFunction(()=>document.querySelectorAll('.persona-lineup .model-avatar-stage').length===5);
  const baseline=await page.evaluate(()=>{
   const avatars=[...document.querySelectorAll('.persona-lineup .model-avatar-stage')];
   const arc=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
   const lineup=document.querySelector('.persona-lineup').getBoundingClientRect();
   return {
    accent:arc, count:avatars.length,
    ids:avatars.map(a=>a.dataset.providerAvatar),
    svgViewboxes:avatars.map(a=>a.querySelector('svg').getAttribute('viewBox')),
    named:avatars.map(a=>a.closest('.persona-member').querySelector('.persona-name').textContent),
    caption:avatars.map(a=>a.closest('.persona-member').querySelector('.persona-state').textContent),
    lineup:{x:lineup.x,y:lineup.y,width:lineup.width,height:lineup.height},
    originalRobot:document.querySelectorAll('.bot-wave-arm').length
   };
  });
  assert.equal(baseline.accent,'#e6e6e6');
  assert.deepEqual(baseline.ids,['chatgpt','claude','gemini','perplexity','local']);
  assert.deepEqual(baseline.svgViewboxes,Array(5).fill('0 0 88 110'));
  assert.ok(baseline.lineup.width>400);
  assert.ok(baseline.lineup.height>100);
  assert.ok(baseline.caption.every(t=>t!=='—'&&t.length>4),'captions must come from state refresh');
  const normal=path.join(dir,'persona-ensemble-shell-100.jpg');
  const image=await page.screenshot({path:normal,type:'jpeg',quality:89,animations:'disabled'});
  await writeFile(path.join(dir,'persona-ensemble-shell-100.base64.txt'),image.toString('base64'));
  assert.ok((await stat(normal)).size>20000);
  const inspectGeometry=()=>page.evaluate(()=>{
    const figures=[...document.querySelectorAll('.persona-lineup .model-avatar-stage')];
    const region=document.querySelector('.persona-lineup')?.getBoundingClientRect();
    return {viewport:window.innerWidth,region:{left:region.left,right:region.right,width:region.width},
      stage:figures.map(el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,height:r.height};})};
  });
  const geometry100=await inspectGeometry();
  await page.evaluate(()=>{document.body.style.zoom='1.25';});
  const zoom125=path.join(dir,'persona-ensemble-shell-125.jpg');
  const image125=await page.screenshot({path:zoom125,type:'jpeg',quality:87,animations:'disabled'});
  await writeFile(path.join(dir,'persona-ensemble-shell-125.base64.txt'),image125.toString('base64'));
  const geometry125=await inspectGeometry();
  await page.evaluate(()=>{document.body.style.zoom='2';});
  const zoom200=path.join(dir,'persona-ensemble-shell-200.jpg');
  const image200=await page.screenshot({path:zoom200,type:'jpeg',quality:84,animations:'disabled'});
  await writeFile(path.join(dir,'persona-ensemble-shell-200.base64.txt'),image200.toString('base64'));
  const geometry200=await inspectGeometry();
  for(const [factor,g] of [[1,geometry100],[1.25,geometry125],[2,geometry200]]){
    assert.equal(g.stage.length,5,'All five personae visible');
    assert.ok(g.stage.every(s=>s.width>=60&&s.height>=80),'Avatar too small at '+factor);
    assert.ok(g.stage.every(s=>s.left>=g.region.left-1&&s.right<=g.region.right+1),
      'Character overflows its stage at '+factor+': '+JSON.stringify(g));
    assert.ok(g.stage.every(s=>s.left>=0&&s.right<=g.viewport+2),
      'Character clipped by viewport at '+factor+': '+JSON.stringify(g));
  }
  assert.equal(f.observed.coreChatCalls,0);
  assert.equal(f.observed.modelCalls,0);
  assert.deepEqual(errors,[]);
  console.log('ELECTRON_PERSONA_ENSEMBLE',JSON.stringify({baseline,geometry:[geometry100,geometry125,geometry200],shots:[normal,zoom125,zoom200],errors,inferences:0}));
 }finally{
  await app?.close().catch(()=>{});
  await f.close();
  if(profile)await rm(profile,{recursive:true,force:true}).catch(()=>{});
 }
});
