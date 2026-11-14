import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {WindowsDpapiSecretStore} from '../../../../packages/core/src/providers/credential-store.mjs';
import {connectorPaths,connectorOrigin} from '../../src/connector-config.mjs';
const paths=connectorPaths(),exe='schtasks.exe';
const node=process.execPath;
const file=fileURLToPath(new URL('./server.mjs',import.meta.url));
const origin=connectorOrigin();
const store=new WindowsDpapiSecretStore({root:paths.security});
const key=(await store.resolve('vault:dpapi.perplexity-remote-key')).trim();
const config=JSON.parse(await readFile(paths.credential,'utf8'));
if(createHash('sha256').update(key).digest('hex')!==config.sha256)throw new Error('INVALID_API_KEY');
const task='MNEMOS Perplexity MCP';
const query=()=>execFileSync(exe,['/Query','/TN',task,'/XML'],{encoding:'utf8',timeout:15000,windowsHide:true});
let existing;
try{existing=query();}catch(e){if(e.status!==1)throw e;}
if(existing&&(!existing.includes('perplexity')||!existing.includes('server.mjs')))throw new Error('UNEXPECTED_EXISTING_TASK_NOT_OVERWRITTEN');
if(!existing){
  const args=[node,file,'--connector-root',paths.root];
  if(origin)args.push('--public-origin',origin);
  const run=args.map(arg=>'"'+arg+'"').join(' ');
  execFileSync(exe,['/Create','/TN',task,'/SC','ONLOGON','/TR',run,'/F','/RL','LIMITED'],{encoding:'utf8',timeout:17000,windowsHide:true});
}
const x=query();
if(!x.includes('server.mjs')||!x.includes('perplexity'))throw new Error('TASK_CONFIGURATION_NOT_VERIFIED');
execFileSync(exe,['/Run','/TN',task],{encoding:'utf8',timeout:15000,windowsHide:true});
let local=null;
for(let i=0;i<28;i++){
  try{
    const r=await fetch('http://127.0.0.1:8876/mcp',{method:'POST',headers:{
      'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+key
    },body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'task-check',version:'1'}}}),signal:AbortSignal.timeout(2500)});
    const content=await r.text();
    if(r.ok&&content.includes('mnemos-perplexity-readonly')){local={status:r.status,ready:true};break;}
    local={status:r.status,ready:false};
  }catch(e){local={status:null,ready:false,error:String(e.message).slice(0,100)};}
  await new Promise(r=>setTimeout(r,500));
}
console.log('SCHEDULED_MCP',JSON.stringify({task,created:!existing,taskVerified:true,local}));
if(!local.ready)throw new Error('SCHEDULED_SERVER_NOT_READY');
