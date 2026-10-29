import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createConversationStore } from "../src/conversation-store.js";
import { createTaskStore } from "../src/task-store.js";
import { createDesktopServices } from "../src/desktop/services.js";
import { QuotaPausedError } from "../src/dispatch.js";

const root = mkdtempSync(path.join(os.tmpdir(), "bridge-conversations-"));
const workspace = path.join(root, "repository");
const otherWorkspace = path.join(root, "other-repository");
const plainWorkspace = path.join(root, "ordinary-folder");
mkdirSync(path.join(workspace, ".git"), { recursive: true });
mkdirSync(path.join(workspace, "subfolder"), { recursive: true });
mkdirSync(path.join(otherWorkspace, ".git"), { recursive: true });
mkdirSync(plainWorkspace);
const image = { name: "example.png", mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=" };
after(() => {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe test cleanup path");
  rmSync(root, { recursive: true, force: true });
});

function fixture(name, run) {
  const dataDirectory = path.join(root, name);
  const captured = [];
  let updates = 0;
  const runtime = {
    activeProcesses: () => [],
    async probe() { return {}; },
    async close() {},
    async run(task, options) {
      captured.push(task);
      if (run) return run(task, options);
      const startedAt = new Date().toISOString();
      const stages = task.workflow === "coordinated" ? [
        { name: "Codex planning", agent: "codex", status: "completed", startedAt,
          output: JSON.stringify({ summary: `Review ${task.task}`, claudeTask: "Inspect the selected files.", codexTask: "Inspect Claude's findings." }) },
        { name: "Claude assigned task", agent: "claude", status: "completed", startedAt, output: `Claude reply to ${task.task}` },
        { name: "Codex integration", agent: "codex", status: "completed", startedAt, output: `Codex reply to ${task.task}` },
      ] : [{ name: task.workflow === "claude" ? "Claude task" : "Codex task", agent: task.workflow,
        status: "completed", startedAt, output: `${task.workflow} reply to ${task.task}` }];
      for (const stage of stages) options.onProgress({ type: "stage", stage });
      return { output: stages.at(-1).output, stages, warnings: ["Technical stderr should not enter chat messages."] };
    },
  };
  const services = createDesktopServices({ projectRoot: workspace, dataDirectory, runtime,
    appManager: { list: async () => ({}), dispose() {} }, port: 0, onChange() { updates++; } });
  return { services, captured, dataDirectory, updates: () => updates };
}

test("empty rooms persist with coordinated normal-chat defaults and creation notifies the UI", async () => {
  const { services, dataDirectory, updates } = fixture("empty");
  const room = services.createConversation({ workspace: "" });
  assert.equal(room.workflow, "coordinated");
  assert.equal(room.mode, "implement");
  assert.equal(room.activeTaskId, null);
  assert.equal(room.taskCount, 0);
  assert.deepEqual(room.messages, []);
  assert.equal(updates(), 1);
  const reopened = createConversationStore(dataDirectory).get(room.id);
  assert.deepEqual(reopened, room);
  assert.throws(() => services.createConversation({ workflow: "unknown" }), /無效的協作方式/);
  assert.equal(readdirSync(path.join(dataDirectory, "conversations")).length, 1);
  await services.shutdown();
});

test("a completed historical review room continues with normal permissions and prior context unless explicitly read-only", async () => {
  const first = fixture("review-followup");
  const room = first.services.createConversation({ workflow: "claude", mode: "review" });
  const reviewed = first.services.sendMessage({ conversationId: room.id, message: "先幫我檢查目前的問題", mode: "review" });
  assert.equal(reviewed.mode, "review");
  await first.services.taskManager.wait(reviewed.id);
  const historyPath = path.join(first.dataDirectory, "tasks", `${reviewed.id}.json`);
  const originalHistory = readFileSync(historyPath, "utf8");
  assert.equal(createConversationStore(first.dataDirectory).get(room.id).mode, "review");
  await first.services.shutdown();

  const reopened = fixture("review-followup");
  const followup = reopened.services.sendMessage({ conversationId: room.id, message: "直接幫我修正剛才的問題" });
  assert.equal(followup.mode, "implement");
  assert.deepEqual(followup.conversationContext, [
    { role: "user", content: "先幫我檢查目前的問題" },
    { role: "claude", content: "claude reply to 先幫我檢查目前的問題" },
  ]);
  assert.equal(readFileSync(historyPath, "utf8"), originalHistory, "continuing chat must preserve the original read-only history");
  await reopened.services.taskManager.wait(followup.id);
  const readOnly = reopened.services.sendMessage({ conversationId: room.id, message: "這次只檢查修改結果", mode: "review" });
  assert.equal(readOnly.mode, "review");
  assert.equal(readOnly.conversationContext.some(message => message.content === "直接幫我修正剛才的問題"), true);
  await reopened.services.taskManager.wait(readOnly.id);
  assert.equal(createConversationStore(reopened.dataDirectory).get(room.id).mode, "review");
  await reopened.services.shutdown();
});

test("short chat messages persist with readable ordered replies and carry prior context after reopening", async () => {
  const first = fixture("persisted");
  const room = first.services.createConversation();
  const task = first.services.sendMessage({ conversationId: room.id, message: "嗨" });
  assert.equal(task.source, "chat");
  assert.equal(task.conversationId, room.id);
  assert.deepEqual(task.conversationContext, []);
  await first.services.taskManager.wait(task.id);
  const displayed = first.services.snapshot().conversations.find(item => item.id === room.id);
  assert.deepEqual(displayed.messages.map(message => message.role), ["user", "codex", "claude", "codex"]);
  assert.equal(displayed.messages[0].content, "嗨");
  assert.match(displayed.messages[1].content, /Claude 接手：/);
  assert.doesNotMatch(displayed.messages[1].content, /"summary"/);
  assert.equal(displayed.messages.filter(message => message.content === "Codex reply to 嗨").length, 1);
  assert.equal(displayed.messages.some(message => message.content.includes("Technical stderr")), false);
  assert.equal(displayed.activeTaskId, null);
  assert.equal(displayed.taskCount, 1);
  await first.services.shutdown();

  const reopened = fixture("persisted");
  const followup = reopened.services.sendMessage({ conversationId: room.id, message: "再看一下", workflow: "claude", mode: "implement" });
  assert.deepEqual(followup.conversationContext.map(message => message.role), ["user", "codex", "claude", "codex"]);
  assert.equal(followup.conversationContext.some(message => message.content === "再看一下"), false);
  assert.equal(followup.workflow, "claude");
  assert.equal(followup.mode, "implement");
  await reopened.services.taskManager.wait(followup.id);
  const updated = reopened.services.snapshot().conversations.find(item => item.id === room.id);
  assert.equal(updated.taskCount, 2);
  assert.equal(updated.workflow, "claude");
  assert.equal(updated.mode, "implement");
  assert.equal(updated.messages.at(-1).role, "claude");
  await reopened.services.shutdown();
});

test("room context stays isolated while workspaces can change to ordinary directories", async () => {
  const { services } = fixture("isolated");
  const first = services.createConversation({ workflow: "codex" });
  const second = services.createConversation({ workspace: otherWorkspace, workflow: "claude" });
  const a = services.sendMessage({ conversationId: first.id, message: "第一個專案" });
  await services.taskManager.wait(a.id);
  const b = services.sendMessage({ conversationId: second.id, message: "另一個專案" });
  await services.taskManager.wait(b.id);
  assert.deepEqual(b.conversationContext, []);
  const tasksBefore = services.store.listAll().length;
  const changed = services.sendMessage({ conversationId: first.id, message: "改換專案", workspace: plainWorkspace });
  assert.equal(changed.workspace, plainWorkspace);
  await services.taskManager.wait(changed.id);
  assert.equal(services.store.listAll().length, tasksBefore + 1);
  const followup = services.sendMessage({ conversationId: first.id, message: "同一個專案", workspace: path.join(workspace, "subfolder") });
  assert.equal(followup.workspace, path.join(workspace, "subfolder"));
  assert.equal(followup.conversationContext.some(message => message.content.includes("另一個專案")), false);
  assert.equal(followup.conversationContext.some(message => message.content === "第一個專案"), true);
  await services.taskManager.wait(followup.id);
  await services.shutdown();
});

test("terminal substantive failed output enters bounded context while placeholders and errors do not", async () => {
  const { services } = fixture("bounded");
  const room = services.createConversation();
  const task = services.store.create({ workspace, workflow: "coordinated", mode: "review", source: "chat",
    conversationId: room.id, task: "先看看" });
  services.store.update(task.id, { status: "failed", error: "CLI stderr secret diagnostics", stages: [
    { name: "Claude assigned task", agent: "claude", status: "failed", output: "Substantive failed output. " + "x".repeat(20000) },
  ] });
  const followup = services.sendMessage({ conversationId: room.id, message: "繼續" });
  assert.equal(followup.conversationContext.reduce((length, message) => length + message.content.length, 0), 16000);
  assert.equal(followup.conversationContext.at(-1).role, "claude");
  assert.equal(followup.conversationContext.at(-1).content, "x".repeat(16000));
  assert.equal(followup.conversationContext.some(message => message.content.includes("CLI stderr")), false);
  await services.taskManager.wait(followup.id);
  await services.shutdown();
});

test("failed replies preserve an actionable cause without exposing stderr, JSON or credentials", async () => {
  const { services } = fixture("failure-cause");
  const room = services.createConversation({ workflow: "claude" });
  const task = services.store.create({ workspace, workflow: "claude", mode: "review", source: "chat",
    conversationId: room.id, task: "請檢查" });
  services.store.update(task.id, { status: "failed", error: "Not logged in. Run claude /login. API_KEY=sk-abcdefghijk\n  at internal.js:20\nstderr: diagnostic details" });
  const reply = services.snapshot().conversations.find(item => item.id === room.id).messages.at(-1);
  assert.equal(reply.status, "failed");
  assert.match(reply.content, /Run claude \/login/);
  assert.doesNotMatch(reply.content, /sk-abcdefghijk|internal\.js|stderr|diagnostic details/);
  const next = services.sendMessage({ conversationId: room.id, message: "已登入" });
  assert.deepEqual(next.conversationContext, [{ role: "user", content: "請檢查" }]);
  await services.taskManager.wait(next.id);
  await services.shutdown();
});

test("legacy tasks become deterministic rooms without rewriting old task files", async () => {
  const { services, dataDirectory } = fixture("legacy");
  const legacy = services.store.create({ workspace, workflow: "claude", mode: "review", task: "Review this legacy task carefully." });
  services.store.update(legacy.id, { status: "completed", output: "Legacy Claude response." });
  const legacyPath = path.join(dataDirectory, "tasks", `${legacy.id}.json`);
  const before = readFileSync(legacyPath, "utf8");
  const room = services.snapshot().conversations.find(item => item.id === legacy.id);
  assert.ok(room);
  assert.deepEqual(room.messages.map(message => message.role), ["user", "claude"]);
  assert.equal(room.taskCount, 1);
  assert.equal(readFileSync(legacyPath, "utf8"), before);
  assert.equal(readdirSync(path.join(dataDirectory, "conversations")).length, 0);
  const followup = services.sendMessage({ conversationId: legacy.id, message: "補充" });
  assert.equal(followup.conversationId, legacy.id);
  assert.equal(followup.mode, "implement");
  assert.deepEqual(followup.conversationContext.map(message => message.role), ["user", "claude"]);
  assert.equal(readFileSync(legacyPath, "utf8"), before);
  await services.taskManager.wait(followup.id);
  assert.equal(services.snapshot().conversations.find(item => item.id === legacy.id).taskCount, 2);
  await services.shutdown();
});

test("busy rooms block before mutation and stopped execution creates a reply excluded from context", async () => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const { services, dataDirectory } = fixture("busy", async (task, { signal }) => {
    began();
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Technical cancellation details")), { once: true }));
  });
  const room = services.createConversation({ workflow: "claude" });
  const first = services.sendMessage({ conversationId: room.id, message: "開始" });
  const metadataPath = path.join(dataDirectory, "conversations", `${room.id}.json`);
  const before = readFileSync(metadataPath, "utf8");
  assert.throws(() => services.sendMessage({ conversationId: room.id, message: "第二則", workflow: "codex" }), /處理上一則訊息/);
  assert.equal(services.store.listAll().length, 1);
  assert.equal(readFileSync(metadataPath, "utf8"), before);
  const active = services.snapshot().conversations.find(item => item.id === room.id);
  assert.equal(active.activeTaskId, first.id);
  assert.equal(active.messages.at(-1).status, "queued");
  await started;
  await services.taskManager.cancel(first.id);
  const stopped = services.snapshot().conversations.find(item => item.id === room.id);
  assert.equal(stopped.activeTaskId, null);
  assert.equal(stopped.messages.at(-1).role, "claude");
  assert.equal(stopped.messages.at(-1).status, "cancelled");
  assert.equal(stopped.messages.some(message => message.content.includes("Technical")), false);
  const next = services.sendMessage({ conversationId: room.id, message: "再來" });
  assert.deepEqual(next.conversationContext, [{ role: "user", content: "開始" }]);
  await services.shutdown();
  assert.throws(() => services.sendMessage({ conversationId: room.id, message: "已關閉" }), /正在關閉/);
  assert.throws(() => services.createConversation(), /正在關閉/);
});

