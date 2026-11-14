/* MNEMOS Core-first interface, privileged shell only.
 * Real data: /api/cockpit/snapshot through main-process allowlisted IPC.
 * No remote WebContents view, no synthetic stats, no automatic model calls.
 */
(()=>{
'use strict';
const instances=new WeakMap();
const byId=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;
  if(text!==undefined)n.textContent=String(text);return n;};
const append=(parent,...children)=>{parent.append(...children);return parent;};
const truncate=(s,n=450)=>String(s??'').slice(0,n);
const formatDate=text=>{
  const date=new Date(text);
  return Number.isFinite(date.getTime())?date.toLocaleTimeString('lv-LV',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
};
const ages={FRESH:'SVAIGI',STALE:'NOVECO',OLD:'VECI DATI',UNAVAILABLE:'NAV DATU'};
function stateBadge(record){
 const raw=String(record?.classification||'UNKNOWN').toUpperCase();
 const labels={ACTIVE:'DARBOJAS',WAITING:'GAIDA',PAUSED:'APTURĒTS',TERMINAL:'PABEIGTS / BEIDZIES',UNKNOWN:'NEZINĀMS'};
 return el('span','work-state work-state-'+raw.toLowerCase(),labels[raw]??raw);
}
function countLine(name,value){
 const row=el('div','work-counter');
 row.append(el('span','',name),el('strong','',Number.isFinite(value)?value:'—'));
 return row;
}
class CoreWorkspace {
 constructor(host,invoke){
   this.host=host;this.invoke=invoke;this.dead=false;
   this.busy=false;this.inFlight=false;this.model=null;this.loadedHistory=false;
   this.previousGraphStates=null;
   this.render();
   this.refresh();
   this.loadHistory();
   this.clock=setInterval(()=>this.tick(),1200);
   this.poll=setInterval(()=>this.refresh(),6000);
   document.addEventListener('visibilitychange',this.visibility=()=>{
     if(document.visibilityState==='visible'&&!this.dead)this.refresh();
   });
 }
 destroy(){
   this.dead=true;
   clearInterval(this.clock);clearInterval(this.poll);
   document.removeEventListener('visibilitychange',this.visibility);
   instances.delete(this.host);
 }
 render(){
   const shell=el('section','core-workspace');
   shell.setAttribute('aria-label','MNEMOS Orchestrator darba telpa');
   const title=el('header','core-workspace-head');
   const identity=append(el('div','core-ident'),
     el('span','core-eyebrow','MNEMOS / CORE'),
     el('h1','', 'Vienots darba process'),
     el('p','','Saruna, uzdevumu stāvoklis un izpildes pierādījumi vienuviet.'));
   this.refreshButton=el('button','core-action','Atjaunot');
   this.refreshButton.type='button';this.refreshButton.addEventListener('click',()=>this.refresh());
   this.status=el('span','core-live-state','PĀRBAUDA CORE');
   this.status.setAttribute('role','status');
   const controls=append(el('div','core-head-controls'),this.status,this.refreshButton);
   title.append(identity,controls);
   this.metadata=el('div','core-source-line','Avots: MNEMOS Core · /api/cockpit/snapshot');
   const body=el('div','core-workspace-body');
   const chat=el('div','core-chat-pane');
   const chatLabel=append(el('div','core-pane-label'),
      el('strong','','ORCHESTRATOR'),el('small','','PAMATA SARUNA / CORE'));
   this.history=el('div','core-chat-history');this.history.setAttribute('role','log');this.history.setAttribute('aria-label','MNEMOS sarunas atbildes');
   const prompt=append(el('div','core-first-instructions'),
      el('span','core-eyebrow','MĒRĶIS → IZPILDE → PIERĀDĪJUMI'),
      el('h2','','Ko nepieciešams izdarīt?'),
      el('p','','MNEMOS maršrutē pieprasījumu caur Core. Modeļu atbildes un pārbaudīti rezultāti tiek nošķirti.'));
   this.intro=prompt;
   this.activity=el('div','core-activity');
   this.history.append(prompt,this.activity);
   this.form=el('form','core-chat-form');
   this.input=el('textarea','core-chat-input');
   this.input.rows=3;this.input.maxLength=16000;
   this.input.placeholder='Apraksti rezultātu, nevis tikai nākamo klikšķi…';
   this.input.setAttribute('aria-label','Uzdevums MNEMOS Orchestrator');
   this.input.addEventListener('keydown',event=>{
     if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){
       event.preventDefault();this.form.requestSubmit();
     }
   });
   this.send=el('button','core-chat-submit','Nosūtīt →');this.send.type='submit';
   const footer=append(el('div','core-chat-footer'),
     el('span','','Ctrl+Enter · viena nosūtīšana · bez automātiskas atkārtošanas'),this.send);
   this.form.append(this.input,footer);
   this.form.addEventListener('submit',event=>{event.preventDefault();void this.submit();});
   this.feedback=el('div','core-feedback');this.feedback.setAttribute('role','status');
   chat.append(chatLabel,this.history,this.feedback,this.form);
   const rail=el('aside','core-work-rail');rail.setAttribute('aria-label','Core uzdevumu un pierādījumu konteksts');
   const railTitle=append(el('div','core-rail-title'),
      el('strong','','IZPILDES STĀVOKLIS'),
      el('small','','TIKAI CORE DATI'));
   this.railContents=el('div','core-rail-content');
   rail.append(railTitle,this.railContents);
   body.append(chat,rail);
   shell.append(title,this.metadata,body);
   this.host.replaceChildren(shell);
   this.showOffline('Gaida Core stāvokli.');
 }
 showOffline(reason){
   if(this.dead)return;
   this.railContents.replaceChildren(append(el('div','core-empty'),
     el('strong','','Nav apstiprinātu aktuālo datu'),el('p','',reason)));
 }
 setFeedback(value,bad=false){
   this.feedback.textContent=value;
   this.feedback.classList.toggle('bad',bad);
 }
 appendMessage(message){
   if(this.dead)return;
   const role=message.role==='user'?'user':'assistant';
   this.intro.hidden=true;this.activity.hidden=true;
   const row=el('article','core-dialog-message core-'+role);
   const header=append(el('div','core-message-meta'),
     el('span','',role==='user'?'TU':'MNEMOS / CORE'),
     el('span','',formatDate(message.at)));
   const body=el('div','core-message-text',truncate(message.text,65000));
   const source=[message.runId?'RUN '+truncate(message.runId,70):null,
     message.proofHash?'PROOF '+truncate(message.proofHash,16):null,
     role==='assistant'?'MODEĻA ATBILDE NAV AUTOMĀTISKI VERIFICĒTA':null,
     message.delivery==='UNCERTAIN_NO_RETRY'?'NOSŪTĪŠANAS IZNĀKUMS NAV APSTIPRINĀTS':null
   ].filter(Boolean).join(' · ');
   row.append(header,body);
   if(source)row.append(el('div','core-message-provenance',source));
   this.history.append(row);
   this.history.scrollTop=this.history.scrollHeight;
   return row;
 }
 async loadHistory(){
   try{
     const snapshot=await this.invoke('core.chat.history',{});
     if(this.dead)return;
     const rows=Array.isArray(snapshot?.messages)?snapshot.messages:[];
     for(const row of rows.slice(-35))this.appendMessage(row);
     this.loadedHistory=true;
   }catch(error){this.setFeedback('Lokālais sarunas žurnāls nav pieejams: '+truncate(error?.message,140),true);}
 }
 tick(){
   if(this.dead||!this.model)return;
   const freshness=this.model.freshness;
   const at=Date.parse(this.model.sourceCapturedAt||'');
   const age=Number.isFinite(at)?Math.max(0,Date.now()-at):Infinity;
   const state=!Number.isFinite(age)?'UNAVAILABLE':age>20000?'OLD':age>7000?'STALE':'FRESH';
   const online=this.model.connection==='CORE_READY'&&state==='FRESH';
   this.status.className='core-live-state'+(online?' online':' stale');
   this.status.textContent=online?'● CORE / TIEŠSAISTĒ':'● '+(ages[state]??'NEZINĀMS');
   this.metadata.textContent='CORE SNAPSHOT · '+(ages[state]??'—')+' · '+
     formatDate(this.model.sourceCapturedAt)+' · SECĪBA '+(this.model.sourceSequence??'—')+
     ' · GLOBĀLS CORE SKATS (NEVIS BROWSER PROJEKTS)';
 }
 async refresh(){
   if(this.dead||this.inFlight||document.visibilityState==='hidden')return;
   this.inFlight=true;this.refreshButton.disabled=true;
   try{
     const result=await this.invoke('core.workspace',{});
     if(this.dead)return;
     this.model=result;this.renderRail();this.renderActivity();this.tick();
   }catch(error){
     this.model=null;
     this.status.className='core-live-state stale';
     this.status.textContent='● CORE NAV PIEEJAMS';
     this.metadata.textContent='Core stāvokļa lasīšana neizdevās';
     this.showOffline(truncate(error?.message,250));
   }finally{this.inFlight=false;if(!this.dead)this.refreshButton.disabled=false;}
 }
 renderActivity(){
   const rows=[];
   for(const item of this.model?.evidence?.tests??[])rows.push({
     at:item.at,title:item.title||item.id,
     meta:'TEST '+item.result+' · '+truncate(item.taskId||item.id,58),
     type:'test',result:item.result
   });
   for(const item of this.model?.evidence?.diffs??[])rows.push({
     at:item.at,title:item.title||item.path||item.id,
     meta:'DIFF '+item.status+' · '+truncate(item.taskId||item.id,58),
     type:'diff',result:item.status
   });
   rows.sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
   const root=this.activity;root.replaceChildren();
   if(this.intro.hidden||!rows.length){
     root.hidden=true;return;
   }
   root.hidden=false;
   root.append(append(el('div','core-activity-head'),
     el('strong','','PĒDĒJIE CORE PIERĀDĪJUMU IERAKSTI'),
     el('small','','NEPIERĀDA DARBA PABEIGŠANU')));
   for(const row of rows.slice(0,5)){
     const line=el('div','core-activity-row');
     const label=el('span','core-activity-kind '+(row.result==='PASS'?'pass':''),
       row.type==='test'?'TEST':'DIFF');
     const copy=append(el('div','core-activity-copy'),
       el('strong','',truncate(row.title,160)),
       el('small','',row.meta+' · '+formatDate(row.at)));
     line.append(label,copy);root.append(line);
   }
 }
 railSection(label,meta){
   const section=el('section','core-rail-section');
   const header=append(el('div','core-rail-section-head'),
      el('h3','',label),el('span','',meta));
   section.append(header);
   this.railContents.append(section);
   return section;
 }
 renderRail(){
   const data=this.model;if(!data)return;
   this.railContents.replaceChildren();
   const counters=this.railSection('DARBI','AUTORITATĪVAIS STĀVOKLIS');
   append(counters,append(el('div','core-work-counters'),
     countLine('DARBĀ',data.counts.active),
     countLine('GAIDA',data.counts.waiting),
     countLine('APTURĒTI',data.counts.paused)));
   const relevant=data.work.filter(w=>['ACTIVE','WAITING','PAUSED'].includes(w.classification));
   const priorities=this.railSection('NĀKAMAIS SOLIS','TASK / GOAL');
   if(!relevant.length)priorities.append(el('p','core-muted','Core neziņo par aktīviem vai gaidošiem uzdevumiem.'));
   for(const item of relevant.slice(0,3)){
     const row=el('div','core-work-item');
     row.append(stateBadge(item),el('strong','',truncate(item.title,170)),
        el('p','',item.nextAction||'Nākamais solis nav norādīts.'));
     row.append(el('small','',''+item.kind.toUpperCase()+' · '+truncate(item.id,80)));
     priorities.append(row);
   }
   const approvals=this.railSection('APSTIPRINĀJUMI','ATĻAUJAS');
   if(!data.attention.length)approvals.append(el('p','core-muted','Nav gaidošu Core apstiprinājumu.'));
   for(const a of data.attention.slice(0,3)){
     const row=el('div','core-approval-item');
     row.append(el('strong','',truncate(a.action||a.id,150)),
       el('small','',truncate(a.id,100)+(a.status?' · '+truncate(a.status,30):'')));
     approvals.append(row);
   }
   const graph=this.railSection('SAISTES','NO CORE TASKGRAPH');
   if(!data.graph.edges.length)graph.append(el('p','core-muted','Šajā momentuzņēmumā nav apstiprinātu uzdevumu savienojumu.'));
   else{
     graph.append(this.graphDrawing(data.graph));
     const label=append(el('div','core-graph-summary'),
       el('strong','',String(data.graph.nodes.length)),
       el('span','','mezgli · '+data.graph.edges.length+' faktiskas saites'));
     graph.append(label);
     const byId=new Map(data.graph.nodes.map(n=>[n.id,n]));
     for(const edge of data.graph.edges.slice(0,5)){
       const from=byId.get(edge.from),to=byId.get(edge.to);
       graph.append(append(el('div','core-edge'),
         el('span','',truncate(from?.label||edge.from,95)),
         el('b','','→'),
         el('span','',truncate(to?.label||edge.to,95))));
     }
   }
   this.previousGraphStates=new Map(data.graph.nodes.map(node=>[node.id,node.status]));
   const sessions=this.railSection('FRONTIER BUS','SESĪJAS');
   sessions.append(el('p','core-muted',data.frontier.length+' Core ziņotas sesijas. Atvērta tīmekļa cilne nenozīmē aģenta tiešsaisti.'));
   const scope=this.railSection('ATMIŅA','PIEKĻUVES ROBEŽA');
   scope.append(el('p','core-muted','Core atmiņas API šeit vēl nav pieslēgts. Browser lokālie ieraksti nav Core ilgtermiņa atmiņa.'));
 }
 graphDrawing(graph){
   const ns='http://www.w3.org/2000/svg';
   const svg=document.createElementNS(ns,'svg');
   svg.setAttribute('viewBox','0 0 280 166');
   svg.setAttribute('class','core-graph-svg');
   svg.setAttribute('role','img');
   svg.setAttribute('aria-label','Shematisks uzdevumu grafiks; līnijas ir tikai Core atgrieztās saites.');
   const relevantIds=new Set(graph.edges.flatMap(edge=>[edge.from,edge.to]));
   const nodes=graph.nodes.filter(n=>relevantIds.has(n.id)).slice(0,15)
     .sort((a,b)=>a.id.localeCompare(b.id));
   const positions=new Map(nodes.map((node,index)=>{
     const n=Math.max(1,nodes.length),col=index%3,row=Math.floor(index/3);
     const rows=Math.max(1,Math.ceil(n/3)),width=90,height=120/rows;
     return [node.id,{x:48+col*width,y:24+row*height}];
   }));
   const line=(from,to)=>{
     const node=document.createElementNS(ns,'line');
     for(const [key,val] of Object.entries({x1:from.x,y1:from.y,x2:to.x,y2:to.y}))
       node.setAttribute(key,String(val));
     node.setAttribute('class','core-graph-edge');
     svg.append(node);
   };
   for(const edge of graph.edges){
     if(positions.has(edge.from)&&positions.has(edge.to))
       line(positions.get(edge.from),positions.get(edge.to));
   }
   for(const node of nodes){
     const point=positions.get(node.id);
     const group=document.createElementNS(ns,'g');
     const old=this.previousGraphStates?.get(node.id);
     const changed=old!==undefined&&old!==node.status;
     if(changed)group.setAttribute('class','core-node-transition');
     for(const [r,kind] of [[changed?12:0,'halo'],[5,'dot']]){
       if(!r)continue;
       const circle=document.createElementNS(ns,'circle');
       circle.setAttribute('cx',String(point.x));circle.setAttribute('cy',String(point.y));
       circle.setAttribute('r',String(r));circle.setAttribute('class','core-node-'+kind);
       group.append(circle);
     }
     const tooltip=document.createElementNS(ns,'title');
     tooltip.textContent=truncate(node.label||node.id,180)+' · '+truncate(node.status,35);
     group.append(tooltip);
     const label=document.createElementNS(ns,'text');
     label.setAttribute('x',String(point.x));label.setAttribute('y',String(point.y+17));
     label.setAttribute('text-anchor','middle');
     label.setAttribute('class','core-graph-label');
     label.textContent=truncate(node.label||node.id,12);
     group.append(label);svg.append(group);
   }
   const box=el('div','core-graph-render');
   box.append(svg,el('small','','SCHEMATISKI · '+nodes.length+' mezgli · savienojumi tikai no Core'));
   return box;
 }
 async submit(){
   const message=this.input.value.trim();
   if(!message||this.busy||this.dead)return;
   this.busy=true;this.send.disabled=true;this.input.disabled=true;
   const key=crypto.randomUUID();
   const stamp=new Date().toISOString();
   const userRow=this.appendMessage({role:'user',text:message,at:stamp,delivery:'UNCERTAIN_NO_RETRY'});
   this.input.value='';this.setFeedback('Iesniegts Core. Atbilde tiek gaidīta; atkārtota nosūtīšana ir bloķēta.');
   try{
     const reply=await this.invoke('core.chat',{key,message});
     if(this.dead)return;
     userRow?.querySelector('.core-message-provenance')?.remove();
     this.appendMessage({role:'assistant',text:reply.reply,at:new Date().toISOString(),
       runId:reply.runId,proofHash:reply.proofHash});
     this.setFeedback('Core atbilde saņemta. Tās apgalvojumi nav automātiski pārbaudīti.');
     void this.refresh();
   }catch(error){
     if(!this.dead)this.setFeedback('NEAPSTIPRINĀTS IZNĀKUMS · '+truncate(error?.message,200)+
       ' · pieprasījums netiks automātiski atkārtots.',true);
   }finally{
     this.busy=false;
     if(!this.dead){this.send.disabled=false;this.input.disabled=false;this.input.focus();}
   }
 }
}
window.MNEMOSCoreWorkspace=Object.freeze({
 mount(host,invoke){if(!(host instanceof Element)||typeof invoke!=='function')
     throw new Error('CORE_WORKSPACE_INVALID_HOST');
   const existing=instances.get(host);if(existing)return existing;
   const next=new CoreWorkspace(host,invoke);instances.set(host,next);return next;
 },
 dispose(host){instances.get(host)?.destroy();}
});
})();
