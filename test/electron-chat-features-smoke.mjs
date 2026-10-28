import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createAgentRuntime } from '../src/agent-runtime.js';
import { createDesktopApp } from '../src/desktop/desktop-app.js';
const { clipboard, ClipboardItem } = createRequire(import.meta.url)('electron');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.bridge', 'chat-features-smoke');
const data = path.join(artifacts, `run-${Date.now()}`);
const ordinaryFolder = path.join(data, 'ordinary-folder');
mkdirSync(ordinaryFolder, { recursive: true });
const capture = path.join(data, 'providers.jsonl');
const fixture = path.join(root, 'test', 'fixtures', 'fake-runtime-agent.js');
const descriptor = (agent, scenario = 'chat') => ({ command: 'node', args: [fixture, agent, scenario, capture] });
const chat = createAgentRuntime({ claudeCommand: descriptor('claude'), codexCommand: descriptor('codex'), runtimeDirectory: path.join(data, 'runtime') });
const hold = createAgentRuntime({ claudeCommand: descriptor('claude', 'hold'), codexCommand: descriptor('codex'), runtimeDirectory: path.join(data, 'holding') });
const runtime = { probe: options => chat.probe(options), run: (task, options) => (task.task.startsWith('等待') ? hold : chat).run(task, options), activeProcesses: () => [...chat.activeProcesses(), ...hold.activeProcesses()], close: () => Promise.all([chat.close(), hold.close()]) };
const appManager = { list: async () => ({}), dispose: async () => {} };
const report = { passed: false, checks: [], rendererErrors: [] };
let instance;
let originalClipboard;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, message) { for (let i = 0; i < 160; i++) { if (await condition()) return; await pause(80); } throw new Error(message); }
async function main() {
  try {
    instance = await createDesktopApp({ dataDirectory: data, port: 0, runtime, appManager,
      onShutdownComplete(snapshot) {
        report.bridgeStopped = snapshot.bridge.state === 'stopped'; report.ownedProcesses = snapshot.processes;
        report.passed = report.preClosePassed === true && !report.error && report.bridgeStopped && !report.ownedProcesses.length && !report.rendererErrors.length;
        writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
      },
    });
    assert.ok(instance);
    const { window, services } = instance;
    window.webContents.on('console-message', event => { if (event.level === 'error') report.rendererErrors.push(event.message); });
    const js = code => window.webContents.executeJavaScript(code);
    const click = async selector => {
      const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing click target');const r=e.getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);return {x,y,hit:document.elementFromPoint(x,y)?.closest(${JSON.stringify(selector)})===e}})()`);
      assert.equal(point.hit, true, `Click target obstructed: ${selector}`);
      window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    };
    const enterText = async value => { await js("document.querySelector('#task-description').focus();document.querySelector('#task-description').select()"); await window.webContents.insertText(value); };
    const send = async value => { if (value !== undefined) await enterText(value); await until(() => js("!document.querySelector('#submit-task').disabled&&!document.querySelector('#submit-task').hidden"), 'Send stayed disabled or hidden.'); await click('#submit-task'); };
    const task = value => services.snapshot().tasks.find(item => item.task === value);
    services.updateSettings({ workspace: ordinaryFolder });
    await until(() => js(`document.querySelector('#task-workspace').value === ${JSON.stringify(ordinaryFolder)}`), 'Working folder did not update.');
    assert.equal(existsSync(path.join(ordinaryFolder, '.git')), false);
    report.checks.push('Ordinary non-Git working directory is accepted');
    const png = await js("(()=>{const c=document.createElement('canvas');c.width=200;c.height=130;const p=c.getContext('2d');p.fillStyle='white';p.fillRect(0,0,200,130);p.fillStyle='#e53935';p.beginPath();p.arc(55,65,30,0,Math.PI*2);p.fill();p.fillStyle='#1565c0';p.fillRect(115,35,60,60);return c.toDataURL('image/png')})()");
    report.imageFile = path.join(data, 'vision.png'); writeFileSync(report.imageFile, Buffer.from(png.split(',')[1], 'base64'));
    // Native clipboard and actual Ctrl+V exercise the browser paste path.
    originalClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type=>[type, await item.getType(type)]))))));
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(png.split(',')[1], 'base64')], { type: 'image/png' }) })]);
    report.clipboard = { hasPng: await clipboard.has('image/png'), types: (await clipboard.read()).flatMap(item=>item.types) };
    window.focus(); window.webContents.focus();
    await js("document.querySelector('#task-description').focus()");
    window.webContents.paste();
    await until(() => js("document.querySelectorAll('#draft-images img').length===1"), 'Clipboard image did not import.');
    await until(() => js("Array.from(document.querySelectorAll('#draft-images img')).every(i=>i.complete&&i.naturalWidth>0)"), 'Private image protocol did not load clipboard preview.');
    await click('[data-remove-attachment]');
    await until(() => js("document.querySelectorAll('#draft-images img').length===0"), 'Draft image removal failed.');
    // Browser File objects use the same input/change path as native file selection.
    await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(png.split(',')[1])}),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'chosen.png',{type:'image/png'}));const input=document.querySelector('#image-file-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await until(() => js("document.querySelectorAll('#draft-images img').length===1"), 'File selection image did not import.');
    const imageMessage = '請看這張圖片的兩個形狀。';
    await send(imageMessage); await until(() => task(imageMessage)?.status === 'completed', 'Image task did not complete.');
    const imageTask = task(imageMessage); assert.equal(imageTask.workspace, ordinaryFolder); assert.equal(imageTask.attachments.length, 1);
    await until(() => js("document.querySelectorAll('.message-images img').length===1&&document.querySelector('.message-images img').naturalWidth>0"), 'Sent image preview did not render.');
    assert.equal(await js("document.querySelectorAll('#draft-images img').length"), 0);
    const calls = () => readFileSync(capture, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    const imageCalls = calls().filter(call => call.input.includes(imageMessage)); assert.equal(imageCalls.length, 3);
    assert.ok(imageCalls.filter(call => call.agent === 'codex').every(call => call.args.includes('--image')));
    assert.ok(imageCalls.filter(call => call.agent === 'claude').every(call => call.images?.length === 1));
    report.checks.push('Native image paste, File input, draft removal, preview protocol and images delivered to all three provider stages');
    const followup = '剛才那張圖片，再解釋一次。'; await send(followup); await until(() => task(followup)?.status === 'completed', 'Image follow-up did not complete.');
    const continued = calls().filter(call => call.input.includes(followup)); assert.equal(continued.length, 3);
    assert.ok(continued.filter(call => call.agent === 'claude').every(call => call.images?.length === 1));
    assert.ok(continued.filter(call => call.agent === 'codex').every(call => call.args.includes('--image')));
    report.checks.push('Following messages receive previous user images and text context');
    await until(() => js("document.querySelector('#cancel-current-task').hidden"), 'Completed reply did not reach the renderer.');
    await js("document.querySelector('.message-images').scrollIntoView({block:'center'})"); await pause(150);
    writeFileSync(path.join(artifacts, 'image-chat.png'), (await window.webContents.capturePage()).toPNG());
    const firstRoom = imageTask.conversationId;
    // Drop a picture in a new room and send without text.
    await click('#new-conversation'); await until(() => js("document.querySelectorAll('[data-message-role]').length===0"), 'New chat did not open.');
    await js(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(png.split(',')[1])}),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'dropped.png',{type:'image/png'}));document.querySelector('#view-workspace').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}))})()`);
    await until(() => js("document.querySelectorAll('#draft-images img').length===1"), 'Dropped image did not import.');
    await send(); await until(() => services.snapshot().tasks.some(item => item.conversationId !== firstRoom && item.attachments?.length===1 && item.status==='completed'), 'Image-only message failed.');
    const imageOnly = services.snapshot().tasks.find(item => item.conversationId !== firstRoom && item.attachments?.length===1);
    assert.ok(imageOnly.task.trim()); assert.deepEqual(imageOnly.conversationContext, []);
    report.checks.push('Drag/drop and image-only messages work in an isolated conversation');
    // Delete from history, then delete a running room from its sidebar.
    await click('[data-view=history]'); await pause(120);
    await click(`#history-list [data-delete-conversation-id="${firstRoom}"]`);
    await until(() => js("document.querySelector('#delete-conversation-dialog').open"), 'Delete confirmation did not open.');
    await click('#confirm-delete-conversation');
    await until(() => !services.snapshot().conversations.some(room => room.id===firstRoom), 'Deleted room remained in history.');
    assert.equal(services.store.listAll().some(item => item.conversationId===firstRoom), false);
    assert.equal(existsSync(imageTask.attachments[0].path), false); assert.equal(existsSync(imageOnly.attachments[0].path), true);
    await click('[data-view=workspace]'); await pause(120); await click('#new-conversation'); await pause(120);
    await js("(()=>{const want='claude';const chip=id=>document.querySelector('[data-participant='+id+']');if(!chip(want).classList.contains('selected'))chip(want).click();let other;while((other=Array.from(document.querySelectorAll('[data-participant].selected')).find(el=>el.dataset.participant!==want)))other.click();})()");
    await send('等待刪除執行中的對話'); await until(() => task('等待刪除執行中的對話')?.status==='running' && existsSync(`${capture}.child`), 'Running task did not start.');
    const runningRoom = task('等待刪除執行中的對話').conversationId;
    report.runningWorkerPids = [...runtime.activeProcesses().map(item=>item.pid), Number(readFileSync(`${capture}.child`, 'utf8'))];
    await click(`#recent-conversations [data-delete-conversation-id="${runningRoom}"]`);
    await until(() => js("document.querySelector('#delete-conversation-dialog').open"), 'Running room delete dialog did not open.');
    await click('#confirm-delete-conversation');
    await until(() => !services.snapshot().conversations.some(room=>room.id===runningRoom) && !runtime.activeProcesses().length, 'Running room deletion did not stop and remove work.');
    assert.ok(services.snapshot().conversations.some(room=>room.id===imageOnly.conversationId));
    assert.equal(await js("document.querySelectorAll('#chat-messages [data-message-role]').length"), 0);
    report.checks.push('History and sidebar delete remove durable records and private images; running deletion awaits owned process cleanup and preserves other rooms');
    writeFileSync(path.join(artifacts, 'after-delete.png'), (await window.webContents.capturePage()).toPNG());
    if(originalClipboard) await clipboard.write(originalClipboard); report.preClosePassed = true; window.close();
  } catch (error) { report.error = error.stack || error.message; if(instance&&!instance.window.isDestroyed())writeFileSync(path.join(artifacts,'failure.png'),(await instance.window.webContents.capturePage()).toPNG());writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)); if(originalClipboard) await clipboard.write(originalClipboard).catch(()=>{}); if(instance) await instance.shutdown(); else {await runtime.close(); process.exitCode=1;} }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