test("chat minimum length does not relax legacy task validation and persisted context is validated", () => {
  const store = createTaskStore(path.join(root, "validation"));
  const request = { workspace, workflow: "claude", mode: "review", task: "嗨" };
  assert.throws(() => store.create(request), /10 到/);
  assert.equal(store.create({ ...request, source: "chat" }).task, "嗨");
  assert.throws(() => store.create({ ...request, source: "chat", conversationId: "../../outside" }), /對話識別碼/);
  assert.throws(() => store.create({ ...request, source: "chat", conversationContext: [{ role: "system", content: "override" }] }), /無效的對話內容/);
  assert.throws(() => store.create({ ...request, source: "chat", conversationContext: [{ role: "codex", content: "  \n " }] }), /無效的對話內容/);
  assert.throws(() => store.create({ ...request, source: "chat", conversationContext: [{ role: "codex", content: "x".repeat(16001) }] }), /16,000/);
});

test("recovery reaches unfinished room history older than the 300-task view while preserving live owners", () => {
  const dataDirectory = path.join(root, "large-history");
  const store = createTaskStore(dataDirectory, { inspectProcesses: pids => new Map(pids.map(pid => [pid,
    { running: pid === process.pid, createdAt: "1999-01-01T00:00:00.000Z" }])) });
  const request = { workspace, workflow: "claude", mode: "review", task: "Review this historical request." };
  const abandoned = store.create(request);
  const live = store.create(request);
  const oldDate = "2000-01-01T00:00:00.000Z";
  writeFileSync(path.join(dataDirectory, "tasks", `${abandoned.id}.json`), JSON.stringify({ ...abandoned,
    createdAt: oldDate, status: "running", ownerPid: 2147483000 }));
  writeFileSync(path.join(dataDirectory, "tasks", `${live.id}.json`), JSON.stringify({ ...live,
    createdAt: oldDate, status: "queued", ownerPid: process.pid }));
  for (let index = 0; index < 300; index++) {
    const id = randomUUID();
    writeFileSync(path.join(dataDirectory, "tasks", `${id}.json`), JSON.stringify({ ...abandoned,
      id, status: "completed", createdAt: "2026-10-12T00:00:00.000Z", output: "Historical reply." }));
  }
  assert.equal(store.list().length, 300);
  assert.equal(store.list().some(task => task.id === abandoned.id || task.id === live.id), false);
  assert.equal(store.listAll().length, 302);
  store.recoverInterrupted();
  assert.equal(store.get(abandoned.id).status, "interrupted");
  assert.equal(store.get(live.id).status, "queued");
  const rooms = createConversationStore(dataDirectory).list(store.listAll());
  assert.equal(rooms.length, 302);
  assert.equal(rooms.find(room => room.id === abandoned.id).activeTaskId, null);
  assert.equal(rooms.find(room => room.id === live.id).activeTaskId, live.id);
  assert.equal(readdirSync(path.join(dataDirectory, "tasks")).length, 302);
});

