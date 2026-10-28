import path from "node:path";
import { createAgentRuntime } from "../agent-runtime.js";
import { createAppManager } from "../app-manager.js";
import { createTaskStore } from "../task-store.js";
import { createTaskManager } from "../task-manager.js";
import { createHttpBridge } from "../http-bridge.js";
import { createConversationStore } from "../conversation-store.js";
import { createUsageMonitor } from "../usage-monitor.js";
import { createClaudeQuotaCache } from "../claude-quota-cache.js";
import { createChatAttachments } from "../chat-attachments.js";
import { PROVIDER_IDS, PROVIDERS, providerSummaries } from "../providers.js";

const LOGIN_POLL_MS = 3000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function createDesktopServices({ projectRoot, dataDirectory = path.join(projectRoot, ".bridge"), runtime: suppliedRuntime, appManager: suppliedApps, usageMonitor: suppliedUsage, port = 47931, onChange = () => {},
  loginPollMs = LOGIN_POLL_MS, loginTimeoutMs = LOGIN_TIMEOUT_MS }) {
  const store = createTaskStore(dataDirectory);
  const conversationStore = createConversationStore(dataDirectory);
  const attachmentStore = createChatAttachments(dataDirectory);
  const deletingConversations = new Map();
  const quotaCache = createClaudeQuotaCache(dataDirectory, { onChange });
  // The dispatcher reads both agents' latest known quota before every phase.
  const currentQuotas = () => ({ codex: usageMonitor.get()?.codex?.quota || null, claude: quotaCache.snapshot().quota || null });
  const runtime = suppliedRuntime || createAgentRuntime({ runtimeDirectory: path.join(dataDirectory, "runtime"), onClaudeQuota: acceptQuota, getQuotas: currentQuotas });
  const appManager = suppliedApps || createAppManager();
  const usageMonitor = suppliedUsage || createUsageMonitor();
  let settings = store.loadSettings({ workspace: projectRoot });
  const unknown = { available: false, authenticated: null, version: "", error: "正在檢查連線" };
  let agents = Object.fromEntries(PROVIDER_IDS.map((id) => [id, { ...unknown }]));
  let apps = Object.fromEntries(PROVIDER_IDS.map((id) => [id, { installed: false, running: false, managed: false, pids: [] }]));
  // A credential marker is not verified authentication. App-only re-login may be opened without a completion claim.
  const logins = new Map();
  const loginControllers = new Set();
  let shuttingDown = false; let closed = null; let refreshing = null; let usageRefreshing = null; let timer = null;
  let quotaRefreshing = null; let quotaController = null; let lastQuotaAttempt = 0;
  const taskManager = createTaskManager({ store, runtime, onChange });
  const bridge = createHttpBridge({ runtime, taskManager, workspaceHint: null, port, onChange });
  function snapshot() {
    const allTasks = store.listAll();
    const usage = usageMonitor.get() || {};
    return {
      agents: Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, logins.has(id) ? { ...agent, login: { ...logins.get(id) } } : agent])),
      providers: providerSummaries(), apps, settings: { ...settings }, bridge: bridge.getStatus(), shuttingDown,
      usage: { ...usage, claude: { ...(usage.claude || {}), ...quotaCache.snapshot() } },
      conversations: conversationStore.list(allTasks),
      tasks: store.list().map(task => {
        const planned = Array.isArray(task.dispatch?.steps) && task.dispatch.steps.length ? task.dispatch.steps.length : 1;
        // Plan, each step and one review, plus a revision and another review for every round returned so far.
        const expected = task.workflow === "coordinated" ? planned + 2 + 2 * (Number(task.dispatch?.round) || 0) : 1;
        const finished = task.stages.filter(stage => stage.status === "completed").length;
        const progressPercent = task.status === "completed" ? 100 : task.status === "queued" ? 0 : Math.min(95, Math.round(100 * finished / expected) + (task.status === "running" ? 5 : 0));
        return { ...task, progressPercent };
      }),
      processes: runtime.activeProcesses(),
    };
  }
  async function refreshStatus({ refreshQuota = true } = {}) {
    if (refreshing) {
      if (refreshQuota) refreshing.then(() => { refreshClaudeQuota({ force: true }).catch(() => {}); });
      return refreshing;
    }
    if (shuttingDown) return snapshot();
    refreshing = (async () => {
      // Usage scanning runs separately so slow log folders never delay the CLI status that gates sending.
      refreshUsage();
      const results = await Promise.allSettled([runtime.probe(), appManager.list()]);
      if (!shuttingDown) {
        if (results[0].status === "fulfilled") agents = results[0].value;
        else agents = Object.fromEntries(PROVIDER_IDS.map((id) => [id, { ...unknown, error: results[0].reason.message }]));
        for (const id of PROVIDER_IDS) {
          const observed = PROVIDERS[id].signInWith === "app" ? agents[id]?.credentialPresent === true : agents[id]?.authenticated === true;
          if (observed && logins.get(id)?.state === "failed") logins.delete(id);
        }
        if (results[1].status === "fulfilled") apps = results[1].value;
        if (refreshQuota) refreshClaudeQuota({ force: true }).catch(() => {});
        onChange();
      }
      return snapshot();
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }
  function refreshUsage() {
    if (usageRefreshing || shuttingDown) return usageRefreshing;
    usageRefreshing = usageMonitor.refresh().then(() => { if (!shuttingDown) onChange(); }, () => {}).finally(() => { usageRefreshing = null; });
    return usageRefreshing;
  }
  function acceptQuota(quota) {
    if (shuttingDown) return false;
    try { return quotaCache.update(quota); }
    catch { quotaCache.setStatus("error", "額度已收到，但無法保存本機快取。"); return false; }
  }
  function refreshClaudeQuota({ force = false } = {}) {
    if (quotaRefreshing) return quotaRefreshing;
    if (shuttingDown || !agents.claude?.available || !agents.claude?.authenticated) return Promise.resolve(quotaCache.snapshot());
    if (typeof runtime.queryClaudeQuota !== "function") return Promise.resolve(quotaCache.snapshot());
    if ((!force && quotaCache.fresh()) || Date.now() - lastQuotaAttempt < 60_000) return Promise.resolve(quotaCache.snapshot());
    // Never run a quota-only model request on the 20-second status timer.
    lastQuotaAttempt = Date.now();
    quotaController = new AbortController();
    quotaCache.setStatus("loading", "正在向 Claude CLI 取得方案額度…");
    quotaRefreshing = (async () => {
      try {
        const quota = await runtime.queryClaudeQuota({ workspace: projectRoot }, { signal: quotaController.signal });
        if (!shuttingDown) {
          if (quota) acceptQuota(quota);
          else quotaCache.setStatus("no-data", "此次 Claude CLI 沒有回傳方案額度；請確認使用訂閱登入及支援的 CLI 版本。");
        }
      } catch (error) {
        if (!shuttingDown) quotaCache.setStatus("error", `Claude 額度更新失敗：${String(error.message || error).replace(/\b(?:sk|sess|token)-[a-z0-9_-]{8,}\b/gi, "[已隱藏憑證]").slice(0, 350)}`);
      } finally { quotaController = null; }
      return quotaCache.snapshot();
    })();
    quotaRefreshing.finally(() => { quotaRefreshing = null; }).catch(() => {});
    return quotaRefreshing;
  }
  async function start() {
    if (shuttingDown) return snapshot();
    store.recoverInterrupted();
    await bridge.start();
    if (shuttingDown) return snapshot();
    timer = setInterval(() => { refreshStatus({ refreshQuota: false }).catch(() => {}); }, 20000);
    timer.unref?.();
    await refreshStatus({ refreshQuota: false });
    refreshClaudeQuota().catch(() => {});
    return snapshot();
  }
  function updateSettings(changes) {
    if (shuttingDown) throw new Error("管理器正在關閉。");
    if (changes.workspace !== undefined && typeof changes.workspace !== "string") throw new Error("無效的專案路徑。");
    if (changes.closeLaunchedApps !== undefined && typeof changes.closeLaunchedApps !== "boolean") throw new Error("無效的關閉設定。");
    settings = store.saveSettings({ ...settings, ...changes }); onChange(); return settings;
  }
  function waitForLoginPoll(signal) {
    return new Promise((resolve) => {
      if (signal.aborted) { resolve(false); return; }
      const complete = (active) => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(active); };
      const abort = () => complete(false);
      const timer = setTimeout(() => complete(true), loginPollMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  /** Open the provider's own sign-in UI. Bridge observes process/credential state, never credential contents. */
  async function loginAgent(id) {
    if (shuttingDown) throw new Error("管理器正在關閉。");
    if (!PROVIDER_IDS.includes(id)) throw new Error("無效的 AI。");
    const viaApp = PROVIDERS[id].signInWith === "app";
    if (logins.get(id)?.state === "pending") throw new Error(`${PROVIDERS[id].appName} 的登入視窗已經開啟，請在${viaApp ? " App 內完成登入" : "瀏覽器完成授權"}。`);
    if (!viaApp && !agents[id]?.available) throw new Error(`${PROVIDERS[id].appName} CLI 尚未安裝或無法執行，無法從這裡登入。`);
    const markerBefore = agents[id]?.credentialPresent;
    const login = { state: "pending", message: viaApp ? `正在開啟 ${PROVIDERS[id].appName} 登入介面…` : "正在開啟登入視窗…", startedAt: new Date().toISOString() };
    const controller = new AbortController();
    const active = () => !shuttingDown && !controller.signal.aborted && logins.get(id) === login;
    const cleanup = () => { loginControllers.delete(controller); controller.abort(); };
    // Reserve before awaiting launch so concurrent callers cannot open duplicate sign-in windows.
    logins.set(id, login); loginControllers.add(controller); onChange();
    let session;
    let expectedRoots = null;
    try {
      if (viaApp) {
        const app = await launchApp(id);
        if (!active()) throw new Error("管理器正在關閉，登入已停止。");
        if (!app.running) throw new Error(`無法開啟 ${PROVIDERS[id].appName}：${app.error || "沒有偵測到執行中的 App。"}`);
        expectedRoots = Array.isArray(app.rootProcesses) && app.rootProcesses.length ? app.rootProcesses.map((item) => ({ ...item })) : null;
        if (markerBefore === true) {
          const opened = { ...login, state: "opened", message: `已開啟 ${PROVIDERS[id].appName}，請在 App 內確認帳號或重新登入。已偵測到的憑證不代表登入仍有效。` };
          logins.set(id, opened); cleanup(); onChange();
          return { id, login: { ...opened } };
        }
        login.message = `已開啟 ${PROVIDERS[id].appName}，請在 App 內完成 Google 登入。`;
      } else {
        session = await runtime.login(id);
        if (!active()) throw new Error("管理器正在關閉，登入已停止。");
        login.message = "已開啟登入視窗，請在瀏覽器完成授權。";
      }
    } catch (error) {
      if (logins.get(id) === login) logins.delete(id);
      cleanup(); onChange(); throw error;
    }
    onChange();
    let consoleClosed = false;
    session?.exited?.then(() => { consoleClosed = true; }, () => { consoleClosed = true; });
    const deadline = Date.now() + loginTimeoutMs;
    (async () => {
      let closedChecks = 0;
      let inventoryFailures = 0;
      while (active()) {
        if (!await waitForLoginPoll(controller.signal) || !active()) return;
        const results = await Promise.allSettled([
          runtime.probeAgent(id, controller.signal),
          viaApp ? appManager.list() : Promise.resolve(null),
        ]);
        if (!active()) return;
        const status = results[0].status === "fulfilled" ? results[0].value : null;
        if (status) agents = { ...agents, [id]: status };
        if (viaApp && results[1].status === "fulfilled" && results[1].value) apps = { ...apps, ...results[1].value };
        if (viaApp ? status?.credentialPresent === true : status?.authenticated === true) {
          logins.delete(id); onChange();
          if (id === "claude") refreshClaudeQuota({ force: true }).catch(() => {});
          return;
        }
        const observedApp = viaApp && results[1].status === "fulfilled" ? results[1].value?.[id] : null;
        if (viaApp && (results[1].status === "rejected" || observedApp?.error)) inventoryFailures++; else inventoryFailures = 0;
        if (inventoryFailures > 1) {
          logins.set(id, { ...login, state: "failed", message: `無法確認 ${PROVIDERS[id].appName} 程序是否仍在執行，請重新整理或重試。` }); onChange(); return;
        }
        const rootsGone = expectedRoots && Array.isArray(observedApp?.rootProcesses)
          && !expectedRoots.some((expected) => observedApp.rootProcesses.some((item) => item.pid === expected.pid && item.created === expected.created));
        const appClosed = observedApp && !observedApp.error && (observedApp.running === false || rootsGone);
        if (viaApp ? appClosed : consoleClosed) closedChecks++; else closedChecks = 0;
        // Give the provider one final check in case it saves a marker as its UI closes.
        if (closedChecks > 1) {
          const message = viaApp ? `${PROVIDERS[id].appName} 已結束，但尚未偵測到新的登入憑證。請重新開啟 App；若持續發生，請查看 App 日誌。`
            : "登入視窗已關閉，但尚未偵測到登入。可以再試一次。";
          logins.set(id, { ...login, state: "failed", message }); onChange(); return;
        }
        if (Date.now() > deadline) { logins.set(id, { ...login, state: "failed", message: viaApp ? "等待登入逾時，尚無法確認登入憑證。請在 App 內確認帳號後重試。" : "等待登入逾時。完成授權後按重新整理，或再試一次。" }); onChange(); return; }
        onChange();
      }
    })().catch(() => {
      if (active()) { logins.set(id, { ...login, state: "failed", message: "無法持續確認登入狀態，請重新整理或重試。" }); onChange(); }
    }).finally(cleanup);
    return { id, login: { ...login } };
  }
  async function launchApp(id) {
    if (shuttingDown) throw new Error("管理器正在關閉。");
    const launched = await appManager.launch(id);
    if (shuttingDown) throw new Error("管理器正在關閉。");
    apps = { ...apps, [id]: launched }; onChange(); return apps[id];
  }
  async function closeApp(id) { apps = { ...apps, [id]: await appManager.close(id) }; onChange(); return apps[id]; }
  function createConversation(input = {}) {
    if (shuttingDown) throw new Error("管理器正在關閉，無法建立對話。");
    const room = conversationStore.create({ workspace: settings.workspace, ...input });
    onChange();
    return room;
  }
  function sendMessage(input) {
    if (shuttingDown) throw new Error("管理器正在關閉，無法傳送訊息。");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("無效的訊息。");
    if (deletingConversations.has(input.conversationId)) throw new Error("對話正在刪除，無法傳送訊息。");
    const tasks = store.listAll();
    // A message in a room whose task is paused for quota resumes that task; the words go along as extra instructions.
    const paused = tasks.find(task => (task.conversationId || task.id) === input.conversationId && task.status === "paused");
    if (paused) {
      const resumed = taskManager.resume(paused.id, typeof input.message === "string" ? input.message : "");
      onChange();
      return resumed;
    }
    const existing = conversationStore.get(input.conversationId, tasks);
    const attachments = attachmentStore.resolveMany(input.attachmentIds);
    const selectedWorkspace = typeof input.workspace === "string" && !input.workspace.trim() ? (settings.workspace || projectRoot)
      : input.workspace ?? (existing?.workspace || settings.workspace || projectRoot);
    const prepared = conversationStore.prepareMessage({ ...input, attachments, workspace: selectedWorkspace }, tasks);
    const task = taskManager.submit(prepared.taskInput);
    conversationStore.recordSubmission(prepared.room, task);
    onChange();
    return task;
  }
  function importImages(input) {
    if (shuttingDown) throw new Error("管理器正在關閉，無法加入圖片。");
    return attachmentStore.importImages(input);
  }
  function deleteConversation(id) {
    if (shuttingDown) return Promise.reject(new Error("管理器正在關閉，無法刪除對話。"));
    if (deletingConversations.has(id)) return deletingConversations.get(id);
    const all = store.listAll();
    if (!conversationStore.get(id, all)) return Promise.reject(new Error("找不到對話。"));
    const related = all.filter(task => (task.conversationId || task.id) === id);
    const deleting = Promise.resolve().then(async () => {
      for (const task of related) if (["queued", "running"].includes(task.status)) await taskManager.cancel(task.id);
      const references = task => [...(task.attachments || []), ...(task.conversationContext || []).flatMap(message => message.attachments || [])].map(image => image.id);
      const deletingIds = new Set(related.flatMap(references));
      const protectedIds = new Set(store.listAll().filter(task => (task.conversationId || task.id) !== id).flatMap(references));
      for (const task of related) store.remove(task.id);
      conversationStore.remove(id);
      let warning;
      try { attachmentStore.remove([...deletingIds].filter(imageId => !protectedIds.has(imageId))); }
      catch { warning = "對話已刪除，但部分圖片無法清理；剩餘圖片仍保留在本機快取。"; }
      onChange();
      return { id, deleted: true, ...(warning ? { warning } : {}) };
    });
    deletingConversations.set(id, deleting);
    deleting.finally(() => deletingConversations.delete(id)).catch(() => {});
    return deleting;
  }
  function shutdown() {
    if (closed) return closed;
    shuttingDown = true; clearInterval(timer); onChange();
    for (const controller of loginControllers) controller.abort();
    logins.clear();
    quotaController?.abort();
    closed = (async () => {
      // The usage scan is read-only, so shutdown does not wait for it.
      await Promise.allSettled([taskManager.shutdown(), bridge.stop(), quotaRefreshing, ...deletingConversations.values()]);
      try { if (settings.closeLaunchedApps) apps = await appManager.closeOwned(); }
      finally { await appManager.dispose?.(); }
      onChange();
    })();
    return closed;
  }
  return { start, snapshot, refreshStatus, refreshClaudeQuota, updateSettings, loginAgent, launchApp, closeApp, shutdown, createConversation, sendMessage, importImages, deleteConversation,
    resumeTask: (id, note) => { const task = taskManager.resume(id, note); onChange(); return task; },
    createTask: input => taskManager.submit({ title: input?.title, task: input?.task, workspace: input?.workspace,
      workflow: input?.workflow, participants: input?.participants, mode: input?.mode, effort: input?.effort, coordinator: input?.coordinator, max_turns: input?.max_turns, source: "desktop" }), cancelTask: id => taskManager.cancel(id),
    startBridge: () => { if (shuttingDown) throw new Error("管理器正在關閉。"); return bridge.start(); }, stopBridge: () => bridge.stop(),
    taskManager, runtime, store, conversationStore, quotaCache, attachmentStore,
  };
}
