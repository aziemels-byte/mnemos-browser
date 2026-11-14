import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','src','main.mjs');
async function harness(){
 const main=await readFile(source,'utf8');
 const head='const brokenStdio=new Set();';
 const tail="process.on('uncaughtExceptionMonitor'";
 const begin=main.indexOf(head),end=main.indexOf(tail);
 assert.ok(begin>0&&end>begin,'test exact production guard, no duplicate mock implementation');
 const guards=main.slice(begin,end);
 const stderr=new EventEmitter(),stdout=new EventEmitter(),record=[],writes=[];
 const fakeConsole={
  error(...a){writes.push(['error',...a])},
  warn(...a){writes.push(['warn',...a])},
  log(...a){writes.push(['log',...a])},
  info(...a){writes.push(['info',...a])}
 };
 const context={process:{stderr,stdout},console:fakeConsole,logRuntimeFault:(...args)=>record.push(args),URL,Error,Set};
 vm.runInNewContext(guards+'\nglobalThis.guard={brokenStdio,isConsolePipeError};',context,{filename:'production-main-stdio-guard.js'});
 return {stderr,stdout,record,writes,console:fakeConsole,...context.guard};
}
test('detached Windows stderr EPIPE is handled, later console.error suppressed, other UI unaffected',async()=>{
 const h=await harness();
 h.console.error('first write works');
 assert.equal(h.writes.length,1);
 const broken=Object.assign(new Error('write EPIPE'),{code:'EPIPE'});
 h.stderr.emit('error',broken);
 assert.equal(h.brokenStdio.has('stderr'),true);
 h.console.error('This would generate the Electron JS error dialog');
 h.console.warn('Another disconnected stderr attempt');
 assert.equal(h.writes.length,1,'no writes after broken pipe');
 assert.ok(h.record.some(v=>v[0]==='stdio-pipe-disconnected'&&v[2]==='stderr'));
 h.console.log('stdout is still alive');
 assert.equal(h.writes.length,2);
});
test('detached stdout EPIPE isolated from stderr and repeated writes',async()=>{
 const h=await harness();
 h.stdout.emit('error',Object.assign(new Error('write EPIPE'),{code:'EPIPE'}));
 h.console.log('suppressed');h.console.info('suppressed');
 h.console.error('stderr healthy');
 assert.deepEqual(h.writes.map(v=>v[0]),['error']);
 assert.equal(h.brokenStdio.has('stdout'),true);
 assert.equal(h.brokenStdio.has('stderr'),false);
});
test('only console/internal-stream EPIPE is recoverable; unrelated application exceptions remain fatal',async()=>{
 const h=await harness();
 const streamErr=Object.assign(new Error('broken pipe'),{code:'EPIPE'});
 streamErr.stack='Error: write EPIPE\n at console.error (node:internal/console/constructor:441:26)';
 assert.equal(h.isConsolePipeError(streamErr),true);
 const appErr=Object.assign(new Error('network socket unexpectedly closed'),{code:'EPIPE'});
 appErr.stack='Error: EPIPE\n at internal-api-client.mjs:25:11';
 assert.equal(h.isConsolePipeError(appErr),false);
 assert.equal(h.isConsolePipeError(new Error('bad data')),false);
});
