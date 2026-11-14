import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {CoordinationJournal,compareUnverifiedSnapshots,
  formatUnverifiedCoordinationReport} from '../src/coordination-journal.mjs';
import {modelAnswerExtractionScript} from '../src/model-answer-capture.mjs';

function localStore(){
  const db=new Map();
  return {project:id=>{if(!['project-one','project-two'].includes(id))throw new Error('UNKNOWN_PROJECT');},
    get:(key,defaultValue)=>db.has(key)?structuredClone(db.get(key)):defaultValue,
    set:(key,value)=>db.set(key,structuredClone(value))};
}
const targets=[{id:'tab-chat',model:'ChatGPT'},{id:'tab-gem',model:'Gemini'},{id:'tab-ppx',model:'Perplexity'}];
const sentence='The browser session is limited to authorized tabs and requires explicit approval before external submission.';
const candidate=(tabId,model,extra='')=>({
  tabId,model,ok:true,kind:'ASSISTANT_DOM_CANDIDATE',title:'Test',
  url:'https://example.com/test',text:'Some web page',answer:sentence+' '+extra,
  readAt:'2026-11-11T12:00:00.000Z'
});

test('History survives journal recreation, scopes every read and uses immutable project-bound run IDs',()=>{
  const store=localStore(),j=new CoordinationJournal(store);
  const a=j.begin('project-one',{prompt:'Compare browser safety',targets,contextIds:['memory-1']});
  assert.match(a.id,/^[a-f0-9-]{36}$/);
  assert.equal(a.status,'PREPARING');
  assert.equal(new CoordinationJournal(store).get('project-one',a.id).prompt,'Compare browser safety');
  assert.equal(j.list('project-one').length,1);
  assert.equal(j.list('project-two').length,0);
  assert.throws(()=>j.get('project-two',a.id),/SCOPE_DENIED/);
  assert.throws(()=>j.get('project-one','../../'),/RUN_ID_INVALID/);
  assert.throws(()=>j.begin('project-one',{prompt:'x',targets:[targets[0],targets[0]]}),/TARGETS_INVALID/);
  assert.throws(()=>j.begin('project-one',{prompt:'x',targets:[...targets,targets[0]]}),/RUN_INVALID/);
});

test('Prepared model origins survive storage and unsafe origin substitutions are rejected',()=>{
  const store=localStore(),journal=new CoordinationJournal(store);
  const run=journal.begin('project-one',{prompt:'Read and compare',targets:[
    {id:'tab-chat',model:'ChatGPT',origin:'https://chatgpt.com'},
    {id:'tab-gem',model:'Gemini',origin:'https://gemini.google.com'},
    {id:'tab-ppx',model:'Perplexity',origin:'https://www.perplexity.ai'}
  ]});
  const recovered=new CoordinationJournal(store).get('project-one',run.id);
  assert.equal(recovered.targets[0].origin,'https://chatgpt.com');
  assert.equal(recovered.targets[1].origin,'https://gemini.google.com');
  assert.equal(recovered.targets[2].origin,'https://www.perplexity.ai');
  assert.throws(()=>journal.begin('project-one',{prompt:'Reject',targets:[
    {id:'tab-chat',model:'ChatGPT',origin:'https://evil.example'}
  ]}),/TARGETS_INVALID/);
  assert.throws(()=>journal.begin('project-one',{prompt:'Reject',targets:[
    {id:'tab-chat',model:'ChatGPT',origin:'https://gemini.google.com'}
  ]}),/TARGETS_INVALID/);
});
test('Captured answers are stored as unverified and exact sentence overlap never becomes fact verification',()=>{
  const store=localStore(),j=new CoordinationJournal(store);
  const run=j.begin('project-one',{prompt:'Evaluate alternatives',targets});
  j.drafts('project-one',run.id,targets.map(t=>({tabId:t.id,model:t.model,ok:true,
    characters:150,baselineHash:'a'.repeat(64)})));
  const saved=j.captured('project-one',run.id,[
    candidate('tab-chat','ChatGPT','Independent reasoning.'),
    candidate('tab-gem','Gemini','Another perspective.'),
    {tabId:'tab-ppx',model:'Perplexity',ok:true,kind:'PAGE_TEXT_ONLY',
      text:'Toolbar text and user interactions',answer:sentence.repeat(3)}
  ]);
  assert.equal(saved.status,'COMPARISON_AVAILABLE');
  assert.equal(saved.comparison.verified,false);
  assert.equal(saved.comparison.comparableCount,2);
  assert.deepEqual(saved.comparison.repeated[0].models,['ChatGPT','Gemini']);
  assert.equal(saved.comparison.sources[2].comparable,false);
  const report=formatUnverifiedCoordinationReport(saved);
  assert.match(report,/NEPĀRBAUDĪTS/);
  assert.match(report,/NAV izolēta asistenta atbilde/);
  assert.match(report,/ChatGPT \+ Gemini/);
  assert.equal(new CoordinationJournal(store).get('project-one',run.id).snapshots.length,3);
  assert.throws(()=>j.captured('project-two',run.id,[candidate('tab-chat','ChatGPT')]),/SCOPE_DENIED/);
  assert.throws(()=>j.captured('project-one',run.id,[candidate('tab-chat','ChatGPT')]),/TARGET_MISMATCH/);
  assert.throws(()=>j.captured('project-one',run.id,[
    candidate('tab-chat','Gemini'),candidate('tab-gem','ChatGPT'),
    candidate('tab-ppx','Perplexity')]),/TARGET_MISMATCH/);
  const noted=j.saved('project-one',run.id,'local-memory-id');
  assert.equal(noted.savedMemoryId,'local-memory-id');
});

