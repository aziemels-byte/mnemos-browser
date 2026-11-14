import { randomUUID } from 'node:crypto';
import { validateBrowserAction, requiresBrowserOwnerApproval } from './browser-actions.mjs';

export const OWNER_SESSION = 'chatgpt-mnemos-browser-owner-20261110';
export const PERPLEXITY_GATEWAY_SESSION = 'mnemos-perplexity-browser-gateway-20261111';
const SCHEMA = 'mnemos.browser.command.v1';
const GRANT_ROUTE = '/api/browser/action-grants/authorize';
const WINDOW_ID = 'main';
const LIFECYCLE = ['tab.status', 'tab.navigate', 'tab.back', 'tab.forward', 'tab.reload', 'tab.close', 'tab.recover'];
const CAPABILITIES = ['tabs.list', 'tab.inspect', 'tab.answer', 'tab.describe', 'tab.fill',
  'tab.choose', 'tab.toggle', 'tab.attach', 'tab.click', 'tab.submit', 'tab.open', 'tab.select',
  'windows.list', ...LIFECYCLE];
const timeout = ms => AbortSignal.timeout(ms);
const short = (value, size) => String(value ?? '').slice(0, size);
const errorText = error => short(error?.message ?? error, 200);
function safeUrl(input) {
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin + u.pathname.slice(0, 800);
  } catch { return null; }
}
function selectedTabs(tabs) {
  return (tabs ?? []).filter(tab => tab && !tab.private && safeUrl(tab.url))
    .slice(0, 24).map(tab => ({
      id: short(tab.id, 90), project: short(tab.project, 90), windowId: WINDOW_ID,
      title: short(tab.title, 180), url: safeUrl(tab.url),
      loading: tab.loading === true,
      readiness: tab.crashed ? 'CRASHED' : tab.loading ? 'LOADING' : tab.failed ? 'FAILED' : 'READY'
    }));
}

