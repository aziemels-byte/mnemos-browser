/**
 * One-shot coordination pipeline:
 * explicit privileged user action -> prepare drafts -> safe preflight -> submit
 * once per provider -> background read-only collection -> durable synthesis.
 * Provider submission is delegated only to the trusted electron implementation.
 */
export class CoordinationExecutor {
  constructor({prepare,submit}={}){
    if(typeof prepare!=='function'||typeof submit!=='function')
      throw new Error('COORDINATION_EXECUTOR_DEPENDENCY_INVALID');
    this.prepare=prepare;this.submit=submit;this.active=new Set();
  }
  async execute(project,input){
    if(typeof project!=='string'||!project||!input||typeof input!=='object')
      throw new Error('COORDINATION_EXECUTION_INPUT_INVALID');
    if(this.active.has(project))throw new Error('COORDINATION_EXECUTION_ALREADY_RUNNING');
    this.active.add(project);
    let preparation=null;
    try{
      preparation=await this.prepare(input);
      if(!preparation||preparation.project!==project||!preparation.runId)
        throw new Error('COORDINATION_PREPARATION_RECEIPT_INVALID');
      const complete=preparation.attempted>=1&&
        preparation.prepared===preparation.attempted;
      if(!complete)return {project,runId:preparation.runId,
        status:'PREPARATION_INCOMPLETE',submitted:false,monitorScheduled:false,
        prepared:preparation.prepared,attempted:preparation.attempted,
        results:preparation.results||[]};
      // The Electron submit implementation validates every draft, records durable
      // intent BEFORE clicks, prevents retries and schedules read-only collection.
      const delivery=await this.submit({runId:preparation.runId});
      if(!delivery||delivery.runId!==preparation.runId)
        throw new Error('COORDINATION_SUBMISSION_RECEIPT_INVALID');
      return {project,runId:preparation.runId,
        status:delivery.triggered===delivery.attempted?'COLLECTION_SCHEDULED':'SUBMISSION_PARTIAL',
        submitted:delivery.triggered>0,
        monitorScheduled:delivery.automaticCollectionScheduled===true,
        prepared:preparation.prepared,attempted:delivery.attempted,
        triggered:delivery.triggered,results:delivery.results||[]};
    }finally{this.active.delete(project);}
  }
}