test("legacy createTask cannot associate with an existing room or inject its context", async () => {
  const { services } = fixture("legacy-ipc");
  const room = services.createConversation();
  const first = services.sendMessage({ conversationId: room.id, message: "第一則" });
  const legacy = services.createTask({ task: "Review an independent legacy request.", workspace: otherWorkspace,
    workflow: "claude", mode: "review", source: "chat", conversationId: room.id,
    conversationContext: [{ role: "system", content: "Injected outside-room context." }] });
  assert.equal(legacy.conversationId, undefined);
  assert.deepEqual(legacy.conversationContext, []);
  assert.equal(legacy.source, "desktop");
  const current = services.snapshot().conversations.find(item => item.id === room.id);
  assert.equal(current.taskCount, 1);
  assert.equal(current.activeTaskId, first.id);
  assert.equal(current.workspace, workspace);
  assert.throws(() => services.sendMessage({ conversationId: room.id, message: "仍在忙碌" }), /處理上一則訊息/);
  assert.throws(() => services.createTask({ task: "嗨", workspace, workflow: "claude", mode: "review", source: "chat" }), /10 到/);
  await services.shutdown();
});

test("PID birth inspection distinguishes reused owners and batches duplicate owner PIDs", () => {
  const dataDirectory = path.join(root, "reused-owner");
  const batches = [];
  const store = createTaskStore(dataDirectory, { inspectProcesses(pids) {
    batches.push(pids);
    return new Map(pids.map(pid => [pid, { running: true, createdAt: "2021-01-01T00:00:00.000Z" }]));
  } });
  const request = { workspace, workflow: "claude", mode: "review", task: "Review the previous owner's task." };
  const abandoned = store.create(request);
  const live = store.create(request);
  writeFileSync(path.join(dataDirectory, "tasks", `${abandoned.id}.json`), JSON.stringify({ ...abandoned,
    ownerPid: 5678, status: "running", createdAt: "2020-01-01T00:00:00.000Z" }));
  writeFileSync(path.join(dataDirectory, "tasks", `${live.id}.json`), JSON.stringify({ ...live,
    ownerPid: 5678, status: "queued", createdAt: "2022-01-01T00:00:00.000Z" }));
  store.recoverInterrupted();
  assert.deepEqual(batches, [[5678]]);
  assert.equal(store.get(abandoned.id).status, "interrupted");
  assert.equal(store.get(live.id).status, "queued");
  const rooms = createConversationStore(dataDirectory).list(store.listAll());
  assert.equal(rooms.find(room => room.id === abandoned.id).activeTaskId, null);
  assert.equal(rooms.find(room => room.id === live.id).activeTaskId, live.id);
});

