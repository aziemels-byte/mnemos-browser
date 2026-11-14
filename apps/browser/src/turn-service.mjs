export class TurnService {
  constructor({store,adapter,guard=()=>true,onChange=()=>{},publish=async()=>{}}) {Object.assign(this,{store,adapter,guard,onChange,publish});this.active=new Map();}
  async submit(input) {
    if(!this.guard())throw new Error('RESOURCE_PRESSURE: Resursu pārbaude neatļauj jauna modeļa ielādi');
    const started=this.store.beginTurn(input);
    if(started.replay)return started;
    if(this.active.size) {this.store.updateTurn(started.turn.id,{status:'REJECTED',output:'',reason:'Jau darbojas viens lokāls pieprasījums'});this.onChange();throw new Error('LOCAL_CONCURRENCY_LIMIT');}
    const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
    this.active.set(started.turn.id,controller);
    this.store.updateTurn(started.turn.id,{status:'RUNNING',output:''});this.onChange();
    void this.execute(started.turn,signal).finally(()=>this.active.delete(started.turn.id));
    return {turn:this.store.turn(started.turn.id),replay:false};
  }
  async execute(turn,signal) {
    let output='';
    try {
      output=await this.adapter.run({model:turn.model,prompt:turn.prompt,context:JSON.parse(turn.context_json??'[]'),signal,onDelta:async value=>{output=value;this.store.updateTurn(turn.id,{status:'RUNNING',output});this.onChange();}});
      signal.throwIfAborted();
      const completed=this.store.completeTurn(turn.id,output);
      await this.deliver(completed);
    } catch(error) {
      const cancelled=signal.aborted;
      this.store.updateTurn(turn.id,{status:cancelled?(signal.reason?.name==='TimeoutError'?'TIMED_OUT':'CANCELLED'):'FAILED',output,reason:cancelled?'Pieprasījums pārtraukts':String(error.message).slice(0,300)});
    } finally {this.onChange();}
  }
  cancel(id) { this.active.get(id)?.abort(new DOMException('User cancelled','AbortError')); }
  async deliver(turn){try{await this.publish(turn);this.store.delivery(turn.id);this.store.event('frontier.result',{turn:turn.id,status:'DELIVERED'});}catch(error){this.store.delivery(turn.id,String(error.message).slice(0,200));this.store.event('frontier.result',{turn:turn.id,status:'DELIVERY_FAILED'});}}
  async flushOutbox(){for(const turn of this.store.pendingDeliveries())await this.deliver(turn);}
  async close() {for(const c of this.active.values())c.abort(); while(this.active.size)await new Promise(r=>setTimeout(r,15));}
}
