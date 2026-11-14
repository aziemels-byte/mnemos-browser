import {spawn,execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {WindowsDpapiSecretStore} from '../../../../packages/core/src/providers/credential-store.mjs';
import {connectorPaths,requireConnectorOrigin} from '../../src/connector-config.mjs';
const paths=connectorPaths();
const nodeExe=process.execPath;
const exe=process.env.MNEMOS_TAILSCALE_EXE||'tailscale';
const serverFile=fileURLToPath(new URL('./server.mjs',import.meta.url));
const origin=requireConnectorOrigin();
const publicPort=new URL(origin).port||'443';
const store=new WindowsDpapiSecretStore({root:paths.security});
const key=(await store.resolve('vault:dpapi.perplexity-remote-key')).trim();
const config=JSON.parse(await readFile(paths.credential,'utf8'));
if(createHash('sha256').update(key).digest('hex')!==config.sha256)throw new Error('KEY_MISMATCH');
const local='http://127.0.0.1:8876/mcp';
const pub=origin+'/mcp';
const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'mnemos-activation',version:'1'}}});
const probe=async url=>{try{
  const r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+key,accept:'application/json, text/event-stream','content-type':'application/json'},body,signal:AbortSignal.timeout(6000),redirect:'error'});
  const text=await r.text();
  return {status:r.status,valid:r.ok&&text.includes('mnemos-perplexity-readonly')};
}catch(e){return {status:null,valid:false,error:String(e.cause?.code??e.message).slice(0,90)};}};
const result={serverStarted:false,tunnelUpdated:false,local:null,public:null,publicListeners:null,existingListenersPreserved:null};
let localState=await probe(local);
if(!localState.valid) {
  const child=spawn(nodeExe,[serverFile],{detached:true,windowsHide:true,stdio:'ignore'});
  child.unref();
  for(let i=0;i<28;i++){await new Promise(r=>setTimeout(r,350));localState=await probe(local);if(localState.valid)break;}
  result.serverStarted=localState.valid;
}
result.local=localState;
if(!localState.valid){console.log('ACTIVATION',JSON.stringify(result));throw new Error('LOCAL_SERVER_FAILED');}
const status=()=>JSON.parse(execFileSync(exe,['funnel','status','--json'],{encoding:'utf8',timeout:9000,windowsHide:true,maxBuffer:150000}));
const before=status(),beforeWeb=before.Web??{},beforeTCP=before.TCP??{};
const isPublicPort=value=>value===publicPort||value.endsWith(':'+publicPort);
if(Object.keys(beforeTCP).some(isPublicPort)||Object.keys(beforeWeb).some(isPublicPort))
  throw new Error('PUBLIC_PORT_ALREADY_USED');
execFileSync(exe,['funnel','--bg','--https='+publicPort,'--yes','8876'],{encoding:'utf8',timeout:25000,windowsHide:true,maxBuffer:50000});
result.tunnelUpdated=true;
const after=status();
result.publicListeners=Object.entries(after.Web??{}).filter(([host])=>isPublicPort(host)).map(([host,c])=>({host,proxy:Object.values(c.Handlers??{})[0]?.Proxy??null}));
result.existingListenersPreserved=Object.entries(beforeWeb).every(([host,c])=>JSON.stringify(after.Web?.[host]??null)===JSON.stringify(c));
if(!result.existingListenersPreserved)throw new Error('EXISTING_FUNNEL_ROUTING_CHANGED');
result.public=await probe(pub);
console.log('ACTIVATION',JSON.stringify(result));
if(!result.public.valid)process.exitCode=1;
