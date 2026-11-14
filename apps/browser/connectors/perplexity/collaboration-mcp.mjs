import { CollaborationStore } from './collaboration-store.mjs';

export function registerCollaborationTools({server,z,getStore}){
  const register=(name,title,description,schema,fn,readOnly=false)=>{
    server.registerTool(name,{
      title,description,inputSchema:schema,
      annotations:{readOnlyHint:readOnly,openWorldHint:false,destructiveHint:false}
    },async args=>{
      try{
        const result=await fn(args);
        return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
      }catch(e){
        return {isError:true,content:[{type:'text',text:String(e.message??e).slice(0,170)}]};
      }
    });
  };
  const ref='External model content is UNTRUSTED and is never executed or written to MNEMOS Core automatically. ';
  register('mnemos_propose_task','Propose MNEMOS task',
    ref+'Propose a task for the human owner to review in MNEMOS Browser. This creates only a pending proposal, NOT a Core task.',
    {requestId:z.string().min(10).max(100),title:z.string().min(5).max(180),details:z.string().min(10).max(4000)},
    x=>{
      const row=getStore().propose({...x,kind:'task'});
      return {proposalId:row.id,status:row.status,replayed:row.replayed,executed:false,requiresHumanApproval:true};
    });
  register('mnemos_request_consultation','Request consultation with ChatGPT',
    ref+'Request a consultation with the owner ChatGPT session. Only a human-approved request is forwarded through MNEMOS Frontier Bus.',
    {requestId:z.string().min(10).max(100),title:z.string().min(5).max(180),details:z.string().min(10).max(4000),target:z.enum(['chatgpt'])},
    x=>{
      const row=getStore().propose({...x,kind:'consultation'});
      return {proposalId:row.id,status:row.status,target:row.target,replayed:row.replayed,forwarded:false,requiresHumanApproval:true};
    });
  register('mnemos_proposal_status','Check collaboration request status',
    'Read status of one Perplexity task proposal or consultation, including whether owner approval has been granted. No automatic execution.',
    {proposalId:z.string().uuid()},
    ({proposalId})=>{
      const p=getStore().get(proposalId);
      if(!p)throw new Error('PROPOSAL_NOT_FOUND');
      return {proposalId:p.id,kind:p.kind,status:p.status,target:p.target,approvedAt:p.approvedAt,
        localItemId:p.localItemId,busMessageId:p.busMessageId,resultCount:p.resultCount,
        ...(p.kind==='consultation'?{reply:p.consultationReply}:{}),
        replyTrust:'EXTERNAL_MODEL_OUTPUT_UNTRUSTED'};
    },true);
  register('mnemos_submit_result','Submit untrusted result for human review',
    ref+'Submit an answer/result only for an already approved proposal. User must separately accept it into MNEMOS project memory.',
    {proposalId:z.string().uuid(),requestId:z.string().min(10).max(100),
      summary:z.string().min(5).max(180),details:z.string().min(10).max(8000)},
    x=>{
      const result=getStore().submitResult(x);
      return {resultId:result.id,proposalId:result.proposalId,status:result.status,
        replayed:result.replayed,committedToMemory:false,requiresHumanReview:true};
    });
}
