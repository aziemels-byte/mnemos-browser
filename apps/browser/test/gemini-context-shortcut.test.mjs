import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const shell=readFileSync(new URL('../ui/shell.js',import.meta.url),'utf8');
const start=shell.indexOf('function ensureCoordinationProject(){');
const end=shell.indexOf('\nfunction geminiMcpCard(){',start);
assert.ok(start>=0&&end>start,'Gemini integration shortcut exists');
const helper=shell.slice(start,end);
function run({tabs,activeId='home',activeProject='mnemos'}){
  const selection=new Set(['previous']),calls=[],errors=[];
  const context={state:{tabs,activeId,activeProject},URL,coordinationTabIds:selection,
    coordinationProject:null,coordinationMemoryIds:new Set(['old-project-memory']),
    showError:value=>errors.push(value),invoke:(name,args)=>{calls.push([name,JSON.parse(JSON.stringify(args))]);return Promise.resolve(true);}};
  runInNewContext(helper+'\nopenGeminiCoordination()',context,{timeout:1000});
  return {selection:[...selection],calls,errors,coordinationProject:context.coordinationProject,
    memories:[...context.coordinationMemoryIds]};
}
const base={id:'g1',url:'https://gemini.google.com/app/thread-1',
  project:'mnemos',private:false,loading:false};
test('Gemini in the active project opens real MNEMOS coordination with its tab selected',()=>{
  const outcome=run({tabs:[base]});
  assert.deepEqual(outcome.selection,['g1']);
  assert.deepEqual(outcome.calls,[['section',{name:'coordination'}]]);
  assert.deepEqual(outcome.errors,[]);
  assert.equal(outcome.coordinationProject,'mnemos');
  assert.deepEqual(outcome.memories,[]);
});
test('active Gemini tab is preferred over another eligible tab',()=>{
  assert.deepEqual(run({tabs:[base,{...base,id:'g2'}],activeId:'g2'}).selection,['g2']);
});
test('private, loading, wrong-project and impostor origin tabs are never exposed',()=>{
  const forbidden=[
    {...base,private:true},{...base,loading:true},{...base,project:'other'},
    {...base,url:'https://gemini.google.com.evil.example/app/1'},
    {...base,url:'https://gemini.google.com/customize/connectors'},
    {...base,url:'http://gemini.google.com/app/1'}
  ];
  const outcome=run({tabs:forbidden});
  assert.deepEqual(outcome.selection,['previous']);
  assert.equal(outcome.calls.length,0);
  assert.equal(outcome.errors.length,1);
});
