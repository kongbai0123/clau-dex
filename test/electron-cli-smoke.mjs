import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../src/agent-runtime.js';
import { createDesktopApp } from '../src/desktop/desktop-app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.bridge', 'cli-smoke');
const data = path.join(artifacts, `run-${Date.now()}`);
mkdirSync(data, { recursive: true });
const env = { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') };
delete env.Path;
const actual = createAgentRuntime({ env });
let providerCalls = 0;
const runtime = { probe: options => actual.probe(options), activeProcesses: () => actual.activeProcesses(), close: () => actual.close(), run: async () => { providerCalls++; throw new Error('Readiness smoke must not send a provider request.'); } };
const report = { passed: false, rendererErrors: [] };
let instance;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, reason) { for(let i=0;i<200;i++){if(await condition())return;await pause(80);}throw new Error(reason); }
async function main() {
  try {
    instance = await createDesktopApp({ dataDirectory: data, port: 0, runtime,
      appManager: { list: async () => ({}), dispose: async () => {} }, usageMonitor: { get: () => ({}), refresh: async () => ({}) },
      onShutdownComplete(snapshot) {
        report.bridgeStopped = snapshot.bridge.state === 'stopped'; report.remainingProcesses = snapshot.processes;
        report.passed = report.ready === true && !report.error && report.bridgeStopped && !report.remainingProcesses.length && !report.rendererErrors.length && providerCalls === 0;
        writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
      },
    });
    const { window, services } = instance;
    window.webContents.on('console-message', event=>{if(event.level==='error')report.rendererErrors.push(event.message);});
    const js = code => window.webContents.executeJavaScript(code);
    report.agents = services.snapshot().agents;
    for(const agent of ['codex','claude']){
      assert.equal(report.agents[agent].available, true);
      assert.equal(report.agents[agent].authenticated, true);
      assert.ok(path.isAbsolute(report.agents[agent].commandPath));
    }
    await until(()=>js("document.querySelector('#task-description')&&!document.querySelector('#task-description').disabled"),'Composer did not become ready.');
    await js("document.querySelector('#task-description').focus()");
    await window.webContents.insertText('CLI 連線驗證');
    await until(()=>js("!document.querySelector('#submit-task').disabled&&!document.querySelector('#submit-task').hidden"),'Send remained disabled despite working authenticated CLIs.');
    assert.equal(await js("document.querySelector('#composer-error').hidden"), true);
    // The AI picker is a multi-select: task-ready agents can be toggled, the rest are shown but disabled.
    await js("document.querySelector('#chat-options').open=true");
    const chips = await js("Array.from(document.querySelectorAll('[data-participant]')).map(el=>({id:el.dataset.participant,selected:el.classList.contains('selected'),disabled:el.disabled}))");
    assert.deepEqual(chips.map(chip=>chip.id), ['codex','claude','antigravity']);
    assert.deepEqual(chips.filter(chip=>chip.selected).map(chip=>chip.id), ['codex','claude']);
    assert.equal(chips.find(chip=>chip.id==='antigravity').disabled, true);
    writeFileSync(path.join(artifacts, 'options.png'), (await window.webContents.capturePage()).toPNG());
    await js("document.querySelector('#chat-options').open=false");
    await js("if(document.querySelector('#toggle-inspector').getAttribute('aria-expanded')!=='true')document.querySelector('#toggle-inspector').click();document.querySelector('[data-inspector-tab=system]').click()");
    const shownNames = JSON.stringify(['codex','claude'].map(agent => path.basename(report.agents[agent].commandPath)));
    await until(()=>js(`${shownNames}.every(name=>document.querySelector('#inspector-body').textContent.includes(name))`),'Discovered CLI paths were not shown.');
    writeFileSync(path.join(artifacts, 'ready.png'), (await window.webContents.capturePage()).toPNG());
    report.sendEnabled = true; report.providerCalls = providerCalls; report.ready = true;
    window.close();
  } catch(error) {
    report.error=error.stack||error.message;
    if(instance)await instance.shutdown(); else {await actual.close();writeFileSync(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));process.exitCode=1;}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
