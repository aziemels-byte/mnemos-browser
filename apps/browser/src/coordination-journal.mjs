/**
 * Durable, project-local multi-model coordination history.
 * Stores unverified web observations, never labels them verified model answers.
 * This journal does not publish to Core, send network requests or execute prompts.
 */
import {randomUUID} from 'node:crypto';
import {buildCoordinationSynthesis,coordinationSynthesisReport} from './coordination-synthesis.mjs';

const MAX_RUNS=12,MAX_TARGETS=3,MAX_TEXT=32768;
const MODELS=new Set(['ChatGPT','Gemini','Perplexity']);
const ALLOWED_ORIGINS={ChatGPT:new Set(['https://chatgpt.com']),
  Gemini:new Set(['https://gemini.google.com']),
  Perplexity:new Set(['https://www.perplexity.ai','https://perplexity.ai'])};
const ID=/^[a-zA-Z0-9_-]{1,90}$/;
const UUID=/^[a-f0-9-]{36}$/i;
const key=project=>'coordination.history.v1.'+project;
const own=(project,run)=>run&&run.project===project;

export function compareUnverifiedSnapshots(snapshots){
  if(!Array.isArray(snapshots)||snapshots.length>MAX_TARGETS)
    throw new Error('COORDINATION_SNAPSHOT_LIMIT');
  const sources=snapshots.map(s=>{
    if(!MODELS.has(s.model)||typeof s.tabId!=='string'||!ID.test(s.tabId))
      throw new Error('COORDINATION_SNAPSHOT_INVALID');
    const kind=s.kind==='ASSISTANT_DOM_CANDIDATE'?'ASSISTANT_DOM_CANDIDATE':'PAGE_TEXT_ONLY';
    const content=s.ok&&typeof s.answer==='string'?s.answer.slice(0,MAX_TEXT):'';
    // Only answer candidates may participate in side-by-side text comparison.
    const comparable=s.ok&&kind==='ASSISTANT_DOM_CANDIDATE'&&content.trim().length>=60;
    return {model:s.model,kind,comparable,characters:content.length,
      error:s.ok?null:(s.error||'NOT_CAPTURED')};
  });
  const eligible=snapshots.filter((s,i)=>sources[i].comparable);
  // Exact sentence overlap is a literal text signal, not a fact-check, agreement,
  // independence proof, semantic equivalence or contradiction detector.
  const sentenceMap=new Map();
  for(const s of eligible){
    const sentences=new Set(String(s.answer).replace(/\s+/g,' ').split(/(?<=[.!?])\s+/u)
      .map(t=>t.trim()).filter(t=>t.length>=45&&t.length<=450));
    for(const sentence of sentences){
      const normalized=sentence.toLocaleLowerCase('lv-LV').normalize('NFKC');
      const old=sentenceMap.get(normalized)||{text:sentence,models:[]};
      if(!old.models.includes(s.model))old.models.push(s.model);
      sentenceMap.set(normalized,old);
    }
  }
  const repeated=[...sentenceMap.values()]
    .filter(v=>v.models.length>=2)
    .sort((a,b)=>b.models.length-a.models.length||a.text.localeCompare(b.text))
    .slice(0,10);
  return {schema:'mnemos.coordination.comparison.v1',verified:false,
    method:'EXACT_SENTENCE_OVERLAP_ONLY',count:sources.length,
    comparableCount:eligible.length,sources,repeated,
    limitations:'Exact wording overlap does not verify truth or independent agreement. Page-only captures are excluded; no semantic contradiction analysis.'};
}


