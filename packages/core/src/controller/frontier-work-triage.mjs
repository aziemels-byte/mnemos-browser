// Read-only summary. Never assume that stale/closed sessions imply work is resolved.
// This module must not return message bodies, verifiers, or metadata.
const PENDING='PENDING';
const CLOSED='CLOSED';

export function frontierSessionLiveness(session,nowMs,staleAfterMs=30*60_000){
  if(session?.status===CLOSED)return CLOSED;
  const lastSeen=Date.parse(String(session?.lastSeenAt??''));
  if(!Number.isFinite(lastSeen)||lastSeen>nowMs)return 'UNKNOWN';
  return nowMs-lastSeen<=staleAfterMs?'RECENT':'STALE';
}

export function summarizeFrontierWork({sessions=[],messages=[],nowMs=Date.now()}={}){
  const now=Number.isFinite(nowMs)?nowMs:Date.now();
  const liveness=new Map();
  for(const session of sessions)liveness.set(session.sessionId,frontierSessionLiveness(session,now));

  // Categories partition each set, so the category sums must equal the totals.
  const names=['recipientRecent','recipientStale','recipientUnknown','closedEndpoint','missingEndpoint'];
  const makeBuckets=()=>Object.fromEntries(names.map(key=>[key,0]));
  const pendingByRecipient=makeBuckets(),unresolvedByRecipient=makeBuckets();
  const collaboration=new Map([...liveness.keys()].map(id=>[id,{
    waitingFor:0,actionRequired:0,repliesAvailable:0,attentionRequired:0
  }]));
  const classify=message=>{
    const sender=liveness.get(message.from),recipient=liveness.get(message.to);
    if(!sender||!recipient)return 'missingEndpoint';
    if(sender===CLOSED||recipient===CLOSED)return 'closedEndpoint';
    return recipient==='RECENT'?'recipientRecent':recipient==='STALE'?'recipientStale':'recipientUnknown';
  };
  let pending=0,unresolved=0,oldestPendingAt=null,oldestUnresolvedAt=null;
  for(const message of messages){
    const isPending=message.status!=='ACKNOWLEDGED';
    const needsReply=message.expectsReply===true&&!message.replyReceivedAt&&!message.resolvedAt;
    if(isPending){
      ++pending;pendingByRecipient[classify(message)]++;
      if(oldestPendingAt==null||String(message.createdAt)<oldestPendingAt)oldestPendingAt=message.createdAt??null;
    }
    if(needsReply){
      ++unresolved;unresolvedByRecipient[classify(message)]++;
      if(oldestUnresolvedAt==null||String(message.createdAt)<oldestUnresolvedAt)oldestUnresolvedAt=message.createdAt??null;
      if(liveness.get(message.from)!==CLOSED){
        const row=collaboration.get(message.from);
        if(row)row.waitingFor++;
      }
      if(liveness.get(message.to)!==CLOSED){
        const row=collaboration.get(message.to);
        if(row){row.actionRequired++;row.attentionRequired++;}
      }
    }
    if(message.to&&message.replyTo!=null&&isPending&&liveness.get(message.to)!==CLOSED){
      const row=collaboration.get(message.to);
      if(row){row.repliesAvailable++;row.attentionRequired++;}
    }
  }
  return{
    schema:'mnemos.frontier-work-triage.v1',
    pending:{total:pending,byRecipient:pendingByRecipient,oldestAt:oldestPendingAt},
    unresolved:{total:unresolved,byRecipient:unresolvedByRecipient,oldestAt:oldestUnresolvedAt},
    requiresHumanReview:pendingByRecipient.recipientStale+pendingByRecipient.recipientUnknown+
      pendingByRecipient.closedEndpoint+pendingByRecipient.missingEndpoint+
      unresolvedByRecipient.recipientStale+unresolvedByRecipient.recipientUnknown+
      unresolvedByRecipient.closedEndpoint+unresolvedByRecipient.missingEndpoint>0,
    mutationPerformed:false,
    collaboration
  };
}
