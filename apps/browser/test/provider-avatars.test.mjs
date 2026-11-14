import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(base,'ui','provider-avatars.js'),'utf8');
const css=fs.readFileSync(path.join(base,'ui','provider-avatars.css'),'utf8');

class Element{
 constructor(tag){
  this.tagName=tag;this.attributes={};this.dataset={};this.children=[];
  this.className='';this.parentNode=null;this.value='';this.events=new Map();
  this.classList={add:cls=>{this.className+=this.className?' '+cls:cls;},contains:cls=>this.className.split(' ').includes(cls)};
 }
 setAttribute(name,value){this.attributes[name]=String(value);}
 appendChild(element){element.parentNode=this;this.children.push(element);return element;}
 insertBefore(element,ref){
  element.parentNode=this;const index=this.children.indexOf(ref);
  this.children.splice(index<0?this.children.length:index,0,element);return element;
 }
 replaceChildren(...elements){this.children=[];for(const element of elements)this.appendChild(element);}
 addEventListener(name,callback){this.events.set(name,callback);}
 closest(selector){return selector==='.composer-footer'?this.parentNode:null;}
 querySelector(selector){if(selector==='.model-selected-avatar'){
   return this.children.find(child=>child.className==='model-selected-avatar')??null;
  }return null;
 }
 querySelectorAll(selector){
  if(selector!=='[data-provider-avatar]')return[];
  const out=[];
  const visit=node=>{
    if(node.dataset.providerAvatar)out.push(node);
    for(const child of node.children)visit(child);
  };
  visit(this);return out;
 }
}
function harness(){
 const footer=new Element('div');footer.className='composer-footer';
 const selector=new Element('select');selector.value='qwen3.5-4b';
 footer.appendChild(selector);
 const document={
  createElement:name=>new Element(name),
  createElementNS:(_ns,name)=>new Element(name),
  getElementById:id=>id==='model'?selector:null
 };
 const context={document,window:{},URL,Math,console};
 vm.runInNewContext(source,context,{timeout:1500,filename:'provider-avatars.js'});
 const body=new Element('body');
 body.appendChild(footer);
 return {api:context.window.MNEMOSProviderAvatars,body,selector,footer};
}
function dump(node){
 return node.tagName+JSON.stringify(node.attributes)+'['+node.children.map(dump).join('')+']';
}
const basic={core:{online:true},activeProject:'p',tabs:[],models:[],local:{turns:[]},council:null};

