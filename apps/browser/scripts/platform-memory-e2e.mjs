import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import { fixtures } from '../test/fixtures.mjs';
import { OWNER_SESSION } from '../src/core-browser-bridge.mjs';

const browserRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
if (!process.env.MNEMOS_CORE_CHECKOUT) throw new Error('Set MNEMOS_CORE_CHECKOUT to a compatible Core source checkout');
const coreCheckout = path.resolve(process.env.MNEMOS_CORE_CHECKOUT);
const coreFixture = path.join(coreCheckout, 'test', 'fixtures', 'isolated-browser-core.mjs');
const { createIsolatedBrowserCore } = await import(pathToFileURL(coreFixture).href);
const portableExe = process.env.MNEMOS_PLATFORM_TEST_EXE;
const out = path.resolve(process.env.MNEMOS_BROWSER_E2E_OUT ?? path.join(browserRoot, 'artifacts', 'platform-memory'));
await mkdir(out, { recursive: true });
const workspace = await mkdtemp(path.join(out, 'run-'));
const fixture = await fixtures();
const core = await createIsolatedBrowserCore(workspace);
const project = 'mnemos';
const selection = 'Chromium cilne';
const siteUrl = fixture.web.origin + '/first?fixture-private-marker=omit#omit';
const checks = [];
const pageErrors = [];
let app;
let page;
let observationId;
let bridgeOwner;

async function check(testId, actions, expected, verify) {
  try {
    await verify();
    checks.push({ testId, actions, expected, result: 'PASS' });
    console.log(`PASS ${testId} ${actions}`);
  } catch (error) {
    const state = page ? await call('snapshot').catch(() => null) : null;
    const diagnostic = state && { activeId: state.activeId, project: state.activeProject,
      coreOnline: state.core?.online, bridgeConnected: state.bridge?.connected,
      bridgeError: state.bridge?.error, browserError: state.error,
      activeTab: state.tabs.find(tab => tab.id === state.activeId)?.title };
    checks.push({ testId, actions, expected, result: 'FAIL', error: error.message, diagnostic });
    if (diagnostic) console.error(JSON.stringify(diagnostic));
    throw error;
  }
}

function call(operation, payload = {}) {
  return page.evaluate(([operation, payload]) => window.mnemos.invoke(operation, payload), [operation, payload]);
}

async function waitForState(predicate, expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await call('snapshot');
    if (predicate(state)) return state;
    await page.waitForTimeout(100);
  }
  throw new Error(`Desktop did not report ${expected}`);
}

function waitForBridge() {
  return waitForState(state => state.bridge?.connected && state.bridge.lastSeenAt, 'completed Frontier inbox poll');
}

async function launch() {
  const env = { ...process.env,
    MNEMOS_TEST_PROFILE: path.join(workspace, 'browser-profile'),
    MNEMOS_TEST_CORE_ORIGIN: core.base,
    MNEMOS_TEST_OLLAMA_ORIGIN: fixture.model.origin,
    MNEMOS_TEST_WEB_ORIGIN: fixture.web.origin
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: portableExe ?? electronPath,
    args: portableExe ? ['--test-mode'] : [browserRoot, '--test-mode'], env });
  page = await app.firstWindow();
  page.on('pageerror', error => { pageErrors.push(error.message); console.error(error.message); });
  await page.waitForFunction(() => Boolean(window.mnemos));
  await waitForState(state => state.core?.online, 'Core online');
  await page.waitForSelector('#boot-stage.ready', { state: 'attached' });
}

async function selectPageText() {
  const locator = { origin: fixture.web.origin, pathname: '/first' };
  for (let attempt = 0; attempt < 80; attempt++) {
    const selected = await app.evaluate(async ({ webContents }, locator) => {
      const contents = webContents.getAllWebContents().find(item => {
        const url = URL.parse(item.getURL());
        return url?.origin === locator.origin && url.pathname === locator.pathname && !item.isLoading();
      });
      if (!contents) return null;
      return contents.executeJavaScript(`(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('h1'));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString();
      })()`);
    }, locator);
    if (selected !== null) {
      assert.equal(selected, selection);
      return;
    }
    await page.waitForTimeout(150);
  }
  throw new Error('Controlled Chromium fixture did not finish navigation');
}