export function formatUnverifiedCoordinationReport(run){
  if(!run||!Array.isArray(run.snapshots)||!run.snapshots.length||
     !run.comparison)throw new Error('COORDINATION_REPORT_NOT_READY');
  const out=[
    ...(run.synthesis?[coordinationSynthesisReport(run.synthesis),'',
      '— DETALIZĒTĀS NOLASĪŠANAS PIEZĪMES —','']:[]),
    '[MNEMOS — NEPĀRBAUDĪTS vairāku AI tīmekļa avotu pārskats]',
    'Ievades uzdevums: '+run.prompt,
    'Izveidots: '+run.createdAt,
    'Pēdējā nolasīšana: '+run.updatedAt,
    'Iegūšanas režīms: '+String(run.monitoring?.state||'MANUĀLA NOLASĪŠANA'),
    'Dati ir iegūti no autentificētām tīmekļa lapām. Tie nav neatkarīgi faktu pārbaudīti.',
    ''
  ];
  for(const source of run.snapshots){
    out.push('== '+source.model+' ==');
    out.push('Avota veids: '+source.kind+(source.ok?'':' (nolasīšanas kļūda)'));
    out.push('Uzraudzības statuss: '+String(source.monitorState||'NEPĀRBAUDĪTS'));
    if(source.truncated)out.push('BRĪDINĀJUMS: avota teksts bija garāks par 32768 rakstzīmēm.');
    if(source.ok){
      out.push('Avota adrese: '+source.url);
      out.push(source.kind==='ASSISTANT_DOM_CANDIDATE'?
        'Iespējamās asistenta atbildes fragments (nav verificēts):':
        'Tīmekļa lapas teksts (NAV izolēta asistenta atbilde):');
      out.push((source.kind==='ASSISTANT_DOM_CANDIDATE'?source.answer:source.text).slice(0,3900));
    }else out.push('Kļūda: '+source.error);
    out.push('');
  }
  out.push('== FORMĀLS TEKSTU SALĪDZINĀJUMS (NAV FAKTU KONSENSS) ==');
  out.push('Atbilžu kandidāti: '+run.comparison.comparableCount+'/'+run.comparison.count);
  if(run.comparison.comparableCount<2)out.push('Nav pietiekamu kandidātu modeļu salīdzināšanai.');
  else if(!run.comparison.repeated.length)
    out.push('Vienādi formulētas pietiekami garas frāzes netika atrastas.');
  for(const item of run.comparison.repeated)
    out.push(item.models.join(' + ')+': '+item.text);
  out.push('Neviens apgalvojums nav validēts. Exact text overlap nenozīmē faktu pareizību, neatkarīgu piekrišanu vai pretrunu neesamību.');
  out.push('Pilni atlasītie fragmenti (līdz 32768 rakstzīmēm no katra) glabājas lokālajā MNEMOS Browser projekta sesijas žurnālā.');
  return out.join('\n').slice(0,15600);
}

