import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopApp } from '../src/desktop/desktop-app.js';

// Exercise the real renderer/IPC/services with deterministic provider and App fixtures.
// No credential contents, external App, CLI login, or model requests are used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.bridge', 'auth-state-smoke');
const dataDirectory = path.join(artifacts, `run-${Date.now()}`);
mkdirSync(dataDirectory, { recursive: true });
let credentialPresent = true;
let available = false;
let running = false;
let launches = 0;
let providerCalls = 0;
let cliLogins = 0;
let closed = false;
let disposed = false;
const report = { passed: false, checks: [], rendererErrors: [] };
const agent = id => id === 'antigravity'
  ? { available, authenticated: null, credentialPresent, authSource: 'credential-entry', version: available ? 'antigravity 1.4.9' : null, commandPath: available ? 'C:\\Users\\fixture\\AppData\\Local\\agy\\bin\\agy.exe' : 'agy', error: available ? null : 'agy is not installed.' }
  : { available: true, authenticated: true, authSource: 'cli-status', version: `${id} fixture`, error: null };
const app = () => ({ installed: true, running, managed: running, pids: running ? [12345] : [],
  rootProcesses: running ? [{ pid: 12345, created: 'fixture-start' }] : [], error: null });
const runtime = {
  probe: async () => Object.fromEntries(['codex', 'claude', 'antigravity'].map(id => [id, agent(id)])),
  probeAgent: async id => agent(id), activeProcesses: () => [], close: async () => { closed = true; },
  run: async () => { providerCalls++; throw new Error('Auth smoke must never request a model.'); },
  login: async () => { cliLogins++; throw new Error('Antigravity sign-in belongs to its App.'); },
};
const appManager = {
  list: async () => ({ antigravity: app() }),
  launch: async id => { assert.equal(id, 'antigravity'); launches++; running = true; return app(); },
  closeOwned: async () => { running = false; return { antigravity: app() }; },
  dispose: async () => { disposed = true; },
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, reason) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await condition()) return; await pause(80); }
  throw new Error(reason);
}
let instance;
async function main() {
  try {
    instance = await createDesktopApp({ dataDirectory, port: 0, runtime, appManager,
      usageMonitor: { get: () => ({}), refresh: async () => ({}) },
      onShutdownComplete(snapshot) {
        report.bridgeStopped = snapshot.bridge.state === 'stopped';
        report.remainingProcesses = snapshot.processes;
        report.providerCalls = providerCalls; report.cliLogins = cliLogins;
        report.runtimeClosed = closed; report.appManagerDisposed = disposed;
        report.passed = report.ready === true && !report.error && !report.rendererErrors.length
          && report.bridgeStopped && !report.remainingProcesses.length && closed && disposed
          && providerCalls === 0 && cliLogins === 0;
        writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
        if (!report.passed) process.exitCode = 1;
      },
    });
    assert.ok(instance, 'The isolated smoke instance must own its window.');
    const { window, services } = instance;
    window.webContents.on('console-message', event => { if (event.level === 'error') report.rendererErrors.push(event.message); });
    const js = code => window.webContents.executeJavaScript(code);
    const card = "document.querySelector('[data-login-agent=antigravity]')?.closest('.app-card')";
    const button = "document.querySelector('[data-login-agent=antigravity]')";
    const hasText = text => js(`${card}?.textContent.includes(${JSON.stringify(text)})`);
    const buttonReady = () => js(`${button} && !${button}.disabled`);
    const capture = async name => {
      await js(`${card}.scrollIntoView({block:'center'})`);
      await pause(200);
      writeFileSync(path.join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    };
    const refresh = () => services.refreshStatus({ refreshQuota: false });
    await js("document.querySelector('#chat-options').open=true");
    await until(() => js("document.querySelector('[data-participant=antigravity]')"), 'Antigravity task chip missing.');
    assert.equal(await js("document.querySelector('[data-participant=antigravity]').disabled"), false);
    await until(() => js("document.querySelector('[data-participant=antigravity]').title.includes('CLI 不可用')"), "Initial CLI status did not reach the renderer.");
    await js("document.querySelector('#chat-options').open=false;if(document.querySelector('#toggle-inspector').getAttribute('aria-expanded')!=='true')document.querySelector('#toggle-inspector').click();document.querySelector('[data-inspector-tab=system]').click()");
    await until(() => js("document.querySelector('#inspector-body').textContent.includes('偵測到憑證（有效性未驗證）')"), 'Inspector credential status missing.');
    assert.equal(await js("Array.from(document.querySelectorAll('#inspector-body .status-badge')).every(el=>{const box=el.getBoundingClientRect(),card=el.closest('.ins-card').getBoundingClientRect();return box.left>=card.left&&box.right<=card.right+1&&el.scrollWidth<=el.clientWidth+1})"), true, 'Inspector badges must wrap within their card.');
    report.checks.push('Task support remains separate from CLI readiness; long inspector status stays inside its card.');
    await js("document.querySelector('.nav-item[data-view=apps]').click()");
    await js("document.querySelector('[data-agent-details=antigravity]').click()");
    await until(() => hasText('偵測到憑證（有效性未驗證）'), 'Stored marker was misrepresented as verified login.');
    assert.equal(services.snapshot().agents.antigravity.authenticated, null);
    assert.equal(await buttonReady(), true);
    await capture('credential-present');
    report.checks.push('Existing credential stays unverified and retains the re-login button.');
    assert.equal(await hasText('agy is not installed.'), true, 'App management must expose CLI failures.');
    available = true;
    await refresh();
    await until(() => hasText('CLI 可用'), 'CLI becoming available must update the App card.');
    assert.equal(await hasText('CLI 不可用'), false);
    assert.equal(await hasText('CLI 已登入'), false, 'A CLI probe must not claim verified sign-in.');
    assert.equal(await hasText('CLI 位置'), true);
    await js("document.querySelector('.nav-item[data-view=workspace]').click();document.querySelector('#chat-options').open=true;(()=>{const chips=()=>Array.from(document.querySelectorAll('[data-participant]'));const ag=chips().find(e=>e.dataset.participant==='antigravity');if(!ag.classList.contains('selected'))ag.click();let other;while((other=chips().find(e=>e.dataset.participant!=='antigravity'&&e.classList.contains('selected'))))other.click()})();document.querySelector('#chat-options').open=false;document.querySelector('#task-description').value='readiness fixture';document.querySelector('#task-description').dispatchEvent(new Event('input',{bubbles:true}))");
    assert.equal(await js("document.querySelector('#submit-task').disabled"), false, 'CLI must allow sending while desktop App is stopped.');
    assert.equal(running, false);
    available = false;
    await refresh();
    await until(() => js("document.querySelector('#submit-task').disabled"), 'Missing CLI must block sending.');
    await js("document.querySelector('.nav-item[data-view=apps]').click()");
    report.checks.push('Missing/ready CLI updates the real renderer, preserves credential uncertainty, and gates sending independently of App liveness.');


    await js(`${button}.click()`);
    await until(() => services.snapshot().agents.antigravity.login?.state === 'opened', 'Existing marker must allow opening App without false pending.');
    await until(() => buttonReady(), 'Re-login button remained disabled.');
    await until(() => hasText('請在 App 內確認帳號或重新登入'), 'App sign-in guidance missing.');
    assert.equal(await hasText('請在瀏覽器'), false);
    assert.equal(launches, 1);
    report.checks.push('Existing marker opens App directly without CLI login or a false success claim.');

    credentialPresent = false;
    await refresh();
    await until(() => hasText('未偵測到登入憑證'), 'Absent marker status missing.');
    await js(`${button}.click()`);
    await until(() => services.snapshot().agents.antigravity.login?.state === 'pending', 'Missing marker must wait for App sign-in.');
    await until(() => js(`${button}.disabled`), 'Pending sign-in was not disabled.');
    running = false;
    await until(() => services.snapshot().agents.antigravity.login?.state === 'failed', 'Late App exit left sign-in stuck pending.');
    await until(() => hasText('Antigravity 已結束'), 'Late App exit was not explained in the renderer.');
    assert.equal(await buttonReady(), true);
    await capture('app-exited');
    report.checks.push('Late App exit fails promptly and restores the retry control.');

    credentialPresent = true;
    await refresh();
    await until(() => hasText('偵測到憑證（有效性未驗證）'), 'Late marker did not update the renderer.');
    await until(async () => !await hasText('Antigravity 已結束'), 'Refresh retained a stale login failure after a marker arrived.');
    assert.equal(services.snapshot().agents.antigravity.authenticated, null);
    report.checks.push('Refresh clears an old sign-in failure when a marker arrives later.');

    credentialPresent = null;
    await refresh();
    await until(() => hasText('憑證狀態待確認'), 'Unknown credentials were treated as signed out.');
    await js(`${button}.click()`);
    await until(() => services.snapshot().agents.antigravity.login?.state === 'pending', 'Unknown marker must still allow opening App.');
    credentialPresent = true;
    await until(() => !services.snapshot().agents.antigravity.login, 'New credential marker did not clear waiting.');
    await until(() => hasText('偵測到憑證（有效性未驗證）'), 'New marker was misrepresented in the renderer.');
    assert.equal(services.snapshot().agents.antigravity.authenticated, null);
    assert.equal(await buttonReady(), true);
    assert.equal(cliLogins, 0); assert.equal(providerCalls, 0);
    report.checks.push('Unknown stays unknown; a new marker ends waiting without verifying authentication.');
    report.ready = true;
    await instance.shutdown();
  } catch (error) {
    report.error = error.stack || error.message;
    if (instance) await instance.shutdown();
    else { writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); process.exitCode = 1; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
