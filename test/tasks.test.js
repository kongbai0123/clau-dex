import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createTaskStore } from "../src/task-store.js";
import { createTaskManager } from "../src/task-manager.js";

const root = mkdtempSync(path.join(os.tmpdir(), "bridge-tasks-"));
const workspace = path.join(root, "repository");
mkdirSync(path.join(workspace, ".git"), { recursive: true });
after(() => {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe test cleanup path");
  rmSync(root, { recursive: true, force: true });
});
const request = { workspace, task: "Review the selected project files.", mode: "review", workflow: "claude" };

test("task history survives reopening and unfinished jobs recover as interrupted", () => {
  const data = path.join(root, "persisted");
  const first = createTaskStore(data);
  const task = first.create(request);
  first.update(task.id, { status: "running", ownerPid: 2147483000 });
  const reopened = createTaskStore(data);
  reopened.recoverInterrupted();
  assert.equal(reopened.get(task.id).status, "interrupted");
  assert.equal(reopened.list().length, 1);
  assert.throws(() => reopened.get("../../other"));
});

test("manager serializes tasks and preserves final outputs", async () => {
  const store = createTaskStore(path.join(root, "serial"));
  let active = 0; let maxActive = 0;
  const runtime = {
    async run(task) { active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 15)); active--; return { output: task.id, stages: [], warnings: [] }; },
    async close() {},
  };
  const manager = createTaskManager({ store, runtime });
  const a = manager.submit(request); const b = manager.submit(request);
  const completed = await Promise.all([manager.wait(a.id), manager.wait(b.id)]);
  assert.equal(maxActive, 1);
  assert.ok(completed.every(task => task.status === "completed"));
  assert.equal(completed[1].output, b.id);
  await manager.shutdown();
});

test("closing manager aborts running work and cancels queued work", async () => {
  const store = createTaskStore(path.join(root, "shutdown"));
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  let closed = false;
  const runtime = {
    run(task, { signal }) { started(); return new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }); },
    async close() { closed = true; },
  };
  const manager = createTaskManager({ store, runtime });
  const a = manager.submit(request); const b = manager.submit(request);
  await begun;
  await manager.shutdown();
  assert.equal(closed, true);
  assert.equal((await manager.wait(a.id)).status, "cancelled");
  assert.equal((await manager.wait(b.id)).status, "cancelled");
  assert.throws(() => manager.submit(request), /正在關閉/);
});

test("all concurrent shutdown callers await full runtime cleanup", async () => {
  const store = createTaskStore(path.join(root, "idempotent-shutdown"));
  let finish; let cleaned = false;
  const pending = new Promise(resolve => { finish = () => { cleaned = true; resolve(); }; });
  const manager = createTaskManager({ store, runtime: { close: () => pending } });
  const first = manager.shutdown(); const second = manager.shutdown();
  let secondDone = false; second.then(() => { secondDone = true; });
  await Promise.resolve(); assert.equal(secondDone, false);
  finish(); await Promise.all([first, second]); assert.equal(cleaned, true);
});

test("recovery preserves unfinished jobs owned by a live process", () => {
  const store = createTaskStore(path.join(root, "live-owner"));
  const task = store.create(request);
  store.update(task.id, { status: "running" });
  store.recoverInterrupted();
  assert.equal(store.get(task.id).status, "running");
});

const defaultAgents = { participants: ["codex", "claude"], coordinator: "codex", effort: { codex: "auto", claude: "auto" } };

test("settings default to Codex + Claude and keep old settings when migrating", () => {
  const data = path.join(root, "settings-migrate");
  assert.deepEqual(createTaskStore(data).loadSettings({ workspace }), { workspace, closeLaunchedApps: false, agentDefaults: defaultAgents });
  writeFileSync(path.join(data, "settings.json"), JSON.stringify({ workspace: "C:\old", closeLaunchedApps: true }), "utf8");
  const store = createTaskStore(data);
  const loaded = store.loadSettings({ workspace });
  assert.deepEqual(loaded, { workspace: "C:\old", closeLaunchedApps: true, agentDefaults: defaultAgents });
  assert.deepEqual(store.saveSettings({ workspace: "C:\old", closeLaunchedApps: true }), loaded);
});

