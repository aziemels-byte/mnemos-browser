import { FrontierSessionBus } from '../../../packages/core/src/controller/frontier-session-bus.mjs';

export class BrowserFrontier {
  constructor({root,store,crypto}) {this.bus=new FrontierSessionBus({runtimeRoot:root});this.store=store;this.crypto=crypto;this.credentials={};}
  async init() {
    await this.bus.init();
    if(!this.crypto.isEncryptionAvailable())throw new Error('OS_SECRET_ENCRYPTION_UNAVAILABLE');
    const saved=this.store.get('frontier.credentials');
    if(saved)this.credentials=JSON.parse(this.crypto.decryptString(Buffer.from(saved,'base64')));
    for(const [sessionId,role] of [['browser-ui','coordinator'],['browser-local-model','specialist']]) {
      const registered=await this.bus.register({sessionId,role,displayName:sessionId==='browser-ui'?'MNEMOS Browser':'Lokālais modelis',capabilities:sessionId==='browser-ui'?['workspace.read']:['chat.local'],verifier:this.credentials[sessionId]});
      if(registered.verifier)this.credentials[sessionId]=registered.verifier;
      // Persist each issued verifier immediately: a crash cannot lose the first session's credential.
      this.store.set('frontier.credentials',this.crypto.encryptString(JSON.stringify(this.credentials)).toString('base64'));
    }
  }
  async publish(turn) {
    const truncated=turn.output.length>15000;
    const body=turn.output.slice(0,15000)+(truncated?`\n\n[Bus preview truncated; full result retained in Browser turn ${turn.id}]`:'');
    const m=await this.bus.send({from:'browser-local-model',to:'browser-ui',body,kind:'result',expectsReply:false,threadId:turn.id,metadata:{turnId:turn.id,model:turn.model,truncated,resultLength:turn.output.length,idempotencyKey:`turn-${turn.id}`},verifier:this.credentials['browser-local-model']});
    await this.bus.acknowledge('browser-ui',m.messageId,{verifier:this.credentials['browser-ui']});
  }
  snapshot() {return {...this.bus.snapshot({compact:true}),scope:'ISOLATED_BROWSER',productionConnected:false};}
}
