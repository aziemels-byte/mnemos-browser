/**
 * Persistent, approval-gated exchange between Perplexity and MNEMOS.
 * External model submissions are untrusted proposals, never executable commands.
 * SQLite (node:sqlite) provides ACID/idempotency across concurrent MCP clients.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { connectorPaths } from '../../src/connector-config.mjs';

const now=()=>new Date().toISOString();
const max=(v,n)=>String(v??'').trim().slice(0,n);
function requestKey(value){
  if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{10,100}$/.test(value))
    throw new Error('REQUEST_ID_INVALID');
  return value;
}
function valueText(value,min,maxLen){
  if(typeof value!=='string'||value.trim().length<min||value.length>maxLen)
    throw new Error('INPUT_LENGTH_INVALID');
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw new Error('CONTROL_CHARACTERS_REJECTED');
  return value.trim();
}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cleanRow=row=>row?{
  id:row.id,kind:row.kind,target:row.target??null,
  title:row.title,details:row.details,status:row.status,
  createdAt:row.created_at,updatedAt:row.updated_at,
  approvedAt:row.approved_at,localItemId:row.local_item_id??null,
  busMessageId:row.bus_message_id??null,
  resultCount:row.result_count??0
}:null;
export class CollaborationStore {
  constructor(dbPath=connectorPaths().collaborationDatabase){
    mkdirSync(path.dirname(dbPath),{recursive:true});
    this.db=new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS proposal(
      id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL,
      payload_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('task','consultation')),
      target TEXT, title TEXT NOT NULL, details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      approved_at TEXT, local_item_id TEXT, bus_message_id TEXT
    );
    CREATE TABLE IF NOT EXISTS submitted_result(
      id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposal(id),
      request_key TEXT UNIQUE NOT NULL,payload_hash TEXT NOT NULL,
      summary TEXT NOT NULL, details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'AWAITING_REVIEW',created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, local_item_id TEXT
    );
    CREATE INDEX IF NOT EXISTS proposal_status_idx ON proposal(status,created_at);
    CREATE INDEX IF NOT EXISTS result_status_idx ON submitted_result(status,created_at);
    CREATE TABLE IF NOT EXISTS consultation_reply(
      proposal_id TEXT PRIMARY KEY REFERENCES proposal(id),
      source_message_id TEXT UNIQUE NOT NULL,reply_to TEXT NOT NULL,
      body TEXT NOT NULL,created_at TEXT NOT NULL
    );`);
    this.getStatement=this.db.prepare('SELECT p.*, (SELECT COUNT(*) FROM submitted_result r WHERE r.proposal_id=p.id) AS result_count FROM proposal p WHERE p.id=?');
  }
  get(id){const row=cleanRow(this.getStatement.get(String(id??'')));
    if(row?.kind==='consultation'){
      const reply=this.db.prepare('SELECT body,created_at FROM consultation_reply WHERE proposal_id=?').get(row.id);
      row.consultationReply=reply?{text:reply.body,receivedAt:reply.created_at,trust:'UNTRUSTED_MODEL_OUTPUT'}:null;
    }
    return row;
  }
  propose({requestId,kind,title,details,target=null}){
    requestKey(requestId);
    if(!['task','consultation'].includes(kind))throw new Error('INVALID_PROPOSAL_KIND');
    const cleanTitle=valueText(title,5,180);
    const cleanDetails=valueText(details,10,4000);
    if(kind==='consultation'&&target!=='chatgpt')throw new Error('TARGET_NOT_AVAILABLE:chatgpt');
    if(kind==='task')target=null;
    const payload={kind,title:cleanTitle,details:cleanDetails,target};
    const hash=digest(payload);
    const existing=this.db.prepare('SELECT id,payload_hash FROM proposal WHERE request_key=?').get(requestId);
    if(existing){
      if(existing.payload_hash!==hash)throw new Error('IDEMPOTENCY_CONFLICT');
      return {...this.get(existing.id),replayed:true};
    }
    const pending=this.db.prepare("SELECT COUNT(*) AS n FROM proposal WHERE status IN ('PENDING_APPROVAL','APPROVING')").get().n;
    if(pending>=30)throw new Error('PENDING_QUEUE_FULL');
    const created24=this.db.prepare("SELECT COUNT(*) AS n FROM proposal WHERE created_at>=?").get(new Date(Date.now()-86400000).toISOString()).n;
    if(created24>=160)throw new Error('DAILY_SUBMISSION_LIMIT');
    const id=randomUUID(),time=now();
    try{
      this.db.prepare('INSERT INTO proposal(id,request_key,payload_hash,kind,target,title,details,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id,requestId,hash,kind,target,cleanTitle,cleanDetails,time,time);
      return {...this.get(id),replayed:false};
    }catch(error){
      if(error.code!=='ERR_SQLITE_ERROR')throw error;
      const collision=this.db.prepare('SELECT id,payload_hash FROM proposal WHERE request_key=?').get(requestId);
      if(!collision)throw error;
      if(collision.payload_hash!==hash)throw new Error('IDEMPOTENCY_CONFLICT');
      return {...this.get(collision.id),replayed:true};
    }
  }
  pending(limit=15){
    return this.db.prepare("SELECT id FROM proposal WHERE status='PENDING_APPROVAL' ORDER BY created_at ASC LIMIT ?")
      .all(Math.min(Math.max(1,Number(limit)||10),30)).map(x=>this.get(x.id));
  }
  all(limit=15){
    return this.db.prepare('SELECT id FROM proposal ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Math.max(1,Number(limit)||10),40)).map(x=>this.get(x.id));
  }
  beginApproval(id){
    const p=this.get(id);if(!p)throw new Error('PROPOSAL_NOT_FOUND');
    if(p.status!=='PENDING_APPROVAL')throw new Error('PROPOSAL_NOT_PENDING');
    const x=this.db.prepare("UPDATE proposal SET status='APPROVING',updated_at=? WHERE id=? AND status='PENDING_APPROVAL'")
      .run(now(),id);
    if(x.changes!==1)throw new Error('APPROVAL_RACE');
    return p;
  }
  finishApproval(id,{localItemId=null,busMessageId=null}={}){
    const x=this.db.prepare("UPDATE proposal SET status='APPROVED',approved_at=?,updated_at=?,local_item_id=?,bus_message_id=? WHERE id=? AND status='APPROVING'")
      .run(now(),now(),localItemId,busMessageId,id);
    if(x.changes!==1)throw new Error('APPROVAL_NOT_CLAIMED');
    return this.get(id);
  }
  reject(id){
    const x=this.db.prepare("UPDATE proposal SET status='REJECTED',updated_at=? WHERE id=? AND status='PENDING_APPROVAL'").run(now(),id);
    if(x.changes!==1)throw new Error('PROPOSAL_NOT_PENDING');
    return this.get(id);
  }
  // "APPROVING" is deliberately not auto-retried: a crash must not duplicate tasks or messages.
  submitResult({proposalId,requestId,summary,details}){
    requestKey(requestId);
    const p=this.get(proposalId);
    if(!p)throw new Error('PROPOSAL_NOT_FOUND');
    if(p.status!=='APPROVED')throw new Error('PROPOSAL_NOT_APPROVED');
    const payload={proposalId,summary:valueText(summary,5,180),details:valueText(details,10,8000)};
    const hash=digest(payload);
    const found=this.db.prepare('SELECT * FROM submitted_result WHERE request_key=?').get(requestId);
    if(found){
      if(found.payload_hash!==hash)throw new Error('IDEMPOTENCY_CONFLICT');
      return {...this.safeResult(found),replayed:true};
    }
    const count=this.db.prepare("SELECT COUNT(*) AS n FROM submitted_result WHERE proposal_id=?").get(proposalId).n;
    if(count>=5)throw new Error('RESULT_LIMIT');
    const id=randomUUID(),time=now();
    try{
      this.db.prepare('INSERT INTO submitted_result(id,proposal_id,request_key,payload_hash,summary,details,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,proposalId,requestId,hash,payload.summary,payload.details,time,time);
    }catch(error){
      const collision=this.db.prepare('SELECT * FROM submitted_result WHERE request_key=?').get(requestId);
      if(!collision)throw error;
      if(collision.payload_hash!==hash)throw new Error('IDEMPOTENCY_CONFLICT');
      return {...this.safeResult(collision),replayed:true};
    }
    return {...this.result(id),replayed:false};
  }
  safeResult(row){return row?{id:row.id,proposalId:row.proposal_id,summary:row.summary,details:row.details,status:row.status,createdAt:row.created_at,localItemId:row.local_item_id??null}:null;}
  result(id){return this.safeResult(this.db.prepare('SELECT * FROM submitted_result WHERE id=?').get(String(id??'')));}
  pendingResults(limit=20){return this.db.prepare("SELECT id FROM submitted_result WHERE status='AWAITING_REVIEW' ORDER BY created_at ASC LIMIT ?")
    .all(Math.min(Math.max(1,Number(limit)||10),30)).map(x=>this.result(x.id));}
  claimResult(id){
    const x=this.db.prepare("UPDATE submitted_result SET status='ACCEPTING',updated_at=? WHERE id=? AND status='AWAITING_REVIEW'").run(now(),id);
    if(x.changes!==1)throw new Error('RESULT_NOT_PENDING');
    return this.result(id);
  }
  finishResult(id,localItemId){
    const x=this.db.prepare("UPDATE submitted_result SET status='ACCEPTED',updated_at=?,local_item_id=? WHERE id=? AND status='ACCEPTING'")
      .run(now(),localItemId,id);
    if(x.changes!==1)throw new Error('RESULT_NOT_CLAIMED');
    return this.result(id);
  }
  rejectResult(id){
    const x=this.db.prepare("UPDATE submitted_result SET status='REJECTED',updated_at=? WHERE id=? AND status='AWAITING_REVIEW'").run(now(),id);
    if(x.changes!==1)throw new Error('RESULT_NOT_PENDING');
    return this.result(id);
  }
  recordConsultationReply({proposalId,sourceMessageId,replyTo,text}){
    const p=this.get(proposalId);
    if(!p||p.kind!=='consultation'||p.status!=='APPROVED')
      throw new Error('CONSULTATION_NOT_APPROVED');
    if(p.busMessageId!==replyTo)throw new Error('CONSULTATION_THREAD_MISMATCH');
    if(!/^msg_[a-f0-9-]{36}$/i.test(String(sourceMessageId??'')))
      throw new Error('SOURCE_MESSAGE_ID_INVALID');
    const answer=valueText(text,5,8000);
    const old=this.db.prepare('SELECT * FROM consultation_reply WHERE proposal_id=?').get(proposalId);
    if(old){
      if(old.source_message_id!==sourceMessageId||old.body!==answer)
        throw new Error('CONSULTATION_REPLY_CONFLICT');
      return {saved:true,replayed:true,proposalId};
    }
    this.db.prepare('INSERT INTO consultation_reply(proposal_id,source_message_id,reply_to,body,created_at) VALUES(?,?,?,?,?)')
      .run(proposalId,sourceMessageId,replyTo,answer,now());
    return {saved:true,replayed:false,proposalId};
  }
  close(){this.db.close();}
}
