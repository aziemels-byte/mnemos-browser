/* The shell renders only bounded plain text. No page HTML or model HTML enters this DOM. */
const $=id=>document.getElementById(id),api=window.mnemos;
let state=null,dialogAction=null,currentModel='',lastTurnId=null,renderedConversation='',renderedMain='',mainView='',lastModels='',tabSignature='',displaySection=null,enterTimer=null;
const attached=new Set();let attachmentProject=null,attachmentSignature='';
let handoffNonce=null;
async function openPerplexityHandoff(){
  const prepared=await invoke('perplexity.handoff.preview');
  if(!prepared)return;
  handoffNonce=prepared.nonce;
  $('handoff-details').textContent='Mērķis: '+prepared.tab+' · '+prepared.characters+
    ' rakstzīmes. Šis ir vienreizējs konteksts, nevis tieša Perplexity piekļuve MNEMOS.';
  $('handoff-preview').value=prepared.preview;
  await invoke('overlay',{visible:true});
  $('handoff-dialog').showModal();
}
function handoffCard(){
  const box=element('div','handoff-card');
  append(box,append(element('div'),element('strong','','Perplexity · MNEMOS konteksts'),
    element('p','subtitle','Nodod pārskatītu viena projekta kontekstu — bez automātiskas nosūtīšanas vai piekļuves lokālajiem rīkiem.')),
    button('Sagatavot Perplexity kontekstu','secondary',openPerplexityHandoff));
  return box;
}

function perplexityMcpCard(){
  const url=state?.mcpEndpoint;
  const outer=element('section','handoff-card mcp-card'),controls=element('div','mcp-controls');
  const info=append(element('div'),element('strong','','Perplexity Pro · MNEMOS MCP'),
    element('p','subtitle','19 MCP rīki: 4 Core lasīšanai, 4 sadarbībai un 11 ielogotā pārlūka darbībām. Iespējama arī CV/dokumentu pievienošana ar tavu Windows faila izvēli. Lasīšana, pārlūkošana un melnrakstu ievade notiek bez apstiprinājuma. Zināmo AI čatu uzvednes ir deleģētas bez papildu apstiprinājuma; publiskai saziņai un citām formām joprojām prasa atļauju. Failu izvēlies pats.'),
    element('p','mcp-url',url??'MCP adrese nav konfigurēta.'),
    element('p','subtitle','Pievienot pielāgotu → Savienotājs → Remote → nosaukums MNEMOS → Streamable HTTP → API Key.'));
  const notice=(value)=>{$('toast').textContent=value;$('toast').hidden=false;};
  append(controls,
    button('1. Atvērt Perplexity spraudņus','primary',async()=>{
      const result=await invoke('perplexity.mcp.prepare');
      if(result?.ready)notice('MCP serveris pārbaudīts. Atslēga ir starpliktuvē 120 sekundes. Perplexity spraudņa konfigurācijā izvēlies API Key.');
    }),
    button('2. Kopēt MCP URL','secondary',async()=>{
      const result=await invoke('perplexity.mcp.copyUrl');if(result?.copied)notice('MCP HTTPS adrese iekopēta starpliktuvē.');
    }),
    button('3. Kopēt API atslēgu','secondary',async()=>{
      const result=await invoke('perplexity.mcp.copyKey');if(result?.copied)notice('API atslēga iekopēta uz 120 sekundēm. Ielīmē tikai Perplexity API Key laukā.');
    }));
  if(!url)for(const control of controls.children)control.disabled=true;
  append(outer,info,controls);return outer;
}
function ensureCoordinationProject(){
  if(coordinationProject===state.activeProject)return;
  coordinationProject=state.activeProject;
  coordinationTabIds.clear();coordinationMemoryIds.clear();
  coordinationPrompt='';councilSeed='Iepazīstamies un noskaidrojam, kā vislabāk sadarboties.';
  coordinationReport=null;coordinationEvidence=null;
  coordinationRunId=null;coordinationHistory=[];coordinationHistoryReady=false;
  coordinationHistoryLoading=false;coordinationSavedMemoryId=null;
  coordinationSubmitReport=null;coordinationSubmission=[];
  coordinationEvidenceUpdatedAt=null;coordinationEvidenceLoading=false;coordinationReportText='';
}
function openGeminiCoordination(){
  const eligible=(state?.tabs??[]).filter(t=>{
    if(!t||t.private||t.loading||t.project!==state.activeProject)return false;
    try{
      const u=new URL(t.url);
      return u.protocol==='https:'&&u.hostname==='gemini.google.com'&&
        !u.username&&!u.password&&(!u.port||u.port==='443')&&
        /^\/app(?:\/[a-zA-Z0-9-]+)?$/.test(u.pathname);
    }catch{return false;}
  });
  const tab=eligible.find(t=>t.id===state.activeId)??eligible[0];
  if(!tab){showError('Atver Gemini sarunu šī projekta neprivātā cilnē.');return;}
  ensureCoordinationProject();
  coordinationTabIds.clear();
  coordinationTabIds.add(tab.id);
  void invoke('section',{name:'coordination'});
}
function geminiMcpCard(){
  const notice=value=>{const toast=$('toast');if(toast){toast.textContent=value;toast.hidden=false;}};
  const outer=element('section','handoff-card mcp-card');
  const info=element('div','handoff-copy');
  append(info,element('span','eyebrow','GEMINI · MNEMOS BROWSER BRIDGE'),
    element('h2','','Google Gemini ↔ MNEMOS'),
    element('p','subtitle','Gemini atvēršana šajā pārlūkā nedod modelim automātisku piekļuvi MNEMOS Core. Google pielāgotie MCP savienojumi pagaidām pieejami tikai atbilstošiem ASV personīgajiem kontiem (angļu valodā). Latvijā izmanto MNEMOS koordināciju: ar izvēlētu projekta atmiņu, pārbaudītu vienreizēju nosūtīšanu un atbilžu fiksāciju.'),element('p','subtitle',state?.bridge?.connected?'MNEMOS Browser ir savienots ar Core; Gemini ir pieejams kā pārvaldāma sarunas cilne, nevis patstāvīgs Core rīku klients.':'MNEMOS Core Bridge nav savienots. Pārlūka projekta atmiņu un Gemini cilni joprojām var izmantot koordinācijas režīmā.'));
  const controls=element('div','handoff-actions');
  append(controls,
    button('Gemini ↔ MNEMOS koordinācija','primary',openGeminiCoordination),
    button('Google MCP iestatījumi (ASV kontiem)','secondary',async()=>{
      await invoke('gemini.mcp.openSetup');
    }),
    button('2. Kopēt MCP adresi','secondary',async()=>{
      const result=await invoke('gemini.mcp.copyUrl');if(result?.copied)notice('MCP HTTPS adrese iekopēta.');
    }),
    button('3. Kopēt Client ID','secondary',async()=>{
      const result=await invoke('gemini.mcp.copyClientId');if(result?.copied)notice('OAuth Client ID iekopēts. Client secret atstāj tukšu.');
    }),
    button('4. Piekrišanas kods','secondary',async()=>{
      const result=await invoke('gemini.mcp.copyConsent');
      if(result?.copied)notice('SLEPENAIS īpašnieka kods starpliktuvē 120 sekundes. Ievadi tikai MNEMOS autorizācijas logā, NE Gemini čatā!');
    }));
  if(!state?.mcpEndpoint){
    append(info,element('p','subtitle','MCP adrese nav konfigurēta.'));
    for(const control of Array.from(controls.children).slice(1))control.disabled=true;
  }
  append(outer,info,controls,element('p','subtitle',
    'Koordinācija: izvēlies Gemini cilni, pēc izvēles līdz diviem projekta atmiņas ierakstiem un ievadi uzdevumu. MNEMOS nosūta pieprasījumu vienreiz un savāc atbildi žurnālā. MCP (tikai atbalstītiem kontiem): Gemini Settings → Connected Apps → Custom apps → MCP URL → OAuth Client ID → Next. Piekrišanas kodu ievadi tikai MNEMOS autorizācijas logā, nekad čatā.'));
  return outer;
}

