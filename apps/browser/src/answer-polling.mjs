/**
 * Bounded polling of authenticated web-chat read-only observations.
 * Never clicks, sends, retries a prompt, or assumes the remote service accepted it.
 */
import {createHash} from 'node:crypto';
export const RESPONSE_POLL_INTERVAL_MS=1800;
export const RESPONSE_POLL_ATTEMPTS=65; // <= 117 s plus per-read latency
export const snapshotDigest=value=>createHash('sha256').update(String(value??'')).digest('hex');

export function assessResponseSample(data,{baselineHash=null,baselinePageHash=null}={}){
  if(!data||typeof data!=='object')return {ready:false,kind:'PAGE_TEXT_ONLY',fingerprint:null,
    reason:'EMPTY_READ'};
  const kind=['ASSISTANT_DOM_CANDIDATE','PERPLEXITY_COMPLETED_TEXT_CANDIDATE','CHATGPT_COMPLETED_TURN_TEXT_CANDIDATE','GEMINI_STABLE_TURN_TEXT_CANDIDATE'].includes(data.kind)?
    data.kind:data.kind==='PAGE_TEXT_AFTER_PROMPT'?'PAGE_TEXT_AFTER_PROMPT':'PAGE_TEXT_ONLY';
  const text=String(['ASSISTANT_DOM_CANDIDATE','PERPLEXITY_COMPLETED_TEXT_CANDIDATE','CHATGPT_COMPLETED_TURN_TEXT_CANDIDATE','GEMINI_STABLE_TURN_TEXT_CANDIDATE'].includes(kind)?
    data.answer:data.text||'');
  const fingerprint=snapshotDigest(kind+'\n'+text);
  const rawAnswerHash=data.answer?snapshotDigest(data.answer):null;
  const rawPageHash=data.text?snapshotDigest(data.text):null;
  if(data.busy)return {ready:false,kind,fingerprint,reason:'RESPONSE_STREAMING'};
  if(['ASSISTANT_DOM_CANDIDATE','PERPLEXITY_COMPLETED_TEXT_CANDIDATE','CHATGPT_COMPLETED_TURN_TEXT_CANDIDATE','GEMINI_STABLE_TURN_TEXT_CANDIDATE'].includes(kind)){
    if(!data.promptFound)return {ready:false,kind,fingerprint,reason:'CURRENT_PROMPT_NOT_FOUND'};
    if(['PERPLEXITY_COMPLETED_TEXT_CANDIDATE','CHATGPT_COMPLETED_TURN_TEXT_CANDIDATE'].includes(kind)&&
      (data.assistantAfterPrompt!==true||data.completionVisible!==true))
      return {ready:false,kind,fingerprint,reason:'PERPLEXITY_REPLY_ANCHOR_NOT_VERIFIED'};
    if(kind==='GEMINI_STABLE_TURN_TEXT_CANDIDATE'&&data.assistantAfterPrompt!==true)
      return {ready:false,kind,fingerprint,reason:'GEMINI_CURRENT_TURN_NOT_ANCHORED'};
    if(!text.trim())return {ready:false,kind,fingerprint,reason:'ANSWER_EMPTY'};
    if(baselineHash&&rawAnswerHash===baselineHash)
      return {ready:false,kind,fingerprint,reason:'OLD_RESPONSE_UNCHANGED'};
    return {ready:true,kind,fingerprint,
      reason:kind==='PERPLEXITY_COMPLETED_TEXT_CANDIDATE'? 'UNVERIFIED_PERPLEXITY_COMPLETED_TEXT':
        kind==='CHATGPT_COMPLETED_TURN_TEXT_CANDIDATE'? 'UNVERIFIED_CHATGPT_COMPLETED_TEXT':
        kind==='GEMINI_STABLE_TURN_TEXT_CANDIDATE'? 'UNVERIFIED_GEMINI_STABLE_TEXT':
          'UNVERIFIED_NEW_ASSISTANT_DOM'};
  }
  if(kind==='PAGE_TEXT_AFTER_PROMPT'){
    // Brief model replies (ACK tokens, single-word answers) are legitimate.
    // Their provenance remains PAGE_TEXT_AFTER_PROMPT, never a verified assistant
    // response; stability and a visible prompt are still required.
    if(!data.promptFound||text.trim().length<5)
      return {ready:false,kind,fingerprint,reason:'WAITING_FOR_VISIBLE_RESPONSE'};
    if(baselinePageHash&&rawPageHash===baselinePageHash)
      return {ready:false,kind,fingerprint,reason:'OLD_PAGE_UNCHANGED'};
    // This is a page-text fallback, NOT an assistant answer. Ready only for
    // review after stability and explicitly labeled incomplete evidence.
    return {ready:true,kind,fingerprint,reason:'UNVERIFIED_PAGE_AFTER_PROMPT'};
  }
  return {ready:false,kind,fingerprint,reason:'NO_CURRENT_RESPONSE_ANCHOR'};
}

export async function pollResponse({
  sample,baselineHash=null,baselinePageHash=null,
  intervalMs=RESPONSE_POLL_INTERVAL_MS,maxAttempts=RESPONSE_POLL_ATTEMPTS,
  stableReads=2,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  cancelled=()=>false,onSample=()=>{},assistantOnly=false
}={}){
  if(typeof sample!=='function'||typeof wait!=='function'||typeof cancelled!=='function'||
     !Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>300||
     !Number.isInteger(stableReads)||stableReads<1||stableReads>5||
     !Number.isInteger(intervalMs)||intervalMs<0||intervalMs>5000||
     typeof assistantOnly!=='boolean')
    throw new Error('COORDINATION_POLL_OPTIONS_INVALID');
  let count=0,previous=null,last=null,completedButUnreadable=0;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    if(cancelled())return {state:'CANCELLED',attempts:attempt-1,sample:last};
    const data=await sample();
    const assessment=assessResponseSample(data,{baselineHash,baselinePageHash});
    // The council can only relay an isolated assistant DOM response.
    // A prompt-relative PAGE_TEXT fallback might consist solely of page
    // chrome/footer and can appear before the assistant begins streaming.
    // Do NOT finish after two stable fallback reads in assistant-only mode.
    const isolated=['ASSISTANT_DOM_CANDIDATE',
      'PERPLEXITY_COMPLETED_TEXT_CANDIDATE','CHATGPT_COMPLETED_TURN_TEXT_CANDIDATE','GEMINI_STABLE_TURN_TEXT_CANDIDATE'].includes(assessment.kind);
    const acceptable=assessment.ready&&(!assistantOnly||isolated);
    const fp=acceptable?assessment.fingerprint:null;
    count=fp&&fp===previous?count+1:fp?1:0;previous=fp;last={data,assessment};
    await onSample({attempt,assessment,stableCount:count});
    if(acceptable&&count>=stableReads)return {
      state:isolated?'CANDIDATE_CAPTURED':'FALLBACK_CAPTURED',
      attempts:attempt,stableReads:count,sample:last
    };
    // A provider can visibly say "completed" while our selectors are stale.
    // Stop this futile long wait promptly. Never fabricate a reply or resend.
    completedButUnreadable=assistantOnly&&data?.completionVisible===true&&!isolated?
      completedButUnreadable+1:0;
    if(completedButUnreadable>=3)return {state:'PROVIDER_REPLY_UNREADABLE',
      attempts:attempt,sample:last};
    if(attempt<maxAttempts)await wait(intervalMs);
  }
  return {state:'TIMEOUT_UNVERIFIED',attempts:maxAttempts,sample:last};
}