test("agent defaults survive a save and reload", () => {
  const data = path.join(root, "settings-roundtrip");
  const cases = [
    { participants: ["antigravity", "claude", "codex"], coordinator: "claude", effort: { codex: "high", claude: "max" } },
    { participants: ["antigravity"], coordinator: "codex", effort: { codex: "auto", claude: "auto" } },
  ];
  for (const agentDefaults of cases) {
    const saved = createTaskStore(data).saveSettings({ workspace, closeLaunchedApps: true, agentDefaults });
    const reloaded = createTaskStore(data).loadSettings();
    assert.deepEqual(reloaded, saved);
    assert.equal(reloaded.workspace, workspace);
    assert.equal(reloaded.closeLaunchedApps, true);
  }
  // Participants are stored in registry order, the coordinator must be a participant, and effort is completed.
  const store = createTaskStore(data);
  const normalized = store.saveSettings({ workspace, agentDefaults: { participants: ["claude", "antigravity"], coordinator: "codex", effort: { codex: "low" } } });
  assert.deepEqual(normalized.agentDefaults, { participants: ["claude", "antigravity"], coordinator: "claude", effort: { codex: "low", claude: "auto" } });
  assert.deepEqual(JSON.parse(readFileSync(path.join(data, "settings.json"), "utf8")), normalized);
});

test("saving rejects invalid agent defaults without overwriting settings", () => {
  const data = path.join(root, "settings-invalid");
  const store = createTaskStore(data);
  const kept = store.saveSettings({ workspace, closeLaunchedApps: true, agentDefaults: { participants: ["claude"], coordinator: "claude" } });
  for (const agentDefaults of [
    { participants: [] }, { participants: ["codex", "unknown"] }, { participants: ["codex", "codex"] }, { participants: "codex" },
    { participants: ["claude"], coordinator: "antigravity" }, { participants: ["claude"], coordinator: "unknown" },
    { effort: { codex: "extreme" } }, { effort: "high" }, null, ["codex"], "codex",
  ]) {
    assert.throws(() => store.saveSettings({ workspace, agentDefaults }), undefined, JSON.stringify(agentDefaults));
  }
  assert.deepEqual(createTaskStore(data).loadSettings(), kept);
});

test("malformed persisted settings fall back to safe defaults per field", () => {
  const data = path.join(root, "settings-malformed");
  const file = path.join(data, "settings.json");
  createTaskStore(data);
  for (const content of ["{not json", "null", "[]", "\"text\""]) {
    writeFileSync(file, content, "utf8");
    assert.deepEqual(createTaskStore(data).loadSettings({ workspace }), { workspace, closeLaunchedApps: false, agentDefaults: defaultAgents });
  }
  writeFileSync(file, JSON.stringify({ workspace: "C:\kept", closeLaunchedApps: true,
    agentDefaults: { participants: ["unknown"], coordinator: 5, effort: { codex: "extreme" } } }), "utf8");
  assert.deepEqual(createTaskStore(data).loadSettings(), { workspace: "C:\kept", closeLaunchedApps: true, agentDefaults: defaultAgents });
  writeFileSync(file, JSON.stringify({ agentDefaults: { participants: ["antigravity", "claude"], coordinator: "codex", effort: "bad" } }), "utf8");
  assert.deepEqual(createTaskStore(data).loadSettings().agentDefaults, { participants: ["claude", "antigravity"], coordinator: "claude", effort: defaultAgents.effort });
  writeFileSync(file, JSON.stringify({ agentDefaults: { participants: [], effort: { claude: "high" } } }), "utf8");
  assert.deepEqual(createTaskStore(data).loadSettings().agentDefaults, { ...defaultAgents, effort: { codex: "auto", claude: "high" } });
  writeFileSync(file, JSON.stringify({ agentDefaults: [] }), "utf8");
  assert.deepEqual(createTaskStore(data).loadSettings().agentDefaults, defaultAgents);
});
