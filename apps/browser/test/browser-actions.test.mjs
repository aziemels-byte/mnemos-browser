import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {performBrowserAction} from '../src/browser-actions.mjs';

function fixture(){
  let url='https://example.com/apply',submitted=0;
  const inputs=[
    {tag:'INPUT',type:'text',typeAttribute:null,name:'applicant',label:'Applicant name',value:'',hidden:false},
    {tag:'INPUT',type:'password',name:'password',label:'Password',value:'',hidden:false},
    {tag:'TEXTAREA',type:'',name:'motivation',label:'Motivation',value:'',hidden:false}
  ];
  const buttons=[{tag:'BUTTON',type:'submit',text:'Apply now',clicked:()=>submitted++},
    {tag:'BUTTON',type:'button',text:'Help',clicked:()=>{}}];
  const document={title:'Application',body:{innerText:'Application form: full name, password, cover letter.'},
    activeElement:null,querySelectorAll(selector){
      if(selector.startsWith('input,textarea'))return inputs.map(x=>x.node);
      if(selector.startsWith('button,'))return buttons.map(x=>x.node);
      return [];
    },
    querySelector(){return null},
    elementFromPoint(x,y){
      return buttons.map(b=>b.node).find(node=>{
        const r=node.getBoundingClientRect();
        return Number.isFinite(r.left)&&x>=r.left&&y>=r.top&&
          x<r.left+r.width&&y<r.top+r.height;
      })||null;
    }
  };
  for(const data of inputs){
    data.node={
      tagName:data.tag,type:data.type,value:data.value,name:data.name,disabled:false,required:false,readOnly:false,
      isContentEditable:false,id:'',labels:[{innerText:data.label}],
      getAttribute(key){return {type:data.typeAttribute===undefined?this.type:data.typeAttribute,name:data.name,autocomplete:''}[key]??null},
      hasAttribute(){return false},
      getBoundingClientRect(){return {width:350,height:34}},
      closest(){return null},focus(){document.activeElement=this},
      innerText:'',
    };
  }
  for(const [i,data] of buttons.entries()){
    data.node={
      tagName:data.tag,type:data.type,value:'',title:'',disabled:false,
      innerText:data.text,
      getAttribute(key){return {type:this.type}[key]??null},
      getBoundingClientRect(){return {left:20,top:35+i*60,width:180,height:38}},closest(){return null},
      contains(node){return node===this},
      click:data.clicked,
    };
  }
  const context={document,window:{innerWidth:1200,innerHeight:900},location:{origin:'https://example.com',pathname:'/apply'},
    getComputedStyle:()=>({display:'block',visibility:'visible'}),URL,Set,Error,Number,String,
    CSS:{escape:txt=>txt},Event:class{constructor(name,opts){this.type=name;this.bubbles=opts?.bubbles;}}};
  const inputEvents=[];
  const wc={isDestroyed:()=>false,getURL:()=>url,
    executeJavaScript:async(script)=>vm.runInNewContext(script,context,{timeout:3500}),
    insertText:text=>{if(document.activeElement?.tagName==='TEXTAREA'||document.activeElement?.tagName==='INPUT')document.activeElement.value=text;},
    sendInputEvent:e=>{
      inputEvents.push(e);
      if(e.type==='mouseUp')document.elementFromPoint(e.x,e.y)?.click();
    }
  };
  return {wc,inputs,buttons,document,inputEvents,getSubmits:()=>submitted,setUrl:x=>{url=x}};
}
test('actual fixed browser script lists fields without values and blocks sensitive input',async()=>{
  const f=fixture();
  const read=await performBrowserAction(f.wc,{operation:'tab.describe',expectedOrigin:'https://example.com'});
  assert.equal(read.title,'Application');
  assert.equal(read.fields.length,3);
  assert.equal(read.fields[0].name,'Applicant name');
  assert.equal(read.fields[0].type,'text');
  assert.equal(read.fields[1].blocked,true);
  assert.equal(read.buttons[0].text,'Apply now');
  assert.equal(read.fields[1].filled,false);
  await assert.rejects(()=>performBrowserAction(f.wc,{operation:'tab.fill',expectedOrigin:'https://example.com',
    index:1,expectedName:'Password',value:'unsafe'}),/SENSITIVE_FIELD_BLOCKED/);
  const fill=await performBrowserAction(f.wc,{operation:'tab.fill',expectedOrigin:'https://example.com',
    index:0,expectedName:'Applicant name',value:'Jane Example'});
  assert.equal(fill.filled,true);
  assert.equal(f.inputs[0].node.value,'Jane Example');
  assert.equal(fill.submitted,false);
  await assert.rejects(()=>performBrowserAction(f.wc,{operation:'tab.fill',expectedOrigin:'https://example.com',
    index:0,expectedName:'Applicant name',value:'Overwritten'}),/FIELD_NOT_EMPTY/);
  assert.equal(f.getSubmits(),0);
});
test('dropdown selection and checkbox state changes are bounded and never submit',async()=>{
  const f=fixture();
  const select={tagName:'SELECT',type:'select-one',disabled:false,required:true,id:'',labels:[{innerText:'Contract type'}],
    value:'',options:[{value:'',textContent:'Choose',disabled:false},
      {value:'full',textContent:'Full-time',disabled:false},{value:'part',textContent:'Part-time',disabled:false}],
    getAttribute:k=>k==='name'?'contract':null,
    getBoundingClientRect:()=>({width:300,height:33}),closest:()=>null,
    dispatchEvent:()=>true};
  const box={tagName:'INPUT',type:'checkbox',disabled:false,checked:false,id:'',labels:[{innerText:'I agree to the terms'}],value:'on',
    getAttribute:k=>k==='type'?'checkbox':k==='name'?'terms':null,
    getBoundingClientRect:()=>({width:18,height:18}),closest:()=>null,
    dispatchEvent:()=>true};
  f.inputs.push({node:select},{node:box});
  const described=await performBrowserAction(f.wc,{operation:'tab.describe',expectedOrigin:'https://example.com'});
  assert.equal(described.fields[3].options[1].label,'Full-time');
  const chosen=await performBrowserAction(f.wc,{operation:'tab.choose',expectedOrigin:'https://example.com',
    index:3,expectedName:'Contract type',value:'part'});
  assert.equal(chosen.changed,true);
  assert.equal(select.value,'part');
  await assert.rejects(()=>performBrowserAction(f.wc,{operation:'tab.choose',expectedOrigin:'https://example.com',
    index:3,expectedName:'Contract type',value:'secret-option'}),/OPTION_NOT_FOUND/);
  const toggled=await performBrowserAction(f.wc,{operation:'tab.toggle',expectedOrigin:'https://example.com',
    index:4,expectedName:'I agree to the terms',checked:true});
  assert.equal(toggled.changed,true);
  assert.equal(box.checked,true);
  assert.equal(f.getSubmits(),0);
});
test('Perplexity Iesniegt button requires explicit submit permission even when HTML type is button',async()=>{
  const f=fixture();
  let clicked=0;
  f.buttons.push({node:{
    tagName:'BUTTON',type:'button',title:'',value:'',disabled:false,
    innerText:'Iesniegt',getAttribute:key=>key==='type'?'button':null,
    getBoundingClientRect:()=>({left:20,top:155,width:80,height:30}),closest:()=>null,
    contains(node){return node===this},click:()=>clicked++,
  }});
  const details=await performBrowserAction(f.wc,{operation:'tab.describe',expectedOrigin:'https://example.com'});
  const target=details.buttons.find(b=>b.text==='Iesniegt');
  assert.equal(target.submit,true);
  await assert.rejects(()=>performBrowserAction(f.wc,{operation:'tab.click',expectedOrigin:'https://example.com',
    index:target.index,expectedText:'Iesniegt'}),/EXPLICIT_SUBMIT_ACTION/);
  assert.equal(clicked,0);
  const submitted=await performBrowserAction(f.wc,{operation:'tab.submit',expectedOrigin:'https://example.com',
    index:target.index,expectedText:'Iesniegt'});
  assert.equal(submitted.submitted,true);
  assert.equal(submitted.verifiedSubmission,false);
  assert.equal(submitted.method,'NATIVE_POINTER_SINGLE_ATTEMPT');
  assert.deepEqual(f.inputEvents.map(e=>e.type),['mouseMove','mouseDown','mouseUp']);
  assert.equal(clicked,1);
});
test('native submit refuses an obscured or renamed button and does not send any pointer event',async()=>{
  const f=fixture();
  const submit={operation:'tab.submit',expectedOrigin:'https://example.com',
    index:0,expectedText:'Apply now'};
  f.document.elementFromPoint=()=>null;
  await assert.rejects(()=>performBrowserAction(f.wc,submit),/SUBMIT_BUTTON_OBSCURED/);
  assert.equal(f.inputEvents.length,0);
  const target=f.buttons[0].node;
  target.innerText='Cancel';
  await assert.rejects(()=>performBrowserAction(f.wc,submit),/BUTTON_CHANGED/);
  assert.equal(f.inputEvents.length,0);
});
test('native submission cannot silently fall back to an untrusted DOM click',async()=>{
  const f=fixture();
  f.wc.sendInputEvent=undefined;
  await assert.rejects(()=>performBrowserAction(f.wc,{
    operation:'tab.submit',expectedOrigin:'https://example.com',
    index:0,expectedText:'Apply now'
  }),/NATIVE_SUBMIT_INPUT_UNAVAILABLE/);
  assert.equal(f.getSubmits(),0);
});

