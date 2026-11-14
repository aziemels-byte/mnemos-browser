import crypto from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { frontierIdempotencyReceipt, deduplicateFrontierMessage } from './frontier-idempotency.mjs';
import { frontierSessionLiveness, summarizeFrontierWork } from './frontier-work-triage.mjs';
import { validateFrontierState } from './persisted-controller-state-validation.mjs';
import { writeAtomicJsonState, assertNoOrphanTempOnFirstBoot } from './atomic-state-file.mjs';
import { ControllerStateBackups } from './controller-state-backups.mjs';

const VALID_ID=/^[a-z0-9][a-z0-9._:-]{2,127}$/i;
const VALID_VERIFIER=/^[a-f0-9]{64}$/;
const clone=value=>value==null?value:structuredClone(value);
const sha256=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
const timingSafeEqualHex=(left,right)=>{const a=Buffer.from(left,'hex'),b=Buffer.from(right,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b);};
const emptyCollaboration=()=>({waitingFor:[],actionRequired:[],repliesAvailable:[],attentionRequired:[],counts:{waitingFor:0,actionRequired:0,repliesAvailable:0,attentionRequired:0}});
const normalizeMetadata=value=>{const metadata=value&&typeof value==='object'&&!Array.isArray(value)?clone(value):{},wake=metadata.wake&&typeof metadata.wake==='object'&&!Array.isArray(metadata.wake)?clone(metadata.wake):{};wake.enabled=wake.enabled===true;metadata.wake=wake;return metadata;};

