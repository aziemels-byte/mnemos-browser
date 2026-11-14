// The URL and routes are main-process constants, never renderer-supplied.
const ROUTES = ['/api/health','/api/cockpit/snapshot','/api/owner-goals'];
const OBSERVATIONS_ROUTE = '/api/memory/browser-observations';
export class CoreClient {
  constructor({base='http://127.0.0.1:4320', fetchImpl=fetch}={}) { const u=new URL(base); if(u.protocol!=='http:' || u.hostname!=='127.0.0.1' || u.username || u.password) throw new Error('CORE_LOOPBACK_ONLY'); this.base=u.origin; this.fetch=fetchImpl; this.last=null; }
  async read(route) { if(!ROUTES.includes(route)) throw new Error('CORE_ROUTE_DENIED'); const r=await this.fetch(this.base+route,{redirect:'error',signal:AbortSignal.timeout(7000)}); if(!r.ok) throw new Error(`Core HTTP ${r.status}`); const value=await r.text(); if(value.length>8_000_000) throw new Error('CORE_RESPONSE_TOO_LARGE'); return JSON.parse(value); }
  async refresh() {
    const results=await Promise.allSettled(ROUTES.map(p=>this.read(p)));
    const [h,c,g]=results.map(r=>r.status==='fulfilled'?r.value:null);
    const shorten=v=>typeof v==='string'?v.slice(0,1000):null;
    const projection={capturedAt:new Date().toISOString(),origin:this.base,readOnly:true,online:!!h,
      service:h?{version:h.version,status:h.status,inferenceStatus:h.inferenceStatus,longTermMemory:h.longTermMemory?.status}:null,
      tasks:(c?.tasks??[]).slice(0,40).map(t=>({id:t.taskId,title:shorten(t.title),status:shorten(t.status)})),
      goals:(g?.goals??[]).slice(0,40).map(t=>({id:t.goalId,title:shorten(t.objective),status:shorten(t.status)})),
      agents:(c?.frontierSessions?.sessions??[]).slice(0,80).map(a=>({id:a.sessionId,name:shorten(a.displayName),role:shorten(a.role),status:shorten(a.status),liveness:shorten(a.liveness)})),
      bus:c?.frontierSessions?.counts??null,
      resources:c?.resources?{ramPercent:c.resources.ramPercent,cpuPercent:c.resources.cpuPercent}:null,
      guard:c?.resourceGuard?{level:c.resourceGuard.level,allowModelLoad:c.resourceGuard.allowModelLoad}:null,
      providers:(c?.providers??[]).map(p=>({id:p.providerId,name:p.displayName,status:p.availability})),
      errors:results.flatMap((r,i)=>r.status==='rejected'?[{route:ROUTES[i],message:String(r.reason?.message??'Core unavailable').slice(0,200)}]:[])};
    this.last=projection; return projection;
  }

  // Only the privileged Browser shell may invoke this explicit, single-shot
  // Orchestrator interaction. Core's policy engine owns routing and spending.
  async submitOrchestrator({ message, conversationId = null }) {
    if (typeof message !== 'string' || !message.trim() || message.length > 16000) {
      throw new Error('CORE_CHAT_INVALID_MESSAGE');
    }
    if (conversationId !== null &&
        (typeof conversationId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(conversationId))) {
      throw new Error('CORE_CHAT_INVALID_CONVERSATION');
    }
    const r = await this.fetch(this.base + '/api/chat', {
      method: 'POST', redirect: 'error',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({message: message.trim(), conversationId}),
      signal: AbortSignal.timeout(90000)
    });
    const body = await r.text();
    if (body.length > 1_000_000) throw new Error('CORE_CHAT_RESPONSE_TOO_LARGE');
    let data;
    try { data = JSON.parse(body); } catch { throw new Error('CORE_CHAT_INVALID_RESPONSE'); }
    if (!r.ok) throw new Error('CORE_CHAT_HTTP_' + r.status);
    return {
      conversationId: typeof data.conversationId === 'string' ? data.conversationId.slice(0,128) : null,
      reply: String(data.turn?.assistantResponse ?? data.content ?? '').slice(0,65000),
      runId: typeof data.run?.runId === 'string' ? data.run.runId.slice(0,140) : null,
      proofHash: typeof data.proof?.sha256 === 'string' ? data.proof.sha256.slice(0,64) : null,
      source: 'MNEMOS_CORE_ORCHESTRATOR',
      verified: false
    };
  }

  saveBrowserObservation({ sessionId, verifier, project, requestId, url, title, text }) {
    return this.browserObservationRequest({ method: 'POST', sessionId, verifier, project,
      body: { schema: 'mnemos.browser-observation-create.v1', requestId, url, title, text } });
  }

  listBrowserObservations({ sessionId, verifier, project, q }) {
    return this.browserObservationRequest({ method: 'GET', sessionId, verifier, project, q });
  }

  deleteBrowserObservation({ sessionId, verifier, project, id }) {
    return this.browserObservationRequest({ method: 'DELETE', sessionId, verifier, project, id });
  }

  async browserObservationRequest({ method, sessionId, verifier, project, q, id, body }) {
    if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('CORE_ROUTE_DENIED');
    if (!/^mnemos-browser-[a-f0-9]{24}$/.test(sessionId ?? '') || !/^[a-f0-9]{64}$/.test(verifier ?? '')) {
      throw Object.assign(new Error('BROWSER_OBSERVATION_AUTH_REQUIRED'), { code: 'BROWSER_OBSERVATION_AUTH_REQUIRED' });
    }
    const endpoint = new URL(OBSERVATIONS_ROUTE, this.base);
    endpoint.searchParams.set('project', project);
    if (q != null) endpoint.searchParams.set('q', q);
    if (id != null) endpoint.searchParams.set('id', id);
    const headers = { 'x-mnemos-frontier-session': sessionId, 'x-mnemos-frontier-verifier': verifier };
    if (body) headers['content-type'] = 'application/json';
    const response = await this.fetch(endpoint, { method, headers, redirect: 'error',
      signal: AbortSignal.timeout(7000), ...(body ? { body: JSON.stringify(body) } : {}) });
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 1_100_000) throw new Error('CORE_RESPONSE_TOO_LARGE');
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('CORE_RESPONSE_INVALID'); }
    if (!response.ok) {
      const code = /^BROWSER_OBSERVATION_[A-Z_]+$/.test(data?.code ?? '') ? data.code : 'CORE_OBSERVATION_REQUEST_FAILED';
      throw Object.assign(new Error(code), { code, status: response.status });
    }
    return data;
  }
}