test('large authenticated page supports bounded pagination beyond first 64 controls',async()=>{
  const f=fixture();
  for(let i=0;i<100;i++)f.buttons.push({node:{
    tagName:'BUTTON',type:'button',title:'',value:'',disabled:false,
    innerText:'Open job '+i,getAttribute:key=>key==='type'?'button':null,
    getBoundingClientRect:()=>({width:140,height:28}),closest:()=>null,click:()=>{}
  }});
  const first=await performBrowserAction(f.wc,{operation:'tab.describe',
    expectedOrigin:'https://example.com',fieldOffset:0,buttonOffset:0,limit:16});
  assert.equal(first.totalButtons,102);
  assert.equal(first.buttons.length,16);
  assert.equal(first.nextButtonOffset,16);
  assert.ok(JSON.stringify(first).length<12000);
  const second=await performBrowserAction(f.wc,{operation:'tab.describe',
    expectedOrigin:'https://example.com',fieldOffset:0,buttonOffset:68,limit:12});
  assert.equal(second.buttons[0].index,68);
  assert.equal(second.buttons[0].text,'Open job 66');
  assert.equal(second.nextButtonOffset,80);
  assert.ok(JSON.stringify(second).length<12000);
  await assert.rejects(()=>performBrowserAction(f.wc,{operation:'tab.describe',
    expectedOrigin:'https://example.com',buttonOffset:-1,limit:12}),/INVALID_CONTROL_PAGE/);
});
test('link descriptions omit query strings and URL fragments containing tokens',async()=>{
  const f=fixture();
  f.buttons.push({node:{
    tagName:'A',href:'https://jobs.example.com/apply?private_token=secret#fragment',type:'',
    title:'',value:'',disabled:false,innerText:'View job',getAttribute:()=>null,
    getBoundingClientRect:()=>({width:150,height:30}),closest:()=>null,
    click:()=>{}
  }});
  const got=await performBrowserAction(f.wc,{operation:'tab.describe',
    expectedOrigin:'https://example.com',buttonOffset:0,limit:16});
  assert.equal(got.buttons.at(-1).href,'https://jobs.example.com/apply');
});
test('reviewed page binding rejects same-origin path changes before any action',async()=>{
  const f=fixture();
  const request={operation:'tab.fill',expectedOrigin:'https://example.com',
    expectedPath:'/wrong-application',index:0,expectedName:'Applicant name',value:'Never typed'};
  await assert.rejects(()=>performBrowserAction(f.wc,request),/PAGE_CHANGED_AFTER_APPROVAL/);
  assert.equal(f.inputs[0].node.value,'');
  await assert.rejects(()=>performBrowserAction(f.wc,{operation:'tab.describe',
    expectedOrigin:'https://example.com',expectedPath:'/apply?token=secret'}),/EXPECTED_PATH_INVALID/);
});
test('Gemini default HTML button type=submit outside form is correctly navigational',async()=>{
  const f=fixture();let clicks=0;
  f.buttons.push({node:{tagName:'BUTTON',type:'submit',form:null,innerText:'Main menu',
    value:'',title:'',disabled:false,
    getAttribute:key=>key==='type'?null:null,
    getBoundingClientRect:()=>({width:130,height:28}),closest:()=>null,click:()=>{clicks++;}}});
  const described=await performBrowserAction(f.wc,{operation:'tab.describe',expectedOrigin:'https://example.com'});
  const target=described.buttons.find(b=>b.text==='Main menu');
  assert.equal(target.submit,false);
  const result=await performBrowserAction(f.wc,{operation:'tab.click',expectedOrigin:'https://example.com',
    index:target.index,expectedText:'Main menu'});
  assert.equal(result.triggered,true);
  assert.equal(result.submitted,false);
  assert.equal(clicks,1);
});
test('submit needs correct label and is marked triggered, never falsely accepted',async()=>{
  const f=fixture();
  await assert.rejects(()=>performBrowserAction(f.wc,{operation:'tab.click',expectedOrigin:'https://example.com',
    index:0,expectedText:'Apply now'}),/EXPLICIT_SUBMIT_ACTION/);
  await assert.rejects(()=>performBrowserAction(f.wc,{operation:'tab.submit',expectedOrigin:'https://example.com',
    index:0,expectedText:'Changed'}),/BUTTON_CHANGED/);
  const result=await performBrowserAction(f.wc,{operation:'tab.submit',expectedOrigin:'https://example.com',
    index:0,expectedText:'Apply now'});
  assert.equal(result.submitted,true);
  assert.equal(result.verifiedSubmission,false);
  assert.equal(result.method,'NATIVE_POINTER_SINGLE_ATTEMPT');
  assert.deepEqual(f.inputEvents.map(e=>e.type),['mouseMove','mouseDown','mouseUp']);
  assert.equal(f.getSubmits(),1);
  f.setUrl('https://evil.example/apply');
  await assert.rejects(()=>performBrowserAction(f.wc,{operation:'tab.describe',expectedOrigin:'https://example.com'}),/TAB_ORIGIN_CHANGED/);
});