export class CoreBrowserBridge {
  constructor({store, crypto, base = 'http://127.0.0.1:4320', fetchImpl = fetch,
    getTabs, inspectTab, readAnswer=null, openUrl, selectTab, approve, performAction = null, performLifecycle = null, onConsultationReply = null, onChange = () => {}}) {
    const endpoint = new URL(base);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/') throw new Error('CORE_LOOPBACK_ONLY');
    if (!store || !crypto || !getTabs || !inspectTab || !openUrl || !selectTab || !approve) throw new Error('BRIDGE_DEPENDENCY_MISSING');
    this.base = endpoint.origin; this.fetch = fetchImpl; this.store = store; this.crypto = crypto;
    this.getTabs = getTabs; this.inspectTab = inspectTab; this.readAnswer = readAnswer; this.openUrl = openUrl;
    this.selectTab = selectTab; this.approve = approve; this.onChange = onChange;
    this.onConsultationReply = onConsultationReply;
    this.performAction = performAction;
    this.performLifecycle = performLifecycle;
    this.startedMutations = new Set(store.get('coreBridge.mutationStarted',[]));
    this.enabled = store.get('coreBridge.enabled', false) === true;
    this.sessionId = store.get('coreBridge.sessionId', null);
    this.verifier = null; this.connected = false; this.busy = false;
    this.lastError = null; this.lastSeenAt = null; this.timer = null; this.registration = null; this.receipts = new Map();
    const savedReceipts = store.get('coreBridge.receipts', null);
    if (savedReceipts && crypto.isEncryptionAvailable()) {
      try {
        const items = JSON.parse(crypto.decryptString(Buffer.from(savedReceipts, 'base64')));
        if (Array.isArray(items)) for (const [id, answer] of items.slice(-32)) {
          if (/^msg_[a-f0-9-]{36}$/i.test(id) && answer?.schema === 'mnemos.browser.result.v1') this.receipts.set(id, answer);
        }
      } catch { this.lastError = 'BRIDGE_RECEIPTS_UNREADABLE'; this.enabled = false; }
    }
    const encrypted = store.get('coreBridge.verifier', null);
    if (encrypted) {
      if (!crypto.isEncryptionAvailable()) { this.enabled = false; this.lastError = 'OS_SECRET_ENCRYPTION_UNAVAILABLE'; }
      else {
        try {
          const token = crypto.decryptString(Buffer.from(encrypted, 'base64'));
          if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('INVALID_VERIFIER');
          this.verifier = token;
        } catch { this.enabled = false; this.lastError = 'BRIDGE_CREDENTIAL_UNREADABLE'; }
      }
    }
    if (!this.sessionId) {
      this.sessionId = 'mnemos-browser-' + randomUUID().replaceAll('-', '').slice(0, 24);
      store.set('coreBridge.sessionId', this.sessionId);
    }
  }
  snapshot() {
    return {enabled: this.enabled, connected: this.connected, sessionId: this.sessionId,
      peer: OWNER_SESSION, lastSeenAt: this.lastSeenAt, error: this.lastError,
      capabilities: this.capabilities(),
      privacy: 'private_excluded; external_submission_requires_approval'};
  }
  capabilities() {
    return this.performLifecycle ? CAPABILITIES : CAPABILITIES.filter(op => !LIFECYCLE.includes(op) && op !== 'windows.list');
  }
  recordMutation(messageId) {
    this.startedMutations.add(messageId);
    while (this.startedMutations.size > 200)
      this.startedMutations.delete(this.startedMutations.values().next().value);
    this.store.set('coreBridge.mutationStarted', [...this.startedMutations]);
  }
  async request(route, {method = 'GET', data, verifier = false} = {}) {
    const headers = {};
    if (data !== undefined) headers['content-type'] = 'application/json';
    if (verifier) {
      headers['x-mnemos-frontier-verifier'] = this.verifier;
      headers['x-mnemos-frontier-session'] = this.sessionId;
    }
    const response = await this.fetch(this.base + route, {method, headers,
      ...(data === undefined ? {} : {body: JSON.stringify(data)}),
      redirect: 'error', signal: timeout(7000)});
    if (!response.ok) {
      const reason = await response.json().catch(() => null);
      const code = typeof reason?.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(reason.code) ? ` ${reason.code}` : '';
      throw new Error('Core HTTP ' + response.status + code);
    }
    const body = await response.text();
    if (body.length > 250000) throw new Error('CORE_RESPONSE_TOO_LARGE');
    return JSON.parse(body);
  }
  async register() {
    if (!this.crypto.isEncryptionAvailable()) throw new Error('OS_SECRET_ENCRYPTION_UNAVAILABLE');
    const record = await this.request('/api/frontier-sessions/register', {method: 'POST', data: {
      sessionId: this.sessionId, role: 'browser_client', displayName: 'MNEMOS Browser',
      capabilities: this.capabilities().map(operation => 'browser.' + operation),
      metadata: {client: 'mnemos-browser', bridgeProtocol: SCHEMA, wake: {enabled: false}},
      ...(this.verifier ? {verifier: this.verifier} : {})
    }});
    if (record.sessionId !== this.sessionId) throw new Error('BRIDGE_SESSION_MISMATCH');
    if (record.verifier) {
      if (!/^[a-f0-9]{64}$/.test(record.verifier)) throw new Error('BRIDGE_VERIFIER_INVALID');
      this.store.set('coreBridge.verifier', this.crypto.encryptString(record.verifier).toString('base64'));
      this.verifier = record.verifier;
    }
    if (!this.verifier) throw new Error('BRIDGE_NO_VERIFIER');
  }
  async start() {
    if (!this.enabled) return this.snapshot();
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, 3000);
      this.timer.unref?.();
    }
    await this.tick();
    return this.snapshot();
  }
  async setEnabled(value) {
    this.enabled = value === true;
    this.store.set('coreBridge.enabled', this.enabled);
    if (this.enabled) await this.start();
    else this.stop();
    this.onChange();
    return this.snapshot();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.connected = false; this.onChange();
  }
  async finishRegistration() {
    await this.registration?.catch(() => {});
  }
  async tick() {
    if (!this.enabled || !this.timer || this.busy) return;
    const timer = this.timer;
    this.busy = true;
    try {
      if (!this.connected) {
        this.registration = this.register();
        try { await this.registration; }
        finally { this.registration = null; }
        if (this.timer !== timer) return;
      }
      const result = await this.request('/api/frontier-sessions/' + encodeURIComponent(this.sessionId) + '/inbox?limit=5', {verifier: true});

      for (const message of result.messages ?? []) {
        if (this.timer !== timer) return;
        if (!message?.messageId || !message?.threadId) continue;
        if (message.kind === 'consultation_reply') {
          if (message.from !== OWNER_SESSION || typeof this.onConsultationReply !== 'function')
            throw new Error('CONSULTATION_SENDER_NOT_TRUSTED');
          let payload;
          try { payload = JSON.parse(message.body); } catch { throw new Error('INVALID_CONSULTATION_JSON'); }
          if (payload?.schema !== 'mnemos.collaboration.reply.v1'
              || !/^[a-f0-9-]{36}$/i.test(payload.proposalId??'')
              || typeof payload.answer !== 'string' || payload.answer.length>8000)
            throw new Error('INVALID_CONSULTATION_REPLY');
          await this.onConsultationReply({
            proposalId:payload.proposalId,
            sourceMessageId:message.messageId,
            replyTo:message.replyTo,
            text:payload.answer
          });
          await this.request('/api/frontier-sessions/' + encodeURIComponent(this.sessionId) + '/ack', {
            method:'POST', data:{messageId:message.messageId,verifier:this.verifier}
          });
          continue;
        }
        let answer = this.receipts.get(message.messageId);
        if (!answer) {
          answer = await this.answer(message);
          this.receipts.set(message.messageId, answer);
          while (this.receipts.size > 32) this.receipts.delete(this.receipts.keys().next().value);
          this.store.set('coreBridge.receipts', this.crypto.encryptString(JSON.stringify([...this.receipts])).toString('base64'));
        }
        // A failed delivery leaves the inbound command pending for idempotent retry.
        await this.request('/api/frontier-sessions/send', {method: 'POST', data: {
          from: this.sessionId, to: message.from, verifier: this.verifier,
          threadId: message.threadId, replyTo: message.messageId, kind: 'browser_result',
          expectsReply: false, body: JSON.stringify(answer),
          metadata: {idempotencyKey: 'browser-reply-' + message.messageId}
        }});
        await this.request('/api/frontier-sessions/' + encodeURIComponent(this.sessionId) + '/ack', {
          method: 'POST', data: {messageId: message.messageId, verifier: this.verifier}
        });
      }
      if (this.timer !== timer) return;
      this.lastSeenAt = new Date().toISOString(); this.lastError = null;
      this.connected = true;
    } catch (error) {
      this.connected = false; this.lastError = errorText(error);
    } finally { this.busy = false; this.onChange(); }
  }
  async mutationGuard(messageId, target) {
    if (this.startedMutations.has(messageId)) throw new Error('ACTION_ALREADY_STARTED_CHECK_SITE_MANUALLY');
    if (!this.verifier) throw new Error('BROWSER_GRANT_DENIED');
    const connection = this.timer;
    const verify = async grantId => {
      try {
        const receipt = await this.request(GRANT_ROUTE, { method: 'POST', verifier: true,
          data: { messageId, ...target, ...(grantId ? { grantId } : {}) } });
        if (this.timer !== connection || !/^[a-f0-9-]{36}$/.test(receipt?.grantId ?? '') ||
            (grantId && receipt.grantId !== grantId) || !(Date.parse(receipt.expiresAt) > Date.now()))
          throw new Error('BROWSER_GRANT_DENIED');
        return receipt.grantId;
      } catch (error) {
        if (String(error.message).includes('BROWSER_GRANT_DENIED')) throw new Error('BROWSER_GRANT_DENIED');
        throw new Error('BROWSER_GRANT_UNAVAILABLE');
      }
    };
    const grantId = await verify();
    return () => verify(grantId);
  }

  async answer(message) {
    const wrap = (ok, data) => ({
      schema: 'mnemos.browser.result.v1', commandMessageId: message.messageId, browserInstanceId: this.sessionId,
      ok, ...(ok ? {data} : {error: data}), capturedAt: new Date().toISOString()
    });
    if (message.from !== OWNER_SESSION && message.from !== PERPLEXITY_GATEWAY_SESSION) return wrap(false, 'UNTRUSTED_SENDER');
    let command;
    try { command = JSON.parse(message.body); }
    catch { return wrap(false, 'INVALID_JSON'); }
    if (!command || command.schema !== SCHEMA || typeof command.operation !== 'string')
      return wrap(false, 'INVALID_COMMAND');
    const liveTabs = this.getTabs();
    const tabs = selectedTabs(liveTabs);
    try {
      if (command.browserInstanceId !== undefined && command.browserInstanceId !== this.sessionId)
        return wrap(false, 'BROWSER_INSTANCE_MISMATCH');
      if (command.operation === 'tabs.list') return wrap(true, {tabs, browserInstanceId: this.sessionId});
      if (command.operation === 'windows.list' || LIFECYCLE.includes(command.operation)) {
        if (message.from !== OWNER_SESSION) return wrap(false, 'BROWSER_LIFECYCLE_SCOPE_DENIED');
        if (!this.performLifecycle) return wrap(false, 'BROWSER_LIFECYCLE_NOT_CONFIGURED');
        if (command.operation === 'windows.list') return wrap(true, {
          browserInstanceId: this.sessionId, windows: [{id: WINDOW_ID, tabCount: tabs.length}]
        });
        if (command.browserInstanceId !== this.sessionId) return wrap(false, 'BROWSER_INSTANCE_REQUIRED');
        const target = tabs.find(row => row.id === command.tabId);
        if (!target) return wrap(false, 'TAB_NOT_ACCESSIBLE');
        if (command.expectedOrigin !== new URL(target.url).origin)
          return wrap(false, 'EXPECTED_ORIGIN_MISMATCH');
        const action = {
          operation: command.operation,
          expectedOrigin: command.expectedOrigin,
          expectedPath: new URL(target.url).pathname,
          url: command.url
        };
        if (command.operation !== 'tab.status') {
          if (this.startedMutations.has(message.messageId))
            return wrap(false, 'ACTION_ALREADY_STARTED_CHECK_SITE_MANUALLY');
          this.recordMutation(message.messageId);
        }
        return wrap(true, await this.performLifecycle(target.id, action));
      }
      const tab = tabs.find(row => row.id === command.tabId);
      if (['tab.describe','tab.fill','tab.choose','tab.toggle','tab.attach','tab.click','tab.submit'].includes(command.operation)) {
        if (!this.performAction) return wrap(false,'BROWSER_ACTIONS_NOT_CONFIGURED');
        if (!tab) return wrap(false,'TAB_NOT_ACCESSIBLE');
        const action = validateBrowserAction(command);
        const origin = new URL(tab.url).origin;
        action.expectedPath = new URL(tab.url).pathname; // Bound to the reviewed page, never a model-supplied path.
        if (action.expectedOrigin !== origin) return wrap(false,'EXPECTED_ORIGIN_MISMATCH');
        const isMutation = action.operation!=='tab.describe';
        if (isMutation && this.startedMutations.has(message.messageId))
          return wrap(false,'ACTION_ALREADY_STARTED_CHECK_SITE_MANUALLY');
        const target = isMutation ? liveTabs.find(row => row.id === tab.id) : null;
        const authorize = isMutation ? await this.mutationGuard(message.messageId, {
          project: tab.project, tabId: tab.id, url: origin + action.expectedPath
        }) : null;
        if (requiresBrowserOwnerApproval(action.operation) &&
            !await this.approve({operation:action.operation,tab,sender:message.from,
              index:action.index, label:action.expectedName??action.expectedText, value:action.value, checked:action.checked}))
          return wrap(false,'USER_DECLINED');
        if (isMutation) {
          // Persist before the external side effect so a crash cannot auto-click or re-submit.
          this.recordMutation(message.messageId);
        }
        const data = await this.performAction(tab.id, action, target && { authorize, href: target.url, project: tab.project, navigationEpoch: target.navigationEpoch });
        return wrap(true,{tabId:tab.id,...data});
      }
      if (command.operation === 'tab.answer') {
        if (!tab || !this.readAnswer) return wrap(false, 'TAB_NOT_ACCESSIBLE');
        if (command.expectedOrigin !== new URL(tab.url).origin)
          return wrap(false, 'EXPECTED_ORIGIN_MISMATCH');
        const offset=Number(command.offset??0),length=Number(command.length??6000);
        if (!Number.isInteger(offset)||offset<0||offset>32768||
            !Number.isInteger(length)||length<1||length>7000)
          return wrap(false,'INVALID_ANSWER_PAGE');
        const data=await this.readAnswer(tab.id,{expectedOrigin:command.expectedOrigin,offset,length});
        return wrap(true,{tabId:tab.id,...data});
      }
      if (command.operation === 'tab.inspect') {
        if (!tab) return wrap(false, 'TAB_NOT_ACCESSIBLE');
        if (command.expectedOrigin&&command.expectedOrigin!==new URL(tab.url).origin)
          return wrap(false,'EXPECTED_ORIGIN_MISMATCH');
        const source = new URL(tab.url);
        const data = await this.inspectTab(tab.id, {expectedOrigin: source.origin, expectedPath: source.pathname});
        return wrap(true, {tab, title: short(data?.title, 180),
          text: short(data?.text, 6000), note: 'Stored in MNEMOS Frontier Bus'});
      }
      if (command.operation === 'tab.select') {
        if (!tab) return wrap(false, 'TAB_NOT_ACCESSIBLE');
        const target = liveTabs.find(row => row.id === tab.id);
        const authorize = await this.mutationGuard(message.messageId, { project: tab.project, tabId: tab.id, url: tab.url });
        await authorize();
        const current = this.getTabs().find(row => row.id === tab.id);
        if (!current || current.private || current.project !== target.project || current.url !== target.url ||
            current.navigationEpoch !== target.navigationEpoch)
          throw new Error('TAB_PAGE_CHANGED');
        this.recordMutation(message.messageId);
        await this.selectTab(tab.id);
        return wrap(true, {selectedId: tab.id});
      }
      if (command.operation === 'tab.open') {
        const u = new URL(command.url);
        if (u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443')
          return wrap(false, 'URL_NOT_ALLOWED');
        if (typeof command.project !== 'string' || !/^[a-z0-9_-]{1,90}$/i.test(command.project))
          return wrap(false, 'BROWSER_GRANT_PROJECT_REQUIRED');
        const authorize = await this.mutationGuard(message.messageId, { project: command.project, url: u.href });
        await authorize();
        this.recordMutation(message.messageId);
        const opened = await this.openUrl(u.href, command.project);
        return wrap(true, {openedId: opened?.id ?? null});
      }
      return wrap(false, 'UNKNOWN_OPERATION');
    } catch (error) { return wrap(false, errorText(error)); }
  }
}