export class FrontierSessionBus {
  constructor({runtimeRoot,clock=()=>Date.now(),maxMessages=2000,wakeDispatcher=null,stateWriter=writeAtomicJsonState,backupManager=null}={}){
    if(!runtimeRoot)throw new Error('FrontierSessionBus requires runtimeRoot');
    this.root=path.join(runtimeRoot,'frontier-session-bus');this.statePath=path.join(this.root,'state.json');this.clock=clock;this.maxMessages=Math.max(100,Number(maxMessages)||2000);this.wakeDispatcher=wakeDispatcher;this.stateWriter=stateWriter;this.backups=backupManager??new ControllerStateBackups({runtimeRoot,controller:'frontier',clock});this.sessions=new Map();this.messages=[];this.idempotencyReceipts=new Map();this.maxIdempotencyReceipts=20000;this.persistQueue=Promise.resolve();this.storageFault=null;
  }
  async init(){await mkdir(this.root,{recursive:true});let migrated=false;try{const state=validateFrontierState(JSON.parse(await readFile(this.statePath,'utf8')));for(const restored of state.sessions??[]){const session=clone(restored),metadata=normalizeMetadata(session?.metadata);if(JSON.stringify(metadata)!==JSON.stringify(session?.metadata)){session.metadata=metadata;migrated=true;}if(session?.status!=='CLOSED'&&!VALID_VERIFIER.test(String(session?.verifierHash??''))){const now=new Date(this.clock()).toISOString();session.status='CLOSED';session.closedAt=session.closedAt??now;session.closeReason=session.closeReason??'LEGACY_UNBOUND';session.lastSeenAt=now;migrated=true;}this.sessions.set(session.sessionId,session);}this.messages=Array.isArray(state.messages)?state.messages.slice(-this.maxMessages):[];this.idempotencyReceipts=new Map((state.idempotencyReceipts??[]).map(receipt=>[receipt.keyHash,receipt]));for(const message of this.messages){const proof=message.idempotency;if(proof?.keyHash&&!this.idempotencyReceipts.has(proof.keyHash))this.idempotencyReceipts.set(proof.keyHash,{...proof,messageId:message.messageId,threadId:message.threadId,from:message.from,to:message.to,createdAt:message.createdAt});}}catch(error){if(error?.code==='ENOENT'){try{await assertNoOrphanTempOnFirstBoot(this.statePath);}catch(cause){throw Object.assign(new Error('Persisted MNEMOS state has an interrupted first write; refusing empty-state recovery'),{code:'FRONTIER_BUS_STATE_UNREADABLE',cause});}}else throw Object.assign(new Error('Persisted MNEMOS state is unreadable; refusing empty-state recovery'),{code:'FRONTIER_BUS_STATE_UNREADABLE',cause:error});}if(migrated)await this.persist();await this.tryBackupCheckpoint();return this.snapshot();}
  validateId(value,label='session ID'){const id=String(value??'').trim();if(!VALID_ID.test(id))throw new Error(`Invalid frontier ${label}`);return id;}
  normalizeVerifier(value){const verifier=String(value??'').trim().toLowerCase();return VALID_VERIFIER.test(verifier)?verifier:null;}
  publicSession(session){if(!session)return null;const value=clone(session);delete value.verifierHash;return value;}
  authorize(sessionId,verifier,{allowClosed=false}={}){const id=this.validateId(sessionId),session=this.sessions.get(id);if(!session)throw new Error('Frontier session not registered');if(session.status==='CLOSED'&&!allowClosed)throw new Error('Frontier session is closed');const supplied=this.normalizeVerifier(verifier);if(!supplied)throw new Error('SESSION_AUTH_REQUIRED: Frontier session verifier is required');const stored=String(session.verifierHash??'');if(!VALID_VERIFIER.test(stored)||!timingSafeEqualHex(stored,sha256(supplied)))throw new Error('SESSION_AUTH_INVALID: Frontier session verifier is invalid');return{id,session};}
  async tryBackupCheckpoint(){
    try{await this.backups.checkpoint(this.statePath);}
    catch(error){if(error?.code==='ENOENT')this.backups.fault=null;}
  }
  async persist(){
    const write=async()=>{
      if(this.storageFault)throw Object.assign(new Error('Frontier persistence fault: restart after storage repair'),{code:'FRONTIER_STORAGE_FAULT'});
      try{
        await this.stateWriter(this.statePath,{schema:'mnemos.frontier-session-bus.v2',updatedAt:new Date(this.clock()).toISOString(),sessions:[...this.sessions.values()],messages:this.messages.slice(-this.maxMessages),idempotencyReceipts:[...this.idempotencyReceipts.values()]});
        await this.tryBackupCheckpoint();
      }catch(error){this.storageFault=error;throw error;}
    };
    const job=this.persistQueue.then(write,write);
    this.persistQueue=job.catch(()=>{});
    return job;
  }
  async register({sessionId,role='specialist',displayName=null,capabilities=[],metadata=null,verifier=null}={}){const id=this.validateId(sessionId),now=new Date(this.clock()).toISOString(),previous=this.sessions.get(id);if(previous?.status==='CLOSED')throw new Error('Frontier session ID is closed and cannot be reused');if(previous){this.authorize(id,verifier);previous.schema='mnemos.frontier-session.v2';previous.role=String(role??previous.role??'specialist').slice(0,100);previous.displayName=String(displayName??previous.displayName??id).slice(0,200);previous.capabilities=[...new Set((Array.isArray(capabilities)?capabilities:previous.capabilities??[]).map(String).map(x=>x.trim()).filter(Boolean))].slice(0,64);previous.metadata=normalizeMetadata(metadata==null?previous.metadata:metadata);previous.status='ONLINE';previous.lastSeenAt=now;await this.persist();return this.publicSession(previous);}const issuedVerifier=crypto.randomBytes(32).toString('hex'),session={schema:'mnemos.frontier-session.v2',sessionId:id,role:String(role??'specialist').slice(0,100),displayName:String(displayName??id).slice(0,200),capabilities:[...new Set((Array.isArray(capabilities)?capabilities:[]).map(String).map(x=>x.trim()).filter(Boolean))].slice(0,64),status:'ONLINE',createdAt:now,lastSeenAt:now,metadata:normalizeMetadata(metadata),verifierHash:sha256(issuedVerifier)};this.sessions.set(id,session);await this.persist();return{...this.publicSession(session),verifier:issuedVerifier};}
  async heartbeat(sessionId,{verifier=null}={}){const{id,session}=this.authorize(sessionId,verifier);session.status='ONLINE';session.lastSeenAt=new Date(this.clock()).toISOString();await this.persist();return{session:this.publicSession(session),...this.collaborationState(id)};}
  async bindProvisionedWakeTarget({sessionId,provisioningId,profileId,conversationUrl,projectUrl}={}){const id=this.validateId(sessionId),session=this.sessions.get(id);if(!session||session.status==='CLOSED')throw new Error('Provisioned frontier session is not active');const expected=String(session.metadata?.provisioning?.id??''),provided=String(provisioningId??'');if(!expected||expected!==provided)throw new Error('FRONTIER_PROVISIONING_ID_MISMATCH');const profile=String(profileId??'').trim(),conversation=String(conversationUrl??'').trim(),project=String(projectUrl??'').trim();if(!VALID_ID.test(profile))throw new Error('Invalid provisioned browser profile ID');let conversationParsed,projectParsed;try{conversationParsed=new URL(conversation);projectParsed=new URL(project);}catch{throw new Error('Invalid provisioned ChatGPT URL');}if(conversationParsed.protocol!=='https:'||conversationParsed.hostname!=='chatgpt.com'||projectParsed.protocol!=='https:'||projectParsed.hostname!=='chatgpt.com')throw new Error('Provisioned ChatGPT target must use chatgpt.com HTTPS');const projectMatch=/^\/g\/(g-p-[a-z0-9_-]{8,160})\/project$/i.exec(projectParsed.pathname.replace(/\/$/,'')),chatMatch=/^\/g\/(g-p-[a-z0-9_-]{8,160})\/c\/[a-z0-9_-]{8,128}$/i.exec(conversationParsed.pathname.replace(/\/$/,''));if(!projectMatch||!chatMatch||projectMatch[1]!==chatMatch[1])throw new Error('Provisioned conversation is not inside the provisioned project');session.metadata=normalizeMetadata({...session.metadata,provisioning:{...session.metadata.provisioning,boundAt:new Date(this.clock()).toISOString(),projectUrl:project},wake:{...(session.metadata?.wake??{}),enabled:true,profileId:profile,conversationUrl:conversation,projectUrl:project}});session.lastSeenAt=new Date(this.clock()).toISOString();await this.persist();await this.wakeDispatcher?.reconcileFrontierSnapshot?.(this.snapshot());return this.publicSession(session);}
  async close(sessionId,{reason=null,verifier=null}={}){
    const{id,session}=this.authorize(sessionId,verifier,{allowClosed:true});

    const now=new Date(this.clock()).toISOString(),resolvedMessageIds=[];
    for(const message of this.messages){
      if(message.expectsReply!==true||message.replyReceivedAt||message.resolvedAt||(message.from!==id&&message.to!==id))continue;
      message.resolvedAt=now;message.resolution='SESSION_CLOSED';message.resolvedBy=id;resolvedMessageIds.push(message.messageId);
    }
    if(session.status!=='CLOSED'){session.status='CLOSED';session.lastSeenAt=now;session.closedAt=now;session.closeReason=reason==null?null:String(reason).trim().slice(0,500)||null;}
    await this.persist();
    await this.wakeDispatcher?.acknowledgeSession?.({sessionId:id});
    for(const messageId of resolvedMessageIds)await this.wakeDispatcher?.acknowledgeResolvedMessage?.({messageId});
    return this.publicSession(session);
  }
  async send({from,to,body,threadId=null,kind='consult',replyTo=null,expectsReply=null,metadata=null,verifier=null}={}){const{id:sender,session:senderSession}=this.authorize(from,verifier),recipient=this.validateId(to,'recipient ID'),recipientSession=this.sessions.get(recipient);if(!recipientSession)throw new Error('Both frontier sessions must be registered');if(senderSession.status==='CLOSED'||recipientSession.status==='CLOSED')throw new Error('Closed frontier sessions cannot send or receive messages');const text=String(body??'').trim();if(!text)throw new Error('Frontier message body is required');
  const normalizedKind=String(kind??'consult').slice(0,64);
  const replyExpected=expectsReply==null?['consult','question','review_request','work_request'].includes(normalizedKind):expectsReply===true;
  const idempotency=frontierIdempotencyReceipt({sender,to:recipient,body:text.slice(0,16000),threadId:threadId==null?null:this.validateId(threadId,'thread ID'),kind:normalizedKind,replyTo:replyTo==null?null:String(replyTo),expectsReply:replyExpected,metadata});
  const existing=deduplicateFrontierMessage(this.messages,idempotency);
  if(existing){
    // Prior commit may have succeeded while its response or wake reconciliation failed.
    // Reassert durability and rerun the idempotent wake reconciliation on retry.
    await this.persist();
    await this.wakeDispatcher?.reconcileFrontierSnapshot?.(this.snapshot());
    return existing;
  }
  const archived=idempotency?this.idempotencyReceipts.get(idempotency.keyHash):null;
  if(archived){
    if(archived.requestHash!==idempotency.requestHash)
      throw Object.assign(new Error('Frontier idempotency key reused with a different request'),{code:'FRONTIER_IDEMPOTENCY_CONFLICT'});
    return {schema:'mnemos.frontier-message-receipt.v1',messageId:archived.messageId,threadId:archived.threadId,
      from:archived.from,to:archived.to,createdAt:archived.createdAt,status:'ARCHIVED',idempotentReplay:true};
  }
  if(idempotency&&this.idempotencyReceipts.size>=this.maxIdempotencyReceipts)
    throw Object.assign(new Error('Frontier idempotency receipt capacity reached; operator review required'),{code:'FRONTIER_IDEMPOTENCY_LEDGER_FULL'});
  const messageId=`msg_${crypto.randomUUID()}`,now=new Date(this.clock()).toISOString(),thread=threadId?this.validateId(threadId,'thread ID'):`thr_${crypto.randomUUID()}`;senderSession.lastSeenAt=now;let repliedToMessage=null;if(replyTo!=null){repliedToMessage=this.messages.find(item=>item.messageId===String(replyTo)&&item.threadId===thread&&item.to===sender&&item.from===recipient)??null;if(!repliedToMessage)throw new Error('Frontier reply target not found in thread');repliedToMessage.replyReceivedAt=now;repliedToMessage.repliedBy=sender;repliedToMessage.resolvedAt=now;repliedToMessage.resolution='REPLIED';repliedToMessage.resolvedBy=sender;}const message={schema:'mnemos.frontier-message.v1',messageId,threadId:thread,from:sender,to:recipient,kind:normalizedKind,body:text.slice(0,16000),replyTo:replyTo==null?null:String(replyTo),expectsReply:replyExpected,status:'PENDING',createdAt:now,deliveredAt:null,acknowledgedAt:null,replyReceivedAt:null,repliedBy:null,resolvedAt:null,resolution:null,resolvedBy:null,metadata:idempotency?Object.fromEntries(Object.entries(metadata).filter(([key])=>key!=='idempotencyKey')):clone(metadata),idempotency};if(idempotency)this.idempotencyReceipts.set(idempotency.keyHash,{...idempotency,messageId,threadId:thread,from:sender,to:recipient,createdAt:now});this.messages.push(message);if(this.messages.length>this.maxMessages)this.messages=this.messages.slice(-this.maxMessages);await this.persist();await this.wakeDispatcher?.reconcileFrontierSnapshot?.(this.snapshot());return clone(message);}
  async inbox(sessionId,{ack=false,limit=50,verifier=null}={}){const{id,session}=this.authorize(sessionId,verifier);const now=new Date(this.clock()).toISOString(),messages=this.messages.filter(message=>message.to===id&&message.status!=='ACKNOWLEDGED').slice(0,Math.max(1,Math.min(200,Number(limit)||50)));if(messages.length){for(const message of messages){if(message.status==='PENDING'){message.status='DELIVERED';message.deliveredAt=now;}if(ack){message.status='ACKNOWLEDGED';message.acknowledgedAt=now;}}await this.persist();if(ack)for(const message of messages)await this.wakeDispatcher?.acknowledgeAction?.({sessionId:id,messageId:message.messageId});}session.lastSeenAt=now;session.status='ONLINE';await this.persist();const collaboration=this.collaborationState(id),publicMessages=messages.map(message=>{const item=clone(message),wake=this.wakeDispatcher?.correlationForAction?.({sessionId:id,messageId:message.messageId});return wake?{...item,wake}:item;});return{sessionId:id,messages:publicMessages,...collaboration};}
  async acknowledge(sessionId,messageId,{verifier=null}={}){const{id}=this.authorize(sessionId,verifier),message=this.messages.find(item=>item.messageId===String(messageId)&&item.to===id);if(!message)throw new Error('Frontier message not found');message.status='ACKNOWLEDGED';message.acknowledgedAt=new Date(this.clock()).toISOString();await this.persist();await this.wakeDispatcher?.acknowledgeAction?.({sessionId:id,messageId:message.messageId});return clone(message);}
  thread(threadId,{sessionId,verifier=null}={}){const id=this.validateId(threadId,'thread ID'),{id:principal}=this.authorize(sessionId,verifier),messages=this.messages.filter(message=>message.threadId===id);if(messages.length&&!messages.some(message=>message.from===principal||message.to===principal))throw new Error('FRONTIER_THREAD_ACCESS_DENIED: Session is not a participant in this thread');return messages.map(clone);}
  collaborationState(sessionId){const id=this.validateId(sessionId),session=this.sessions.get(id);if(session?.status==='CLOSED')return emptyCollaboration();const unresolved=this.messages.filter(message=>message.expectsReply===true&&!message.replyReceivedAt&&!message.resolvedAt),waitingFor=unresolved.filter(message=>message.from===id).map(message=>({messageId:message.messageId,threadId:message.threadId,sessionId:message.to,kind:message.kind,createdAt:message.createdAt,body:message.body})),actionRequired=unresolved.filter(message=>message.to===id).map(message=>({messageId:message.messageId,threadId:message.threadId,sessionId:message.from,kind:message.kind,createdAt:message.createdAt,body:message.body})),repliesAvailable=this.messages.filter(message=>message.to===id&&message.replyTo!=null&&message.status!=='ACKNOWLEDGED').map(message=>({messageId:message.messageId,threadId:message.threadId,from:message.from,replyTo:message.replyTo,createdAt:message.createdAt,body:message.body,instruction:'REPLY_AVAILABLE: inspect this reply thread and continue the related work.'})),attentionRequired=[...repliesAvailable.map(reply=>({type:'REPLY_AVAILABLE',priority:'HIGH',messageId:reply.messageId,threadId:reply.threadId,from:reply.from,instruction:reply.instruction})),...actionRequired.map(item=>({type:'ACTION_REQUIRED',priority:'NORMAL',messageId:item.messageId,threadId:item.threadId,from:item.sessionId,instruction:'ACTION_REQUIRED: inspect the request, respond through MNEMOS, then continue your assigned work.'}))];return{waitingFor:waitingFor.map(clone),actionRequired:actionRequired.map(clone),repliesAvailable:repliesAvailable.map(clone),attentionRequired:attentionRequired.map(clone),counts:{waitingFor:waitingFor.length,actionRequired:actionRequired.length,repliesAvailable:repliesAvailable.length,attentionRequired:attentionRequired.length}};}
  snapshot({compact=false}={}){
    const now=this.clock(),capturedAt=new Date(now).toISOString();
    const triage=summarizeFrontierWork({
      sessions:[...this.sessions.values()],messages:this.messages,nowMs:now
    });
    const sessions=[...this.sessions.values()].map(session=>{
      const liveness=frontierSessionLiveness(session,now),lastSeenMs=Date.parse(session.lastSeenAt??'');
      const lastSeenAgeMs=Number.isFinite(lastSeenMs)?Math.max(0,now-lastSeenMs):null;
      if(compact)return {
        sessionId:session.sessionId,status:session.status,liveness,
        lastSeenAt:session.lastSeenAt,lastSeenAgeMs,
        collaborationCounts:triage.collaboration.get(session.sessionId)?{
          ...triage.collaboration.get(session.sessionId)
        }:{waitingFor:0,actionRequired:0,repliesAvailable:0,attentionRequired:0}
      };
      return {...this.publicSession(session),liveness,lastSeenAgeMs,collaboration:this.collaborationState(session.sessionId)};
    });
    const activeSessions=sessions.filter(session=>session.status!=='CLOSED').length;
    const counts={
      sessions:sessions.length,activeSessions,closedSessions:sessions.length-activeSessions,
      recentSessions:sessions.filter(session=>session.liveness==='RECENT').length,
      staleSessions:sessions.filter(session=>session.liveness==='STALE').length,
      unknownLivenessSessions:sessions.filter(session=>session.liveness==='UNKNOWN').length,
      messages:this.messages.length,pending:triage.pending.total,unresolvedReplies:triage.unresolved.total
    };
    const {collaboration,...workTriage}=triage;
    const idempotencyReceipts=this.idempotencyReceipts.size;
    const receiptLedger={receipts:idempotencyReceipts,capacity:this.maxIdempotencyReceipts,
      remaining:Math.max(0,this.maxIdempotencyReceipts-idempotencyReceipts),
      nearCapacity:idempotencyReceipts>=this.maxIdempotencyReceipts*0.9};
    const base={schema:'mnemos.frontier-session-bus.telemetry.v2',capturedAt,counts,
      workTriage,receiptLedger,storage:{writable:!this.storageFault,faultCode:this.storageFault?.code??null},backup:this.backups.summary()};
    if(compact)return {...base,oldestPendingAt:triage.pending.oldestAt,
      oldestUnresolvedAt:triage.unresolved.oldestAt,sessions};
    const pending=this.messages.filter(message=>message.status!=='ACKNOWLEDGED');
    const unresolved=this.messages.filter(message=>message.expectsReply===true&&!message.replyReceivedAt&&!message.resolvedAt);
    return {...base,sessions,pending:pending.slice(-100).map(clone),
      unresolvedReplies:unresolved.slice(-100).map(clone)};
  }
}
