import { randomUUID } from "node:crypto";

export function createTaskManager({ store, runtime, onChange = () => {} }) {
  const ownerId = randomUUID();
  const queue = [];
  const waiters = new Map();
  const controllers = new Map();
  let currentPromise = null;
  let shuttingDown = false;
  let pumping = false;
  let pumpScheduled = false;
  let shutdownPromise = null;
  function changed() { onChange(); }
  function resolveWaiters(task) {
    for (const resolve of waiters.get(task.id) || []) resolve(task);
    waiters.delete(task.id);
  }
  function complete(id, changes) {
    const task = store.update(id, { ...changes, finishedAt: new Date().toISOString() });
    resolveWaiters(task);
    changed();
    return task;
  }
  function wait(id) {
    const task = store.get(id);
    if (!task) return Promise.reject(new Error("找不到任務。"));
    if (["completed", "failed", "cancelled", "interrupted", "paused"].includes(task.status)) return Promise.resolve(task);
    return new Promise(resolve => { const list = waiters.get(id) || []; list.push(resolve); waiters.set(id, list); });
  }
  async function pump() {
    if (pumping || shuttingDown) return;
    pumping = true;
    try {
      while (queue.length && !shuttingDown) {
        const id = queue.shift();
        const queued = store.get(id);
        if (queued?.status !== "queued") continue;
        const controller = new AbortController();
        controllers.set(id, controller);
        const task = store.update(id, { status: "running", startedAt: new Date().toISOString(), progress: "準備執行" });
        changed();
        try {
          const result = await runtime.run(task, {
            signal: controller.signal,
            onProgress(event) {
              const current = store.get(id);
              if (current?.status !== "running") return;
              if (event.type === "stage" && event.stage) {
                const stages = [...current.stages];
                const index = stages.findIndex(stage => stage.name === event.stage.name);
                if (index < 0) stages.push(event.stage); else stages[index] = { ...stages[index], ...event.stage };
                store.update(id, { stages, progress: event.stage.name });
              } else if (event.type === "dispatch" && event.dispatch) {
                store.update(id, { dispatch: event.dispatch });
              } else if (event.type === "progress") {
                store.update(id, { progress: String(event.message || "執行中").slice(0, 500) });
              }
              changed();
            },
          });
          if (controller.signal.aborted) complete(id, { status: "cancelled", progress: "已取消", error: "任務已停止；已完成的檔案修改會保留。" });
          else complete(id, { status: "completed", progress: "執行完成", output: result.output || "", stages: result.stages || store.get(id).stages, warnings: result.warnings || [], ...(result.dispatch ? { dispatch: result.dispatch } : {}) });
        } catch (error) {
          if (error.code === "QUOTA_PAUSED" && !controller.signal.aborted && store.get(id)?.source !== "mcp") {
            // Both agents are out of quota: keep the checkpointed state and wait for the user to resume.
            store.update(id, { status: "paused", progress: "額度用盡，已暫停", pausedAt: new Date().toISOString(), resumeAt: error.resumeAt || null,
              pauseReason: error.message, dispatch: error.dispatch, ...(error.stages ? { stages: error.stages } : {}) });
            resolveWaiters(store.get(id));
            changed();
            continue;
          }
          complete(id, { status: controller.signal.aborted ? "cancelled" : "failed", progress: controller.signal.aborted ? "已取消" : "執行失敗", error: controller.signal.aborted ? "任務已停止；已完成的檔案修改會保留。" : error.message, ...(error.stages ? { stages: error.stages } : {}) });
        } finally { controllers.delete(id); }
      }
    } finally { pumping = false; }
  }
  function submit(input) {
    if (shuttingDown) throw new Error("管理器正在關閉，無法新增任務。");
    const task = store.create({ ...input, ownerId });
    queue.push(task.id);
    changed();
    if (!pumping && !pumpScheduled) {
      pumpScheduled = true;
      currentPromise = Promise.resolve().then(() => { pumpScheduled = false; return pump(); });
      currentPromise.catch(() => {});
    }
    return task;
  }
  /** Continues a paused task from its saved checkpoint; an optional note from the user is passed to the agents. */
  function resume(id, note) {
    if (shuttingDown) throw new Error("管理器正在關閉，無法續作。");
    const task = store.get(id);
    if (!task) throw new Error("找不到任務。");
    if (task.status !== "paused") throw new Error("這個任務沒有暫停，無法續作。");
    const notes = [...(Array.isArray(task.resumeNotes) ? task.resumeNotes : [])];
    if (typeof note === "string" && note.trim()) notes.push({ at: new Date().toISOString(), text: note.trim().slice(0, 8000) });
    store.update(id, { status: "queued", progress: "等待續作", ownerId, ownerPid: process.pid, resumeNotes: notes, resumeAt: null });
    queue.push(id);
    changed();
    if (!pumping && !pumpScheduled) {
      pumpScheduled = true;
      currentPromise = Promise.resolve().then(() => { pumpScheduled = false; return pump(); });
      currentPromise.catch(() => {});
    }
    return store.get(id);
  }
  async function cancel(id) {
    const task = store.get(id);
    if (!task) throw new Error("找不到任務。");
    if (task.status === "paused") return complete(id, { status: "cancelled", progress: "已停止", error: "已停止暫停中的任務；已完成的檔案修改會保留。" });
    if (task.ownerId !== ownerId) throw new Error("這個任務由另一個管理器執行，無法在此停止。");
    if (task.status === "queued") return complete(id, { status: "cancelled", progress: "已取消" });
    if (task.status === "running") {
      store.update(id, { progress: "正在停止任務" }); changed();
      controllers.get(id)?.abort();
      return wait(id);
    }
    return task;
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    for (const id of queue.splice(0)) {
      if (store.get(id)?.status === "queued") complete(id, { status: "cancelled", progress: "管理視窗已關閉" });
    }
    for (const controller of controllers.values()) controller.abort();
    shutdownPromise = (async () => {
      await runtime.close();
      await currentPromise;
      for (const [id] of waiters) {
        const task = store.get(id);
        if (task) resolveWaiters(task);
      }
    })();
    return shutdownPromise;
  }
  return { submit, resume, wait, cancel, shutdown, get shuttingDown() { return shuttingDown; }, get ownerId() { return ownerId; } };
}
