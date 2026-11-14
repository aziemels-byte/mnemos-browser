import test from 'node:test';
import assert from 'node:assert/strict';
import {CouncilConversation,councilPrompt} from '../src/council-conversation.mjs';

const targets=[
  {id:'77777777-7777-4777-8777-777777777777',model:'Gemini',origin:'https://gemini.google.com'},
  {id:'88888888-8888-4888-8888-888888888888',model:'Perplexity',origin:'https://www.perplexity.ai'},
  {id:'99999999-9999-4999-8999-999999999999',model:'ChatGPT',origin:'https://chatgpt.com'}
];
function kv(){const map=new Map();return{get:(k,f)=>structuredClone(map.has(k)?map.get(k):f),set:(k,v)=>map.set(k,structuredClone(v))};}
async function settle(service,expected='COMPLETED'){
  for(let n=0;n<120;n++){const state=service.summary('mnemos');if(state?.status===expected)return state;await new Promise(r=>setTimeout(r,3));}
  assert.fail('Council did not reach '+expected+' (actual: '+service.summary('mnemos')?.status+')');
}
test('models exchange real captured answers in successive turns, exactly once per turn',async()=>{
  const sent=[],store=kv();
  const conversation=new CouncilConversation({store,
    send:async a=>{sent.push(a);return {triggered:true,editorCleared:true,url:a.target.origin+'/chat'};},
    capture:async a=>({state:'CANDIDATE_CAPTURED',answer:'Real '+a.target.model+' response '+a.turnId})
  });
  const started=conversation.start({project:'mnemos',targets,seed:'Iepazīšanās',maxTurns:6});
  assert.equal(started.status,'RUNNING');
  const finished=await settle(conversation);
  assert.deepEqual(finished.turns.map(t=>t.model),['Gemini','Perplexity','ChatGPT','Gemini','Perplexity','ChatGPT']);
  assert.equal(sent.length,6);
  assert.match(sent[1].prompt,/Real Gemini response/);
  assert.match(sent[2].prompt,/Real Perplexity response/);
  assert.match(sent[4].prompt,/Real ChatGPT response/);
  assert.ok(finished.turns.every(t=>t.status==='CAPTURED'&&t.quality==='UNVERIFIED_ASSISTANT_DOM'));
  for(const turn of finished.turns){
    assert.equal(turn.telemetry.source,'DOM_POLL');
    assert.equal(turn.telemetry.tokenEventsAvailable,false);
    assert.ok(turn.sendTriggeredAt);
    assert.ok(turn.responseCapturedAt);
    assert.ok(Date.parse(turn.responseCapturedAt)>=Date.parse(turn.sendTriggeredAt));
    assert.ok(turn.answerHash?.length===64);
  }
  assert.equal(conversation.get('mnemos').status,'COMPLETED');
});
test('unknown submit failure is persisted and never retried',async()=>{
  let calls=0;const conversation=new CouncilConversation({store:kv(),
    send:async()=>{calls++;throw new Error('renderer JS exception');},
    capture:async()=>{assert.fail('No response should be polled after an exception');}
  });
  conversation.start({project:'mnemos',targets:targets.slice(0,2),seed:'Sveiki',maxTurns:4});
  const result=await settle(conversation,'SEND_UNCERTAIN_NO_RETRY');
  assert.equal(result.turns.length,1);assert.equal(calls,1);
  assert.match(result.turns[0].error,/renderer JS exception/);
});
test('HTML page-text fallback cannot be retransmitted as model speech',async()=>{
  let calls=0;const conversation=new CouncilConversation({store:kv(),
    send:async()=>{calls++;return{triggered:true,editorCleared:true};},
    capture:async()=>({state:'FALLBACK_CAPTURED',answer:'unverified page content'})
  });
  conversation.start({project:'mnemos',targets:targets.slice(0,2),seed:'Sveiki',maxTurns:4});
  const result=await settle(conversation,'BLOCKED_UNVERIFIED');
  assert.equal(result.turns[0].status,'RESPONSE_UNVERIFIED');
  assert.equal(calls,1);
});
test('intent survives interrupted browser without automatic continuation',async()=>{
  let resolveSend;const store=kv();
  const conversation=new CouncilConversation({store,
    send:()=>new Promise(resolve=>{resolveSend=resolve;}),
    capture:async()=>({state:'CANDIDATE_CAPTURED',answer:'response'})
  });
  conversation.start({project:'mnemos',targets:targets.slice(0,2),seed:'Sveiki',maxTurns:4});
  assert.equal(conversation.summary('mnemos').turns[0].status,'INTENT_RECORDED');
  const nextInstance=new CouncilConversation({store,send:async()=>{assert.fail('must not send')},capture:async()=>{}});
  assert.equal(nextInstance.recover('mnemos').interrupted,true);
  assert.equal(nextInstance.get('mnemos').status,'INTERRUPTED_NO_RETRY');
  resolveSend({triggered:true,editorCleared:false});
  await settle(conversation,'SEND_UNCERTAIN_NO_RETRY');
});
test('stop prevents subsequent turns',async()=>{
  let captured=0;const store=kv();
  let service;
  service=new CouncilConversation({store,send:async()=>({triggered:true,editorCleared:true}),
    capture:async()=>{captured++;service.stop('mnemos');return{state:'CANDIDATE_CAPTURED',answer:'real answer'};}
  });
  service.start({project:'mnemos',targets:targets.slice(0,2),seed:'Sveiki',maxTurns:4});
  const state=await settle(service,'STOPPED');
  assert.equal(captured,1);assert.equal(state.turns.length,1);
  assert.equal(state.turns[0].status,'STOPPED_AFTER_SEND');
});
test('invalid targets/oversized prompts are rejected without sending',()=>{
  const service=new CouncilConversation({store:kv(),send:async()=>{},capture:async()=>{}});
  assert.throws(()=>service.start({project:'mnemos',targets:[targets[0],targets[0]],seed:'Hi',maxTurns:3}),/COUNCIL_TARGET_INVALID/);
  assert.throws(()=>service.start({project:'mnemos',targets:targets.slice(0,2),seed:'X'.repeat(901),maxTurns:3}),/COUNCIL_INPUT_INVALID/);
  assert.throws(()=>councilPrompt({seed:'hi',turns:[],model:'Unknown'}),/COUNCIL_PROMPT_INVALID/);
});
