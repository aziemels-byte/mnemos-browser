import test from 'node:test';
import assert from 'node:assert/strict';
import {collaborationModel,collaborationTargets,collaborationPlan,
  coordinationDraft,collaborationComposer,collaborationComposerWithState,
  collaborationSendButton,delegatedModelPromptAllowed,recoverCollaborationSample} from '../src/model-coordination.mjs';
const tabs=[
 {id:'a',url:'https://chatgpt.com/c/a',project:'p',private:false,loading:false,title:'ChatGPT'},
 {id:'b',url:'https://gemini.google.com/app/123',project:'p',private:false,loading:false,title:'Gemini'},
 {id:'c',url:'https://www.perplexity.ai/search/123',project:'p',private:false,loading:false,title:'Perplexity'},
 {id:'private',url:'https://chatgpt.com/c/private',project:'p',private:true,loading:false},
 {id:'other-project',url:'https://gemini.google.com/app/a',project:'other',private:false,loading:false},
 {id:'loading',url:'https://www.perplexity.ai/',project:'p',private:false,loading:true},
 {id:'fake',url:'https://gemini.google.com.attacker.org/app',project:'p',private:false,loading:false}
];
test('Only exact supported HTTPS origins and non-private project tabs are eligible',()=>{
 assert.equal(collaborationModel('https://chatgpt.com/c/a'), 'ChatGPT');
 for(const bad of ['https://chatgpt.com.evil.test/', 'http://chatgpt.com',
   'https://user:password@chatgpt.com', 'https://gemini.google.com.attacker.org',
   'file:///etc/passwd','https://example.com',
   'https://gemini.google.com/customize/connectors',
   'https://www.perplexity.ai/computer/plugins',
   'https://chatgpt.com/settings/plugins-settings/plugin_id'])assert.equal(collaborationModel(bad),null,bad);
 assert.deepEqual(collaborationTargets(tabs,'p').map(x=>x.id),['a','b','c']);
 assert.throws(()=>collaborationTargets(tabs,null),/INVALID_COLLABORATION_PROJECT/);
});
test('Coordination plan requires unique explicitly selected model tabs, same project and bounded memory',()=>{
 const plan=collaborationPlan({tabIds:['a','b','c'],activeProject:'p',tabs});
 assert.deepEqual(plan.targets.map(x=>x.model),['ChatGPT','Gemini','Perplexity']);
 for(const ids of [[],['a','a'],['a','b','c','a'],['private'],['other-project'],['fake']])
   assert.throws(()=>collaborationPlan({tabIds:ids,activeProject:'p',tabs}));
 assert.throws(()=>collaborationPlan({tabIds:['a'],activeProject:'p',tabs,
   memoryIds:['wrong'],memories:[]}),/CONTEXT_MISSING/);
 const extra=[...tabs,{...tabs[0],id:'d',url:'https://chatgpt.com/c/d'}];
 assert.throws(()=>collaborationPlan({tabIds:['a','d'],activeProject:'p',tabs:extra}),/DUPLICATE_MODEL/);
});
test('Shared prompt is verbatim without memory by default; opt-in memories are clearly scoped',()=>{
 const message='Compare architecture alternatives';
 assert.equal(coordinationDraft({prompt:message}),message);
 const shared=coordinationDraft({prompt:message,memories:[
   {text:'Some untrusted web finding',source:'perplexity:untrusted:xyz'}
 ]});
 assert.ok(shared.includes('Lietotāja uzdevums:'));
 assert.ok(shared.includes('Some untrusted web finding'));
 assert.ok(shared.includes('NEUZTICAMS'));
 assert.ok(shared.includes('\n'), 'should contain actual line breaks');
 assert.ok(!shared.includes('\\n'), 'must not contain literal backslash-n');
 assert.throws(()=>coordinationDraft({prompt:''}),/PROMPT_INVALID/);
 assert.throws(()=>coordinationDraft({prompt:'a'.repeat(1601)}),/PROMPT_INVALID/);
 assert.throws(()=>coordinationDraft({prompt:'x',memories:[
   {text:'a'.repeat(551),source:'browser'}]}),/OVERSIZED/);
 assert.throws(()=>coordinationDraft({prompt:'a',memories:Array.from({length:3},()=>({text:'x',source:'browser'}))}),/CONTEXT_LIMIT/);
});
test('Only exact send controls are eligible and filled composer must match a known model',()=>{
  const c={fields:[{index:4,type:'contenteditable',name:'Jautā ChatGPT',
    filled:true,blocked:false}]};
  assert.deepEqual(collaborationComposerWithState(c,'ChatGPT',true),
    {index:4,expectedName:'Jautā ChatGPT'});
  assert.throws(()=>collaborationComposerWithState(c,'ChatGPT',false),/COMPOSER_MISSING/);
  assert.deepEqual(collaborationSendButton({buttons:[
    {index:0,text:'Delete',submit:true},
    {index:2,text:'Open menu',submit:false},
    {index:8,text:'Send message',submit:true}
  ]},'ChatGPT'),{index:8,expectedText:'Send message'});
  // Actual live Perplexity (Latvian UI): send control is index 67, 'Iesniegt'.
  assert.deepEqual(collaborationSendButton({buttons:[
    {index:61,text:'Pievienot failus, spraudņus un citu',submit:false},
    {index:63,text:'Computer',submit:false},
    {index:67,text:'Iesniegt',submit:true}
  ]},'Perplexity'),{index:67,expectedText:'Iesniegt'});
  assert.deepEqual(collaborationSendButton({buttons:[
    {index:21,text:'Nosūtīt ziņojumu',submit:true}
  ]},'ChatGPT'),{index:21,expectedText:'Nosūtīt ziņojumu'});
  assert.throws(()=>collaborationSendButton({buttons:[
    {index:0,text:'Save',submit:true}]},'Perplexity'),/SEND_BUTTON_MISSING/);
  assert.throws(()=>collaborationSendButton({buttons:[
    {index:0,text:'Send',submit:true},{index:1,text:'Send message',submit:true}
  ]},'Gemini'),/SEND_BUTTON_MISSING_OR_AMBIGUOUS/);
  assert.throws(()=>collaborationSendButton({buttons:[
    {index:0,text:'Send message',submit:false}
  ]},'ChatGPT'),/SEND_BUTTON_MISSING/);
});
test('delegated AI model prompts require an exact trusted chat URL, filled composer and unique send control',()=>{
  const chatTab={id:'tab-1',url:'https://gemini.google.com/app/0000000000000001',
    project:'mnemos',private:false,loading:false};
  const description={fields:[
    {index:0,type:'contenteditable',name:'Enter a prompt for Gemini',filled:true,blocked:false}
  ],buttons:[
    {index:26,text:'Send message',submit:true},{index:3,text:'Delete',submit:true}
  ]};
  const request={tab:chatTab,index:26,label:'Send message',description};
  assert.equal(delegatedModelPromptAllowed(request),true);
  assert.equal(delegatedModelPromptAllowed({...request,index:3,label:'Delete'}),false);
  assert.equal(delegatedModelPromptAllowed({...request,index:26,label:'Save'}),false);
  assert.equal(delegatedModelPromptAllowed({...request,tab:{...chatTab,private:true}}),false);
  assert.equal(delegatedModelPromptAllowed({...request,tab:{...chatTab,loading:true}}),false);
  assert.equal(delegatedModelPromptAllowed({...request,tab:{...chatTab,project:null}}),false);
  assert.equal(delegatedModelPromptAllowed({...request,tab:{...chatTab,
    url:'https://gemini.google.com/customize/connectors'}}),false);
  assert.equal(delegatedModelPromptAllowed({...request,tab:{...chatTab,
    url:'https://gemini.google.com.evil.example/app'}}),false);
  assert.equal(delegatedModelPromptAllowed({...request,tab:{...chatTab,
    url:'https://jobs.example.com/apply'}}),false);
  assert.equal(delegatedModelPromptAllowed({...request,description:{...description,
    fields:description.fields.map(f=>({...f,filled:false}))}}),false);
  assert.equal(delegatedModelPromptAllowed({...request,description:{...description,
    fields:description.fields.map(f=>({...f,blocked:true}))}}),false);
  assert.equal(delegatedModelPromptAllowed({...request,description:{...description,
    buttons:[...description.buttons,{index:27,text:'Send message',submit:true}]}}),false);
  const perplexity={tab:{...chatTab,url:'https://www.perplexity.ai/session/aaaaaaaa-aaaa-4aaa-aaaa-000000000002'},
    index:67,label:'Iesniegt',description:{
      fields:[{index:0,type:'contenteditable',name:'Uzdodiet papildjautājumu',filled:true,blocked:false}],
      buttons:[{index:67,text:'Iesniegt',submit:true}]}};
  assert.equal(delegatedModelPromptAllowed(perplexity),true);
  for(const name of ['Jautājiet jebko…','Ierakstiet @, lai piekļūtu savienotājiem','Ierakstiet /, lai izvēlētos meklēšanas režīmus']) {
    const home={...perplexity,tab:{...perplexity.tab,url:'https://www.perplexity.ai/'},description:{...perplexity.description,fields:[{...perplexity.description.fields[0],name}]}};
    assert.equal(delegatedModelPromptAllowed(home),true,name);
  }
  const chatgpt={tab:{...chatTab,url:'https://chatgpt.com/c/synthetic-conversation-0001'},
    index:12,label:'Send message',description:{
      fields:[{index:4,type:'contenteditable',name:'Jautā ChatGPT',filled:true,blocked:false}],
      buttons:[{index:12,text:'Send message',submit:true}]}};
  assert.equal(delegatedModelPromptAllowed(chatgpt),true);
});
test('Exact approved-looking composers must be empty, unique, non-sensitive and of text-editable type',()=>{
 for(const [model,name] of [
   ['ChatGPT','Jautā ChatGPT'],['Gemini','Enter a prompt for Gemini'],
   ['Perplexity','Uzdodiet papildjautājumu']]){
   assert.deepEqual(collaborationComposer({fields:[
     {index:0,type:'file',name:'INPUT',filled:false,blocked:false},
     {index:4,type:'contenteditable',name,filled:false,blocked:false}]},model),
     {index:4,expectedName:name});
   for(const prop of [{filled:true},{blocked:true},{type:'password'}]){
     const f={index:4,type:'contenteditable',name,filled:false,blocked:false,...prop};
     assert.throws(()=>collaborationComposer({fields:[f]},model),/COMPOSER_MISSING_OR_AMBIGUOUS/);
   }
   assert.throws(()=>collaborationComposer({fields:[
     {index:4,type:'contenteditable',name,filled:false,blocked:false},
     {index:9,type:'contenteditable',name,filled:false,blocked:false}]},model),/COMPOSER_MISSING_OR_AMBIGUOUS/);
 }
});

test('read-only recovery requires exactly one prompt match among eligible restored tabs',async()=>{
 const target={model:'ChatGPT',origin:'https://chatgpt.com'};
 const restored=[...tabs,{...tabs[0],id:'restored',url:'https://chatgpt.com/c/restored'},
   {...tabs[0],id:'elsewhere',project:'other'}];
 const sampled=[];
 const match={data:{promptFound:true}};
 const options={target,project:'p',tabs:restored};
 assert.equal(await recoverCollaborationSample({...options,read:async id=>{
   sampled.push(id);
   return id==='restored'?match:{data:{promptFound:false}};
 }}),match);
 assert.deepEqual(sampled,['a','restored']);
 await assert.rejects(recoverCollaborationSample({...options,read:async()=>match}),/PROMPT_AMBIGUOUS/);
 await assert.rejects(recoverCollaborationSample({...options,read:async()=>{throw Error('closed');}}),/PROMPT_NOT_FOUND/);
});
