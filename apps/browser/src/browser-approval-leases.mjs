/**
 * Temporary, explicitly granted browser-action leases.
 * Never persisted. A lease belongs to one sender, one browser tab and one exact HTTPS
 * page; reading and draft insertion are separate scopes. Submission, clicking,
 * uploads, choices, navigation and all other operations always need fresh approval.
 */
const SAFE_HOSTS=new Set(['chatgpt.com','gemini.google.com','www.perplexity.ai','perplexity.ai','claude.ai']);
const GROUP=new Map([['tab.inspect','read'],['tab.describe','read'],['tab.fill','draft']]);
export const LEASE_DURATION_MS=15*60*1000;

export class BrowserApprovalLeases {
  constructor({now=()=>Date.now(),durationMs=LEASE_DURATION_MS}={}) {
    this.now=now;
    this.durationMs=durationMs;
    this.grants=new Map();
  }
  scope({operation,tab,sender}={}) {
    const group=GROUP.get(operation);
    if(!group||tab?.private||typeof sender!=='string'||!sender||
       typeof tab?.id!=='string'||!tab.id)return null;
    try {
      const u=new URL(tab.url);
      if(u.protocol!=='https:'||!SAFE_HOSTS.has(u.hostname)||
         u.username||u.password||u.port&&u.port!=='443')return null;
      // The URL's query and fragment are never logged or retained in the lease key.
      return JSON.stringify([sender,tab.id,u.origin,u.pathname,group]);
    }catch{return null;}
  }
  allowed(request) {
    const key=this.scope(request);
    if(!key)return false;
    const expiresAt=this.grants.get(key);
    if(!Number.isFinite(expiresAt))return false;
    if(this.now()>=expiresAt){this.grants.delete(key);return false;}
    return true;
  }
  allowForSession(request) {
    const key=this.scope(request);
    if(!key)return false;
    this.grants.set(key,this.now()+this.durationMs);
    return true;
  }
  snapshot(){
    const now=this.now();
    for(const [key,expiresAt] of this.grants)if(now>=expiresAt)this.grants.delete(key);
    return {active:this.grants.size,minutes:Math.round(this.durationMs/60000),persisted:false};
  }
  clear(){this.grants.clear();return this.snapshot();}
}
