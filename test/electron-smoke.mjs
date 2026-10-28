import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../src/agent-runtime.js';
import { createDesktopApp } from '../src/desktop/desktop-app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.bridge', 'smoke');
const data = path.join(artifacts, `run-${Date.now()}`);
mkdirSync(data, { recursive: true });
const capture = path.join(data, 'capture.jsonl');
const fixture = path.join(root, 'test', 'fixtures', 'fake-runtime-agent.js');
const command = (agent, scenario) => ({ command: 'node', args: [fixture, agent, scenario, capture] });
const chatRuntime = createAgentRuntime({ claudeCommand: command('claude', 'chat'), codexCommand: command('codex', 'chat'), runtimeDirectory: path.join(data, 'runtime') });
const holdRuntime = createAgentRuntime({ claudeCommand: command('claude', 'hold'), codexCommand: command('codex', 'chat'), runtimeDirectory: path.join(data, 'holding') });
const runtime = {
  probe: options => chatRuntime.probe(options),
  run: (task, options) => (task.task.startsWith('等待') ? holdRuntime : chatRuntime).run(task, options),
  activeProcesses: () => [...chatRuntime.activeProcesses(), ...holdRuntime.activeProcesses()],
  close: () => Promise.all([chatRuntime.close(), holdRuntime.close()]),
};
let disposed = 0; let nativeCloseCount = 0;
const info = { installed: true, running: true, managed: false, pids: [] };
const appManager = { list: async () => ({ codex: info, claude: info }), closeOwned: async () => { nativeCloseCount++; return { codex: info, claude: info }; }, dispose: async () => { disposed++; } };
const report = { passed: false, checks: [], workerPids: [], url: '' };
let instance;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, message) {
  for (let i = 0; i < 150; i++) { if (await condition()) return; await pause(80); }
  throw new Error(message);
}
async function runSmoke() {
  try {
    instance = await createDesktopApp({ dataDirectory: data, runtime, appManager, port: 0,
      onShutdownComplete(snapshot) {
        report.stopped = snapshot.bridge.state === 'stopped' && snapshot.processes.length === 0;
        report.tasks = snapshot.tasks.map(task => ({ id: task.id, task: task.task, status: task.status }));
        report.nativeCloseCount = nativeCloseCount; report.disposed = disposed;
        report.passed = report.preClosePassed === true && report.stopped && nativeCloseCount === 1 && disposed === 1;
        writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
      },
    });
    assert.ok(instance);
    const { window, services } = instance;
    const js = code => window.webContents.executeJavaScript(code);
    const send = async (message, { expectOverlay = false } = {}) => {
      await js("document.querySelector('#task-description').focus(); document.querySelector('#task-description').select()");
      await window.webContents.insertText(message);
      await until(() => js("!document.querySelector('#submit-task').disabled && !document.querySelector('#submit-task').hidden"), 'Send button did not enable after real text entry.');
      const point = await js("(()=>{const button=document.querySelector('#submit-task');const rect=button.getBoundingClientRect();const x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);const hit=document.elementFromPoint(x,y);return{x,y,hit:hit?.closest('button')?.id,hitTag:hit?.outerHTML?.slice(0,250),rect:rect.toJSON(),viewport:{width:innerWidth,height:innerHeight},workspaceHidden:document.querySelector('#view-workspace').hidden,scroll:document.querySelector('#main-content').scrollTop}})()");
      if (point.hit !== 'submit-task') { report.obstructedButton = point; writeFileSync(path.join(artifacts, 'send-obstructed.png'), (await window.webContents.capturePage()).toPNG()); }
      if (expectOverlay) {
        const overlay = await js("(()=>{const toast=document.querySelector('#toast'),r=toast.getBoundingClientRect(),b=document.querySelector('#submit-task').getBoundingClientRect();return{visible:!toast.hidden,overlaps:r.left<b.right&&r.right>b.left&&r.top<b.bottom&&r.bottom>b.top,pointerEvents:getComputedStyle(toast).pointerEvents}})()");
        assert.deepEqual(overlay, { visible: true, overlaps: true, pointerEvents: 'none' });
        report.toastOverlay = overlay;
      }
      assert.equal(point.hit, 'submit-task', 'Another element obstructs the send button.');
      window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    };
    const task = message => services.snapshot().tasks.find(item => item.task === message);
    const newChat = async () => {
      const count = services.snapshot().conversations.length;
      await js("document.querySelector('#new-conversation').click()");
      await until(() => services.snapshot().conversations.length > count, 'New room was not persisted.');
      await until(() => js("document.querySelectorAll('[data-message-role]').length === 0"), 'New room did not clear transcript.');
    };
    report.url = services.snapshot().bridge.url;
    await until(() => js("Boolean(window.bridge) && Boolean(document.querySelector('#task-description'))"), 'Renderer did not connect to IPC.');
    await pause(200);
    assert.equal(await js("document.querySelector('#submit-task').getBoundingClientRect().bottom <= window.innerHeight"), true);
    assert.equal(await js("document.querySelectorAll('[data-mode],#mode-description').length"), 0);
    const oldRoom = services.createConversation({ workspace: root, mode: 'review' });
    await until(() => js(`Boolean(document.querySelector('[data-conversation-id="${oldRoom.id}"]'))`), 'Existing review room did not appear.');
    await js(`document.querySelector('[data-conversation-id="${oldRoom.id}"]').click()`);
    assert.equal(await js("document.querySelector('#composer-mode-label').textContent.includes('只讀')"), false);
    writeFileSync(path.join(artifacts, 'workspace.png'), (await window.webContents.capturePage()).toPNG());
    report.checks.push('Clean chat and composer visible without a work-mode selector, including old review rooms');
    await js("const input=document.querySelector('#task-description'); input.value='中文輸入驗證'; input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})); input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})); input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true}))");
    await pause(120); assert.equal(services.snapshot().tasks.length, 0);
    report.checks.push('Chinese IME and Shift+Enter do not submit accidentally');
    const firstMessage = '請整理聊天室設計並請 Claude 複核。\n<img src=x onerror="window.chatInjected=true">';
    await send(firstMessage);
    await until(() => task(firstMessage)?.status === 'completed', 'Coordinated chat did not finish.');
    const first = task(firstMessage);
    assert.equal(first.mode, 'implement');
    assert.equal(first.conversationId, oldRoom.id);
    await until(() => js("document.querySelectorAll('[data-message-role]').length === 4"), 'Three-party message transcript did not render.');
    assert.deepEqual(await js("Array.from(document.querySelectorAll('[data-message-role]')).map(item => item.dataset.messageRole)"), ['user', 'codex', 'claude', 'codex']);
    assert.equal(await js("document.querySelector('#chat-messages').textContent.includes('codexTask')"), false);
    assert.equal(await js("Boolean(window.chatInjected) || Boolean(document.querySelector('#chat-messages img'))"), false);
    await until(() => js("!document.querySelector('#task-workspace').disabled && !document.querySelector('#task-workspace').readOnly"), 'Working folder stayed locked after the reply completed.');
    report.checks.push('Chronological roles, plain planner reply, editable working folder');
    await js("document.querySelector('#task-description').focus(); document.querySelector('#task-description').select()");
    await window.webContents.insertText('好');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until(() => task('好')?.status === 'completed', 'One-character follow-up failed.');
    assert.equal(task('好').conversationId, first.conversationId);
    assert.ok(task('好').conversationContext.some(message => message.role === 'user' && message.content.includes('請整理聊天室')));
    const executions = readFileSync(capture, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(executions.some(item => item.input.includes('請整理聊天室') && item.input.includes('"role":"user"')));
    await until(() => js("document.querySelectorAll('[data-message-role]').length === 8"), 'Follow-up replies did not render.');
    const additionalRequest = '再追加一項要求：請把前面提到的聊天室設計加入訊息時間。';
    await send(additionalRequest);
    await until(() => task(additionalRequest)?.status === 'completed', 'Additional requirement after completion did not finish.');
    const additional = task(additionalRequest);
    assert.equal(additional.mode, 'implement');
    assert.equal(additional.conversationId, first.conversationId);
    assert.ok(additional.conversationContext.some(message => message.role === 'user' && message.content === firstMessage));
    assert.ok(additional.conversationContext.some(message => message.role === 'codex'));
    assert.ok(additional.conversationContext.some(message => message.role === 'claude'));
    const continuedExecutions = readFileSync(capture, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(item => item.input.includes(additionalRequest));
    assert.equal(continuedExecutions.length, 3);
    assert.ok(continuedExecutions.every(item => item.input.includes('請整理聊天室') && item.input.includes('"role":"user"')));
    assert.ok(continuedExecutions.some(item => item.agent === 'claude' && item.args.includes('bypassPermissions')));
    // The coordinator's review is read-only; it returns work for revision instead of editing it.
    const review = continuedExecutions.find(item => item.input.includes('You are the reviewer'));
    assert.ok(review && review.agent === 'codex' && review.args.includes('read-only') && review.args.includes('--output-schema'));
    await until(() => js("document.querySelectorAll('[data-message-role]').length === 12"), 'Appended requirement replies did not render.');
    writeFileSync(path.join(artifacts, 'chat.png'), (await window.webContents.capturePage()).toPNG());
    report.checks.push('Short follow-up persists and provider receives prior context');
    report.checks.push('Completed conversation accepts additional requirements with prior three-party context and implementation capability');
    await js("document.querySelector('[data-view=apps]').click()"); await pause(100);
    assert.equal(await js("document.querySelector('#view-apps').hidden"), false);
    assert.equal(await js("Array.from(document.querySelectorAll('[data-close-app]')).every(button => button.disabled)"), true);
    writeFileSync(path.join(artifacts, 'apps.png'), (await window.webContents.capturePage()).toPNG());
    report.checks.push('Separate App management retains ownership safeguards');
    await js("document.querySelector('[data-view=settings]').click(); document.querySelector('#close-launched-apps').click()");
    await until(() => services.snapshot().settings.closeLaunchedApps, 'Shutdown preference not saved.');
    await js("document.querySelector('[data-view=workspace]').click(); document.querySelector('[data-workflow=claude]').click()");
    // Recreate the old obstruction even when the product notification moves elsewhere.
    await js("showToast('通知出現時，傳送按鈕仍可點擊'); const toast=document.querySelector('#toast'); toast.style.top='auto'; toast.style.bottom='24px'");
    assert.equal(await js("document.querySelector('#toast').hidden"), false);
    await send('等待取消驗證', { expectOverlay: true });
    await js("document.querySelector('#toast').style.removeProperty('top'); document.querySelector('#toast').style.removeProperty('bottom')");
    await until(() => task('等待取消驗證')?.status === 'running' && existsSync(`${capture}.child`), 'Holding worker did not start.');
    await until(() => js("Boolean(document.querySelector('[data-cancel-task]'))"), 'Stop action did not render.');
    await js("document.querySelector('[data-cancel-task]').click()");
    await until(() => task('等待取消驗證')?.status === 'cancelled', 'Stop did not terminate worker tree.');
    report.checks.push('Real send click works while a settings notification overlays the composer; stop cancels owned process tree');
    await newChat(); await pause(120);
    await js("document.querySelector('[data-workflow=claude]').click()");
    await send('等待關閉視窗驗證');
    await until(() => task('等待關閉視窗驗證')?.status === 'running', 'Second room worker did not start.');
    await until(() => runtime.activeProcesses().length > 0, 'No owned process tracked.'); await pause(250);
    report.workerPids = [...runtime.activeProcesses().map(item => item.pid), Number(readFileSync(`${capture}.child`, 'utf8'))];
    await newChat(); await pause(120); await send('等待佇列驗證');
    await until(() => task('等待佇列驗證')?.status === 'queued', 'Other-room message not queued.');
    assert.notEqual(task('等待佇列驗證').conversationId, task('等待關閉視窗驗證').conversationId);
    assert.deepEqual(task('等待佇列驗證').conversationContext, []);
    writeFileSync(path.join(artifacts, 'running.png'), (await window.webContents.capturePage()).toPNG());
    report.checks.push('Room isolation and real window close with running and queued work');
    report.preClosePassed = true; window.close();
  } catch (error) {
    report.error = error.stack || error.message;
    writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    if (instance) await instance.shutdown(); else { await runtime.close(); process.exit(1); }
  }
}
runSmoke().catch(error => { console.error(error); process.exitCode = 1; });