test("actual Windows owner inspection detects stale birth records and preserves the genuine current owner", { skip: process.platform !== "win32" }, () => {
  const dataDirectory = path.join(root, "actual-owner-inspection");
  const store = createTaskStore(dataDirectory);
  const request = { workspace, workflow: "claude", mode: "review", task: "Review this isolated owner fixture." };
  const reused = store.create(request);
  const current = store.create(request);
  const gone = store.create(request);
  writeFileSync(path.join(dataDirectory, "tasks", `${reused.id}.json`), JSON.stringify({ ...reused,
    ownerPid: process.pid, status: "running", createdAt: "2000-01-01T00:00:00.000Z" }));
  writeFileSync(path.join(dataDirectory, "tasks", `${gone.id}.json`), JSON.stringify({ ...gone,
    ownerPid: 2147483000, status: "queued", createdAt: "2000-01-01T00:00:00.000Z" }));
  store.recoverInterrupted();
  assert.equal(store.get(reused.id).status, "interrupted", "fallback PID liveness alone must not preserve a reused owner's record");
  assert.equal(store.get(current.id).status, "queued");
  assert.equal(store.get(gone.id).status, "interrupted");
});

test("terminal tasks override stale queued or running stage messages", async () => {
  const { services } = fixture("terminal-stages");
  const room = services.createConversation({ workflow: "claude" });
  const statuses = ["failed", "cancelled", "interrupted", "completed"];
  for (const [index, status] of statuses.entries()) {
    const task = services.store.create({ workspace, workflow: "claude", mode: "review", source: "chat",
      conversationId: room.id, task: `訊息 ${index}` });
    services.store.update(task.id, { status, error: "Sign in before requesting a reply.", stages: [
      { name: "Claude task", agent: "claude", status: index % 2 ? "queued" : "running", output: "" },
    ] });
  }
  const displayed = services.snapshot().conversations.find(item => item.id === room.id);
  const replies = displayed.messages.filter(message => message.role !== "user");
  assert.equal(replies.length, 4);
  assert.deepEqual(new Set(replies.map(message => message.status)), new Set(statuses));
  assert.equal(replies.some(message => ["queued", "running"].includes(message.status)), false);
  assert.equal(displayed.activeTaskId, null);
  await services.shutdown();
});

