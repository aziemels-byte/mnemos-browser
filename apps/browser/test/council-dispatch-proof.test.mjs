import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyCouncilDispatch} from '../src/council-browser-driver.mjs';
import {CouncilConversation} from '../src/council-conversation.mjs';

const ready={allowed:true,promptVisible:true,editorEmpty:true,url:'https://www.perplexity.ai/session/new-session'};
const pending={allowed:true,promptVisible:false,editorEmpty:false,url:'https://www.perplexity.ai/'};

test('Perplexity home -> session transition proves dispatch using read-only prompt + empty editor',async()=>{
  const states=[null,pending,ready];
  let reads=0,waits=0;
  const proof=await verifyCouncilDispatch({sample:async()=>states[reads++],wait:async()=>{waits++},delays:[0,0,0]});
  assert.equal(proof.promptVisible,true);
  assert.equal(proof.receiptEvidence,'VISIBLE_PROMPT_AND_EMPTY_EDITOR');
  assert.equal(proof.url,ready.url);
  assert.equal(reads,3);
  assert.equal(waits,0);
});

test('an unsent draft or failed navigation can never count as verified dispatch',async()=>{
  let reads=0;
  const proof=await verifyCouncilDispatch({
    sample:async()=>{reads++;return {allowed:true,promptVisible:true,editorEmpty:false,url:'https://www.perplexity.ai/'};},
    wait:async()=>{},delays:[0,0,0]});
  assert.equal(proof.promptVisible,false);
  assert.equal(reads,3);
  const forbidden=await verifyCouncilDispatch({
    sample:async()=>({allowed:false,promptVisible:true,editorEmpty:true}),
    wait:async()=>{},delays:[0,0]});
  assert.equal(forbidden.promptVisible,false);
});

function kv(){const map=new Map();return{get:(k,f)=>structuredClone(map.has(k)?map.get(k):f),set:(k,v)=>map.set(k,structuredClone(v))};}
async function settled(run){
  for(let i=0;i<100;i++){if(run.summary('mnemos')?.status==='COMPLETED')return run.summary('mnemos');await new Promise(r=>setTimeout(r,2));}
  throw new Error('RUN_NOT_COMPLETED:'+run.summary('mnemos')?.status);
}
test('navigation dispatch proof allows next model turn without a second click',async()=>{
  const targets=[
    {id:'55555555-5555-4555-8555-555555555555',model:'Perplexity',origin:'https://www.perplexity.ai'},
    {id:'66666666-6666-4666-8666-666666666666',model:'Gemini',origin:'https://gemini.google.com'}
  ];
  let sends=0,captures=0;
  const service=new CouncilConversation({store:kv(),send:async()=>{
      sends++;return {triggered:true,editorCleared:null,promptVisible:true,
        receiptEvidence:'VISIBLE_PROMPT_AND_EMPTY_EDITOR'};
    },capture:async()=>{
      captures++;return {state:'CANDIDATE_CAPTURED',answer:'Reāla izolēta asistenta atbilde '+captures};
    }});
  service.start({project:'mnemos',targets,seed:'Iepazīšanās',maxTurns:2});
  const result=await settled(service);
  assert.equal(sends,2);
  assert.equal(captures,2);
  assert.deepEqual(result.turns.map(t=>t.status),['CAPTURED','CAPTURED']);
  assert.equal(service.get('mnemos').turns[0].dispatchEvidence,'VISIBLE_PROMPT_AND_EMPTY_EDITOR');
});
test('navigation without a visible prompt and empty editor remains uncertain and is never retried',async()=>{
  const targets=[
    {id:'55555555-5555-4555-8555-555555555555',model:'Perplexity',origin:'https://www.perplexity.ai'},
    {id:'66666666-6666-4666-8666-666666666666',model:'Gemini',origin:'https://gemini.google.com'}
  ];
  let sends=0;
  const service=new CouncilConversation({store:kv(),send:async()=>{
    sends++;return {triggered:true,editorCleared:null,promptVisible:false};
  },capture:async()=>assert.fail('must not capture uncertain delivery')});
  service.start({project:'mnemos',targets,seed:'Iepazīšanās',maxTurns:2});
  for(let i=0;i<100&&service.summary('mnemos')?.status==='RUNNING';i++)
    await new Promise(r=>setTimeout(r,2));
  assert.equal(service.summary('mnemos').status,'SEND_UNCERTAIN_NO_RETRY');
  assert.equal(sends,1);
});
