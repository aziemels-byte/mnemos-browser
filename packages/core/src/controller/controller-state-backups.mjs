import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,readdir,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {writeAtomicJsonState} from './atomic-state-file.mjs';
import {validateFrontierState,validateContinuationState} from './persisted-controller-state-validation.mjs';

const TYPES={
  frontier:{filename:'state.json',validate:validateFrontierState},
  continuation:{filename:'goals.json',validate:validateContinuationState}
};
const ID=/^[0-9]{8}T[0-9]{6}[0-9]{3}Z-[a-f0-9-]{36}\.json$/;
const sha=raw=>createHash('sha256').update(raw,'utf8').digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const safeType=type=>{
  const kind=TYPES[type];
  if(!kind)throw fail('BACKUP_INVALID_TYPE','Unsupported controller backup type');
  return kind;
};

export async function verifyControllerBackup({backupRoot,controller,id}){
  const spec=safeType(controller);
  if(typeof id!=='string'||!ID.test(id))throw fail('BACKUP_INVALID_ID','Invalid backup ID');
  const file=path.join(backupRoot,controller,id);
  const record=JSON.parse(await readFile(file,'utf8'));
  if(!record||record.schema!=='mnemos.controller-backup.v1'||record.controller!==controller||
     record.sourceFile!==spec.filename||typeof record.raw!=='string'||
     typeof record.sha256!=='string'||!/^[0-9a-f]{64}$/.test(record.sha256)||
     !Number.isSafeInteger(record.sizeBytes))
    throw fail('BACKUP_INVALID','Backup manifest format mismatch');
  if(Buffer.byteLength(record.raw,'utf8')!==record.sizeBytes||
     sha(record.raw)!==record.sha256)
    throw fail('BACKUP_CHECKSUM_MISMATCH','Backup content checksum mismatch');
  spec.validate(JSON.parse(record.raw));
  return {id,controller,sourceFile:spec.filename,sha256:record.sha256,
    sizeBytes:record.sizeBytes,createdAt:record.createdAt,raw:record.raw};
}

// Recovery is staging-only. Never overwrite live state or auto-promote a backup.
export async function stageVerifiedControllerRestore({backupRoot,controller,id,stagingRoot}){
  if(!stagingRoot||!path.isAbsolute(stagingRoot))
    throw fail('RESTORE_STAGING_REQUIRED','An absolute isolated stagingRoot is required');
  const verified=await verifyControllerBackup({backupRoot,controller,id});
  const isolated=path.resolve(stagingRoot);
  if(isolated===path.resolve(backupRoot)||isolated.startsWith(path.resolve(backupRoot)+path.sep))
    throw fail('RESTORE_STAGING_UNSAFE','Staging must be separate from backup root');
  await mkdir(isolated,{recursive:true});
  const target=path.join(isolated,controller+'-restore-'+randomUUID()+'.json');
  let handle=null,completed=false;
  try{
    handle=await open(target,'wx',0o600);
    await handle.writeFile(verified.raw,'utf8');
    await handle.sync();
    await handle.close();handle=null;
    const actual=await readFile(target,'utf8');
    if(sha(actual)!==verified.sha256)throw fail('RESTORE_STAGING_MISMATCH','Staged bytes do not match verified source');
    completed=true;
    return {stagedPath:target,sha256:verified.sha256,controller,
      sizeBytes:verified.sizeBytes,sourceBackupId:id,liveStateUntouched:true};
  }finally{
    if(handle)await handle.close().catch(()=>{});
    if(!completed)await rm(target,{force:true}).catch(()=>{});
  }
}

export class ControllerStateBackups {
  constructor({runtimeRoot,controller,clock=()=>Date.now(),intervalMs=15*60_000,keep=24,backupRoot=null}={}){
    safeType(controller);
    if(!runtimeRoot)throw fail('BACKUP_RUNTIME_REQUIRED','runtimeRoot is required');
    this.controller=controller;
    this.backupRoot=backupRoot??path.join(runtimeRoot,'controller-backups');
    this.clock=clock;this.intervalMs=Math.max(60_000,Number(intervalMs)||15*60_000);
    this.keep=Math.max(2,Math.min(120,Number(keep)||24));
    this.lastVerifiedAt=null;this.lastBackupAt=null;this.lastSha256=null;
    this.fault=null;
  }
  summary(){return {healthy:!this.fault,lastVerifiedAt:this.lastVerifiedAt,
    lastSha256:this.lastSha256,intervalMs:this.intervalMs,
    retention:this.keep,faultCode:this.fault?.code??null};}
  async checkpoint(statePath,{force=false}={}){
    const now=this.clock();
    if(!force&&this.lastBackupAt!==null&&now-this.lastBackupAt<this.intervalMs)return null;
    const spec=safeType(this.controller);
    if(path.basename(statePath)!==spec.filename)
      throw fail('BACKUP_SOURCE_INVALID','Unexpected canonical filename');
    try{
      const raw=await readFile(statePath,'utf8');
      const bytes=Buffer.byteLength(raw,'utf8');
      if(bytes>16*1024*1024)throw fail('BACKUP_TOO_LARGE','State exceeds 16 MiB checkpoint limit');
      spec.validate(JSON.parse(raw));
      const digest=sha(raw);
      await mkdir(path.join(this.backupRoot,this.controller),{recursive:true});
      const id=new Date(now).toISOString().replace(/[-:.]/g,'')+'-'+randomUUID()+'.json';
      const backupFile=path.join(this.backupRoot,this.controller,id);
      await writeAtomicJsonState(backupFile,{schema:'mnemos.controller-backup.v1',
        controller:this.controller,sourceFile:spec.filename,createdAt:new Date(now).toISOString(),
        sizeBytes:bytes,sha256:digest,raw});
      const checked=await verifyControllerBackup({backupRoot:this.backupRoot,controller:this.controller,id});
      this.lastSha256=checked.sha256;this.lastVerifiedAt=new Date(now).toISOString();
      this.lastBackupAt=now;this.fault=null;
      await this.pruneVerified();
      return {id,sha256:digest,sizeBytes:bytes};
    }catch(error){
      this.fault=error;
      throw error;
    }
  }
  async pruneVerified(){
    const folder=path.join(this.backupRoot,this.controller);
    const ids=(await readdir(folder)).filter(name=>ID.test(name)).sort().reverse();
    for(const id of ids.slice(this.keep)){
      // Never silently remove unreadable/tampered backup evidence.
      try{await verifyControllerBackup({backupRoot:this.backupRoot,controller:this.controller,id});}
      catch{continue;}
      await rm(path.join(folder,id),{force:false});
    }
  }
  async inventory(){
    const folder=path.join(this.backupRoot,this.controller);
    let ids;
    try{ids=(await readdir(folder)).filter(name=>ID.test(name)).sort().reverse();}
    catch(error){if(error?.code==='ENOENT')return[];throw error;}
    const output=[];
    for(const id of ids){
      try{const r=await verifyControllerBackup({backupRoot:this.backupRoot,controller:this.controller,id});
        output.push({id,valid:true,sha256:r.sha256,sizeBytes:r.sizeBytes,createdAt:r.createdAt});}
      catch(error){output.push({id,valid:false,reason:error.code??'UNREADABLE'});}
    }
    return output;
  }
}
