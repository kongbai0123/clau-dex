import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopApp } from '../src/desktop/desktop-app.js';

// Run sequentially in separate Electron processes:
//   electron test/electron-session-smoke.mjs --phase=write
//   electron test/electron-session-smoke.mjs --phase=restore
//   electron test/electron-session-smoke.mjs --phase=verify-solo
// Only isolated settings and fake provider status are used. No App or model is started.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.bridge', 'session-smoke');
const stateFile = path.join(artifacts, 'state.json');
const phase = process.argv.find(argument => argument.startsWith('--phase='))?.slice('--phase='.length) || 'write';
assert.ok(['write', 'restore', 'verify-solo'].includes(phase), `Unknown phase: ${phase}`);
mkdirSync(artifacts, { recursive: true });
const saved = phase === 'write' ? { dataDirectory: path.join(artifacts, `run-${Date.now()}-${process.pid}`) }
  : JSON.parse(readFileSync(stateFile, 'utf8'));
const dataDirectory = path.resolve(saved.dataDirectory);
const relative = path.relative(artifacts, dataDirectory);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Session smoke must never open a production profile.');
mkdirSync(dataDirectory, { recursive: true });
if (phase === 'write') writeFileSync(stateFile, JSON.stringify(saved, null, 2));

const expectedTeam = { participants: ['codex', 'claude', 'antigravity'], coordinator: 'claude', effort: { codex: 'high', claude: 'medium' } };
const expectedSolo = { participants: ['antigravity'], coordinator: 'codex', effort: { codex: 'high', claude: 'medium' } };
const report = { phase, passed: false, checks: [], rendererErrors: [], dataDirectory };
let runtimeClosed = false;
let appManagerDisposed = false;
let appLaunches = 0;
let providerCalls = 0;
let probeCalls = 0;
const agentStatus = id => ({ available: true, version: `${id} fixture ${probeCalls}`, error: null,
  ...(id === 'antigravity' ? { authenticated: null, credentialPresent: true, authSource: 'credential-entry', headless: true }
    : { authenticated: true, authSource: 'cli-status' }) });
const runtime = {
  probe: async () => { probeCalls++; return Object.fromEntries(['codex', 'claude', 'antigravity'].map(id => [id, agentStatus(id)])); },
  activeProcesses: () => [], close: async () => { runtimeClosed = true; },
  run: async () => { providerCalls++; throw new Error('Session smoke must never request a model.'); },
};
const appManager = {
  list: async () => Object.fromEntries(['codex', 'claude', 'antigravity'].map(id => [id, { installed: false, running: false, managed: false, pids: [], rootProcesses: [], error: null }])),
  launch: async () => { appLaunches++; throw new Error('Session smoke must never launch an AI desktop App.'); },
  dispose: async () => { appManagerDisposed = true; },
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, reason) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await condition()) return; await pause(60); }
  throw new Error(reason);
}
const sameDefaults = (actual, expected) => JSON.stringify(actual?.participants) === JSON.stringify(expected.participants)
  && actual?.coordinator === expected.coordinator && actual?.effort?.codex === expected.effort.codex && actual?.effort?.claude === expected.effort.claude;
