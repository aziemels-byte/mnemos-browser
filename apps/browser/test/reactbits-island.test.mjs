import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=relative=>fs.readFileSync(path.join(app,relative),'utf8');
const adapter=file('ui/reactbits-animated-list.js');

function rendererSandbox(){
  const create=(type,props,...children)=>({type,props:{...(props??{}),children}});
  const renders=[],unmounts=[];
  const React={
    Fragment:Symbol.for('react.fragment'),
    createElement:create,
    useRef:()=>({current:null}),
    useEffect:effect=>{effect();},
    useState:initial=>[typeof initial==='function'?initial():initial,()=>{}]
  };
  const ReactDOM={
    createRoot:host=>({
      render:element=>renders.push({host,element}),
      unmount:()=>unmounts.push(host)
    })
  };
  class HTMLElement{}
  class Host extends HTMLElement{constructor(){super();this.isConnected=true;}}
  const ctx={
    window:{React,ReactDOM},
    HTMLElement,document:{body:{},activeElement:null},
    MutationObserver:class{observe(){}},console:{error(){}},
    setTimeout,clearTimeout
  };
  vm.runInNewContext(adapter,ctx,{filename:'reactbits-animated-list.js'});
  return {api:ctx.window.MNEMOSReactBits,renders,unmounts,Host};
}
function traverse(element,found=[]){
  if(element===null||element===undefined)return found;
  if(Array.isArray(element)){for(const child of element)traverse(child,found);return found;}
  if(typeof element!=='object')return found;
  if(typeof element.type==='function'){
    // Component hooks are pure in our test renderer.
    return traverse(element.type(element.props),found);
  }
  found.push(element);
  traverse(element.props?.children,found);
  return found;
}
const turns=[
  {id:'a1',model:'ChatGPT',status:'CAPTURED',
    answer:'Pierādīta atbilde <img src=x onerror=alert(1)> un drošs teksts.',url:'https://chatgpt.com/c/example'},
  {id:'b2',model:'Gemini',status:'CAPTURED',
    answer:'Pārbaudītais Gemini teksts.',routing:{status:'LOCAL_MODEL',nextModel:'Perplexity',intent:'CHALLENGE',model:'qwen3:4b'}},
  {id:'c3',model:'Perplexity',status:'AWAITING_RESPONSE',
    inspectionAttempts:3,lastReadReason:'WAITING'}
];
const labels={statusLabel:status=>({'CAPTURED':'Atbilde nolasīta','AWAITING_RESPONSE':'Gaida AI atbildi'}[status]??status),
  errorLabel:value=>String(value)};

