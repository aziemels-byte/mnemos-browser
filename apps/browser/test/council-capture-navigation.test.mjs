import test from 'node:test';
import assert from 'node:assert/strict';
import {createCouncilBrowserDriver} from '../src/council-browser-driver.mjs';

const target={id:'real-chat-tab',model:'ChatGPT',origin:'https://chatgpt.com'};
function fakeTab(page){
  const wc={
    isDestroyed:()=>false,
    getURL:()=>page.url,
    executeJavaScript:async()=>{
      page.scriptCalls++;
      if(page.onRead)page.onRead();
      return {kind:'ASSISTANT_DOM_CANDIDATE',promptFound:true,
        answer:'Reālas modeļa atbildes testa kandidāts',busy:false};
    }
  };
  return {project:'mnemos',private:false,loading:false,crashed:false,view:{webContents:wc}};
}
function driverFor(page,poll){
  const tab=fakeTab(page);
  return createCouncilBrowserDriver({
    getTab:id=>id===target.id?tab:null,selectTab:()=>{},getWindow:()=>null,
    testMode:true,poll
  });
}
test('cross-run duplicate prompt is rejected before any input or new submission',async()=>{
  let reads=0;
  const wc={
    isDestroyed:()=>false,
    getURL:()=> 'https://chatgpt.com/c/older-session',
    executeJavaScript:async script=>{
      reads++;
      assert.match(script,/Iepazīstamies/,'prompt must be checked against existing page');
      return {promptFound:true,answer:'Iepriekšējā īstā atbilde'};
    },
    insertText:()=>assert.fail('duplicate draft must not be inserted'),
    sendInputEvent:()=>assert.fail('duplicate request must not be submitted')
  };
  const tab={project:'mnemos',private:false,loading:false,crashed:false,view:{webContents:wc}};
  const driver=createCouncilBrowserDriver({getTab:()=>tab,selectTab:()=>assert.fail('no selection'),
    getWindow:()=>null});
  await assert.rejects(
    ()=>driver.send({project:'mnemos',target,prompt:'Iepazīstamies.'}),
    /COUNCIL_PROMPT_ALREADY_VISIBLE/);
  assert.equal(reads,1);
});
test('read-only capture survives transient about:blank redirect and then reads approved assistant DOM',async()=>{
  const page={url:'about:blank',scriptCalls:0};
  let observations=0;
  const driver=driverFor(page,async({sample})=>{
    const waiting=await sample();observations++;
    assert.equal(waiting.navigationPending,true);
    assert.equal(waiting.kind,'PAGE_TEXT_ONLY');
    assert.equal(page.scriptCalls,0,'never reads disallowed navigation document');
    page.url='https://chatgpt.com/c/new-123';
    const first=await sample();observations++;
    assert.equal(first.kind,'ASSISTANT_DOM_CANDIDATE');
    const stable=await sample();observations++;
    assert.equal(stable.kind,'ASSISTANT_DOM_CANDIDATE');
    return {state:'CANDIDATE_CAPTURED',sample:{data:stable,
      assessment:{reason:'UNVERIFIED_NEW_ASSISTANT_DOM'}}};
  });
  const got=await driver.capture({project:'mnemos',target,prompt:'Iepazīstamies.',baselineHash:null});
  assert.equal(got.state,'CANDIDATE_CAPTURED');
  assert.match(got.answer,/modeļa atbildes/);
  assert.equal(got.url,'https://chatgpt.com/c/new-123');
  assert.equal(observations,3);
  assert.equal(page.scriptCalls,2);
});
test('same-origin valid new conversation path is retried without resending prompt',async()=>{
  const page={url:'https://chatgpt.com/',scriptCalls:0};
  const driver=driverFor(page,async({sample})=>{
    page.onRead=()=>{page.url='https://chatgpt.com/c/new-abc';page.onRead=null;};
    const duringNavigation=await sample();
    assert.equal(duringNavigation.navigationPending,true);
    const afterNavigation=await sample();
    assert.equal(afterNavigation.kind,'ASSISTANT_DOM_CANDIDATE');
    return {state:'CANDIDATE_CAPTURED',sample:{data:afterNavigation,
      assessment:{reason:'UNVERIFIED_NEW_ASSISTANT_DOM'}}};
  });
  const got=await driver.capture({project:'mnemos',target,prompt:'Iepazīstamies.'});
  assert.equal(got.state,'CANDIDATE_CAPTURED');
  assert.equal(got.url,'https://chatgpt.com/c/new-abc');
});
test('permanent cross-origin change cannot be read or relayed after six transient observations',async()=>{
  const page={url:'https://untrusted.example/',scriptCalls:0};
  const driver=driverFor(page,async({sample})=>{
    for(let i=0;i<6;i++){
      const value=await sample();
      assert.equal(value.kind,'PAGE_TEXT_ONLY');
      assert.equal(value.navigationPending,true);
    }
    await sample();
    assert.fail('A seventh cross-origin observation must fail closed');
  });
  await assert.rejects(
    ()=>driver.capture({project:'mnemos',target,prompt:'Iepazīstamies.'}),
    /COUNCIL_ORIGIN_CHANGED/);
  assert.equal(page.scriptCalls,0,'no reads from a cross-origin document');
});
test('permanent disallowed same-origin settings path cannot be treated as chat response',async()=>{
  const page={url:'https://chatgpt.com/settings',scriptCalls:0};
  const driver=driverFor(page,async({sample})=>{
    for(let i=0;i<6;i++)assert.equal((await sample()).navigationPending,true);
    await sample();
    assert.fail('A settings page cannot become the council answer');
  });
  await assert.rejects(
    ()=>driver.capture({project:'mnemos',target,prompt:'Iepazīstamies.'}),
    /COUNCIL_ORIGIN_CHANGED/);
  assert.equal(page.scriptCalls,0);
});
