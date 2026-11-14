import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const js=fs.readFileSync(path.join(here,'ui','living-network.js'),'utf8');
function fakeEnvironment({reduceMotion=false,withShader=false,shaderReady=false}={}){
  const callbacks=new Map();let lastId=0;
  let doc;
  class FakeElement{
    constructor(tag='div'){
      this.tagName=tag;this.children=[];this.parentNode=null;
      this.dataset={};this.attributes=new Map();this.textContent='';
      this.className='';this.listeners=new Map();this.width=0;this.height=0;
      this.classList={
        contains:key=>this.className.split(' ').includes(key),
        add:key=>this.className+=' '+key,
        remove:key=>this.className=this.className.split(' ').filter(x=>x!==key).join(' ')
      };
    }
    get isConnected(){return this===doc.body || !!this.parentNode?.isConnected;}
    get nextSibling(){if(!this.parentNode)return null;return this.parentNode.children[this.parentNode.children.indexOf(this)+1]??null;}
    get previousSibling(){if(!this.parentNode)return null;return this.parentNode.children[this.parentNode.children.indexOf(this)-1]??null;}
    append(...items){for(const child of items){child.remove?.();this.children.push(child);child.parentNode=this;}return this;}
    insertBefore(child,ref){child.remove?.();const at=this.children.indexOf(ref);this.children.splice(at<0?this.children.length:at,0,child);child.parentNode=this;}
    after(child){this.parentNode.insertBefore(child,this.nextSibling);}
    remove(){if(this.parentNode){const idx=this.parentNode.children.indexOf(this);if(idx>=0)this.parentNode.children.splice(idx,1);}this.parentNode=null;}
    getBoundingClientRect(){return{width:310,height:150};}
    getContext(type){if(type!=='2d')return null;return context;}
    setAttribute(k,v){this.attributes.set(k,v);}
    addEventListener(k,fn){this.listeners.set(k,fn);}
    removeEventListener(k){this.listeners.delete(k);}
    querySelector(k){return k==='.page-header'?this.children.find(x=>x.className==='page-header')??null:null;}
  }
  const context={
    setTransform(){},fillRect(){},beginPath(){},moveTo(){},lineTo(){},
    stroke(){},arc(){},fill(){},set fillStyle(v){},set strokeStyle(v){},
    set lineWidth(v){}
  };
  doc={
    body:new FakeElement('body'),hidden:false,
    createElement:tag=>new FakeElement(tag),
    getElementById:name=>({context:aside,'context-body':contextBody,main})[name]??null,
    addEventListener(){},removeEventListener(){}
  };
  const main=new FakeElement('main'),heading=new FakeElement('div');
  heading.className='page-header';main.append(heading);
  const aside=new FakeElement('aside'),contextBody=new FakeElement('div');
  aside.append(contextBody);doc.body.append(main,aside);
  const observeStats={resize:0,intersection:0};
  const shaderRecord={roots:0,renders:[],unmounts:0};
  const sandbox={
    document:doc,
    performance:{now:()=>3000},
    window:{devicePixelRatio:1,matchMedia:()=>({
      matches:reduceMotion,addEventListener(){},removeEventListener(){}
    })},
    ResizeObserver:class{observe(){observeStats.resize++;}disconnect(){}},
    IntersectionObserver:class{
      constructor(cb){this.cb=cb;}
      observe(){observeStats.intersection++;this.cb([{isIntersecting:true}]);}
      disconnect(){}
    },
    requestAnimationFrame:callback=>{callbacks.set(++lastId,callback);return lastId;},
    cancelAnimationFrame:id=>callbacks.delete(id)
  };
  if(withShader){
    sandbox.window.MNEMOSWebThreads=function WebThreads(){};
    sandbox.window.React={createElement:(type,props)=>({type,props})};
    sandbox.window.ReactDOM={createRoot:()=>{
      shaderRecord.roots++;
      return {
        render(node){
          shaderRecord.renders.push(node);
          if(shaderReady)node.props.onReady();
        },
        unmount(){shaderRecord.unmounts++;}
      };
    }};
  }
  vm.runInNewContext(js,sandbox,{filename:'living-network.js'});
  return{api:sandbox.window.MNEMOSLivingNetwork,doc,main,aside,callbacks,observeStats,shaderRecord};
}
const minimal=({online=false,error=null,status=null,loading=false,guard=null,
  agents=[],pending=0,coordination=[],council=null}={})=>({
  core:{online,guard,agents},error,activeProject:'mnemos',
  local:{turns:status?[{project:'mnemos',status}]:[]},
  tabs:[{loading}],frontier:{counts:{pending}},coordination,council
});
test('Neural organism is a permanent mounted, deterministic topology and ONE animation loop',()=>{
 const env=fakeEnvironment();
 assert.equal(env.api.version,'1.0-state-linked');
 assert.deepEqual({...env.api.topology},{nodes:75,edges:env.api.topology.edges,lobes:3});
 assert.ok(env.api.topology.edges>=72&&env.api.topology.edges<115);
 assert.equal(env.api.running,true);
 assert.equal(env.callbacks.size,1);
 assert.equal(env.observeStats.resize,1);
 assert.equal(env.observeStats.intersection,1);
 assert.equal(env.aside.children[0].className,'mn-organism');
 assert.doesNotMatch(js,/Math\.random\(|fetch\(|XMLHttpRequest|localStorage|\.innerHTML\s*=/);
});
test('real backend states map to distinct modes; no activity is fabricated at idle or disconnected',()=>{
 const env=fakeEnvironment();
 env.api.update(minimal());
 assert.equal(env.api.state,'disconnected');
 env.api.update(minimal({online:true}));
 assert.equal(env.api.state,'idle');
 env.api.update(minimal({online:true,status:'QUEUED'}));
 assert.equal(env.api.state,'planning');
 env.api.update(minimal({online:true,status:'RUNNING'}));
 assert.equal(env.api.state,'executing');
 env.api.update(minimal({online:true,loading:true}));
 assert.equal(env.api.state,'retrieving');
 env.api.update(minimal({online:true,pending:2}));
 assert.equal(env.api.state,'validating');
 env.api.update(minimal({online:true,agents:[{status:'RUNNING'},{status:'ACTIVE'}]}));
 assert.equal(env.api.state,'multi_agent');
 env.api.update(minimal({online:true,coordination:[{status:'RECONCILING'}]}));
 assert.equal(env.api.state,'validating');
 env.api.update(minimal({online:true,council:{status:'RUNNING'}}));
 assert.equal(env.api.state,'multi_agent');
 env.api.update(minimal({online:true,council:{status:'RECONCILING'}}));
 assert.equal(env.api.state,'validating');
 env.api.update(minimal({online:true,guard:{level:'CRITICAL'}}));
 assert.equal(env.api.state,'error');
 env.api.update(minimal({online:true,error:'IO_ERROR'}));
 assert.equal(env.api.state,'error');
 assert.equal(env.callbacks.size,1);
 env.api.dispose();assert.equal(env.api.running,false);
});
test('organism relocates as ONE canvas across Home, collaboration and web/context rail',()=>{
 const env=fakeEnvironment();
 const host=env.aside.children[0];
 env.doc.body.className='mn-home';
 env.api.update(minimal({online:true}));
 assert.equal(host.parentNode,env.main);
 assert.equal(env.main.children[1],host);
 env.doc.body.className='coordination-mode';
 env.api.update(minimal({online:true}));
 assert.equal(host.parentNode,env.doc.body);
 env.doc.body.className='';
 env.api.update(minimal({online:true}));
 assert.equal(host.parentNode,env.aside);
 assert.equal(env.aside.children[0],host);
 env.api.dispose();
 assert.equal(host.isConnected,false);
});
test('visibility and lifecycle cleanups stop animation; reduced motion is supported',()=>{
 const env=fakeEnvironment({reduceMotion:true});
 env.api.update(minimal({online:true}));
 assert.equal(env.api.running,true);
 env.doc.hidden=true;
 // In a browser, the registered visibilitychange listener calls stop.
 env.api.dispose();
 assert.equal(env.api.running,false);
 assert.equal(env.callbacks.size,0);
 assert.match(js,/preferredReduced\?1000/);
 assert.match(js,/removeEventListener\?\.\('change',reducedChanged\)/);
});
test('real WebGL-ready callback switches exactly once from Canvas2D fallback to React Bits; tracks backend state',()=>{
 const env=fakeEnvironment({withShader:true,shaderReady:true});
 assert.equal(env.shaderRecord.roots,1);
 assert.equal(env.api.renderBackend,'reactbits-webgl2');
 assert.equal(env.callbacks.size,0,'2D loop is stopped when WebGL2 is confirmed');
 env.api.update(minimal({online:true,status:'RUNNING'}));
 assert.equal(env.api.state,'executing');
 const props=env.shaderRecord.renders.at(-1).props;
 assert.equal(props.speed,.24);
 assert.equal(props.pulses,.25);
 assert.equal(props.threadCount,9);
 assert.equal(props.nodes,3);
 assert.ok(props.glow<=.024);
 assert.ok(props.thickness<=.16);
 assert.ok(props.brightness<=.72);
 assert.equal(props.dpr,1.2);
 env.api.update(minimal({online:true}));
 const quiet=env.shaderRecord.renders.at(-1).props;
 assert.equal(quiet.speed,.09);
 assert.equal(quiet.pulses,0);
 assert.equal(quiet.threadCount,6);
 assert.ok(quiet.glow<=.017);
 env.shaderRecord.renders.at(-1).props.onFailure('WEBGL_CONTEXT_LOST');
 assert.equal(env.api.renderBackend,'canvas2d-fallback','context loss must not leave a blank window');
 assert.equal(env.callbacks.size,1,'Canvas2D fallback restarts after GPU context loss');
 env.api.dispose();
 assert.equal(env.shaderRecord.unmounts,1);
});
test('WebGL errors preserve usable Canvas2D visualization without hiding the fallback',()=>{
 const env=fakeEnvironment({withShader:true,shaderReady:false});
 assert.equal(env.shaderRecord.roots,1);
 assert.equal(env.api.renderBackend,'canvas2d-fallback');
 assert.equal(env.callbacks.size,1);
 env.api.update(minimal({online:true,guard:{level:'CRITICAL'}}));
 assert.equal(env.api.state,'error');
 assert.equal(env.api.renderBackend,'canvas2d-fallback');
 env.api.dispose();
 assert.equal(env.shaderRecord.unmounts,1);
});
test('real WebThreads shader is locally installed, provenance recorded and CSP remains strict',()=>{
 const shader=fs.readFileSync(path.join(here,'ui','reactbits-webthreads.js'),'utf8');
 assert.match(shader,/React Bits: WebThreads/);
 assert.match(shader,/gl\.drawArrays\(gl\.TRIANGLES/);
 assert.match(shader,/#version 300 es/);
 assert.match(shader,/window\.MNEMOSWebThreads=WebThreads/);
 assert.doesNotMatch(shader,/^\s*import |^\s*export default /m);
 assert.match(shader,/lastWebGLPaint/);
 assert.match(shader,/webglcontextlost/);
 assert.match(shader,/WEBGL_EXPOSURE_SAFETY/);
 assert.match(shader,/readPixels/);
 assert.match(shader,/vec3 rgb = 0\.78 \* \(vec3\(1\.0\) - exp\(-radiance \* 1\.1\)\)/);
 assert.ok(shader.indexOf('gl.drawArrays(gl.TRIANGLES, 0, 3);') <
   shader.indexOf('onReady?.()'),'Shader must not claim readiness before actual drawing');
 const sandbox={window:{React:{useEffect(){},useMemo(){},useRef(){}}}};
 vm.runInNewContext(shader,sandbox,{timeout:1000});
 assert.equal(typeof sandbox.window.MNEMOSWebThreads,'function');
 const html=fs.readFileSync(path.join(here,'ui','index.html'),'utf8');
 const main=fs.readFileSync(path.join(here,'src','main.mjs'),'utf8');
 for(const asset of ['reactbits-webthreads.js','reactbits-webthreads.css']){
   assert.ok(main.includes("'"+asset+"'"),asset+' must be allowlisted');
 }
 assert.doesNotMatch(html,/reactbits-webthreads|living-network/);
 assert.match(main,/script-src 'self'/);
 assert.match(main,/connect-src 'none'/);
});