test('All four public providers and local engine have distinct actual SVG characters',()=>{
 const {api}=harness();
 const ids=['ChatGPT','Claude','Gemini','Perplexity','qwen3.5-4b','llama3:8b'];
 const faces=ids.map(id=>{
  const avatar=api.create(id,{size:'small'});
  assert.equal(avatar.tagName,'span');
  assert.equal(avatar.children[0].tagName,'svg');
  assert.equal(avatar.attributes.role,'img');
  assert.equal(avatar.children[0].attributes.viewBox,'0 0 64 64');
  assert.ok(avatar.children[0].children.length>=8,'SVG is not a placeholder');
  return dump(avatar.children[0]);
 });
 assert.equal(new Set(faces).size,faces.length,'all six selected personas must be visually distinct');
 const repeat=api.create('qwen3.5-4b');
 assert.equal(dump(repeat.children[0]),faces[4],'model identity must stay stable across re-render');
 assert.equal(api.tabProvider('https://chatgpt.com/c/example'),'chatgpt');
 assert.equal(api.tabProvider('https://gemini.google.com/app'),'gemini');
 assert.equal(api.tabProvider('https://www.perplexity.ai/session/test'),'perplexity');
 assert.equal(api.tabProvider('https://claude.ai/chat'),'claude');
 assert.equal(api.tabProvider('https://other.example.com'),null);
 assert.equal(api.tabProvider('http://chatgpt.com/'),null);
});
test('Facial state changes come only from actual local tasks and verified council turns',()=>{
 const {api}=harness();
 assert.equal(api.status(basic,'ChatGPT'),'inactive');
 const ready={...basic,tabs:[{url:'https://chatgpt.com/c/x'}]};
 assert.equal(api.status(ready,'ChatGPT'),'ready');
 assert.equal(api.status({...ready,tabs:[{url:'https://chatgpt.com/c/x',loading:true}]},'ChatGPT'),'loading');
 assert.equal(api.status(ready,'Gemini'),'inactive');
 const login={...basic,tabs:[{url:'https://claude.ai/login'}]};
 assert.equal(api.status(login,'Claude'),'login','a login screen is not an authenticated model');
 assert.equal(api.status({...login,tabs:[{url:'https://claude.ai/chat'}]},'Claude'),'ready');
 assert.equal(api.status({...login,tabs:[{url:'https://claude.ai/login',private:true}]},'Claude'),'inactive');
 const waiting={...ready,council:{status:'RUNNING',turns:[{model:'Gemini',status:'AWAITING_RESPONSE'}]}};
 assert.equal(api.status(waiting,'Gemini'),'waiting');
 const checked={...ready,council:{status:'COMPLETED',turns:[{model:'Gemini',status:'CAPTURED'}]}};
 assert.equal(api.status(checked,'Gemini'),'completed');
 const uncertain={...ready,council:{status:'SEND_UNCERTAIN_NO_RETRY',turns:[{model:'Gemini',status:'SEND_UNCERTAIN_NO_RETRY'}]}};
 assert.equal(api.status(uncertain,'Gemini'),'error');
 const local={...basic,models:[{id:'qwen3.5-4b'},{id:'llama3:8b'}],
    local:{turns:[{project:'p',model:'qwen3.5-4b',status:'RUNNING',output:'Verified local token'}]}};
 assert.equal(api.status(local,'qwen3.5-4b'),'speaking');
 assert.equal(api.status(local,'llama3:8b'),'local','different local models must not fake ongoing activity');
 assert.equal(api.status({...local,local:{turns:[{project:'p',model:'qwen3.5-4b',status:'COMPLETED',output:'ok'}]}},'qwen3.5-4b'),'completed');
});
test('Native selector gets one dynamically selected local persona; no duplicated listeners',()=>{
 const {api,body,selector,footer}=harness();
 const first=api.create('ChatGPT');
 body.appendChild(first);
 const current={...basic,models:[{id:'qwen3.5-4b'},{id:'llama3:8b'}]};
 api.refresh(body,current);
 assert.equal(footer.children.length,2);
 assert.equal(selector.events.size,1);
 const badge=footer.children[0];
 assert.equal(badge.className,'model-selected-avatar');
 assert.equal(badge.children[0].dataset.avatarIdentity,'qwen3.5-4b');
 assert.equal(first.dataset.avatarState,'inactive');
 const svgBefore=dump(badge.children[0].children[0]);
 selector.value='llama3:8b';
 selector.events.get('change')();
 assert.equal(badge.children[0].dataset.avatarIdentity,'llama3:8b');
 assert.notEqual(dump(badge.children[0].children[0]),svgBefore);
 assert.equal(footer.children.length,2);
 api.refresh(body,current);
 assert.equal(selector.events.size,1);
 assert.equal(badge.children[0].dataset.avatarState,'local');
});
test('The source shell wires animated characters to cards, council, tabs, context, and the approved palette',()=>{
 const html=fs.readFileSync(path.join(base,'ui','index.html'),'utf8');
 const shell=fs.readFileSync(path.join(base,'ui','shell.js'),'utf8');
 const main=fs.readFileSync(path.join(base,'src','main.mjs'),'utf8');
 assert.ok(html.includes('provider-avatars.css'));
 assert.ok(html.indexOf('provider-avatars.js')<html.indexOf('shell.js'));
 assert.ok(main.includes("'provider-avatars.js'"));
 assert.ok(main.includes("'provider-avatars.css'"));
 assert.ok(shell.includes('MNEMOSProviderAvatars?.refresh(document,next)'));
 assert.ok(shell.includes('MNEMOSProviderAvatars?.tabProvider(tab.url)'));
 assert.ok(shell.includes('const contextProject=append('));
 assert.ok(shell.includes('MNEMOSProviderAvatars?.create(p.id)'));
 const palette=fs.readFileSync(path.join(base,'ui','pipboy.css'),'utf8');
 assert.match(palette,/--accent:#e6e6e6/i);
 assert.doesNotMatch(html,/quiet-surface.css|reactbits-webthreads.css|living-conversation.css/);
});
test('Animations respect reduced-motion, stay muted and never call models or browser APIs',()=>{
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
 assert.match(css,/\.model-avatar\[data-avatar-state=waiting\]/);
 assert.match(css,/\.model-avatar\[data-avatar-state=verifying\]/);
 assert.match(css,/\.model-avatar\[data-avatar-state=completed\]/);
 assert.match(css,/\.model-selected-avatar/);
 assert.doesNotMatch(css,/(?:radial-gradient|linear-gradient|--accent:|--bg:|filter:drop-shadow)/);
 assert.doesNotMatch(source,/fetch\s*\(|XMLHttpRequest|innerHTML|localStorage|postMessage\s*\(|navigator\.clipboard/);
});

test('Council attention is evidence-backed; gaze follows only an on-screen active participant',()=>{
 const {api,body}=harness();
 const observer=api.create('ChatGPT');
 const speaker=api.create('Gemini');
 const speakerStage=api.create('Gemini',{size:'stage'});
 body.appendChild(observer);body.appendChild(speaker);body.appendChild(speakerStage);
 const observed=new Map();
 observer.style={setProperty:(name,value)=>observed.set(name,value)};
 observer.getBoundingClientRect=()=>({left:0,top:20,width:38,height:38});
 speaker.getBoundingClientRect=()=>({left:-120,top:20,width:38,height:38});
 speakerStage.getBoundingClientRect=()=>({left:120,top:20,width:88,height:110});
 const tabs=[{url:'https://chatgpt.com/c/x'},{url:'https://gemini.google.com/app'}];
 const active={...basic,tabs,council:{status:'RUNNING',turns:[{model:'ChatGPT',status:'CAPTURED'}, {model:'Gemini',status:'AWAITING_RESPONSE'}]}};
 assert.equal(api.status(active,'ChatGPT'),'listening');
 api.refresh(body,active);
 assert.equal(observer.dataset.avatarState,'listening');
 assert.ok(parseFloat(observed.get('--gaze-x'))>0,'gaze must point toward the actual visible participant');
 assert.ok(parseFloat(observed.get('--gaze-y'))>0,'stage target has a different actual vertical center');
 speaker.getBoundingClientRect=()=>({left:120,top:20,width:0,height:0});
 speakerStage.getBoundingClientRect=()=>({left:120,top:20,width:0,height:0});
 api.refresh(body,active);
 assert.equal(observed.get('--gaze-x'),'0.00px','no invented position when speaker is off screen');
 const completed={...active,council:{status:'COMPLETED',turns:[{model:'ChatGPT',status:'CAPTURED'}, {model:'Gemini',status:'CAPTURED'}]}};
 api.refresh(body,completed);
 assert.equal(api.status(completed,'ChatGPT'),'completed','previously captured participant must retain provenance');
 assert.equal(observer.dataset.avatarState,'completed');
 const unrelated={...active,tabs:[...tabs,{url:'https://claude.ai/chat'}]};
 assert.equal(api.status(unrelated,'Claude'),'ready','open nonparticipant cannot be portrayed as listening');
 const noHistory={...active,council:{status:'RUNNING',turns:[{model:'Gemini',status:'AWAITING_RESPONSE'}]}};
 assert.equal(api.status(noHistory,'ChatGPT'),'ready','uncaptured model cannot be portrayed as listening');
});

test('Each public persona uses distinct event-gated timing and stationary idle',()=>{
 for(const id of ['chatgpt','claude','gemini','perplexity','local']){
  assert.ok(css.includes('data-provider-avatar='+id+']'),id+' distinct motion mapping missing');
 }
 for(const name of ['chatgpt','claude','gemini','perplexity','relay']){
  assert.ok(css.includes('@keyframes model-avatar-'+name+'{'),name+' keyframes missing');
 }
 assert.match(css,/data-avatar-state=listening/);
 assert.match(css,/--gaze-x/);
 assert.doesNotMatch(css,/box-shadow|drop-shadow|radial-gradient|linear-gradient/);
});
