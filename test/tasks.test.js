import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
