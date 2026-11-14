// Fail closed when a syntactically valid but incomplete state file would
// otherwise be misread as an empty state and overwritten on the next write.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(value);
const hex64=value=>typeof value==='string'&&/^[0-9a-f]{64}$/i.test(value);
const invalid=(name,reason)=>{throw Object.assign(new Error(name+': '+reason),{code:'PERSISTED_STATE_INVALID'});};
const uniqueKeys=(records,key,name)=>{
  const seen=new Set();
  for(const record of records){
    const value=record[key];
    if(seen.has(value))invalid(name,'duplicate '+key);
    seen.add(value);
  }
};
export function validateFrontierState(state){
  const name='frontier-state';
  if(!object(state)||!['mnemos.frontier-session-bus.v1','mnemos.frontier-session-bus.v2'].includes(state.schema))
    invalid(name,'unsupported schema');
  if(!Array.isArray(state.sessions)||!Array.isArray(state.messages))
    invalid(name,'missing sessions or messages array');
  if(state.idempotencyReceipts!==undefined&&!Array.isArray(state.idempotencyReceipts))
    invalid(name,'malformed idempotency receipt ledger');
  for(const session of state.sessions){
    if(!object(session)||!validId(session.sessionId)||!['ONLINE','CLOSED'].includes(session.status))
      invalid(name,'malformed session');
  }
  uniqueKeys(state.sessions,'sessionId',name);
  for(const message of state.messages){
    if(!object(message)||!validId(message.messageId)||!validId(message.threadId)||
       !validId(message.from)||!validId(message.to)||
       !['PENDING','DELIVERED','ACKNOWLEDGED'].includes(message.status))
      invalid(name,'malformed message');
  }
  uniqueKeys(state.messages,'messageId',name);
  const receipts=state.idempotencyReceipts??[];
  if(receipts.length>20000)invalid(name,'idempotency ledger exceeds durable limit');
  for(const receipt of receipts){
    if(!object(receipt)||!hex64(receipt.keyHash)||!hex64(receipt.requestHash)||
       !validId(receipt.messageId)||!validId(receipt.threadId))
      invalid(name,'malformed idempotency receipt');
  }
  uniqueKeys(receipts,'keyHash',name);
  return state;
}
export function validateContinuationState(state){
  const name='continuation-state';
  if(!object(state)||state.schema!=='mnemos.continuation-state.v1')
    invalid(name,'unsupported schema');
  if(!Array.isArray(state.goals))invalid(name,'missing goals array');
  for(const goal of state.goals){
    if(!object(goal)||!validId(goal.goalId)||typeof goal.objective!=='string'||!goal.objective.trim()||
      typeof goal.status!=='string'||!goal.status)
      invalid(name,'malformed goal');
  }
  uniqueKeys(state.goals,'goalId',name);
  return state;
}