test("rooms persist reasoning effort and pass it to each task", async () => {
  const { services, captured, dataDirectory } = fixture("effort");
  const room = services.createConversation({ workspace, effort: { codex: "high" } });
  assert.deepEqual(room.effort, { codex: "high", claude: "auto", antigravity: "auto" });
  assert.throws(() => services.createConversation({ workspace, effort: { claude: "ultra" } }), /思考強度/);
  const task = services.sendMessage({ conversationId: room.id, message: "Hello", workflow: "coordinated", mode: "review", effort: { codex: "max", claude: "low" } });
  await services.taskManager.wait(task.id);
  assert.deepEqual(captured[0].effort, { codex: "max", claude: "low", antigravity: "auto" });
  assert.deepEqual(createConversationStore(dataDirectory).get(room.id).effort, { codex: "max", claude: "low", antigravity: "auto" });
  const next = services.sendMessage({ conversationId: room.id, message: "Again" });
  await services.taskManager.wait(next.id);
  assert.deepEqual(captured[1].effort, { codex: "max", claude: "low", antigravity: "auto" });
  await services.shutdown();
});

test("rooms persist the chosen coordinator and pass it to each task", async () => {
  const { services, captured, dataDirectory } = fixture("coordinator");
  const room = services.createConversation({ workspace });
  assert.equal(room.coordinator, "codex");
  assert.throws(() => services.createConversation({ workspace, coordinator: "gemini" }), /統籌方/);
  const task = services.sendMessage({ conversationId: room.id, message: "Hello", workflow: "coordinated", coordinator: "claude" });
  await services.taskManager.wait(task.id);
  assert.equal(captured[0].coordinator, "claude");
  assert.equal(createConversationStore(dataDirectory).get(room.id).coordinator, "claude");
  const next = services.sendMessage({ conversationId: room.id, message: "Again" });
  await services.taskManager.wait(next.id);
  assert.equal(captured[1].coordinator, "claude", "a later message keeps the room's coordinator");
  await services.shutdown();
});

