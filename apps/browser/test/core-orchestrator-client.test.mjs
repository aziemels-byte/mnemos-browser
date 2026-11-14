import test from 'node:test';
import assert from 'node:assert/strict';
import {CoreClient} from '../src/core-client.mjs';
test('Orchestrator submit is a single explicit loopback POST and returns bounded unverified evidence',async()=>{
 const calls=[];
 const client=new CoreClient({base:'http://127.0.0.1:4320',fetchImpl:async(url,options)=>{
   calls.push({url,method:options.method,redirect:options.redirect,
      contentType:options.headers['content-type'],body:JSON.parse(options.body)});
   return new Response(JSON.stringify({conversationId:'conv-x',
     turn:{assistantResponse:'Pārbaudīta testa atbilde'},
     run:{runId:'run-1'},proof:{sha256:'a'.repeat(64)}}),
     {status:200,headers:{'content-type':'application/json'}});
 }});
 const reply=await client.submitOrchestrator({message:'  Core darbība  ',conversationId:'conv-1'});
 assert.deepEqual(calls,[{url:'http://127.0.0.1:4320/api/chat',method:'POST',
   redirect:'error',contentType:'application/json',
   body:{message:'Core darbība',conversationId:'conv-1'}}]);
 assert.equal(reply.source,'MNEMOS_CORE_ORCHESTRATOR');
 assert.equal(reply.verified,false);
 assert.equal(reply.reply,'Pārbaudīta testa atbilde');
 assert.equal(reply.runId,'run-1');assert.equal(reply.proofHash.length,64);
});
test('Orchestrator never sends an empty, oversized or malformed conversation payload',async()=>{
 let called=0;
 const client=new CoreClient({fetchImpl:async()=>{called++;throw Error('SHOULD_NOT_SEND')}});
 for(const input of [
  {message:''},{message:' '},{message:'x'.repeat(16001)},
  {message:'Zināms',conversationId:'bad/../../id'},
  {message:'Zināms',conversationId:{}}
 ])await assert.rejects(()=>client.submitOrchestrator(input),/CORE_CHAT_INVALID_/);
 assert.equal(called,0);
});
test('Orchestrator rejects malformed and non-2xx replies instead of falsely reporting completion',async()=>{
 const invalid=new CoreClient({fetchImpl:async()=>new Response('not json',{status:200})});
 await assert.rejects(()=>invalid.submitOrchestrator({message:'Darbs'}),/INVALID_RESPONSE/);
 const rejected=new CoreClient({fetchImpl:async()=>new Response(JSON.stringify({error:'blocked'}),{status:409})});
 await assert.rejects(()=>rejected.submitOrchestrator({message:'Darbs'}),/CORE_CHAT_HTTP_409/);
});
test('no arbitrary Core route and no non-loopback Core origin',async()=>{
 assert.throws(()=>new CoreClient({base:'https://www.example.com/'}),/CORE_LOOPBACK_ONLY/);
 const core=new CoreClient({fetchImpl:async()=>{throw Error('unexpected fetch')}});
 await assert.rejects(()=>core.read('/api/secret'),/CORE_ROUTE_DENIED/);
});
