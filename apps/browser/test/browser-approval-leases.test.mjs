import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserApprovalLeases,LEASE_DURATION_MS} from '../src/browser-approval-leases.mjs';

const base={sender:'chatgpt-mnemos-browser-owner-20261110',
  tab:{id:'a-tab',url:'https://gemini.google.com/app/conversation-1',private:false}};
const req=(operation,extra={})=>({...base,operation,...extra});

test('No implicit grants; one 15-minute consent groups read operations, but not drafts',()=>{
  let now=10_000;
  const p=new BrowserApprovalLeases({now:()=>now});
  assert.equal(p.allowed(req('tab.inspect')),false);
  assert.equal(p.allowForSession(req('tab.inspect')),true);
  assert.equal(p.allowed(req('tab.inspect')),true);
  assert.equal(p.allowed(req('tab.describe')),true);
  assert.equal(p.allowed(req('tab.fill')),false);
  now+=LEASE_DURATION_MS-1;
  assert.equal(p.allowed(req('tab.describe')),true);
  now++;
  assert.equal(p.allowed(req('tab.inspect')),false);
  assert.equal(p.snapshot().active,0);
});
test('A separate draft grant never authorizes submitting or clicking',()=>{
  const p=new BrowserApprovalLeases();
  assert.equal(p.allowForSession(req('tab.fill')),true);
  assert.equal(p.allowed(req('tab.fill')),true);
  for(const operation of ['tab.submit','tab.click','tab.attach','tab.choose','tab.toggle','tab.open','tab.select'])
    assert.equal(p.allowed(req(operation)),false,operation);
  assert.equal(p.allowed(req('tab.inspect')),false);
});
test('Leases are bound to exact requester, tab, page path, host and HTTPS',()=>{
  const p=new BrowserApprovalLeases();
  p.allowForSession(req('tab.inspect'));
  assert.equal(p.allowed(req('tab.describe',{sender:'mnemos-perplexity-browser-gateway-20261111'})),false);
  assert.equal(p.allowed(req('tab.inspect',{tab:{...base.tab,id:'different-tab'}})),false);
  assert.equal(p.allowed(req('tab.inspect',{tab:{...base.tab,url:'https://gemini.google.com/app/other-conversation'}})),false);
  assert.equal(p.allowed(req('tab.inspect',{tab:{...base.tab,url:'https://www.perplexity.ai/app/conversation-1'}})),false);
  assert.equal(p.allowed(req('tab.inspect',{tab:{...base.tab,url:'https://gemini.google.com/app/conversation-1?some=private#frag'}})),true);
  assert.equal(p.allowed(req('tab.inspect',{tab:{...base.tab,private:true}})),false);
  for(const url of ['http://gemini.google.com/app/conversation-1',
    'https://gemini.google.com.evil.example/app/conversation-1',
    'https://account.example.org/private', 'https://gemini.google.com:8080/app/conversation-1'])
    assert.equal(p.allowForSession(req('tab.inspect',{tab:{...base.tab,url}})),false,url);
});
test('Revocation immediately clears grants and a separate instance has none',()=>{
  const p=new BrowserApprovalLeases();
  p.allowForSession(req('tab.fill'));p.allowForSession(req('tab.inspect'));
  assert.equal(p.snapshot().active,2);
  assert.deepEqual(p.clear(),{active:0,minutes:15,persisted:false});
  assert.equal(p.allowed(req('tab.fill')),false);
  assert.equal(new BrowserApprovalLeases().allowed(req('tab.inspect')),false);
});
