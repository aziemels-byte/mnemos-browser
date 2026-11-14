import test from 'node:test';
import assert from 'node:assert/strict';
import {CouncilConversation} from '../src/council-conversation.mjs';

function kv(){const map=new Map();return{get:(k,f)=>structuredClone(map.has(k)?map.get(k):f),set:(k,v)=>map.set(k,structuredClone(v))};}
const targets=[
  {id:'11111111-1111-4111-8111-111111111111',model:'ChatGPT',origin:'https://chatgpt.com'},
  {id:'22222222-2222-4222-8222-222222222222',model:'Gemini',origin:'https://gemini.google.com'},
  {id:'33333333-3333-4333-8333-333333333333',model:'Perplexity',origin:'https://www.perplexity.ai'}
];
async function settle(service,expected){
  for(let n=0;n<150;n++){
    if(service.summary('mnemos')?.status===expected)return service.summary('mnemos');
    await new Promise(r=>setTimeout(r,3));
  }
  assert.fail('Missing '+expected+': '+service.summary('mnemos')?.status);
}
test('existing Perplexity response is recovered read-only and conversation resumes at next model, no duplicate send',async()=>{
  const sends=[],captures=[];
  let perplexitySends=0;
  const service=new CouncilConversation({store:kv(),
    send:async ({target,prompt})=>{
      sends.push({model:target.model,prompt});
      const firstPerplexity=target.model==='Perplexity'&&++perplexitySends===1;
      return {triggered:true,editorCleared:!firstPerplexity,promptVisible:false};
    },
    capture:async ({target,requireResponseAfterPrompt})=>{
      captures.push({model:target.model,reconciling:requireResponseAfterPrompt===true});
      return {state:'CANDIDATE_CAPTURED',answer:'Real '+target.model+' answer.'};
    }
  });
  service.start({project:'mnemos',targets,seed:'Iepazīšanās',maxTurns:6});
  const failed=await settle(service,'SEND_UNCERTAIN_NO_RETRY');
  assert.deepEqual(failed.turns.map(t=>t.model),['ChatGPT','Gemini','Perplexity']);
  assert.equal(sends.length,3);
  assert.equal(captures.length,2);
  const accepted=service.reconcile('mnemos');
  assert.equal(accepted.status,'RECONCILING');
  const done=await settle(service,'COMPLETED');
  assert.equal(done.turns.length,6);
  assert.ok(done.turns.every(t=>t.status==='CAPTURED'));
  assert.deepEqual(sends.map(s=>s.model),['ChatGPT','Gemini','Perplexity','ChatGPT','Gemini','Perplexity']);
  assert.equal(sends.filter(s=>s.model==='Perplexity').length,2,'Perplexity sends only in original 3rd and next 6th turn');
  assert.ok(captures.some(c=>c.model==='Perplexity'&&c.reconciling===true));
  assert.ok(service.get('mnemos').turns[2].dispatchEvidence==='READ_ONLY_RECOVERY_AFTER_RECORDED_PROMPT');
});
test('fallback-only recovery fails closed and sends no further prompts',async()=>{
  let sends=0,readRecovery=0;
  const service=new CouncilConversation({store:kv(),
    send:async ({target})=>{sends++;return{triggered:true,editorCleared:target.model!=='Perplexity'};},
    capture:async ({requireResponseAfterPrompt})=>{
      if(requireResponseAfterPrompt){readRecovery++;return{state:'FALLBACK_CAPTURED',reason:'PAGE_TEXT_ONLY'};}
      return {state:'CANDIDATE_CAPTURED',answer:'Real prior model answer.'};
    }
  });
  service.start({project:'mnemos',targets,seed:'Iepazīšanās',maxTurns:6});
  await settle(service,'SEND_UNCERTAIN_NO_RETRY');
  assert.equal(sends,3);
  service.reconcile('mnemos');
  await settle(service,'SEND_UNCERTAIN_NO_RETRY');
  assert.equal(sends,3);
  assert.equal(readRecovery,1);
  assert.match(service.get('mnemos').error,/COUNCIL_READ_ONLY_RECOVERY_UNVERIFIED/);
});
test('restart during read-only reconciliation preserves safe recovery button and does not resend',async()=>{
  const store=kv();
  let sends=0;
  const before=new CouncilConversation({store,
    send:async()=>{sends++;return {triggered:true,editorCleared:false};},
    capture:async()=>({state:'CANDIDATE_CAPTURED',answer:'Should not matter'})});
  before.start({project:'mnemos',targets:targets.slice(0,2),seed:'Iepazīšanās',maxTurns:2});
  await settle(before,'SEND_UNCERTAIN_NO_RETRY');
  assert.equal(sends,1);
  const key=['council','conversations','v1','mnemos'].join('.');
  const rows=store.get(key,[]);
  rows[0].status='RECONCILING';
  rows[0].turns.at(-1).status='RECONCILING';
  store.set(key,rows);
  const after=new CouncilConversation({store,send:async()=>assert.fail('must not send'),
    capture:async()=>({state:'CANDIDATE_CAPTURED',answer:'Actual answer'})});
  assert.equal(after.recover('mnemos').interrupted,true);
  assert.equal(after.summary('mnemos').status,'SEND_UNCERTAIN_NO_RETRY');
  assert.equal(after.summary('mnemos').turns.at(-1).status,'SEND_UNCERTAIN_NO_RETRY');
  assert.equal(sends,1);
});
test('restart during already-dispatched assistant wait recovers existing answer, without resending first turn',async()=>{
  const store=kv(),delivered=[];
  const original=new CouncilConversation({store,
    send:async ({target})=>{delivered.push(target.model);return{triggered:true,editorCleared:true};},
    capture:async()=>new Promise(()=>{})
  });
  original.start({project:'mnemos',targets:targets.slice(0,2),seed:'Iepazīšanās',maxTurns:2});
  for(let i=0;i<100&&original.summary('mnemos').turns[0]?.status!=='AWAITING_RESPONSE';i++)
    await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(original.summary('mnemos').turns[0].status,'AWAITING_RESPONSE');
  assert.deepEqual(delivered,['ChatGPT']);
  const resumed=new CouncilConversation({store,
    send:async ({target})=>{delivered.push(target.model);return{triggered:true,editorCleared:true};},
    capture:async ({target,requireResponseAfterPrompt})=>({
      state:'CANDIDATE_CAPTURED',
      answer:'Verificēšanai derīgs testa kandidāts no '+target.model+'.',
      answerKind:requireResponseAfterPrompt?'CHATGPT_COMPLETED_TURN_TEXT_CANDIDATE':'ASSISTANT_DOM_CANDIDATE'
    })
  });
  assert.equal(resumed.recover('mnemos').interrupted,true);
  assert.equal(resumed.summary('mnemos').status,'SEND_UNCERTAIN_NO_RETRY');
  assert.equal(resumed.summary('mnemos').turns[0].status,'SEND_UNCERTAIN_NO_RETRY');
  resumed.reconcile('mnemos');
  await settle(resumed,'COMPLETED');
  assert.deepEqual(delivered,['ChatGPT','Gemini']);
  assert.equal(resumed.get('mnemos').turns[0].quality,'UNVERIFIED_CHATGPT_COMPLETED_TEXT');
});
test('finished but unverified ChatGPT turn permits read-only reconciliation, not a duplicate send',async()=>{
  const sent=[],store=kv();
  let recoveryCount=0;
  const service=new CouncilConversation({store,
    send:async ({target})=>{sent.push(target.model);return{triggered:true,editorCleared:true};},
    capture:async ({target,requireResponseAfterPrompt})=>{
      if(!requireResponseAfterPrompt&&target.model==='ChatGPT')
        return {state:'TIMEOUT_UNVERIFIED',reason:'UNVERIFIED_PAGE_AFTER_PROMPT'};
      if(requireResponseAfterPrompt)recoveryCount++;
      return {state:'CANDIDATE_CAPTURED',
        answer:'Pabeigta atbilde no '+target.model+' ar pārbaudītu secību.'};
    }
  });
  service.start({project:'mnemos',targets:targets.slice(0,2),seed:'Iepazīšanās',maxTurns:2});
  await settle(service,'BLOCKED_UNVERIFIED');
  assert.equal(service.summary('mnemos').turns[0].status,'RESPONSE_UNVERIFIED');
  assert.equal(sent.length,1);
  service.reconcile('mnemos');
  await settle(service,'COMPLETED');
  assert.equal(recoveryCount,1);
  assert.deepEqual(sent,['ChatGPT','Gemini']);
});
test('cannot reconcile a non-uncertain or tampered council',async()=>{
  const service=new CouncilConversation({store:kv(),send:async()=>({triggered:true,editorCleared:true}),
    capture:async()=>({state:'CANDIDATE_CAPTURED',answer:'Real answer.'})});
  assert.throws(()=>service.reconcile('mnemos'),/RECONCILIATION_NOT_ALLOWED/);
  service.start({project:'mnemos',targets:targets.slice(0,2),seed:'Hi',maxTurns:2});
  await settle(service,'COMPLETED');
  assert.throws(()=>service.reconcile('mnemos'),/RECONCILIATION_NOT_ALLOWED/);
});