const coordinationTabIds=new Set(),coordinationMemoryIds=new Set();
const councilExpandedTurns=new Set(),councilClosedTurns=new Set();
let coordinationAdvancedOpen=false;
let coordinationPrompt='',councilSeed='Iepazīstamies un noskaidrojam, kā vislabāk sadarboties.',councilUseLocalManager=true,coordinationReport=null,coordinationEvidence=null,coordinationBusy=false,coordinationProject=null;
let coordinationRunId=null,coordinationHistory=[],coordinationHistoryReady=false,coordinationHistoryLoading=false,coordinationSavedMemoryId=null;
let coordinationSubmitReport=null,coordinationSubmission=[];
let coordinationEvidenceUpdatedAt=null,coordinationEvidenceLoading=false,coordinationReportText='';
function coordinationPage(){
  ensureCoordinationProject();

  // Core emits only metadata, never raw answer text. Load full evidence on
  // completion and keep the selected run scoped to the same project.
  if(Array.isArray(state.coordination)){
    coordinationHistory=state.coordination;
    coordinationHistoryReady=true;
  }
  const runSummary=state.coordination?.find(row=>row.id===coordinationRunId);
  if(runSummary?.captured>0&&
     runSummary.updatedAt!==coordinationEvidenceUpdatedAt&&
     !coordinationEvidenceLoading){
    const runId=coordinationRunId,projectId=coordinationProject;
    coordinationEvidenceLoading=true;
    void Promise.all([
      invoke('coordination.get',{runId}),
      invoke('coordination.report',{runId})
    ]).then(([loaded,preview])=>{
      coordinationEvidenceLoading=false;
      if(!loaded||coordinationProject!==projectId||coordinationRunId!==runId)return;
      coordinationEvidence={runId:loaded.id,snapshots:loaded.snapshots,
        comparison:loaded.comparison,synthesis:loaded.synthesis};
      coordinationEvidenceUpdatedAt=loaded.updatedAt;
      coordinationSubmission=loaded.submissions??[];
      coordinationSavedMemoryId=loaded.savedMemoryId||null;
      coordinationReportText=preview?.text||'';
      renderedMain='';renderMain();
    });
  }

  if(!coordinationHistoryReady&&!coordinationHistoryLoading){
    coordinationHistoryLoading=true;
    const projectId=coordinationProject;
    void invoke('coordination.list').then(rows=>{
      if(coordinationProject!==projectId)return;
      coordinationHistory=rows??[];
      coordinationHistoryReady=true;
      coordinationHistoryLoading=false;
      renderedMain='';renderMain();
    });
  }
  const panel=element('section','coordination-page');
  const hostNames=new Map([
    ['chatgpt.com','ChatGPT'],['gemini.google.com','Gemini'],
    ['www.perplexity.ai','Perplexity'],['perplexity.ai','Perplexity']]);
  const eligible=state.tabs.filter(t=>{
    if(t.private||t.loading||t.project!==state.activeProject)return false;
    try{
      const u=new URL(t.url),model=hostNames.get(u.hostname);
      if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||!model)return false;
      if(model==='ChatGPT')return u.pathname==='/'||/^\/c\/[a-zA-Z0-9-]+$/.test(u.pathname);
      if(model==='Gemini')return /^\/app(?:\/[a-zA-Z0-9-]+)?$/.test(u.pathname);
      return u.pathname==='/'||/^\/(?:session|search)\/[a-zA-Z0-9-]+$/.test(u.pathname);
    }catch{return false;}
  });
  const current=new Set(eligible.map(t=>t.id));
  for(const id of coordinationTabIds)if(!current.has(id))coordinationTabIds.delete(id);
  // An unobstructed ensemble, NOT decorative dashboard cards. The text beneath
  // each face is populated exclusively by MNEMOSProviderAvatars.refresh().
  const ensemble=element('section','persona-ensemble');
  ensemble.setAttribute('aria-label','Digitālās personības un to faktiskie darba stāvokļi');
  const lineup=element('div','persona-lineup');
  for(const [model,name] of [
    ['ChatGPT','ChatGPT'],['Claude','Claude'],['Gemini','Gemini'],
    ['Perplexity','Perplexity'],['local','Lokālie modeļi']
  ]){
    const member=element('div','persona-member');
    const figure=window.MNEMOSProviderAvatars?.create(model,{size:'stage'});
    append(member,figure,element('strong','persona-name',name),
      element('small','persona-state','—'));
    lineup.append(member);
  }
  ensemble.append(lineup);
  panel.append(ensemble);
  append(panel,element('p','subtitle',
    'Izvēlies ielogotos modeļus un pārvaldi vienu sarunu. MNEMOS saglabā katru gājienu; ziņojumus nesūta atkārtoti.'),
    element('div','section-divider'),titleRow('Dalībnieki',eligible.length,'ESOŠĀS CILNES'));
  if(!eligible.length)panel.append(empty('Nav AI cilņu',
    'Atver ChatGPT, Gemini vai Perplexity šī projekta pārlūka profilā.'));
  const targetList=element('div','coordination-options');
  const nativeModelToggles=new Map();
  for(const t of eligible){
    const origin=new URL(t.url),model=hostNames.get(origin.hostname);
    const line=element('label','coordination-option'),toggle=element('input');
    nativeModelToggles.set(t.id,toggle);
    toggle.type='checkbox';toggle.checked=coordinationTabIds.has(t.id);
    toggle.addEventListener('change',()=>{
      if(toggle.checked){
        const chosen=eligible.filter(v=>coordinationTabIds.has(v.id));
        if(chosen.length>=3||chosen.some(v=>hostNames.get(new URL(v.url).hostname)===model)){
          toggle.checked=false;showError('Maksimāli 3 cilnes; katrs modelis tikai vienreiz.');return;
        }
        coordinationTabIds.add(t.id);
      }else coordinationTabIds.delete(t.id);
    });
    append(line,toggle,window.MNEMOSProviderAvatars?.create(model,{size:'small'}),append(element('div'),element('strong','',model),
      element('small','',t.title.slice(0,130))));
    targetList.append(line);
  }
  panel.append(targetList);
  // React Bits renders the visible roster, while the native checkboxes retain
  // all existing validation and provide a no-JavaScript-render fallback.
  const rosterHost=element('div','reactbits-roster-host');
  panel.insertBefore(rosterHost,targetList);
  const rosterRows=eligible.map(t=>({
    id:t.id,
    model:hostNames.get(new URL(t.url).hostname),
    title:String(t.title??'').slice(0,130),
    selected:coordinationTabIds.has(t.id)
  }));
  queueMicrotask(()=>{
    if(!rosterHost.isConnected)return;
    const mount=window.MNEMOSReactBits?.mountRoster;
    if(typeof mount!=='function'){rosterHost.remove();return;}
    const ok=mount(rosterHost,rosterRows,{
      onToggle(id,desired){
        const native=nativeModelToggles.get(id);
        if(!native)return false;
        native.checked=desired;
        native.dispatchEvent(new Event('change',{bubbles:true}));
        return native.checked;
      },
      onReady(){
        if(rosterHost.isConnected)targetList.hidden=true;
      }
    });
    if(!ok)rosterHost.remove();
  });
  const selectModels=button('Atlasīt pieejamos AI modeļus','secondary',()=>{
    coordinationTabIds.clear();
    const used=new Set();
    for(const tab of eligible){
      const model=hostNames.get(new URL(tab.url).hostname);
      if(!used.has(model)){coordinationTabIds.add(tab.id);used.add(model);}
      if(used.size>=3)break;
    }
    renderedMain='';renderMain();
  });
  selectModels.disabled=coordinationBusy||eligible.length===0;
  panel.append(append(element('div','coordination-actions'),selectModels));
  // The live council is part of the Electron browser runtime, not ChatGPT
  // automation. A single click authorizes a bounded, sequential conversation.
  const council=state.council;
  const statusNames={
    RUNNING:'Saruna notiek',RECONCILING:'Pārbauda jau saņemtu atbildi',
    COMPLETED:'Saruna pabeigta',
    STOP_REQUESTED:'Notiek apturēšana',STOPPED:'Apturēta',
    INTERRUPTED_NO_RETRY:'Pārtraukta — netiek atkārtota',
    BLOCKED_UNVERIFIED:'Apturēta — atbilde nav pārbaudāma',
    SEND_UNCERTAIN_NO_RETRY:'Apturēta — nosūtīšana nav pārbaudāma',
    INTENT_RECORDED:'Sagatavo ziņojumu',AWAITING_RESPONSE:'Gaida AI atbildi',
    CAPTURED:'Atbilde nolasīta',RESPONSE_UNVERIFIED:'Atbildi nevar pārbaudīt',
    STOPPED_AFTER_SEND:'Apturēta pēc ziņojuma'
  };
  const statusLabel=status=>statusNames[status]||status||'Nav sākta';
  const errorLabel=code=>{
    if(code==='FILL_NOT_VERIFIED')
      return 'Ziņojuma ievades pārbaude neizdevās. Nosūtīšana šajā ciklā netika veikta; melnrakstu pārbaudi pirms jaunas sarunas (FILL_NOT_VERIFIED).';
    if(['COUNCIL_ORIGIN_CHANGED','COUNCIL_RESPONSE_PAGE_CHANGED'].includes(code))
      return 'AI cilnes adrese mainījās atbildes nolasīšanas laikā. Atbilde netika nodota citam modelim; nosūtīšana netiek atkārtota ('+code+').';
    if(code==='COUNCIL_TAB_NOT_READY')
      return 'AI cilne īslaicīgi nav pieejama. Atbildi nevarēja droši nolasīt; nosūtīšana netiek atkārtota ('+code+').';
    if(code==='COUNCIL_PROMPT_ALREADY_VISIBLE')
      return 'Šis pats sarunas uzdevums jau atrodams izvēlētajā AI cilnē. Lai neradītu atkārtotu ziņojumu, nekas netika sūtīts; izvēlies jaunu, tukšu AI sarunu (COUNCIL_PROMPT_ALREADY_VISIBLE).';
    if(code==='UNVERIFIED_PAGE_AFTER_PROMPT')
      return 'Pēc nosūtītās ziņas redzams lapas teksts, bet asistenta atbilde nav droši izolēta. Ziņojums citam modelim netika pārsūtīts (UNVERIFIED_PAGE_AFTER_PROMPT).';
    if(code==='NO_CURRENT_RESPONSE_ANCHOR'||code==='TIMEOUT_UNVERIFIED')
      return 'Neizdevās droši nolasīt atbildi atļautajā laikā. Ziņojums netika atkārtoti nosūtīts ('+code+').';
    if(code==='PROVIDER_REPLY_UNREADABLE')
      return 'AI atbilde ir pabeigta, taču lapas struktūra neļauj droši atdalīt tās tekstu. Nolasīšana apturēta; ziņojums netika sūtīts vēlreiz.';
    if(code?.startsWith('COUNCIL_READ_ONLY_RECOVERY_UNVERIFIED'))
      return 'Iepriekšējā atbilde nav droši izolējama; turpināšana apturēta. Atkārtota nosūtīšana nav veikta ('+code+').';
    return code;
  };
  const councilCard=element('section','handoff-card council-panel');
  append(councilCard,titleRow('Sarunas gaita',council?.turns?.length||0,
    statusLabel(council?.status)),
    element('p','subtitle',
      'Katrs nākamais modelis saņem tikai faktiski nolasītas atbildes. Neskaidrības gadījumā izpilde apstājas.'));
  const introSeed=element('textarea','coordination-prompt');
  introSeed.rows=2;introSeed.maxLength=900;introSeed.value=councilSeed;
  introSeed.setAttribute('aria-label','Sarunas ievada tēma');
  introSeed.addEventListener('input',()=>{councilSeed=introSeed.value;});
  councilCard.append(introSeed);
  const councilControls=element('div','coordination-actions');
  const activeCouncil=['RUNNING','RECONCILING','STOP_REQUESTED'].includes(council?.status);
  const managerRow=element('label','coordination-option');
  const managerCheck=element('input');
  managerCheck.type='checkbox';
  managerCheck.checked=activeCouncil?council.localManagerEnabled:councilUseLocalManager;
  managerCheck.disabled=activeCouncil;
  managerCheck.addEventListener('change',()=>{councilUseLocalManager=managerCheck.checked;});
  const managerName=state.councilAgentModel||'Nav pieejams mazs lokāls modelis';
  append(managerRow,managerCheck,append(element('div'),
    element('strong','','Lokālais sarunas koordinators'),
    element('small','',state.councilAgentModel?
      managerName+' · izvēlas nākamo dalībnieku un diskusijas virzienu; sūtīšanu kontrolē pārlūks.':
      'Ja piemērots Ollama modelis nav uzstādīts, saglabājas parastā dalībnieku secība.')));
  councilCard.append(managerRow);
  const launch=button('Sākt sarunu starp AI','primary',async()=>{
    if(coordinationBusy||activeCouncil)return;
    if(coordinationTabIds.size<2){
      showError('Sarunai nepieciešamas vismaz divas atšķirīgas AI cilnes.');return;
    }
    if(!councilSeed.trim()){showError('Ieraksti sarunas tēmu.');return;}
    coordinationBusy=true;launch.disabled=true;
    const result=await invoke('council.start',{
      tabIds:[...coordinationTabIds],seed:councilSeed,maxTurns:6,
      localManagerEnabled:councilUseLocalManager
    });
    coordinationBusy=false;
    if(result){renderedMain='';renderMain();}
  });
  launch.disabled=coordinationBusy||activeCouncil||!eligible.length;
  councilControls.append(launch);
  if(['SEND_UNCERTAIN_NO_RETRY','BLOCKED_UNVERIFIED'].includes(council?.status)&&
     ['SEND_UNCERTAIN_NO_RETRY','RESPONSE_UNVERIFIED'].includes(council?.turns?.at(-1)?.status)){
    const recover=button('Pārbaudīt esošo atbildi un turpināt','secondary',async()=>{
      if(coordinationBusy)return;
      coordinationBusy=true;recover.disabled=true;
      const result=await invoke('council.reconcile');
      coordinationBusy=false;
      if(result){renderedMain='';renderMain();}
    });
    recover.disabled=coordinationBusy;
    recover.title='Tikai nolasa jau nosūtītā ziņojuma atbildi; nekad nesūta to vēlreiz. Ja atbilde nav identificējama, sarunu neturpina.';
    councilControls.append(recover);
  }
  if(activeCouncil){
    const stop=button('Apturēt pēc pašreizējās darbības','secondary',async()=>{
      await invoke('council.stop');renderedMain='';renderMain();
    });
    stop.disabled=council.stopRequested===true;
    councilControls.append(stop);
  }
  councilCard.append(councilControls);
  if(council){
    if(council.error)councilCard.append(element('p','notice gold',errorLabel(council.error)));
    const messages=element('div','coordination-results');
    const nativeMessages=element('div','council-native-fallback');
    for(const [index,turn] of council.turns.entries()){
      const row=element('div','council-turn');
      row.classList.toggle('council-turn-active',
        ['AWAITING_RESPONSE','RECONCILING','INTENT_RECORDED'].includes(turn.status));
      row.classList.toggle('council-turn-complete',turn.status==='CAPTURED');
      const number=element('span','council-turn-number',String(index+1).padStart(2,'0'));
      const content=element('div','council-turn-body');
      const header=element('div','council-turn-head');
      append(header,window.MNEMOSProviderAvatars?.create(turn.model,{size:'small'}),badge(turn.model),element('strong','',statusLabel(turn.status)));
      if(turn.status==='CAPTURED')header.append(element('span','council-turn-done','✓'));
      content.append(header);
      if(turn.routing){
        const routing=turn.routing.status==='THINKING'?
          'Koordinators izvēlas nākamo dalībnieku…':
          turn.routing.status==='LOCAL_MODEL'?
            'Nākamais: '+turn.routing.nextModel+' · '+turn.routing.model+' · '+turn.routing.intent:
            'Nākamais: '+turn.routing.nextModel+' · rezerves secība';
        content.append(element('small','council-turn-meta',routing));
      }
      if(turn.inspectionAttempts>0&&['RECONCILING','AWAITING_RESPONSE'].includes(turn.status))
        content.append(element('small','council-turn-meta',
          `Pārbaudes: ${turn.inspectionAttempts} · ${turn.lastReadReason||'GAIDA'}`));
      // Only evidence-backed clocks. DOM polling is never token-stream telemetry.
      if(turn.sendTriggeredAt||turn.responseCapturedAt){
        const sent=turn.sendTriggeredAt?new Date(turn.sendTriggeredAt).getTime():NaN;
        const captured=turn.responseCapturedAt?new Date(turn.responseCapturedAt).getTime():NaN;
        const elapsed=Number.isFinite(sent)&&Number.isFinite(captured)&&captured>=sent
          ?` · DOM nolasīts pēc ${((captured-sent)/1000).toFixed(1)} s`:'';
        content.append(element('small','council-turn-meta',
          'DOM aptauja · nav tokenu straumes' + elapsed));
      }
      if(turn.url)content.append(element('small','council-turn-url',turn.url));
      if(turn.answer){
        const details=element('details','council-answer');
        details.open=councilExpandedTurns.has(turn.id)||
          (index===council.turns.length-1&&!councilClosedTurns.has(turn.id));
        details.addEventListener('toggle',()=>{
          if(details.open){councilExpandedTurns.add(turn.id);councilClosedTurns.delete(turn.id);}
          else{councilExpandedTurns.delete(turn.id);councilClosedTurns.add(turn.id);}
        });
        details.append(element('summary','','Lasīt atbildi'),
          element('div','council-answer-content',turn.answer));
        content.append(details);
      }
      if(turn.error)content.append(element('p','notice gold',errorLabel(turn.error)));
      row.append(number,content);
      nativeMessages.append(row);
    }
    messages.append(nativeMessages);
    councilCard.append(messages);
    // React Bits is an optional, read-only island. The existing tested DOM
    // transcript stays available if React fails, loads late or is disabled.
    // Wait until the host is attached: React 18 createRoot must not race
    // a detached element during the shell's synchronous page rebuild.
    queueMicrotask(()=>{
      if(!messages.isConnected)return;
      const mount=window.MNEMOSReactBits?.mountCouncil;
      if(typeof mount!=='function')return;
      const island=element('div','reactbits-island');
      messages.prepend(island);
      let mounted=false;
      try{
        mounted=mount(island,council,{statusLabel,errorLabel})===true;
      }catch(error){
        console.error('React Bits council unavailable:',String(error?.message||error));
      }
      if(mounted)nativeMessages.hidden=true;
      else island.remove();
    });
  }
  panel.append(councilCard,element('div','section-divider'));

  append(panel,element('div','section-divider'),titleRow('Kopīgais uzdevums','','MAKS. 1600 RAKSTZĪMES'));
  const prompt=element('textarea','coordination-prompt');
  prompt.rows=5;prompt.maxLength=1600;
  prompt.placeholder='Viens jautājums vai uzdevums vairākiem modeļiem…';
  prompt.value=coordinationPrompt;
  prompt.addEventListener('input',()=>{coordinationPrompt=prompt.value;});
  panel.append(prompt);
  const memories=localItems('memory');
  append(panel,element('div','section-divider'),
    titleRow('Projekta atmiņa',memories.length,'NEKAS NETIEK PIEVIENOTS AUTOMĀTISKI'),
    element('p','subtitle','Pēc izvēles pievieno līdz diviem nelieliem ierakstiem. '+
      'Tikai šeit atzīmētais konteksts nonāks ārējo AI melnrakstos.'));
  const contextList=element('div','coordination-options');
  for(const item of memories.slice(0,20)){
    const line=element('label','coordination-option'),check=element('input');
    check.type='checkbox';check.checked=coordinationMemoryIds.has(item.id);
    check.addEventListener('change',()=>{
      if(check.checked&&coordinationMemoryIds.size>=2){
        check.checked=false;showError('Vienam kopīgajam uzdevumam var izvēlēties divus atmiņas ierakstus.');return;
      }
      if(check.checked)coordinationMemoryIds.add(item.id);
      else coordinationMemoryIds.delete(item.id);
    });
    append(line,check,append(element('div'),element('strong','',item.title.slice(0,120)),
      element('small','',item.source+' · '+(item.title.length>550?'Garš ieraksts: vajadzīga saīsināšana':'≤ 550 zīmes, ja izvēlēts'))));
    contextList.append(line);
  }
  if(!memories.length)contextList.append(element('p','subtitle','Nav saglabātu atmiņas ierakstu.'));
  panel.append(contextList);
  const controls=element('div','coordination-actions');
  const prepare=button(coordinationBusy?'Gatavo melnrakstus…':'Ievietot melnrakstus (bez nosūtīšanas)','primary',async()=>{
    if(coordinationBusy)return;
    if(!coordinationPrompt.trim()){showError('Ievadi uzdevuma tekstu.');return;}
    if(!coordinationTabIds.size){showError('Izvēlies vismaz vienu modeļa cilni.');return;}
    coordinationBusy=true;prepare.disabled=true;prepare.textContent='Gatavo melnrakstus…';
    const result=await invoke('coordination.prepare',{
      prompt:coordinationPrompt,tabIds:[...coordinationTabIds],memoryIds:[...coordinationMemoryIds]
    });
    coordinationBusy=false;
    if(result){coordinationReport=result;coordinationRunId=result.runId;
      coordinationEvidence=null;coordinationSavedMemoryId=null;
      coordinationSubmission=[];coordinationSubmitReport=null;
      coordinationEvidenceUpdatedAt=null;coordinationReportText='';
      const historyRows=await invoke('coordination.list');if(historyRows)coordinationHistory=historyRows;}
    renderedMain='';renderMain();
  });
  prepare.disabled=coordinationBusy;
  const execute=button(coordinationBusy?'Izpilda sadarbību…':'Sākt pilnu sadarbības ciklu','primary',async()=>{
    if(coordinationBusy)return;
    if(!coordinationPrompt.trim()){showError('Ievadi kopīgo uzdevumu.');return;}
    if(!coordinationTabIds.size){showError('Atlasi AI modeļu cilnes.');return;}
    coordinationBusy=true;execute.disabled=true;execute.textContent='Sagatavo un nosūta vienreiz…';
    const projectId=coordinationProject;
    const result=await invoke('coordination.execute',{
      prompt:coordinationPrompt,tabIds:[...coordinationTabIds],memoryIds:[...coordinationMemoryIds]
    });
    coordinationBusy=false;
    if(result&&coordinationProject===projectId){
      coordinationRunId=result.runId;
      const loaded=await invoke('coordination.get',{runId:result.runId});
      if(loaded){
        coordinationReport={runId:loaded.id,prepared:loaded.drafts.filter(d=>d.ok).length,
          attempted:loaded.targets.length,results:loaded.drafts};
        coordinationSubmission=loaded.submissions||[];
        coordinationEvidence=loaded.snapshots.length?
          {runId:loaded.id,snapshots:loaded.snapshots,
            comparison:loaded.comparison,synthesis:loaded.synthesis}:null;
        coordinationEvidenceUpdatedAt=loaded.updatedAt;
        coordinationSavedMemoryId=loaded.savedMemoryId||null;
        coordinationReportText='';
      }
      coordinationSubmitReport=result;
      const rows=await invoke('coordination.list');if(rows)coordinationHistory=rows;
      if(result.status==='PREPARATION_INCOMPLETE')showError('Daļu melnrakstu neizdevās sagatavot; nekas netika nosūtīts.');
    }
    renderedMain='';renderMain();
  });
  execute.disabled=coordinationBusy;
  const collect=button('Savākt atlasīto cilņu saturu','secondary',async()=>{
    if(coordinationBusy)return;
    if(!coordinationRunId){showError('Vispirms sagatavo uzdevuma melnrakstus.');return;}
    coordinationBusy=true;collect.disabled=true;collect.textContent='Nolasa cilnes…';
    const result=await invoke('coordination.collect',{runId:coordinationRunId});
    coordinationBusy=false;if(result){coordinationEvidence=result;coordinationSavedMemoryId=null;
      const refreshed=await invoke('coordination.get',{runId:coordinationRunId});
      coordinationEvidenceUpdatedAt=refreshed?.updatedAt||null;
      const preview=await invoke('coordination.report',{runId:coordinationRunId});
      coordinationReportText=preview?.text||'';
      const historyRows=await invoke('coordination.list');if(historyRows)coordinationHistory=historyRows;}
    renderedMain='';renderMain();
  });
  collect.disabled=coordinationBusy||!coordinationRunId||runSummary?.monitoring?.state==='RUNNING';
  const send=button('Nosūtīt atlasītajiem AI (bez papildu loga)','secondary',async()=>{
    if(coordinationBusy)return;
    if(!coordinationRunId||!coordinationReport?.prepared){showError('Vispirms sagatavo melnrakstus.');return;}
    if(coordinationSubmission.length){showError('Šai sesijai jau ir bijis nosūtīšanas mēģinājums.');return;}
    coordinationBusy=true;send.disabled=true;send.textContent='Pārbauda melnrakstus…';
    const result=await invoke('coordination.submit',{runId:coordinationRunId});
    coordinationBusy=false;
    if(result&&!result.cancelled){
      coordinationSubmitReport=result;
      const loaded=await invoke('coordination.get',{runId:coordinationRunId});
      if(loaded)coordinationSubmission=loaded.submissions||[];
      const historyRows=await invoke('coordination.list');if(historyRows)coordinationHistory=historyRows;
    }
    renderedMain='';renderMain();
  });
  send.disabled=coordinationBusy||!coordinationRunId||!coordinationReport?.prepared||coordinationSubmission.length>0;
  append(controls,execute,prepare,send,collect,element('span','coordination-assurance',
    'PILNS CIKLS = VIENREIZĒJA NOSŪTĪŠANA → NOLASĪŠANA → ŽURNĀLS'));
  panel.append(controls);
  if(runSummary?.monitoring?.state==='RUNNING'){
    const rows=runSummary.monitoring.targets||[];
    append(panel,element('div','section-divider'),
      titleRow('Automātiska atbilžu savākšana',rows.length+'/'+runSummary.targets.length,
        'TIKAI LASĪŠANA · BEZ ATKĀRTOTAS NOSŪTĪŠANAS'));
    panel.append(element('p','subtitle',
      'Atbilžu nolasīšana un stabilitātes pārbaude notiek fonā pārlūkā, nevis attālinātā servisā.'));
    for(const item of rows)panel.append(append(element('div','coordination-result'),
      badge(item.state),
      element('p','subtitle',item.reason+' · '+item.attempts+' pārbaudes')));
  }
  if(runSummary?.monitoring?.state==='INTERRUPTED_BY_RESTART')
    panel.append(element('p','notice gold','Atbilžu savākšana pārtraukta, jo pārlūks pārstartēts. Uzvednes nav nosūtītas atkārtoti.'));
  if(coordinationReport){
    append(panel,element('div','section-divider'),
      titleRow('Pēdējais rezultāts',coordinationReport.prepared+'/'+coordinationReport.attempted,
        coordinationSubmission.length?'NOSŪTĪŠANAS STATUSS ZEMĀK':'TIKAI MELNRAKSTI'));
    const reportList=element('div','coordination-results');
    for(const item of coordinationReport.results)reportList.append(
      append(element('div','coordination-result'),badge(item.ok?'MELNRAKSTS GATAVS':'NAV IEVIETOTS',item.ok?'':'gold'),
        append(element('div'),element('strong','',item.model),element('p','subtitle',
          item.ok?'Ievadītas '+item.characters+' zīmes. '+(
            coordinationSubmission.find(s=>s.tabId===item.tabId)?.submitted?
              'Nosūtīšanas klikšķis izsaukts (pieņemšana nav verificēta).':
              coordinationSubmission.length?'Nosūtīšana nav apstiprināta.':'Ziņojums nav nosūtīts.'):
            item.error))));
    panel.append(reportList);
  }
  if(coordinationSubmission.length||coordinationSubmitReport){
    append(panel,element('div','section-divider'),
      titleRow('Nosūtīšanas stāvoklis',coordinationSubmission.length,
        'VIENA APSTIPRINĀTA DARBĪBA KATRAM MODELIM'));
    panel.append(element('p','subtitle',
      'TRIGGERED_UNVERIFIED nozīmē, ka pogas klikšķis tika izsaukts. '+
      'Tas nav pierādījums, ka platforma ziņojumu pieņēma vai apstrādāja.'));
    for(const row of coordinationSubmission){
      append(panel,append(element('div','coordination-result'),
        badge(row.state||'UNKNOWN',row.state==='FAILED'?'gold':''),
        append(element('div'),element('strong','',row.model),
          row.editorCleared===true?element('p','subtitle','Ievades lauks iztukšots pēc nosūtīšanas klikšķa. Servera pieņemšana nav verificēta.'):
          row.editorCleared===false?element('p','subtitle','Ievades lauks nav iztukšots. Nosūtīšana nav apstiprināta; automātiska atkārtošana bloķēta.'):
          element('p','subtitle','Nav neatkarīga apliecinājuma par ziņojuma pieņemšanu.'),
          row.error?element('p','subtitle',row.error):null)));
    }
  }
  if(coordinationEvidence){
    append(panel,element('div','section-divider'),
      titleRow('Pārskatam savāktais saturs',coordinationEvidence.snapshots.length,'NEPĀRBAUDĪTI AVOTI'),
      element('p','subtitle','Vispirms mēģinām nolasīt iespējamu asistenta atbildes fragmentu; ja to nevar droši izolēt, saglabājam lapas tekstu ar atsevišķu statusu. Faktu patiesums nav pārbaudīts. Atmiņā saglabā tikai pēc tavas izvēles.'));
    const list=element('div','coordination-snapshots');
    for(const item of coordinationEvidence.snapshots){
      const details=element('details','coordination-snapshot');
      const summary=element('summary','',item.model+' — '+(item.ok?'nolasītas '+(
        item.kind==='ASSISTANT_DOM_CANDIDATE'?item.answer?.length:item.text?.length||0)+' zīmes':'lasīšanas kļūda'));
      details.append(summary);
      if(item.ok)append(details,element('p','subtitle',item.title+' · '+item.url),
        element('p','subtitle',item.kind==='ASSISTANT_DOM_CANDIDATE'?'Iespējamas asistenta atbildes kandidāts':
          item.kind==='PAGE_TEXT_AFTER_PROMPT'?'Lapas teksts PĒC lietotāja jautājuma (NAV verificēta asistenta atbilde)':'Tikai lapas teksts — nav izolēta atbilde'),
        item.truncated?element('p','notice gold','Atbildes fragments pārsniedz 32768 rakstzīmes. Pārējais nav lokāli nolasīts.'):null,
        item.monitorState?element('p','subtitle','Nolasīšanas stāvoklis: '+item.monitorState):null,
        item.note?element('p','notice gold',item.note):null,
        element('pre','coordination-page-text',item.kind==='ASSISTANT_DOM_CANDIDATE'?item.answer:item.text));
      else details.append(element('p','subtitle',item.error));
      list.append(details);
    }
    panel.append(list);
    if(coordinationEvidence.synthesis){
      const synthesis=coordinationEvidence.synthesis,s=synthesis.summary;
      append(panel,element('div','section-divider'),
        titleRow('Strukturēts projekta rezultāts',s.observed+'/'+s.requestedModels.length,
          'AUTOMĀTISKI SAGLABĀTS PROJEKTA ŽURNĀLĀ'));
      append(panel,element('p','subtitle',
        'Statuss: '+synthesis.status+' · '+s.isolatedAssistantCandidates+
        ' izolētas iespējamās atbildes · '+s.promptRelativeFallbacks+
        ' nenoteiktas lapas atbildes · '+s.lexicalMatches+
        ' leksiskas sakritības. Faktu pareizība nav pārbaudīta.'));
      const evidenceList=element('div','coordination-results');
      for(const source of synthesis.evidence){
        const card=element('div','coordination-result');
        append(card,badge(source.model),append(element('div'),
          element('strong','',source.quality),
          element('p','subtitle',source.origin||source.url||'Nav izcelsmes'),
          ...source.excerpts.slice(0,2).map(t=>element('p','subtitle',t)),
          source.error?element('p','notice gold',source.error):null));
        evidenceList.append(card);
      }
      panel.append(evidenceList);
      if(synthesis.lexicalMatches.length){
        append(panel,element('p','subtitle',
          'Līdzīgi formulējumi (NAV semantiska vienprātība):'));
        for(const match of synthesis.lexicalMatches.slice(0,5)){
          append(panel,append(element('div','coordination-result'),
            badge(match.models.join(' + ')),
            append(element('div'),
              element('p','subtitle','Aptuvenā teksta līdzība: '+Math.round(match.score*100)+'%'),
              ...match.quotes.slice(0,2).map(q=>
                element('p','subtitle',q.model+': '+q.quote)))));
        }
      }else panel.append(element('p','subtitle',
        'Līdzīgi teikumi nav konstatēti. Tas nav domstarpību pierādījums.'));
      panel.append(append(element('div','coordination-actions'),
        button('Kopēt strukturēto rezultātu (JSON)','secondary',async()=>{
          const saved=await invoke('coordination.copyStructured',{runId:coordinationRunId});
          if(saved?.copied){$('toast').textContent='Strukturētais JSON nokopēts';$('toast').hidden=false;}
        }),badge('ŽURNĀLĀ')));
    }

    if(coordinationReportText){
      append(panel,element('div','section-divider'),
        titleRow('Apkopotais MNEMOS pārskats','','PROVENANCE · NEPĀRBAUDĪTI FAKTI'));
      const details=element('details','coordination-snapshot');
      details.append(element('summary','','Atvērt apkopojumu (avoti, fragmenti, sakritības)'));
      details.append(element('pre','coordination-page-text',coordinationReportText));
      panel.append(details);
      panel.append(append(element('div','coordination-actions'),
        button('Kopēt pārskatu','secondary',async()=>{
          const copied=await invoke('coordination.copyReport',{runId:coordinationRunId});
          if(copied?.copied){$('toast').textContent='Pārskats nokopēts';$('toast').hidden=false;}
        })));
    }
    if(coordinationEvidence.comparison){
      const c=coordinationEvidence.comparison;
      append(panel,element('div','section-divider'),
        titleRow('Salīdzinājums',c.comparableCount+'/'+c.count,
          'NEPĀRBAUDĪTI ASISTENTA TEKSTA KANDIDĀTI'));
      panel.append(element('p','subtitle',
        'Salīdzinātas tikai iespējamo asistenta atbilžu redzamās frāzes. '+
        'Šis nav semantiskas sakritības, pretrunu vai faktu pareizības tests.'));
      if(c.comparableCount<2)panel.append(element('p','notice gold',
        'Nepietiek izolētu atbildes kandidātu salīdzināšanai; lapu teksti netiek skaitīti kā atbildes.'));
      else if(!c.repeated.length)panel.append(element('p','notice',
        'Nav atrastas precīzi sakrītošas pietiekami garas frāzes. Tas nepierāda, ka modeļi nepiekrīt.'));
      for(const hit of c.repeated)panel.append(append(element('div','coordination-result'),
        badge(hit.models.join(' + ')),
        element('p','subtitle',hit.text)));
      const save=button('Saglabāt NEPĀRBAUDĪTU pārskatu projekta atmiņā','secondary',async()=>{
        const result=await invoke('coordination.saveReport',{runId:coordinationRunId});
        if(result?.saved){coordinationSavedMemoryId=result.memoryId;renderedMain='';renderMain();}
      });
      save.disabled=!coordinationRunId||Boolean(coordinationSavedMemoryId);
      panel.append(append(element('div','coordination-actions'),save,
        coordinationSavedMemoryId?badge('Saglabāts lokāli'):null));
    }
  }

  append(panel,element('div','section-divider'),titleRow('Saglabātās sadarbības sesijas',
    coordinationHistory.length,'TIKAI ŠĪ PROJEKTA IERAKSTI'));
  const runList=element('div','coordination-history');
  for(const item of coordinationHistory.slice(0,12)){
    const row=element('div','coordination-history-row');
    append(row,
      append(element('div'),
        element('strong','',item.prompt.slice(0,115)),
        element('small','',item.createdAt+' · '+item.status+' · '+item.targets.map(t=>t.model).join(', '))),
      button('Apskatīt','secondary',async()=>{
        const loaded=await invoke('coordination.get',{runId:item.id});
        if(!loaded||coordinationProject!==loaded.project)return;
        coordinationRunId=loaded.id;
        coordinationEvidenceUpdatedAt=loaded.updatedAt;
        const preview=loaded.snapshots.length?await invoke('coordination.report',{runId:loaded.id}):null;
        coordinationReportText=preview?.text||'';
        coordinationSavedMemoryId=loaded.savedMemoryId||null;
        coordinationSubmission=loaded.submissions||[];
        coordinationSubmitReport=null;
        coordinationReport={runId:loaded.id,prepared:loaded.drafts.filter(v=>v.ok).length,
          attempted:loaded.targets.length,results:loaded.drafts};
        coordinationEvidence=loaded.snapshots.length?{
          runId:loaded.id,snapshots:loaded.snapshots,comparison:loaded.comparison,synthesis:loaded.synthesis
        }:null;
        coordinationPrompt=loaded.prompt;
        renderedMain='';renderMain();
      }));
    runList.append(row);
  }
  if(!coordinationHistory.length)runList.append(element('p','subtitle',
    coordinationHistoryLoading?'Nolasa saglabātos ierakstus…':'Vēl nav saglabātu sesiju.'));
  panel.append(runList);

  // Secondary instruments remain available but no longer dominate the
  // primary, live conversation. The details state survives routine rerenders.
  const extras=[];
  let afterCouncil=false;
  for(const node of [...panel.children]){
    if(node===councilCard){afterCouncil=true;continue;}
    if(afterCouncil)extras.push(node);
  }
  if(extras.length){
    const drawer=element('details','coordination-advanced');
    drawer.open=coordinationAdvancedOpen;
    drawer.addEventListener('toggle',()=>{coordinationAdvancedOpen=drawer.open;});
    const body=element('div','coordination-advanced-body');
    for(const node of extras)body.append(node);
    drawer.append(element('summary','coordination-advanced-title',
      'Papildu rīki, salīdzinājumi un vēsture'),body);
    panel.append(drawer);
  }
  return panel;
}

