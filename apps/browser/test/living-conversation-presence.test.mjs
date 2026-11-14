import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>fs.readFileSync(path.join(base,'ui',name),'utf8');
const source=read('living-conversation.js');
function environment(){
  let roots=0,renders=[],unmounts=0;
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.parentNode=null;
      this.className='';this.hidden=false;this.dataset={};this.attributes={};
      this.listeners=new Map();
      this.classList={toggle:(name,value)=>{
        const set=new Set(this.className.split(' ').filter(Boolean));
        if(value)set.add(name);else set.delete(name);
        this.className=[...set].join(' ');return value;
      },remove:name=>{
        this.className=this.className.split(' ').filter(x=>x&&x!==name).join(' ');
      }};
    }
    get isConnected(){return this===body||Boolean(this.parentNode?.isConnected);}
    get previousSibling(){if(!this.parentNode)return null;return this.parentNode.children[this.parentNode.children.indexOf(this)-1]??null;}
    get nextSibling(){if(!this.parentNode)return null;return this.parentNode.children[this.parentNode.children.indexOf(this)+1]??null;}
    append(...children){for(const node of children){node.remove();this.children.push(node);node.parentNode=this;}}
    remove(){const group=this.parentNode?.children;if(group){const i=group.indexOf(this);if(i>=0)group.splice(i,1);}this.parentNode=null;}
    insertBefore(child,ref){child.remove();const at=this.children.indexOf(ref);this.children.splice(at>=0?at:this.children.length,0,child);child.parentNode=this;}
    after(next){this.parentNode.insertBefore(next,this.nextSibling);}
    setAttribute(k,v){this.attributes[k]=v;}
    addEventListener(k,v){this.listeners.set(k,v);}
    removeEventListener(k){this.listeners.delete(k);}
    querySelector(k){return k==='.page-header'?this.children.find(x=>x.className==='page-header')??null:null;}
  }
  const body=new Element('body'),main=new Element('main'),
    header=new Element('header'),aside=new Element('aside'),contextBody=new Element('div');
  const prompt=new Element('textarea');
  header.className='page-header';main.append(header);aside.append(contextBody);contextBody.append(prompt);body.append(main,aside);
  const React={
    Fragment:Symbol.for('react.fragment'),createElement:(type,props,...children)=>({type,props:{...props,children}}),
    useEffect:()=>{},useRef:()=>({current:null})
  };
  const ReactDOM={createRoot(){
    roots++;return{render(node){renders.push(node);},unmount(){unmounts++;}};
  }};
  const window={React,ReactDOM,
    MNEMOSFaultyTerminal:function Faulty(){},
    MNEMOSGlitchText:function Glitch(){},
    MNEMOSFuzzyText:function Fuzzy(){},
    matchMedia:()=>({matches:false})
  };
  const document={body,createElement:tag=>new Element(tag),
    getElementById:name=>({main,context:aside,'context-body':contextBody,prompt})[name]??null};
  const ctx={window,document,URL,console:{error(){},warn(){}}};
  vm.runInNewContext(source,ctx,{filename:'living-conversation.js'});
  return{api:window.MNEMOSLivingConversation,body,main,aside,header,contextBody,prompt,
    stats:()=>({roots,renders:renders.length,unmounts}),renders,window};
}
const state=({section='workspace',activeId=null,tabs=[],online=true,council=null,turns=[],error=null}={})=>({
  section,activeId,tabs,activeProject:'mnemos',
  core:{online},council,local:{turns},error
});
const chatId='77777777-7777-4777-8777-777777777777';
const aiTab={id:chatId,url:'https://chatgpt.com/c/example',title:'ChatGPT'};
test('FaultyTerminal, GlitchText and FuzzyText are actual locally adapted React Bits components',()=>{
  const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),
    useEffect:()=>{},useRef:()=>({current:null}),
    Children:{toArray:value=>value==null?[]:[value]}};
  const sandbox={window:{React}};
  const result={};
  for(const [file,name] of [
    ['reactbits-faulty-terminal.js','MNEMOSFaultyTerminal'],
    ['reactbits-glitch-text.js','MNEMOSGlitchText'],
    ['reactbits-fuzzy-text.js','MNEMOSFuzzyText']
  ]){
    const raw=read(file);
    assert.ok(raw.includes('github.com/DavidHDev/react-bits'),file);
    assert.doesNotMatch(raw,/^\s*import |^\s*export default |dangerouslySetInnerHTML|fetch\(/m);
    vm.runInNewContext(raw,sandbox,{timeout:2000});
    result[name]=sandbox.window[name];
    assert.equal(typeof result[name],'function');
  }
  const faulty=result.MNEMOSFaultyTerminal({});
  const glitch=result.MNEMOSGlitchText({children:'GAIDA',mode:'slices'});
  const fuzzy=result.MNEMOSFuzzyText({children:'SIGNĀLS'});
  assert.equal(faulty.type,'div');
  assert.equal(glitch.type,'div');
  assert.equal(fuzzy.type,'canvas');
});
test('web chat has always-visible life presence, reuses one React root, returns to Home without intercepting the page',()=>{
  const env=environment();
  env.api.update(state({activeId:chatId,tabs:[aiTab]}));
  assert.equal(env.api.location,'chat');
  assert.equal(env.api.phase,'idle');
  assert.equal(env.aside.children[0].className,'mn-presence');
  assert.equal(env.stats().roots,1);
  assert.equal(env.stats().renders,1);
  assert.match(env.body.className,/mn-presence-visible/);
  env.api.update(state({activeId:chatId,tabs:[aiTab]}));
  assert.equal(env.stats().roots,1);
  assert.equal(env.stats().renders,1,'identical state should not trigger GPU remount');
  env.api.update(state());
  assert.doesNotMatch(env.body.className,/mn-presence-visible/);
  assert.equal(env.aside.children[0].hidden,true);
  env.api.dispose();
  assert.equal(env.stats().unmounts,1);
});
test('collaboration becomes a central living organism with distinct verifiable statuses',()=>{
  const env=environment();
  const baseRun={status:'RUNNING',turns:[{id:'one',model:'Perplexity',status:'AWAITING_RESPONSE'}]};
  env.api.update(state({section:'coordination',council:baseRun}));
  assert.equal(env.api.location,'coordination');
  assert.equal(env.api.phase,'waiting');
  assert.equal(env.main.children[1].className,'mn-presence');
  assert.equal(env.stats().roots,1);
  let view=env.api.inspect(state({section:'coordination',council:{
    status:'RECONCILING',turns:[{id:'two',model:'Gemini',status:'RECONCILING'}]
  }}));
  assert.equal(view.phase,'verifying');
  assert.equal(view.label,'Gemini');
  view=env.api.inspect(state({section:'coordination',council:{
    status:'SEND_UNCERTAIN_NO_RETRY',turns:[{id:'x',model:'ChatGPT',status:'SEND_UNCERTAIN_NO_RETRY'}]
  }}));
  assert.equal(view.phase,'error');
  const full='<svg onload=alert(1)>Tikai faktiski nolasīts teksts '+ 'X'.repeat(240);
  const done=state({section:'coordination',council:{status:'COMPLETED',turns:[
    {id:'three',model:'ChatGPT',status:'CAPTURED',answer:full}
  ]}});
  env.api.update(done);
  view=env.api.inspect(done);
  assert.equal(view.phase,'captured');
  assert.equal(view.reply.text.length,190);
  assert.match(view.reply.text,/^<svg/);
  assert.ok(env.stats().renders>=2);
  env.api.dispose();
});
test('native local chat shows a responsive presence on composer focus and after verified completion',()=>{
  const env=environment();
  env.api.update(state());
  assert.equal(env.api.location,'none');
  env.prompt.listeners.get('focus')();
  assert.equal(env.api.location,'chat');
  assert.equal(env.api.phase,'listening');
  env.prompt.listeners.get('blur')();
  assert.equal(env.aside.children[0].hidden,true);
  const task={id:'local1',project:'mnemos',status:'COMPLETED',
    model:'qwen3.5:4b',output:'Atbilde ir gatava. Jautājums ir jātestē praksē.'};
  const done=state({turns:[task]});
  env.api.update(done);
  assert.equal(env.api.phase,'captured');
  assert.equal(env.api.inspect(done).reply.model,'qwen3.5:4b');
  assert.match(env.api.inspect(done).reply.text,/Atbilde ir gatava/);
  env.api.dispose();
  assert.equal(env.prompt.listeners.size,0);
});
test('no fabricated hidden thought text, no browser write or external request capabilities',()=>{
  const {api}=environment();
  const q=api.inspect(state({activeId:chatId,tabs:[aiTab]}));
  assert.equal(q.phase,'idle');
  assert.equal(q.provider,'ChatGPT');
  assert.equal(q.reply,null,'the presence MUST NOT invent provider answers');
  const busy=api.inspect(state({turns:[{project:'mnemos',status:'RUNNING'}]}));
  assert.equal(busy.phase,'thinking');
  assert.equal(busy.reply,null);
  assert.doesNotMatch(source,/\.innerHTML\s*=|dangerouslySetInnerHTML|fetch\(|XMLHttpRequest|window\.open\(|electron|require\(/);
  assert.match(source,/REĀLI STĀVOKĻI · VIZUĀLA SIMULĀCIJA/);
  assert.match(source,/MNEMOSFaultyTerminal/);
  assert.match(source,/MNEMOSGlitchText/);
  assert.match(source,/MNEMOSFuzzyText/);
});
test('conversation shader is exposure-guarded, visually interactive and reduced-motion safe',()=>{
 const shader=read('reactbits-faulty-terminal.js');
 const css=read('living-conversation.css');
 assert.match(shader,/FAULTY_TERMINAL_OVEREXPOSED/);
 assert.match(shader,/readPixels/);
 assert.match(shader,/onFailure\?\.\('WEBGL_CONTEXT_LOST'\)/);
 assert.match(shader,/lastVisualFrame/);
 assert.match(source,/mouseReact:!reduced/);
 assert.match(source,/clickEffect:reduced\?'none':'glitch'/);
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
 assert.match(css,/body\.mn-presence-visible #context>\.mn-organism/);
 assert.match(css,/body\.coordination-mode #main>\.mn-presence/);
 assert.match(css,/\.mn-presence-reply-glitch/);
 assert.doesNotMatch(css,/background:\s*white\s*;/i);
 let depth=0;
 for(const char of css.replace(/\/\*[\s\S]*?\*\//g,'')){
   if(char==='{')depth++;
   if(char==='}')depth--;
   assert.ok(depth>=0);
 }
 assert.equal(depth,0);
});
