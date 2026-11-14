import { app, BrowserWindow, WebContentsView, ipcMain, protocol, session, dialog, Menu, safeStorage, clipboard } from 'electron';
import { readFile, mkdir } from 'node:fs/promises';
import { appendFileSync, mkdirSync, renameSync, statSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dns from 'node:dns/promises';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { BrowserStore } from './store.mjs';
import { selectBrowserProfile } from './profile-policy.mjs';
import { connectorOrigin, connectorPaths, requireConnectorOrigin } from './connector-config.mjs';
import { CoreClient } from './core-client.mjs';
import { buildCoreFirstReadModel } from './core-workspace-read-model.mjs';
import { createPageObservationReview } from './page-observation-review.mjs';
import { OllamaAdapter } from './ollama.mjs';
import { TurnService } from './turn-service.mjs';
import { BrowserFrontier } from './frontier.mjs';
import { CoreBrowserBridge, OWNER_SESSION } from './core-browser-bridge.mjs';
import { performBrowserAction } from './browser-actions.mjs';
import { collaborationModel, collaborationPlan, recoverCollaborationSample, coordinationDraft, collaborationComposer, collaborationComposerWithState, collaborationSendButton, delegatedModelPromptAllowed } from './model-coordination.mjs';
import { modelAnswerExtractionScript, preparedDraftTextScript } from './model-answer-capture.mjs';
import { pollResponse, snapshotDigest } from './answer-polling.mjs';
import { CoordinationJournal, formatUnverifiedCoordinationReport } from './coordination-journal.mjs';
import { CoordinationExecutor } from './coordination-executor.mjs';
import { CouncilConversation } from './council-conversation.mjs';
import { LocalCouncilManager, chooseLocalCouncilModel } from './council-local-manager.mjs';
import { createCouncilBrowserDriver } from './council-browser-driver.mjs';
import { attachBrowserFile } from './browser-file-upload.mjs';
import { buildPerplexityHandoff, perplexityAllowedUrl, focusEmptyPerplexityComposer } from './perplexity-handoff.mjs';
import { APP_URL, WEB_PREFERENCES, PROVIDERS, validateWebURL, omniboxURL, isPrivateHost, assertShellSender, validateId, text, canLoadLocalModel } from './policy.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Hash the code actually available when THIS main process starts.
// A package updated on disk does not magically update an existing Electron process.
const runtimeBuild=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0,16);
const runtimeStartedAt=new Date().toISOString();
const testMode=process.argv.includes('--test-mode');
const fixtureOrigin=testMode?process.env.MNEMOS_TEST_WEB_ORIGIN:null;
const urlOptions={fixtureOrigin};
const defaultCoreOrigin = 'http://127.0.0.1:4320';
const coreOrigin = (testMode ? process.env.MNEMOS_TEST_CORE_ORIGIN : process.env.MNEMOS_BROWSER_CORE_ORIGIN) ?? defaultCoreOrigin;
// Do not put NEW authenticated sessions, caches or credentials beside the executable.
// An existing legacy profile is deliberately kept IN PLACE until an explicit,
// separately approved closed-browser migration (never copy a live Chromium profile).
const legacyProfile=path.join(root,'.profile');
const defaultProfile=path.join(app.getPath('appData'),'MNEMOS Browser');
const profileSelection=selectBrowserProfile({testMode,testProfile:process.env.MNEMOS_TEST_PROFILE,
  explicitProfile:process.env.MNEMOS_BROWSER_PROFILE,legacyProfile,defaultProfile,
  legacyExists:existsSync(legacyProfile)});
const profile=profileSelection.path,profileLocation=profileSelection.location;