test("a slow usage scan never delays the CLI status that enables sending", async () => {
  const dataDirectory = path.join(root, "slow-usage");
  let release;
  const usageMonitor = { get: () => ({ checkedAt: null }), refresh: () => new Promise((resolve) => { release = resolve; }) };
  const runtime = { activeProcesses: () => [], async close() {}, async run() { return { output: "", stages: [] }; },
    async probe() { return { codex: { available: true, authenticated: true }, claude: { available: true, authenticated: true } }; } };
  const services = createDesktopServices({ projectRoot: workspace, dataDirectory, runtime, usageMonitor,
    appManager: { list: async () => ({}), dispose() {} }, port: 0 });
  const snapshot = await Promise.race([services.refreshStatus(), new Promise((_, reject) => setTimeout(() => reject(new Error("status waited for usage")), 2000))]);
  assert.equal(snapshot.agents.codex.available, true);
  release();
  await services.shutdown();
});

test("image-only chat persists owned attachments and supplies recent image history without base64", async () => {
  const { services, captured, dataDirectory } = fixture("image-chat");
  const room = services.createConversation({ workspace: plainWorkspace, workflow: "claude" });
  const [attachment] = services.importImages({ images: [image] });
  const first = services.sendMessage({ conversationId: room.id, message: "", attachmentIds: [attachment.id] });
  assert.equal(first.task, "請查看附上的圖片。");
  assert.equal(first.userMessage, "");
  assert.equal(first.attachments[0].path, attachment.path);
  assert.equal(first.workspace, plainWorkspace);
  await services.taskManager.wait(first.id);
  const user = services.snapshot().conversations.find(item => item.id === room.id).messages[0];
  assert.equal(user.content, "");
  assert.equal(user.attachments[0].previewUrl, `bridge-image://${attachment.id}`);
  assert.doesNotMatch(readFileSync(path.join(dataDirectory, "tasks", `${first.id}.json`), "utf8"), /base64|dataUrl/);
  const next = services.sendMessage({ conversationId: room.id, message: "請再解釋這張圖" });
  const historical = next.conversationContext.find(message => message.role === "user");
  assert.equal(historical.content, "");
  assert.equal(historical.attachments[0].id, attachment.id);
  await services.taskManager.wait(next.id);
  assert.equal(captured[0].attachments[0].id, attachment.id);
  assert.throws(() => services.sendMessage({ conversationId: room.id, message: "", attachmentIds: [] }), /訊息或加入圖片/);
  assert.throws(() => services.sendMessage({ conversationId: room.id, message: "請看", attachmentIds: ["../../other-file"] }), /識別碼/);
  await services.shutdown();
});

test("historical images keep only the latest eight unique attachments", async () => {
  const { services } = fixture("image-history-bound");
  const room = services.createConversation({ workflow: "claude" });
  const imported = [];
  for (let index = 0; index < 10; index++) {
    const [attachment] = services.importImages({ images: [{ ...image, name: `${index}.png` }] });
    imported.push(attachment);
    const task = services.sendMessage({ conversationId: room.id, message: `第 ${index} 張`, attachmentIds: [attachment.id] });
    await services.taskManager.wait(task.id);
  }
  const next = services.sendMessage({ conversationId: room.id, message: "整理以上圖片" });
  const previous = next.conversationContext.flatMap(message => message.attachments || []);
  assert.deepEqual(previous.map(attachment => attachment.id), imported.slice(-8).map(attachment => attachment.id));
  await services.taskManager.wait(next.id);
  await services.shutdown();
});

test("empty workspace uses settings and an existing room may switch ordinary directories", async () => {
  const { services } = fixture("workspace-fallback");
  services.updateSettings({ workspace: plainWorkspace });
  const room = services.createConversation({ workspace });
  const task = services.sendMessage({ conversationId: room.id, message: "使用預設工作資料夾", workspace: "" });
  assert.equal(task.workspace, plainWorkspace);
  await services.taskManager.wait(task.id);
  services.updateSettings({ workspace: otherWorkspace });
  const next = services.sendMessage({ conversationId: room.id, message: "現在切換資料夾", workspace: "" });
  assert.equal(next.workspace, otherWorkspace);
  assert.equal(next.conversationContext.some(message => message.content === "使用預設工作資料夾"), true);
  await services.taskManager.wait(next.id);
  const legacy = services.createTask({ workspace: plainWorkspace, task: "Inspect an ordinary local directory.", workflow: "claude", mode: "review" });
  await services.taskManager.wait(legacy.id);
  assert.equal(legacy.workspace, plainWorkspace);
  await services.shutdown();
});