function collaborationReviewPanel(){
  const panel=element('section','collaboration-panel');
  const title=append(element('div','collaboration-heading'),
    append(element('div'),element('h2','','PERPLEXITY → MNEMOS · APSTIPRINĀJUMI'),
      element('p','subtitle','Ārējie modeļi drīkst tikai iesniegt priekšlikumus. Darbībām vajadzīgs tavs atsevišķs apstiprinājums.')),
    button('Atjaunot','secondary',()=>void reload()));
  const content=element('div','collaboration-list');
  panel.append(title,content);
  async function decide(id,choice){
    const result=await invoke('collaboration.decide',{id,choice});
    if(result&&!result.cancelled)await reload();
  }
  function itemRow(item,isResult){
    const row=element('div','collaboration-row'),
      body=element('div','collaboration-copy'),
      controls=element('div','collaboration-actions');
    append(body,element('strong','',isResult?item.summary:item.title),
      element('p','',item.details),
      element('small','',(isResult?'REZULTĀTS':'PIEDĀVĀJUMS')+' · '+(isResult?'Ārēja atbilde':item.kind==='task'?'Lokāls uzdevums':'Konsultācija ar ChatGPT')+' · '+item.id));
    append(controls,
      button(isResult?'Pieņemt atmiņā':'Apstiprināt','primary',()=>void decide(item.id,isResult?'accept-result':'approve')),
      button('Noraidīt','secondary',()=>void decide(item.id,isResult?'reject-result':'reject')));
    return append(row,body,controls);
  }
  async function reload(){
    if(!panel.isConnected)return;
    const data=await invoke('collaboration.list');
    if(!data||!panel.isConnected)return;
    content.replaceChildren();
    const count=data.pending.length+data.results.length;
    title.querySelector('h2').textContent='PERPLEXITY → MNEMOS · APSTIPRINĀJUMI ('+count+')';
    if(!count)content.append(element('p','subtitle','Nav jaunu priekšlikumu vai pārskatāmu rezultātu.'));
    for(const item of data.pending)content.append(itemRow(item,false));
    for(const item of data.results)content.append(itemRow(item,true));
    if((data.recent??[]).some(p=>p.status==='APPROVING'))
      content.append(element('p','notice gold','Ir nepabeigta apstiprinājuma transakcija. Automātiska atkārtošana ir bloķēta, lai nepieļautu dubultus uzdevumus.'));
  }
  // No background access to privileged UI: polling stops when this DOM node is detached.
  const poll=setInterval(()=>{if(!panel.isConnected)clearInterval(poll);else void reload();},18000);
  queueMicrotask(()=>void reload());
  return panel;
}
function element(tag,cls,value){const e=document.createElement(tag);if(cls)e.className=cls;if(value!=null)e.textContent=String(value);return e;}
function button(label,cls,action){const b=element('button',cls,label);b.type='button';b.addEventListener('click',action);return b;}
function append(parent,...children){parent.append(...children.filter(Boolean));return parent;}
function invoke(op,payload={}){return api.invoke(op,payload).catch(error=>{showError(error.message);return null;});}
function showError(message){$('toast').textContent=String(message).replace(/^Error invoking remote method '[^']+': Error: /,'');$('toast').hidden=false;}
function date(value){return new Date(value).toLocaleString('lv-LV',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});}
function project(){return state.local.projects.find(p=>p.id===state.activeProject);}
function localItems(kind){return state.local.items.filter(i=>i.project===state.activeProject&&(!kind||i.kind===kind));}
function badge(value,cls=''){return element('span',`record-status ${cls}`,value);}
function source(value){return element('span',`source-tag ${value==='Core'?'core':''}`,value);}
function openDialog(kind){
  const names={project:['Jauns projekts','Atsevišķa darba telpa ar savu pārlūka sesiju un atmiņu.','Projekta nosaukums'],goal:['Jauns mērķis','Mērķis tiks saglabāts šī pārlūka projekta darba telpā.','Vēlamais rezultāts'],task:['Jauns uzdevums','Uzdevumu vari atzīmēt kā pabeigtu; tas nepalaiž aģentu.','Uzdevums'],memory:['Saglabāt atmiņā','Saglabāts ieraksts ir pieejams šī projekta atmiņas sadaļā.','Ieraksts']};
  const [title,description,label]=names[kind];$('dialog-title').textContent=title;$('dialog-description').textContent=description;$('dialog-label').textContent=label;$('dialog-input').value='';$('dialog-input').maxLength=kind==='project'?100:4000;
  dialogAction=async value=>kind==='project'?invoke('project.create',{name:value}):invoke('item.create',{kind,title:value});
  invoke('overlay',{visible:true}).then(()=>{$('input-dialog').showModal();$('dialog-input').focus();});
}
function record(row,origin='Browser',kind='task'){
  const div=element('div',`record-row ${kind}`),check=origin==='Browser'&&kind!=='memory'?button(row.status==='DONE'?'✓':'',`record-check ${row.status==='DONE'?'done':''}`,()=>invoke('item.complete',{id:row.id})):element('span','record-check',kind==='memory'?'≡':'');
  check.setAttribute('aria-label',row.status==='DONE'?'Atzīmēt kā nepabeigtu':'Atzīmēt kā pabeigtu');
  const copy=element('div','record-copy');append(copy,element('div','record-title',row.title),append(element('div','record-meta'),source(origin),element('span','',kind==='memory'?'Projekta atmiņa':kind==='goal'?'Mērķis':'Uzdevums'),row.created?element('span','',date(row.created)):null));
  append(div,check,copy,kind==='memory'?null:badge(row.status??'UNKNOWN',/FAIL|BLOCK|WAIT|CANCEL/i.test(row.status)?'gold':''));return div;
}
function heading(title,sub,action){const h=element('div','page-header');append(h,append(element('div'),element('h1','',title),element('p','subtitle',sub)),action);return h;}
function titleRow(title,count,note){return append(element('div','section-title'),append(element('h2'),document.createTextNode(title),element('span','count-label',count??'')),note?element('span','eyebrow',note):null);}
function empty(title,sub){return append(element('div','empty-state'),element('strong','',title),document.createTextNode(sub));}
function quicklinks(){const list=element('div','quicklinks');for(const p of state.providers.filter(p=>p.mode==='manual-web')){const b=button('','quicklink',()=>invoke('provider.open',{id:p.id}));const avatar=window.MNEMOSProviderAvatars?.create(p.id)||element('span','provider-logo',p.id.slice(0,2).toUpperCase());append(b,avatar,append(element('div'),document.createTextNode(p.name),element('small','','Tīmekļa sesija')),element('span','out-arrow','↗'));list.append(b);}return list;}
function statusInstrument(){
  const online=state.core?.online===true,guard=state.core?.guard,modelCount=state.models?.length??0;
  const unit=element('section','dashboard-unit'+(online?'':' offline'));
  unit.setAttribute('aria-label','MNEMOS Core diagnostika');
  const figure=element('div','dashboard-rotor'),svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 112 112');
  svg.setAttribute('aria-hidden','true');
  const shape=(tag,attrs,klass,parent=svg)=>{
    const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));
    if(klass)node.setAttribute('class',klass);
    parent.append(node);return node;
  };
  // Original mid-century service automaton. Decorative motion conveys the live Core state;
  // text next to it is the authoritative status, never a made-up gauge.
  shape('circle',{cx:56,cy:56,r:48,fill:'none',stroke:'#585858','stroke-width':1,'stroke-dasharray':'2 9'});
  shape('path',{d:'M 8 56 H 17 M 95 56 H 104 M 56 8 V 15 M 56 97 V 104',stroke:'#7a7a7a','stroke-width':1,fill:'none'});
  const antenna=shape('g',{},'bot-antenna');
  shape('path',{d:'M56 22 V12',stroke:'#b7b7b7','stroke-width':2,'stroke-linecap':'round'},null,antenna);
  shape('circle',{cx:56,cy:9,r:3.5,fill:'#c8c8c8',stroke:'#666666','stroke-width':1},null,antenna);
  const body=shape('g',{},'bot-body');
  shape('path',{d:'M40 69 L72 69 L74 92 Q56 98 38 92 Z',fill:'#2d2d2d',stroke:'#979797','stroke-width':2},null,body);
  shape('rect',{x:47,y:75,width:18,height:10,rx:2,fill:'#545454',stroke:'#b2b2b2','stroke-width':1},null,body);
  shape('path',{d:'M44 93 L41 103 M68 93 L71 103 M33 104 H48 M64 104 H79',stroke:'#afafaf','stroke-width':3,'stroke-linecap':'round'},null,body);
  shape('path',{d:'M41 71 Q28 72 23 61 M21 61 L15 57',fill:'none',stroke:'#b0b0b0','stroke-width':4,'stroke-linecap':'round'},null,body);
  shape('path',{d:'M14 55 L11 50 M15 55 L16 48 M15 55 L21 52',fill:'none',stroke:'#bdbdbd','stroke-width':1.7,'stroke-linecap':'round'},null,body);
  const arm=shape('g',{},'bot-wave-arm');
  shape('path',{d:'M72 73 Q84 67 88 55 L94 50',fill:'none',stroke:'#b0b0b0','stroke-width':4,'stroke-linecap':'round'},null,arm);
  shape('path',{d:'M93 49 L91 43 M94 49 L97 43 M94 49 L101 47',fill:'none',stroke:'#bdbdbd','stroke-width':1.7,'stroke-linecap':'round'},null,arm);
  const head=shape('g',{},'bot-head');
  shape('path',{d:'M33 32 Q33 23 43 23 H69 Q79 23 79 33 V56 Q79 67 69 67 H43 Q33 67 33 56 Z',fill:'#343434',stroke:'#b4b4b4','stroke-width':2},null,head);
  shape('path',{d:'M30 39 H33 V53 H30 M79 39 H82 V53 H79',stroke:'#909090','stroke-width':3,fill:'none'},null,head);
  shape('ellipse',{cx:45,cy:41,rx:4,ry:5,fill:'#d6d6d6'},'bot-eye',head);
  shape('ellipse',{cx:67,cy:41,rx:4,ry:5,fill:'#d6d6d6'},'bot-eye',head);
  shape('path',{d:'M43 53 Q56 61 69 53 M50 57 V60 M62 57 V60',stroke:'#c7c7c7','stroke-width':1.7,'stroke-linecap':'round',fill:'none'},'bot-mouth',head);
  figure.append(svg);
  const readings=element('div','dashboard-reading');
  const status=online?'CORE '+(state.core.service?.version??'—')+' · SASNIEDZAMS':'CORE · NAV SASNIEDZAMS';
  const resource=guard?.allowModelLoad===false?'Modeļa ielāde ir ierobežota.':modelCount+' lokāli modeļi pieejami atlasē.';
  append(readings,element('strong','',status),
    element('span','',online?'MNEMOS sistēmas stāvoklis':'Lokālā darba telpa turpina darboties.'),
    element('em','',resource));
  unit.append(figure,readings);return unit;
}
function inlineForm(kind,placeholder){const f=element('form','inline-form'),input=element('input');input.placeholder=placeholder;input.required=true;input.maxLength=4000;input.setAttribute('aria-label',placeholder);const b=element('button','secondary','＋ Pievienot');b.type='submit';f.addEventListener('submit',async e=>{e.preventDefault();const value=input.value.trim();if(!value)return;const result=await invoke('item.create',{kind,title:value});if(result)input.value='';});return append(f,input,b);}
function coreList(parent,kind){const rows=state.core?.[kind]??[];append(parent,element('div','section-divider'),titleRow(kind==='goals'?'Mērķi no MNEMOS Core':'Uzdevumi no MNEMOS Core',rows.length,'TIKAI LASĪŠANAI'));if(!rows.length)parent.append(empty('Nav pieejamu ierakstu',state.core?.online?'Core šobrīd neatgriež ierakstus.':'Core nav sasniedzams.'));for(const r of rows.slice(0,8))parent.append(record(r,'Core',kind==='goals'?'goal':'task'));}
function table(headers,rows){const t=element('table','data-table'),head=element('thead'),tr=element('tr'),body=element('tbody');for(const h of headers)tr.append(element('th','',h));head.append(tr);for(const r of rows){const row=element('tr');for(const cell of r)row.append(element('td','',cell));body.append(row);}return append(t,head,body);}
let observationPanel;
function coreObservationPanel(projectId){
  if(observationPanel)return observationPanel;
  const panel=element('section','core-observations');
  const results=element('div','observation-results');
  results.setAttribute('aria-live','polite');
  const query=element('input');
  query.type='search';
  query.placeholder='Meklēt novērojumos';
  query.setAttribute('aria-label','Meklēt novērojumos');
  query.maxLength=80;
  const load=button('Ielasīt no Core','secondary',()=>void refresh());
  async function refresh(){
    load.disabled=true;
    const data=await invoke('observation.list',{project:projectId,q:query.value.trim()});
    load.disabled=false;
    if(panel!==observationPanel)return;
    if(!data){results.replaceChildren(element('p','subtitle','Core atmiņa šim projektam nav pieejama.'));return;}
    results.replaceChildren();
    if(!data.observations.length){results.append(element('p','subtitle','Projektā nav saglabātu lapu novērojumu.'));return;}
    for(const observation of data.observations){
      const details=element('details','observation-record');
      append(details,element('summary','',observation.title),
        element('p','record-meta',`${observation.source.origin} · ${date(observation.storedAt)} · Nepārbaudīts novērojums`),
        element('p','observation-text',observation.text));
      if(data.permissions.includes('delete')){
        const remove=button('Dzēst','secondary',async()=>{
          if(remove.dataset.confirmed!=='true'){
            remove.dataset.confirmed='true';
            remove.textContent='Apstiprināt dzēšanu';
            return;
          }
          remove.disabled=true;
          const receipt=await invoke('observation.delete',{project:projectId,id:observation.id});
          if(receipt?.deleted)details.remove();
          else remove.disabled=false;
        });
        details.append(remove);
      }
      results.append(details);
    }
  }
  load.disabled=query.disabled=state.bridge?.connected!==true;
  const search=append(element('form','inline-form'),query,load);
  search.addEventListener('submit',event=>{event.preventDefault();if(!load.disabled)void refresh();});
  observationPanel=append(panel,titleRow('Lapu novērojumi Core atmiņā',null),search,results);
  return observationPanel;
}

