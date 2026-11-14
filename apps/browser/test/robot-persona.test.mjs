import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const code=fs.readFileSync(path.join(base,'ui','robot-persona.js'),'utf8');
function environment(){
  const timers=new Map(), docListeners=new Map();
  let timerId=0;
  function el(type='div'){
    const events=new Map(), classes=new Set(),vars=new Map(), children=[];
    const node={
      type, events,children,dataset:{},style:{
        setProperty:(name,value)=>vars.set(name,value),
        removeProperty:name=>vars.delete(name),
        getPropertyValue:name=>vars.get(name)
      },
      classList:{
        add:name=>classes.add(name),
        remove:name=>classes.delete(name),
        contains:name=>classes.has(name)
      },
      setAttribute(name,value){this[name]=value;},
      addEventListener:(name,fn)=>events.set(name,fn),
      querySelector(selector){
        if(selector==='svg')return {type:'svg'};
        if(selector==='.dashboard-rotor')return children.find(x=>x.type==='figure')??null;
        if(selector==='.mn-robot-presence')return children.find(x=>x.classList?.contains('mn-robot-presence'))??null;
        if(selector==='.assistant-orb')return children.find(x=>x.type==='orb')??null;
        if(selector==='div:not(.mn-robot-presence)')return children.find(x=>x.type==='copy')??null;
        return null;
      },
      getBoundingClientRect:()=>({left:0,top:0,width:80,height:80}),
      append(child){children.push(child);},
      replaceWith(next){this.replaced=next;onReplace?.(this,next);},
      get offsetWidth(){return 80;},
      textContent:''
    };
    let onReplace=null;
    node.onReplace=callback=>{onReplace=callback;};
    return node;
  }
  const copy=el('copy'),orb=el('orb'),heading=el('heading'),home=el('figure'),figure=el('figure'),prompt=el('prompt');
  heading.children.push(orb,copy);
  orb.onReplace((old,newNode)=>{
    const idx=heading.children.indexOf(old);
    heading.children.splice(idx,1,newNode);
  });
  const doc={
    hidden:false,
    createElement:type=>el(type),
    querySelector:selector=>selector==='.assistant-heading'?heading:
      selector==='.assistant-heading .mn-robot-state'?
        copy.children.find(x=>x.className==='mn-robot-state')??null:null,
    querySelectorAll:selector=>selector==='.dashboard-rotor'?[home,figure]:[],
    getElementById:name=>name==='prompt'?prompt:null,
    addEventListener:(name,fn)=>docListeners.set(name,fn),
    removeEventListener:name=>docListeners.delete(name)
  };
  const window={matchMedia:()=>({matches:false})};
  const ctx={window,document:doc,console,
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},
    clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(code,ctx,{timeout:1000,filename:'robot-persona.js'});
  let calls=0;
  const factory=()=>{calls++;const unit=el('unit');unit.children.push(figure);return unit;};
  return{api:window.MNEMOSRobotPersona,home,figure,heading,copy,prompt,doc,timers,docListeners,factory,get calls(){return calls}};
}
const state=({online=true,council=null,turn=null,error=null}={})=>({
  core:{online},activeProject:'project',council,error,
  local:{turns:turn?[{...turn,project:'project'}]:[]}
});
test('Robot reacts only to real states, with explicit no-guess fallback',()=>{
  const env=environment();
  assert.equal(env.api.describe(state()),'idle');
  assert.equal(env.api.describe(state({online:false})),'offline');
  assert.equal(env.api.describe(state({turn:{status:'QUEUED'}})),'planning');
  assert.equal(env.api.describe(state({turn:{status:'RUNNING',output:''}})),'working');
  assert.equal(env.api.describe(state({turn:{status:'RUNNING',output:'Īsta atbilde'}})),'speaking');
  assert.equal(env.api.describe(state({turn:{status:'COMPLETED',output:'Atbilde'}})),'happy');
  assert.equal(env.api.describe(state({council:{status:'RUNNING',turns:[{status:'AWAITING_RESPONSE'}]}})),'waiting');
  assert.equal(env.api.describe(state({council:{status:'RECONCILING',turns:[]}})),'checking');
  assert.equal(env.api.describe(state({council:{status:'RUNNING',turns:[{status:'CAPTURED'}]}})),'planning');
  assert.equal(env.api.describe(state({error:'actual failure'})),'error');
  assert.equal(env.api.describe(null),'idle');
  env.api.dispose();
});
test('Exactly one original robot SVG is reused in the sidebar; home SVG remains unchanged',()=>{
  const env=environment();
  env.api.update(state(),env.factory);
  assert.equal(env.calls,1);
  assert.equal(env.heading.querySelector('.mn-robot-presence'),env.figure);
  assert.equal(env.figure.dataset.robotMood,'idle');
  assert.equal(env.home.dataset.robotMood,'idle');
  assert.equal(env.copy.children.length,1);
  assert.equal(env.copy.children[0].textContent,'Esmu šeit');
  env.api.update(state({turn:{status:'RUNNING',output:'Atbilde'}}),env.factory);
  assert.equal(env.calls,1,'Do not reconstruct the SVG or a new React root on each model token');
  assert.equal(env.figure.dataset.robotMood,'speaking');
  assert.equal(env.copy.children[0].textContent,'Veidoju atbildi');
  assert.equal(env.home.dataset.robotMood,'speaking');
  env.api.dispose();
});
test('Robot accepts pointer/keyboard gestures locally but cannot submit AI prompts or leak text',()=>{
  const env=environment();
  env.api.update(state(),env.factory);
  env.figure.events.get('pointermove')({clientX:70,clientY:20});
  assert.notEqual(env.figure.style.getPropertyValue('--mn-robot-look-x'),undefined);
  let prevented=0;
  env.figure.events.get('keydown')({key:'Enter',preventDefault:()=>{prevented++;}});
  assert.equal(prevented,1);
  assert.equal(env.figure.classList.contains('mn-robot-greeting'),true);
  env.prompt.events.get('focus')();
  assert.equal(env.api.describe(state()),'listening');
  env.prompt.events.get('blur')();
  assert.equal(env.api.describe(state()),'idle');
  assert.doesNotMatch(code,/fetch\(|XMLHttpRequest|innerHTML|postMessage\(|window\.open\(|audio\.play/);
  assert.equal(env.figure.role,'button');
  env.api.dispose();
  assert.equal(env.docListeners.size,0);
  assert.equal(env.timers.size,0);
});
