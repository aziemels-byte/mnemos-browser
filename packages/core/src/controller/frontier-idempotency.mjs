import { createHash } from 'node:crypto';

const KEY_PATTERN=/^[a-z0-9][a-z0-9._:-]{7,127}$/i;
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const canonical=value=>{
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(
    Object.keys(value).sort().map(key=>[key,canonical(value[key])])
  );
  return value;
};

// Backward compatible wire path: metadata.idempotencyKey is supported even by
// ChatGPT clients whose cached tool schema has no top-level idempotencyKey.
export function frontierIdempotencyReceipt({sender,to,body,threadId,kind,replyTo,expectsReply,metadata}){
  if(metadata==null||typeof metadata!=='object'||Array.isArray(metadata)||
     !Object.hasOwn(metadata,'idempotencyKey'))return null;
  const key=metadata.idempotencyKey;
  if(typeof key!=='string'||!KEY_PATTERN.test(key))
    throw Object.assign(new Error('Invalid frontier idempotency key (8-128 safe characters)'),{code:'FRONTIER_IDEMPOTENCY_KEY_INVALID'});
  const otherMetadata={...metadata};
  delete otherMetadata.idempotencyKey;
  const request={sender,to,body,threadId,kind,replyTo,expectsReply,metadata:otherMetadata};
  return {
    keyHash:hash(sender+'\0'+key),
    requestHash:hash(JSON.stringify(canonical(request)))
  };
}

export function deduplicateFrontierMessage(messages,receipt){
  if(!receipt)return null;
  const previous=messages.find(item=>item.idempotency?.keyHash===receipt.keyHash);
  if(!previous)return null;
  if(previous.idempotency.requestHash!==receipt.requestHash)
    throw Object.assign(new Error('Frontier idempotency key reused with a different request'),
      {code:'FRONTIER_IDEMPOTENCY_CONFLICT'});
  return structuredClone(previous);
}
