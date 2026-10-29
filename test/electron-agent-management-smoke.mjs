import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopApp } from '../src/desktop/desktop-app.js';

// Real renderer/IPC, isolated profile, deterministic status; no models or native Apps.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.bridge', 'agent-management-smoke');
const dataDirectory = path.join(artifacts, `run-${Date.now()}`);
mkdirSync(dataDirectory, { recursive: true });
let available = true, signedIn = true, probeCount = 0;
let launches = 0, calls = 0, logins = 0, closed = false;
const report = { passed: false, checks: [], rendererErrors: [] };
const ids = ['codex', 'claude', 'antigravity'];
const runtime = {
  async probe() {
    probeCount++;
    return Object.fromEntries(ids.map(id => [id, { available: id === 'antigravity' ? available : true,
      authenticated: id === 'antigravity' ? null : signedIn, credentialPresent: true,
      commandPath: `C:\\fixture\\${id}.exe`, version: `${id} fixture ${probeCount}`, error: id === 'antigravity' && !available ? 'Missing fixture CLI' : null }]));
  },
  activeProcesses: () => [], close: async () => { closed = true; },
  run: async () => { calls++; throw new Error('Management smoke cannot send a model request.'); },
  login: async () => { logins++; return { opened: true }; },
};
const appManager = {
  list: async () => Object.fromEntries(ids.map(id => [id, { installed: true, running: false, managed: false, pids: [] }])),
  launch: async () => { launches++; throw new Error('No native App may be launched.'); }, dispose: async () => {},
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, message) {
  for (let i = 0; i < 200; i++) { if (await condition()) return; await pause(60); }
  throw new Error(message);
}
let instance;
async function main() {
try {
  instance = await createDesktopApp({ dataDirectory, port: 0, runtime, appManager,
    usageMonitor: { get: () => ({ checkedAt: new Date().toISOString() }), refresh: async () => ({}) },
    onShutdownComplete(snapshot) {
      report.listenerStopped = snapshot.bridge.state === 'stopped';
      report.passed = report.ready === true && !report.error && !report.rendererErrors.length && closed
        && report.listenerStopped && !snapshot.processes.length && !launches && !calls && !logins;
      report.calls = { launches, calls, logins };
      writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    },
  });
  const { window, services } = instance;
  window.webContents.on('console-message', event => { if (event.level === 'error') report.rendererErrors.push(event.message); });
  const js = code => window.webContents.executeJavaScript(code);
  const capture = async name => {
    await pause(130);
    writeFileSync(path.join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  await until(() => js("document.querySelector('[data-agent-row=antigravity]')?.dataset.readiness==='ready'"), 'Initial status missing.');
  await js("document.querySelector('.nav-item[data-view=apps]').click()");
  assert.equal(await js("document.querySelector('#view-title').textContent"), 'Agent 管理');
  assert.equal(await js("document.querySelector('#inspector').hidden"), true, 'Overview must not duplicate the global inspector.');
  assert.equal(await js("Array.from(document.querySelectorAll('[data-agent-row]')).every(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})"), true, 'All three agents must be visible in the normal window.');
  assert.equal(await js("document.querySelector('#service-details').open"), false);
  assert.equal(await js("document.querySelector('#management-status').textContent.includes('3 / 3')"), true);
  await capture('01-overview');
  report.checks.push('Three providers share one compact overview with CLI readiness and collapsed local-service diagnostics.');

  await js("document.querySelector('[data-agent-details=antigravity]').click()");
  assert.equal(await js("document.querySelector('.inspector-tabs').hidden"), true);
  assert.equal(await js("['執行與登入','桌面 App','進階診斷'].every(text=>document.querySelector('#inspector-body').textContent.includes(text))"), true);
  assert.equal(await js("document.querySelector('#inspector-body').textContent.includes('不影響 CLI 任務')"), true);
  assert.equal(await js("!!document.querySelector('[data-close-app=antigravity]')"), false, 'Do not offer an ineffective close action for an unowned App.');
  assert.equal(await js("document.querySelector('[data-disclosure]').open"), false);
  await js("document.querySelector('[data-disclosure]').open=true;document.querySelector('[data-copy-agent-path]').focus()");
  await services.refreshStatus({ refreshQuota: false });
  await pause(140);
  assert.equal(await js("document.querySelector('[data-disclosure]').open"), true);
  assert.equal(await js("document.activeElement.dataset.copyAgentPath"), 'antigravity');
  await capture('02-details');
  report.checks.push('Contextual details separate login, desktop App and diagnostics; refresh preserves focus and expanded diagnostics.');

  available = false;
  await js("document.querySelector('#refresh-agents').click()");
  await until(() => js("document.querySelector('[data-agent-row=antigravity]').dataset.readiness==='unavailable'"), 'Refresh did not show missing CLI.');
  assert.equal(await js("document.querySelector('#inspector-body').textContent.includes('Missing fixture CLI')"), true);
  await js("document.querySelector('[data-close-inspector]').click();document.querySelector('[data-agent-primary=antigravity]').click()");
  assert.equal(await js("document.querySelector('#inspector').hidden"), false, 'Repair action must open the selected Agent details.');
  assert.equal(services.snapshot().conversations.length, 0);
  report.checks.push('Unavailable provider exposes repair details without creating a room or launching an App.');

  available = true;
  await services.refreshStatus({ refreshQuota: false });
  await until(() => js("document.querySelector('[data-agent-row=antigravity]').dataset.readiness==='ready'"), 'Recovery missing.');
  await js("document.querySelector('[data-close-inspector]').click();document.querySelector('[data-agent-primary=antigravity]').click()");
  await until(() => services.snapshot().conversations.length === 1, 'Chat action did not create a room.');
  await until(() => js("!document.querySelector('#view-workspace').hidden"), 'Chat action did not navigate.');
  assert.deepEqual(services.snapshot().conversations[0].participants, ['antigravity']);
  await js("document.querySelector('#task-description').value='readiness fixture';document.querySelector('#task-description').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await js("document.querySelector('#submit-task').disabled"), false);
  assert.equal(calls, 0, 'Opening a chat must not send a request.');
  report.checks.push('Ready action opens the chosen solo Agent room, preserves defaults, and never sends a model request.');

  await services.stopBridge();
  await js("document.querySelector('.nav-item[data-view=apps]').click()");
  await until(() => js("document.querySelector('[data-agent-primary=antigravity]').disabled"), 'Stopped service did not disable chat action.');
  assert.equal(await js("document.querySelector('#submit-task').disabled"), true);
  await services.startBridge();
  await services.refreshStatus({ refreshQuota: false });
  await until(() => js("!document.querySelector('[data-agent-primary=antigravity]').disabled"), 'Restarted service did not restore chat action.');
  signedIn = false;
  await services.refreshStatus({ refreshQuota: false });
  await until(() => js("document.querySelector('[data-agent-row=codex]').dataset.readiness==='needs-login'"), 'Signed-out state missing.');
  await js("document.querySelector('[data-agent-primary=codex]').click()");
  assert.equal(await js("!!document.querySelector('[data-login-agent=codex]')"), true);
  await js("document.querySelector('[data-close-inspector]').click()");
  const task = services.store.create({workspace:root,workflow:'antigravity',mode:'implement',task:'fixture execution history'});
  services.store.update(task.id, {status:'completed',stages:[{agent:'antigravity',status:'completed',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),output:'fixture'}]});
  await services.refreshStatus({refreshQuota:false});
  await until(()=>js("document.querySelector('[data-agent-row=antigravity]').textContent.includes('最近執行成功')"),'Execution history missing.');
  report.checks.push('Saved execution evidence is shown separately from CLI and authentication status.');
  window.setSize(900, 700);
  await pause(120);
  assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"), true, 'Overview must not overflow horizontally.');
  await capture('03-compact');
  report.checks.push('Service and sign-in gates agree across management and composer; compact window avoids horizontal overflow.');
  report.ready = true;
  await instance.shutdown();
} catch (error) {
  report.error = error.stack || error.message;
  if (instance) {
    writeFileSync(path.join(artifacts, 'failure.png'), (await instance.window.webContents.capturePage()).toPNG());
    await instance.shutdown();
  } else { writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); process.exitCode = 1; }
}

}
main().catch(error => { console.error(error); process.exitCode = 1; });