test('External submission is durable, one-shot and never automatically repeated',()=>{
  const store=localStore(),j=new CoordinationJournal(store);
  const run=j.begin('project-one',{prompt:'Cross-check implementations',targets});
  const prepared=j.drafts('project-one',run.id,targets.map(t=>({
    tabId:t.id,model:t.model,ok:true,characters:50,draftHash:'f'.repeat(64)
  })));
  assert.equal(prepared.drafts.length,3);
  const intent=j.authorizeSubmission('project-one',run.id,['tab-chat','tab-gem']);
  assert.equal(intent.submissions[0].state,'INTENT_RECORDED');
  assert.equal(intent.submissions[1].state,'INTENT_RECORDED');
  assert.throws(()=>j.authorizeSubmission('project-one',run.id,['tab-chat']),/ALREADY_SUBMISSION_ATTEMPTED/);
  assert.equal(new CoordinationJournal(store).get('project-one',run.id).submissions[0].state,'INTENT_RECORDED');
  const one=j.completeSubmission('project-one',run.id,'tab-chat',{submitted:true});
  assert.equal(one.status,'SUBMISSION_IN_PROGRESS');
  const two=j.completeSubmission('project-one',run.id,'tab-gem',{submitted:false,error:'PAGE_CHANGED'});
  assert.equal(two.status,'SUBMISSION_PARTIAL');
  assert.equal(two.submissions[0].state,'TRIGGERED_UNVERIFIED');
  assert.equal(two.submissions[1].state,'FAILED');
  assert.throws(()=>j.completeSubmission('project-one',run.id,'tab-chat',{submitted:true}),/NOT_PENDING/);
  assert.throws(()=>j.authorizeSubmission('project-two',run.id,['tab-chat']),/SCOPE_DENIED/);
});

