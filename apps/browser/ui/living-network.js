/* MNEMOS / Living Neural Core
 * A permanent state-linked visual organism, not an activity simulator.
 * No model inference, storage, browser automation or network access.
 * Deterministic geometry; 1 rAF; throttled + paused when hidden/off-screen.
 */
(function(){
  'use strict';
  const MODES=Object.freeze({
    booting:'INICIALIZĒ',
    disconnected:'CORE NAV SASNIEDZAMS',
    idle:'CORE GATAVS',
    planning:'PLĀNO',
    retrieving:'IEGŪST DATUS',
    executing:'IZPILDA',
    multi_agent:'AĢENTI SADARBOJAS',
    validating:'PĀRBAUDA',
    completed:'PABEIGTS',
    error:'KĻŪDA'
  });
  const ACTIVE=new Set(['planning','retrieving','executing','multi_agent','validating']);
  const host=document.createElement('section');
  host.className='mn-organism';
  host.setAttribute('aria-label','MNEMOS sistēmas aktivitātes vizualizācija');
  const header=document.createElement('div');header.className='mn-organism-heading';
  const title=document.createElement('span');title.textContent='MNEMOS / NEURAL CORE';
  const status=document.createElement('span');status.className='mn-organism-status';status.textContent=MODES.booting;
  status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  header.append(title,status);
  const canvas=document.createElement('canvas');canvas.className='mn-organism-canvas';
  const shaderHost=document.createElement('div');shaderHost.className='mn-organism-webthreads';
  shaderHost.setAttribute('aria-hidden','true');
  canvas.setAttribute('role','img');
  canvas.setAttribute('aria-label','Telpisks neironu tīkls, kura impulsi parāda faktisko MNEMOS aktivitāti');
  const footer=document.createElement('div');footer.className='mn-organism-footer';
  const detail=document.createElement('span');detail.textContent='GAIDA CORE STĀVOKLI';
  const signal=document.createElement('span');signal.className='mn-organism-signal';
  footer.append(detail,signal);
  host.append(header,canvas,shaderHost,footer);
  const ctx=canvas.getContext('2d',{alpha:false,desynchronized:true});
  let size={w:0,h:0,dpr:1},frame=0,lastTime=0,mode='booting',
    active=false,visible=true,attached=false,disposed=false,bootStart=performance.now(),
    pulseUntil=0,transitionAt=0,events=0,preferredReduced=false,
    parallaxX=0,parallaxY=0,
    media=null,io=null,resize=null,mo=null,ctxValid=!!ctx,counts={core:false,bus:0,model:false},
    shaderRoot=null,shaderReady=false,shaderInitAttempted=false;
  function hash(seed){
    let x=seed>>>0;
    return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};
  }
  const rand=hash(0x4d4e454d);
  // An asymmetric dendritic volume: three spatial lobes with connections,
  // rather than a rotating globe or a uniform particle sphere.
  const nodes=[],edges=[],clusters=[
    {x:-.42,y:-.12,z:-.16},
    {x:.07,y:.12,z:.27},
    {x:.39,y:-.24,z:-.32}
  ];
  for(let k=0;k<3;k++){
    const center=clusters[k],root=nodes.length;
    nodes.push({x:center.x,y:center.y,z:center.z,cluster:k,depth:0,size:2.1});
    const parents=[root];
    for(let n=0;n<24;n++){
      const parentIndex=parents[Math.floor(rand()*parents.length)];
      const parent=nodes[parentIndex];
      const spread=.10+rand()*.13,angle=rand()*Math.PI*2;
      const node={x:Math.max(-.92,Math.min(.93,parent.x+Math.cos(angle)*spread)),
        y:Math.max(-.78,Math.min(.8,parent.y+Math.sin(angle)*spread)),
        z:Math.max(-.83,Math.min(.86,parent.z+(rand()-.5)*.34)),
        cluster:k,depth:parent.depth+1,size:.75+rand()*.95};
      const idx=nodes.push(node)-1;parents.push(idx);edges.push({a:parentIndex,b:idx,cluster:k});
    }
  }
  for(let i=0;i<27;i++){
    const a=Math.floor(rand()*nodes.length),b=Math.floor(rand()*nodes.length);
    if(a!==b && nodes[a].cluster!==nodes[b].cluster){
      const dx=nodes[a].x-nodes[b].x,dy=nodes[a].y-nodes[b].y;
      if(dx*dx+dy*dy<.58)edges.push({a,b,cluster:i%3});
    }
  }
  const topology=Object.freeze({nodes:nodes.length,edges:edges.length,lobes:3});
  // A real React Bits WebGL2 shader now provides the primary neural surface.
  // The old 2D graph remains a deterministic fallback, never a second GPU
  // animation loop. An explicit successful WebGL program setup is required.
  function onShaderReady(){
    if(disposed||shaderReady)return;
    shaderReady=true;
    host.dataset.shader='ready';
    canvas.setAttribute('aria-hidden','true');
    stop();
  }
  function onShaderFailure(){
    if(disposed)return;
    shaderReady=false;
    host.dataset.shader='failed';
    canvas.setAttribute('aria-hidden','false');
    resizeCanvas();
    schedule();
  }
  function shaderProps(){
    const busy=ACTIVE.has(mode);
    const lost=mode==='disconnected'||mode==='booting';
    const faulty=mode==='error';
    return {
      colors:faulty?['#9c5853','#d7a883','#846e66']:
        ['#d8b98a','#eee1c6','#8a9da5','#b8c8c4'],
      coreColor:faulty?'#dfc1a7':'#fff0d4',
      backgroundColor:'transparent',
      // Values are in shader-space, not CSS pixels. The previous 14-18
      // strands with 0.1-0.14 glow and 1.28 thickness overexposed most of
      // the panel to solid white. Keep ambient energy below saturation.
      threadCount:busy?9:6,
      nodes:3,
      speed:preferredReduced?0:busy?.24:lost?.045:.09,
      frequency:5.0,spread:.19,taper:.12,pinch:.5,position:.5,
      angle:-6,glow:busy?.024:.017,falloff:.82,thickness:.16,
      brightness:busy?.72:.56,opacity:lost?.34:faulty?.58:.78,
      depth:.48,pulses:busy?.25:0,mirror:true,
      shimmer:busy,fade:.16,grain:.008,intro:true,
      mouseInteraction:true,mouseStrength:.7,pulseOnClick:true,
      paused:document.hidden||!visible||preferredReduced,dpr:1.2,
      onReady:onShaderReady,onFailure:onShaderFailure
    };
  }
  function refreshShader(){
    if(disposed||!shaderRoot||!window.React||!window.MNEMOSWebThreads)return;
    try{
      shaderRoot.render(window.React.createElement(window.MNEMOSWebThreads,shaderProps()));
    }catch(error){
      host.dataset.shader='failed';
      console.error('MNEMOS WebThreads rendering error:',String(error?.message||error));
    }
  }
  function ensureShader(){
    if(disposed||shaderInitAttempted||!host.isConnected)return;
    if(!window.ReactDOM?.createRoot||!window.MNEMOSWebThreads)return;
    shaderInitAttempted=true;
    try{
      shaderRoot=window.ReactDOM.createRoot(shaderHost);
      refreshShader();
    }catch(error){
      shaderRoot=null;host.dataset.shader='failed';
      console.error('MNEMOS WebThreads startup error:',String(error?.message||error));
    }
  }
  function resizeCanvas(){
    if(!ctxValid||disposed)return;
    const rect=canvas.getBoundingClientRect();
    if(rect.width<10||rect.height<10)return;
    const dpr=Math.min(1.75,Math.max(1,window.devicePixelRatio||1));
    const w=Math.round(rect.width*dpr),h=Math.round(rect.height*dpr);
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    size={w:rect.width,h:rect.height,dpr};
  }
  function project(node,t){
    const drift=preferredReduced?0:Math.sin(t*.00018+node.cluster*2.2+node.depth*.32)*.012;
    const x=node.x+drift+node.z*parallaxX,
      y=node.y+(preferredReduced?0:Math.sin(t*.00026+node.x*6)*.009)+node.z*parallaxY;
    const perspective=1.16/(1.25-node.z*.24);
    return {x:(.5+x*.49*perspective)*size.w,
      y:(.51+y*.39*perspective)*size.h,
      z:node.z,p:perspective,s:node.size};
  }
  function draw(t){
    if(!ctxValid||!size.w||!size.h)return;
    const w=size.w,h=size.h,scale=size.dpr;
    ctx.setTransform(scale,0,0,scale,0,0);
    ctx.fillStyle='#111315';ctx.fillRect(0,0,w,h);
    const isBusy=ACTIVE.has(mode),isConnected=mode!=='disconnected'&&mode!=='booting';
    const boot=preferredReduced?1:Math.min(1,Math.max(0,(t-bootStart)/1700));
    const breathe=preferredReduced?1:1+Math.sin(t*.0009)*.035;
    const opacity=(mode==='disconnected'?.27:.70)*boot*breathe;
    const positions=nodes.map(node=>project(node,t));
    // Depth sorting is stable and deterministic; it preserves a volumetric
    // foreground/background illusion without a bright rotating mesh.
    const ordered=edges.map(e=>({e,z:(positions[e.a].z+positions[e.b].z)/2}))
      .sort((a,b)=>a.z-b.z);
    for(const {e,z} of ordered){
      const a=positions[e.a],b=positions[e.b];
      const depth=(z+1)/2;
      ctx.strokeStyle='rgba(183,189,187,'+(opacity*(.16+depth*.29)).toFixed(3)+')';
      ctx.lineWidth=(.45+depth*.45);
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    }
    const recentPulse=t<pulseUntil;
    if((isBusy||recentPulse)&&!preferredReduced){
      const speed=(mode==='multi_agent'?0.00075:0.00047);
      const count=isBusy?Math.min(16,6+events%11):5;
      for(let i=0;i<count;i++){
        const edge=edges[(i*17+11)%edges.length];
        const a=positions[edge.a],b=positions[edge.b];
        const u=((t*speed+i*.173+events*.07)%1);
        const x=a.x+(b.x-a.x)*u,y=a.y+(b.y-a.y)*u;
        const alpha=recentPulse?.69:.48;
        ctx.beginPath();ctx.arc(x,y,1.1+(.35*(edge.cluster===1)),0,Math.PI*2);
        ctx.fillStyle='rgba(226,210,172,'+alpha+')';ctx.fill();
      }
    }
    for(let i=0;i<nodes.length;i++){
      const n=nodes[i],p=positions[i],depth=(n.z+1)/2;
      const lum=(.19+depth*.38)*opacity;
      const energised=isBusy&&((i+events)%11===0);
      const root=n.depth===0;
      ctx.beginPath();
      ctx.arc(p.x,p.y,Math.max(.56,n.size*(.68+depth*.55)),0,Math.PI*2);
      ctx.fillStyle=energised?'rgba(232,212,173,'+Math.min(.95,lum+.28)+')':
        root?'rgba(224,208,180,'+Math.min(.85,lum+.30)+')':
        'rgba(194,200,197,'+Math.min(.8,lum)+')';
      if(root){ctx.shadowBlur=9;ctx.shadowColor='#b9ad95';}
      ctx.fill();ctx.shadowBlur=0;
    }
    if(mode==='error'){
      ctx.strokeStyle='rgba(181,114,93,.33)';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(w*.06,h*.88);ctx.lineTo(w*.94,h*.88);ctx.stroke();
    }
    ctx.setTransform(1,0,0,1,0,0);
  }
  function paint(t){
    frame=0;
    if(disposed||document.hidden||!visible||!ctxValid||shaderReady)return;
    const cap=preferredReduced?1000:ACTIVE.has(mode)?1000/30:1000/20;
    if(t-lastTime>=cap){draw(t);lastTime=t;}
    frame=requestAnimationFrame(paint);
  }
  function schedule(){
    if(disposed||frame||document.hidden||!visible||!ctxValid||shaderReady)return;
    frame=requestAnimationFrame(paint);
  }
  function stop(){if(frame){cancelAnimationFrame(frame);frame=0;}}
  function relocate(){
    if(disposed)return;
    const isCoord=document.body.classList.contains('coordination-mode');
    const isHome=document.body.classList.contains('mn-home');
    const main=document.getElementById('main');
    const heading=main?.querySelector('.page-header');
    const aside=document.getElementById('context'),
      contextBody=document.getElementById('context-body');
    if(isCoord){if(host.parentNode!==document.body)document.body.append(host);}
    else if(isHome&&main&&heading){
      if(host.parentNode!==main||host.previousSibling!==heading)heading.after(host);
    }
    else if(aside&&contextBody){
      if(host.parentNode!==aside||host.nextSibling!==contextBody)
        aside.insertBefore(host,contextBody);
    }
    attached=host.isConnected;
    resizeCanvas();ensureShader();
  }
  function interpret(next){
    if(!next||typeof next!=='object')return {mode:'booting',reason:'GAIDA CORE STĀVOKLI'};
    const core=next.core||{},local=next.local||{},bus=next.frontier?.counts||{};
    const tasks=Array.isArray(local.turns)?local.turns:[];
    const current=tasks.find(t=>t.project===next.activeProject);
    const coordination=Array.isArray(next.coordination)?next.coordination:[];
    // The new six-turn council is a single `state.council` object. The legacy
    // collaboration journal remains an array. Track BOTH real state shapes.
    const liveStates=['RUNNING','RECONCILING','STOP_REQUESTED'];
    const liveCouncil=next.council&&liveStates.includes(next.council.status)?
      next.council:null;
    const liveRun=liveCouncil||coordination.find(r=>liveStates.includes(r.status));
    const agents=Array.isArray(core.agents)?core.agents:[];
    const activeAgents=agents.filter(a=>/RUNNING|ACTIVE|EXECUTING|WORKING/i.test(String(a.status??''))).length;
    const loading=(next.tabs||[]).some(tab=>tab.loading===true);
    const offline=core.online!==true;
    const resourceError=core.guard?.level==='CRITICAL';
    const failed=!!next.error||resourceError;
    const base={mode:'idle',reason:'SAVIENOJUMS STABILS',connected:!offline,
      bus:Number(bus.pending||0),model:false};
    if(failed)return {...base,mode:'error',reason:resourceError?'RESURSU IEROBEŽOJUMS':'SISTĒMAS KĻŪDA'};
    if(liveRun)return {...base,mode:liveRun.status==='RECONCILING'?'validating':'multi_agent',
      reason:'AKTĪVS MODEĻU CIKLS'};
    if(current?.status==='RUNNING')return {...base,mode:'executing',
      model:true,reason:'AKTĪVS LOKĀLAIS MODELIS'};
    if(current?.status==='QUEUED')return {...base,mode:'planning',model:true,
      reason:'MODELIS GAIDA IZPILDI'};
    if(activeAgents>1)return {...base,mode:'multi_agent',reason:'AKTĪVI AĢENTI: '+activeAgents};
    if(activeAgents===1)return {...base,mode:'executing',reason:'AKTĪVS AĢENTS'};
    if(loading)return {...base,mode:'retrieving',reason:'TIEK IELĀDĒTA CILNE'};
    if(Number(bus.pending)>0)return {...base,mode:'validating',reason:'BUS GAIDA APSTIPRINĀJUMU'};
    if(offline)return {...base,mode:'disconnected',reason:'CORE NAV SAVIENOTS'};
    return base;
  }
  function update(next){
    if(disposed)return;
    relocate();
    const value=interpret(next),now=performance.now();
    const was=mode;mode=value.mode;
    counts={core:value.connected,bus:value.bus,model:value.model};
    if(was!==mode){
      transitionAt=now;events++;
      // Pulses are justified by actual state transitions, not random activity.
      pulseUntil=ACTIVE.has(mode)?now+1300:mode==='completed'?now+1000:now;
      status.textContent=MODES[mode]||mode;
      host.dataset.mode=mode;
      refreshShader();
    }
    detail.textContent=value.reason;
    signal.textContent=value.connected?'CORE ONLINE':'CORE OFFLINE';
    host.setAttribute('data-connected',value.connected?'true':'false');
    if(!frame)schedule();
  }
  function onVisibility(){refreshShader();if(document.hidden)stop();else{lastTime=0;schedule();}}
  function pointerMove(event){
    if(preferredReduced||!size.w||!size.h)return;
    const rect=host.getBoundingClientRect();
    parallaxX=Math.max(-.08,Math.min(.08,((event.clientX-rect.left)/rect.width-.5)*.16));
    parallaxY=Math.max(-.05,Math.min(.05,((event.clientY-rect.top)/rect.height-.5)*.10));
  }
  function pointerLeave(){parallaxX=0;parallaxY=0;}
  function reducedChanged(){preferredReduced=media?.matches===true;}
  function setup(){
    if(disposed||attached)return;
    relocate();
    if(window.matchMedia){
      media=window.matchMedia('(prefers-reduced-motion: reduce)');
      reducedChanged();media.addEventListener?.('change',reducedChanged);
    }
    if(typeof ResizeObserver==='function'){
      resize=new ResizeObserver(resizeCanvas);resize.observe(canvas);
    }
    if(typeof IntersectionObserver==='function'){
      io=new IntersectionObserver(entries=>{
        visible=entries.some(entry=>entry.isIntersecting);
        if(visible){resizeCanvas();refreshShader();schedule();}else stop();
      },{threshold:0});io.observe(host);
    }
    document.addEventListener('visibilitychange',onVisibility);
    host.addEventListener('pointermove',pointerMove,{passive:true});
    host.addEventListener('pointerleave',pointerLeave);
    resizeCanvas();ensureShader();schedule();
  }
  function dispose(){
    if(disposed)return;disposed=true;stop();
    document.removeEventListener('visibilitychange',onVisibility);
    host.removeEventListener('pointermove',pointerMove);
    host.removeEventListener('pointerleave',pointerLeave);
    resize?.disconnect();io?.disconnect();mo?.disconnect();
    media?.removeEventListener?.('change',reducedChanged);
    try{shaderRoot?.unmount();}catch{}
    shaderRoot=null;
    host.remove();
  }
  // Script is loaded before shell.js at the bottom of <body>.
  setup();
  window.MNEMOSLivingNetwork=Object.freeze({
    version:'1.0-state-linked',update,dispose,topology,
    get state(){return mode;},
    get running(){return !document.hidden&&visible&&(shaderReady||frame!==0);},
    get renderBackend(){return shaderReady?'reactbits-webgl2':'canvas2d-fallback';}
  });
})();
