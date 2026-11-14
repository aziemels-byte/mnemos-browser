import {open,rename,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Detect a new install interrupted during its first state commit.
// Do not silently initialize empty state when a potentially durable orphan exists.
export async function assertNoOrphanTempOnFirstBoot(statePath){
  let entries;
  try{entries=await readdir(path.dirname(statePath));}
  catch(error){if(error?.code==='ENOENT')return;throw error;}
  const prefix=path.basename(statePath)+'.';
  if(entries.some(name=>name.startsWith(prefix)&&name.endsWith('.tmp')))
    throw Object.assign(new Error('Orphaned first-write temp state requires operator review'),{code:'STATE_FIRST_BOOT_ORPHAN'});
}

// Single-process atomic state replacement. Writes and flushes the complete
// temp file before publishing it through a same-directory rename.
// Never auto-promote orphan temp files: a crash may have left them incomplete.
// Callers serialize writes and are responsible for validating loaded state.
export async function writeAtomicJsonState(file,state,{beforeRename=null}={}){
  const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle=null,committed=false;
  try{
    handle=await open(temp,'wx',0o600);
    await handle.writeFile(JSON.stringify(state,null,2)+'\n','utf8');
    await handle.sync();
    await handle.close();
    handle=null;
    if(beforeRename)await beforeRename({temp,file});
    await rename(temp,file);
    committed=true;
  }finally{
    if(handle)await handle.close().catch(()=>{});
    if(!committed)await rm(temp,{force:true}).catch(()=>{});
  }
}