app.setPath('userData',profile);
app.setPath('sessionData',path.join(profile,'chromium'));
// Local-only crash evidence. Do not log tab contents, cookies, prompts, or credentials.
const faultLog=path.join(profile,'logs','runtime-errors.jsonl');
function logRuntimeFault(kind,error,context=''){
  try {
    const scrub=value=>String(value??'').replace(/https?:\/\/[^\s"'<>]+/gi,url=>{
      try {const u=new URL(url);return u.origin+'/[redacted]';}
      catch {return '[redacted-url]';}
    }).replace(/(bearer\s+|token[=:]|api[_-]?key[=:])[^\s"']+/gi,'$1[redacted]').slice(0,3500);
    const entry={schema:'mnemos.browser.runtime-error.v1',time:new Date().toISOString(),
      kind:scrub(kind),name:scrub(error?.name??'Error'),
      message:scrub(error?.message??error),stack:scrub(error?.stack??''),
      context:scrub(context),pid:process.pid};
    mkdirSync(path.dirname(faultLog),{recursive:true});
    try {if(statSync(faultLog).size>1024*1024)renameSync(faultLog,faultLog+'.previous');}
    catch (rotationError) {if(rotationError.code!=='ENOENT')throw rotationError;}
    appendFileSync(faultLog,JSON.stringify(entry)+'\n',{encoding:'utf8',mode:0o600});
  }catch{ /* Diagnostics must never cause an application crash. */ }
}
// Electron launched from an ephemeral console/agent can inherit a closed stderr pipe.
// A subsequent console.error() then emits EPIPE from node:internal/streams/writable,
// which used to produce the native "A JavaScript error occurred in the main process" dialog.
// Once a stdio pipe closes, never write to it again; persist diagnostics to a file instead.
const brokenStdio=new Set();
const isConsolePipeError=error=>
  ['EPIPE','ERR_STREAM_DESTROYED'].includes(error?.code)&&
  /(?:console\.(?:error|warn|log)|node:internal\/console|node:internal\/streams\/writable)/.test(String(error?.stack??''));
for(const [channel,stream] of [['stdout',process.stdout],['stderr',process.stderr]]){
  if(stream?.on)stream.on('error',error=>{
    if(['EPIPE','ERR_STREAM_DESTROYED'].includes(error?.code)){
      brokenStdio.add(channel);
      logRuntimeFault('stdio-pipe-disconnected',error,channel);
      return;
    }
    logRuntimeFault('stdio-stream-error',error,channel);
  });
}
for(const [method,channel] of [['error','stderr'],['warn','stderr'],['log','stdout'],['info','stdout']]){
  const original=console[method].bind(console);
  console[method]=(...args)=>{
    if(brokenStdio.has(channel)){
      const error=args.find(x=>x instanceof Error);
      if(error)logRuntimeFault('console-after-closed-'+channel,error,method);
      return;
    }
    try{original(...args);}
    catch(error){
      if(['EPIPE','ERR_STREAM_DESTROYED'].includes(error?.code)){
        brokenStdio.add(channel);
        logRuntimeFault('console-pipe-disconnected',error,method);
      }else throw error;
    }
  };
}
process.on('uncaughtExceptionMonitor',(error,origin)=>logRuntimeFault('uncaught-exception',error,origin));
process.on('uncaughtException',(error,origin)=>{
  if(isConsolePipeError(error)){
    brokenStdio.add('stderr');
    logRuntimeFault('console-pipe-uncaught',error,origin);
    return; // Only a detached console pipe is nonfatal, not arbitrary application failures.
  }
  logRuntimeFault('uncaught-fatal',error,origin);
  try{app.exit(1);}catch{process.exitCode=1;}
});
process.on('unhandledRejection',reason=>{
  logRuntimeFault('unhandled-rejection',reason);
  if(isConsolePipeError(reason)){brokenStdio.add('stderr');return;}
  if(!closing)report(reason);
});
app.on('render-process-gone',(_event,contents,details)=>
  logRuntimeFault('renderer-process-gone',new Error(String(details?.reason??'unknown')),
    'renderer='+contents?.id+' exit='+String(details?.exitCode??'unknown')));
app.on('child-process-gone',(_event,details)=>
  logRuntimeFault('child-process-gone',new Error(String(details?.reason??'unknown')),
    'type='+String(details?.type??'unknown')+' exit='+String(details?.exitCode??'unknown')));
protocol.registerSchemesAsPrivileged([{scheme:'mnemos',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
let win,store,frontier,turns,bridge,coordinationJournal,coordinationExecutor,councilRunner,activeId='home',activeProject='mnemos',section='workspace',lastError=null,models=[],coreState=null;
let closing=false,refreshing=false,restoringTabs=false,overlay=false,emitTimer,pendingPerplexityHandoff=null;
const tabs=new Map(),configuredSessions=new WeakSet(),browserSessions=new Set();
const activeCoordinationPolls=new Set();
const delegatedPromptRates=new Map();
let coreWorkspaceCache=null, coreWorkspaceCacheAt=0, coreWorkspaceReadInFlight=null;
async function coreWorkspaceRead(){
  const now=Date.now();
  if(coreWorkspaceCache&&now-coreWorkspaceCacheAt<1400)return coreWorkspaceCache;
  if(coreWorkspaceReadInFlight)return coreWorkspaceReadInFlight;
  coreWorkspaceReadInFlight=core.read('/api/cockpit/snapshot')
    .then(snapshot=>{
      const value=buildCoreFirstReadModel(snapshot,{nowMs:Date.now()});
      coreWorkspaceCache=value;coreWorkspaceCacheAt=Date.now();return value;
    }).finally(()=>{coreWorkspaceReadInFlight=null;});
  return coreWorkspaceReadInFlight;
}
const CHAT_GUARD_KEY='core.orchestrator.chat.intent.v1';
const CHAT_JOURNAL_KEY='core.orchestrator.chat.local-journal.v1';
const CHAT_CONVERSATION_KEY='core.orchestrator.chat.conversation.v1';
async function submitCoreChat(payload){
  if(activeId!=='home'||section!=='workspace')throw new Error('CORE_CHAT_REQUIRES_ACTIVE_WORKSPACE');
  const key=String(payload.key??'');
  if(!/^[0-9a-f-]{36}$/i.test(key))throw new Error('CORE_CHAT_KEY_INVALID');
  const message=text(payload.message,16000),history=store.get(CHAT_GUARD_KEY,[]);
  if(history.some(x=>x.key===key))throw new Error('CORE_CHAT_ALREADY_ATTEMPTED_NO_RETRY');
  const conversationId=store.get(CHAT_CONVERSATION_KEY,null);
  const intent={key,at:new Date().toISOString(),status:'SUBMISSION_INTENT_RECORDED'};
  store.set(CHAT_GUARD_KEY,[...history.slice(-99),intent]);
  const journal=store.get(CHAT_JOURNAL_KEY,[]);
  store.set(CHAT_JOURNAL_KEY,[...journal.slice(-59),{
    key,role:'user',text:message,at:intent.at,delivery:'UNCERTAIN_NO_RETRY'}]);
  try{
    const result=await core.submitOrchestrator({message,conversationId});
    if(result.conversationId)store.set(CHAT_CONVERSATION_KEY,result.conversationId);
    const receipt={key,role:'assistant',text:result.reply,at:new Date().toISOString(),
      runId:result.runId,proofHash:result.proofHash,source:result.source,verified:false};
    store.set(CHAT_JOURNAL_KEY,[...store.get(CHAT_JOURNAL_KEY,[]).slice(-59),receipt]);
    store.set(CHAT_GUARD_KEY,store.get(CHAT_GUARD_KEY,[]).map(x=>x.key===key?{...x,status:'REPLY_RECEIVED'}:x));
    return {sent:true,reply:result.reply,runId:result.runId,proofHash:result.proofHash,
      conversationId:result.conversationId,source:result.source,verified:false};
  }catch(error){
    const code=String(error?.message??error).slice(0,180);
    store.set(CHAT_GUARD_KEY,store.get(CHAT_GUARD_KEY,[]).map(x=>x.key===key?{...x,status:'UNCERTAIN_NO_RETRY',code}:x));
    // A timeout does not prove the Core failed to process the request.
    throw new Error('CORE_CHAT_UNCERTAIN_NO_RETRY: '+code);
  }
}

const core=new CoreClient({base:coreOrigin});
const observations = createPageObservationReview({
  core,
  getActiveTab: currentTab,
  getActiveProject: () => activeProject,
  credentials: () => {
    if (!bridge?.enabled || !bridge.connected || !bridge.verifier) {
      throw new Error('Savieno pārlūku ar Core sadaļā Iestatījumi.');
    }
    return { sessionId: bridge.sessionId, verifier: bridge.verifier };
  }
});
const ollama=new OllamaAdapter({...(testMode?{base:process.env.MNEMOS_TEST_OLLAMA_ORIGIN}: {})});
const localCouncilManager=new LocalCouncilManager({
  adapter:ollama,listModels:()=>ollama.models(),
  resourceGuard:()=>canLoadLocalModel({
    freeBytes:os.freemem(),totalBytes:os.totalmem(),
    guard:coreState?.guard,fixture:testMode
  }),
  timeoutMs:18000
});
const assetTypes={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const assets=new Set(['index.html','shell.css','pipboy.css','core-workspace.css','core-workspace-ui.js','shell.js','robot-persona.css','robot-persona.js','provider-avatars.css','provider-avatars.js','quiet-surface.css','logo.svg']);
function currentTab(){return tabs.get(activeId);}
function state(){return {version:'0.1.0',testMode,activeId,activeProject,section,error:lastError,
  mcpEndpoint:configuredMcpEndpoint(),
  runtime:{mainBuild:runtimeBuild,startedAt:runtimeStartedAt,profileLocation},
  tabs:[...tabs.values()].map(t=>{
    const wc=t.view.webContents;
    const history=wc&&!wc.isDestroyed()?wc.navigationHistory:null;
    return {id:t.id,project:t.project,private:t.private,url:t.url,title:t.title,loading:t.loading,error:t.error,crashed:t.crashed,
      canBack:history?.canGoBack()??false,canForward:history?.canGoForward()??false};
  }),
  local:store.snapshot(),core:coreState,frontier:frontier.snapshot(),bridge:bridge?.snapshot()??null,
  coordination:coordinationJournal?.list(activeProject)||[],
  council:councilRunner?.summary(activeProject)||null,
  councilAgentModel:chooseLocalCouncilModel(models),models,providers:PROVIDERS};}
function emit(){
  if(closing)return;
  clearTimeout(emitTimer);
  emitTimer=setTimeout(()=>{
    if(!win||win.isDestroyed())return;
    const wc=win.webContents;
    if(wc&&!wc.isDestroyed())wc.send('mnemos:state',state());
  },30);
}
function report(error){lastError=String(error?.message??error).slice(0,400);emit();}
function persistTabs(){
  if(restoringTabs)return;
  store.set('tabs',[...tabs.values()].filter(t=>!t.private).map(t=>({id:t.id,url:t.url,project:t.project})));
}
function layout(){
  if(!win||win.isDestroyed())return;
  const [w,h]=win.getContentSize();
  for(const tab of tabs.values()){
    const visible=tab.id===activeId&&!overlay;
    tab.view.setVisible(visible);
    if(visible) {const side=w<1180?288:336;const left=w<1000?184:212;tab.view.setBounds({x:left,y:96,width:Math.max(240,w-left-side),height:Math.max(200,h-124)});}
  }
}
async function publicRequest(url){
  if(url==='about:blank')return true;
  const u=new URL(url);
  if(['data:','blob:'].includes(u.protocol))return true;
  const checked=u.protocol==='wss:'?url.replace(/^wss:/,'https:'):url;
  validateWebURL(checked,urlOptions);
  if(fixtureOrigin && u.origin===fixtureOrigin)return true;
  const records=await dns.lookup(u.hostname.replace(/^\[|\]$/g,''),{all:true});
  if(!records.length||records.some(r=>isPrivateHost(r.address)))throw new Error('PRIVATE_NETWORK_BLOCKED');
  return true;
}
function configureWebSession(s){
  if(configuredSessions.has(s))return;configuredSessions.add(s);browserSessions.add(s);
  s.webRequest.onBeforeRequest(async(details,callback)=>{
    const remoteNavigation=details.resourceType==='mainFrame'&&
      [...tabs.values()].find(tab=>tab.nativeNavigation&&tab.view.webContents?.id===details.webContentsId)?.nativeNavigation;
    try {
      if(remoteNavigation&&(details.method!=='GET'||new URL(details.url).origin!==remoteNavigation.origin))
        throw new Error('NAVIGATION_SCOPE_DENIED');
      await publicRequest(details.url);
      callback({cancel:false});
    } catch { callback({cancel:true}); }
  });
  const grants=new Set();
  // Media permission is always reviewed per request; microphone approval must not imply camera approval.
  s.setPermissionCheckHandler((_wc,permission,origin)=>permission!=='media'&&grants.has(`${origin}:${permission}`));
  s.setPermissionRequestHandler(async(wc,permission,callback,details)=>{
    try{
      const tab=[...tabs.values()].find(t=>t.view.webContents===wc);
      const origin=new URL(details?.requestingUrl||wc.getURL()).origin;
      const media=(details?.mediaTypes??[]).map(type=>({audio:'mikrofonu',video:'kameru'}[type])).filter(Boolean).join(' un ');
      const labels={media,geolocation:'atrašanās vietu',notifications:'paziņojumus','clipboard-read':'starpliktuves lasīšanu'};
      if(!tab||tab.id!==activeId||!labels[permission]){callback(false);return;}
      const answer=await dialog.showMessageBox(win,{type:'question',title:'Vietnes atļauja',message:`${origin} pieprasa ${labels[permission]}`,detail:permission==='media'?'Atļauja der šim pieprasījumam.':'Atļauja der tikai šai lietotnes palaišanas reizei.',buttons:['Noraidīt','Atļaut'],defaultId:0,cancelId:0});
      const allow=answer.response===1&&!wc.isDestroyed()&&tab.id===activeId&&wc.getURL().startsWith(origin+'/');
      if(allow&&permission!=='media')grants.add(`${origin}:${permission}`);callback(allow);
    }catch{callback(false);}
  });
  s.on('will-download',(_event,item,wc)=>{
    const tab=[...tabs.values()].find(t=>t.view.webContents===wc);
    if(!tab||tab.id!==activeId||!item.hasUserGesture()){item.cancel();return;}
    const name=path.basename(item.getFilename());
    // Synchronous API: Chromium owns the Save As dialog and its cancellation lifecycle.
    item.setSaveDialogOptions({title:'Saglabāt lejupielādi',defaultPath:path.join(profile,'downloads',name)});
    store.event('download.requested',{name});
    item.once('done',(_event,status)=>{if(!closing){store.event('download.finished',{name,status});emit();}});
  });
}
function selectTab(id){if(id!=='home'&&!tabs.has(id))throw new Error('Cilne nav atrasta');activeId=id;if(id!=='home')activeProject=tabs.get(id).project;layout();emit();if(id!=='home')tabs.get(id).view.webContents.focus();}
function attachKeys(wc){wc.on('before-input-event',(event,input)=>{if(input.type!=='keyDown')return;const key=input.key.toLowerCase();if(input.control||input.meta){if(['l','t','w','tab'].includes(key)){event.preventDefault();if(key==='w'){if(activeId!=='home')closeTab(activeId);}else if(key==='tab'){const ids=['home',...tabs.keys()];selectTab(ids[(ids.indexOf(activeId)+(input.shift?-1:1)+ids.length)%ids.length]);}else {if(key==='t')selectTab('home');win.webContents.focus();win.webContents.send('mnemos:focus-address');}}}if(key==='escape'&&currentTab()?.loading)currentTab().view.webContents.stop();});}
async function openTab({input,project=activeProject,private:incognito=false,scopedOpen=false},restoredId){
  store.project(project);
  const url=omniboxURL(input,urlOptions);if(!url)return;
  if(tabs.size>=24)throw new Error('Sasniegts 24 cilņu ierobežojums');
  const validRestoredId=typeof restoredId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(restoredId);
  const id=validRestoredId&&!tabs.has(restoredId)?restoredId:randomUUID();
  const partition=incognito?`private-${id}`:`persist:mnemos-project-${validateId(project)}`;
  const s=session.fromPartition(partition);configureWebSession(s);
  const view=new WebContentsView({webPreferences:{...WEB_PREFERENCES,session:s}});
  const tab={id,project,private:incognito,url,title:new URL(url).hostname,loading:true,error:null,crashed:false,nativeNavigation:false,navigationEpoch:0,view};tabs.set(id,tab);
  win.contentView.addChildView(view);view.setBackgroundColor('#111416');
  const wc=view.webContents;attachKeys(wc);
  wc.once('destroyed',()=>closeTab(id));
  wc.setWindowOpenHandler(({url:popup})=>{try{validateWebURL(popup,urlOptions);void openTab({input:popup,project,private:incognito}).catch(report);}catch(error){report(error);}return {action:'deny'};});
  wc.on('will-navigate',(event,target)=>{try{validateWebURL(target,urlOptions);}catch(error){event.preventDefault();report(error);}});
  wc.on('will-redirect',(event,target)=>{try{validateWebURL(target,urlOptions);}catch(error){event.preventDefault();report(error);}});
  wc.on('will-attach-webview',event=>event.preventDefault());
  wc.on('page-title-updated',(_event,title)=>{tab.title=title.slice(0,200);emit();});
  wc.on('did-start-navigation',(details,_url,_inPlace,isMainFrame)=>{
    if(details.isMainFrame??isMainFrame)tab.navigationEpoch++;
  });
  wc.on('did-start-loading',()=>{tab.loading=true;tab.error=null;emit();});
  wc.on('did-stop-loading',()=>{tab.loading=false;emit();});
  wc.on('did-finish-load',()=>{tab.crashed=false;emit();});
  const navigated=()=>{const target=wc.getURL();try{tab.url=validateWebURL(target,urlOptions);persistTabs();emit();}catch{}};
  wc.on('did-navigate',navigated);wc.on('did-navigate-in-page',navigated);
  wc.on('did-fail-load',(_e,code,description,_url,isMainFrame)=>{if(!isMainFrame||code===-3)return;tab.loading=false;tab.error=`${description} (${code})`;emit();});
  wc.on('render-process-gone',(_event,details)=>{tab.loading=false;tab.crashed=true;tab.error=`Process: ${details.reason}`;emit();});
  selectTab(id);persistTabs();
  if(scopedOpen){
    const destination=new URL(url);
    tab.nativeNavigation={origin:destination.origin};
    try { await waitForTabNavigation(wc,destination,()=>wc.loadURL(url)); }
    catch(error) { closeTab(id); throw error; }
    finally { tab.nativeNavigation=false; }
  }else void wc.loadURL(url).catch(error=>{tab.error=String(error.message).slice(0,250);emit();});
  return {id};
}
function detachTab({view}){
  if(win&&!win.isDestroyed())win.contentView.removeChildView(view);
  const wc=view.webContents;
  if(wc&&!wc.isDestroyed())wc.close();
}
function closeTab(id){
  const tab=tabs.get(id);if(!tab)return;
  tabs.delete(id);
  if(activeId===id)activeId='home';
  detachTab(tab);
  persistTabs();layout();emit();
}
function browserTabStatus(tab) {
  return {tabId:tab.id,readiness:tab.crashed?'CRASHED':tab.loading?'LOADING':tab.error?'FAILED':'READY'};
}

function getLifecycleTarget(id,action) {
  const tab=tabs.get(id),wc=tab?.view.webContents;
  if(!tab||tab.private||!wc||wc.isDestroyed())throw new Error('TAB_NOT_ACCESSIBLE');
  const url=new URL(wc.getURL()||tab.url);
  if(url.origin!==action.expectedOrigin||url.pathname!==action.expectedPath)
    throw new Error('TAB_PAGE_CHANGED');
  return {tab,wc,url};
}

function waitForTabNavigation(wc,destination,start) {
  return new Promise((resolve,reject)=>{
    let settled=false,began=false;
    function finish(error,url) {
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      for(const [name,handler] of Object.entries(listeners))wc.removeListener(name,handler);
      if(error)reject(error);else resolve(url);
    }
    function complete() {
      try {
        if(!began)return;
        const url=new URL(wc.getURL());
        if(url.origin!==destination.origin)throw new Error('NAVIGATION_SCOPE_DENIED');
        finish(null,url.origin+url.pathname);
      } catch(error) { finish(error); }
    }
    function checkOrigin(event,legacyUrl) {
      if(event.isMainFrame===false)return;
      try { if(new URL(event.url??legacyUrl).origin===destination.origin)return; } catch {}
      event.preventDefault();
      finish(new Error('NAVIGATION_SCOPE_DENIED'));
    }
    const listeners={
      'did-start-navigation':(details,legacyUrl,_inPlace,isMainFrame)=>{
        if(!(details.isMainFrame??isMainFrame))return;
        if(began||new URL(details.url??legacyUrl).href!==destination.href){
          finish(new Error('NAVIGATION_REPLACED'));
          return;
        }
        began=true;
      },
      'will-navigate':checkOrigin,
      'will-redirect':checkOrigin,
      'did-finish-load':complete,
      'did-navigate-in-page':(_event,_url,isMainFrame)=>{if(isMainFrame)complete();},
      'did-fail-load':(_event,_code,_description,_url,isMainFrame)=>{
        if(isMainFrame)finish(new Error('NAVIGATION_FAILED'));
      },
      'render-process-gone':()=>finish(new Error('TAB_RENDERER_CRASHED')),
      destroyed:()=>finish(new Error('TAB_NOT_ACCESSIBLE'))
    };
    for(const [name,handler] of Object.entries(listeners))wc.on(name,handler);
    const timer=setTimeout(()=>{
      finish(new Error('NAVIGATION_TIMEOUT'));
      if(!wc.isDestroyed())wc.stop();
    },8000);
    try { Promise.resolve(start()).catch(()=>finish(new Error('NAVIGATION_FAILED'))); }
    catch { finish(new Error('NAVIGATION_FAILED')); }
  });
}

const LIFECYCLE_LABELS={
  'tab.navigate':'atvērt adresi',
  'tab.back':'atgriezties iepriekšējā lapā',
  'tab.forward':'pāriet uz nākamo lapu',
  'tab.reload':'pārlādēt lapu',
  'tab.close':'aizvērt cilni',
  'tab.recover':'atjaunot cilni'
};

async function performTabLifecycle(id,action) {
  const {tab,wc,url}=getLifecycleTarget(id,action);
  if(action.operation==='tab.status')return browserTabStatus(tab);
  if(tab.nativeNavigation||tab.loading||wc.isLoading())throw new Error('TAB_BUSY');
  if(tab.crashed&&!['tab.recover','tab.close'].includes(action.operation))throw new Error('TAB_RENDERER_CRASHED');

  let destination=url, start, historyMatches=()=>true;
  if(action.operation==='tab.navigate'){
    if(typeof action.url!=='string'||action.url.length>4096)throw new Error('INVALID_NAVIGATION_URL');
    try { destination=new URL(validateWebURL(action.url,urlOptions)); }
    catch { throw new Error('INVALID_NAVIGATION_URL'); }
    start=()=>wc.loadURL(destination.href);
  }else if(action.operation==='tab.back'||action.operation==='tab.forward'){
    const history=wc.navigationHistory,back=action.operation==='tab.back';
    if(!(back?history.canGoBack():history.canGoForward()))throw new Error('TAB_HISTORY_UNAVAILABLE');
    const activeIndex=history.getActiveIndex(),index=activeIndex+(back?-1:1);
    destination=new URL(history.getEntryAtIndex(index).url);
    historyMatches=()=>history.getActiveIndex()===activeIndex&&history.getEntryAtIndex(index)?.url===destination.href;
    start=()=>history.goToIndex(index);
  }else if(action.operation==='tab.recover'){
    if(!tab.crashed)throw new Error('TAB_RENDERER_HEALTHY');
    start=()=>wc.loadURL(destination.href);
  }else if(action.operation==='tab.reload'){
    start=()=>wc.reload();
  }
  if(destination.origin!==action.expectedOrigin)throw new Error('NAVIGATION_SCOPE_DENIED');

  const signal=AbortSignal.timeout(20000);
  const response=await dialog.showMessageBox(win,{
    type:'question',title:'MNEMOS Browser · aģenta darbība',
    message:'Vai atļaut aģentam '+LIFECYCLE_LABELS[action.operation]+'?',
    detail:destination.href,buttons:['Noraidīt','Atļaut'],defaultId:0,cancelId:0,signal
  });
  if(signal.aborted||!bridge?.enabled||closing)throw new Error('BROWSER_COMMAND_CANCELLED');
  if(response.response!==1)throw new Error('USER_DECLINED');
  const current=getLifecycleTarget(id,action);
  if(current.wc!==wc||current.url.href!==url.href||!historyMatches())throw new Error('TAB_PAGE_CHANGED');
  if(tab.nativeNavigation||tab.loading||wc.isLoading())throw new Error('TAB_BUSY');
  if(action.operation==='tab.close'){
    closeTab(id);
    return {tabId:id,readiness:'CLOSED'};
  }
  if(tab.crashed!==(action.operation==='tab.recover'))throw new Error('TAB_PAGE_CHANGED');
  tab.nativeNavigation={origin:destination.origin};
  try {
    const url=await waitForTabNavigation(wc,destination,start);
    return {tabId:id,readiness:'READY',url};
  } finally { tab.nativeNavigation=false; }
}

async function refresh(){
  if(refreshing)return;refreshing=true;
  try{[coreState,models]=await Promise.all([core.refresh(),ollama.models().catch(()=>[])]);emit();}finally{refreshing=false;}
}

function handoffTarget(){
  const eligible=[...tabs.values()].filter(t=>!t.private&&!t.loading&&
    !t.view.webContents.isDestroyed()&&perplexityAllowedUrl(t.view.webContents.getURL(),fixtureOrigin));
  return eligible.find(t=>t.project===activeProject)??eligible[0]??null;
}
async function previewPerplexityHandoff(){
  const tab=handoffTarget();
  if(!tab)throw new Error('Atver Perplexity cilni MNEMOS Browser un mēģini vēlreiz.');
  await refresh();
  const body=buildPerplexityHandoff({core:coreState,workspace:store.snapshot(),projectId:activeProject});
  const nonce=randomUUID();
  pendingPerplexityHandoff={nonce,tabId:tab.id,projectId:activeProject,body,createdAt:Date.now()};
  return {nonce,preview:body,tab:tab.title.slice(0,140),characters:body.length,autoSend:false};
}
async function insertPerplexityHandoff({nonce}={}){
  const request=pendingPerplexityHandoff;
  pendingPerplexityHandoff=null; // one-shot even on failure
  if(!request||nonce!==request.nonce||Date.now()-request.createdAt>120000)
    throw new Error('Konteksta priekšskatījums ir novecojis. Izveido to no jauna.');
  const tab=tabs.get(request.tabId);
  if(!tab||tab.private||tab.loading||tab.view.webContents.isDestroyed()||request.projectId!==activeProject||
    !perplexityAllowedUrl(tab.view.webContents.getURL(),fixtureOrigin))
    throw new Error('Perplexity cilne ir mainījusies. Atkārto priekšskatījumu.');
  selectTab(tab.id); // Browser owns the active tab; only inserts a draft.
  const wc=tab.view.webContents;
  const focused=await wc.executeJavaScript(focusEmptyPerplexityComposer,true);
  if(!focused?.ok)throw new Error(focused?.error??'PERPLEXITY_COMPOSER_NOT_AVAILABLE');
  if(!perplexityAllowedUrl(wc.getURL(),fixtureOrigin))throw new Error('Perplexity cilne ir novirzīta.');
  wc.insertText(request.body);
  await new Promise(resolve=>setTimeout(resolve,170));
  const inserted=await wc.executeJavaScript(
    "(()=>{const e=document.activeElement;return !!e&&((e.value??e.innerText??'').includes('MNEMOS_CONTEXT_JSON:'));})()",true);
  if(!inserted)throw new Error('PERPLEXITY_DRAFT_INSERT_UNCONFIRMED');
  return {ok:true,tabId:tab.id,characters:request.body.length,sent:false,
    instruction:'Konteksts ir tikai Perplexity uzvednes melnrakstā. Pārskati un pats nosūti.'};
}
function configuredMcpEndpoint(){
  if(testMode)return null;
  try{const origin=connectorOrigin();return origin?origin+'/mcp':null;}catch{return null;}
}
async function resolveMcpCredential(reference){
  const {WindowsDpapiSecretStore}=await import('../../../packages/core/src/providers/credential-store.mjs');
  const storage=new WindowsDpapiSecretStore({root:connectorPaths().security});
  const value=(await storage.resolve(reference))?.trim();
  if(!value)throw new Error('MNEMOS_CONNECTOR_CREDENTIAL_UNAVAILABLE');
  return value;
}
async function preparePerplexityMcp(){
  if(testMode)throw new Error('PERPLEXITY_MCP_LIVE_ONLY');
  const endpoint=requireConnectorOrigin()+'/mcp';
  const consent=await dialog.showMessageBox(win,{
    type:'question',title:'MNEMOS → Perplexity Pro',
    message:'Pievienot tikai lasāmo MNEMOS MCP savienotāju?',
    detail:'Tiks atvērti Perplexity spraudņu iestatījumi. MNEMOS piekļuves atslēga uz 2 minūtēm tiks ievietota Windows starpliktuvē, lai to ielīmētu Perplexity API Key laukā.\n\nSavienotājam ir 19 rīki, tostarp vadība MNEMOS Browser ielogotajās cilnēs un CV failu pievienošana ar paša lietotāja faila izvēli. Pārlūkošana un formas melnraksta aizpildīšana notiek bez apstiprinājuma. Formas nosūtīšanai tavā vārdā nepieciešams apstiprinājums; failus izvēlies pats Windows dialogā. Netiek atklātas paroles, pārlūka sīkdatnes vai operatora komandu izpilde.',
    buttons:['Atcelt','Turpināt'],defaultId:0,cancelId:0
  });
  if(consent.response!==1)return {cancelled:true};
  const key=await resolveMcpCredential('vault:dpapi.perplexity-remote-key');
  const config=JSON.parse(await readFile(connectorPaths().credential,'utf8'));
  if(createHash('sha256').update(key).digest('hex')!==config.sha256)
    throw new Error('PERPLEXITY_MCP_KEY_MISMATCH');
  const response=await fetch(endpoint,{method:'POST',headers:{
    'authorization':'Bearer '+key,'content-type':'application/json',
    'accept':'application/json, text/event-stream'
  },body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',
    params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'mnemos-browser-mcp-setup',version:'1.0'}}}),
    signal:AbortSignal.timeout(8000),redirect:'error'});
  const reply=await response.text();
  if(!response.ok||!reply.includes('mnemos-perplexity-readonly'))
    throw new Error('PERPLEXITY_MCP_ENDPOINT_NOT_READY');
  clipboard.writeText(key);
  const timer=setTimeout(()=>{if(clipboard.readText()===key)clipboard.clear();},120000);
  timer.unref?.();
  const existing=[...tabs.values()].find(tab=>!tab.private&&
    tab.url.startsWith('https://www.perplexity.ai/computer/plugins'));
  if(existing)selectTab(existing.id);
  else await openTab({input:'https://www.perplexity.ai/computer/plugins'});
  return {ready:true,endpoint,auth:'API Key',transport:'Streamable HTTP',
    clipboard:'secure-key-copied-for-120-seconds',autoSubmitted:false,
    instructions:'Perplexity → Pievienot pielāgotu → Savienotājs → Remote; Name: MNEMOS; URL: '+endpoint+
      '; Authentication: API Key (ielīmē Ctrl+V); Transport: Streamable HTTP. Apstiprini un pievieno savienotāju.'};
}
async function copyPerplexityMcpKey(){
  if(testMode)throw new Error('PERPLEXITY_MCP_LIVE_ONLY');
  requireConnectorOrigin();
  const answer=await dialog.showMessageBox(win,{
    type:'question',title:'MNEMOS MCP piekļuves atslēga',
    message:'Kopēt Perplexity MCP API atslēgu starpliktuvē?',
    detail:'Atslēga 120 sekundes būs pieejama Windows starpliktuvē; tā tiks automātiski notīrīta, ja pa šo laiku neiekopēsi citu saturu.',
    buttons:['Atcelt','Kopēt'],defaultId:0,cancelId:0
  });
  if(answer.response!==1)return {cancelled:true};
  const key=await resolveMcpCredential('vault:dpapi.perplexity-remote-key');
  const config=JSON.parse(await readFile(connectorPaths().credential,'utf8'));
  if(createHash('sha256').update(key).digest('hex')!==config.sha256)throw new Error('API_KEY_HASH_MISMATCH');
  clipboard.writeText(key);
  const timer=setTimeout(()=>{if(clipboard.readText()===key)clipboard.clear();},120000);
  timer.unref?.();
  return {copied:true,expiresInSeconds:120};
}
async function geminiMcpDetails(){
  if(testMode)return {ready:false,testMode:true};
  const origin=connectorOrigin();
  if(!origin)return {ready:false,reason:'MNEMOS_CONNECTOR_PUBLIC_ORIGIN_REQUIRED'};
  const config=JSON.parse(await readFile(connectorPaths().geminiConfig,'utf8'));
  if(!/^mnemos-gemini-[a-f0-9]{32}$/.test(config.clientId))throw new Error('INVALID_GEMINI_CLIENT');
  const endpoint=origin+'/mcp';
  const response=await fetch(origin+'/.well-known/oauth-authorization-server',{
    signal:AbortSignal.timeout(8000),redirect:'error'});
  const meta=await response.json();
  if(!response.ok||meta.issuer!==origin)
    throw new Error('GEMINI_OAUTH_ENDPOINT_UNAVAILABLE');
  return {ready:true,clientId:config.clientId,endpoint,transport:'Streamable HTTP',
    oauth:'Authorization Code + PKCE S256',scope:'mnemos',autoSubmit:false};
}
async function copyGeminiConsentKey(){
  if(testMode)throw new Error('GEMINI_OAUTH_LIVE_ONLY');
  const origin=requireConnectorOrigin();
  const approved=await dialog.showMessageBox(win,{
    type:'question',title:'Gemini → MNEMOS OAuth',
    message:'Kopēt vienreiz ievadāmo MNEMOS piekrišanas atslēgu?',
    detail:'Šis ir SLEPENS īpašnieka autentifikācijas kods. Ievadi to tikai MNEMOS autorizācijas logā adresē '+origin+'/oauth/authorize, NEKAD Gemini čatā. Kods 120 sekundes paliks Windows starpliktuvē.',
    buttons:['Atcelt','Kopēt uz 120 sekundēm'],defaultId:0,cancelId:0
  });
  if(approved.response!==1)return {cancelled:true};
  const value=await resolveMcpCredential('vault:dpapi.gemini-oauth-consent-key');
  const config=JSON.parse(await readFile(connectorPaths().geminiConfig,'utf8'));
  if(createHash('sha256').update(value).digest('hex')!==config.consentSha)
    throw new Error('GEMINI_CONSENT_KEY_MISMATCH');
  clipboard.writeText(value);
  const timer=setTimeout(()=>{if(clipboard.readText()===value)clipboard.clear();},120000);
  timer.unref?.();
  return {copied:true,expiresInSeconds:120,rawValueExposed:false};
}

// Perplexity-originated proposals are UNTRUSTED. The only write path is this
// local Electron main process, with a fresh native human confirmation per item.
let collaborationQueue=null;
async function queueForReview(){
  if(collaborationQueue)return collaborationQueue;
  const module=await import('../connectors/perplexity/collaboration-store.mjs');
  collaborationQueue=new module.CollaborationStore(testMode?path.join(profile,'collaboration-fixture.sqlite'):undefined);
  return collaborationQueue;
}
async function collaborationList(){
  const q=await queueForReview();
  return {pending:q.pending(20),results:q.pendingResults(20),recent:q.all(12)};
}
async function collaborationDecision(input){
  const id=validateId(input.id),choice=input.choice;
  if(!['approve','reject','accept-result','reject-result'].includes(choice))
    throw new Error('UNKNOWN_COLLABORATION_ACTION');
  const q=await queueForReview();
  const isResult=choice.endsWith('-result'),record=isResult?q.result(id):q.get(id);
  if(!record)throw new Error('COLLABORATION_ITEM_NOT_FOUND');
  const affirmative=choice==='approve'||choice==='accept-result';
  const projectName=store.project(activeProject).name;
  const answer=await dialog.showMessageBox(win,{
    type:'question',title:'Perplexity → MNEMOS · īpašnieka apstiprinājums',
    message:(affirmative?'Apstiprināt':'Noraidīt')+(isResult?' ārēja modeļa rezultātu?':' Perplexity priekšlikumu?'),
    detail:(isResult?record.summary:record.title).slice(0,180)+'\n\n'+
      (isResult?record.details:record.details).slice(0,1400)+
      '\n\nŠis saturs ir NEUZTICAMS. Projekts: '+projectName+
      (isResult?'\nPieņemot, teksts tiks saglabāts projekta atmiņā ar ārēju izcelsmi.':
        record.kind==='task'?'\nPieņemot, tiks izveidots tikai lokāls MNEMOS Browser uzdevums. Izpilde netiks palaista.':
        '\nPieņemot, pieprasījums tiks nosūtīts ChatGPT caur MNEMOS Frontier Bus.'),
    buttons:['Atcelt',affirmative?'Apstiprināt':'Noraidīt'],
    defaultId:0,cancelId:0
  });
  if(answer.response!==1)return {cancelled:true};
  if(choice==='reject')return {rejected:q.reject(id)};
  if(choice==='reject-result')return {rejected:q.rejectResult(id)};
  if(choice==='accept-result'){
    const claimed=q.claimResult(id);
    // Never mark untrusted model output as validated MNEMOS fact.
    const created=store.addItem({project:activeProject,kind:'memory',
      source:'perplexity:untrusted:'+claimed.proposalId,
      title:'[ĀRĒJS REZULTĀTS — NEPĀRBAUDĪTS]\n'+claimed.summary+'\n\n'+claimed.details});
    q.finishResult(id,created.id);
    emit();return {accepted:true,localItemId:created.id,status:'ACCEPTED'};
  }
  const proposal=q.get(id);
  if(proposal.kind==='consultation'&&(!bridge?.enabled||!bridge?.connected||!bridge?.verifier))
    throw new Error('CHATGPT_FRONTIER_BRIDGE_NOT_CONNECTED');
  q.beginApproval(id);
  if(proposal.kind==='task'){
    const source='perplexity:proposal:'+proposal.id;
    const found=store.snapshot().items.find(item=>item.source===source);
    const task=found??store.addItem({project:activeProject,kind:'task',
      title:'[Perplexity · priekšlikums]\n'+proposal.title+'\n\n'+proposal.details,
      source});
    const approved=q.finishApproval(id,{localItemId:task.id});
    emit();return {approved:true,kind:'task',localItemId:task.id,status:approved.status,executed:false};
  }
  // Only one explicitly trusted target is allowed. No arbitrary session ID from Perplexity.
  const result=await bridge.request('/api/frontier-sessions/send',{method:'POST',data:{
    from:bridge.sessionId,to:OWNER_SESSION,verifier:bridge.verifier,
    kind:'consultation_request',expectsReply:true,
    body:JSON.stringify({schema:'mnemos.collaboration.consultation.v1',
      proposalId:proposal.id,source:'perplexity-pro',trust:'UNTRUSTED_EXTERNAL_INPUT',
      title:proposal.title,question:proposal.details,
      approval:'OWNER_APPROVED_TO_FORWARD_NOT_TO_EXECUTE'}),
    metadata:{idempotencyKey:'perplexity-owner-approved-'+proposal.id}
  }});
  if(!result.messageId)throw new Error('CORE_FRONTIER_SEND_UNCONFIRMED');
  const approved=q.finishApproval(id,{busMessageId:result.messageId});
  emit();return {approved:true,kind:'consultation',messageId:result.messageId,status:approved.status,executed:false};
}
async function prepareCollaborationDrafts(input={}){
  const projectId=activeProject;
  const memoryIds=input.memoryIds??[];
  // Project ownership, privacy, provider and duplicate-target checks precede any page access.
  const memories=store.resolveContext(projectId,memoryIds);
  const plan=collaborationPlan({
    tabIds:input.tabIds,memoryIds,activeProject:projectId,
    tabs:[...tabs.values()],memories
  });
  const draft=coordinationDraft({prompt:input.prompt,memories});
  const run=coordinationJournal.begin(projectId,{prompt:input.prompt,targets:plan.targets,contextIds:memoryIds});
  const previousTab=activeId,results=[];
  try{
    for(const target of plan.targets){
      try{
        const tab=tabs.get(target.id);
        if(activeProject!==projectId||!tab||tab.project!==projectId||tab.private||tab.loading||
           tab.view.webContents.isDestroyed())throw new Error('COLLABORATION_TAB_CHANGED');
        const wc=tab.view.webContents,actual=wc.getURL();
        const url=new URL(actual);
        if(collaborationModel(actual)!==target.model||url.origin!==target.origin||
           url.pathname!==new URL(tab.url).pathname)
          throw new Error('COLLABORATION_TAB_NAVIGATED');
        const actionScope={expectedOrigin:url.origin,expectedPath:url.pathname};
        const described=await performBrowserAction(wc,{
          operation:'tab.describe',...actionScope,fieldOffset:0,buttonOffset:0,limit:64
        });
        if(activeProject!==projectId)throw new Error('COLLABORATION_PROJECT_CHANGED');
        const composer=collaborationComposer(described,target.model);
        const baseline=await wc.executeJavaScript(modelAnswerExtractionScript(target.model),true);
        const baselineHash=baseline?.answer?createHash('sha256').update(baseline.answer).digest('hex'):null;
        // Focus one visible authenticated Electron tab, insert only a draft.
        selectTab(tab.id);
        const result=await performBrowserAction(wc,{
          operation:'tab.fill',...actionScope,...composer,value:draft
        });
        if(result.filled!==true||result.submitted!==false)
          throw new Error('COLLABORATION_DRAFT_NOT_VERIFIED');
        results.push({tabId:tab.id,model:target.model,ok:true,
          characters:result.characters,baselineHash,
          draftHash:createHash('sha256').update(draft).digest('hex'),submitted:false});
      }catch(error){
        results.push({tabId:target.id,model:target.model,ok:false,
          error:String(error?.message??error).slice(0,180),submitted:false});
      }
    }
  }finally{
    if(activeProject===projectId){
      if(previousTab==='home'||tabs.has(previousTab))selectTab(previousTab);
      else selectTab('home');
    }
  }
  const recorded=coordinationJournal.drafts(projectId,run.id,results);
  emit();return {project:projectId,runId:run.id,status:recorded.status,attempted:plan.targets.length,
    prepared:results.filter(r=>r.ok).length,submitted:false,
    contextCount:memories.length,results};
}

async function collectCollaborationSnapshots(input={}){
  const projectId=input.automatic===true?input.projectId:activeProject;
  const run=coordinationJournal.get(projectId,input.runId);
  const isAuto=input.automatic===true,jobKey=projectId+':'+run.id;
  if(activeCoordinationPolls.has(jobKey))
    throw new Error('COORDINATION_COLLECTION_ALREADY_RUNNING');
  const canRecover=!isAuto&&run.targets.some(t=>t.origin&&
    run.submissions?.some(s=>s.tabId===t.id&&s.submitted===true));
  if(!canRecover&&!run.targets.some(t=>tabs.has(t.id)&&tabs.get(t.id).project===projectId))
    throw new Error('COORDINATION_RUN_TABS_EXPIRED_REPREPARE');
  if(isAuto){
    if(!run.submissions?.length)throw new Error('COORDINATION_MONITOR_REQUIRES_SUBMISSION');
    coordinationJournal.beginMonitoring(projectId,run.id);
  }
  activeCoordinationPolls.add(jobKey);
  try{
    const snapshots=await Promise.all(run.targets.map(async target=>{
      let metadata={title:'',url:''};
      const draft=run.drafts?.find(d=>d.tabId===target.id);
      const sent=run.submissions?.find(s=>s.tabId===target.id);
      if(isAuto&&!sent?.submitted)return {tabId:target.id,model:target.model,ok:false,
        error:'PROMPT_NOT_SUBMITTED_FOR_MODEL',monitorState:'NOT_SUBMITTED'};
      const read=async(tabId)=>{
        const tab=tabs.get(tabId),wc=tab?.view.webContents;
        if(!tab||tab.project!==projectId||tab.private||tab.loading||!wc||wc.isDestroyed())
          throw new Error('COLLABORATION_TAB_CHANGED');
        const before=wc.getURL(),url=new URL(before);
        // Legacy runs have no persisted origin; new runs are bound to the exact
        // originally prepared origin. Navigation within the same chat site is fine.
        if(collaborationModel(before)!==target.model||
           (target.origin&&url.origin!==target.origin))
          throw new Error('COLLABORATION_ORIGIN_CHANGED');
        // Rendered, user-visible text only. Do not read hidden inputs, cookies or JS state.
        const data=await wc.executeJavaScript(modelAnswerExtractionScript(target.model,{
          prompt:run.prompt
        }),true);
        if(wc.isDestroyed()||wc.getURL()!==before)
          throw new Error('COLLABORATION_PAGE_CHANGED_DURING_READ');
        return {data,metadata:{title:String(data.title||'').slice(0,180),
          url:url.origin+url.pathname}};
      };
      try{
        let data,monitorState='ON_DEMAND_SNAPSHOT',note='';
        if(isAuto){
          const polled=await pollResponse({
            sample:async()=>{
              const observation=await read(target.id);
              metadata=observation.metadata;
              return observation.data;
            },
            baselineHash:draft?.baselineHash,
            cancelled:()=>closing||!tabs.has(target.id),
            onSample:({attempt,assessment})=>{
              if(attempt===1||attempt%8===0){
                coordinationJournal.updateMonitoring(projectId,run.id,target.id,{
                  state:assessment.ready?'STABILIZING':'WAITING',
                  reason:assessment.reason,attempts:attempt
                });
                emit();
              }
            }
          });
          data=polled.sample?.data||{};
          monitorState=polled.state;
          note=polled.sample?.assessment?.reason||'NO_RESPONSE';
          coordinationJournal.updateMonitoring(projectId,run.id,target.id,{
            state:monitorState,reason:note,attempts:polled.attempts
          });
        }else if(!tabs.has(target.id)&&sent?.submitted===true&&target.origin){
          ({data,metadata}=await recoverCollaborationSample({
            target,project:projectId,tabs:[...tabs.values()],read
          }));
          monitorState='RECOVERED_AFTER_RESTART';
        }else{
          ({data,metadata}=await read(target.id));
        }
        const priorAnswer=draft?.baselineHash;
        const answerHash=data.answer?snapshotDigest(data.answer):null;
        const unchanged=Boolean(priorAnswer&&answerHash===priorAnswer);
        const usable=data.kind==='ASSISTANT_DOM_CANDIDATE'&&
          data.promptFound===true&&!unchanged&&!data.busy;
        const kind=usable?'ASSISTANT_DOM_CANDIDATE':
          data.kind==='PAGE_TEXT_AFTER_PROMPT'?'PAGE_TEXT_AFTER_PROMPT':'PAGE_TEXT_ONLY';
        return {tabId:target.id,model:target.model,ok:true,
          title:metadata.title,url:metadata.url,
          text:String(data.text||'').slice(-32768),
          answer:usable?String(data.answer||'').slice(-32768):'',
          kind,answerChars:Number(data.answerChars)||0,
          bodyChars:Number(data.bodyChars)||0,
          truncated:data.bodyTruncated===true||data.answerTruncated===true,
          note:unchanged?'PREVIOUS_ANSWER_UNCHANGED':note,
          monitorState,unverified:true,readAt:new Date().toISOString()};
      }catch(error){
        return {tabId:target.id,model:target.model,ok:false,
          error:String(error?.message??error).slice(0,160),
          monitorState:isAuto?'READ_ERROR':'ON_DEMAND_ERROR'};
      }
    }));
    if(canRecover&&snapshots.every(s=>!s.ok))
      throw new Error(snapshots.map(s=>s.model+': '+s.error).join(', '));
    const saved=coordinationJournal.captured(projectId,run.id,snapshots);
    emit();
    return {project:projectId,runId:run.id,sent:false,persisted:true,
      type:'UNVERIFIED_WEB_OBSERVATIONS',snapshots:saved.snapshots,
      comparison:saved.comparison,automatic:isAuto};
  }finally{activeCoordinationPolls.delete(jobKey);}
}

async function submitCoordinationRun(input={}){
  // External user-authenticated sending is never allowed in test-mode fixtures.
  if(testMode)throw new Error('COORDINATION_EXTERNAL_SUBMISSION_LIVE_ONLY');
  const projectId=activeProject,run=coordinationJournal.get(projectId,input.runId);
  if(run.submissions?.length)throw new Error('COORDINATION_ALREADY_SUBMISSION_ATTEMPTED');
  if(!run.drafts?.length)throw new Error('COORDINATION_NOT_PREPARED');
  const candidates=run.drafts.filter(d=>d.ok);
  if(!candidates.length)throw new Error('COORDINATION_NO_READY_DRAFTS');
  const contexts=store.resolveContext(projectId,run.contextIds);
  const expectedDraft=coordinationDraft({prompt:run.prompt,memories:contexts});
  const expectedHash=createHash('sha256').update(expectedDraft).digest('hex');
  const preflight=[];
  const checked=(target,checkValue=true)=>async()=>{
    const tab=tabs.get(target.tabId);
    if(activeProject!==projectId||!tab||tab.private||tab.loading||
       tab.project!==projectId||tab.view.webContents.isDestroyed())
      throw new Error('COORDINATION_SUBMISSION_TAB_NOT_ACCESSIBLE');
    const wc=tab.view.webContents,actual=wc.getURL(),url=new URL(actual);
    if(collaborationModel(actual)!==target.model)throw new Error('COORDINATION_SUBMISSION_ORIGIN_CHANGED');
    const scope={expectedOrigin:url.origin,expectedPath:url.pathname};
    const desc=await performBrowserAction(wc,{operation:'tab.describe',...scope,limit:64});
    const composer=collaborationComposerWithState(desc,target.model,true);
    const actualValue=await wc.executeJavaScript(preparedDraftTextScript(composer),true);
    if(checkValue&&createHash('sha256').update(actualValue.text).digest('hex')!==expectedHash)
      throw new Error('COORDINATION_DRAFT_CHANGED_AFTER_PREPARATION');
    let buttons=[...desc.buttons],offset=desc.nextButtonOffset;
    for(let n=0;offset!==null&&n<4;n++){
      const page=await performBrowserAction(wc,{operation:'tab.describe',...scope,
        fieldOffset:0,buttonOffset:offset,limit:64});
      buttons.push(...page.buttons);offset=page.nextButtonOffset;
    }
    const sendButton=collaborationSendButton({buttons},target.model);
    if(wc.isDestroyed()||wc.getURL()!==actual)throw new Error('COORDINATION_SUBMISSION_PAGE_CHANGED');
    return {tab,wc,scope,sendButton};
  };
  for(const draft of candidates){
    if(draft.draftHash!==expectedHash)throw new Error('COORDINATION_PREPARED_CONTENT_HASH_CHANGED');
    const target={tabId:draft.tabId,model:draft.model};
    const ready=await checked(target)();
    preflight.push({target,...ready});
  }
  if(!preflight.length)throw new Error('COORDINATION_NOTHING_TO_SEND');
  // The explicit 'Send to selected AI models' click in the privileged shell
  // already authorizes this bounded task. A second modal would be redundant.
  // Re-check the project and tabs before any external model prompt.
  if(activeProject!==projectId||preflight.some(p=>
    tabs.get(p.target.tabId)?.project!==projectId))
    return {cancelled:true,submitted:false};
  // Durable intent BEFORE any click: a crash/restart must never cause an auto-retry.
  coordinationJournal.authorizeSubmission(projectId,run.id,preflight.map(x=>x.target.tabId));
  const results=[];
  for(const item of preflight){
    let submitted=false,error=null,editorCleared=null;
    try{
      const refreshed=await checked(item.target)();
      // Electron native input only reaches an actively focused BrowserWindow.
      win.focus();selectTab(item.target.tabId);
      if(!win.isFocused())throw new Error('COORDINATION_SEND_WINDOW_NOT_FOCUSED');
      const outcome=await performBrowserAction(refreshed.wc,{
        operation:'tab.submit',...refreshed.scope,...refreshed.sendButton
      });
      submitted=outcome.submitted===true&&outcome.triggered===true;
      editorCleared=outcome.editorCleared??null;
      if(!submitted)throw new Error('COORDINATION_SUBMIT_NOT_TRIGGERED');
    }catch(e){error=String(e?.message??e).slice(0,160);}
    coordinationJournal.completeSubmission(projectId,run.id,item.target.tabId,{submitted,error,editorCleared});
    results.push({tabId:item.target.tabId,model:item.target.model,triggered:submitted,editorCleared,
      ...(submitted?{}:{error})});
  }
  emit();
  if(results.some(r=>r.triggered)){
    // All future activity is READ-ONLY. Do not resend if the service is slow,
    // the page navigates or the application restarts.
    setTimeout(()=>{
      if(closing)return;
      void collectCollaborationSnapshots({
        automatic:true,projectId,runId:run.id
      }).catch(error=>{
        try{coordinationJournal.failMonitoring(projectId,run.id,error);emit();}
        catch(failure){report(failure);}
        report(error);
      });
    },1200).unref?.();
  }
  return {cancelled:false,runId:run.id,confirmed:true,
    triggered:results.filter(r=>r.triggered).length,attempted:results.length,
    acceptedBySites:false,automaticCollectionScheduled:results.some(r=>r.triggered),
    results};
}

function startCouncil(input={}){
  const plan=collaborationPlan({tabIds:input.tabIds,memoryIds:[],
    activeProject,tabs:[...tabs.values()],memories:[]});
  return councilRunner.start({project:activeProject,targets:plan.targets,
    seed:input.seed||'Iepazīstamies un noskaidrojam, kā varam sadarboties.',
    maxTurns:Number(input.maxTurns??6),
    localManagerEnabled:input.localManagerEnabled===true});
}
function saveCoordinationReport(input={}){
  const projectId=activeProject,run=coordinationJournal.get(projectId,input.runId);
  if(!run.snapshots.length)throw new Error('COORDINATION_NOT_YET_CAPTURED');
  const source='browser:coordination:'+run.id;
  let existing=store.findMemoryBySource(projectId,source);
  if(existing)return {saved:true,duplicate:true,memoryId:existing.id};
  const report=formatUnverifiedCoordinationReport(run);
  const saved=store.addItem({project:projectId,kind:'memory',source,title:report});
  coordinationJournal.saved(projectId,run.id,saved.id);
  emit();return {saved:true,duplicate:false,memoryId:saved.id};
}

function commandTab({id}) {
  if(id===undefined)return currentTab();
  const tab=tabs.get(validateId(id));
  if(!tab)throw new Error('TAB_NOT_ACCESSIBLE');
  return tab;
}

const commands={
  snapshot:()=>state(),
  'core.workspace':()=>coreWorkspaceRead(),
  'core.chat.history':()=>({conversationId:store.get(CHAT_CONVERSATION_KEY,null),
    messages:store.get(CHAT_JOURNAL_KEY,[]).slice(-60),
    trust:'LOCAL_BROWSER_JOURNAL_NOT_CORE_MEMORY'}),
  'core.chat':p=>submitCoreChat(p),
  'observation.preview':p=>observations.preview(p.tabId),
  'observation.save':p=>observations.save(p.requestId),
  'observation.discard':p=>observations.discard(p.requestId),
  'observation.list':p=>observations.list(p.project,p.q),
  'observation.delete':p=>observations.delete(p.project,p.id),
  refresh:async()=>{await refresh();return state();},
  'tab.open':p=>openTab(p),
  'tab.select':p=>selectTab(validateId(p.id)),
  'tab.close':p=>closeTab(validateId(p.id)),
  'tab.navigate':p=>{const tab=commandTab(p);if(!tab)return openTab({input:text(p.input,4096)});const url=omniboxURL(p.input,urlOptions);if(url)void tab.view.webContents.loadURL(url).catch(report);},
  'tab.back':p=>{const n=commandTab(p)?.view.webContents.navigationHistory;if(n?.canGoBack())n.goBack();},
  'tab.forward':p=>{const n=commandTab(p)?.view.webContents.navigationHistory;if(n?.canGoForward())n.goForward();},
  'tab.reload':p=>{const t=commandTab(p);if(t){if(t.loading)t.view.webContents.stop();else t.view.webContents.reload();}},
  'project.create':p=>{const project=store.createProject(p.name);activeProject=project.id;activeId='home';section='workspace';layout();emit();return project;},
  'project.select':p=>{store.project(p.id);activeProject=p.id;activeId='home';layout();emit();},
  section:p=>{if(!['workspace','goals','memory','agents','bus','coordination','settings'].includes(p.name))throw new Error('Nezināma sadaļa');section=p.name;activeId='home';layout();emit();},
  'item.create':p=>{const row=store.addItem({project:activeProject,kind:p.kind,title:p.title});emit();return row;},
  'item.complete':p=>{store.completeItem(p.id,activeProject);emit();},
  'turn.submit':p=>turns.submit({key:p.key,project:activeProject,model:p.model,prompt:text(p.prompt,16000),contextIds:p.contextIds??[]}),
  'turn.cancel':p=>{const t=store.turn(p.id);if(!t||t.project!==activeProject)throw new Error('Pieprasījums nav atrasts šajā projektā');turns.cancel(validateId(p.id));},
  'turn.remember':p=>{const t=store.turn(p.id);if(!t||t.status!=='COMPLETED'||t.project!==activeProject)throw new Error('Nav pabeigtas atbildes šajā projektā');const row=store.addItem({project:activeProject,kind:'memory',title:t.output,source:`ollama:${t.model}:${t.id}`});emit();return row;},
  'provider.open':p=>{const provider=PROVIDERS.find(v=>v.id===p.id&&v.mode==='manual-web');if(!provider)throw new Error('Integrācija nav aktivizēta');return openTab({input:provider.url});},
  'bridge.enable':()=>bridge.setEnabled(true),
  'bridge.disable':()=>bridge.setEnabled(false),
  'perplexity.handoff.preview':()=>previewPerplexityHandoff(),
  'perplexity.handoff.insert':p=>insertPerplexityHandoff(p),
  'perplexity.mcp.prepare':()=>preparePerplexityMcp(),
  'perplexity.mcp.copyKey':()=>copyPerplexityMcpKey(),
  'perplexity.mcp.copyUrl':()=>{clipboard.writeText(requireConnectorOrigin()+'/mcp');return {copied:true,type:'mcp_url'};},
  'gemini.mcp.details':()=>geminiMcpDetails(),
  'gemini.mcp.copyUrl':()=>{clipboard.writeText(requireConnectorOrigin()+'/mcp');return {copied:true};},
  'gemini.mcp.copyClientId':async()=>{const d=await geminiMcpDetails();if(!d.ready)return d;clipboard.writeText(d.clientId);return {copied:true};},
  'gemini.mcp.copyConsent':()=>copyGeminiConsentKey(),
  'gemini.mcp.openSetup':()=>openTab({input:'https://gemini.google.com/customize/connectors'}),
  'collaboration.list':()=>collaborationList(),
  'collaboration.decide':p=>collaborationDecision(p),
  'coordination.prepare':p=>prepareCollaborationDrafts(p),
  'coordination.execute':p=>coordinationExecutor.execute(activeProject,p),
  'coordination.collect':p=>collectCollaborationSnapshots(p),
  'coordination.submit':p=>submitCoordinationRun(p),
  'coordination.list':()=>coordinationJournal.list(activeProject),
  'council.start':p=>startCouncil(p),
  'council.get':p=>councilRunner.get(activeProject,p?.id||null),
  'council.reconcile':()=>councilRunner.reconcile(activeProject),
  'council.stop':()=>councilRunner.stop(activeProject),
  'council.list':()=>councilRunner.list(activeProject),
  'coordination.get':p=>coordinationJournal.get(activeProject,p.runId),
  'coordination.report':p=>({text:formatUnverifiedCoordinationReport(coordinationJournal.get(activeProject,p.runId))}),
  'coordination.structured':p=>{const r=coordinationJournal.get(activeProject,p.runId);if(!r.synthesis)throw new Error('COORDINATION_SYNTHESIS_NOT_READY');return r.synthesis;},
  'coordination.copyStructured':p=>{const r=coordinationJournal.get(activeProject,p.runId);if(!r.synthesis)throw new Error('COORDINATION_SYNTHESIS_NOT_READY');const json=JSON.stringify(r.synthesis,null,2);clipboard.writeText(json);return {copied:true,characters:json.length};},
  'coordination.copyReport':p=>{const report=formatUnverifiedCoordinationReport(coordinationJournal.get(activeProject,p.runId));clipboard.writeText(report);return {copied:true,characters:report.length};},
  'coordination.saveReport':p=>saveCoordinationReport(p),
  'ui.reload':()=>{
    if(closing||!win||win.isDestroyed())throw new Error('UI_RELOAD_WINDOW_UNAVAILABLE');
    // Reload only the privileged shell. WebContentsView tabs, project partitions,
    // authentication cookies, persistent browser state and running jobs survive.
    // Defer until the caller receives its IPC acknowledgement.
    setTimeout(()=>{
      if(closing||!win||win.isDestroyed())return;
      try{win.webContents.reloadIgnoringCache();}
      catch(error){logRuntimeFault('shell-reload-failed',error);}
    },100);
    return {scheduled:true,tabCount:tabs.size};
  },
  'window.minimize':()=>win.minimize(),
  'window.maximize':()=>win.isMaximized()?win.unmaximize():win.maximize(),
  'window.close':()=>win.close(),
  'error.clear':()=>{lastError=null;emit();}
};
commands.overlay=p=>{overlay=p.visible===true;layout();if(overlay)win.webContents.focus();};
if(testMode)commands['diagnostics.testClosedStderr']=()=>{
  const error=Object.assign(new Error('write EPIPE from console.error synthetic test'),{code:'EPIPE'});
  process.stderr.emit('error',error);
  console.error('This synthetic error must not reach disconnected stderr');
  return {stderrProtected:brokenStdio.has('stderr')};
};
if(testMode)commands['diagnostics.testFault']=()=>{
  logRuntimeFault('test-diagnostic',new Error('TEST https://example.org/private?token=do-not-log'),'synthetic-only');
  return {written:true};
};
if(testMode)commands['coordination.testFixture']=()=>{
  // Isolated Electron test profile ONLY. No provider navigation, inference,
  // prompt insertion, browser submit, credentials or external requests.
  const projectId=activeProject,prompt='Fixture: assess MNEMOS Browser architecture';
  const sources=[
    {id:'fixture-chat',model:'ChatGPT',origin:'https://chatgpt.com'},
    {id:'fixture-gem',model:'Gemini',origin:'https://gemini.google.com'},
    {id:'fixture-perp',model:'Perplexity',origin:'https://www.perplexity.ai'}
  ];
  const row=coordinationJournal.begin(projectId,{prompt,targets:sources});
  const responseA='MNEMOS Browser must separate authenticated Chromium tabs from the persistent Core service. Every captured response must include explicit provenance. Never resend a model prompt automatically after an uncertain delivery.';
  const responseB='MNEMOS Browser must separate authenticated Chromium tabs from the persistent Core service. Every captured response must include explicit provenance. A durable task journal allows independent review of model-generated outputs.';
  const fallback='The web interface displays model responses alongside citations and user prompts. A durable task journal allows independent review of model-generated outputs.';
  const draftHash=createHash('sha256').update(prompt).digest('hex');
  coordinationJournal.drafts(projectId,row.id,sources.map(t=>({
    tabId:t.id,model:t.model,ok:true,characters:prompt.length,draftHash
  })));
  coordinationJournal.authorizeSubmission(projectId,row.id,sources.map(t=>t.id));
  for(const target of sources)
    coordinationJournal.completeSubmission(projectId,row.id,target.id,{submitted:true,editorCleared:true});
  coordinationJournal.beginMonitoring(projectId,row.id);
  const now=new Date().toISOString();
  const synth=coordinationJournal.captured(projectId,row.id,[
    {tabId:sources[0].id,model:'ChatGPT',ok:true,kind:'ASSISTANT_DOM_CANDIDATE',
      url:'https://chatgpt.com/c/fixture',title:'Fixture ChatGPT',answer:responseA,
      readAt:now,monitorState:'CANDIDATE_CAPTURED'},
    {tabId:sources[1].id,model:'Gemini',ok:true,kind:'ASSISTANT_DOM_CANDIDATE',
      url:'https://gemini.google.com/app/fixture',title:'Fixture Gemini',answer:responseB,
      readAt:now,monitorState:'CANDIDATE_CAPTURED'},
    {tabId:sources[2].id,model:'Perplexity',ok:true,kind:'PAGE_TEXT_AFTER_PROMPT',
      url:'https://www.perplexity.ai/session/fixture',title:'Fixture Perplexity',text:fallback,
      readAt:now,monitorState:'FALLBACK_CAPTURED'}
  ]);
  emit();return {runId:row.id,testFixture:true,synthesis:synth.synthesis};
};

if(!app.requestSingleInstanceLock()){app.quit();}else{
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
app.whenReady().then(async()=>{
try {
  await mkdir(profile,{recursive:true});
  protocol.handle('mnemos',async request=>{
    const u=new URL(request.url),file=u.pathname.slice(1)||'index.html';
    if(u.hostname!=='app'||!assets.has(file)||request.method!=='GET')return new Response('Not found',{status:404});
    const body=await readFile(path.join(root,'ui',file));
    return new Response(body,{headers:{'content-type':assetTypes[path.extname(file)],'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff','cache-control':'no-store, max-age=0'}});
  });
  store=new BrowserStore(path.join(profile,'workspace'));
  const previousCoreOrigin = store.get('coreBridge.origin', null);
  if ((previousCoreOrigin && previousCoreOrigin !== core.base) ||
      (!previousCoreOrigin && core.base !== defaultCoreOrigin && store.get('coreBridge.verifier', null))) {
    throw new Error('Šis pārlūka profils ir piesaistīts citam Core. Izmanto atsevišķu profilu.');
  }
  store.set('coreBridge.origin', core.base);
  coordinationJournal=new CoordinationJournal(store);
  coordinationExecutor=new CoordinationExecutor({prepare:prepareCollaborationDrafts,submit:submitCoordinationRun});
  const councilDriver=createCouncilBrowserDriver({getTab:id=>tabs.get(id),
    selectTab:id=>selectTab(id),getWindow:()=>win,isClosing:()=>closing,testMode});
  councilRunner=new CouncilConversation({store,send:councilDriver.send,
    capture:councilDriver.capture,
    advisor:async args=>localCouncilManager.advise(args),onChange:emit});
  for(const project of store.snapshot().projects)councilRunner.recover(project.id);
  for(const project of store.snapshot().projects)
    coordinationJournal.recoverInterrupted(project.id);
  frontier=new BrowserFrontier({root:path.join(profile,'core-isolated'),store,crypto:safeStorage});await frontier.init();
  turns=new TurnService({store,adapter:ollama,guard:()=>canLoadLocalModel({freeBytes:os.freemem(),totalBytes:os.totalmem(),guard:coreState?.guard,fixture:testMode}),onChange:emit,publish:t=>frontier.publish(t)});
  await turns.flushOutbox();
  win=new BrowserWindow({width:1500,height:960,minWidth:980,minHeight:680,show:false,title:'MNEMOS Browser',backgroundColor:'#111416',frame:false,webPreferences:{...WEB_PREFERENCES,preload:path.join(root,'src','preload.cjs')}});
  Menu.setApplicationMenu(null);attachKeys(win.webContents);
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  // The privileged shell never fetches network content; even its default session denies permissions.
  win.webContents.session.setPermissionRequestHandler((_wc,_p,callback)=>callback(false));
  win.webContents.session.setPermissionCheckHandler(()=>false);
  bridge=new CoreBrowserBridge({
    store,crypto:safeStorage,base:core.base,
    getTabs:()=>[...tabs.values()].map(t=>({id:t.id,project:t.project,private:t.private,url:t.url,title:t.title,loading:t.loading,crashed:t.crashed,failed:!!t.error,navigationEpoch:t.navigationEpoch})),
    performLifecycle:performTabLifecycle,
    inspectTab:async(id,scope)=>{
      const {tab,wc,url}=getLifecycleTarget(id,scope);
      if(tab.loading||tab.crashed||wc.isLoading())throw new Error('TAB_NOT_READY');
      const observation=await wc.executeJavaScript('({title:document.title,text:(document.body?.innerText||"").slice(0,6000)})');
      if(wc.isDestroyed()||wc.getURL()!==url.href)throw new Error('TAB_PAGE_CHANGED');
      return observation;
    },
    readAnswer:async(id,{expectedOrigin,offset,length})=>{
      const tab=tabs.get(id);
      if(!tab||tab.private||tab.loading||tab.view.webContents.isDestroyed())
        throw new Error('TAB_NOT_ACCESSIBLE');
      const wc=tab.view.webContents,before=wc.getURL(),model=collaborationModel(before);
      if(!model||new URL(before).origin!==expectedOrigin)
        throw new Error('ANSWER_REQUIRES_KNOWN_AI_CHAT');
      const observation=await wc.executeJavaScript(modelAnswerExtractionScript(model),true);
      if(wc.isDestroyed()||wc.getURL()!==before)throw new Error('ANSWER_PAGE_CHANGED');
      const candidate=observation.kind==='ASSISTANT_DOM_CANDIDATE';
      const source=String(candidate?observation.answer:observation.text);
      const chunk=source.slice(offset,offset+length);
      return {model,kind:observation.kind,unverified:true,selector:observation.selector,
        title:observation.title,url:new URL(before).origin+new URL(before).pathname,
        offset,total:source.length,nextOffset:offset+chunk.length<source.length?
          offset+chunk.length:null,
        content:chunk,bodyChars:observation.bodyChars,
        truncated:observation.bodyTruncated||observation.answerTruncated,
        note:candidate?'UNVERIFIED_ASSISTANT_DOM':'UNVERIFIED_PAGE_TEXT_NOT_MODEL_ANSWER'};
    },
    openUrl:(url,project)=>openTab({input:url,project,scopedOpen:true}),
    selectTab:id=>selectTab(id),
    performAction:async(id,action,scope)=>{
      const t=tabs.get(id);
      if(!t||t.private||t.loading||t.view.webContents.isDestroyed())throw new Error('TAB_NOT_ACCESSIBLE');
      const wc=t.view.webContents;
      const checkPage=()=>{
        if(closing||!bridge.enabled||tabs.get(id)!==t||t.project!==scope.project||wc.isDestroyed()||
           wc.getURL()!==scope.href||t.navigationEpoch!==scope.navigationEpoch||wc.isLoading()||t.crashed)throw new Error('TAB_PAGE_CHANGED');
      };
      if(scope)checkPage();
      const authorize=scope ? async()=>{await scope.authorize();checkPage();} : null;
      let delegatedBackground=false;
       if(action.operation==='tab.submit'&&scope&&collaborationModel(wc.getURL())){
         try{
           const u=new URL(wc.getURL());
           let page=await performBrowserAction(wc,{
             operation:'tab.describe',expectedOrigin:u.origin,expectedPath:u.pathname,
             fieldOffset:0,buttonOffset:0,limit:64
           });
           const fields=page.fields,buttons=[...page.buttons];
           let offset=page.nextButtonOffset;
           for(let n=0;offset!==null&&n<3;n++){
             page=await performBrowserAction(wc,{
               operation:'tab.describe',expectedOrigin:u.origin,expectedPath:u.pathname,
               fieldOffset:0,buttonOffset:offset,limit:64
             });
             buttons.push(...page.buttons);offset=page.nextButtonOffset;
           }
           delegatedBackground=delegatedModelPromptAllowed({
             tab:{...t,loading:t.loading},index:action.index,
             label:action.expectedText,description:{fields,buttons}
           });
         }catch{delegatedBackground=false;}
       }
       if(action.operation==='tab.submit'&&!delegatedBackground){
         if(!win.isVisible())win.show();
         win.focus();
       }
      if(scope)selectTab(id);
      if(action.operation==='tab.submit'&&!delegatedBackground&&!win.isFocused())throw new Error('BROWSER_SEND_WINDOW_NOT_FOCUSED');
      if(action.operation==='tab.attach')return attachBrowserFile(t.view.webContents,action,{
        showOpenDialog: (...args)=>dialog.showOpenDialog(...args),ownerWindow:win,authorize});
      const assertCurrent=scope ? ()=>{
        checkPage();
        if(action.operation==='tab.submit'&&(activeId!==id||(!delegatedBackground&&!win.isFocused())))throw new Error('BROWSER_SEND_WINDOW_NOT_FOCUSED');
      } : null;
      return performBrowserAction(wc,action,{authorize,assertCurrent});
    },
    approve:async({operation,tab,sender,index,label})=>{
      // Internal prompts to approved AI-model chat composers are delegated inference,
      // not publication. Never show repetitive modal approval for those exact controls.
      // Public forms, posts, applications, unknown sites and ambiguous buttons still
      // require one native approval before any submission.
      if(operation!=='tab.submit'||testMode||!win||win.isDestroyed())return false;
      try{
        const model=collaborationModel(tab?.url);
        const live=tab&&tabs.get(tab.id);
        if(model&&live&&!live.private&&!live.loading&&live.project===tab.project&&
           !live.view.webContents.isDestroyed()&&
           live.view.webContents.getURL()===tab.url){
          const wc=live.view.webContents,url=new URL(tab.url);
          let page=await performBrowserAction(wc,{
            operation:'tab.describe',expectedOrigin:url.origin,
            expectedPath:url.pathname,fieldOffset:0,buttonOffset:0,limit:64
          });
          const fields=page.fields,buttons=[...page.buttons];
          let offset=page.nextButtonOffset;
          for(let n=0;offset!==null&&n<3;n++){
            page=await performBrowserAction(wc,{
              operation:'tab.describe',expectedOrigin:url.origin,
              expectedPath:url.pathname,fieldOffset:0,buttonOffset:offset,limit:64
            });
            buttons.push(...page.buttons);offset=page.nextButtonOffset;
          }
          if(delegatedModelPromptAllowed({
            tab:{...tab,loading:live.loading},index,label,description:{fields,buttons}
          })){
            const now=Date.now(),key=live.id;
            const recent=(delegatedPromptRates.get(key)||[]).filter(t=>now-t<300000);
            // Bound autonomous prompt traffic: at most 10 per tab per five minutes.
            // Past the limit, fall back to the ordinary native approval.
            if(recent.length<10){
              delegatedPromptRates.set(key,[...recent,now]);
              const history=store.get('browser.delegatedModelPrompts',[]);
              store.set('browser.delegatedModelPrompts',
                [...history.slice(-79),{at:new Date(now).toISOString(),model,
                  project:tab.project,tabId:key,sender}]);
              return true;
            }
          }
        }
      }catch(error){report(error);}
      const response=await dialog.showMessageBox(win,{
        type:'question',title:'MNEMOS Browser · apstiprināt ārēju nosūtīšanu',
        message:'Apstiprināt nosūtīšanu tavā vārdā?',
        detail:'Pieprasītājs: '+sender+'\nVietne: '+(tab?.url??'')+
          (Number.isInteger(index)?'\nPoga #'+index+': '+String(label??'').slice(0,120):'')+
          '\n\nŠī darbība nosūta datus ārējai vietnei. Apstiprinājums ir vienreizējs; vietnes pieņemšana jāpārbauda atsevišķi.',
        buttons:['Noraidīt','Nosūtīt'],defaultId:0,cancelId:0
      });
      return response.response===1;
    },

    onConsultationReply:async reply=>{
      const q=await queueForReview();
      q.recordConsultationReply(reply);
      q.submitResult({proposalId:reply.proposalId,
        requestId:'chatgpt-reply-'+reply.sourceMessageId,
        summary:'ChatGPT konsultācijas atbilde',
        details:reply.text});
      emit();
    },
    onChange:emit
  });
  ipcMain.handle('mnemos:command',async(event,operation,payload)=>{
    assertShellSender(event,win.webContents);
    if(!Object.hasOwn(commands,operation)||typeof operation!=='string')throw new Error('UNKNOWN_COMMAND');
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||JSON.stringify(payload).length>64000)throw new Error('INVALID_COMMAND_PAYLOAD');
    try{return await commands[operation](payload)??null;}catch(error){report(error);throw error;}
  });
  win.on('resize',layout);
  win.on('close',()=>{
    clearTimeout(emitTimer);
    const openTabs=[...tabs.values()];
    // Keep the saved tab list for restart. Destruction callbacks see an empty registry.
    tabs.clear();activeId='home';
    for(const tab of openTabs)detachTab(tab);
  });
  await win.loadURL(APP_URL);
  win.show();
  await refresh();
  restoringTabs=true;
  try {
    for(const t of store.get('tabs',[]).slice(0,24)){
      try { await openTab({input:t.url,project:t.project},t.id); } catch {}
    }
  } finally { restoringTabs=false; }
  persistTabs();
  selectTab('home');
  await bridge.start();
} catch(error) { logRuntimeFault('startup-failure',error);if(!testMode)dialog.showErrorBox('MNEMOS Browser',error.message);app.exit(1); }
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  if(closing)return;
  event.preventDefault();closing=true;clearTimeout(emitTimer);
  const safely=async(label,fn)=>{try{await fn();}catch(error){logRuntimeFault('shutdown-'+label,error);}};
  // A rejected storage flush or Core disconnect must not become an uncaught Electron exception.
  void (async()=>{
    await safely('bridge-stop',()=>bridge?.stop());
    await safely('bridge-finish',()=>bridge?.finishRegistration());
    await safely('turns-close',()=>turns?.close());
    for(const s of browserSessions){
      await safely('storage-flush',()=>s.flushStorageData());
      await safely('cookie-flush',()=>s.cookies.flushStore());
    }
    await safely('store-close',()=>store?.close());
  })().catch(error=>logRuntimeFault('shutdown-unexpected',error))
     .finally(()=>app.quit());
});
}