test('Automatic monitoring records progress and survives interruption without resending',()=>{
  const store=localStore(),journal=new CoordinationJournal(store);
  const run=journal.begin('project-one',{prompt:'Review results',targets});
  journal.drafts('project-one',run.id,targets.map(t=>({
    tabId:t.id,model:t.model,ok:true,draftHash:'b'.repeat(64)})));
  assert.throws(()=>journal.beginMonitoring('project-one',run.id),/REQUIRES_SUBMISSION/);
  journal.authorizeSubmission('project-one',run.id,['tab-chat','tab-gem']);
  const inProgress=journal.beginMonitoring('project-one',run.id);
  assert.equal(inProgress.monitoring.state,'RUNNING');
  journal.updateMonitoring('project-one',run.id,'tab-chat',{
    state:'WAITING',reason:'RESPONSE_STREAMING',attempts:8
  });
  assert.equal(journal.get('project-one',run.id).monitoring.targets[0].attempts,8);
  assert.throws(()=>journal.updateMonitoring('project-two',run.id,'tab-chat',{
    state:'WAITING'}),/SCOPE_DENIED/);
  const afterCrash=new CoordinationJournal(store);
  assert.equal(afterCrash.recoverInterrupted('project-one').interrupted,true);
  const interrupted=afterCrash.get('project-one',run.id);
  assert.equal(interrupted.monitoring.state,'INTERRUPTED_BY_RESTART');
  assert.equal(interrupted.status,'CAPTURE_INTERRUPTED');
  assert.throws(()=>afterCrash.authorizeSubmission('project-one',run.id,['tab-chat']),
    /ALREADY_SUBMISSION_ATTEMPTED/);
  const resume=afterCrash.beginMonitoring('project-one',run.id);
  assert.equal(resume.monitoring.state,'RUNNING');
  afterCrash.failMonitoring('project-one',run.id,new Error('TAB_CLOSED'));
  assert.equal(afterCrash.get('project-one',run.id).status,'CAPTURE_FAILED');
});
test('Capturing long answers preserves 32768 characters with provenance, beyond prior 6500 limit',()=>{
  const journal=new CoordinationJournal(localStore()),run=journal.begin('project-one',{
    prompt:'Explain provenance',targets:[targets[0]]
  });
  const huge='L'.repeat(28000);
  const saved=journal.captured('project-one',run.id,[{
    tabId:'tab-chat',model:'ChatGPT',ok:true,
    kind:'ASSISTANT_DOM_CANDIDATE',answer:huge,text:'Browser fallback',
    monitorState:'CANDIDATE_CAPTURED',answerChars:huge.length,
    bodyChars:44000,truncated:false
  }]);
  assert.equal(saved.snapshots[0].answer.length,28000);
  assert.equal(saved.snapshots[0].monitorState,'CANDIDATE_CAPTURED');
  assert.equal(saved.snapshots[0].bodyChars,44000);
  assert.equal(saved.comparison.verified,false);
  assert.ok(formatUnverifiedCoordinationReport(saved).length>4000);
});
test('Page-only and stale candidates never participate in comparison',()=>{
  const rows=[
    {tabId:'a',model:'ChatGPT',ok:true,kind:'PAGE_TEXT_ONLY',answer:sentence,text:sentence},
    {tabId:'b',model:'Gemini',ok:true,kind:'ASSISTANT_DOM_CANDIDATE',answer:sentence},
    {tabId:'c',model:'Perplexity',ok:false,kind:'ASSISTANT_DOM_CANDIDATE',answer:sentence,error:'CLOSED'}
  ];
  const result=compareUnverifiedSnapshots(rows);
  assert.equal(result.comparableCount,1);
  assert.equal(result.repeated.length,0);
  assert.equal(result.sources[0].comparable,false);
  assert.equal(result.sources[2].error,'CLOSED');
});

test('DOM extraction uses known selector candidates and read-only page-text fallback',()=>{
  for(const model of ['ChatGPT','Gemini','Perplexity']){
    const body={innerText:'Visible background content from a local fixture with no secrets'};
    const seen=[];
    const source={
      ChatGPT:'[data-message-author-role="assistant"] .markdown',
      Gemini:'model-response .markdown',
      Perplexity:'[data-testid="answer-content"]'
    }[model];
    const doc={
      title:'Fixture page',
      body,
      querySelectorAll(selector){
        seen.push(selector);
        return selector===source?[{innerText:sentence,textContent:sentence}]:[];
      }
    };
    const output=vm.runInNewContext(modelAnswerExtractionScript(model),{document:doc});
    assert.equal(output.kind,'ASSISTANT_DOM_CANDIDATE',model);
    assert.equal(output.answer,sentence);
    assert.equal(output.selector,source);
    assert.ok(seen.includes(source));
    assert.equal(body.innerText,'Visible background content from a local fixture with no secrets');
    doc.querySelectorAll=()=>[];
    const fallback=vm.runInNewContext(modelAnswerExtractionScript(model),{document:doc});
    assert.equal(fallback.kind,'PAGE_TEXT_ONLY');
    assert.equal(fallback.answer,'');
    assert.ok(fallback.text.includes('Visible background'));
  }
  assert.throws(()=>modelAnswerExtractionScript('Unknown'),/UNKNOWN_MODEL/);
});
