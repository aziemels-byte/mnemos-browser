import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {performBrowserAction} from '../src/browser-actions.mjs';

function page(text) {
  const url='https://www.perplexity.ai/session/long-conversation';
  const wc={
    isDestroyed:()=>false,
    getURL:()=>url,
    executeJavaScript:async script=>runInNewContext(script,{
      document:{title:'Long AI thread',body:{innerText:text},querySelectorAll:()=>[]},
      location:{origin:'https://www.perplexity.ai',pathname:'/session/long-conversation'}
    })
  };
  return wc;
}
test('AI chat inspection includes newest response even after long conversation',async()=>{
  const beginning='STALE_PREVIOUS_EXCHANGE '.repeat(350);
  const newest='CURRENT_ROUND_PERPLEXITY_ANSWER_AFTER_SUBMIT';
  const result=await performBrowserAction(page(beginning+'\n'+newest),{
    operation:'tab.describe',expectedOrigin:'https://www.perplexity.ai',
    expectedPath:'/session/long-conversation',limit:64
  });
  assert.match(result.text,/CURRENT_ROUND_PERPLEXITY_ANSWER_AFTER_SUBMIT/);
  assert.equal(result.text.length<=4600,true);
  assert.equal(result.text.startsWith('STALE_PREVIOUS_EXCHANGE'),false);
  assert.match(result.note,/latest visible page text/);
  assert.equal(result.fields.length,0);
});
test('short pages retain complete text',async()=>{
  const result=await performBrowserAction(page('First response\nFinal answer'),{
    operation:'tab.describe',expectedOrigin:'https://www.perplexity.ai',limit:8
  });
  assert.equal(result.text,'First response\nFinal answer');
});