async function frontier(route, { body, verifier } = {}) {
  const response = await fetch(`${core.base}/api/frontier-sessions/${route}`, {
    signal: AbortSignal.timeout(8000),
    method: body ? 'POST' : 'GET',
    headers: { ...(body && { 'content-type': 'application/json' }),
      ...(verifier && { 'x-mnemos-frontier-verifier': verifier }) },
    ...(body && { body: JSON.stringify(body) })
  });
  assert.ok(response.ok, `Frontier HTTP ${response.status}`);
  return response.json();
}

async function browserCommand(owner, browserInstanceId, operation, args = {}) {
  const request = await frontier('send', { body: {
    from: owner.sessionId, to: browserInstanceId, verifier: owner.verifier, kind: 'browser_command',
    expectsReply: true, body: JSON.stringify({ schema: 'mnemos.browser.command.v1',
      operation, browserInstanceId, ...args })
  } });
  for (let attempt = 0; attempt < 30; attempt++) {
    const inbox = await frontier(`${owner.sessionId}/inbox`, { verifier: owner.verifier });
    const reply = inbox.messages.find(message => message.replyTo === request.messageId);
    if (reply) {
      assert.equal(reply.from, browserInstanceId);
      assert.equal(reply.threadId, request.threadId);
      const result = JSON.parse(reply.body);
      assert.equal(result.commandMessageId, request.messageId);
      assert.equal(result.browserInstanceId, browserInstanceId);
      await frontier(`${owner.sessionId}/ack`, { body: { messageId: reply.messageId, verifier: owner.verifier } });
      return result;
    }
    await page.waitForTimeout(200);
  }
  throw new Error('Core did not receive the Browser result');
}

async function loadMemory() {
  await page.locator('[data-section=memory]').click();
  await page.getByRole('button', { name: 'Ielasīt no Core' }).click();
}

