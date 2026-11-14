import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {attachBrowserFile} from '../src/browser-file-upload.mjs';

function createFixture(){
  const element={
    tagName:'INPUT',type:'file',accept:'.pdf,.docx',files:[],disabled:false,
    id:'',labels:[{innerText:'Upload CV'}],name:'cv-file',multiple:false,
    getBoundingClientRect:()=>({width:0,height:0}),
    closest:()=>null,hasAttribute:()=>false,attributes:{},
    getAttribute(name){return this.attributes[name]??({type:'file',autocomplete:'off',name:'cv-file'})[name]??null},
    setAttribute(name,value){this.attributes[name]=value},
    removeAttribute(name){delete this.attributes[name]}
  };
  const document={
    title:'Job application',body:{innerText:'Apply'},
    querySelectorAll:q=>q.startsWith('input,textarea,select')?[element]:[],
    querySelector:q=>q.startsWith('input[data-mnemos-file-token')?element:null,
  };
  const context={document,location:{origin:'https://jobs.example.com',pathname:'/apply'},
    getComputedStyle:()=>({visibility:'hidden',display:'none'}),CSS:{escape:s=>s},
    URL,Set,Error,Number,String,Array,Boolean};
  let active=false,commands=[];
  const wc={
    isDestroyed:()=>false,
    getURL:()=> 'https://jobs.example.com/apply',
    executeJavaScript:script=>vm.runInNewContext(script,context,{timeout:3000}),
    debugger:{
      isAttached:()=>active,
      attach(){if(active)throw new Error('DOUBLE_ATTACH');active=true;},
      detach(){active=false;},
      async sendCommand(name,args){
        commands.push(name);
        if(name==='DOM.getDocument')return {root:{nodeId:100}};
        if(name==='DOM.querySelector'){
          assert.match(args.selector,/data-mnemos-file-token/);
          return {nodeId:101};
        }
        if(name==='DOM.setFileInputFiles'){
          assert.equal(args.nodeId,101);
          element.files=[{name:path.basename(args.files[0])}];
          return {};
        }
        throw new Error('UNEXPECTED_DEBUG_COMMAND');
      }
    }
  };
  return {wc,element,commands,isAttached:()=>active};
}
test('file path is chosen by owner, never supplied by MCP caller; setFileInputFiles scoped to verified input',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'mnemos-browser-upload-'));
  try{
    const file=path.join(tmp,'example-cv.pdf');await writeFile(file,Buffer.from('%PDF-1.4\nTEST\n'));
    const f=createFixture();
    const res=await attachBrowserFile(f.wc,{operation:'tab.attach',expectedOrigin:'https://jobs.example.com',
      index:0,expectedName:'Upload CV'},{
        ownerWindow:{},showOpenDialog:async()=>({canceled:false,filePaths:[file]})
    });
    assert.equal(res.attached,true);
    assert.equal(res.fileName,'example-cv.pdf');
    assert.equal(res.siteAccepted,false);
    assert.equal(res.submitted,false);
    assert.deepEqual(f.commands,['DOM.getDocument','DOM.querySelector','DOM.setFileInputFiles']);
    assert.equal(f.isAttached(),false);
    assert.equal(f.element.getAttribute('data-mnemos-file-token'),null);
  }finally{await rm(tmp,{recursive:true,force:true})}
});
test('cancelled chooser causes no file attachment and no CDP operation',async()=>{
  const f=createFixture();
  const res=await attachBrowserFile(f.wc,{operation:'tab.attach',
    expectedOrigin:'https://jobs.example.com',index:0,expectedName:'Upload CV'},{
      ownerWindow:{},showOpenDialog:async()=>({canceled:true,filePaths:[]})
  });
  assert.equal(res.cancelled,true);assert.equal(f.commands.length,0);
});
test('remote model cannot provide a file path, and unsupported or oversized uploads are rejected',async()=>{
  const f=createFixture();
  const tmp=await mkdtemp(path.join(os.tmpdir(),'mnemos-browser-upload-'));
  try{
    const ex=path.join(tmp,'config.exe');await writeFile(ex,'do not upload executable');
    await assert.rejects(()=>attachBrowserFile(f.wc,{operation:'tab.attach',index:0,
      expectedOrigin:'https://jobs.example.com',expectedName:'Upload CV'},{
        showOpenDialog:async()=>({canceled:false,filePaths:[ex]})
    }),/FILE_TYPE_NOT_ALLOWED/);
    assert.equal(f.commands.length,0);
    const wrong=path.join(tmp,'photo.jpg');await writeFile(wrong,Buffer.from('jpeg test'));
    await assert.rejects(()=>attachBrowserFile(f.wc,{operation:'tab.attach',index:0,
      expectedOrigin:'https://jobs.example.com',expectedName:'Upload CV'}, {
        showOpenDialog:async()=>({canceled:false,filePaths:[wrong]})
    }),/FILE_NOT_ACCEPTED_BY_SITE_FIELD/);
    await assert.rejects(()=>attachBrowserFile(f.wc,{operation:'tab.attach',index:0,
      expectedOrigin:'https://jobs.example.com',expectedName:'Password'},{
        showOpenDialog:async()=>({canceled:false,filePaths:[]})
    }),/FILE_INPUT_CHANGED/);
  }finally{await rm(tmp,{recursive:true,force:true})}
});

test('revocation after the owner chooses a file stops it before Chromium receives the path',async()=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'mnemos-browser-upload-'));
  try{
    const file=path.join(tmp,'test.pdf');await writeFile(file,'%PDF-1.4\nTEST\n');
    const f=createFixture();
    await assert.rejects(()=>attachBrowserFile(f.wc,{operation:'tab.attach',index:0,
      expectedOrigin:'https://jobs.example.com',expectedName:'Upload CV'}, {
        showOpenDialog:async()=>({canceled:false,filePaths:[file]}),
        authorize:async()=>{throw new Error('BROWSER_GRANT_DENIED');}
    }),/BROWSER_GRANT_DENIED/);
    assert.ok(!f.commands.includes('DOM.setFileInputFiles'));
    assert.equal(f.element.files.length,0);
    assert.equal(f.isAttached(),false);
    assert.equal(f.element.getAttribute('data-mnemos-file-token'),null);
  }finally{await rm(tmp,{recursive:true,force:true})}
});