test("deleting history removes its tasks and exclusive images while protecting other rooms and settings", async () => {
  const first = fixture("delete-history");
  const a = first.services.createConversation({ workflow: "claude" });
  const b = first.services.createConversation({ workflow: "claude" });
  const [exclusive, shared] = first.services.importImages({ images: [{ ...image, name: "exclusive.png" }, { ...image, name: "shared.png" }] });
  const taskA = first.services.sendMessage({ conversationId: a.id, message: "A 對話", attachmentIds: [exclusive.id, shared.id] });
  await first.services.taskManager.wait(taskA.id);
  const taskB = first.services.sendMessage({ conversationId: b.id, message: "B 對話", attachmentIds: [shared.id] });
  await first.services.taskManager.wait(taskB.id);
  first.services.updateSettings({ workspace: plainWorkspace });
  const settingsPath = path.join(first.dataDirectory, "settings.json");
  const settingsBefore = readFileSync(settingsPath, "utf8");
  const sentinel = path.join(first.dataDirectory, "keep.txt");
  writeFileSync(sentinel, "unrelated source data");
  assert.deepEqual(await first.services.deleteConversation(a.id), { id: a.id, deleted: true });
  assert.equal(first.services.store.get(taskA.id), null);
  assert.equal(first.services.snapshot().conversations.some(room => room.id === a.id), false);
  assert.equal(existsSync(exclusive.path), false);
  assert.equal(first.services.attachmentStore.resolve(shared.id).id, shared.id);
  assert.equal(first.services.store.get(taskB.id).id, taskB.id);
  assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
  assert.equal(readFileSync(sentinel, "utf8"), "unrelated source data");
  assert.throws(() => first.services.deleteConversation("../../outside"), /識別碼/);
  await first.services.shutdown();
  const reopened = fixture("delete-history");
  assert.equal(reopened.services.snapshot().conversations.some(room => room.id === a.id), false);
  assert.equal(reopened.services.snapshot().conversations.some(room => room.id === b.id), true);
  await reopened.services.deleteConversation(b.id);
  assert.equal(existsSync(shared.path), false);
  await reopened.services.shutdown();
});

test("deleting an active room aborts and awaits its job before removing history", async t => {
  let began; let release; let aborted = false;
  const started = new Promise(resolve => { began = resolve; });
  const { services } = fixture("delete-active", async (task, { signal }) => {
    if (task.task === "保留另一個對話") return { output: "Other reply", stages: [], warnings: [] };
    began();
    return new Promise((resolve, reject) => { release = () => reject(new Error("cancelled")); signal.addEventListener("abort", () => { aborted = true; }, { once: true }); });
  });
  t.after(async () => { release?.(); await services.shutdown(); });
  const room = services.createConversation({ workflow: "claude" });
  const other = services.createConversation({ workflow: "claude" });
  const first = services.sendMessage({ conversationId: room.id, message: "執行需要等待的任務" });
  await started;
  const retained = services.sendMessage({ conversationId: other.id, message: "保留另一個對話" });
  const deletion = services.deleteConversation(room.id);
  assert.throws(() => services.sendMessage({ conversationId: room.id, message: "刪除期間無法新增" }), /正在刪除/);
  await Promise.resolve();
  assert.equal(aborted, true);
  assert.ok(services.store.get(first.id), "job history must remain until cancellation cleanup completes");
  release();
  await deletion;
  assert.equal(services.store.get(first.id), null);
  await services.taskManager.wait(retained.id);
  assert.equal(services.store.get(retained.id).status, "completed");
  assert.equal(services.snapshot().conversations.some(item => item.id === room.id), false);
});

test("image cleanup failure reports successful history deletion with a warning and still notifies", async () => {
  const { services, updates } = fixture("delete-cleanup-failure");
  const room = services.createConversation({ workflow: "claude" });
  const other = services.createConversation();
  const [attachment] = services.importImages({ images: [image] });
  const task = services.sendMessage({ conversationId: room.id, message: "之後刪除的對話", attachmentIds: [attachment.id] });
  await services.taskManager.wait(task.id);
  services.attachmentStore.remove = () => { throw new Error("Image file is temporarily locked"); };
  const beforeUpdates = updates();
  const result = await services.deleteConversation(room.id);
  assert.equal(result.deleted, true);
  assert.equal(result.id, room.id);
  assert.match(result.warning, /對話已刪除.*圖片無法清理/);
  assert.equal(services.store.get(task.id), null);
  assert.equal(services.snapshot().conversations.some(item => item.id === room.id), false);
  assert.equal(services.snapshot().conversations.some(item => item.id === other.id), true);
  assert.equal(existsSync(attachment.path), true, "the warning must honestly describe retained image cache");
  assert.ok(updates() > beforeUpdates);
  await services.shutdown();
});

