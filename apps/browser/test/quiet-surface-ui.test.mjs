import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const read=name=>readFileSync(path.resolve(here,'..',name),'utf8');

function balancedCSS(source){
 let depth=0,comment=false,quote=null;
 for(let i=0;i<source.length;i++){
  const c=source[i],n=source[i+1];
  if(comment){if(c==='*'&&n==='/'){comment=false;i++;}continue;}
  if(quote){if(c==='\\'){i++;continue;}if(c===quote)quote=null;continue;}
  if(c==='/'&&n==='*'){comment=true;i++;continue;}
  if(c==='"'||c==="'"){quote=c;continue;}
  if(c==='{')depth++;
  else if(c==='}'){depth--;assert.ok(depth>=0,'Unbalanced closing brace at '+i);}
 }
 assert.equal(depth,0);assert.equal(comment,false);assert.equal(quote,null);
}

test('Previously rejected Quiet Surface is not loaded, original Atomic Age remains authoritative',()=>{
 const index=read('ui/index.html'),css=read('ui/pipboy.css');
 assert.doesNotMatch(index,/href="quiet-surface.css"|src="reactbits-animated-list.js"|href="reactbits.css"/);
 assert.match(index,/<link rel="stylesheet" href="pipboy\.css">/);
 assert.match(index,/<link rel="stylesheet" href="provider-avatars\.css">/);
 assert.match(index,/<script src="provider-avatars\.js"><\/script>/);
 assert.match(css,/--accent:#e6e6e6/);
 assert.match(css,/bot-wave-arm/);
});
test('Collaborating characters remain part of the existing native workflow, not a separate AI dashboard',()=>{
 const shell=read('ui/shell.js'),avatars=read('ui/provider-avatars.js');
 assert.match(shell,/const panel=element\('section','coordination-page'\)/);
 assert.match(shell,/const ensemble=element\('section','persona-ensemble'\)/);
 assert.match(shell,/append\(member,figure,element\('strong','persona-name',name\)/);
 assert.match(shell,/council:state\.section==='coordination'\?state\.council:null/);
 assert.match(shell,/window\.MNEMOSProviderAvatars\?\.refresh\(document,next\)/);
 assert.match(avatars,/function activeSpeaker\(state\)/);
 assert.match(avatars,/function stageBody\(svg,id\)/);
 assert.doesNotMatch(avatars,/fetch\s*\(|XMLHttpRequest/);
});
test('Persona stylesheet is syntactically balanced, monochrome and accessible in reduced-motion mode',()=>{
 const css=read('ui/provider-avatars.css');
 balancedCSS(css);
 assert.match(css,/\.persona-lineup/);
 assert.match(css,/\.model-avatar-stage/);
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
 assert.doesNotMatch(css,/background:\s*(?:linear-gradient|radial-gradient)|box-shadow|drop-shadow|--accent:/);
});