test('Vendored React18 script executes and exports working element/hook API in an isolated browser-like context',()=>{
  const sandbox={};
  sandbox.self=sandbox;
  sandbox.window=sandbox;
  vm.runInNewContext(file('ui/vendor/react.production.min.js'),sandbox,{timeout:2000});
  assert.equal(sandbox.React.version,'18.2.0');
  assert.equal(typeof sandbox.React.createElement,'function');
  assert.equal(typeof sandbox.React.useEffect,'function');
  assert.equal(typeof sandbox.React.useState,'function');
  const node=sandbox.React.createElement('div',{id:'test'},'Latviski');
  assert.equal(node.type,'div');
  assert.equal(node.props.children,'Latviski');
});
test('Vendored React Bits runtime remains local and disabled in the default shell',()=>{
  const react=file('ui/vendor/react.production.min.js');
  const dom=file('ui/vendor/react-dom.production.min.js');
  assert.match(react,/@license React/);
  assert.match(react,/18\.2\.0/);
  assert.match(dom,/@license React/);
  assert.match(dom,/createRoot/);
  assert.ok(react.length>10000&&dom.length>100000);
  const html=file('ui/index.html');
  for(const name of [
    'vendor/react.production.min.js','vendor/react-dom.production.min.js',
    'reactbits-animated-list.js','reactbits.css']){
    assert.ok(!html.includes(name),name+' is disabled in the default shell');
    assert.ok(file('src/main.mjs').includes("'"+name+"'"),name+' is privileged-scheme allowlisted');
  }
  assert.match(file('src/main.mjs'),/script-src 'self'; style-src 'self'/);
  assert.match(file('src/main.mjs'),/connect-src 'none'/);
  assert.doesNotMatch(html,/https?:\/\/[^"']+\.(?:js|css)/);
});
test('React Bits adaptation mounts, exposes real React component and renders received turns as plain text',()=>{
  const {api,Host,renders,unmounts}=rendererSandbox();
  assert.equal(api.available,true);
  assert.match(api.component,/React Bits \/ AnimatedList/);
  const host=new Host();
  assert.equal(api.mountCouncil(host,{turns},labels),true);
  assert.equal(renders.length,1);
  const nodes=traverse(renders[0].element);
  assert.equal(nodes.filter(n=>n.type==='li').length,3);
  assert.equal(nodes.filter(n=>n.type==='article').length,3);
  assert.equal(nodes.filter(n=>n.type==='ol').length,1);
  assert.ok(nodes.some(n=>n.type==='section'&&n.props['data-reactbits-component']==='AnimatedList'));
  assert.ok(nodes.some(n=>n.type==='div'&&n.props.children.includes(turns[1].answer)));
  assert.ok(nodes.some(n=>n.type==='small'&&n.props.children.some(x=>typeof x==='string'&&x.includes('Pārbaudes: 3'))));
  // Never interpret third-party model text as markup or executable code.
  assert.doesNotMatch(adapter,/innerHTML|dangerouslySetInnerHTML|eval\s*\(/);
  assert.equal(api.mountCouncil(host,{turns},labels),true);
  assert.equal(renders.length,2);
  assert.equal(unmounts.length,0);
  host.isConnected=false;
  api.cleanup();
  assert.equal(unmounts.length,1);
});
test('React Bits roster is always visible and uses existing native toggle validation',()=>{
  const {api,Host,renders}=rendererSandbox();
  const host=new Host();
  let called=0,ready=0;
  const items=[
    {id:'chatgpt',model:'ChatGPT',title:'ChatGPT conversation',selected:true},
    {id:'gemini',model:'Gemini',title:'Gemini conversation',selected:false},
    {id:'perplexity',model:'Perplexity',title:'Perplexity conversation',selected:false}
  ];
  const accepted=api.mountRoster(host,items,{
    onToggle:(id,desired)=>{called++;return id==='gemini'&&desired;},
    onReady:()=>ready++
  });
  assert.equal(accepted,true);
  assert.equal(renders.length,1);
  const nodes=traverse(renders[0].element);
  assert.equal(ready,1);
  assert.equal(nodes.filter(n=>n.type==='input').length,3);
  assert.ok(nodes.some(n=>n.type==='span'&&n.props.children.includes('REACT BITS · ACTIVE')));
  const checkbox=nodes.filter(n=>n.type==='input')[1];
  checkbox.props.onChange({target:{checked:true}});
  assert.equal(called,1);
  assert.match(file('ui/reactbits.css'),/\.rb-roster-entry/);
  const shell=file('ui/shell.js');
  assert.match(shell,/MNEMOSReactBits\?\.mountRoster/);
  assert.match(shell,/native\.dispatchEvent\(new Event\('change'/);
  assert.match(shell,/targetList\.hidden=true/);
});
test('Failed React installation is optional, not allowed to destroy the existing native transcript',()=>{
  const sandbox={window:{},console:{}};
  vm.runInNewContext(adapter,sandbox);
  assert.equal(sandbox.window.MNEMOSReactBits.available,false);
  const shell=file('ui/shell.js');
  assert.match(shell,/const nativeMessages=element\('div','council-native-fallback'\)/);
  assert.match(shell,/nativeMessages\.append\(row\)/);
  assert.match(shell,/if\(mounted\)nativeMessages\.hidden=true/);
  assert.match(shell,/else island\.remove\(\)/);
  assert.match(shell,/if\(!messages\.isConnected\)return/);
});
test('UI stays sober and keyboard interactions are scoped to list',()=>{
  const css=file('ui/reactbits.css');
  assert.match(css,/\.rb-enter/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css,/(?:radial-gradient|linear-gradient|box-shadow:.*glow)/);
  assert.match(adapter,/onKeyDown: navigate/);
  assert.doesNotMatch(adapter,/window\.addEventListener\(['"]keydown/);
  assert.match(adapter,/type: 'button'/);
  assert.match(adapter,/'aria-expanded'/);
});
test('Upstream React Bits license is present and attributed',()=>{
  const lic=file('ui/reactbits-license.txt');
  assert.match(lic,/MIT \+ Commons Clause/);
  assert.match(lic,/David Haz/);
  assert.match(lic,/AnimatedList/);
  assert.match(adapter,/Original: https:\/\/github\.com\/DavidHDev\/react-bits/);
});
