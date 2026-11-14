/**
 * Local, deterministic, project-scoped multi-model synthesis.
 * No remote calls, background inference, prompting, verification or publication.
 * Lexical overlap is NOT semantic agreement or evidence of factual correctness.
 */
import {createHash} from 'node:crypto';
const MODELS=['ChatGPT','Gemini','Perplexity'];
const MAX_QUOTE=340,MAX_SENTENCES=65,MAX_TOPICS=12;
const STOP=new Set(`about above after again against along also among around because before being below between both could every first from further having into itself other over same should since than that their them there these this those through under until very were what when where which while would your yours with without then here only they have been will more most many some such much just even does done said says each plus thus also have this note probably likely maybe probably using use used come going like want need check please thanks lūdzu tāpēc pašlaik tādēļ šobrīd piemēram tikai arī vienam vienīgi būt būtu var viņš viņa viņi viņas kurš kurā kāds kāda tāds tāda tajā tur tās tas šis šajā ar līdz par pēc pirms cik vai kur kad nav bija ir es mēs jūs mums mani savā savu savu kā par pie no uz lai un bet arī ar to jau gan šie šīm tam tos tēma lieta pilnībā`.split(/\s+/));
const clean=s=>String(s??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/gu,' ').trim();
const digest=s=>createHash('sha256').update(String(s)).digest('hex');
const words=s=>new Set((clean(s).toLocaleLowerCase('lv-LV').normalize('NFKC')
  .match(/[\p{L}\p{N}]{4,}/gu)||[]).filter(w=>!STOP.has(w)&&!/^\d{4,}$/.test(w)));
const intersection=(a,b)=>[...a].filter(w=>b.has(w));
function sentences(input){
  const text=String(input??'').slice(0,32768).replace(/\r\n?/g,'\n');
  const blocks=text.split(/(?<=[.!?])(?:\s+|\n+)|\n{1,}|\s+(?=[•*-]\s+)/u);
  const result=[];
  for(const raw of blocks){
    const candidate=clean(raw).replace(/^[•*\-\d.)\s]+/,'');
    if(candidate.length>=35&&candidate.length<=800&&words(candidate).size>=5){
      result.push(candidate.slice(0,MAX_QUOTE));
      if(result.length>=MAX_SENTENCES)break;
    }
  }
  return result;
}
const quality=s=>!s.ok?'ERROR':
  s.kind==='ASSISTANT_DOM_CANDIDATE'?'ASSISTANT_DOM_UNVERIFIED':
  s.kind==='PAGE_TEXT_AFTER_PROMPT'?'PROMPT_RELATIVE_PAGE_UNVERIFIED':'PAGE_ONLY_NOT_ISOLATED';
const contentFor=s=>s.kind==='ASSISTANT_DOM_CANDIDATE'?s.answer:
  s.kind==='PAGE_TEXT_AFTER_PROMPT'?s.text:'';

