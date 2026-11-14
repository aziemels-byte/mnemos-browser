import test from 'node:test';
import assert from 'node:assert/strict';
import {CouncilConversation} from '../src/council-conversation.mjs';

test('restored read-only recovery remains retryable without any automatic send',async()=>{
  const map=new Map();
  const store={
    get:(key,fallback)=>structuredClone(map.has(key)?map.get(key):fallback),
    set:(key,value)=>map.set(key,structuredClone(value))
  };
  const targets=[
    {id:'11111111-1111-4111-8111-111111111111',model:'Perplexity',
      origin:'https://www.perplexity.ai'},
    {id:'22222222-2222-4222-8222-222222222222',model:'Gemini',
      origin:'https://gemini.google.com'}
  ];
  let sends=0;
  const running=new CouncilConversation({store,
    send:async()=>{sends++;return {triggered:true,editorCleared:false};},
    capture:async()=>assert.fail('No capture after uncertain send')
  });
  running.start({project:'mnemos',targets,seed:'Iepazīšanās',maxTurns:2});
  for(let attempt=0;attempt<100&&running.summary('mnemos').status==='RUNNING';attempt++)
    await new Promise(resolve=>setTimeout(resolve,3));
  assert.equal(running.summary('mnemos').status,'SEND_UNCERTAIN_NO_RETRY');
  const key=['council','conversations','v1','mnemos'].join('.');
  const rows=store.get(key,[]);
  rows[0].status='RECONCILING';
  rows[0].turns[0].status='RECONCILING';
  store.set(key,rows);
  const reopened=new CouncilConversation({store,
    send:async()=>assert.fail('Startup must never automatically resend'),
    capture:async()=>assert.fail('Startup must never automatically inspect')
  });
  assert.deepEqual(reopened.recover('mnemos'),{interrupted:true});
  assert.equal(reopened.summary('mnemos').status,'SEND_UNCERTAIN_NO_RETRY');
  assert.equal(reopened.summary('mnemos').turns[0].status,'SEND_UNCERTAIN_NO_RETRY');
  assert.equal(sends,1);
});