export class CoordinationJournal {
  constructor(store){this.store=store;}
  #history(project){
    if(!ID.test(project))throw new Error('COORDINATION_PROJECT_INVALID');
    this.store.project(project);
    const rows=this.store.get(key(project),[]);
    if(!Array.isArray(rows))throw new Error('COORDINATION_HISTORY_CORRUPT');
    return rows;
  }
  list(project){
    return this.#history(project).map(r=>({
      id:r.id,project:r.project,createdAt:r.createdAt,updatedAt:r.updatedAt,
      prompt:r.prompt,status:r.status,targets:r.targets,
      captured:r.snapshots?.length||0,comparableCount:r.comparison?.comparableCount||0,
      synthesisStatus:r.synthesis?.status||null,
      synthesisMetrics:r.synthesis?.summary?{
        isolated:r.synthesis.summary.isolatedAssistantCandidates,
        fallback:r.synthesis.summary.promptRelativeFallbacks,
        matches:r.synthesis.summary.lexicalMatches}:null,
      monitoring:r.monitoring??null
    }));
  }
  get(project,id){
    if(typeof id!=='string'||!UUID.test(id))throw new Error('COORDINATION_RUN_ID_INVALID');
    const row=this.#history(project).find(r=>r.id===id);
    if(!own(project,row))throw new Error('COORDINATION_RUN_SCOPE_DENIED');
    return structuredClone(row);
  }
  begin(project,{prompt,targets,contextIds=[]}){
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>1600||
       !Array.isArray(targets)||!targets.length||targets.length>MAX_TARGETS||
       !Array.isArray(contextIds)||contextIds.length>2)
      throw new Error('COORDINATION_RUN_INVALID');
    const ids=new Set(),models=new Set();
    for(const target of targets){
      if(!target||!ID.test(target.id)||!MODELS.has(target.model)||
         ids.has(target.id)||models.has(target.model)||
         (target.origin!==undefined&&!ALLOWED_ORIGINS[target.model]?.has(target.origin)))
        throw new Error('COORDINATION_TARGETS_INVALID');
      ids.add(target.id);models.add(target.model);
    }
    for(const id of contextIds)if(!ID.test(id))throw new Error('COORDINATION_CONTEXT_ID_INVALID');
    const now=new Date().toISOString(),row={
      id:randomUUID(),project,prompt:prompt.trim(),targets:targets.map(t=>({
        id:t.id,model:t.model,...(t.origin?{origin:t.origin}:{})})),
      contextIds:[...new Set(contextIds)],status:'PREPARING',
      drafts:[],submissions:[],snapshots:[],comparison:null,synthesis:null,
      monitoring:null,createdAt:now,updatedAt:now
    };
    const history=this.#history(project);
    history.unshift(row);
    this.store.set(key(project),history.slice(0,MAX_RUNS));
    return structuredClone(row);
  }
  drafts(project,id,results){
    if(!Array.isArray(results)||results.length>MAX_TARGETS)throw new Error('COORDINATION_DRAFTS_INVALID');
    return this.#mutate(project,id,r=>{
      r.drafts=results.map(v=>({tabId:v.tabId,model:v.model,ok:v.ok===true,
        submitted:false,characters:v.ok?Number(v.characters)||0:0,
        baselineHash:/^[a-f0-9]{64}$/.test(v.baselineHash||'')?v.baselineHash:null,
        draftHash:/^[a-f0-9]{64}$/.test(v.draftHash||'')?v.draftHash:null,
        ...(v.ok?{}:{error:String(v.error||'NOT_PREPARED').slice(0,160)})}));
      r.status=r.drafts.every(v=>v.ok)?'DRAFTS_PREPARED':'DRAFTS_PARTIAL';
    });
  }
  recoverInterrupted(project){
    const rows=this.#history(project);
    let touched=false;
    for(const row of rows)if(row.monitoring?.state==='RUNNING'){
      row.monitoring.state='INTERRUPTED_BY_RESTART';
      row.monitoring.finishedAt=new Date().toISOString();
      row.status='CAPTURE_INTERRUPTED';
      row.updatedAt=new Date().toISOString();touched=true;
    }
    if(touched)this.store.set(key(project),rows);
    return {interrupted:touched};
  }
  failMonitoring(project,id,error){
    return this.#mutate(project,id,r=>{
      if(!r.monitoring)r.monitoring={};
      r.monitoring.state='FAILED';
      r.monitoring.error=String(error?.message??error).slice(0,180);
      r.monitoring.finishedAt=new Date().toISOString();
      r.status='CAPTURE_FAILED';
    });
  }
  beginMonitoring(project,id){
    const row=this.get(project,id);
    if(!row.submissions?.length)throw new Error('COORDINATION_MONITOR_REQUIRES_SUBMISSION');
    if(row.monitoring?.state==='RUNNING')return row;
    return this.#mutate(project,id,r=>{
      r.monitoring={state:'RUNNING',startedAt:new Date().toISOString(),targets:[],
        automatic:true};
      r.status='COLLECTING_RESPONSES';
    });
  }
  updateMonitoring(project,id,tabId,{state,reason,attempts}){
    const row=this.get(project,id);
    if(!row.targets.some(t=>t.id===tabId)||row.monitoring?.state!=='RUNNING')
      throw new Error('COORDINATION_MONITOR_NOT_ACTIVE');
    return this.#mutate(project,id,r=>{
      const target=r.monitoring.targets.find(t=>t.tabId===tabId);
      const next={tabId,state:String(state||'WAITING').slice(0,60),
        reason:String(reason||'').slice(0,100),attempts:Number(attempts)||0};
      if(target)Object.assign(target,next);else r.monitoring.targets.push(next);
    });
  }
  captured(project,id,snapshots){
    if(!Array.isArray(snapshots)||!snapshots.length||snapshots.length>MAX_TARGETS)
      throw new Error('COORDINATION_SNAPSHOTS_INVALID');
    const row=this.get(project,id),expected=new Map(row.targets.map(t=>[t.id,t.model]));
    if(snapshots.length!==expected.size||new Set(snapshots.map(s=>s.tabId)).size!==snapshots.length||
      snapshots.some(s=>expected.get(s.tabId)!==s.model))
      throw new Error('COORDINATION_SNAPSHOT_TARGET_MISMATCH');
    const cleaned=snapshots.map(s=>({
      tabId:s.tabId,model:s.model,ok:s.ok===true,
      kind:s.kind==='ASSISTANT_DOM_CANDIDATE'?'ASSISTANT_DOM_CANDIDATE':
        s.kind==='PAGE_TEXT_AFTER_PROMPT'?'PAGE_TEXT_AFTER_PROMPT':'PAGE_TEXT_ONLY',
      title:String(s.title||'').slice(0,180),
      url:String(s.url||'').slice(0,500),
      text:String(s.text||'').slice(0,MAX_TEXT),
      answer:String(s.answer||'').slice(0,MAX_TEXT),
      note:String(s.note||'').slice(0,100),
      monitorState:String(s.monitorState||'').slice(0,60),
      answerChars:Math.max(0,Number(s.answerChars)||0),
      bodyChars:Math.max(0,Number(s.bodyChars)||0),
      truncated:s.truncated===true,
      readAt:String(s.readAt||'').slice(0,35),
      ...(s.ok?{}:{error:String(s.error||'CAPTURE_FAILED').slice(0,160)})
    }));
    const comparison=compareUnverifiedSnapshots(cleaned);
    const synthesis=buildCoordinationSynthesis({...row,snapshots:cleaned,comparison});
    return this.#mutate(project,id,r=>{
      r.snapshots=cleaned;r.comparison=comparison;r.synthesis=synthesis;
      if(r.monitoring){r.monitoring.state='FINISHED';r.monitoring.finishedAt=new Date().toISOString();}
      r.status=comparison.comparableCount>=2?'COMPARISON_AVAILABLE':'CAPTURED_UNVERIFIED';
    });
  }
  authorizeSubmission(project,id,tabIds){
    if(!Array.isArray(tabIds)||!tabIds.length||tabIds.length>MAX_TARGETS||
       new Set(tabIds).size!==tabIds.length)
      throw new Error('COORDINATION_SUBMISSION_TARGETS_INVALID');
    const row=this.get(project,id);
    if(row.submissions?.length)throw new Error('COORDINATION_ALREADY_SUBMISSION_ATTEMPTED');
    for(const tabId of tabIds){
      if(!row.targets.some(t=>t.id===tabId)||
         !row.drafts.some(d=>d.tabId===tabId&&d.ok&&/^[a-f0-9]{64}$/.test(d.draftHash||'')))
        throw new Error('COORDINATION_SUBMISSION_NOT_PREPARED');
    }
    return this.#mutate(project,id,r=>{
      const at=new Date().toISOString();
      r.submissions=tabIds.map(tabId=>({tabId,model:r.targets.find(t=>t.id===tabId).model,
        state:'INTENT_RECORDED',submitted:false,at}));
      r.status='SUBMISSION_INTENT_RECORDED';
    });
  }
  completeSubmission(project,id,tabId,{submitted,error,editorCleared}={}){
    const row=this.get(project,id),current=row.submissions?.find(s=>s.tabId===tabId);
    if(!current||current.state!=='INTENT_RECORDED')
      throw new Error('COORDINATION_SUBMISSION_NOT_PENDING');
    return this.#mutate(project,id,r=>{
      const s=r.submissions.find(v=>v.tabId===tabId);
      s.submitted=submitted===true;
      s.editorCleared=editorCleared===true?true:editorCleared===false?false:null;
      s.state=s.submitted?'TRIGGERED_UNVERIFIED':'FAILED';
      s.error=s.submitted?null:String(error||'TRIGGER_FAILED').slice(0,160);
      s.completedAt=new Date().toISOString();
      const all=r.submissions.every(x=>x.state!=='INTENT_RECORDED');
      r.status=all?
        (r.submissions.every(x=>x.submitted)?'SUBMISSION_TRIGGERED_UNVERIFIED':'SUBMISSION_PARTIAL'):
        'SUBMISSION_IN_PROGRESS';
    });
  }
  saved(project,id,memoryId){
    if(typeof memoryId!=='string'||!ID.test(memoryId))throw new Error('COORDINATION_MEMORY_ID_INVALID');
    return this.#mutate(project,id,r=>{r.savedMemoryId=memoryId;});
  }
  #mutate(project,id,transform){
    const rows=this.#history(project),index=rows.findIndex(x=>x.id===id);
    if(index<0||!own(project,rows[index]))throw new Error('COORDINATION_RUN_SCOPE_DENIED');
    const row=structuredClone(rows[index]);transform(row);row.updatedAt=new Date().toISOString();
    rows[index]=row;
    this.store.set(key(project),rows);
    return structuredClone(row);
  }
}