try {
  await check('CORE', 'Start real Core before Electron', 'Core health responds independently', async () => {
    await core.start();
    const response = await fetch(core.base + '/api/health');
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.version, '2.0.0');
    assert.equal(health.platformVersion, '2.000');
  });
  await launch();
  await page.locator('#settings').click();
  await page.getByRole('button', { name: 'Savienot', exact: true }).click();
  await waitForBridge();
  const { sessionId } = (await call('snapshot')).bridge;
  await app.close();
  app = null;
  await core.stop();
  core.configureGrants([{ sessionId, project, permissions: ['read', 'write', 'delete'],
    expiresAt: new Date(Date.now() + 600_000).toISOString() }]);
  await core.start();
  await launch();
  await waitForBridge();

  await check('E-review', 'Select text in real Chromium and cancel its Desktop review', 'Exact selection and redacted origin, zero persisted rows', async () => {
    const { id } = await call('tab.open', { input: siteUrl, project });
    await waitForState(state => state.tabs.some(tab => tab.id === id && !tab.loading && !tab.error), 'Chromium tab ready');
    await call('tab.select', { id });
    await waitForBridge();
    await selectPageText();
    await page.locator('#review-observation').click({ timeout: 7000 });
    await page.locator('#observation-dialog[open]').waitFor({ timeout: 7000 });
    assert.equal(await page.locator('#observation-preview').inputValue(), selection);
    const source = await page.locator('#observation-source').textContent();
    assert.ok(source.endsWith(fixture.web.origin));
    assert.ok(!source.includes('fixture-private-marker'));
    await page.locator('#observation-cancel').click();
    assert.deepEqual((await call('observation.list', { project })).observations, []);
  });
  await check('E-save', 'Confirm a selected excerpt in the desktop and read its Core record', 'One untrusted observation with Frontier provenance', async () => {
    await selectPageText();
    await page.locator('#review-observation').click({ timeout: 7000 });
    await page.locator('#observation-dialog[open]').waitFor();
    await page.screenshot({ path: path.join(out, 'observation-review.png') });
    await page.locator('#observation-save').click();
    await page.locator('#observation-dialog[open]').waitFor({ state: 'hidden' });
    const { observations } = await call('observation.list', { project });
    assert.equal(observations.length, 1);
    const [record] = observations;
    assert.equal(record.text, selection);
    assert.equal(record.kind, 'OBSERVATION');
    assert.equal(record.trust, 'UNTRUSTED_REFERENCE');
    assert.equal(record.objectiveAuthority, false);
    assert.equal(record.source.sessionId, sessionId);
    assert.equal(record.source.origin, fixture.web.origin);
    observationId = record.id;
    await loadMemory();
    await page.locator('.observation-record summary').click();
    assert.equal(await page.locator('.observation-record .observation-text').innerText(), selection);
    await page.screenshot({ path: path.join(out, 'observation-memory.png') });
  });
  await check('BRIDGE', 'Send window discovery through actual Core Frontier HTTP', 'Browser result has the same thread and command ID', async () => {
    bridgeOwner = await frontier('register', { body: {
      sessionId: OWNER_SESSION, role: 'coordinator', displayName: 'Isolated integration operator'
    } });
    assert.equal(bridgeOwner.sessionId, OWNER_SESSION);
    const result = await browserCommand(bridgeOwner, sessionId, 'windows.list');
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.windows, [{ id: 'main', tabCount: 1 }]);

  });
  await check('BRIDGE-GRANT', 'Issue and revoke a Core grant while Electron remains open',
    'The exact Chromium control is editable only with an active grant', async () => {
      const expectedOrigin = 'https://grants.mnemos.invalid';
      const url = expectedOrigin + '/draft';
      await app.evaluate(({ session }, { project, url }) => {
        const partition = session.fromPartition('persist:mnemos-project-' + project);
        partition.webRequest.onBeforeRequest((request, reply) => reply({ cancel: request.url !== url }));
        partition.protocol.handle('https', request => request.url === url
          ? new Response('<title>Draft fixture</title><label for="draft">Draft</label><input id="draft">',
              { headers: { 'content-type': 'text/html' } })
          : new Response('', { status: 404 }));
      }, { project, url });
      const { id: tabId } = await call('tab.open', { input: url, project });
      await waitForState(state => state.tabs.some(tab => tab.id === tabId && !tab.loading && !tab.error && tab.title === 'Draft fixture'), 'grant fixture ready');
      const fill = value => browserCommand(bridgeOwner, sessionId, 'tab.fill', { tabId, expectedOrigin,
        index: 0, expectedName: 'Draft', value });
      const read = () => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url)
        .executeJavaScript('document.getElementById("draft").value'), url);
      const grantFile = path.join(workspace, 'browser-action-grant.json');
      await writeFile(grantFile, JSON.stringify({ browser: sessionId, actor: bridgeOwner.sessionId, project, tabId, url,
        operation: 'tab.fill', expiresAt: new Date(Date.now()+120_000).toISOString() }));
      const grantCli = (operation, argument) => JSON.parse(execFileSync(process.execPath,
        ['scripts/browser-action-grants.mjs', operation, argument], { cwd: coreCheckout, encoding: 'utf8', windowsHide: true,
          env: { ...process.env, MNEMOS_RUNTIME_CONFIG: core.runtimeConfig } }));
      try {
        assert.equal((await fill('Denied before issue')).error, 'BROWSER_GRANT_DENIED');
        assert.equal(await read(), '');
        const grant = grantCli('issue', grantFile);
        assert.equal((await fill('Allowed draft')).data.filled, true);
        assert.equal(await read(), 'Allowed draft');
        assert.equal(grantCli('revoke', grant.id).revoked, true);
        assert.equal((await fill('Denied after revoke')).error, 'BROWSER_GRANT_DENIED');
        assert.equal(await read(), 'Allowed draft');
      } finally { await call('tab.close', { id: tabId }); }
    });
  await check('E-restart', 'Restart Core and Electron and reopen project memory', 'Original observation ID and text survive both restarts', async () => {
    await app.close();
    app = null;
    await core.stop();
    await core.start();
    await launch();
    await waitForBridge();
    const [record] = (await call('observation.list', { project })).observations;
    assert.equal(record.id, observationId);
    assert.equal(record.text, selection);
    await loadMemory();
    await page.locator('.observation-record summary').click();
    assert.equal(await page.locator('.observation-record .observation-text').innerText(), selection);
  });
  await check('E-delete', 'Confirm deletion in project memory', 'Core no longer returns the observation', async () => {
    await page.getByRole('button', { name: 'Dzēst', exact: true }).click();
    await page.getByRole('button', { name: 'Apstiprināt dzēšanu' }).click();
    await page.locator('.observation-record').waitFor({ state: 'detached' });
    assert.deepEqual((await call('observation.list', { project })).observations, []);
    assert.equal(fixture.observed.modelCalls, 0);
  });
} finally {
  if (app) await app.close().catch(() => {});
  await core.stop();
  await fixture.close();
  await writeFile(path.join(out, 'platform-memory-e2e.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), environment: { os: process.platform, node: process.version },
    components: ['MNEMOS Electron', 'Chromium', 'Core HTTP', 'Frontier identity', 'Core observation store'],
    browserBuild: portableExe ? 'portable' : 'source', outboundInference: false, checks, pageErrors
  }, null, 2));
}
