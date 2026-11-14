import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPerplexityHandoff, perplexityAllowedUrl, focusEmptyPerplexityComposer } from '../src/perplexity-handoff.mjs';

test('only canonical Perplexity HTTPS origins pass',()=>{
  for(const url of ['https://www.perplexity.ai/session/abc','https://perplexity.ai/'])
    assert.equal(perplexityAllowedUrl(url),true,url);
  for(const url of ['http://www.perplexity.ai','https://perplexity.ai.evil.test/',
    'https://attacker@perplexity.ai/','javascript:alert(1)','file:///etc/passwd',
    'https://127.0.0.1:4320/','https://www.perplexity.ai:444/'])
    assert.equal(perplexityAllowedUrl(url),false,url);
  assert.equal(perplexityAllowedUrl('http://127.0.0.1:5000/handoff-fixture','http://127.0.0.1:5000'),true);
  assert.equal(perplexityAllowedUrl('http://127.0.0.1:5000/other','http://127.0.0.1:5000'),false);
});

test('handoff describes MNEMOS accurately and excludes stored memory and credentials',()=>{
  const message=buildPerplexityHandoff({
    projectId:'p1',
    workspace:{projects:[{id:'p1',name:'MNEMOS Browser'},{id:'p2',name:'PRIVATE PROJECT'}],
      items:[{project:'p1',kind:'task',title:'Savienot Perplexity',status:'OPEN'},
        {project:'p1',kind:'memory',title:'PRIVATE_ACCOUNT_SECRET_abcdef',status:'SAVED'},
        {project:'p2',kind:'task',title:'OTHER_PROJECT_SECRET_123',status:'OPEN'}]},
    core:{online:true,capturedAt:'2026-11-10T20:00:00.000Z',service:{version:'2.0.0'},
      goals:[{title:'Core goal',status:'ACTIVE'}],tasks:[],bus:{activeSessions:3}},
    at:'2026-11-10T20:01:00.000Z'
  });
  assert.ok(message.includes('MNEMOS'));
  assert.ok(message.includes('Savienot Perplexity'));
  assert.ok(message.includes('Core goal'));
  assert.ok(message.includes('"memoryRecordsNotShared":1'));
  assert.ok(message.includes('NOT a live MCP/API connection'));
  assert.ok(!message.includes('PRIVATE_ACCOUNT_SECRET'));
  assert.ok(!message.includes('OTHER_PROJECT_SECRET'));
  assert.ok(!message.includes('PRIVATE PROJECT'));
  assert.ok(!message.includes('password'));
  assert.ok(message.length<4500);
  assert.ok(focusEmptyPerplexityComposer.includes('PERPLEXITY_DRAFT_NOT_EMPTY'));
  assert.ok(!focusEmptyPerplexityComposer.includes('submit()'));
});
test('offline Core is explicitly marked and no invented live tools',()=>{
  const message=buildPerplexityHandoff({
    projectId:'p1',
    workspace:{projects:[{id:'p1',name:'MNEMOS'}],items:[]},
    core:{online:false},
  });
  assert.ok(message.includes('unavailable at snapshot time'));
  assert.ok(!message.includes('reachable'));
});
