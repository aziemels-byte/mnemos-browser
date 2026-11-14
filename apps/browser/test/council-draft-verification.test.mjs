import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {councilDraftEquivalent} from '../src/council-browser-driver.mjs';

test('council accepts only equivalent prose after rich editor reflows whitespace',()=>{
  const expected='MNEMOS Browser · GPT/Gemini/Perplexity īsta iepazīšanās saruna.\n\nTu esi ChatGPT.\n\nAtbildi latviski, dabiski.';
  assert.equal(councilDraftEquivalent(expected,expected),true);
  assert.equal(councilDraftEquivalent(expected.replace(/\n\n/g,'\n'),expected),true);
  assert.equal(councilDraftEquivalent(expected.replaceAll(' ','\u00a0').replaceAll('\n','\r\n'),expected),true);
  assert.equal(councilDraftEquivalent('  '+expected+'\n',expected),true);
  assert.equal(councilDraftEquivalent(expected.replace('ChatGPT','Gemini'),expected),false);
  assert.equal(councilDraftEquivalent(expected.replace('Atbildi latviski, dabiski.',''),expected),false);
  assert.equal(councilDraftEquivalent('',expected),false);
  assert.equal(councilDraftEquivalent(null,expected),false);
  assert.equal(councilDraftEquivalent(expected,undefined),false);
});

test('the real council panel has a scoped full-width layout and wraps status/content',async()=>{
  const path=fileURLToPath(new URL('../ui/pipboy.css',import.meta.url));
  const css=await readFile(path,'utf8');
  assert.match(css,/\.coordination-page\s*>\s*\.handoff-card\s*\{[\s\S]*?flex-direction:column;/);
  assert.match(css,/\.coordination-page\s*>\s*\.handoff-card\s+\.coordination-prompt\s*\{[\s\S]*?width:100%/);
  assert.match(css,/\.coordination-page\s*>\s*\.handoff-card\s+\.coordination-result\s*\{[\s\S]*?grid-template-columns:/);
});