let observationDraftId=null;
async function openObservationReview(tabId){
  const draft=await invoke('observation.preview',{tabId});
  if(!draft)return;
  observationDraftId=draft.requestId;
  $('observation-source').textContent=`${draft.title} · ${draft.url}`;
  $('observation-preview').value=draft.text;
  $('observation-error').hidden=true;
  await invoke('overlay',{visible:true});
  $('observation-dialog').showModal();
}

function renderMain(){
  const main=$('main'),tab=state.tabs.find(t=>t.id===state.activeId);
  // The rejected Core-first visual experiment is opt-in, never the default MNEMOS UI.
  // Preserve the original Atomic Age instrument panel and animations on startup.
  const coreHome=!tab&&state.section==='workspace'&&localStorage.getItem('mnemos.coreFirstPreview')==='1';
  document.body.classList.toggle('core-workspace-mode',coreHome);
  document.body.classList.toggle('coordination-mode',
    !tab&&state.section==='coordination'&&!coreHome);
  document.body.classList.toggle('mn-home',!tab&&state.section==='workspace'&&!coreHome);
  if(!coreHome)window.MNEMOSCoreWorkspace.dispose(main);
  main.classList.toggle('web',!!tab);main.setAttribute('aria-hidden',tab?'true':'false');
  if(coreHome){
    if(mainView!=='core-workspace'){
      mainView='core-workspace';
      window.MNEMOSCoreWorkspace.mount(main,(cmd,payload={})=>api.invoke(cmd,payload));
    }
    return;
  }
  if(tab){if(mainView!=='web'){main.replaceChildren();mainView='web';}return;}
  const signature=JSON.stringify({section:state.section,project:state.activeProject,coordination:state.section==='coordination'?state.coordination:null,council:state.section==='coordination'?state.council:null,tabs:state.tabs.map(t=>({id:t.id,title:t.title,url:t.url,project:t.project,private:t.private,loading:t.loading})),items:state.local.items,core:state.core,providers:state.providers,bus:state.frontier,bridge:state.bridge,models:state.models});
  if(mainView==='home'&&signature===renderedMain)return;
  const focus=document.activeElement,hadInline=focus?.closest('.inline-form'),draft=hadInline?focus.value:null,position=hadInline?focus.selectionStart:null;
  main.replaceChildren();mainView='home';renderedMain=signature;
  const sec=state.section;
  if(displaySection!==sec){displaySection=sec;main.classList.remove('motion-enter');void main.offsetWidth;main.classList.add('motion-enter');clearTimeout(enterTimer);enterTimer=setTimeout(()=>main.classList.remove('motion-enter'),580);}
  append(main,append(element('div','page-kicker'),append(element('div','breadcrumb'),element('span','','MNEMOS'),element('span','slash','/'),element('span','',project()?.name)),element('span','timestamp',state.core?.capturedAt?`Core · ${date(state.core.capturedAt)}`:'Core nav savienots')));
  if(sec==='workspace'){
    append(main,heading(project()?.name??'Darba telpa','Projekti, pārlūkošana un kopīgais darba konteksts.',button('＋ Jauns uzdevums','primary',()=>openDialog('task'))),statusInstrument(),quicklinks());
    const tasks=localItems('task');append(main,titleRow('Projekta uzdevumi',tasks.length,'BROWSER'),element('div','work-panel'));
    if(!tasks.length)main.append(empty('Sāc ar konkrētu darbu','Pievieno uzdevumu vai atver tīmekļa cilni. Konteksts paliks šajā projektā.'));
    for(const row of tasks.slice(0,6))main.append(record(row));
    main.append(inlineForm('task','Ko šajā projektā vēlies paveikt?'));
    const goals=localItems('goal');append(main,element('div','section-divider'),titleRow('Mērķi',goals.length));
    if(!goals.length)main.append(empty('Vēl nav projekta mērķu','Pievieno rezultātu, uz kuru strādāt.'));
    for(const row of goals.slice(0,3))main.append(record(row,'Browser','goal'));
    main.append(button('＋ Pievienot mērķi','secondary',()=>openDialog('goal')));
    coreList(main,'tasks');
  }else if(sec==='goals'){
    append(main,heading('Mērķi un uzdevumi','Rezultāts, nākamais solis un pārbaudāms progress.',button('＋ Jauns mērķis','primary',()=>openDialog('goal'))),titleRow('Projekta mērķi',localItems('goal').length));
    for(const row of localItems('goal'))main.append(record(row,'Browser','goal'));
    main.append(inlineForm('goal','Vēlamais projekta rezultāts'));
    append(main,titleRow('Projekta uzdevumi',localItems('task').length));for(const row of localItems('task'))main.append(record(row));main.append(inlineForm('task','Nākamais konkrētais solis'));coreList(main,'goals');
  }else if(sec==='memory'){
    append(main,heading('Projekta atmiņa','Saglabāti secinājumi un avoti, kas paliek pie projekta.',button('＋ Saglabāt ierakstu','primary',()=>openDialog('memory'))));
    const items=localItems('memory');if(!items.length)main.append(empty('Vieta svarīgajam','Saglabā savu piezīmi vai pabeigtu modeļa atbildi ar avota norādi.'));
    for(const row of items)main.append(record(row,'Browser','memory'));
    main.append(coreObservationPanel(state.activeProject));
    main.append(element('div','notice','Šī ir pārlūka projekta atmiņa. Core ilgtermiņa atmiņa netiek pārrakstīta, un ieraksti netiek automātiski nosūtīti modelim.'));
  }else if(sec==='coordination'){
    append(main,heading('Modeļu sadarbība','Viens pārskatāms projekta uzdevums vairākām ielogotām AI cilnēm.'));
    main.append(coordinationPage());
  }else if(sec==='agents'){
    append(main,heading('Aģenti un modeļi','Piekļuve ir redzama; modelis netiek klusi aizstāts.'));
    for(const p of state.providers){const row=element('div','integration-row');append(row,window.MNEMOSProviderAvatars?.create(p.mode==='local-api'?'local':p.id)||element('span','provider-logo','AI'),append(element('div'),element('strong','',p.name),element('small','',p.mode==='local-api'?`${state.models.length} instalēti lokāli modeļi`:p.mode==='manual-web'?'Lietotāja vadīta tīmekļa sesija':p.reason)),p.mode==='manual-web'?button('Atvērt ↗','secondary',()=>invoke('provider.open',{id:p.id})):badge(p.mode==='local-api'?'LOKĀLS':'NAV AKTIVIZĒTS',p.available?'':'gold'));main.append(row);}
    main.append(perplexityMcpCard());
    main.append(geminiMcpCard());
    main.append(collaborationReviewPanel());
    main.append(handoffCard());
    append(main,element('div','section-divider'),titleRow('Core Frontier sesijas',state.core?.agents?.length??0,'TIKAI LASĪŠANAI'));
    main.append(table(['SESIJA','LOMA','STATUSS'],(state.core?.agents??[]).map(a=>[a.name,a.role,[a.status,a.liveness].filter(Boolean).join(' · ')])));
  }else if(sec==='bus'){
    append(main,heading('Frontier Bus','Esošais MNEMOS ziņojumu protokols pārlūka izolētajā vidē.'));
    const counts=state.frontier.counts,strip=element('div','metric-strip');for(const [value,label] of [[counts.activeSessions,'Aktīvas sesijas'],[counts.messages,'Ziņojumi'],[counts.pending,'Gaida ACK']])strip.append(append(element('div','metric'),element('strong','',value),element('small','',label)));main.append(strip);
    main.append(table(['SESIJA','DZĪVOTSPĒJA','STATUSS'],state.frontier.sessions.map(a=>[a.sessionId,a.liveness,a.status])));
    main.append(element('div','notice','Pabeigta lokālā modeļa atbilde tiek nosūtīta caur šo Bus un apstiprināta ar ACK. Produkcijas Browser Wake netiek iedarbināts.'));
    append(main,element('div','section-divider'),titleRow('Core Bus projekcija','','TIKAI LASĪŠANAI'));
    main.append(table(['RĀDĪTĀJS','VĒRTĪBA'],Object.entries(state.core?.bus??{})));
  }else{
    append(main,heading('Darba vides iestatījumi','MNEMOS Browser 0.1 · izstrādes vertikālais griezums.'));
    const uiReload=button('Pārlādēt MNEMOS saskarni','secondary',async()=>{
      // Only the privileged Electron shell reloads; authenticated tabs stay open.
      const result=await invoke('ui.reload',{});
      if(!result?.scheduled)showError('Neizdevās pārlādēt MNEMOS saskarni.');
    });
    uiReload.title='Atjauno MNEMOS dizainu un skriptus; ielogotās AI cilnes netiek pārlādētas.';
    main.append(uiReload);
    // Process fingerprint comes from main.mjs at boot, not from a file edited later.
    if(!state.runtime?.mainBuild)main.append(element('p','notice gold','Aktīvā Electron procesa versija nav nosakāma. Lai ielādētu atjaunināto galveno procesu, nepieciešams pārlūka restarts.'));
    if(state.runtime?.profileLocation==='LEGACY_INSIDE_PACKAGE')main.append(element('p','notice gold',
      'Aktīvā autentificētā sesija glabājas vecajā instalācijas mapē. To nedrīkst kopēt izlaidumā vai pārvietot, kamēr pārlūks darbojas. Automātiska migrācija ir atspējota.'));
    main.append(table(['IESTATĪJUMS','PAŠREIZĒJAIS STĀVOKLIS'],[['Aktīvā procesa SHA-256',state.runtime?.mainBuild??'Nav pieejams'],['Processa palaišana',state.runtime?.startedAt??'Nav pieejams'],['Sesijas glabāšana',({APPDATA:'Lietotāja AppData',EXPLICIT:'Norādīts profils',TEST_ISOLATED:'Izolēts tests',LEGACY_INSIDE_PACKAGE:'Vecajā instalācijas mapē'})[state.runtime?.profileLocation]??'Nav zināms'],['Core',state.core?.origin??'http://127.0.0.1:4320'],['Core piekļuve','Sistēmas dati un projekta novērojumi ar piešķirtu atļauju'],['Frontier Bus','Izolēta pārlūka glabātuve'],['Tīmekļa sesijas','Atsevišķi katram projektam'],['Lokālā modeļa izpilde','Viena vienlaicīga izpilde; 120 s termiņš'],['Maksas API','Deaktivizēti'],['Ārējas darbības','AI uzvednes: bez loga; cita nosūtīšana: ar atļauju' ],['Meklētājs','DuckDuckGo; tikai pēc Enter'],['Automātiska konteksta nosūtīšana','Izslēgta'],['Diagnostika',state.testMode?'TESTA REŽĪMS':'Nav attālinātās atkļūdošanas porta']]));
    main.append(perplexityMcpCard());
    main.append(geminiMcpCard());
    main.append(collaborationReviewPanel());
    main.append(handoffCard());
    if(state.bridge){
      const b=state.bridge,card=element('div','work-panel');
      append(main,element('div','section-divider'),
        titleRow('ChatGPT ↔ MNEMOS Browser','','CORE FRONTIER BUS'),
        element('p','subtitle','Tiešs savienojums caur esošo MNEMOS Core Frontier Bus.'));
      append(card,append(element('div','integration-row'),
        append(element('div'),element('strong','',b.connected?'Savienots ar Core':b.enabled?'Savienojums nav pieejams':'Nav pieslēgts'),
          element('small','',b.sessionId)),
        button(b.enabled?'Atvienot':'Savienot','secondary',()=>invoke(b.enabled?'bridge.disable':'bridge.enable'))),
        element('p','notice',b.enabled?'Savienojums ļauj lasīt neprivātas cilnes. Aģenta ievadei, klikšķiem, failu pievienošanai un cilņu atvēršanai vai atlasīšanai vajadzīga Core atļauja. Cilņu navigācijai un atkopšanai vajadzīgs lokāls apstiprinājums. Pieprasījumu nosūtīšana ChatGPT, Gemini un Perplexity pašu AI čatam neprasa atsevišķu logu; tas ir deleģēts modeļa izsaukums. Pieteikumi, publiski ieraksti un citu vietņu formas joprojām prasa atļauju. Pārāk biežas AI uzvednes īslaicīgi pārslēdzas uz apstiprināšanas režīmu. Failu pievienošanai nepieciešama tava izvēle Windows failu dialogā; vietne failu var augšupielādēt uzreiz.':'Savienošana ir brīvprātīga. Bez tās ārēja piekļuve cilnēm ir izslēgta.'),
        element('p','subtitle','Atļautais kontrolieris: '+b.peer),
        b.error?element('p','notice gold','Savienojuma kļūda: '+b.error):null);
      main.append(card);
    }
    main.append(element('div','notice gold','Publiskai izplatīšanai vēl vajadzīga parakstīta pakotne, droši atjauninājumi un plašāka vietņu, autentifikācijas un drošības pārbaude.'));
  }
  if(hadInline&&draft!=null){const next=main.querySelector('.inline-form input');if(next){next.value=draft;next.focus();next.setSelectionRange(position,position);}}
}
function renderContext(){
  const body=$('context-body'),items=localItems(),t=state.tabs.find(t=>t.id===state.activeId);body.replaceChildren();
  const contextProject=append(element('div','context-project'),element('span','project-color'),document.createTextNode(project()?.name??'MNEMOS'));const activeProvider=!t?.private&&window.MNEMOSProviderAvatars?.tabProvider(t?.url);if(activeProvider)contextProject.append(window.MNEMOSProviderAvatars.create(activeProvider,{size:'small'}));body.append(contextProject);
  for(const [label,value] of [['Projekta uzdevumi',items.filter(i=>i.kind==='task'&&i.status!=='DONE').length],['Saglabātā atmiņa',items.filter(i=>i.kind==='memory').length],['Tīmekļa sesija',t?.private?'Privāta':t?'Projekta profils':'Projekta profils']])body.append(append(element('div','context-line'),element('span','',label),element('strong','',value)));
  if(t)body.append(append(element('div','context-url'),element('span','','AKTĪVĀ CILNE'),document.createTextNode(t.url)));
  if(t&&!t.private&&t.project===state.activeProject){
    try{const u=new URL(t.url);if(u.protocol==='https:'&&u.hostname==='gemini.google.com'&&/^\/app(?:\/[a-zA-Z0-9-]+)?$/.test(u.pathname))body.append(button('Gemini → MNEMOS koordinācija','secondary',openGeminiCoordination));}catch{}
  }
  body.append(element('p','context-scope',t?.private?'Privātā cilne netiek atjaunota pēc lietotnes aizvēršanas.':'Konteksts pieder projektam. Tu izvēlies, ko saglabāt un nodot tālāk.'));
  if(t&&!t.private&&state.bridge?.connected===true){
    const save=button('Saglabāt iezīmēto tekstu','secondary',()=>openObservationReview(t.id));
    save.id='review-observation';
    save.disabled=t.loading||!!t.error;
    body.append(save);
  }
  if(attachmentProject!==state.activeProject){attached.clear();attachmentProject=state.activeProject;attachmentSignature='';}
  const memories=localItems('memory').slice(0,4),as=JSON.stringify(memories);
  if(as!==attachmentSignature){const attachments=$('context-attachments');attachments.replaceChildren();if(memories.length){attachments.append(element('span','attachment-heading','Pievienot projekta atmiņu šim pieprasījumam'));for(const m of memories){const label=element('label','attachment'),check=element('input');check.type='checkbox';check.value=m.id;check.checked=attached.has(m.id);check.addEventListener('change',()=>check.checked?attached.add(m.id):attached.delete(m.id));append(label,check,element('span','',m.title.slice(0,70)+(m.title.length>70?'…':'')));attachments.append(label);}}attachmentSignature=as;}
  const signature=JSON.stringify(state.models);
  if(signature!==lastModels){const previous=$('model').value||currentModel;$('model').replaceChildren();if(!state.models.length){$('model').append(new Option('Nav lokāla modeļa',''));}for(const m of state.models)$('model').append(new Option(m.id,m.id));if(state.models.some(m=>m.id===previous))$('model').value=previous;lastModels=signature;}
  const resourceBlocked=state.core?.guard?.allowModelLoad===false||state.core?.guard?.level==='CRITICAL';
  $('send').disabled=!state.models.length||resourceBlocked;
  document.querySelector('.composer-note').textContent=resourceBlocked?`Core neatļauj modeļa ielādi (${state.core.guard.level}; RAM ${Math.round(state.core.resources?.ramPercent??0)}%). Lapas saturs netiek sūtīts automātiski.`:'Lapas saturs modelim netiek nosūtīts automātiski.';
  const turn=state.local.turns.find(t=>t.project===state.activeProject),cs=JSON.stringify({turn:turn??null,models:state.models.length});
  if(cs!==renderedConversation||lastTurnId!==state.activeProject){renderedConversation=cs;lastTurnId=state.activeProject;const c=$('conversation');c.replaceChildren();if(!turn)append(c,append(element('div','assistant-empty'),element('strong','','Sāc ar skaidru jautājumu.'),document.createTextNode(state.models.length?'Izvēlies lokālo modeli un sāc darbu. Atbildi varēsi saglabāt projekta atmiņā.':'Ollama šobrīd neatgriež instalētus lokālus modeļus. Tīmekļa AI sesijas vari atvērt darba telpā.')));else{append(c,element('div','message-prompt',turn.prompt),element('div','message-output',turn.output||'Gaida modeļa atbildi…'),element('div','turn-status',`${turn.model} · ${turn.status}`));if(turn.reason)c.append(element('p','turn-reason',turn.reason));if(turn.status==='COMPLETED')c.append(button('▤ Saglabāt atmiņā','remember',()=>invoke('turn.remember',{id:turn.id})));if(['RUNNING','QUEUED'].includes(turn.status))c.append(button('Pārtraukt','cancel-turn',()=>invoke('turn.cancel',{id:turn.id})));}c.scrollTop=c.scrollHeight;}
}
function render(next){
  if(next.activeProject!==state?.activeProject||next.bridge?.connected!==state?.bridge?.connected)observationPanel=null;
  state=next;const t=state.tabs.find(t=>t.id===state.activeId);
  const ts=JSON.stringify({tabs:state.tabs.map(t=>({id:t.id,title:t.title,url:t.url,private:t.private,loading:t.loading})),active:state.activeId});
  if(tabSignature!==ts){const list=$('tabs');list.replaceChildren();const home=button('','tab '+(state.activeId==='home'?'active':''),()=>invoke('tab.select',{id:'home'}));append(home,element('span','tab-glyph','▦'),element('span','tab-title','Darba telpa'));home.setAttribute('role','tab');home.setAttribute('aria-selected',state.activeId==='home');list.append(home);for(const tab of state.tabs){const b=button('','tab '+(tab.id===state.activeId?'active':''),()=>invoke('tab.select',{id:tab.id}));b.setAttribute('role','tab');b.setAttribute('aria-selected',tab.id===state.activeId);b.title=tab.title;const provider=!tab.private&&window.MNEMOSProviderAvatars?.tabProvider(tab.url);append(b,provider?window.MNEMOSProviderAvatars.create(provider,{size:'small'}):element('span','tab-glyph'+(tab.loading?' loading':''),tab.loading?'◌':tab.private?'◉':'◈'),element('span','tab-title',tab.title));const close=element('span','tab-close','×');close.setAttribute('aria-hidden','true');close.addEventListener('click',e=>{e.stopPropagation();invoke('tab.close',{id:tab.id});});b.append(close);b.addEventListener('auxclick',e=>{if(e.button===1)invoke('tab.close',{id:tab.id});});list.append(b);}tabSignature=ts;}
  if(document.activeElement!==$('address'))$('address').value=t?.url??'';
  $('address-icon').textContent=t?'◇':'⌕';$('back').disabled=!t?.canBack;$('forward').disabled=!t?.canForward;$('reload').disabled=!t;$('reload').textContent=t?.loading?'×':'↻';
  $('core-state').textContent=state.core?.online?`Core ${state.core.service.version}`:'Core bezsaistē';document.querySelector('.core-badge .status-dot').classList.toggle('offline',!state.core?.online);
  for(const b of document.querySelectorAll('[data-section]'))b.classList.toggle('active',state.section===b.dataset.section&&state.activeId==='home');
  const p=$('projects');p.replaceChildren();for(const project of state.local.projects){const b=button('','project-link '+(project.id===state.activeProject?'active':''),()=>invoke('project.select',{id:project.id}));append(b,element('span','project-color'),element('span','project-name',project.name),element('span','project-count',state.tabs.filter(t=>t.project===project.id).length||''));p.append(b);}
  $('status-text').textContent=state.testMode?'Pārbaudes režīms · kontrolēti testa pakalpojumi':t?.error?`Cilnes kļūda: ${t.error}`:state.core?.online?'Core savienots · Browser 0.1':'Core nav sasniedzams · lokālā darba telpa pieejama';
  renderMain();renderContext();window.MNEMOSRobotPersona?.update(next,statusInstrument);window.MNEMOSProviderAvatars?.refresh(document,next);
  if(state.error)showError(state.error);else $('toast').hidden=true;
}
$('address-form').addEventListener('submit',e=>{e.preventDefault();invoke('tab.navigate',{input:$('address').value,...(state.activeId==='home'?{}:{id:state.activeId})});$('address').blur();});
$('address').addEventListener('focus',e=>e.target.select());
$('back').onclick=()=>invoke('tab.back',{id:state.activeId});$('forward').onclick=()=>invoke('tab.forward',{id:state.activeId});$('reload').onclick=()=>invoke('tab.reload',{id:state.activeId});
$('new-tab').onclick=async()=>{await invoke('tab.select',{id:'home'});$('address').focus();};
$('private-tab').onclick=()=>invoke('tab.open',{input:$('address').value||'https://duckduckgo.com/',private:true});
$('refresh-core').onclick=()=>invoke('refresh').then(next=>{if(next)render(next);});
$('new-project').onclick=()=>openDialog('project');$('settings').onclick=()=>invoke('section',{name:'settings'});
$('nav').addEventListener('click',e=>{const b=e.target.closest('[data-section]');if(b)invoke('section',{name:b.dataset.section});});
$('minimize').onclick=()=>invoke('window.minimize');$('maximize').onclick=()=>invoke('window.maximize');$('close-window').onclick=()=>invoke('window.close');
$('toast').onclick=()=>{$('toast').hidden=true;invoke('error.clear');};
$('dialog-cancel').onclick=()=>$('input-dialog').close();
$('input-form').addEventListener('submit',async e=>{e.preventDefault();const value=$('dialog-input').value.trim();if(!value)return;const result=await dialogAction(value);if(result)$('input-dialog').close();});
$('prompt-form').addEventListener('submit',async e=>{e.preventDefault();const prompt=$('prompt').value.trim(),model=$('model').value;if(!prompt||!model)return;currentModel=model;const result=await invoke('turn.submit',{prompt,model,key:crypto.randomUUID(),contextIds:[...attached]});if(result)$('prompt').value='';});
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){$('prompt-form').requestSubmit();}});
api.subscribe(render);
api.onFocusAddress(()=>{$('address').focus();$('address').select();});
$('input-dialog').addEventListener('close',()=>invoke('overlay',{visible:false}));
$('handoff-cancel').onclick=()=>$('handoff-dialog').close();
$('handoff-dialog').addEventListener('close',()=>{handoffNonce=null;invoke('overlay',{visible:false});});
$('handoff-insert').onclick=async()=>{
  const nonce=handoffNonce;
  if(!nonce)return;
  handoffNonce=null;
  $('handoff-insert').disabled=true;
  $('handoff-dialog').close();
  await invoke('overlay',{visible:false});
  const result=await invoke('perplexity.handoff.insert',{nonce});
  $('handoff-insert').disabled=false;
  if(result?.ok){
    $('toast').textContent='Konteksts ievietots Perplexity melnrakstā. Tas NAV nosūtīts.';
    $('toast').hidden=false;
  }
};

