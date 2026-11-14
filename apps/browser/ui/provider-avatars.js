/* MNEMOS / Model characters. One distinct monochrome living avatar per
 * model family. Presence is NOT a claim to inspect private AI reasoning.
 * Only browser-tab, council and local execution evidence determines states.
 * Original Atomic Age palette and MNEMOS mascot are not modified.
 * No timers, network requests, GPU tasks or browser navigation.
 */
(function(){
'use strict';
const NS='http://www.w3.org/2000/svg';
const names=Object.freeze({
 chatgpt:'ChatGPT',claude:'Claude',gemini:'Gemini',
 perplexity:'Perplexity',local:'Lokālais AI',unknown:'AI'
});
const labels=Object.freeze({
 inactive:'Nav atvērts',ready:'Cilne atvērta',login:'Nepieciešama pierakstīšanās',listening:'Aktīvs cits sarunas dalībnieks',
 loading:'Ielādē cilni',sending:'Sagatavo ziņojumu',
 waiting:'Gaida atbildi',verifying:'Pārbauda atbildi',
 completed:'Atbilde nolasīta',error:'Nepārbaudīts / kļūda',
 queued:'Gaida izpildi',working:'Izpilda uzdevumu',speaking:'Ģenerē atbildi',
 local:'Lokālais modelis pieejams',unavailable:'Modelis nav pieejams'
});
function key(value){
 const s=String(value??'').toLowerCase();
 if(/chatgpt|openai|gpt[-\s_]?\d/.test(s))return'chatgpt';
 if(/claude|anthropic/.test(s))return'claude';
 if(/gemini|google/.test(s))return'gemini';
 if(/perplexity|sonar/.test(s))return'perplexity';
 if(/ollama|local|qwen|llama|deepseek|mistral|phi|gemma|coder|mnemos/.test(s))return'local';
 return'unknown';
}
function tabProvider(url){
 try{
  const {protocol,hostname}=new URL(url);
  if(protocol!=='https:')return null;
  const known={
   'chatgpt.com':'chatgpt','gemini.google.com':'gemini',
   'claude.ai':'claude','www.perplexity.ai':'perplexity',
   'perplexity.ai':'perplexity'
  };
  return known[hostname]??null;
 }catch{return null;}
}
function isLoginPage(url){
 try{
  const u=new URL(url);
  if(u.protocol!=='https:')return false;
  if(u.hostname==='claude.ai')return /^\/(?:login|signup|sign-up)(?:\/|$)/.test(u.pathname);
  if(u.hostname==='chatgpt.com')return /^\/(?:auth|login|signup)(?:\/|$)/.test(u.pathname);
  if(['perplexity.ai','www.perplexity.ai'].includes(u.hostname))
   return /^\/(?:login|sign-in|signup)(?:\/|$)/.test(u.pathname);
  return false;
 }catch{return false;}
}
function normalizeStatus(status){
 const s=String(status??'').toUpperCase();
 if(s==='CAPTURED'||s==='COMPLETED')return'completed';
 if(s==='RECONCILING'||s==='VERIFYING')return'verifying';
 if(s==='AWAITING_RESPONSE'||s==='WAITING')return'waiting';
 if(s==='INTENT_RECORDED'||s==='PREPARING'||s==='SENDING')return'sending';
 if(s==='RUNNING'||s==='EXECUTING')return'working';
 if(s==='QUEUED')return'queued';
 if(/ERROR|FAIL|UNVERIFIED|UNCERTAIN|BLOCKED|INTERRUPTED/.test(s))return'error';
 return null;
}
// Presence is inferred only from the latest running council turn; never from text sentiment.
function activeSpeaker(state){
 const council=state?.council;
 if(!['RUNNING','RECONCILING'].includes(council?.status))return null;
 const turn=Array.isArray(council.turns)?council.turns.at(-1):null;
 const step=normalizeStatus(turn?.status);
 const id=key(turn?.model);
 return ['sending','waiting','working','speaking','verifying'].includes(step)&&
   ['chatgpt','claude','gemini','perplexity'].includes(id)?id:null;
}
function status(state,modelName){
 const id=key(modelName);
 const council=state?.council;
 const turns=Array.isArray(council?.turns)?council.turns:[];
 const current=turns.at(-1);
 if(current&&key(current.model)===id){
  const currentStatus=normalizeStatus(current.status);
  if(currentStatus&&
     ['RUNNING','RECONCILING','STOP_REQUESTED'].includes(council.status))
   return currentStatus;
  if(currentStatus&&currentStatus!=='sending')return currentStatus;
 }
 // Previous CAPTURED turns remain evidence after the next model takes over.
 // Only actual participants can be shown listening; an unrelated open tab cannot.
 const capturedParticipant=turns.slice(0,-1).some(turn=>
   key(turn.model)===id&&turn.status==='CAPTURED');
 if(id==='local'){
  const turn=(state?.local?.turns??[]).find(t=>t.project===state.activeProject);
  const identity=String(modelName??'').trim();
  const generic=identity==='local'||identity==='Lokālais AI';
  if(!generic&&turn?.model&&String(turn.model).toLowerCase()!==identity.toLowerCase()){
    const installed=(state?.models??[]).some(m=>String(m.id).toLowerCase()===identity.toLowerCase());
    return installed?'local':'unavailable';
  }
  const task=normalizeStatus(turn?.status);
  if(task==='working'&&String(turn?.output??'').length)return'speaking';
  if(task)return task;
  return state?.models?.length?'local':'unavailable';
 }
 const tabs=(state?.tabs??[]).filter(t=>!t.private&&tabProvider(t.url)===id);
 if(tabs.some(t=>t.loading))return'loading';
 // A login screen is not an authenticated model. Only visible URL evidence is used.
 if(tabs.length&&tabs.every(t=>isLoginPage(t.url)))return'login';
 const speaker=activeSpeaker(state);
 if(tabs.length&&capturedParticipant&&speaker&&speaker!==id)return'listening';
 if(capturedParticipant)return'completed';
 return tabs.length?'ready':'inactive';
}
function svgElement(tag,attrs,parent){
 const e=document.createElementNS(NS,tag);
 for(const [k,v] of Object.entries(attrs??{}))e.setAttribute(k,String(v));
 parent?.appendChild(e);return e;
}
function identityVariant(identity){
 const value=String(identity??'');
 let n=2166136261;
 for(let i=0;i<value.length;i++){n^=value.charCodeAt(i);n=Math.imul(n,16777619);}
 return (n>>>0)%4;
}
function character(provider,svg,identity=provider){
 const p=key(provider);
 const s=(tag,attrs,parent=svg)=>svgElement(tag,attrs,parent);
 const shell={fill:'#2c2c2c',stroke:'#d5d5d5','stroke-width':2.2,
  'stroke-linejoin':'round','stroke-linecap':'round'};
 const wire={fill:'none',stroke:'#a9a9a9','stroke-width':1.8,
  'stroke-linejoin':'round','stroke-linecap':'round'};
 const faint={fill:'none',stroke:'#777','stroke-width':1.3,
  'stroke-linejoin':'round','stroke-linecap':'round'};
 const path=(d,attrs={})=>s('path',{d,...wire,...attrs});
 const eye=(cx,cy,rx=3.1,ry=3.7,attrs={})=>s('ellipse',{
  cx,cy,rx,ry,fill:'#f2f2f2',class:'model-avatar-eye',...attrs});
 const mouth=(d)=>s('path',{d,fill:'none',stroke:'#e3e3e3',
  'stroke-width':1.9,'stroke-linecap':'round',class:'model-avatar-mouth'});
 if(p==='chatgpt'){
  // Rounded companion: expansive faceplate, expressive brows, short receiver ears.
  s('rect',{x:4,y:29,width:11,height:15,rx:5,fill:'#555',stroke:'#bcbcbc','stroke-width':1.8});
  s('rect',{x:49,y:29,width:11,height:15,rx:5,fill:'#555',stroke:'#bcbcbc','stroke-width':1.8});
  s('rect',{x:10,y:11,width:44,height:44,rx:16,...shell});
  s('rect',{x:15,y:21,width:34,height:26,rx:12,fill:'#171717',stroke:'#747474','stroke-width':1.2});
  path('M21 15 Q32 9 43 15',{stroke:'#aaa','stroke-width':1.4});
  path('M19 29 Q24 26 29 29',{stroke:'#999','stroke-width':1.45});
  path('M35 29 Q40 26 45 29',{stroke:'#999','stroke-width':1.45});
  eye(24,35,3.7,4.4);eye(40,35,3.7,4.4);
  mouth('M25 44 Q32 50 39 44');
  s('circle',{cx:12,cy:16,r:1.3,fill:'#eee'});
  s('rect',{x:27,y:54,width:10,height:3,rx:1.4,fill:'#929292'});
 }else if(p==='claude'){
  // Folded, asymmetric origami-mechanical profile: hard bevels, slotted eyes.
  path('M18 13 L12 5 M45 12 L53 5 M24 8 L24 13 M40 8 L40 13');
  s('path',{d:'M13 17 L27 8 L45 12 L55 27 L50 51 L32 59 L14 51 L9 31 Z',...shell});
  s('path',{d:'M18 20 L29 15 L45 20 L49 29 L45 45 L32 52 L18 44 L15 30 Z',
   fill:'#1b1b1b',stroke:'#888','stroke-width':1.4,'stroke-linejoin':'round'});
  s('path',{d:'M16 21 L22 25 L22 42 L16 46',...faint});
  s('path',{d:'M46 21 L42 25 L42 42 L48 46',...faint});
  path('M21 29 L28 27 M36 27 L43 29',{stroke:'#dedede','stroke-width':2.3});
  s('rect',{x:22,y:31,width:6,height:6,rx:1.2,fill:'#f0f0f0',class:'model-avatar-eye'});
  s('rect',{x:36,y:31,width:6,height:6,rx:1.2,fill:'#f0f0f0',class:'model-avatar-eye'});
  path('M29 39 L32 41 L35 39',{stroke:'#888','stroke-width':1.25});
  mouth('M27 46 L36 46');
  s('path',{d:'M24 54 L28 59 M40 54 L36 59',...faint});
 }else if(p==='gemini'){
  // A duet, not two identical icons. Their unequal contours physically overlap.
  s('path',{d:'M10 11 Q16 5 23 8 Q36 8 37 22 L37 43 Q36 54 21 54 Q6 54 5 40 L5 23 Q6 15 10 11 Z',
   ...shell});
  s('path',{d:'M32 25 Q35 17 45 18 Q59 18 59 35 Q59 49 48 54 Q36 58 29 46 Q27 40 32 25 Z',
   fill:'#3b3b3b',stroke:'#ededed','stroke-width':2.1,'stroke-linejoin':'round'});
  s('path',{d:'M10 19 Q22 13 31 21 M38 29 Q47 24 54 32',...faint});
  eye(15,31,2.9,3.6);eye(27,31,2.9,3.6);
  mouth('M16 41 Q22 45 28 40');
  eye(40,38,2.4,3.3);eye(50,38,2.4,3.3);
  mouth('M40 46 Q45 49 49 45');
  s('path',{d:'M50 5 L52 10 L57 12 L52 14 L50 20 L48 14 L43 12 L48 10 Z',
   fill:'#d2d2d2',stroke:'none',class:'model-avatar-spark'});
  path('M29 23 Q33 19 36 24',{stroke:'#bcbcbc','stroke-width':1.6});
 }else if(p==='perplexity'){
  // A single-eyed surveying machine, wholly unlike a humanoid robot.
  s('path',{d:'M32 3 L61 31 L32 60 L3 31 Z',fill:'#282828',
   stroke:'#d7d7d7','stroke-width':2.2,'stroke-linejoin':'round'});
  s('path',{d:'M32 10 L53 31 L32 52 L11 31 Z',fill:'#161616',
   stroke:'#8c8c8c','stroke-width':1.5,'stroke-linejoin':'round'});
  path('M32 5 V12 M32 51 V59 M5 31 H12 M52 31 H59',{stroke:'#e6e6e6','stroke-width':2});
  path('M18 23 L32 16 L46 23',{stroke:'#989898','stroke-width':1.6});
  s('circle',{cx:32,cy:32,r:13,fill:'#343434',
   stroke:'#c1c1c1','stroke-width':1.6,class:'model-avatar-orbit'});
  s('circle',{cx:32,cy:32,r:9.2,fill:'#101010',stroke:'#777','stroke-width':1.2});
  eye(32,32,6.3,7.2);
  s('circle',{cx:30.7,cy:30.4,r:2,fill:'#565656'});
  path('M17 42 L23 46 M41 46 L47 42',{stroke:'#999','stroke-width':1.6});
  s('path',{d:'M6 22 L11 18 M53 44 L58 40',...faint});
 }else{
  // Vacuum-tube / relay companion with reproducible mechanical identity.
  const variant=identityVariant(identity);
  const antennas=['M32 4 V14 M27 7 H37','M15 8 L23 16 M49 8 L41 16',
   'M32 2 V14 M25 9 H39','M15 12 L24 18 M49 12 L40 18'];
  path(antennas[variant],{stroke:'#bcbcbc','stroke-width':2.1});
  if(variant===0||variant===2)s('circle',{cx:32,cy:5,r:2.2,fill:'#e1e1e1'});
  else{
   s('circle',{cx:15,cy:8,r:2.3,fill:'#bcbcbc'});
   s('circle',{cx:49,cy:8,r:2.3,fill:'#bcbcbc'});
  }
  s('path',{d:variant===1?'M16 20 L48 20 L54 31 L51 50 L13 50 L10 31 Z':
   'M17 17 Q32 11 47 17 L52 28 L52 48 L12 48 L12 28 Z',...shell});
  s('rect',{x:16,y:25,width:32,height:20,rx:variant===3?11:variant===1?2:6,
   fill:'#141414',stroke:'#888','stroke-width':1.2});
  s('path',{d:'M16 20 L48 20 M12 51 L52 51 M18 55 L46 55',...wire});
  path('M13 29 H7 V40 H13 M51 29 H57 V40 H51',{stroke:'#bcbcbc'});
  if(variant===1){
   s('rect',{x:20,y:30,width:10,height:7,rx:1.2,fill:'#ddd',class:'model-avatar-eye'});
   s('rect',{x:34,y:30,width:10,height:7,rx:1.2,fill:'#ddd',class:'model-avatar-eye'});
  }else if(variant===2){
   s('rect',{x:19,y:29,width:26,height:10,rx:5,fill:'#666',class:'model-avatar-visor'});
   eye(25,34,2.3,3.1);eye(39,34,2.3,3.1);
  }else{
   eye(25,33,variant===3?3.8:3.2,variant===3?2.7:4);
   eye(39,33,variant===3?3.8:3.2,variant===3?2.7:4);
  }
  mouth(variant===3?'M26 42 Q32 39 38 42':'M27 42 L37 42');
  s('rect',{x:22,y:56,width:20,height:5,rx:1.5,fill:'#7e7e7e',
   stroke:'#c5c5c5','stroke-width':1.4});
 }
 return svg;
}
// A full character is rendered only in the collaboration ensemble.
// Compact controls retain the original 64x64 face for legibility at 21px.
function stageBody(svg,id){
 const add=(tag,attrs)=>svgElement(tag,attrs,svg);
 const base={fill:'#303030',stroke:'#bcbcbc','stroke-width':2.2,'stroke-linecap':'round','stroke-linejoin':'round'};
 const wire={fill:'none',stroke:'#a0a0a0','stroke-width':2.5,'stroke-linecap':'round','stroke-linejoin':'round'};
 if(id==='chatgpt'){
  add('path',{d:'M27 61 Q16 66 19 85 Q26 100 44 101 Q62 100 69 85 Q72 67 61 61 Z',...base});
  add('path',{d:'M22 70 Q10 72 12 86 M66 70 Q78 72 76 86',...wire,
   class:'model-avatar-arm'});
  add('path',{d:'M35 97 V105 M53 97 V105',...wire});
  add('rect',{x:37,y:77,width:14,height:10,rx:4,fill:'#151515',stroke:'#999','stroke-width':1.4});
  add('circle',{cx:44,cy:82,r:2.4,fill:'#e4e4e4'});
 }else if(id==='claude'){
  add('path',{d:'M28 61 L60 61 L72 91 L61 101 H27 L16 91 Z',...base});
  add('path',{d:'M27 66 L11 83 L17 93 M61 66 L77 83 L71 93',...wire,class:'model-avatar-arm'});
  add('path',{d:'M38 99 L36 106 H26 M50 99 L52 106 H62',...wire});
  add('path',{d:'M44 69 L44 96 M37 78 H51 M37 85 H51',...wire,'stroke-width':1.2});
 }else if(id==='gemini'){
  add('path',{d:'M24 63 Q11 68 17 91 L32 100 L46 95 L46 70 Z',...base});
  add('path',{d:'M47 63 Q65 58 70 75 L70 91 L58 99 L43 96 Z',...base,fill:'#404040'});
  add('path',{d:'M19 72 L10 82 L16 87 M68 72 L78 80 L71 87',...wire,class:'model-avatar-arm'});
  add('path',{d:'M29 98 L27 106 M56 98 L58 106 M39 82 L50 81',...wire});
  add('circle',{cx:34,cy:81,r:2.5,fill:'#ececec'});
  add('rect',{x:52,y:78,width:7,height:6,rx:2,fill:'#c5c5c5'});
 }else if(id==='perplexity'){
  // A search instrument, not a humanoid with an arbitrary torso.
  add('path',{d:'M44 57 V73 M44 73 L17 99 M44 73 L71 99 M44 73 V103',...wire});
  add('circle',{cx:44,cy:73,r:7,fill:'#262626',stroke:'#dadada','stroke-width':2});
  add('circle',{cx:17,cy:99,r:4,fill:'#aaa'});
  add('circle',{cx:71,cy:99,r:4,fill:'#aaa'});
  add('path',{d:'M35 103 H53',...wire,'stroke-width':1.6});
 }else{
  add('rect',{x:23,y:62,width:42,height:38,rx:5,...base});
  add('path',{d:'M23 69 L11 78 V90 M65 69 L77 78 V90 M34 99 V106 M54 99 V106',...wire,
   class:'model-avatar-arm'});
  add('rect',{x:32,y:73,width:24,height:17,rx:2,fill:'#171717',stroke:'#888','stroke-width':1.2});
  add('path',{d:'M36 78 H52 M36 84 H47',...wire,'stroke-width':1.8});
  add('circle',{cx:52,cy:85,r:2,fill:'#ededed'});
 }
}
// A facial cue describes the UI task state, never an inferred private emotion.
const expressionPaths=Object.freeze({
 chatgpt:{
   verifying:['M25 45 L39 45'],
   completed:['M24 43 Q32 52 40 43'],
   error:['M25 47 Q32 42 39 47']
 },
 claude:{
   verifying:['M27 46 L36 46'],
   completed:['M27 45 L31 48 L36 44'],
   error:['M27 47 L32 45 L36 48']
 },
 gemini:{
   verifying:['M16 41 L28 41','M40 46 L49 46'],
   completed:['M15 40 Q22 47 28 40','M39 45 Q45 51 50 44'],
   error:['M16 43 Q22 40 28 44','M40 47 Q45 44 49 48']
 },
 local:{
   verifying:['M27 42 L37 42'],
   completed:['M26 41 Q32 47 38 41'],
   error:['M27 44 Q32 41 37 44']
 }
});
function setState(node,next){
 if(!node)return;
 const state=String(next??'inactive');
 node.dataset.avatarState=state;
 const paths=expressionPaths[node.dataset.providerAvatar]?.[state];
 const mouths=node.querySelectorAll?.('.model-avatar-mouth')??[];
 for(let i=0;i<mouths.length;i++){
   const mouth=mouths[i];
   const neutral=mouth.getAttribute('data-avatar-neutral-d')??mouth.getAttribute('d');
   if(!mouth.hasAttribute('data-avatar-neutral-d'))
     mouth.setAttribute('data-avatar-neutral-d',neutral);
   const target=paths?.[i]??neutral;
   if(mouth.getAttribute('d')!==target)mouth.setAttribute('d',target);
 }
}
function create(model,{size='regular'}={}){
 const id=key(model);
 const wrapper=document.createElement('span');
 wrapper.className='model-avatar';
 wrapper.dataset.providerAvatar=id;
 wrapper.dataset.avatarIdentity=String(model??id).slice(0,128);
 wrapper.dataset.avatarState='inactive';
 wrapper.setAttribute('role','img');
 wrapper.setAttribute('aria-label',(id==='local'?String(model):(names[id]??String(model)))+' · '+labels.inactive);
 if(size==='small')wrapper.classList.add('model-avatar-small');
 if(size==='stage'){
  wrapper.classList.add('model-avatar-stage');
  wrapper.dataset.avatarStage='yes';
 }
 const svg=svgElement('svg',{viewBox:size==='stage'?'0 0 88 110':'0 0 64 64',
  'aria-hidden':'true',focusable:'false',shapeRendering:'geometricPrecision'},wrapper);
 if(size==='stage'){
  stageBody(svg,id);
  const head=svgElement('g',{transform:'translate(12 0)',class:'model-avatar-head'},svg);
  character(id,head,model);
 }else character(id,svg,model);
 return wrapper;
}

let lastState=null;
function syncLocalSelector(){
 const selector=document.getElementById('model');
 const footer=selector?.closest?.('.composer-footer');
 if(!footer)return;
 let badge=footer.querySelector('.model-selected-avatar');
 if(!badge){
   badge=document.createElement('span');
   badge.className='model-selected-avatar';
   footer.insertBefore(badge,selector);
 }
 if(selector.dataset.avatarBound!=='yes'){
   selector.dataset.avatarBound='yes';
   selector.addEventListener('change',()=>{
     syncLocalSelector();
     if(lastState)refresh(document,lastState);
   });
 }
 const identity=String(selector.value||'local');
 if(badge.dataset.modelIdentity!==identity){
   badge.dataset.modelIdentity=identity;
   badge.replaceChildren(create(identity,{size:'small'}));
 }
}
function refresh(root,state){
 lastState=state;
 syncLocalSelector();
 if(!root?.querySelectorAll)return;
 const nodes=[...root.querySelectorAll('[data-provider-avatar]')];
 const speaker=activeSpeaker(state);
 // Use a REAL on-screen participant as the gaze target, not a synthetic model location.
 const isVisible=n=>typeof n?.getBoundingClientRect==='function'&&
   n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0;
 // Prioritize the large, visible collaboration figure. A tiny browser-tab
 // duplicate is not the person the audience is looking at.
 const target=speaker?(
   nodes.find(n=>n.dataset.providerAvatar===speaker&&n.dataset.avatarStage==='yes'&&isVisible(n))??
   nodes.find(n=>n.dataset.providerAvatar===speaker&&isVisible(n))
 ):null;
 const targetRect=target?.getBoundingClientRect();
 for(const node of nodes){
  const provider=node.dataset.providerAvatar;
  const next=status(state,node.dataset.avatarIdentity??provider);
  if(node.dataset.avatarState!==next){
   setState(node,next);
   const display=provider==='local'?node.dataset.avatarIdentity:(names[provider]||'AI');
   node.setAttribute('aria-label',display+' · '+(labels[next]??next));
   node.title=display+' — '+(labels[next]??next);
  }
  const member=node.closest?.('.persona-member');
  const caption=member?.querySelector?.('.persona-state');
  if(caption&&caption.textContent!==(labels[next]??next))caption.textContent=labels[next]??next;
  const rect=next==='listening'&&targetRect&&typeof node.getBoundingClientRect==='function'
    ?node.getBoundingClientRect():null;
  const dx=rect?.width?Math.max(-1,Math.min(1,(targetRect.left+targetRect.width/2-rect.left-rect.width/2)/120)):0;
  const dy=rect?.height?Math.max(-1,Math.min(1,(targetRect.top+targetRect.height/2-rect.top-rect.height/2)/120)):0;
  // A maximum 1.4px glance, neutral when the referenced model is not on screen.
  const gaze=`${(dx*1.4).toFixed(2)}px,${(dy*1.4).toFixed(2)}px`;
  if(node.dataset.avatarGaze!==gaze){
   node.dataset.avatarGaze=gaze;
   node.style?.setProperty?.('--gaze-x',`${(dx*1.4).toFixed(2)}px`);
   node.style?.setProperty?.('--gaze-y',`${(dy*1.4).toFixed(2)}px`);
  }
 }
}
window.MNEMOSProviderAvatars=Object.freeze({
 create,refresh,syncLocalSelector,key,status,tabProvider,normalizeStatus,labels,setState
});
})();