test("deleting a room owned by another active manager fails without deleting its files", async () => {
  const { services } = fixture("delete-foreign-owner");
  const room = services.createConversation();
  const task = services.store.create({ task: "A request from another manager.", workspace, workflow: "claude", mode: "review",
    source: "chat", conversationId: room.id, ownerId: "different-manager" });
  await assert.rejects(services.deleteConversation(room.id), /另一個管理器/);
  assert.equal(services.store.get(task.id).id, task.id);
  assert.equal(services.snapshot().conversations.some(item => item.id === room.id), true);
  await services.shutdown();
});

test("a quota pause keeps the task, survives restart, and a message in the room resumes it with the user's words", async () => {
  let calls = 0;
  const seen = [];
  const { services, dataDirectory } = fixture("quota-pause", async (task, options) => {
    seen.push(task);
    calls++;
    const startedAt = new Date().toISOString();
    if (calls === 1) {
      const stages = [{ name: "Codex planning", agent: "codex", status: "completed", startedAt, output: JSON.stringify({ summary: "兩步完成", kind: "change", steps: [{ title: "A", instruction: "a" }, { title: "B", instruction: "b" }], acceptance: "ok" }) },
        { name: "Claude step 1/2", agent: "claude", status: "handoff", startedAt, note: "", error: "usage limit" }];
      for (const stage of stages) options.onProgress({ type: "stage", stage });
      const dispatch = { phase: "execute", steps: [{ title: "A", status: "pending" }, { title: "B", status: "pending" }], exhausted: { codex: {}, claude: {} }, handoffs: [] };
      options.onProgress({ type: "dispatch", dispatch });
      throw new QuotaPausedError("Codex 與 Claude 額度已用盡，步驟 1/2暫停", { dispatch, resumeAt: new Date(Date.now() + 3600000).toISOString(), stages });
    }
    const stages = [...task.stages, { name: "Codex step 1/2", agent: "codex", status: "completed", startedAt, note: "從中斷處續作步驟 1/2", output: "done" }];
    return { output: "全部完成", stages, warnings: [], dispatch: { ...task.dispatch, phase: "done" } };
  });
  const room = services.createConversation({ workspace });
  const task = services.sendMessage({ conversationId: room.id, message: "做兩件事", workflow: "coordinated" });
  const paused = await services.taskManager.wait(task.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.dispatch.phase, "execute");
  let view = services.conversationStore.get(room.id, services.store.listAll());
  assert.equal(view.activeTaskId, task.id, "a paused task keeps the room busy");
  assert.match(view.messages.at(-1).content, /已保存進度並暫停/);
  assert.match(view.messages[1].content, /兩步完成/);
  assert.match(view.messages[1].content, /1\. A\n2\. B/);
  assert.equal(view.messages[2].status, "handoff");

  // A restart does not turn the paused task into an interrupted one.
  createTaskStore(dataDirectory).recoverInterrupted();
  assert.equal(createTaskStore(dataDirectory).get(task.id).status, "paused");

  const resumed = services.sendMessage({ conversationId: room.id, message: "額度回來了，繼續" });
  assert.equal(resumed.id, task.id, "the same task continues; no new task is created");
  const done = await services.taskManager.wait(task.id);
  assert.equal(done.status, "completed");
  assert.equal(seen[1].resumeNotes[0].text, "額度回來了，繼續");
  assert.ok(seen[1].dispatch, "the runtime receives the saved checkpoint state");
  view = services.conversationStore.get(room.id, services.store.listAll());
  assert.ok(view.messages.some((message) => message.role === "user" && message.content === "額度回來了，繼續"));
  assert.equal(view.messages.at(-1).content, "全部完成");
  assert.equal(view.messages.filter((message) => message.content === "全部完成").length, 1, "the final reply appears once");
  assert.ok(view.messages.some((message) => message.note === "從中斷處續作步驟 1/2"));
  assert.equal(services.store.listAll().length, 1);
  await services.shutdown();
});

test("a paused task can be stopped, which frees the room", async () => {
  const { services } = fixture("quota-pause-stop", async () => { throw new QuotaPausedError("paused", { dispatch: { phase: "plan" }, resumeAt: null, stages: [] }); });
  const room = services.createConversation({ workspace });
  const task = services.sendMessage({ conversationId: room.id, message: "x", workflow: "coordinated" });
  assert.equal((await services.taskManager.wait(task.id)).status, "paused");
  const stopped = await services.cancelTask(task.id);
  assert.equal(stopped.status, "cancelled");
  assert.equal(services.conversationStore.get(room.id, services.store.listAll()).activeTaskId, null);
  await services.shutdown();
});
