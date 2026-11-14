import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeServer} from './server.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const token='local_test_token_0123456789_ABCdef123456789';
const sha256=createHash('sha256').update(token).digest('hex');
const initialize={jsonrpc:'2.0',id:1,method:'initialize',
  params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'mnemos-connector-test',version:'1.0'}}};
async function call(port,body,auth=true){
  return fetch('http://127.0.0.1:'+port+'/mcp',{method:'POST',
    headers:{accept:'application/json, text/event-stream','content-type':'application/json',
      ...(auth?{authorization:'Bearer '+token}:{})},
    body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
}
async function responseObject(res){
  const content=await res.text();
  if(content.startsWith('event:')||content.startsWith('data:')) {
    const line=content.split(/\r?\n/).find(x=>x.startsWith('data:'));
    return JSON.parse(line?.slice(5).trim()||'{}');
  }
  return JSON.parse(content);
}

test('external MCP can queue a task/consultation and submit results ONLY after local approval',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'perplexity-mcp-'));
  const dbPath=path.join(root,'collaboration.sqlite');
  const app=await makeServer({credentialHash:sha256,port:0,dbPath});
  await app.listen();
  const port=app.server.address().port;
  async function invoke(id,name,args){
    const response=await call(port,{jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
    assert.equal(response.status,200,name);
    return (await responseObject(response)).result;
  }
  try{
    const key='perplexity-queue-test-00001';
    const params={requestId:key,title:'Izveidot apstiprināmu lokālu uzdevumu',
      details:'Šis ārējais pieprasījums nedrīkst pats izveidot Core uzdevumu vai izpildīt kodu.'};
    const a=await invoke(7,'mnemos_propose_task',params);
    assert.equal(a.structuredContent?.status,'PENDING_APPROVAL');
    assert.equal(a.structuredContent?.executed,false);
    const id=a.structuredContent.proposalId;
    const replay=await invoke(8,'mnemos_propose_task',params);
    assert.equal(replay.structuredContent?.replayed,true);
    const denied=await invoke(9,'mnemos_submit_result',{proposalId:id,requestId:'perplexity-result-test-00001',
      summary:'Vēl neapstiprināts',details:'Pirms apstiprināšanas rezultātu nevar iesniegt.'});
    assert.equal(denied.isError,true);
    assert.match(denied.content?.[0]?.text,/NOT_APPROVED/);
    const status=await invoke(10,'mnemos_proposal_status',{proposalId:id});
    assert.equal(status.structuredContent?.status,'PENDING_APPROVAL');
    const failed=await invoke(11,'mnemos_request_consultation',{
      requestId:'perplexity-consult-00001',target:'chatgpt',
      title:'Jautājums ChatGPT',details:'Kā noteikt satura kvalitāti bez automātiskas izpildes?'});
    assert.equal(failed.structuredContent?.status,'PENDING_APPROVAL');
    assert.equal(failed.structuredContent?.forwarded,false);
    const {CollaborationStore}=await import('./collaboration-store.mjs');
    const local=new CollaborationStore(dbPath);
    const listed=local.pending();
    assert.equal(listed.length,2);
    assert.ok(listed.some(p=>p.id===id));
    local.beginApproval(id);
    local.finishApproval(id,{localItemId:'local-browser-fixture-1'});
    local.close();
    const result=await invoke(12,'mnemos_submit_result',{
      proposalId:id,requestId:'perplexity-result-test-00001',
      summary:'Pabeigts, bet nav uzticams',details:'Detalizēta ārēja atbilde, kam vajadzīga cilvēka pārskatīšana.'});
    assert.equal(result.structuredContent?.status,'AWAITING_REVIEW');
    assert.equal(result.structuredContent?.committedToMemory,false);
    const persisted=new CollaborationStore(dbPath);
    assert.equal(persisted.pendingResults()[0]?.id,result.structuredContent?.resultId);
    persisted.close();
  }finally{
    await new Promise(resolve=>app.server.close(resolve));
    rmSync(root,{recursive:true,force:true});
  }
});

test('MCP denies anonymous, invalid key, unknown paths and supports Streamable HTTP',async()=>{
  const fetchCore=async url=>{
    assert.equal(url,'http://127.0.0.1:4320/api/health');
    return Response.json({version:'connector-test'});
  };
  const app=await makeServer({credentialHash:sha256,port:0,fetchCore});
  await app.listen();
  const port=app.server.address().port;
  try {
    assert.equal((await call(port,initialize,false)).status,401);
    const wrong=await fetch('http://127.0.0.1:'+port+'/mcp',{method:'POST',headers:{
      accept:'application/json, text/event-stream','content-type':'application/json',authorization:'Bearer wrong_wrong_wrong_wrong_wrong_wrong_wrong_wrong'},body:JSON.stringify(initialize)});
    assert.equal(wrong.status,401);
    const unexpected=await fetch('http://127.0.0.1:'+port+'/other',{headers:{authorization:'Bearer '+token}});
    assert.equal(unexpected.status,404);
    const init=await call(port,initialize);
    assert.equal(init.status,200);
    const value=await responseObject(init);
    assert.equal(value.result?.serverInfo?.name,'mnemos-perplexity-readonly');
    const list=await call(port,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
    assert.equal(list.status,200);
    const listing=await responseObject(list);
    const names=listing.result.tools.map(x=>x.name).sort();
    assert.deepEqual(names,['mnemos_agents_summary','mnemos_browser_attach','mnemos_browser_choose','mnemos_browser_click','mnemos_browser_fill','mnemos_browser_open','mnemos_browser_read','mnemos_browser_result','mnemos_browser_select','mnemos_browser_submit','mnemos_browser_tabs','mnemos_browser_toggle','mnemos_goals','mnemos_proposal_status','mnemos_propose_task','mnemos_request_consultation','mnemos_status','mnemos_submit_result','mnemos_tasks']);
    assert.equal(listing.result.tools.filter(x=>x.annotations.readOnlyHint===true).length,8);
    assert.equal(listing.result.tools.filter(x=>x.annotations.readOnlyHint===false).length,11);
    const output=await call(port,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'mnemos_status',arguments:{}}});
    assert.equal(output.status,200);
    const body=await responseObject(output);
    assert.equal(body.result.structuredContent?.service,'MNEMOS');
    assert.equal(body.result.structuredContent?.online,true);
    // If unsupported write tool slips through, fail closed.
    const denied=await call(port,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'mnemos_operator',arguments:{action:'run_check'}}});
    const noTool=await responseObject(denied);
    assert.ok(noTool.error||noTool.result?.isError);
  }finally{await new Promise(resolve=>app.server.close(resolve));}
});