$('observation-cancel').onclick=()=>$('observation-dialog').close();
$('observation-dialog').addEventListener('cancel',event=>{if($('observation-save').disabled)event.preventDefault();});
$('observation-dialog').addEventListener('close',()=>{
  if(observationDraftId)void invoke('observation.discard',{requestId:observationDraftId});
  observationDraftId=null;
  $('observation-preview').value='';
  void invoke('overlay',{visible:false});
});
$('observation-save').onclick=async()=>{
  if(!observationDraftId)return;
  const save=$('observation-save'), cancel=$('observation-cancel'), error=$('observation-error');
  save.disabled=cancel.disabled=true;
  error.hidden=true;
  const receipt=await api.invoke('observation.save',{requestId:observationDraftId}).catch(failure=>{
    error.textContent=String(failure.message).replace(/^Error invoking remote method '[^']+': Error: /,'');
    error.hidden=false;
    return null;
  });
  save.disabled=cancel.disabled=false;
  if(receipt?.observation){
    $('observation-dialog').close();
    $('toast').textContent='Novērojums saglabāts Core atmiņā.';
    $('toast').hidden=false;
  }
};

const bootStarted=performance.now();
function finishBoot(){const hold=window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:770;setTimeout(()=>$('boot-stage')?.classList.add('ready'),Math.max(0,hold-(performance.now()-bootStarted)));}
api.invoke('snapshot').then(snapshot=>{render(snapshot);finishBoot();}).catch(error=>{showError(error.message);finishBoot();});
