import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCoordinationSynthesis,coordinationSynthesisReport} from '../src/coordination-synthesis.mjs';

const answerA='The MNEMOS Browser separates authorized Chromium tabs from the persistent Core runtime. Project-scoped browsing is essential for data isolation. One-shot submissions prevent accidental duplicate operations. Each model response should be stored with provenance and read timestamps. Further review is required before treating any answer as fact.';
const answerB='The MNEMOS Browser separates authorized Chromium tabs from the persistent Core runtime. Project-scoped browsing is essential for data isolation. A durable record of attempts prevents duplicate sends. The browser should display the user’s project memory separately from third-party text.';
const answerC='A durable record of attempts prevents duplicate sends. Browser storage should be encrypted at rest where secrets are involved. Source citations and timestamps remain important.';
const targets=[
 {id:'chat-tab',model:'ChatGPT',origin:'https://chatgpt.com'},
 {id:'gem-tab',model:'Gemini',origin:'https://gemini.google.com'},
 {id:'perp-tab',model:'Perplexity',origin:'https://www.perplexity.ai'}
];
function fixture(){
  return {id:'fce57b50-47b9-4f5f-a25d-2d65c40a00c1',project:'mnemos',
    prompt:'Evaluate MNEMOS Browser architecture',
    targets,
    snapshots:[
      {tabId:'chat-tab',model:'ChatGPT',url:'https://chatgpt.com/c/123',
        ok:true,kind:'ASSISTANT_DOM_CANDIDATE',answer:answerA,
        readAt:'2026-11-11T12:01:00Z'},
      {tabId:'gem-tab',model:'Gemini',url:'https://gemini.google.com/app/123',
        ok:true,kind:'ASSISTANT_DOM_CANDIDATE',answer:answerB,
        readAt:'2026-11-11T12:02:00Z'},
      {tabId:'perp-tab',model:'Perplexity',url:'https://www.perplexity.ai/session/123',
        ok:true,kind:'PAGE_TEXT_AFTER_PROMPT',text:answerC,
        readAt:'2026-11-11T12:03:00Z'}
    ]};
}
test('Multi-model synthesis builds a durable structured, source-specific evidence ledger',()=>{
  const run=fixture(),out=buildCoordinationSynthesis(run);
  assert.equal(out.schema,'mnemos.coordination.synthesis.v1');
  assert.equal(out.status,'PARTIAL_PROVENANCE');
  assert.equal(out.verified,false);
  assert.equal(out.semanticAnalysis,false);
  assert.equal(out.summary.observed,3);
  assert.equal(out.summary.isolatedAssistantCandidates,2);
  assert.equal(out.summary.promptRelativeFallbacks,1);
  assert.equal(out.summary.completeRun,true);
  assert.equal(out.evidence.length,3);
  assert.equal(out.evidence[0].origin,'https://chatgpt.com');
  assert.equal(out.evidence[2].quality,'PROMPT_RELATIVE_PAGE_UNVERIFIED');
  assert.match(out.evidence[0].contentHash,/^[a-f0-9]{64}$/);
  assert.ok(out.evidence.every(e=>!('sentences' in e)));
  assert.ok(out.lexicalMatches.some(m=>m.models.includes('ChatGPT')&&m.models.includes('Gemini')));
  assert.ok(out.lexicalMatches.every(m=>m.models.length>=2&&m.score>=0.5));
  const text=coordinationSynthesisReport(out);
  assert.match(text,/NEUZTICAMA ĀRĒJA INFORMĀCIJA/);
  assert.match(text,/LEKSISKI|Leksiski/);
  assert.match(text,/nenozīmē faktu patiesumu/);
  assert.ok(text.length<15501);
});
test('Unverified page-only and failed captures are never invented as assistant facts',()=>{
  const run=fixture();
  run.snapshots[0]={tabId:'chat-tab',model:'ChatGPT',ok:true,
    kind:'PAGE_TEXT_ONLY',text:'Sidebar random user message '+answerA};
  run.snapshots[1]={tabId:'gem-tab',model:'Gemini',ok:false,error:'TAB_CLOSED'};
  const out=buildCoordinationSynthesis(run);
  assert.equal(out.summary.isolatedAssistantCandidates,0);
  assert.equal(out.summary.pageOnly,1);
  assert.equal(out.summary.failed,1);
  assert.equal(out.status,'INCOMPLETE');
  assert.deepEqual(out.evidence[0].excerpts,[]);
  assert.equal(out.evidence[0].contentHash,null);
  assert.equal(out.evidence[1].error,'TAB_CLOSED');
  assert.equal(out.summary.lexicalMatches,0);
});
test('Synthesis is project-bound, model-bound, bounded and avoids false contradiction claims',()=>{
  const run=fixture();
  run.snapshots.push({tabId:'wrong',model:'ChatGPT',ok:true,answer:answerA});
  assert.throws(()=>buildCoordinationSynthesis(run),/SCOPE_MISMATCH/);
  const good=fixture();good.snapshots[0].answer='There must be no automatic retry. '+answerA;
  good.snapshots[1].answer='The system should offer a manual retry. '+answerB;
  const out=buildCoordinationSynthesis(good);
  assert.equal(out.semanticAnalysis,false);
  assert.ok(!Object.hasOwn(out,'contradictions'));
  assert.ok(out.unresolved.some(s=>s.includes('NOT evaluated')));
  assert.throws(()=>coordinationSynthesisReport({schema:'wrong'}),/REPORT_INVALID/);
});
test('Long and noisy responses are strictly truncated in structured highlights',()=>{
  const run=fixture();
  run.snapshots[0].answer=Array(1000).fill(answerA).join('\n');
  const out=buildCoordinationSynthesis(run);
  assert.equal(out.evidence[0].contentCharacters,32768);
  assert.ok(out.evidence[0].excerpts.length<=4);
  assert.ok(out.evidence[0].excerpts.every(s=>s.length<=340));
  assert.ok(out.lexicalMatches.length<=12);
  assert.ok(JSON.stringify(out).length<28000);
});