const saveReport = () => writeFileSync(path.join(artifacts, `${phase}-report.json`), JSON.stringify(report, null, 2));
let instance;
async function main() {
  try {
    instance = await createDesktopApp({ dataDirectory, port: 0, runtime, appManager,
      usageMonitor: { get: () => ({}), refresh: async () => ({}) },
      onShutdownComplete(snapshot) {
        report.listenerStopped = snapshot.bridge.state === 'stopped';
        report.remainingProcesses = snapshot.processes;
        report.runtimeClosed = runtimeClosed; report.appManagerDisposed = appManagerDisposed;
        report.appLaunches = appLaunches; report.providerCalls = providerCalls; report.probeCalls = probeCalls;
        report.savedDefaults = snapshot.settings.agentDefaults;
        report.passed = report.preClosePassed === true && !report.error && !report.rendererErrors.length
          && report.listenerStopped && !report.remainingProcesses.length && runtimeClosed && appManagerDisposed
          && appLaunches === 0 && providerCalls === 0;
        saveReport();
        if (!report.passed) process.exitCode = 1;
      },
    });
    assert.ok(instance, 'The isolated session must own its window.');
    const { window, services } = instance;
    window.webContents.on('console-message', event => { if (event.level === 'error') report.rendererErrors.push(event.message); });
    const js = code => window.webContents.executeJavaScript(code);
    const selection = () => js("({participants:Array.from(document.querySelectorAll('[data-participant].selected')).map(el=>el.dataset.participant),coordinator:document.querySelector('[data-coordinator].selected')?.dataset.coordinator,effort:{codex:document.querySelector('#effort-codex').dataset.level,claude:document.querySelector('#effort-claude').dataset.level}})");
    const assertSelection = async expected => {
      await until(async () => {
        const actual = await selection();
        // A solo executor has no coordinator selector; its persisted coordinator uses the registry fallback.
        return JSON.stringify(actual.participants) === JSON.stringify(expected.participants)
          && (expected.participants.length === 1 || actual.coordinator === expected.coordinator)
          && JSON.stringify(actual.effort) === JSON.stringify(expected.effort);
      }, 'Saved Agent preferences did not reach the renderer.');
    };
    const assertSaved = expected => until(() => sameDefaults(services.snapshot().settings.agentDefaults, expected), 'Agent preferences were not durably saved.');
    const refreshAndObserve = async () => {
      const beforeRefresh = probeCalls;
      await services.refreshStatus({ refreshQuota: false });
      await until(() => probeCalls > beforeRefresh, 'Status refresh did not run.');
      const expectedVersion = `codex fixture ${probeCalls}`;
      await until(() => js(`document.querySelector('#app-cards').textContent.includes(${JSON.stringify(expectedVersion)})`), 'The refreshed snapshot did not reach the renderer.');
    };
    const capture = async name => {
      await js("document.querySelector('#chat-options').open=true");
      await pause(180);
      writeFileSync(path.join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    };
    await until(() => js("document.querySelector('[data-participant=antigravity]')&&!document.querySelector('#new-conversation').disabled"), 'Session renderer did not become ready.');

    if (phase === 'write') {
      await js("document.querySelector('#chat-options').open=true;if(!document.querySelector('[data-participant=antigravity]').classList.contains('selected'))document.querySelector('[data-participant=antigravity]').click()");
      await js("document.querySelector('[data-coordinator=claude]').click()");
      await js("for(const [id,value] of [['codex','3'],['claude','2']]){const slider=document.querySelector('#effort-'+id);slider.value=value;slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new Event('change',{bubbles:true}))}");
      await assertSaved(expectedTeam);
      await assertSelection(expectedTeam);
      report.checks.push('Agent selection, coordinator and effort are saved from the real controls.');
      await capture('three-agents-saved');
    } else {
      const expected = phase === 'restore' ? expectedTeam : expectedSolo;
      await assertSaved(expected);
      await assertSelection(expected);
      report.checks.push('A separate Electron process restored the last Agent preferences.');
      if (phase === 'verify-solo') {
        const oldRoom = services.snapshot().conversations.find(room =>
          JSON.stringify(room.participants) === JSON.stringify(expectedTeam.participants) && room.coordinator === expectedTeam.coordinator);
        assert.ok(oldRoom, 'The earlier three-Agent conversation must remain available.');
        const selector = `[data-conversation-id="${oldRoom.id}"]`;
        await until(() => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), 'The earlier conversation was not shown in recent history.');
        await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await assertSelection(expectedTeam);
        await refreshAndObserve();
        await assertSelection(expectedTeam);
        await assertSaved(expectedSolo);
        assert.deepEqual(services.snapshot().conversations.find(room => room.id === oldRoom.id).participants, expectedTeam.participants);
        report.checks.push('Viewing and refreshing an older conversation preserves its own Agents without changing the saved defaults.');
      }
      const previousRooms = services.snapshot().conversations.length;
      await js("document.querySelector('#chat-options').open=false;document.querySelector('#new-conversation').click()");
      await until(() => services.snapshot().conversations.length > previousRooms, 'New conversation was not created.');
      await assertSelection(expected);
      const newest = services.snapshot().conversations[0];
      assert.deepEqual(newest.participants, expected.participants);
      assert.deepEqual(newest.effort, expected.effort);
      assert.equal(newest.coordinator, expected.coordinator);
      report.checks.push('A new conversation inherits the restored preferences without launching desktop Apps.');
      if (phase === 'verify-solo') report.checks.push('A new conversation after viewing older history uses the saved solo Antigravity preference.');

      if (phase === 'restore') {
        await js("document.querySelector('#chat-options').open=true;for(const id of ['codex','claude']){const chip=document.querySelector('[data-participant='+id+']');if(chip.classList.contains('selected'))chip.click()}");
        await assertSaved(expectedSolo);
        await assertSelection(expectedSolo);
        await refreshAndObserve();
        await assertSelection(expectedSolo);
        await assertSaved(expectedSolo);
        report.checks.push('A solo Antigravity preference survives a provider status refresh.');
        await capture('solo-antigravity-saved');
      } else await capture('solo-antigravity-restored');
    }
    assert.equal(appLaunches, 0); assert.equal(providerCalls, 0);
    report.preClosePassed = true;
    window.close();
  } catch (error) {
    report.error = error.stack || error.message;
    if (instance) await instance.shutdown();
    else { saveReport(); process.exitCode = 1; }
  }
}
main().catch(error => { report.error = error.stack || error.message; saveReport(); console.error(error); process.exitCode = 1; });
