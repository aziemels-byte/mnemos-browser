import test from 'node:test';
import assert from 'node:assert/strict';
import {CoordinationExecutor} from '../src/coordination-executor.mjs';

const base={project:'mnemos',runId:'one',attempted:3,prepared:3,
  results:[{model:'ChatGPT',ok:true},{model:'Gemini',ok:true},{model:'Perplexity',ok:true}]};
test('One explicit action prepares all three then submits once and schedules read-only monitoring',async()=>{
  const calls=[];
  const service=new CoordinationExecutor({
    prepare:async input=>{calls.push(['prepare',input.prompt]);return base;},
    submit:async ({runId})=>{calls.push(['submit',runId]);return {
      runId,attempted:3,triggered:3,automaticCollectionScheduled:true,
      results:[{model:'ChatGPT',triggered:true},{model:'Gemini',triggered:true},
        {model:'Perplexity',triggered:true}]
    };}
  });
  const result=await service.execute('mnemos',{prompt:'Review MNEMOS architecture'});
  assert.deepEqual(calls,[['prepare','Review MNEMOS architecture'],['submit','one']]);
  assert.equal(result.submitted,true);
  assert.equal(result.status,'COLLECTION_SCHEDULED');
  assert.equal(result.monitorScheduled,true);
  assert.equal(result.triggered,3);
});
test('Partial drafts are never submitted; require explicit new action to retry',async()=>{
  let submitted=0;
  const service=new CoordinationExecutor({
    prepare:async()=>({...base,prepared:2}),
    submit:async()=>{submitted++;throw new Error('SHOULD_NOT_SEND');}
  });
  const result=await service.execute('mnemos',{prompt:'Test'});
  assert.equal(result.status,'PREPARATION_INCOMPLETE');
  assert.equal(result.submitted,false);
  assert.equal(submitted,0);
});
test('Concurrency lock rejects repeat action and recovers after failed preflight',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  let submits=0;
  const service=new CoordinationExecutor({
    prepare:async()=>{await pending;return base;},
    submit:async ({runId})=>{submits++;return {runId,attempted:3,
      triggered:2,automaticCollectionScheduled:true,results:[]};}
  });
  const first=service.execute('mnemos',{prompt:'One'});
  await assert.rejects(()=>service.execute('mnemos',{prompt:'Two'}),/EXECUTION_ALREADY_RUNNING/);
  release();
  const response=await first;
  assert.equal(response.status,'SUBMISSION_PARTIAL');
  assert.equal(response.triggered,2);
  assert.equal(submits,1);
  const retry=await service.execute('mnemos',{prompt:'Three'});
  assert.equal(retry.triggered,2);
  assert.equal(submits,2);
});
test('Project mismatch, bad receipts and missing dependencies fail closed',async()=>{
  assert.throws(()=>new CoordinationExecutor({prepare:()=>{}}),/DEPENDENCY_INVALID/);
  const s=new CoordinationExecutor({prepare:async()=>({...base,project:'other'}),
    submit:async()=>{throw new Error('SHOULD_NOT_SUBMIT');}});
  await assert.rejects(()=>s.execute('mnemos',{prompt:'x'}),/PREPARATION_RECEIPT_INVALID/);
  const u=new CoordinationExecutor({prepare:async()=>base,
    submit:async()=>({runId:'wrong',attempted:3,triggered:3})});
  await assert.rejects(()=>u.execute('mnemos',{prompt:'x'}),/SUBMISSION_RECEIPT_INVALID/);
});
