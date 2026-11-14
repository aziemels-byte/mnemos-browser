/* MNEMOS · Living Conversation Presence
 * React Bits FaultyTerminal + GlitchText + FuzzyText.
 * This is a reactive simulated organism / interaction layer, NOT a source of
 * model private reasoning. Modes use only observable MNEMOS task/council data.
 * Absolutely no browser control, provider calls, user-message interception,
 * recording or network access. All text is rendered as plain React text.
 */
(function(){
  'use strict';
  const React=window.React,ReactDOM=window.ReactDOM;
  const h=React?.createElement;
  const roots={current:null};
  let host=null,stage=null,mode='booting',signature='',position='',disposed=false,
    latestState=null,promptFocused=false,
    backend='not-mounted',lastCaptured=null;
  const PROVIDERS=Object.freeze({
    'chatgpt.com':'ChatGPT','gemini.google.com':'Gemini',
    'perplexity.ai':'Perplexity','www.perplexity.ai':'Perplexity'
  });
  const PHASES=Object.freeze({
    idle:'SAIKNE AKTĪVA',listening:'SAIKNE ATVĒRTA',waiting:'GAIDA ATBILDI',planning:'VEIDO MARŠRUTU',
    transmitting:'NODOD UZDEVUMU',reading:'UZTVER ATBILDI',
    verifying:'PĀRBAUDA ATBILDI',captured:'ATBILDE NOLASĪTA',
    thinking:'LOKĀLAIS MODELIS STRĀDĀ',offline:'CORE NAV SASNIEDZAMS',
    error:'DARBĪBA APTURĒTA'
  });
  const BUSY=new Set(['waiting','planning','transmitting','reading','verifying','thinking']);
  const LIMITED = value=>String(value??'').replace(/\s+/gu,' ').trim().slice(0,190);
  function providerForTab(state){
    const tab=state?.tabs?.find(t=>t.id===state.activeId);
    if(!tab?.url)return null;
    try {
      const url=new URL(tab.url);
      return url.protocol==='https:'?PROVIDERS[url.hostname]??null:null;
    }catch{return null;}
  }
  function inspect(state){
    const council=state?.council||null;
    const last=Array.isArray(council?.turns)?council.turns.at(-1):null;
    const coreOnline=state?.core?.online===true;
    const provider=providerForTab(state);
    const recentReply=[...(council?.turns??[])].reverse()
      .find(t=>t?.status==='CAPTURED'&&typeof t.answer==='string'&&t.answer.trim());
    const localTurn=(state?.local?.turns??[]).find(t=>t.project===state?.activeProject);
    const localReply=localTurn?.status==='COMPLETED'&&
      typeof localTurn.output==='string'&&localTurn.output.trim()?{
        id:String(localTurn.id||'local'),
        model:String(localTurn.model||'MNEMOS').slice(0,30),
        text:LIMITED(localTurn.output)
      }:null;
    const reply=recentReply?{
      id:String(recentReply.id),model:String(recentReply.model||'AI').slice(0,30),
      text:LIMITED(recentReply.answer)
    }:localReply;
    let phase='idle',detail=provider?'PĀRLŪKA SARUNA · '+provider:'SARUNAS TELPA',label=provider||'MNEMOS';
    if(state?.error || ['SEND_UNCERTAIN_NO_RETRY','BLOCKED_UNVERIFIED','RESPONSE_UNVERIFIED'].includes(council?.status)){
      phase='error';detail='NEPĀRSŪTA ZIŅOJUMUS AUTOMĀTISKI';
    }else if(council&&['RUNNING','RECONCILING','STOP_REQUESTED'].includes(council.status)){
      label=String(last?.model||'MNEMOS').slice(0,35);
      const turnStatus=last?.status;
      if(council.status==='RECONCILING'||turnStatus==='RECONCILING'){
        phase='verifying';detail='ATBILDES IZCELSMES PĀRBAUDE';
      }else if(turnStatus==='AWAITING_RESPONSE'){
        phase='waiting';detail='GAIDA FAKTISKU MODEĻA ATBILDI';
      }else if(turnStatus==='CAPTURED'){
        phase='planning';detail='ATBILDE SAŅEMTA · IZVĒLAS NĀKAMO';
      }else{
        phase='transmitting';detail='NOSŪTĪŠANAS STĀVOKLIS';
      }
    }else {
      const active=localTurn?.status==='RUNNING'?localTurn:null;
      if(active){phase='thinking';detail='LOKĀLĀ MODEĻA IZPILDE';label='MNEMOS';}
      else if(localTurn?.status==='QUEUED'){phase='planning';detail='LOKĀLAIS MODELIS GAIDA';label='MNEMOS';}
      else if(reply){phase='captured';detail='FAKTISKI NOLASĪTA ATBILDE';label=reply.model;}
      else if(!coreOnline){phase='offline';detail='CORE SAVIENOJUMS NAV AKTĪVS';}
      else if(promptFocused){phase='listening';detail='IEVADES LAUKS AKTĪVS';}
    }
    return {phase,label,detail,reply,provider};
  }
  function Presence({view,onReady,onFailure}){
    const Faulty=window.MNEMOSFaultyTerminal;
    const Glitch=window.MNEMOSGlitchText;
    const Fuzzy=window.MNEMOSFuzzyText;
    const busy=BUSY.has(view.phase);
    const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true;
    return h(React.Fragment,null,
      Faulty?h(Faulty,{
        className:'mn-presence-faulty',
        tint:view.phase==='error'?'#b1887e':'#b6ab96',
        scale:1.2,gridMul:[1.05,.8],digitSize:1.35,
        timeScale:reduced?0:busy?.18:.045,
        scanlineIntensity:.11,
        glitchAmount:reduced?0:busy?.23:.045,
        flickerAmount:reduced?0:busy?.14:.025,
        noiseAmp:.18,
        chromaticAberration:.004,
        dither:.28,curvature:.055,
        mouseReact:!reduced,mouseStrength:.22,
        pageLoadAnimation:false,
        brightness:busy?.24:.17,
        glyphs:'characters',glow:busy?.24:.13,persistence:.25,
        scramble:busy?.24:.09,
        mouseGlow:busy?.21:.13,vignette:.5,
        clickEffect:reduced?'none':'glitch',
        variation:.42,dpr:1,lightMode:false,
        onReady,onFailure
      }):null,
      h('div',{className:'mn-presence-overlay'},
        h('div',{className:'mn-presence-overline'},
          h('span',null,'MNEMOS · PRESENCE'),
          h('span',{className:'mn-presence-dot','aria-hidden':true},
            view.phase==='error'?'!':'●')),
        h('div',{className:'mn-presence-life'},
          Glitch&&!reduced?h(Glitch,{
            key:view.phase+':'+view.label,
            mode:'slices',intensity:busy?.19:.06,
            offset:busy?4:2,speed:.45,
            enableShadows:false,enableOnHover:true,
            trigger:busy?'always':'hover',
            burstDuration:.44,
            fontSize:'clamp(1.15rem, 3vw, 2.1rem)',
            fontWeight:650,className:'mn-presence-glitch',
            color:'#e8dcc2'
          },PHASES[view.phase]):h('strong',{className:'mn-presence-plain'},PHASES[view.phase]),
          h('span',{className:'mn-presence-sub'},view.label)),
        view.reply?h('div',{className:'mn-presence-reply',key:view.reply.id},
          h('span',{className:'mn-presence-reply-head'},
            'NOLASĪTS · '+view.reply.model),
          Glitch&&!reduced?h(Glitch,{
            key:'received:'+view.reply.id,mode:'slices',
            trigger:'hover',intensity:.085,speed:.45,offset:2,
            enableShadows:false,fontSize:12,fontWeight:600,
            className:'mn-presence-reply-glitch',color:'#eee6d4'
          },view.reply.text.slice(0,56)):
            h('strong',{className:'mn-presence-reply-glitch'},view.reply.text.slice(0,56)),
          h('p',null,view.reply.text)
        ):h('div',{className:'mn-presence-muted'},
          Fuzzy&&!reduced?h(Fuzzy,{
            fontSize:17,fontWeight:550,fontFamily:'Consolas, monospace',
            color:'#c2b6a0',enableHover:true,baseIntensity:.025,
            hoverIntensity:.15,fuzzRange:8,fps:18,
            direction:'horizontal',trigger:'hover',intro:false,
            className:'mn-presence-fuzzy'
          },'SIGNĀLS / '+(busy?'AKTĪVS':'MIERS')):
          h('span',null,'SIGNĀLS / '+(busy?'AKTĪVS':'MIERS'))),
        h('div',{className:'mn-presence-foot'},
          h('span',null,view.detail),
          h('span',null,'REĀLI STĀVOKĻI · VIZUĀLA SIMULĀCIJA'))
      ));
  }
  function ensureHost(){
    if(host)return host;
    host=document.createElement('section');
    host.className='mn-presence';
    host.setAttribute('aria-label','MNEMOS dzīvais sarunas interfeiss');
    host.dataset.phase='idle';host.dataset.backend='waiting';
    stage=document.createElement('div');stage.className='mn-presence-stage';
    host.append(stage);
    return host;
  }
  function mount(){
    if(!host?.isConnected||!React||!ReactDOM?.createRoot||!window.MNEMOSFaultyTerminal)return;
    if(roots.current)return;
    try{roots.current=ReactDOM.createRoot(stage);backend='react-initializing';}
    catch(error){backend='fallback';host.dataset.backend='fallback';console.error('MNEMOS Presence React:',String(error?.message||error));}
  }
  function show(view){
    if(!roots.current)return;
    try{
      roots.current.render(h(Presence,{
        view,
        onReady:()=>{
          if(disposed)return;
          host.dataset.backend='react-webgl2';backend='react-webgl2';
        },
        onFailure:reason=>{
          if(disposed)return;
          host.dataset.backend='fallback';backend='fallback';
          console.warn('MNEMOS Presence GPU fallback:',String(reason));
        }
      }));
    }catch(error){backend='fallback';host.dataset.backend='fallback';}
  }
  function update(state){
    if(disposed||!state)return;
    latestState=state;
    const tab=providerForTab(state);
    const activeTab=state.tabs?.find(t=>t.id===state.activeId);
    const section=state.section==='coordination'&&!activeTab;
    const localTurn=(state.local?.turns??[]).find(t=>t.project===state.activeProject);
    const enabled=!!tab||section||!!localTurn||promptFocused;
    const body=document.body;
    body.classList.toggle('mn-presence-visible',enabled);
    if(!enabled){
      if(host)host.hidden=true;
      return;
    }
    ensureHost();
    const main=document.getElementById('main');
    const aside=document.getElementById('context');
    const contextBody=document.getElementById('context-body');
    const header=main?.querySelector('.page-header');
    const place=section?'coordination':'chat';
    if(place==='coordination'&&header){
      if(host.parentNode!==main||host.previousSibling!==header)header.after(host);
    }else if(place==='chat'&&aside&&contextBody){
      if(host.parentNode!==aside||host.nextSibling!==contextBody)aside.insertBefore(host,contextBody);
    }else return;
    host.hidden=false;
    if(position!==place){position=place;signature='';}
    const view=inspect(state);
    host.dataset.phase=view.phase;
    const next=JSON.stringify([view.phase,view.label,view.detail,view.reply?.id,view.reply?.text]);
    if(signature===next)return;
    signature=next;
    mount();show(view);
  }
  function dispose(){
    if(disposed)return;disposed=true;
    try{roots.current?.unmount();}catch{}
    roots.current=null;host?.remove();
    document.body.classList.remove('mn-presence-visible');
    composer?.removeEventListener('focus',onFocus);
    composer?.removeEventListener('blur',onBlur);
  }
  // Local text composer is an authentic user interaction signal, not AI
  // reasoning. Never read or save its contents. Only observe focus state.
  const composer=document.getElementById('prompt');
  const onFocus=()=>{promptFocused=true;if(latestState)update(latestState);};
  const onBlur=()=>{promptFocused=false;if(latestState)update(latestState);};
  composer?.addEventListener('focus',onFocus);
  composer?.addEventListener('blur',onBlur);
  window.MNEMOSLivingConversation=Object.freeze({
    update,dispose,inspect,
    get backend(){return backend;},
    get phase(){return host?.dataset.phase||'hidden';},
    get location(){return position||'none';}
  });
})();
