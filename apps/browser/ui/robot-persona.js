/* MNEMOS / ATOMIC AGE — living automaton.
 * Animates the EXISTING approved monochrome SVG service robot, never replaces
 * it with a generated graphic or changes the global color palette.
 * Modes depend on observable MNEMOS state; NO invented model reasoning.
 * No network requests, browser actions, audio, WebGL, user-text storage.
 */
(function(){
  'use strict';
  const moods=Object.freeze({
    idle:'Esmu šeit',listening:'Klausos',working:'Strādāju',
    speaking:'Veidoju atbildi',waiting:'Gaida AI atbildi',
    checking:'Pārbauda atbildi',planning:'Izvēlas nākamo modeli',
    happy:'Atbilde saņemta',offline:'Core bezsaistē',
    error:'Nepieciešama pārbaude'
  });
  let focused=false,lastState=null,eyeSeed=0x6d6e656d,blinkTimer=0,
    greetingTimer=0,blinkReset=0;
  const reduced=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches===true;
  const random=()=>{
    eyeSeed^=eyeSeed<<13;eyeSeed^=eyeSeed>>>17;eyeSeed^=eyeSeed<<5;
    return (eyeSeed>>>0)/4294967296;
  };
  function moodFrom(state){
    if(!state||typeof state!=='object')return'idle';
    const council=state.council;
    const last=Array.isArray(council?.turns)?council.turns.at(-1):null;
    if(state.error||council&&
       ['SEND_UNCERTAIN_NO_RETRY','RESPONSE_UNVERIFIED','BLOCKED_UNVERIFIED'].includes(council.status))
      return'error';
    if(council?.status==='RECONCILING'||last?.status==='RECONCILING')return'checking';
    if(council&&['RUNNING','STOP_REQUESTED'].includes(council.status)){
      if(last?.status==='AWAITING_RESPONSE')return'waiting';
      if(last?.routing?.status==='THINKING'||last?.status==='CAPTURED')return'planning';
      return'working';
    }
    const local=state.local?.turns?.find(t=>t.project===state.activeProject);
    if(local?.status==='RUNNING')return String(local.output??'').length?'speaking':'working';
    if(local?.status==='QUEUED')return'planning';
    if(focused)return'listening';
    if(local?.status==='COMPLETED')return'happy';
    if(state.core?.online===false)return'offline';
    return'idle';
  }
  function bind(figure){
    if(!figure||figure.dataset.robotBound==='yes')return;
    figure.dataset.robotBound='yes';
    figure.addEventListener('pointermove',event=>{
      if(reduced())return;
      const r=figure.getBoundingClientRect();
      if(!r.width||!r.height)return;
      const x=Math.max(-1.5,Math.min(1.5,(event.clientX-r.left-r.width/2)/r.width*3));
      const y=Math.max(-1.0,Math.min(1.0,(event.clientY-r.top-r.height/2)/r.height*2));
      figure.style.setProperty('--mn-robot-look-x',x.toFixed(2)+'px');
      figure.style.setProperty('--mn-robot-look-y',y.toFixed(2)+'px');
    },{passive:true});
    figure.addEventListener('pointerleave',()=>{
      figure.style.removeProperty('--mn-robot-look-x');
      figure.style.removeProperty('--mn-robot-look-y');
    });
    const wave=()=>{
      if(reduced())return;
      figure.classList.remove('mn-robot-greeting');
      void figure.offsetWidth;
      figure.classList.add('mn-robot-greeting');
      clearTimeout(greetingTimer);
      greetingTimer=setTimeout(()=>figure.classList.remove('mn-robot-greeting'),1300);
    };
    figure.addEventListener('click',wave);
    figure.addEventListener('keydown',event=>{
      if(event.key==='Enter'||event.key===' '){event.preventDefault();wave();}
    });
  }
  function ensureSidebar(factory){
    const heading=document.querySelector('.assistant-heading');
    if(!heading||typeof factory!=='function')return;
    let figure=heading.querySelector('.mn-robot-presence');
    if(figure)return figure;
    const original=heading.querySelector('.assistant-orb');
    if(!original)return;
    const shell=factory();
    figure=shell?.querySelector('.dashboard-rotor');
    if(!figure?.querySelector('svg'))return;
    figure.classList.add('mn-robot-presence');
    figure.tabIndex=0;
    figure.setAttribute('role','button');
    figure.setAttribute('aria-label','MNEMOS robots. Nospied Enter, lai robots pamātu.');
    original.replaceWith(figure);
    const caption=document.createElement('small');
    caption.className='mn-robot-state';
    caption.setAttribute('role','status');
    caption.setAttribute('aria-live','polite');
    heading.querySelector('div:not(.mn-robot-presence)')?.append(caption);
    return figure;
  }
  function render(factory){
    if(!lastState)return;
    ensureSidebar(factory);
    const mood=moodFrom(lastState);
    for(const node of document.querySelectorAll('.dashboard-rotor')){
      node.dataset.robotMood=mood;
      node.title='MNEMOS · '+moods[mood];
      bind(node);
    }
    const caption=document.querySelector('.assistant-heading .mn-robot-state');
    if(caption&&caption.textContent!==moods[mood])caption.textContent=moods[mood];
  }
  function blink(){
    clearTimeout(blinkTimer);
    blinkTimer=setTimeout(()=>{
      if(!document.hidden&&!reduced()){
        for(const node of document.querySelectorAll('.dashboard-rotor')){
          node.classList.add('mn-robot-blink');
        }
        clearTimeout(blinkReset);
        blinkReset=setTimeout(()=>{
          for(const node of document.querySelectorAll('.dashboard-rotor'))
            node.classList.remove('mn-robot-blink');
        },180);
      }
      blink();
    },4000+Math.floor(random()*4600));
  }
  const onVisibility=()=>{if(document.hidden){clearTimeout(blinkTimer);clearTimeout(blinkReset);}
    else blink();};
  document.addEventListener('visibilitychange',onVisibility);
  const prompt=document.getElementById('prompt');
  prompt?.addEventListener('focus',()=>{focused=true;if(lastState)render(lastFactory);});
  prompt?.addEventListener('blur',()=>{focused=false;if(lastState)render(lastFactory);});
  let lastFactory=null;
  blink();
  window.MNEMOSRobotPersona=Object.freeze({
    describe:moodFrom,
    update(state,factory){
      lastState=state;lastFactory=factory;
      render(factory);
    },
    dispose(){
      clearTimeout(blinkTimer);clearTimeout(blinkReset);clearTimeout(greetingTimer);
      document.removeEventListener('visibilitychange',onVisibility);
    }
  });
})();
