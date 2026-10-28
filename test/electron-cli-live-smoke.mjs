import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../src/agent-runtime.js';
import { createDesktopApp } from '../src/desktop/desktop-app.js';

// Explicit opt-in: this smoke sends one short real request to each provider.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.bridge', 'cli-live-smoke');
const dataDirectory = path.join(artifacts, `run-${Date.now()}`);
const workspace = mkdtempSync(path.join(os.tmpdir(), 'bridge-cli-live-'));
mkdirSync(dataDirectory, { recursive: true });
const env = { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') };
delete env.Path;
const actual = createAgentRuntime({ env, runtimeDirectory: path.join(dataDirectory, 'runtime'), timeoutMs: 120000 });
let calls = 0;
// Omit the quota warm-up; only the two explicit test messages consume model usage.
const runtime = { probe: options => actual.probe(options), run: (task, options) => { calls++; return actual.run(task, options); },
  activeProcesses: () => actual.activeProcesses(), close: () => actual.close() };
const report = { passed: false, results: [], rendererErrors: [], dataDirectory, workspace };
const save = () => writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
let instance;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, reason, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await pause(100); }
  throw new Error(reason);
}
async function main() {
  try {
    instance = await createDesktopApp({ dataDirectory, port: 0, runtime,
      appManager: { list: async () => ({}), dispose: async () => {} },
      usageMonitor: { get: () => ({}), refresh: async () => ({}) },
      onShutdownComplete(snapshot) {
        report.listenerStopped = snapshot.bridge.state === 'stopped'; report.remainingProcesses = snapshot.processes; report.calls = calls;
        report.passed = report.preClosePassed === true && !report.error && !report.rendererErrors.length && report.listenerStopped && !report.remainingProcesses.length && calls === 2;
        save();
      },
    });
    assert.ok(instance);
    const { window, services } = instance;
    report.url = services.snapshot().bridge.url;
    report.agents = services.snapshot().agents;
    window.webContents.on('console-message', event=>{if(event.level==='error')report.rendererErrors.push(event.message);});
    const js = code => window.webContents.executeJavaScript(code);
    const click = async selector => {
      const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing target');const r=e.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);return{x,y,hit:document.elementFromPoint(x,y)?.closest(${JSON.stringify(selector)})===e}})()`);
      assert.equal(point.hit, true, `Obstructed click: ${selector}`);
      window.focus(); window.webContents.focus();
      window.webContents.sendInputEvent({ type:'mouseDown', x:point.x, y:point.y, button:'left', clickCount:1 });
      window.webContents.sendInputEvent({ type:'mouseUp', x:point.x, y:point.y, button:'left', clickCount:1 });
    };
    for(const agent of ['codex','claude']) {
      assert.equal(report.agents[agent].available, true);
      assert.equal(report.agents[agent].authenticated, true);
      assert.ok(path.isAbsolute(report.agents[agent].commandPath));
    }
    services.updateSettings({ workspace });
    await until(()=>js(`document.querySelector('#task-workspace').value===${JSON.stringify(workspace)}`),'Working folder did not arrive in renderer.');
    for(const agent of ['codex','claude']) {
      await click('#new-conversation');
      await until(()=>js("document.querySelectorAll('[data-message-role]').length===0&&!document.querySelector('#task-description').disabled"),'New room was not ready.');
      await click('#chat-options summary');
      await click(`[data-workflow="${agent}"]`);
      const marker = `BRIDGE_${agent.toUpperCase()}_LIVE_OK`;
      const message = `本次只驗證聊天室傳送與回覆。請只回覆 ${marker}，不要讀寫檔案、執行指令或呼叫任何工具。`;
      await js("document.querySelector('#task-description').focus()");
      await window.webContents.insertText(message);
      await until(()=>js("!document.querySelector('#submit-task').disabled&&!document.querySelector('#submit-task').hidden"),'Send was not enabled.');
      assert.equal(await js("document.querySelector('#composer-error').hidden"), true);
      if(agent==='codex') {
        window.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
        window.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
      } else await click('#submit-task');
      const findTask = () => services.snapshot().tasks.find(task=>task.task===message);
      await until(()=>Boolean(findTask()),`${agent} message did not reach IPC.`);
      await until(()=>['completed','failed','paused','cancelled'].includes(findTask()?.status),`${agent} did not finish.`,150000);
      const task = findTask();
      assert.equal(task.status, 'completed', task.error || task.pauseReason);
      assert.equal(task.workflow, agent);
      assert.ok(task.output.includes(marker), `${agent} did not return the requested marker.`);
      await until(()=>js(`Array.from(document.querySelectorAll('[data-message-role]')).some(e=>e.dataset.messageRole===${JSON.stringify(agent)}&&e.textContent.includes(${JSON.stringify(marker)}))`),`${agent} real reply was not rendered.`);
      await until(()=>js("document.querySelector('#cancel-current-task').hidden&&!document.querySelector('#submit-task').hidden"),`${agent} completed status was not rendered.`);
      report.results.push({ agent, sendMethod:agent==='codex'?'Enter':'mouse', status:task.status, output:task.output, taskId:task.id });
      save();
      writeFileSync(path.join(artifacts, `${agent}.png`),(await window.webContents.capturePage()).toPNG());
    }
    assert.equal(services.store.listAll().length, 2);
    report.preClosePassed = true;
    window.close();
  } catch(error) {
    report.error = error.stack || error.message;
    if(instance&&!instance.window.isDestroyed())writeFileSync(path.join(artifacts,'failure.png'),(await instance.window.webContents.capturePage()).toPNG());
    if(instance)await instance.shutdown();else{await actual.close();save();process.exitCode=1;}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
