import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../src/agent-runtime.js';
import { createDesktopApp } from '../src/desktop/desktop-app.js';

// Explicit manual smoke: two completed real model requests and two runs canceled
// during startup. Creates only the named fixture file in this isolated workspace.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.bridge', 'antigravity-live-smoke');
const dataDirectory = path.join(artifacts, `run-${Date.now()}`);
const workspace = path.join(dataDirectory, 'workspace');
mkdirSync(workspace, { recursive: true });
const env = { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') };
delete env.Path;
const actual = createAgentRuntime({ env, runtimeDirectory: path.join(dataDirectory, 'runtime'), timeoutMs: 120_000 });
const report = { passed: false, rendererErrors: [], results: [], processAgents: [], workspace, runCalls: 0 };
const save = () => writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
const runtime = {
  probe: options => actual.probe(options), probeAgent: (...args) => actual.probeAgent(...args),
  activeProcesses: () => actual.activeProcesses(), close: () => actual.close(),
  run(task, options = {}) {
    report.runCalls++;
    assert.equal(task.workflow, 'antigravity', 'This smoke must not spend another provider’s model usage.');
    return actual.run(task, { ...options, onProgress(event) {
      if (event.type === 'process') report.processAgents.push(event.agent);
      options.onProgress?.(event);
    } });
  },
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, reason, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await pause(80); }
  throw new Error(reason);
}
let instance;
async function main() {
  try {
    instance = await createDesktopApp({ dataDirectory, runtime, port: 0,
      appManager: { list: async () => ({}), dispose: async () => {} },
      usageMonitor: { get: () => ({checkedAt:new Date().toISOString()}), refresh: async () => ({}) },
      onShutdownComplete(snapshot) {
        report.listenerStopped = snapshot.bridge.state === 'stopped';
        report.remainingProcesses = snapshot.processes;
        report.closeCanceled = snapshot.tasks.find(task => task.id === report.closeTaskId)?.status === 'cancelled';
        report.passed = report.preClosePassed === true && !report.error && !report.rendererErrors.length
          && report.listenerStopped && !report.remainingProcesses.length && report.closeCanceled
          && report.processAgents.length >= 4 && report.processAgents.every(agent => agent === 'antigravity');
        save();
        if (!report.passed) process.exitCode = 1;
      },
    });
    assert.ok(instance);
    const { window, services } = instance;
    window.webContents.on('console-message', event => { if (event.level === 'error') report.rendererErrors.push(event.message); });
    const js = code => window.webContents.executeJavaScript(code);
    report.agent = services.snapshot().agents.antigravity;
    assert.equal(report.agent.available, true, report.agent.error);
    assert.equal(report.agent.headless, true);
    assert.equal(report.agent.authenticated, null, 'A marker must remain distinct from verified account status.');
    assert.ok(path.isAbsolute(report.agent.commandPath));
    services.updateSettings({ workspace });
    await until(() => js(`document.querySelector('#task-workspace').value===${JSON.stringify(workspace)}`), 'Workspace did not reach the renderer.');
    await js("document.querySelector('#chat-options').open=true;(()=>{const chip=id=>document.querySelector('[data-participant='+id+']');if(!chip('antigravity').classList.contains('selected'))chip('antigravity').click();let other;while((other=Array.from(document.querySelectorAll('[data-participant].selected')).find(el=>el.dataset.participant!=='antigravity')))other.click()})();document.querySelector('#chat-options').open=false");
    assert.deepEqual(await js("Array.from(document.querySelectorAll('[data-participant].selected')).map(el=>el.dataset.participant)"), ['antigravity']);
    const send = async message => {
      await until(() => js("!document.querySelector('#task-description').disabled&&!document.querySelector('#submit-task').hidden"), 'Composer did not become ready.');
      await js("document.querySelector('#task-description').focus()");
      await window.webContents.insertText(message);
      await until(() => js("!document.querySelector('#submit-task').disabled"), 'Antigravity send remained disabled.');
      await js("document.querySelector('#submit-task').click()");
      const findTask = () => services.snapshot().tasks.find(task => task.task === message);
      await until(() => !!findTask(), 'Message did not reach IPC.');
      return findTask;
    };
    const finish = async (findTask, marker) => {
      await until(() => ['completed', 'failed', 'paused', 'cancelled'].includes(findTask()?.status), 'Antigravity did not finish.', 150_000);
      const task = findTask();
      assert.equal(task.status, 'completed', task.error || task.pauseReason);
      assert.equal(task.workflow, 'antigravity');
      assert.ok(task.stages.every(stage => stage.agent === 'antigravity'));
      assert.ok(task.output.includes(marker), task.output);
      await until(() => js(`Array.from(document.querySelectorAll('[data-message-role=antigravity]')).some(el=>el.textContent.includes(${JSON.stringify(marker)}))`), 'Real Antigravity reply was not rendered.');
      await until(() => actual.activeProcesses().length === 0, 'Completed CLI was not cleaned up.');
      report.results.push({ taskId: task.id, status: task.status, output: task.output, stages: task.stages.map(({ agent, status, usage }) => ({ agent, status, usage })) });
      save();
    };
    await finish(await send('請只回覆 BRIDGE_ANTIGRAVITY_CHAT_OK。這是連線驗證，不要讀寫檔案、執行命令或使用工具。'), 'BRIDGE_ANTIGRAVITY_CHAT_OK');
    await finish(await send('請使用檔案寫入工具，在目前工作資料夾建立 agent-smoke.txt，內容必須恰好為 BRIDGE_ANTIGRAVITY_FILE_OK 加上一個換行。只操作這個檔案，不要執行 shell、改設定或存取其他路徑。完成後回覆 BRIDGE_ANTIGRAVITY_FILE_OK。'), 'BRIDGE_ANTIGRAVITY_FILE_OK');
    assert.equal(readFileSync(path.join(workspace, 'agent-smoke.txt'), 'utf8').replace(/\r\n/g, '\n'), 'BRIDGE_ANTIGRAVITY_FILE_OK\n');
    report.fileVerified = true;
    await js("if(document.querySelector('#toggle-inspector').getAttribute('aria-expanded')!=='true')document.querySelector('#toggle-inspector').click();document.querySelector('[data-inspector-tab=system]').click()");
    await until(() => js("document.querySelector('#inspector-body').textContent.includes('CLI 可用')"), 'System pane did not show ready CLI.');
    assert.equal(await js("document.querySelector('#inspector-body').textContent.includes('CLI 不可用')"), false);
    writeFileSync(path.join(artifacts, 'system-ready.png'), (await window.webContents.capturePage()).toPNG());
    await js("document.querySelector('[data-inspector-tab=usage]').click()");
    await until(() => js("document.querySelector('[data-zone=tokens] [data-usage-agent=antigravity]')"), 'Antigravity token usage missing.');
    assert.equal(await js("document.querySelector('[data-zone=quota] [data-usage-agent=antigravity]').textContent.includes('暫不支援查詢')"), true);
    assert.equal(await js("document.querySelector('[data-zone=tokens] [data-usage-agent=antigravity] .ins-meter-value').textContent.trim().startsWith('0 tokens')"), false, 'Real Antigravity usage must appear.');
    report.usageVisible = true;

    writeFileSync(path.join(artifacts, 'agent-ready.png'), (await window.webContents.capturePage()).toPNG());

    const cancelTask = await send('這是取消流程測試，請只回覆 CANCEL_TEST_MARKER，不要使用工具。');
    await until(() => actual.activeProcesses().some(process => process.agent === 'antigravity'), 'Cancelable CLI never started.');
    await until(() => js("!document.querySelector('#cancel-current-task').hidden&&!document.querySelector('#cancel-current-task').disabled"), 'Cancel button not ready.');
    await js("document.querySelector('#cancel-current-task').click()");
    await until(() => cancelTask()?.status === 'cancelled' && !actual.activeProcesses().length, 'Cancel did not clean its CLI.');
    report.cancelPassed = true;

    const closeTask = await send('這是關閉清理測試，請只回覆 CLOSE_TEST_MARKER，不要使用工具。');
    report.closeTaskId = closeTask().id;
    await until(() => actual.activeProcesses().some(process => process.agent === 'antigravity'), 'CLI for close cleanup never started.');
    report.preClosePassed = report.fileVerified && report.cancelPassed && report.results.length === 2;
    window.close();
  } catch (error) {
    report.error = error.stack || error.message;
    if (instance && !instance.window.isDestroyed()) writeFileSync(path.join(artifacts, 'failure.png'), (await instance.window.webContents.capturePage()).toPNG());
    if (instance) await instance.shutdown();
    else { await actual.close(); save(); process.exitCode = 1; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
