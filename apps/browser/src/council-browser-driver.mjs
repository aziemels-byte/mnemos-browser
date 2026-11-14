/**
 * Narrow MNEMOS Browser council I/O. Uses ONLY already-open authenticated
 * Electron WebContents. No headless sessions, new windows, API secrets, clicks
 * on arbitrary sites, or automatic retry of an ambiguous submission.
 */
import {createHash} from 'node:crypto';
import {collaborationModel,collaborationComposer,collaborationSendButton} from './model-coordination.mjs';
import {performBrowserAction} from './browser-actions.mjs';
import {modelAnswerExtractionScript,preparedDraftTextScript} from './model-answer-capture.mjs';
import {pollResponse,snapshotDigest} from './answer-polling.mjs';

const hash=v=>createHash('sha256').update(String(v)).digest('hex');
// Chat editors convert paragraph breaks, NBSP and other whitespace when inserting
// text. For council's plain-language prompts, compare all WORDS and punctuation,
// not exact DOM line-break layout. Never accept missing/replaced text.
export function councilDraftEquivalent(actual,expected){
  if(typeof actual!=='string'||typeof expected!=='string'||
     !actual.trim()||!expected.trim())return false;
  if(hash(actual)===hash(expected))return true;
  const words=v=>v.normalize('NFC').replace(/\s+/gu,' ').trim();
  return words(actual)===words(expected);
}
/**
 * Only read-only evidence of dispatch. A provider can navigate from / to
 * /session/... before the legacy submit's editor-cleared check returns.
 * Do not mistake this route transition for a failed send and click twice.
 */
