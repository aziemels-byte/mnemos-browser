import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {CollaborationStore} from '../connectors/perplexity/collaboration-store.mjs';
test('Perplexity can propose but cannot execute, idempotency survives restart',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'mnemos-perplexity-queue-'));
 let s;
 try{
   const db=path.join(root,'queue.sqlite');
   s=new CollaborationStore(db);
   const item={requestId:'perplexity-proposal-000001',kind:'task',title:'Implementēt būvēšanas diagnostiku',
      details:'Ierosināt izolētu, pārskatāmu darba uzdevumu bez izpildes.'};
   const p=s.propose(item);
   assert.equal(p.status,'PENDING_APPROVAL');
   assert.equal(p.localItemId,null);
   assert.equal(s.pending().length,1);
   assert.equal(s.propose(item).replayed,true);
   assert.throws(()=>s.propose({...item,details:'Mainīts pieprasījums, pati atslēga saglabājas.'}),/IDEMPOTENCY_CONFLICT/);
   assert.throws(()=>s.submitResult({proposalId:p.id,requestId:'perplexity-result-000001',summary:'Preliminary',
      details:'This is an external result and not approved.'}),/NOT_APPROVED/);
   s.close();s=new CollaborationStore(db);
   assert.equal(s.get(p.id).status,'PENDING_APPROVAL');
   s.beginApproval(p.id);s.finishApproval(p.id,{localItemId:'browser-local-id-1'});
   assert.equal(s.get(p.id).status,'APPROVED');
   const result={proposalId:p.id,requestId:'perplexity-result-000001',
     summary:'Pārbaudīta diagnostika',details:'Ārējs rezultāts, gaida atsevišķu cilvēka pārskatu.'};
   const r=s.submitResult(result);
   assert.equal(r.status,'AWAITING_REVIEW');
   assert.equal(s.submitResult(result).replayed,true);
   s.claimResult(r.id);s.finishResult(r.id,'memory-1');
   assert.equal(s.result(r.id).status,'ACCEPTED');
   assert.equal(s.propose({requestId:'perplexity-consult-000001',kind:'consultation',
     target:'chatgpt',title:'Pajautāt citiem modeļiem',details:'Piedāvāt salīdzinājumu; tikai pēc cilvēka atļaujas.'}).status,'PENDING_APPROVAL');
   const consultation=s.pending().find(p=>p.kind==='consultation');
   assert.ok(consultation);
   const consultationMessageId='msg_'+randomUUID(),ownerReplyId='msg_'+randomUUID();
   assert.throws(()=>s.recordConsultationReply({proposalId:consultation.id,sourceMessageId:ownerReplyId,
     replyTo:consultationMessageId,text:'ChatGPT ieteikums no autorizētas sesijas.'}),/NOT_APPROVED/);
   s.beginApproval(consultation.id);s.finishApproval(consultation.id,{busMessageId:consultationMessageId});
   const reply={proposalId:consultation.id,sourceMessageId:ownerReplyId,replyTo:consultationMessageId,
     text:'ChatGPT ieteikums no autorizētas sesijas.'};
   assert.equal(s.recordConsultationReply(reply).saved,true);
   assert.equal(s.recordConsultationReply(reply).replayed,true);
   assert.match(s.get(consultation.id).consultationReply.text,/ChatGPT ieteikums/);
   assert.throws(()=>s.recordConsultationReply({...reply,replyTo:'msg_'+randomUUID()}),/THREAD_MISMATCH/);
   assert.equal(s.submitResult({proposalId:consultation.id,requestId:'chatgpt-reply-'+ownerReplyId,
     summary:'ChatGPT konsultācijas atbilde',details:reply.text}).status,'AWAITING_REVIEW');
   assert.throws(()=>s.propose({requestId:'perplexity-consult-000002',kind:'consultation',
     target:'claude',title:'Nederīga adresācija',details:'Nezināms modeļa savienojums bez apstiprinājuma.'}),/TARGET_NOT_AVAILABLE/);
   const next=s.propose({requestId:'perplexity-proposal-000002',kind:'task',
     title:'Pārskatāms uzdevums',details:'Nekādu patvaļīgu izpildes komandu.'});
   s.reject(next.id);assert.equal(s.get(next.id).status,'REJECTED');
   assert.throws(()=>s.beginApproval(next.id),/NOT_PENDING/);
 }finally{s?.close();rmSync(root,{recursive:true,force:true});}
});
