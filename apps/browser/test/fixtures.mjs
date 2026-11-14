import http from 'node:http';
import {randomUUID} from 'node:crypto';
export async function fixtures(){
  const observed={core:[],modelCalls:0,modelRequests:[],coreChatCalls:0,coreChatRequests:[]},control={coreOffline:false,slow:false,graphChanged:false};
  const serve=handler=>new Promise(resolve=>{const s=http.createServer(handler);s.listen(0,'127.0.0.1',()=>resolve({server:s,origin:`http://127.0.0.1:${s.address().port}`}));});
  const core=await serve(async(req,res)=>{
    observed.core.push({method:req.method,url:req.url});res.setHeader('content-type','application/json');
    if(control.coreOffline){res.writeHead(503);res.end('{}');return;}
    if(req.url==='/api/chat'&&req.method==='POST'){
      let input='';for await(const b of req)input+=b;
      const body=JSON.parse(input);observed.coreChatCalls++;observed.coreChatRequests.push(body);
      res.end(JSON.stringify({conversationId:'fixture-conversation-1',
        turn:{assistantResponse:'Core Orchestrator testa atbilde. Uzdevums saņemts.'},
        run:{runId:'fixture-run-1'},proof:{sha256:'a'.repeat(64)}}));
      return;
    }
    if(req.url==='/api/cockpit/snapshot'&&req.method==='GET'){
      res.end(JSON.stringify({
        capturedAt:new Date().toISOString(),sequence:100,service:{status:'ready'},
        continuation:{goals:[
          {goalId:'fixture-goal',objective:'Pārbaudīt MNEMOS Core-first arhitektūru',
            status:'ACTIVE',nextAction:'Pārbaudīt Browser un Core darbību',updatedAt:new Date().toISOString()}
        ]},
        developmentTasks:[
          {taskId:'fixture-development-1',title:'Pieslēgt Core Orchestrator',
            status:'RUNNING',checkpoint:{currentPhase:'test',nextAction:'Palaist E2E'}}
        ],
        approvals:[{approvalId:'fixture-approval',action:'Pārskatīt testa atļauju',
          status:'PENDING',risk:'LOW'}],
        tests:[{testRunId:'fixture-test-1',taskId:'fixture-development-1',
          title:'Core-first paneļa integrācijas pārbaude',passed:true,
          createdAt:new Date().toISOString(),exitCode:0}],
        diffs:[{patchId:'fixture-patch-1',taskId:'fixture-development-1',
          title:'Pievienots Core-first adapteris',status:'REVIEW',
          targetPath:'apps/browser/src/core-client.mjs',createdAt:new Date().toISOString()}],
        taskGraph:{nodes:[
          {id:'fixture-node-1',label:'Core',state:'READY'},
          {id:'fixture-node-2',label:'Browser',state:control.graphChanged?'VERIFIED':'TEST'}],
          edges:[{from:'fixture-node-1',to:'fixture-node-2'}]},
        frontierSessions:{sessions:[{sessionId:'fixture-session-1',status:'ACTIVE',liveness:'RECENT'}],
          counts:{messages:0,pending:0}},
        resourceGuard:{level:'NORMAL',allowModelLoad:true},
        tasks:[{taskId:'fixture-task',title:'Kontrolēta Core testa ieraksts',status:'COMPLETED'}]
      }));return;
    }
    const body=req.url==='/api/health'?{version:'2.0.0-fixture',status:'READY'}:req.url==='/api/owner-goals'?{goals:[{goalId:'fixture-goal',objective:'Kontrolēta testa mērķis',status:'OPEN'}]}:{tasks:[{taskId:'fixture-task',title:'Kontrolēta Core testa ieraksts',status:'COMPLETED'}],frontierSessions:{sessions:[],counts:{messages:0,pending:0}},resourceGuard:{level:'NORMAL',allowModelLoad:true}};
    res.end(JSON.stringify(body));
  });
  const model=await serve(async(req,res)=>{
    if(req.url==='/api/tags'){res.setHeader('content-type','application/json');res.end(JSON.stringify({models:[{name:'test-local:1',size:1000},{name:'remote:cloud',remote_host:'https://ollama.com'}]}));return;}
    if(req.url!=='/api/chat'){res.writeHead(404);res.end();return;}
    observed.modelCalls++;let input='';for await(const b of req)input+=b;
    observed.modelRequests.push(JSON.parse(input));res.setHeader('content-type','application/x-ndjson');
    const response=['Pārbaudīta ','testa atbilde. ','Ā😀'];
    for(const chunk of response){if(res.destroyed)return;res.write(JSON.stringify({model:'test-local:1',message:{role:'assistant',content:chunk},done:false})+'\n');await new Promise(r=>setTimeout(r,control.slow?1500:35));}
    if(!res.destroyed)res.end(JSON.stringify({model:'test-local:1',done:true,done_reason:'stop'})+'\n');
  });
  const fixtureSession = randomUUID();
  const web=await serve((req,res)=>{
    if(req.url==='/fixture-auth/login'){
      res.setHeader('set-cookie',`fixture_session=${fixtureSession}; Path=/; Max-Age=3600; HttpOnly; SameSite=Strict`);
      res.setHeader('content-type','text/html; charset=utf-8');
      res.end('<!doctype html><title>Kontrolēta pieteikšanās</title><p>Testa konts ir pieteicies.</p>');
      return;
    }
    if(req.url==='/fixture-auth/session'){
      const authenticated=(req.headers.cookie??'').split(/;\s*/).includes(`fixture_session=${fixtureSession}`);
      res.writeHead(authenticated?204:401);res.end();return;
    }
    res.setHeader('content-type','text/html; charset=utf-8');if(req.url?.startsWith('/file-upload-fixture')){res.end(`<!doctype html><html><head><title>CV upload fixture</title></head><body><label for="cv">CV fails</label><input id="cv" aria-label="CV fails" type="file" accept=".txt,.pdf" style="display:none"><script>document.getElementById('cv').addEventListener('change',e=>{document.body.dataset.fileName=e.target.files[0]?.name||'';document.body.dataset.fileCount=String(e.target.files.length);});</script></body></html>`);return;}if(req.url?.startsWith('/handoff-fixture')){res.end(`<!doctype html><html><head><title>Perplexity draft fixture</title></head><body><h1>Pārbaudes uzvedne</h1><div id="composer" role="textbox" contenteditable="true" style="border:1px solid #aaa;padding:12px;min-height:64px;width:600px"></div><button id="submit" onclick="window.submitted=true">Sūtīt</button><script>window.submitted=false;</script></body></html>`);return;}res.end(`<!doctype html><title>MNEMOS pārlūka testa lapa</title><body style="background:#f4f1e9;color:#1c3124;font-family:Segoe UI;padding:54px"><p style="font-size:12px;letter-spacing:3px">KONTROLĒTA PĀRLŪKA PĀRBAUDE</p><h1>Chromium cilne</h1><p>Šo lapu renderē atsevišķs WebContentsView process.</p><a href="/second">Nākamā lapa</a><script>window.fixture=true;</script></body>`);});
  return {core,model,web,control,observed,close:async()=>{for(const item of [core,model,web]){item.server.closeAllConnections();await new Promise(r=>item.server.close(r));}}};
}
