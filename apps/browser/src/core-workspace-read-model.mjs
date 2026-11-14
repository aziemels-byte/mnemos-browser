/**
 * MNEMOS Browser: safe, read-only projection of the CANONICAL Core cockpit.
 * Experimental data boundary. NOT wired into live Browser UI.
 *
 * Source: GET /api/cockpit/snapshot (and optional GET /api/owner-goals).
 * Core is the authority. Browser SQLite is NOT canonical Core memory or work.
 */
export const CORE_UI_READ_MODEL_SCHEMA='mnemos.browser.core-first.read-model.v1';
export const CORE_SNAPSHOT_ROUTE='/api/cockpit/snapshot';
const TERMINAL=new Set(['COMPLETED','CANCELLED','FAILED','ACCEPTED','REJECTED']);
const ACTIVE=new Set(['RUNNING','ACTIVE','IN_PROGRESS','STARTED','VERIFYING','RESULT_SUBMITTED']);
const WAITING=new Set(['WAITING_APPROVAL','APPROVAL_REQUIRED','DUE','STALE']);
const PAUSED=new Set(['PAUSED','BLOCKED','BUDGET_EXHAUSTED']);
const str=(value,max=220)=>typeof value==='string'?value.slice(0,max):'';
const arr=value=>Array.isArray(value)?value:[];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value:{};
function stateOf(item){
  const raw=str(item?.status,80).toUpperCase()||'UNKNOWN';
  if(item?.executionStatus==='idle'&&raw==='ACTIVE')return 'PAUSED';
  if(TERMINAL.has(raw))return 'TERMINAL';
  if(WAITING.has(raw)||raw.includes('APPROVAL'))return 'WAITING';
  if(PAUSED.has(raw)||raw.includes('PAUSED'))return 'PAUSED';
  if(ACTIVE.has(raw))return 'ACTIVE';
  return 'UNKNOWN';
}
function record(kind,item){
 const id=kind==='goal'?item.goalId:item.taskId;
 if(typeof id!=='string'||!id||id.length>200)return null;
 const checkpoint=object(item.checkpoint);
 return {
  key:kind+':'+id,
  kind,
  id,
  title:str(kind==='goal'?item.objective:(item.title||item.taskDefinition?.title||id),320),
  rawStatus:str(item.status,70)||'UNKNOWN',
  classification:stateOf(item),
  nextAction:str(checkpoint.nextAction||item.nextAction||item.lastProgress,320)||null,
  phase:str(checkpoint.currentPhase,120)||null,
  resumeReason:str(checkpoint.resumeReason,320)||null,
  taskId:kind==='development'?id:null,
  updatedAt:typeof item.updatedAt==='string'?item.updatedAt:typeof item.createdAt==='string'?item.createdAt:null,
  source:{endpoint:CORE_SNAPSHOT_ROUTE,field:kind==='goal'?'continuation.goals':'developmentTasks',id},
  verified:false // A task status or UI badge is NOT verification evidence.
 };
}
function projectGraph(value){
 const raw=object(value),seen=new Set();
 const nodes=arr(raw.nodes).slice(0,256).flatMap(n=>{
  if(typeof n?.id!=='string'||!n.id||seen.has(n.id))return [];
  seen.add(n.id);
  return [{id:n.id,label:str(n.label,150),status:str(n.state,80),source:CORE_SNAPSHOT_ROUTE+':taskGraph.nodes'}];
 });
 // Do not synthesize a sequential graph from array order. Only actual supplied edges count.
 const edges=arr(raw.edges).slice(0,512)
  .filter(e=>typeof e?.from==='string'&&typeof e?.to==='string'&&seen.has(e.from)&&seen.has(e.to))
  .map(e=>({from:e.from,to:e.to,source:CORE_SNAPSHOT_ROUTE+':taskGraph.edges'}));
 return {nodes,edges,mode:nodes.length?'SOURCE_GRAPH':'NO_GRAPH_AVAILABLE'};
}
export function coreFreshness(timestamp,nowMs=Date.now()){
 const ms=Date.parse(timestamp||'');
 if(!Number.isFinite(ms)||!Number.isFinite(nowMs))return {state:'UNAVAILABLE',ageMs:null};
 const ageMs=Math.max(0,nowMs-ms);
 return {state:ageMs>20000?'OLD':ageMs>7000?'STALE':'FRESH',ageMs};
}
export function buildCoreFirstReadModel(coreSnapshot,{nowMs=Date.now(),projectId=null}={}){
 const s=object(coreSnapshot);
 const freshness=coreFreshness(s.capturedAt,nowMs);
 const rows=[...arr(s.continuation?.goals).map(t=>record('goal',t)),
  ...arr(s.developmentTasks).map(t=>record('development',t))].filter(Boolean);
 const priority={ACTIVE:0,WAITING:1,PAUSED:2,UNKNOWN:3,TERMINAL:4};
 rows.sort((a,b)=>(priority[a.classification]-priority[b.classification])||
  String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
 const approvals=arr(s.approvals).slice(0,60).filter(a=>typeof a?.approvalId==='string')
  .map(a=>({id:a.approvalId,taskId:str(a.taskId,200)||null,
   action:str(a.action,200),status:str(a.status,70),risk:str(a.risk,70),
   source:CORE_SNAPSHOT_ROUTE+':approvals'}));
 const coreActive=rows.filter(r=>r.classification==='ACTIVE').length;
 const waiting=rows.filter(r=>r.classification==='WAITING').length;
 const paused=rows.filter(r=>r.classification==='PAUSED').length;
 const evidence={
   tests:arr(s.tests).filter(x=>typeof x?.testRunId==='string')
     .slice(0,14).map(x=>({
       id:x.testRunId,taskId:str(x.taskId,150)||null,title:str(x.title,280),
       result:x.passed===true?'PASS':x.passed===false?'FAIL':'UNKNOWN',
       exitCode:Number.isInteger(x.exitCode)?x.exitCode:null,
       at:typeof x.createdAt==='string'?x.createdAt:null,
       source:CORE_SNAPSHOT_ROUTE+':tests',verified:false
     })),
   diffs:arr(s.diffs).filter(x=>typeof x?.patchId==='string')
     .slice(0,14).map(x=>({
       id:x.patchId,taskId:str(x.taskId,150)||null,title:str(x.title,280),
       path:str(x.targetPath,250),status:str(x.status,70)||'UNKNOWN',
       at:typeof x.createdAt==='string'?x.createdAt:null,
       source:CORE_SNAPSHOT_ROUTE+':diffs',verified:false
     }))
 };
 const frontier=arr(s.frontierSessions?.sessions).slice(0,80).filter(x=>typeof x?.sessionId==='string')
   .map(x=>({id:x.sessionId,liveness:str(x.liveness,80),status:str(x.status,80),
    lastSeenAt:typeof x.lastSeenAt==='string'?x.lastSeenAt:null,
    source:CORE_SNAPSHOT_ROUTE+':frontierSessions.sessions'}));
 return Object.freeze({
  schema:CORE_UI_READ_MODEL_SCHEMA,
  readOnly:true,
  canonicalSource:'MNEMOS Core',
  endpoint:CORE_SNAPSHOT_ROUTE,
  sourceCapturedAt:typeof s.capturedAt==='string'?s.capturedAt:null,
  sourceSequence:Number.isSafeInteger(s.sequence)?s.sequence:null,
  freshness,
  projectScope:'GLOBAL_CORE_SNAPSHOT',
  requestedBrowserProjectId:typeof projectId==='string'?projectId:null,
  caveat:'Core snapshot is global; no Browser-project filter inferred from it.',
  connection:s.service?.status==='ready'&&freshness.state==='FRESH'?'CORE_READY':
    freshness.state==='UNAVAILABLE'?'UNKNOWN':freshness.state==='FRESH'?'DEGRADED':'STALE_DATA',
  work:rows.slice(0,100),
  counts:{active:coreActive,waiting,paused,terminal:rows.filter(r=>r.classification==='TERMINAL').length,
    unknown:rows.filter(r=>r.classification==='UNKNOWN').length},
  attention:approvals,
  evidence,
  graph:projectGraph(s.taskGraph),
  frontier,
  memory:{source:'CORE',status:'NO_CANONICAL_MEMORY_PROJECTION',entries:[]},
  browserTabs:{source:'BROWSER_SESSION',status:'SEPARATE_CAPABILITY_NOT_IN_CORE_SNAPSHOT'},
  provenance:{claim:'READ_ONLY_SNAPSHOT_NOT_ACTION_VERIFICATION',
    authoritativeFields:['capturedAt','sequence','continuation.goals','developmentTasks','approvals','frontierSessions','taskGraph','tests','diffs']},
 });
}
