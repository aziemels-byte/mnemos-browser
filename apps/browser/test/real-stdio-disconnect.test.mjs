import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','src','main.mjs');
test('actual Node child survives inherited stderr pipe being closed by parent (real EPIPE)',{timeout:16000},async()=>{
 const src=await readFile(source,'utf8');
 const start=src.indexOf('const brokenStdio=new Set();');
 const end=src.indexOf("process.on('uncaughtExceptionMonitor'");
 assert.ok(start>0&&end>start);
 const guard=src.slice(start,end);
 const childScript=[
 "const events=[];",
 "function logRuntimeFault(kind,error,context){events.push({kind,code:error?.code||'',context});}",
 guard,
 "process.stdout.write('READY\\n');",
 "setTimeout(()=>{",
 " for(let i=0;i<250;i++)console.error('EXPECTED_REAL_BROKEN_STDERR_WRITE_'+i);",
 " setTimeout(()=>{",
 "  const result={broken:brokenStdio.has('stderr'),errors:events.filter(e=>e.kind==='stdio-pipe-disconnected').length,after:events.length};",
 "  process.stdout.write('RESULT '+JSON.stringify(result)+'\\n');",
 "  process.exit(0);",
 " },350);",
 "},110);"
 ].join('\n');
 const proc=spawn(process.execPath,['-e',childScript],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let out='',cut=false,err='';
 proc.stdout.setEncoding('utf8');
 proc.stdout.on('data',chunk=>{out+=chunk;if(!cut&&out.includes('READY\n')){cut=true;proc.stderr.destroy();}});
 proc.stderr.setEncoding('utf8');
 proc.stderr.on('data',chunk=>{err+=chunk;});
 const result=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{proc.kill();reject(new Error('CHILD_HUNG_WITH_DISCONNECTED_STDERR'));},12000);
  proc.on('error',reject);
  proc.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
 });
 assert.equal(result.code,0,'child process must not crash on EPIPE: '+err.slice(-700));
 assert.equal(cut,true,'test must actually close stderr');
 const m=out.match(/RESULT (\{[^\n]+\})/);
 assert.ok(m,'no child result '+out.slice(-500));
 const data=JSON.parse(m[1]);
 assert.equal(data.broken,true,'stderr should enter disconnected state');
 assert.ok(data.errors>=1,'real EPIPE must trigger handler, not just a synthetic event');
 console.log('REAL_CLOSED_STDERR_VERIFIED',JSON.stringify(data));
});