export function buildCoordinationSynthesis(run){
  if(!run||typeof run.project!=='string'||!Array.isArray(run.targets)||
     !Array.isArray(run.snapshots)||run.targets.length>3)
    throw new Error('COORDINATION_SYNTHESIS_INVALID');
  const targets=new Map(run.targets.map(t=>[t.id,t]));
  if(run.snapshots.some(s=>targets.get(s.tabId)?.model!==s.model))
    throw new Error('COORDINATION_SYNTHESIS_SCOPE_MISMATCH');
  const chunks=run.snapshots.map(s=>{
    const content=s.ok?String(contentFor(s)||'').slice(0,32768):'';
    const candidates=s.ok&&quality(s)!=='PAGE_ONLY_NOT_ISOLATED'?sentences(content):[];
    return {model:s.model,tabId:s.tabId,origin:targets.get(s.tabId)?.origin||null,
      url:typeof s.url==='string'?s.url.slice(0,500):'',
      readAt:s.readAt||null,quality:quality(s),ok:s.ok===true,
      monitorState:s.monitorState||null,truncated:s.truncated===true,
      contentHash:content?digest(content):null,
      contentCharacters:content.length,
      excerpts:candidates.slice(0,4),
      sentences:candidates,error:s.ok?null:String(s.error||'CAPTURE_FAILED').slice(0,180)};
  });
  const groups=[];const all=chunks.filter(c=>['ASSISTANT_DOM_UNVERIFIED',
    'PROMPT_RELATIVE_PAGE_UNVERIFIED'].includes(c.quality));
  for(const entry of all){
    for(const sentence of entry.sentences){
      const tokens=words(sentence);
      let found=null,best=0;
      for(const group of groups){
        if(group.items.some(e=>e.model===entry.model))continue;
        const anchor=words(group.items[0].quote);
        const common=intersection(tokens,anchor).length;
        const union=new Set([...tokens,...anchor]).size;
        const score=union?common/union:0;
        if(common>=5&&score>=0.5&&score>best){best=score;found=group;}
      }
      if(found){found.items.push({model:entry.model,quote:sentence,
        quality:entry.quality});found.similarity=Math.min(found.similarity,best);}
      else groups.push({similarity:1,items:[{model:entry.model,quote:sentence,
        quality:entry.quality}]});
    }
  }
  const shared=groups.filter(g=>new Set(g.items.map(i=>i.model)).size>=2)
    .map(g=>({models:g.items.map(i=>i.model),score:Math.round(g.similarity*100)/100,
      quotes:g.items.map(x=>({...x}))}))
    .sort((a,b)=>b.models.length-a.models.length||b.score-a.score)
    .slice(0,MAX_TOPICS);
  const isolated=chunks.map(c=>({model:c.model,quality:c.quality,
    excerpts:c.excerpts.slice(0,3)}));
  const eligible=chunks.filter(c=>c.quality==='ASSISTANT_DOM_UNVERIFIED').length;
  const fallback=chunks.filter(c=>c.quality==='PROMPT_RELATIVE_PAGE_UNVERIFIED').length;
  const failed=chunks.filter(c=>!c.ok).length;
  return {
    schema:'mnemos.coordination.synthesis.v1',verified:false,semanticAnalysis:false,
    project:run.project,runId:run.id||null,generatedAt:new Date().toISOString(),
    prompt:String(run.prompt||'').slice(0,1600),
    summary:{requestedModels:run.targets.map(t=>t.model),observed:chunks.length,
      isolatedAssistantCandidates:eligible,promptRelativeFallbacks:fallback,
      pageOnly:chunks.filter(c=>c.quality==='PAGE_ONLY_NOT_ISOLATED').length,
      failed,lexicalMatches:shared.length,
      completeRun:chunks.length===run.targets.length&&failed===0,
      allResponsesIsolated:eligible===run.targets.length&&run.targets.length>0},
    evidence:chunks.map(({sentences,...rest})=>rest),
    lexicalMatches:shared,perModelHighlights:isolated,
    unresolved:['The presence of an answer fragment does not independently verify factual claims.',
      'Lexical matches are wording similarity only; conflicts, nuanced semantics and correctness were NOT evaluated.',
      'Provider page text may contain user prompts, navigation, advertisements and earlier replies.'],
    method:'LOCAL_DETERMINISTIC_LEXICAL_SIMILARITY_NO_MODEL_INFERENCE',
    status:chunks.length===run.targets.length&&failed===0?
      eligible===run.targets.length?'UNVERIFIED_RESPONSES_ISOLATED':'PARTIAL_PROVENANCE':
      'INCOMPLETE'
  };
}

export function coordinationSynthesisReport(data){
  if(data?.schema!=='mnemos.coordination.synthesis.v1')
    throw new Error('COORDINATION_SYNTHESIS_REPORT_INVALID');
  const a=[];
  a.push('MNEMOS · Strukturēts vairāku modeļu pārskats');
  a.push('Statuss: '+data.status+' · apgalvojumi NAV faktoloģiski pārbaudīti');
  a.push('Uzdevums: '+data.prompt);
  a.push('Iegūti: '+data.summary.observed+'/'+data.summary.requestedModels.length+
    ' · izolēti asistenta teksti: '+data.summary.isolatedAssistantCandidates+
    ' · daļēji izolēti: '+data.summary.promptRelativeFallbacks);
  a.push('Avoti un izvilkumi (NEUZTICAMA ĀRĒJA INFORMĀCIJA):');
  for(const entry of data.evidence){
    a.push('— '+entry.model+' | '+entry.quality+' | '+(entry.origin||'unknown origin'));
    if(entry.error)a.push('  Kļūda: '+entry.error);
    for(const quote of entry.excerpts.slice(0,3))a.push('  • '+quote);
  }
  a.push('Leksiski līdzīgi fragmenti starp modeļiem: '+data.lexicalMatches.length);
  for(const m of data.lexicalMatches.slice(0,6)){
    a.push('— '+m.models.join(' + ')+' | tekstu līdzība '+Math.round(m.score*100)+'%');
    for(const q of m.quotes.slice(0,3))a.push('  '+q.model+': '+q.quote);
  }
  if(!data.lexicalMatches.length)a.push('Leksiski līdzīgi fragmenti nav atrasti; tas NEPIERĀDA domstarpības.');
  a.push('Ierobežojums: leksiska līdzība nenozīmē faktu patiesumu vai semantisku vienprātību. Pretrunas nav automātiski analizētas.');
  return a.join('\n').slice(0,15500);
}