export async function verifyCouncilDispatch({sample,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),delays=[0,300,600,900,1300,1800,2200,2500]}={}){
  if(typeof sample!=='function'||typeof wait!=='function'||
     !Array.isArray(delays)||delays.length<1||delays.length>8)
    throw new Error('COUNCIL_DISPATCH_PROOF_OPTIONS_INVALID');
  for(const delay of delays){
    if(!Number.isInteger(delay)||delay<0||delay>2500)
      throw new Error('COUNCIL_DISPATCH_PROOF_OPTIONS_INVALID');
    if(delay)await wait(delay);
    let result;
    try{result=await sample();}catch{continue;}
    // The editor MUST be empty and the actual current prompt must be visible
    // on a valid, already authenticated model-chat page.
    if(result?.allowed===true&&result?.promptVisible===true&&result?.editorEmpty===true)
      return {promptVisible:true,receiptEvidence:'VISIBLE_PROMPT_AND_EMPTY_EDITOR',
        url:result.url};
  }
  return {promptVisible:false,receiptEvidence:'DISPATCH_NOT_VERIFIED'};
}
export function createCouncilBrowserDriver({getTab,selectTab,getWindow,isClosing=()=>false,testMode=false,poll=pollResponse}){
  if(typeof getTab!=='function'||typeof selectTab!=='function'||typeof getWindow!=='function')
    throw new Error('COUNCIL_BROWSER_DRIVER_DEPENDENCIES_INVALID');
  function targetFor(project,target){
    const tab=getTab(target.id),wc=tab?.view?.webContents;
    if(!tab||tab.project!==project||tab.private||tab.loading||tab.crashed||
       !wc||wc.isDestroyed()||isClosing())
      throw new Error('COUNCIL_TAB_NOT_READY');
    const url=wc.getURL(),u=new URL(url);
    if(collaborationModel(url)!==target.model||u.origin!==target.origin)
      throw new Error('COUNCIL_ORIGIN_CHANGED');
    return {tab,wc,url,u};
  }
  async function send({project,target,prompt}){
    if(testMode)throw new Error('COUNCIL_EXTERNAL_SENDING_BLOCKED_IN_TESTS');
    const {tab,wc,url,u}=targetFor(project,target);
    const scope={expectedOrigin:u.origin,expectedPath:u.pathname};
    // Cross-run idempotency: a user may click Start again after an ambiguous
    // attempt. Never send the identical council prompt twice to a chat which
    // already visibly contains it. Read only; no hidden new tab/navigation.
    const old=await wc.executeJavaScript(modelAnswerExtractionScript(target.model,{prompt}),true);
    if(old?.promptFound===true)throw new Error('COUNCIL_PROMPT_ALREADY_VISIBLE');
    const baselineHash=old?.answer?snapshotDigest(old.answer):null;
    const described=await performBrowserAction(wc,{operation:'tab.describe',...scope,limit:64});
    const composer=collaborationComposer(described,target.model);
    const win=getWindow();
    if(!win||win.isDestroyed())throw new Error('COUNCIL_WINDOW_NOT_AVAILABLE');
    if(!win.isVisible())win.show();
    win.focus();selectTab(tab.id);
    // Only ONE insertion. A ChatGPT rich-text composer may normalize whitespace
    // or update asynchronously, making strict first-frame verification fail.
    // Recover by READ-ONLY inspections, never by inserting the prompt again.
    let fillError=null;
    try{
      const filled=await performBrowserAction(wc,{operation:'tab.fill',...scope,...composer,value:prompt});
      if(filled.filled!==true)fillError=new Error('COUNCIL_FILL_NOT_VERIFIED');
    }catch(error){
      if(error?.message!=='FILL_NOT_VERIFIED')throw error;
      fillError=error;
    }
    let draftConfirmed=false;
    for(const delay of [0,250,500,850]){
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      targetFor(project,target); // reject navigation/closed tab before reading
      let observed;
      try{observed=await wc.executeJavaScript(preparedDraftTextScript(composer),true);}
      catch(error){
        if(error?.message?.includes('DRAFT_FIELD_CHANGED'))throw error;
        continue;
      }
      if(councilDraftEquivalent(observed?.text,prompt)){
        draftConfirmed=true;break;
      }
    }
    if(!draftConfirmed)throw fillError||new Error('COUNCIL_DRAFT_MISMATCH_NO_SEND');
    const buttons=[];let offset=0;
    for(let attempt=0;offset!==null&&attempt<4;attempt++){
      const d=await performBrowserAction(wc,{operation:'tab.describe',...scope,
        fieldOffset:0,buttonOffset:offset,limit:64});
      buttons.push(...d.buttons);offset=d.nextButtonOffset;
    }
    const btn=collaborationSendButton({buttons},target.model);
    const current=targetFor(project,target);
    if(current.wc!==wc||current.url!==url||!win.isFocused())
      throw new Error('COUNCIL_FOCUS_OR_PAGE_CHANGED');
    const result=await performBrowserAction(wc,{operation:'tab.submit',...scope,...btn});
    let extra={promptVisible:false};
    if(result?.triggered===true&&result?.editorCleared!==true){
      // NATIVE pointer was already dispatched exactly once. A successful
      // Perplexity / -> /session navigation makes the old path-bound
      // editor-clear check return null. Reconcile read-only; NEVER resend.
      extra=await verifyCouncilDispatch({sample:async()=>{
        const current=targetFor(project,target);
        const {wc:active,u:currentUrl,url:activeUrl}=current;
        if(active!==wc)return {allowed:false};
        const observed=await active.executeJavaScript(
          modelAnswerExtractionScript(target.model,{prompt}),true);
        if(active.getURL()!==activeUrl)return {allowed:false};
        if(observed?.promptFound!==true)return {allowed:true,promptVisible:false};
        const metadata=await performBrowserAction(active,{
          operation:'tab.describe',expectedOrigin:currentUrl.origin,
          expectedPath:currentUrl.pathname,limit:64
        });
        let editorEmpty=false;
        try{editorEmpty=!!collaborationComposer(metadata,target.model);}
        catch{}
        return {allowed:true,promptVisible:true,editorEmpty,
          url:currentUrl.origin+currentUrl.pathname};
      }});
    }
    return {...result,...extra,baselineHash,url:extra.url||u.origin+u.pathname};
  }
  async function capture({project,target,prompt,baselineHash,cancelled=()=>false,
    requireResponseAfterPrompt=false,onProgress=()=>{}}){
    // After a real submission, providers may navigate via a temporary document,
    // login/redirect transition or a new /c/ conversation path. Capture is
    // READ-ONLY: short-lived URL mismatches must not abort the whole council.
    // Never read or relay content from an unapproved origin/path.
    let transientReads=0;
    const pendingNavigation=()=>({kind:'PAGE_TEXT_ONLY',text:'',promptFound:false,
      busy:true,answer:'',navigationPending:true});
    const temporary=error=>['COUNCIL_ORIGIN_CHANGED','COUNCIL_TAB_NOT_READY',
      'COUNCIL_RESPONSE_PAGE_CHANGED'].includes(error?.message);
    const suspend=error=>{
      transientReads++;
      if(transientReads>6)throw error;
      return pendingNavigation();
    };
    const found=await poll({
      // Reasoning-mode web chats may take far longer than two minutes.
      // Keep one bounded, cancelable read-only wait (up to ~16 minutes), no retries.
      baselineHash,maxAttempts:240,stableReads:2,intervalMs:4000,assistantOnly:true,
      cancelled:()=>cancelled()||isClosing(),
      onSample:({attempt,assessment})=>{
        if(attempt===1||attempt%5===0)
          onProgress({attempt,reason:assessment?.reason||'WAITING'});
      },
      sample:async()=>{
        let scoped;
        try{scoped=targetFor(project,target);}
        catch(error){
          if(!temporary(error))throw error;
          return suspend(error);
        }
        const {wc,url,u}=scoped;
        let observed;
        try{
          observed=await wc.executeJavaScript(
            modelAnswerExtractionScript(target.model,{prompt}),true);
        }catch(error){
          // WebContents may be replaced during a provider navigation.
          if(wc.isDestroyed())throw error;
          const next=wc.getURL();
          if(next!==url)return suspend(new Error('COUNCIL_RESPONSE_PAGE_CHANGED'));
          throw error;
        }
        if(wc.isDestroyed())throw new Error('COUNCIL_TAB_NOT_READY');
        if(wc.getURL()!==url)
          return suspend(new Error('COUNCIL_RESPONSE_PAGE_CHANGED'));
        transientReads=0;
        // When reconciling an uncertain send, only recover a response
        // following THIS exact prompt. A stale assistant block is not enough.
        if(requireResponseAfterPrompt&&observed?.assistantAfterPrompt!==true)
          return {kind:'PAGE_TEXT_ONLY',text:'',promptFound:false,
            completionVisible:observed?.completionVisible===true,
            busy:!!observed?.busy,answer:''};
        return {...observed,observedUrl:u.origin+u.pathname};
      }
    });
    const data=found.sample?.data;
    if(found.state==='CANDIDATE_CAPTURED'&&
       ['ASSISTANT_DOM_CANDIDATE','PERPLEXITY_COMPLETED_TEXT_CANDIDATE',
         'CHATGPT_COMPLETED_TURN_TEXT_CANDIDATE',
          'GEMINI_STABLE_TURN_TEXT_CANDIDATE'].includes(data?.kind)&&
       data?.promptFound===true&&
       (!requireResponseAfterPrompt||data?.assistantAfterPrompt===true))
      return {state:'CANDIDATE_CAPTURED',answer:data.answer,url:data.observedUrl,
        answerKind:data.kind,reason:found.sample.assessment.reason};
    return {state:found.state,reason:found.sample?.assessment?.reason||'NO_VERIFIED_RESPONSE_CANDIDATE'};
  }
  return {send,capture};
}
