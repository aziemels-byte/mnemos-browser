import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WindowsDpapiSecretStore} from '../../../../packages/core/src/providers/credential-store.mjs';
import {connectorPaths,requireConnectorOrigin} from '../../src/connector-config.mjs';
const paths=connectorPaths();
const url=requireConnectorOrigin()+'/mcp';
const store=new WindowsDpapiSecretStore({root:paths.security});
const key=(await store.resolve('vault:dpapi.perplexity-remote-key')).trim();
const conf=JSON.parse(await readFile(paths.credential,'utf8'));
assert.equal(createHash('sha256').update(key).digest('hex'),conf.sha256);
async function call(id,method,params={}){
 const r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+key,accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(7500),redirect:'error'});
 assert.equal(r.status,200,method+' did not respond with HTTP 200');
 const text=await r.text();
 const line=text.split(/\r?\n/).find(x=>x.startsWith('data:'));
 return JSON.parse(line?line.slice(5):text);
}
const anonymous=await fetch(url,{method:'GET',signal:AbortSignal.timeout(7500),redirect:'error'});
assert.equal(anonymous.status,401);
const init=await call(1,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'remote-verification',version:'1'}});
assert.equal(init.result?.serverInfo?.name,'mnemos-perplexity-readonly');
const tools=await call(2,'tools/list');
const names=tools.result?.tools?.map(x=>x.name).sort();
assert.deepEqual(names,['mnemos_agents_summary','mnemos_browser_attach','mnemos_browser_choose','mnemos_browser_click','mnemos_browser_fill','mnemos_browser_open','mnemos_browser_read','mnemos_browser_result','mnemos_browser_select','mnemos_browser_submit','mnemos_browser_tabs','mnemos_browser_toggle','mnemos_goals','mnemos_proposal_status','mnemos_propose_task','mnemos_request_consultation','mnemos_status','mnemos_submit_result','mnemos_tasks']);
assert.equal(tools.result.tools.filter(t=>t.annotations.readOnlyHint).length,8);
assert.equal(tools.result.tools.filter(t=>!t.annotations.readOnlyHint).length,11);
const r=await call(3,'tools/call',{name:'mnemos_status',arguments:{}});
assert.equal(r.result?.structuredContent?.online,true);
for(const tool of ['mnemos_goals','mnemos_tasks','mnemos_agents_summary']){
 const response=await call(10+names.indexOf(tool),'tools/call',{name:tool,arguments:{limit:2}});
 if(response.result?.isError===true)throw new Error('REMOTE_TOOL_FAILED:'+tool);
 assert.ok(response.result?.structuredContent?.capturedAt,tool+' missing capturedAt');
}
console.log('REMOTE_PUBLIC_MCP',JSON.stringify({https:true,anonymousDenied:anonymous.status===401,toolCount:names.length,readOnlyTools:8,approvalGatedQueueTools:11,coreOnline:r.result?.structuredContent?.online,coreVersion:r.result?.structuredContent?.version}));
