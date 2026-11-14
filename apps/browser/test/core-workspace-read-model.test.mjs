import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCoreFirstReadModel,coreFreshness,CORE_UI_READ_MODEL_SCHEMA,CORE_SNAPSHOT_ROUTE} from '../src/core-workspace-read-model.mjs';

const now=Date.parse('2026-11-12T12:00:00.000Z');
const fixture=()=>({
 capturedAt:'2026-11-12T11:59:59.000Z',sequence:42,service:{status:'ready'},
 continuation:{goals:[
  {goalId:'g-active',objective:'Implement Core-first UI',status:'ACTIVE',updatedAt:'2026-11-12T11:59:40Z',nextAction:'Review real task graph'},
  {goalId:'g-idle',objective:'Paused job',status:'ACTIVE',executionStatus:'idle'},
  {goalId:'g-wait',objective:'Wait for human approval',status:'APPROVAL_REQUIRED'},
  {goalId:'g-done',objective:'Finished task',status:'COMPLETED'}
 ]},
 developmentTasks:[
  {taskId:'t-running',title:'Real integration task',status:'RUNNING',checkpoint:{currentPhase:'implement',nextAction:'Run E2E',resumeReason:'manual review'}},
  {taskId:'t-blocked',title:'Blocked task',status:'BLOCKED'},
  {taskId:'t-unknown',title:'Unrecognized status',status:'CUSTOM'},
 ],
 approvals:[{approvalId:'a-1',taskId:'t-running',action:'Merge',status:'PENDING',risk:'HIGH'}],
 frontierSessions:{sessions:[{sessionId:'session-1',liveness:'RECENT',status:'ONLINE',lastSeenAt:'2026-11-12T11:59:45Z'}]},
 taskGraph:{nodes:[{id:'n1',label:'Plan',state:'COMPLETED'},{id:'n2',label:'Build',state:'RUNNING'}],
 edges:[{from:'n1',to:'n2'},{from:'n2',to:'missing'}]}
});
test('freshness: fresh/stale/old/unavailable are based on source timestamp, not local refresh',()=>{
 assert.deepEqual(coreFreshness('2026-11-12T11:59:59Z',now),{state:'FRESH',ageMs:1000});
 assert.equal(coreFreshness('2026-11-12T11:59:52Z',now).state,'STALE');
 assert.equal(coreFreshness('2026-11-12T11:59:30Z',now).state,'OLD');
 assert.deepEqual(coreFreshness('fake',now),{state:'UNAVAILABLE',ageMs:null});
});
test('read model separates canonical source, project scope, readiness and truth of memory',()=>{
 const p=buildCoreFirstReadModel(fixture(),{nowMs:now,projectId:'local-mnemos'});
 assert.equal(p.schema,CORE_UI_READ_MODEL_SCHEMA);
 assert.equal(p.endpoint,CORE_SNAPSHOT_ROUTE);
 assert.equal(p.readOnly,true);
 assert.equal(p.projectScope,'GLOBAL_CORE_SNAPSHOT');
 assert.equal(p.requestedBrowserProjectId,'local-mnemos');
 assert.equal(p.connection,'CORE_READY');
 assert.equal(p.sourceSequence,42);
 assert.deepEqual(p.memory.entries,[]);
 assert.equal(p.memory.status,'NO_CANONICAL_MEMORY_PROJECTION');
 assert.equal(p.browserTabs.status,'SEPARATE_CAPABILITY_NOT_IN_CORE_SNAPSHOT');
});
test('paused ACTIVE/idle work is not counted as running; unknown is not completed',()=>{
 const model=buildCoreFirstReadModel(fixture(),{nowMs:now});
 assert.deepEqual(model.counts,{active:2,waiting:1,paused:2,terminal:1,unknown:1});
 assert.equal(model.work.find(x=>x.id==='g-idle').classification,'PAUSED');
 assert.equal(model.work.find(x=>x.id==='t-unknown').classification,'UNKNOWN');
 assert.equal(model.work[0].classification,'ACTIVE');
 assert.equal(model.work.at(-1).classification,'TERMINAL');
});
test('work items carry their real IDs, checkpoint and truthful nonverification',()=>{
 const model=buildCoreFirstReadModel(fixture(),{nowMs:now});
 const run=model.work.find(x=>x.id==='t-running');
 assert.equal(run.key,'development:t-running');
 assert.equal(run.phase,'implement');
 assert.equal(run.nextAction,'Run E2E');
 assert.equal(run.resumeReason,'manual review');
 assert.equal(run.source.field,'developmentTasks');
 assert.equal(run.verified,false);
 assert.equal(model.work.find(x=>x.id==='g-active').source.field,'continuation.goals');
});
test('only authoritative graph edges are visible, no chain inferred from node order',()=>{
 const model=buildCoreFirstReadModel(fixture(),{nowMs:now});
 assert.equal(model.graph.mode,'SOURCE_GRAPH');
 assert.deepEqual(model.graph.edges.map(x=>[x.from,x.to]),[['n1','n2']]);
 assert.equal(model.graph.edges[0].source,CORE_SNAPSHOT_ROUTE+':taskGraph.edges');
 const x=fixture();x.taskGraph={nodes:[{id:'n1'},{id:'n2'}]};
 assert.equal(buildCoreFirstReadModel(x,{nowMs:now}).graph.edges.length,0);
});
test('approval and Frontier Bus entries remain distinctly attributed and not synthetic',()=>{
 const model=buildCoreFirstReadModel(fixture(),{nowMs:now});
 assert.equal(model.attention[0].id,'a-1');
 assert.equal(model.attention[0].source,CORE_SNAPSHOT_ROUTE+':approvals');
 assert.equal(model.frontier[0].id,'session-1');
 assert.equal(model.frontier[0].liveness,'RECENT');
});
test('stale Core cannot appear online just because the last status says ready',()=>{
 const v=fixture();v.capturedAt='2026-11-12T11:59:00Z';
 const model=buildCoreFirstReadModel(v,{nowMs:now});
 assert.equal(model.connection,'STALE_DATA');
 assert.equal(model.freshness.state,'OLD');
});
test('unavailable Core returns empty truthful state, without mock tasks or graph',()=>{
 const model=buildCoreFirstReadModel(null,{nowMs:now});
 assert.equal(model.connection,'UNKNOWN');
 assert.equal(model.work.length,0);
 assert.equal(model.attention.length,0);
 assert.equal(model.graph.mode,'NO_GRAPH_AVAILABLE');
 assert.equal(model.sourceSequence,null);
});
test('hostile strings are data, not markup; long values are bounded',()=>{
 const v=fixture();v.developmentTasks[0].title='<img src=x onerror=alert(1)>'+'x'.repeat(1000);
 const model=buildCoreFirstReadModel(v,{nowMs:now});
 const title=model.work.find(x=>x.id==='t-running').title;
 assert.ok(title.startsWith('<img src=x onerror=alert(1)>'));
 assert.equal(title.length,320);
});
test('Core test/diff evidence is source-labelled and never treated as proof of task completion',()=>{
 const snapshot=fixture();
 snapshot.tests=[
  {testRunId:'test-11',taskId:'t-running',title:'Failure case',
    passed:false,exitCode:1,createdAt:'2026-11-12T11:59:00Z'},
  {testRunId:'test-12',taskId:'t-running',title:'Passing run',
    passed:true,exitCode:0,createdAt:'2026-11-12T11:59:30Z'}
 ];
 snapshot.diffs=[{patchId:'patch-3',taskId:'t-running',title:'Patch',
  status:'PROPOSED',targetPath:'apps/browser/src/main.mjs',createdAt:'2026-11-12T11:59:10Z'}];
 const model=buildCoreFirstReadModel(snapshot,{nowMs:now});
 assert.equal(model.evidence.tests.length,2);
 assert.equal(model.evidence.tests[0].result,'FAIL');
 assert.equal(model.evidence.tests[1].result,'PASS');
 assert.equal(model.evidence.tests[1].verified,false);
 assert.equal(model.evidence.tests[0].source,CORE_SNAPSHOT_ROUTE+':tests');
 assert.equal(model.evidence.diffs[0].status,'PROPOSED');
 assert.equal(model.evidence.diffs[0].verified,false);
 assert.equal(model.evidence.diffs[0].source,CORE_SNAPSHOT_ROUTE+':diffs');
});

test('duplicate graph node IDs cannot duplicate actual edges',()=>{
 const x=fixture();x.taskGraph.nodes.push({id:'n1',label:'imposter'});
 const model=buildCoreFirstReadModel(x,{nowMs:now});
 assert.equal(model.graph.nodes.length,2);
 assert.equal(model.graph.edges.length,1);
});
