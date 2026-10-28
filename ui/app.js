"use strict";

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const VIEW_LABELS = { workspace: "聊天室", apps: "App 管理", history: "對話紀錄", settings: "設定" };
const WORKFLOW_LABELS = { coordinated: "協作", codex: "Codex", claude: "Claude" };
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
// Keep in sync with src/effort.js. "auto" passes no flag to the CLI.
const EFFORT_LEVELS = { codex: ["auto", "low", "medium", "high", "xhigh", "max", "ultra"], claude: ["auto", "low", "medium", "high", "xhigh", "max"] };
const EFFORT_LABELS = { auto: "預設", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
const EFFORT_SHORT = { low: "Low", medium: "Med", high: "High", xhigh: "XHigh", max: "Max", ultra: "Ultra" };
function effortOf(value) {
  const effort = { codex: "auto", claude: "auto" };
  for (const agent of Object.keys(EFFORT_LEVELS)) if (EFFORT_LEVELS[agent].includes(value?.[agent])) effort[agent] = value[agent];
  return effort;
}
function coordinatorOf(value) { return value === "claude" ? "claude" : "codex"; }
function workflowAgents(workflow) { return workflow === "coordinated" ? ["codex", "claude"] : [workflow]; }
const state = {
  snapshot: { agents: {}, bridge: { state: "starting", tools: [] }, apps: {}, tasks: [], conversations: [], settings: { workspace: "", closeLaunchedApps: false }, shuttingDown: false },
  loaded: false, view: "workspace", selectedConversationId: null,
  options: { workspace: "", workflow: "coordinated", effort: effortOf(), coordinator: "codex" }, optionDirty: false,
  drafts: new Map(), busy: new Set(), error: null, apiError: null, toastTimer: null,
  settingsWorkspaceDirty: false, composing: false, forceScroll: false,
  renderedRoom: undefined, renderedMessages: "",
  inspector: { open: false, tab: "usage" }, inspectorHtml: "",
  imageDrafts: new Map(), imageErrors: new Map(), imagePreviews: new Map(), uploadingImages: new Map(), imageGenerations: new Map(), deletedRooms: new Set(),
  renderedDraftImages: "", pendingDeleteId: null, dragDepth: 0,
};

function conversation() { return (state.snapshot.conversations || []).find((room) => room.id === state.selectedConversationId) || null; }
function roomsByRecency() { return [...(state.snapshot.conversations || [])].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)); }
function rolePreview() {
  if (state.options.workflow !== "coordinated") return "";
  const usage = state.snapshot.usage || {};
  const remaining = (quota) => {
    let left = null;
    for (const window of [quota?.primary, quota?.secondary]) {
      if (!window || !Number.isFinite(window.usedPercent)) continue;
      const reset = Date.parse(window.resetsAt);
      if (window.usedPercent >= 100 && !(Number.isFinite(reset) && reset <= Date.now())) return 0;
      if (window === quota.primary) left = Number.isFinite(reset) && reset <= Date.now() ? 100 : Math.max(0, 100 - window.usedPercent);
    }
    return left;
  };
  const left = { codex: remaining(usage.codex?.quota), claude: remaining(usage.claude?.quota) };
  const lead = coordinatorOf(state.options.coordinator); const other = lead === "codex" ? "claude" : "codex";
  const name = (agent) => agent === "codex" ? "Codex" : "Claude";
  if (left[lead] === 0 && left[other] === 0) return "兩邊額度都已用盡";
  if (left[lead] === 0) return `${name(lead)} 額度已用盡，改由 ${name(other)} 統籌`;
  if (left[other] === 0) return `${name(lead)} 統籌並執行`;
  return `${name(lead)} 統籌審查`;
}
/** Shown above the composer while the room's task waits for quota; resuming is always the user's call. */
function renderPauseBanner() {
  const banner = $("#pause-banner"); const task = pausedTask();
  banner.hidden = !task;
  if (!task) { banner.innerHTML = ""; return; }
  const steps = Array.isArray(task.dispatch?.steps) ? task.dispatch.steps : [];
  const done = steps.filter((step) => step.status === "done").length;
  const resume = task.resumeAt ? new Date(task.resumeAt) : null;
  const when = resume && resume.getTime() > Date.now() ? `預估 ${new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(resume)} 後額度恢復。` : "";
  const busy = state.busy.has(`resume-${task.id}`) || state.busy.has(`cancel-${task.id}`) || state.snapshot.shuttingDown;
  banner.innerHTML = `<div class="pause-text">${icon("clock")}<div><strong>額度用盡，任務已暫停並保存進度${steps.length ? `（已完成 ${done}/${steps.length} 步）` : ""}</strong><p>${escapeHtml(when)}額度恢復後按「接續完成」，或在下方輸入補充說明再傳送，會從中斷處繼續。</p></div></div><div class="pause-actions"><button type="button" class="button primary" data-resume-task="${escapeHtml(task.id)}" ${busy ? "disabled" : ""}>${icon("play")}接續完成</button><button type="button" class="button secondary" data-cancel-task="${escapeHtml(task.id)}" ${busy ? "disabled" : ""}>${icon("stop")}停止</button></div>`;
  $("#task-description").placeholder = "輸入補充說明並傳送，即可接續完成…";
}
function pausedTask() {
  const room = conversation();
  return room ? (state.snapshot.tasks || []).find((task) => (task.conversationId || task.id) === room.id && task.status === "paused") || null : null;
}
function activeTaskId() {
  const id = conversation()?.activeTaskId;
  if (!id) return null;
  const task = (state.snapshot.tasks || []).find((candidate) => candidate.id === id);
  return task && !ACTIVE_STATUSES.has(task.status) ? null : id;
}
function currentDraftKey() { return state.selectedConversationId || "new"; }
function draftImages(key = currentDraftKey()) { return state.imageDrafts.get(key) || []; }
function previewUrl(image) {
  const candidate = image?.previewUrl || state.imagePreviews.get(image?.id) || "";
  return /^bridge-image:\/\/[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}\/?$/i.test(candidate) || /^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/=\s]+$/i.test(candidate) ? candidate : "";
}
function imageMarkup(images, editable = false) {
  return images.map((image) => {
    const url = previewUrl(image);
    const name = image.name || "圖片";
    return `<div class="${editable ? "draft-image" : "message-image"}"${editable ? ' role="listitem"' : ""}><button class="image-thumbnail" type="button" ${url ? `data-preview-url="${escapeHtml(url)}" data-preview-name="${escapeHtml(name)}"` : "disabled"} aria-label="預覽 ${escapeHtml(name)}">${url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy"/>` : icon("image")}</button>${editable ? `<button type="button" class="draft-image-remove" data-remove-attachment="${escapeHtml(image.id)}" aria-label="移除 ${escapeHtml(name)}" title="移除圖片" ${state.busy.has("send-message") ? "disabled" : ""}>${icon("close")}</button>` : ""}<span class="image-filename" title="${escapeHtml(name)}">${escapeHtml(name)}</span></div>`;
  }).join("");
}
function renderDraftImages() {
  const key = currentDraftKey(); const images = draftImages(key); const pending = state.uploadingImages.get(key) || 0;
  const signature = JSON.stringify([key, images.map((image) => [image.id, image.name, image.previewUrl]), state.busy.has("send-message")]);
  if (signature !== state.renderedDraftImages) { state.renderedDraftImages = signature; $("#draft-images").innerHTML = imageMarkup(images, true); }
  $("#draft-images").hidden = images.length === 0;
  $("#attachment-status").hidden = !pending;
  $("#attachment-status").textContent = pending ? `正在加入 ${pending} 張…` : "";
}
function fileMimeType(file) {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name?.split(".").at(-1)?.toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[extension] || "";
}
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("無法讀取這張圖片。"));
    reader.onerror = () => reject(new Error(`無法讀取 ${file.name || "圖片"}，請重新選擇。`));
    reader.onabort = () => reject(new Error("圖片讀取已取消。"));
    reader.readAsDataURL(file);
  });
}
async function importImageFiles(fileList) {
  const files = [...fileList]; const key = currentDraftKey();
  const generation = state.imageGenerations.get(key) || 0;
  if (!files.length || state.snapshot.shuttingDown || state.busy.has("send-message")) return;
  if (state.uploadingImages.has(key)) { showToast("圖片正在加入，請稍後再選擇。", true); return; }
  try {
    if (files.some((file) => !IMAGE_MIME_TYPES.has(fileMimeType(file)))) throw new Error("圖片支援 PNG、JPEG、WebP，請選擇這些格式。");
    if (files.some((file) => !file.size || file.size > MAX_IMAGE_BYTES)) throw new Error("每張圖片需大於 0 bytes，且不可超過 7 MiB。");
    const current = draftImages(key);
    if (current.length + files.length > MAX_IMAGES) throw new Error("每則訊息最多可加入 8 張圖片。");
    if (current.reduce((total, image) => total + (image.size || 0), 0) + files.reduce((total, file) => total + file.size, 0) > MAX_IMAGE_TOTAL_BYTES) throw new Error("每則訊息的圖片總大小不可超過 20 MiB。");
    state.uploadingImages.set(key, files.length); state.imageErrors.delete(key); if (currentDraftKey() === key) state.error = null; renderComposer();
    const images = await Promise.all(files.map(async (file, index) => {
      const mimeType = fileMimeType(file);
      return { name: file.name || `貼上圖片-${index + 1}`, mimeType, dataUrl: (await readImageFile(file)).replace(/^data:[^;]*;base64,/, `data:${mimeType};base64,`) };
    }));
    const result = await invoke("importImages", { images });
    const imported = Array.isArray(result) ? result : result?.attachments;
    if (!Array.isArray(imported) || imported.length !== files.length || imported.some((image) => !image?.id)) throw new Error("圖片未能加入，請重新選擇。文字仍可正常傳送。");
    if (state.deletedRooms.has(key) || generation !== (state.imageGenerations.get(key) || 0)) return;
    imported.forEach((image, index) => { if (!image.previewUrl && images[index]) state.imagePreviews.set(image.id, images[index].dataUrl); });
    state.imageDrafts.set(key, [...draftImages(key), ...imported]);
  } catch (error) {
    if (!state.deletedRooms.has(key) && generation === (state.imageGenerations.get(key) || 0)) { state.imageErrors.set(key, errorMessage(error)); if (currentDraftKey() !== key) showToast(`圖片加入失敗：${errorMessage(error)}`, true); }
  } finally { state.uploadingImages.delete(key); renderComposer(); }
}
function dateLabel(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date); }
function errorMessage(error) { return String(typeof error === "string" ? error : error?.message || "操作未完成，請稍後重試。").replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ""); }
function statusBadge(label, type = "ready") { return `<span class="status-badge ${type}"><span class="status-dot ${type === "ready" ? "" : type}"></span>${escapeHtml(label)}</span>`; }
function agentStatus(agent = {}) {
  if (!state.loaded || state.apiError) return { text: "狀態待確認", type: "muted" };
  if (!agent.available) return { text: "CLI 不可用", type: "muted" };
  if (agent.authenticated === false) return { text: "需要登入", type: "warning" };
  if (agent.authenticated === true) return { text: "CLI 已登入", type: "ready" };
  return { text: "登入待確認", type: "warning" };
}
function showToast(message, isError = false) {
  const toast = $("#toast"); clearTimeout(state.toastTimer);
  $("span", toast).textContent = message; $("use", toast).setAttribute("href", isError ? "#i-warning" : "#i-check");
  toast.classList.toggle("error", isError); toast.hidden = false;
  state.toastTimer = setTimeout(() => { toast.hidden = true; }, isError ? 7000 : 3500);
}
function setView(view, focus = false) {
  if (!VIEW_LABELS[view]) return;
  state.view = view;
  state.dragDepth = 0; $("#image-drop-overlay").hidden = true;
  $$(".view").forEach((section) => { section.hidden = section.id !== `view-${view}`; section.classList.toggle("active", !section.hidden); });
  $$(".nav-item").forEach((button) => { const active = button.dataset.view === view; button.classList.toggle("active", active); button.title = VIEW_LABELS[button.dataset.view]; if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
  $("#view-title").textContent = VIEW_LABELS[view];
  $("#conversation-title").hidden = view !== "workspace";
  if (view === "workspace") { renderChat(); resizeComposer(); }
  if (focus) $("#main-content").focus({ preventScroll: true });
}
function saveDraft() { state.drafts.set(state.selectedConversationId || "new", $("#task-description").value); }
function loadDraft() { $("#task-description").value = state.drafts.get(state.selectedConversationId || "new") || ""; resizeComposer(); }
function selectConversation(id) {
  const room = (state.snapshot.conversations || []).find((candidate) => candidate.id === id);
  if (!room) return;
  saveDraft(); state.selectedConversationId = id; state.options = { workspace: room.workspace || "", workflow: room.workflow || "coordinated", effort: effortOf(room.effort), coordinator: coordinatorOf(room.coordinator) }; state.optionDirty = false; state.error = null; state.forceScroll = true;
  loadDraft(); syncOptionControls(); render(); setView("workspace"); $("#task-description").focus();
}
function resizeComposer() { const textarea = $("#task-description"); textarea.style.height = "auto"; textarea.style.height = `${Math.max(45, Math.min(150, textarea.scrollHeight))}px`; }
function syncOptionControls() {
  $("#task-workspace").value = state.options.workspace;
  $$("[data-workflow]").forEach((button) => { const selected = button.dataset.workflow === state.options.workflow; button.classList.toggle("selected", selected); button.setAttribute("aria-pressed", String(selected)); });
  $$("[data-coordinator]").forEach((button) => { const selected = button.dataset.coordinator === coordinatorOf(state.options.coordinator); button.classList.toggle("selected", selected); button.setAttribute("aria-pressed", String(selected)); });
  $("#coordinator-field").hidden = state.options.workflow !== "coordinated";
  $("#workflow-description").textContent = state.options.workflow === "coordinated" ? "統籌方把你的需求整理成驗收標準、依任務性質指派 Codex 或 Claude 執行，再逐條審查；未達標就退回修正（最多 2 輪），最後交付結果。額度只在一方用完時才交接。" : state.options.workflow === "codex" ? "由 Codex 回覆與處理這則訊息。" : "由 Claude Code 回覆與處理這則訊息。";
  const agents = workflowAgents(state.options.workflow);
  for (const agent of Object.keys(EFFORT_LEVELS)) {
    const levels = EFFORT_LEVELS[agent]; const level = state.options.effort[agent]; const index = Math.max(0, levels.indexOf(level));
    const slider = $(`#effort-${agent}`); slider.value = String(index); slider.style.setProperty("--fill", `${(index / (levels.length - 1)) * 100}%`);
    slider.setAttribute("aria-valuetext", EFFORT_LABELS[level]); slider.dataset.level = level;
    $(`#effort-${agent}-label`).textContent = EFFORT_LABELS[level]; $(`#effort-${agent}-label`).dataset.level = level;
    $(`[data-effort-row="${agent}"]`).hidden = !agents.includes(agent);
  }
}
function effortSummary() {
  return workflowAgents(state.options.workflow).filter((agent) => state.options.effort[agent] !== "auto")
    .map((agent) => `${agent === "codex" ? "Codex" : "Claude"} ${EFFORT_SHORT[state.options.effort[agent]]}`).join(" · ");
}
function messageHtml(message) {
  const role = message.role;
  const name = role === "user" ? "你" : role === "codex" ? "Codex" : "Claude";
  const content = String(message.content || "");
  const images = Array.isArray(message.attachments) ? message.attachments : [];
  const active = ACTIVE_STATUSES.has(message.status);
  const failure = ["failed", "cancelled", "interrupted"].includes(message.status);
  const statusText = message.status === "handoff" ? "已交接" : message.status === "paused" ? "已暫停" : message.status === "queued" ? "等待回覆" : message.status === "running" ? "正在回覆" : message.status === "cancelled" ? "已停止" : message.status === "interrupted" ? "已中斷" : message.status === "failed" ? "回覆未完成" : "";
  const formatted = escapeHtml(content).replace(/```(?:[\w-]+)?\n([\s\S]*?)```/g, "<pre>$1</pre>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  return `<article class="message" data-message-role="${role}" data-message-id="${escapeHtml(message.id)}"><div class="message-avatar">${icon(role === "claude" ? "claude" : "codex")}</div><div class="message-main"><div class="message-heading"><span class="message-name">${name}</span>${statusText ? `<span class="message-state ${failure ? "error" : ""}">${statusText}</span>` : ""}${content && role !== "user" ? `<button class="icon-button message-copy" data-copy-message="${escapeHtml(message.id)}" title="複製 ${name} 的回覆" aria-label="複製 ${name} 的回覆">${icon("copy")}</button>` : ""}</div>${message.note ? `<p class="message-note">${icon("link")}${escapeHtml(message.note)}</p>` : ""}${images.length ? `<div class="message-images" aria-label="訊息中的圖片">${imageMarkup(images)}</div>` : ""}${content ? `<div class="message-content">${formatted}</div>` : images.length ? "" : active ? '<div class="typing-dots" aria-label="正在等待回覆"><span></span><span></span><span></span></div>' : '<p class="message-no-content">這則回覆沒有內容。</p>'}</div></article>`;
}
function renderChat() {
  const room = conversation();
  const messages = (room?.messages || []).filter((message) => ["user", "codex", "claude"].includes(message.role));
  $("#conversation-title").textContent = room?.title || "新對話";
  const signature = JSON.stringify(messages.map((message) => [message.id, message.role, message.status, message.content, (Array.isArray(message.attachments) ? message.attachments : []).map((image) => [image.id, image.name, image.previewUrl])]));
  if (state.renderedRoom === state.selectedConversationId && state.renderedMessages === signature && !state.forceScroll) return;
  const scroll = $("#chat-scroll");
  const priorScroll = scroll.scrollTop;
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  const newRoom = state.renderedRoom !== state.selectedConversationId;
  $("#chat-messages").innerHTML = messages.length ? messages.map(messageHtml).join("") : `<div class="chat-welcome"><div class="welcome-agents" aria-hidden="true"><span class="welcome-agent">${icon("codex")}</span><span class="welcome-divider"></span><span class="welcome-agent claude">${icon("claude")}</span></div><h1>想一起完成什麼？</h1><p>直接輸入目標，Codex 與 Claude<br>會在這裡接力回覆。</p></div>`;
  state.renderedRoom = state.selectedConversationId; state.renderedMessages = signature;
  scroll.scrollTop = newRoom || state.forceScroll || nearBottom ? scroll.scrollHeight : priorScroll;
  state.forceScroll = false;
}
function renderHistory() {
  const rooms = roomsByRecency(); const query = $("#history-search").value.trim().toLocaleLowerCase();
  $("#history-count").textContent = String(rooms.length);
  $("#recent-conversations").innerHTML = rooms.length ? rooms.slice(0, 8).map((room) => `<div class="recent-room-row ${room.id === state.selectedConversationId ? "selected" : ""}"><button class="recent-room" data-conversation-id="${escapeHtml(room.id)}" title="${escapeHtml(room.title || "新對話")}">${escapeHtml(room.title || "新對話")}</button><button type="button" class="icon-button room-delete" data-delete-conversation-id="${escapeHtml(room.id)}" aria-label="刪除 ${escapeHtml(room.title || "新對話")}" title="刪除對話">${icon("trash")}</button></div>`).join("") : '<p class="recent-empty">開始對話後，<br>會在這裡找到紀錄。</p>';
  const filtered = rooms.filter((room) => !query || `${room.title || ""} ${(room.messages || []).map((message) => message.content || "").join(" ")}`.toLocaleLowerCase().includes(query));
  $("#history-list").innerHTML = filtered.length ? filtered.map((room) => `<div class="history-item"><button type="button" class="history-select" data-conversation-id="${escapeHtml(room.id)}">${icon("chat")}<span class="history-body"><span class="history-title">${escapeHtml(room.title || "新對話")}</span><span class="history-meta"><span>${dateLabel(room.updatedAt || room.createdAt)}</span><span>${room.messages?.length || 0} 則訊息</span><span>${escapeHtml(WORKFLOW_LABELS[room.workflow] || "協作")}</span></span></span>${icon("arrow")}</button><button type="button" class="icon-button room-delete" data-delete-conversation-id="${escapeHtml(room.id)}" aria-label="刪除 ${escapeHtml(room.title || "新對話")}" title="刪除對話">${icon("trash")}</button></div>`).join("") : `<div class="history-empty">${icon("history")}<h2>${rooms.length ? "沒有符合的對話" : "每段對話，都會留在這裡"}</h2><p>${rooms.length ? "試試其他關鍵字。" : "開始與 Codex、Claude 對話，之後就能回到這裡。"}</p>${!rooms.length ? '<button class="button secondary" data-new-conversation>開始新對話</button>' : ""}</div>`;
}
function bridgeInfo() {
  const bridge = state.snapshot.bridge || {};
  if (state.apiError) return { label: "服務無法連接", description: state.apiError, type: "error", action: null };
  if (!state.loaded || bridge.state === "starting") return { label: "正在啟動服務", description: "準備本機協作工具", type: "busy", action: null };
  if (bridge.state === "running") return { label: "管理服務已啟動", description: bridge.url || "本機 MCP 橋接已就緒", type: "ready", action: "stop" };
  if (bridge.state === "error") return { label: "服務啟動失敗", description: bridge.error || "請重新啟動橋接服務", type: "error", action: "start" };
  return { label: "管理服務已停止", description: "啟動橋接服務後，即可接收與分派任務", type: "muted", action: "start" };
}
function renderBridge() {
  const bridge = state.snapshot.bridge || {}; const info = bridgeInfo(); const busy = state.busy.has("bridge");
  $("#sidebar-status").textContent = info.label; $("#sidebar-status").title = info.description; $("#sidebar-dot").className = `status-dot ${info.type === "ready" ? "" : info.type}`;
  $("#app-bridge-detail").innerHTML = `<div class="app-service-content"><div><div class="service-status-line"><span class="status-dot ${info.type === "ready" ? "" : info.type}"></span>${escapeHtml(info.label)}${bridge.pid ? `<span class="status-badge muted">PID ${escapeHtml(bridge.pid)}</span>` : ""}</div><p class="service-description">${escapeHtml(info.description)}</p><p class="service-description">關閉視窗時，橋接服務與執行中的 CLI 任務會同步停止。</p></div>${info.action ? `<button class="button ${info.action === "stop" ? "secondary" : "primary"}" data-bridge-action="${info.action}" ${busy || state.snapshot.shuttingDown ? "disabled" : ""}>${icon(info.action === "stop" ? "stop" : "play")}${busy ? "處理中…" : info.action === "stop" ? "停止橋接" : "啟動橋接"}</button>` : ""}</div>${Array.isArray(bridge.tools) && bridge.tools.length ? `<div class="service-tools">${bridge.tools.map((tool) => `<span class="service-tool">${escapeHtml(typeof tool === "string" ? tool : tool.name || "MCP tool")}</span>`).join("")}</div>` : ""}${bridge.error ? `<p class="inline-error">${escapeHtml(bridge.error)}</p>` : ""}`;
}
function renderApps() {
  $("#app-cards").innerHTML = ["codex", "claude"].map((key) => {
    const app = state.snapshot.apps?.[key] || {}; const agent = state.snapshot.agents?.[key] || {}; const busy = state.busy.has(`app-${key}`); const name = key === "codex" ? "Codex" : "Claude Code";
    const pids = Array.isArray(app.pids) ? app.pids : []; const ownership = app.managed ? "由工作台啟動" : app.running ? "在工作台外啟動" : "尚未啟動";
    return `<article class="app-card"><div class="app-card-header"><div class="agent-avatar ${key}">${icon(key)}</div><div><h2 class="app-title">${name}</h2><p class="app-subtitle">${key === "codex" ? "Codex 桌面應用程式" : "Claude Code 應用程式／終端機"}</p></div>${statusBadge(!state.loaded ? "檢查中" : app.running ? "執行中" : app.installed ? "已停止" : "未偵測到", app.running ? "ready" : "muted")}</div><div class="app-data"><span>安裝狀態</span><strong>${!state.loaded ? "正在檢查" : app.installed ? "已找到啟動程式" : "尚未找到啟動程式"}</strong></div><div class="app-data"><span>程序管理</span><strong>${ownership}</strong></div><div class="app-data"><span>程序編號</span><code>${pids.length ? escapeHtml(pids.join(", ")) : "—"}</code></div><div class="app-data"><span>任務 CLI</span><strong>${escapeHtml(agentStatus(agent).text)}</strong></div>${agent.version ? `<div class="app-data"><span>CLI 版本</span><code>${escapeHtml(agent.version)}</code></div>` : ""}<div class="app-card-footer"><button class="button primary" data-launch-app="${key}" ${busy || !app.installed || state.snapshot.shuttingDown ? "disabled" : ""}>${icon("play")}${busy ? "處理中…" : app.running ? "開啟 App" : "啟動 App"}</button><button class="button secondary" data-close-app="${key}" ${busy || !app.managed || !app.running || state.snapshot.shuttingDown ? "disabled" : ""} title="${app.managed ? "關閉由工作台啟動的 App" : "只能關閉由工作台啟動的 App"}">${icon("close")}關閉 App</button></div><p class="app-hint">${app.managed ? "這個 App 由工作台啟動，可以在此關閉。" : app.running ? "此 App 由其他地方啟動；可在它自己的視窗中關閉。" : "開啟 App 不會自動開始聊天室任務。"}</p>${app.error || agent.error ? `<p class="inline-error">${escapeHtml(app.error || agent.error)}</p>` : ""}</article>`;
  }).join("");
}
function renderComposer() {
  const activeId = activeTaskId(); const pending = state.busy.has("send-message"); const key = currentDraftKey(); const uploading = state.uploadingImages.has(key);
  renderDraftImages();
  const keys = state.options.workflow === "coordinated" ? ["codex", "claude"] : [state.options.workflow];
  const checking = keys.filter((key) => { const agent = state.snapshot.agents?.[key]; return !agent?.available && agent?.error === "正在檢查連線"; });
  const missing = keys.filter((key) => !state.snapshot.agents?.[key]?.available && !checking.includes(key)); const login = keys.filter((key) => state.snapshot.agents?.[key]?.authenticated === false);
  const blocked = !state.loaded || state.apiError || state.snapshot.bridge?.state !== "running" || checking.length || missing.length || login.length;
  $("#submit-task").hidden = Boolean(activeId); $("#submit-task").disabled = Boolean(blocked || pending || uploading || state.snapshot.shuttingDown || (!$("#task-description").value.trim() && !draftImages(key).length));
  const cancel = $("#cancel-current-task"); cancel.hidden = !activeId; if (activeId) cancel.dataset.cancelTask = activeId; else delete cancel.dataset.cancelTask;
  cancel.disabled = Boolean(state.busy.has(`cancel-${activeId}`) || state.snapshot.shuttingDown);
  $("#task-workspace").readOnly = Boolean(pending || activeId); $("#select-workspace").disabled = Boolean(pending || !state.loaded || state.busy.has("select-workspace") || activeId || state.snapshot.shuttingDown);
  $("#attach-images").disabled = Boolean(!state.loaded || pending || uploading || state.snapshot.shuttingDown);
  $$("[data-workflow],[data-coordinator],[data-effort-agent]").forEach((button) => { button.disabled = Boolean(activeId || pending || state.snapshot.shuttingDown); });
  $("#task-description").disabled = Boolean(pending || state.snapshot.shuttingDown);
  $("#workspace-lock-hint").textContent = "未指定時使用預設資料夾；每則訊息都可以重新選擇。";
  const projectName = state.options.workspace.split(/[\\/]/).filter(Boolean).at(-1);
  $("#composer-context-label").textContent = projectName || "工作資料夾（選填）"; $("#composer-context-label").title = state.options.workspace || "未指定時使用預設工作資料夾";
  const effortText = effortSummary();
  const roles = rolePreview();
  $("#composer-mode-label").textContent = `${WORKFLOW_LABELS[state.options.workflow] || "協作"}${roles ? ` · ${roles}` : ""}${effortText ? ` · ${effortText}` : ""}`;
  $("#task-description").placeholder = state.options.workflow === "coordinated" ? "傳送訊息給 Codex 與 Claude…" : `傳送訊息給 ${state.options.workflow === "codex" ? "Codex" : "Claude"}…`;
  const agentNames = (agentKeys) => agentKeys.map((key) => key === "codex" ? "Codex" : "Claude").join("、");
  const gateError = state.apiError ? "無法連接管理服務，請重新開啟工作台。" : state.loaded && state.snapshot.bridge?.state !== "running" ? "管理服務尚未啟動，請到 App 管理啟動橋接。" : state.loaded && checking.length ? `正在檢查 ${agentNames(checking)} CLI 狀態，完成後即可傳送…` : state.loaded && missing.length ? `${agentNames(missing)} CLI 尚不可用，請到 App 管理查看狀態。` : state.loaded && login.length ? `${agentNames(login)} 尚未登入，請先完成登入。` : null;
  const error = state.error || state.imageErrors.get(key) || gateError; $("#composer-error").hidden = !error; $("#composer-error").textContent = error || "";
  $$("#new-conversation,[data-new-conversation]").forEach((button) => { button.disabled = !state.loaded || state.busy.has("new-room") || pending || uploading || state.snapshot.shuttingDown; });
  $("#refresh-status").disabled = !state.loaded || state.busy.has("refresh") || state.snapshot.shuttingDown; $("#refresh-status").classList.toggle("busy", state.busy.has("refresh"));
  $("#select-settings-workspace").disabled = !state.loaded || state.busy.has("select-settings-workspace") || state.snapshot.shuttingDown;
  $("#save-settings").disabled = !state.loaded || state.busy.has("save-settings") || state.snapshot.shuttingDown;
  $("#close-launched-apps").disabled = !state.loaded || state.busy.has("close-app-settings") || state.snapshot.shuttingDown;
  renderPauseBanner();
}
// ---- Inspector side panel ----
const INSPECTOR_KEY = "bridge.inspector";
const INSPECTOR_TABS = ["usage", "conversation", "system"];
/** "Claude step 2/3 #2" → "Claude 步驟 2/3（續）": stage names carry agent and role. */
function stageLabel(name) {
  const text = String(name || ""); const repeated = / #\d+$/.test(text); const base = text.replace(/ #\d+$/, "");
  const agent = /^Claude/.test(base) ? "Claude" : /^Codex/.test(base) ? "Codex" : "";
  const step = base.match(/step (\d+)\/(\d+)/); const revision = base.match(/revision (\d+)/); const review = base.match(/review(?: (\d+))?$/);
  const role = /planning/.test(base) ? "規劃" : /assigned task/.test(base) ? "執行" : step ? `步驟 ${step[1]}/${step[2]}` : revision ? `修正 ${revision[1]}`
    : review ? `審查${review[1] ? ` ${review[1]}` : ""}` : /integration/.test(base) ? "驗收" : / task$/.test(base) ? "回覆" : "";
  return role ? `${agent} ${role}${repeated ? "（續）" : ""}` : text;
}
const STATUS_LABELS = { queued: "等待中", running: "執行中", completed: "完成", failed: "失敗", cancelled: "已停止", interrupted: "已中斷" };
// Agent identity colors (validated for color-vision deficiency on the white surface).
const AGENT_COLORS = { codex: "#3f7cb4", claude: "#d0824f" };
const AGENT_SHADES = { codex: ["#a7c3df", "#3f7cb4", "#1f4c78"], claude: ["#edc3a6", "#d0824f", "#8f4d26"] };
const AGENT_NAMES = { codex: "Codex", claude: "Claude" };
const SEVERITY = { good: { color: "#5f9a3c", label: "充足" }, warning: { color: "#d9a21b", label: "偏低" }, critical: { color: "#d03b3b", label: "快用完" } };
const OUTCOME_COLORS = { completed: "#5f9a3c", running: "#8fa0b3", queued: "#c3ccd6", failed: "#d03b3b", cancelled: "#b3b8ad", interrupted: "#b3b8ad" };
function loadInspector() {
  try { const saved = JSON.parse(localStorage.getItem(INSPECTOR_KEY) || "{}"); return { open: typeof saved.open === "boolean" ? saved.open : window.innerWidth >= 1100, tab: INSPECTOR_TABS.includes(saved.tab) ? saved.tab : "usage" }; }
  catch { return { open: window.innerWidth >= 1100, tab: "usage" }; }
}
function saveInspector() { try { localStorage.setItem(INSPECTOR_KEY, JSON.stringify(state.inspector)); } catch { /* preference only */ } }
function formatTokens(value) {
  const number = Number(value) || 0;
  if (number < 1000) return String(Math.round(number));
  if (number < 1e6) return `${(number / 1e3).toFixed(number < 1e4 ? 1 : 0)}K`;
  return `${(number / 1e6).toFixed(number < 1e7 ? 2 : 1)}M`;
}
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小時 ${Math.floor((seconds % 3600) / 60)} 分`;
}
function relativeTime(value) {
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return "—";
  if (diff < 60_000) return "剛剛";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`;
  return dateLabel(value);
}
function untilText(value) {
  const diff = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diff)) return "重置時間未知";
  if (diff <= 0) return "已重置";
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `${minutes} 分後重置`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分後重置`;
  return `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小時後重置`;
}
function windowLabel(minutes) {
  if (!Number.isFinite(minutes)) return "額度";
  if (minutes <= 360) return `${Math.round(minutes / 60)} 小時`;
  if (minutes >= 9000 && minutes <= 11000) return "每週";
  return minutes >= 1440 ? `${Math.round(minutes / 1440)} 天` : `${Math.round(minutes / 60)} 小時`;
}
function elapsed(start, end) { const from = new Date(start).getTime(); const to = end ? new Date(end).getTime() : Date.now(); return to - from; }
const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0));
const tipAttr = (lines) => `data-tip="${escapeHtml(lines.filter(Boolean).join("\n"))}"`;
function card(title, iconName, body, extra = "", usageAgent = "") { return `<section class="ins-card"${usageAgent ? ` data-usage-agent="${escapeHtml(usageAgent)}"` : ""}><h3>${icon(iconName)}<span>${escapeHtml(title)}</span>${extra}</h3>${body}</section>`; }
function legend(items) { return `<ul class="ins-legend">${items.map((item) => `<li><i style="background:${item.color}"></i>${escapeHtml(item.label)}${item.value !== undefined ? ` <strong>${escapeHtml(item.value)}</strong>` : ""}</li>`).join("")}</ul>`; }
function severityChip(level, text) { return `<span class="ins-sev"><i style="background:${SEVERITY[level].color}"></i>${escapeHtml(text || SEVERITY[level].label)}</span>`; }

/** Horizontal part-to-whole bar; segments keep a 2px surface gap. */
function stackBar(segments, aria) {
  const shown = segments.filter((segment) => segment.value > 0);
  if (!shown.length) return `<div class="ins-stack empty" role="img" aria-label="${escapeHtml(aria)}：無資料"></div>`;
  return `<div class="ins-stack" role="img" aria-label="${escapeHtml(aria)}">${shown.map((segment) => `<span style="flex-grow:${segment.value};background:${segment.color}" ${tipAttr(segment.tip)} tabindex="0"></span>`).join("")}</div>`;
}
/** Labelled horizontal bars on one shared scale, value at the tip. */
function barRows(rows) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return `<div class="ins-bars">${rows.map((row) => `<div class="ins-barrow" ${tipAttr(row.tip)} tabindex="0"><span class="ins-barlabel">${row.swatch ? `<i style="background:${row.swatch}"></i>` : ""}${escapeHtml(row.label)}</span><span class="ins-bartrack"><span style="width:${row.value > 0 ? Math.max(1.5, (row.value / max) * 100) : 0}%;background:${row.color}"></span></span><span class="ins-barvalue">${escapeHtml(row.display)}</span></div>`).join("")}</div>`;
}
function stat(label, value, note = "") { return `<div class="ins-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ""}</div>`; }
function sumStages(stages, agent) {
  const total = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0, hasCost: false, runs: 0, reported: 0 };
  for (const stage of stages) {
    if (stage.agent !== agent) continue;
    total.runs++;
    const usage = stage.usage; if (!usage) continue;
    total.reported++; total.inputTokens += usage.inputTokens || 0; total.cachedInputTokens += usage.cachedInputTokens || 0; total.outputTokens += usage.outputTokens || 0;
    if (Number.isFinite(usage.costUsd)) { total.costUsd += usage.costUsd; total.hasCost = true; }
  }
  return total;
}
const money = (value) => `$${value.toFixed(value < 1 ? 3 : 2)}`;

function usageCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, number)) : 0;
}
function usageTotals(value) {
  const inputTokens = usageCount(value?.inputTokens);
  return { inputTokens, cachedInputTokens: Math.min(inputTokens, usageCount(value?.cachedInputTokens)), outputTokens: usageCount(value?.outputTokens), messages: usageCount(value?.messages), sessions: usageCount(value?.sessions) };
}
/** A titled zone. Each zone answers one question, so quota, token use and runs never mix. */
function zone(kind, iconName, title, question, body, headline = "") {
  return `<section class="ins-zone" data-zone="${kind}"><header class="ins-zone-head"><span class="ins-zone-icon">${icon(iconName)}</span><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(question)}</p></div>${headline ? `<strong class="ins-zone-total">${headline}</strong>` : ""}</header>${body}</section>`;
}
/** One horizontal meter row: name, the key value on the right, the bar, then supporting detail. */
function meterRow({ agent, name, valueLabel, value, percent, color, marker, meta, tip, empty }) {
  return `<div class="ins-meter"${agent ? ` data-usage-agent="${agent}"` : ""} ${tip ? `${tipAttr(tip)} tabindex="0"` : ""}><div class="ins-meter-head"><span class="ins-meter-name">${agent ? `<i style="background:${AGENT_COLORS[agent]}"></i>` : ""}${escapeHtml(name)}</span><span class="ins-meter-value${empty ? " muted" : ""}">${valueLabel ? `<small>${escapeHtml(valueLabel)}</small>` : ""}${escapeHtml(value)}</span></div><div class="ins-meter-track${empty ? " empty" : ""}">${empty ? "" : `<span style="width:${clampPercent(percent)}%;background:${color}"></span>`}${Number.isFinite(marker) ? `<b class="ins-meter-marker" style="left:${clampPercent(marker)}%"></b>` : ""}</div>${meta ? `<p class="ins-meter-meta">${meta}</p>` : ""}</div>`;
}
function quotaRows(usageAgent, agent = "codex") {
  const quota = usageAgent.quota;
  const name = AGENT_NAMES[agent];
  const windows = [quota.primary, quota.secondary].filter((window) => window && typeof window === "object").sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));
  return windows.map((window) => {
    const observedAt = window.observedAt || quota.observedAt;
    const cached = quota.stale === true || Boolean(window.observedAt);
    const cachedText = cached ? `快取紀錄 · ${dateLabel(observedAt)}（等待最新資料）` : "";
    const label = windowLabel(window.windowMinutes);
    const reset = window.resetsAt ? new Date(window.resetsAt).getTime() : NaN;
    const lapsed = Number.isFinite(reset) && reset <= Date.now();
    const known = typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent);
    if (lapsed || !known) {
      const explanation = lapsed ? "此額度視窗已結束，等待更新。" : "尚未取得此視窗的額度數值。";
      return meterRow({ agent, name: `${name} · ${label}`, value: "待更新", empty: true,
        meta: `<span>${escapeHtml(explanation)}</span>${cachedText ? `<span title="${escapeHtml(observedAt)}">${escapeHtml(cachedText)}</span>` : ""}`,
        tip: [`${name} ${label}額度待更新`, explanation, cachedText] });
    }
    const used = clampPercent(window.usedPercent);
    const remaining = 100 - used;
    const resetText = window.resetsAt ? untilText(window.resetsAt) : "重置時間未知";
    if ((window.windowMinutes ?? 0) <= 360) {
      // Short window: what is left right now.
      const level = remaining >= 30 ? "good" : remaining >= 10 ? "warning" : "critical";
      return meterRow({ agent, name: `${name} · ${label}`, valueLabel: cached ? "上次剩餘" : "剩餘", value: `${Math.round(remaining)}%`, percent: remaining, color: SEVERITY[level].color,
        meta: `${severityChip(level)}<span>${escapeHtml(resetText)}</span>${cachedText ? `<span title="${escapeHtml(observedAt)}">${escapeHtml(cachedText)}</span>` : ""}`,
        tip: [`${cached ? "上次" : ""}剩餘 ${Math.round(remaining)}%`, `${name} ${label}額度 · 已使用 ${Math.round(used)}%`, resetText, cachedText] });
    }
    // Long (weekly) window: how much has been used, against how much of the week has passed.
    const progress = Number.isFinite(reset) && Number.isFinite(window.windowMinutes) && !lapsed ? clampPercent(100 - ((reset - Date.now()) / (window.windowMinutes * 60_000)) * 100) : NaN;
    const level = used < 70 ? "good" : used < 90 ? "warning" : "critical";
    const pace = !Number.isFinite(progress) ? "" : used > progress + 5 ? "用得比時間快" : used < progress - 5 ? "用得比時間慢" : "與時間同步";
    return meterRow({ agent, name: `${name} · ${label}`, valueLabel: cached ? "上次已使用" : "已使用", value: `${Math.round(used)}%`, percent: used, color: SEVERITY[level].color, marker: progress,
      meta: `${severityChip(level, level === "good" ? "正常" : level === "warning" ? "偏高" : "快用完")}${pace ? `<span>${escapeHtml(pace)}</span>` : ""}<span>${escapeHtml(resetText)}</span>${cachedText ? `<span title="${escapeHtml(observedAt)}">${escapeHtml(cachedText)}</span>` : ""}`,
      tip: [`${cached ? "上次" : ""}已使用 ${Math.round(used)}%`, `${name} ${label}額度 · 剩餘 ${Math.round(remaining)}%`, Number.isFinite(progress) ? `時間已過 ${Math.round(progress)}%（直線標記）` : "", resetText, cachedText] });
  }).join("");
}
function usageTabHtml() {
  const usage = state.snapshot.usage || {};
  const codex = usage.codex; const claude = usage.claude;
  const loading = !usage.checkedAt;

  // 1. Quota: how much of the plan is left.
  let quota;
  if (loading) quota = '<p class="ins-muted">正在讀取本機紀錄…</p>';
  else if (codex?.error) quota = `<p class="ins-error">${escapeHtml(codex.error)}</p>`;
  else if (codex?.quota && (codex.quota.primary || codex.quota.secondary)) quota = quotaRows(codex);
  else quota = meterRow({ agent: "codex", name: "Codex", value: "尚無紀錄", empty: true, meta: "<span>在 Codex App 或 CLI 互動模式使用一次後就會出現</span>" });
  if (claude?.quota && (claude.quota.primary || claude.quota.secondary)) quota += quotaRows(claude, "claude");
  else {
    const status = claude?.quotaStatus?.state || (loading ? "loading" : "no-data");
    const labels = { ready: "尚無紀錄", loading: "讀取中", "no-data": "尚無紀錄", unsupported: "暫不支援", error: "讀取失敗" };
    const messages = { ready: "尚未取得 Claude 額度資料。", loading: "正在讀取 Claude CLI 額度…", "no-data": "尚未取得 Claude 額度紀錄，請稍後重新整理。", unsupported: "目前 Claude CLI 尚未提供可讀取的額度資料。", error: "Claude 額度讀取失敗，請稍後重新整理。" };
    quota += meterRow({ agent: "claude", name: "Claude", value: labels[status] || "尚無紀錄", empty: true,
      meta: `<span>${escapeHtml(claude?.quotaStatus?.message || messages[status] || messages["no-data"])}</span>` });
  }
  const hasWeekly = [codex?.quota?.primary, codex?.quota?.secondary, claude?.quota?.primary, claude?.quota?.secondary].some((window) => (window?.windowMinutes ?? 0) > 360);
  const observed = [["Codex", codex?.quota], ["Claude", claude?.quota]].filter(([, quota]) => quota).map(([name, quota]) => `${name} ${name === "Codex" ? "資料來自最近一次工作階段" : "資料由 Claude CLI 取得"} · ${escapeHtml(relativeTime(quota.observedAt))}${quota.stale ? `（快取 · ${escapeHtml(dateLabel(quota.observedAt))}）` : ""}`);
  quota += `<p class="ins-foot">${hasWeekly ? '<span class="ins-marker-key"></span>直線＝本週時間進度，色條超過直線代表用得比時間快。' : ""}${observed.length ? `${hasWeekly ? "<br>" : ""}${observed.join("<br>")}` : ""}</p>`;

  // 2. Tokens: how much was consumed today, per agent, split by where it was used.
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const todayTasks = (state.snapshot.tasks || []).filter((task) => new Date(task.createdAt) >= startToday);
  const bridgeStages = todayTasks.flatMap((task) => task.stages || []);
  const local = { codex: usageTotals(codex?.today), claude: usageTotals(claude?.today) };
  const bridge = { codex: sumStages(bridgeStages, "codex"), claude: sumStages(bridgeStages, "claude") };
  const sum = (value) => value.inputTokens + value.outputTokens;
  const totals = Object.fromEntries(["codex", "claude"].map((agent) => [agent, sum(local[agent]) + sum(bridge[agent])]));
  const max = Math.max(1, totals.codex, totals.claude);
  const tokenRows = ["codex", "claude"].map((agent) => {
    const known = agent === "codex" ? Boolean(codex?.today) : Boolean(claude?.today);
    const localTotal = sum(local[agent]); const bridgeTotal = sum(bridge[agent]);
    const input = local[agent].inputTokens + bridge[agent].inputTokens; const cached = local[agent].cachedInputTokens + bridge[agent].cachedInputTokens; const output = local[agent].outputTokens + bridge[agent].outputTokens;
    const [light, , dark] = AGENT_SHADES[agent];
    const segments = [{ value: localTotal, color: AGENT_COLORS[agent], tip: [`${formatTokens(localTotal)} tokens`, `${AGENT_NAMES[agent]} · App／CLI`] }, { value: bridgeTotal, color: light, tip: [`${formatTokens(bridgeTotal)} tokens`, `${AGENT_NAMES[agent]} · 工作台`] }].filter((segment) => segment.value > 0);
    const recent = agent === "claude" && claude?.recent5h ? ` · 最近 5 小時輸出 ${formatTokens(usageTotals(claude.recent5h).outputTokens)}` : "";
    return `<div class="ins-meter" data-usage-agent="${agent}"><div class="ins-meter-head"><span class="ins-meter-name"><i style="background:${AGENT_COLORS[agent]}"></i>${AGENT_NAMES[agent]}</span><span class="ins-meter-value">${escapeHtml(formatTokens(totals[agent]))}<small> tokens</small></span></div><div class="ins-meter-track">${segments.length ? `<div class="ins-meter-stack" style="width:${(totals[agent] / max) * 100}%">${segments.map((segment) => `<span style="flex-grow:${segment.value};background:${segment.color}" ${tipAttr(segment.tip)} tabindex="0"></span>`).join("")}</div>` : ""}</div><p class="ins-meter-meta"><span>輸入 ${formatTokens(input)}${cached ? `（快取 ${formatTokens(cached)}）` : ""} · 輸出 <strong>${formatTokens(output)}</strong>${escapeHtml(recent)}</span>${!known && !bridgeTotal ? "<span>今天尚無紀錄</span>" : ""}</p></div>`;
  }).join("");
  const tokenLegend = `<ul class="ins-legend"><li><i style="background:${AGENT_COLORS.codex}"></i><i style="background:${AGENT_COLORS.claude}"></i>深色＝App／CLI</li><li><i style="background:${AGENT_SHADES.codex[0]}"></i><i style="background:${AGENT_SHADES.claude[0]}"></i>淺色＝工作台</li></ul>`;
  const tokens = loading ? '<p class="ins-muted">正在讀取本機紀錄…</p>' : tokenRows + tokenLegend;

  // 3. Runs: how today's manager messages went.
  let runs = '<p class="ins-muted">今天還沒有透過工作台送出的訊息。</p>';
  if (todayTasks.length) {
    const groups = ["completed", "running", "queued", "failed", "cancelled", "interrupted"].map((status) => ({ status, count: todayTasks.filter((task) => task.status === status).length })).filter((group) => group.count);
    const finished = todayTasks.filter((task) => task.startedAt && task.finishedAt);
    const average = finished.length ? finished.reduce((total, task) => total + elapsed(task.startedAt, task.finishedAt), 0) / finished.length : NaN;
    runs = `<div class="ins-meter"><div class="ins-meter-head"><span class="ins-meter-name">訊息結果</span><span class="ins-meter-value">${todayTasks.length}<small> 則</small></span></div>${stackBar(groups.map((group) => ({ value: group.count, color: OUTCOME_COLORS[group.status], tip: [`${group.count} 則`, STATUS_LABELS[group.status]] })), "今天訊息結果")}</div>${legend(groups.map((group) => ({ color: OUTCOME_COLORS[group.status], label: STATUS_LABELS[group.status], value: String(group.count) })))}`
      + `<p class="ins-foot">${Number.isFinite(average) ? `平均每則 ${escapeHtml(formatDuration(average))}` : ""}${bridge.claude.hasCost ? `${Number.isFinite(average) ? " · " : ""}Claude 等值 API 費用約 ${money(bridge.claude.costUsd)}（訂閱方案不另計費）` : ""}</p>`;
  }
  return zone("quota", "gauge", "額度", "方案還能用多少", quota)
    + zone("tokens", "chat", "Token 消耗", "今天用了多少 tokens", tokens, loading ? "" : `${escapeHtml(formatTokens(totals.codex + totals.claude))}<small> tokens</small>`)
    + zone("runs", "history", "工作台執行", "今天送出的訊息結果", runs)
    + `<p class="ins-foot center">每 20 秒自動更新${usage.checkedAt ? ` · 上次 ${escapeHtml(relativeTime(usage.checkedAt))}` : ""}</p>`;
}

/** Segments: stages that ran (including handoffs), then what the saved plan still has pending. */
function progressItems(task) {
  const stages = task.stages || [];
  const dispatch = task.dispatch || {};
  const items = stages.map((stage) => ({ label: stageLabel(stage.name), agent: stage.agent, status: stage.status || "pending", startedAt: stage.startedAt, finishedAt: stage.finishedAt }));
  const pending = (label) => items.push({ label, status: "pending" });
  if (task.workflow === "coordinated") {
    if (!stages.some((stage) => stage.role === "planner" || /planning/.test(stage.name))) pending("規劃");
    const steps = Array.isArray(dispatch.steps) ? dispatch.steps : [];
    if (!steps.length && !stages.some((stage) => stage.role === "executor" || /assigned task|step /.test(stage.name))) pending("執行");
    steps.forEach((step, index) => {
      if (step.status !== "done" && !stages.some((stage) => stage.step === index && stage.status === "running")) pending(steps.length > 1 ? `步驟 ${index + 1}/${steps.length}` : "執行");
    });
    if (dispatch.phase === "revise" && !stages.some((stage) => stage.role === "reviser" && stage.round === dispatch.round && stage.status === "running")) pending(`修正 ${dispatch.round}`);
    if (dispatch.phase !== "done" && !stages.some((stage) => stage.role === "reviewer" && stage.status === "running")) pending("審查");
  } else if (!stages.length) pending("回覆");
  return items;
}
/** Horizontal segmented progress: one segment per stage, done / running / handed off / waiting. */
function stageProgress(task) {
  return `<ol class="ins-progressbar">${progressItems(task).map(({ label, agent, status, startedAt, finishedAt }) => {
    const time = startedAt ? (status === "running" ? `<span data-since="${escapeHtml(startedAt)}">${formatDuration(elapsed(startedAt))}</span>` : status === "handoff" ? "已交接" : formatDuration(elapsed(startedAt, finishedAt))) : "等待";
    return `<li class="${escapeHtml(status)}"${agent ? ` style="--agent:${AGENT_COLORS[agent] || AGENT_COLORS.codex}"` : ""}><span class="ins-progress-seg"></span><span class="ins-progress-label">${escapeHtml(label)}</span><span class="ins-progress-time">${time}</span></li>`;
  }).join("")}</ol>`;
}
function messageRows(tasks, measure) {
  const rows = tasks.map((task) => {
    const stages = task.stages || [];
    const segments = stages.map((stage) => ({ stage, value: measure(stage) })).filter((item) => item.value > 0);
    return { task, segments, total: segments.reduce((sum, item) => sum + item.value, 0) };
  });
  return rows;
}
function timelineChart(tasks, kind) {
  const measure = kind === "time" ? (stage) => stage.startedAt ? Math.max(0, elapsed(stage.startedAt, stage.status === "running" ? null : stage.finishedAt)) : 0
    : (stage) => stage.usage ? (stage.usage.inputTokens || 0) + (stage.usage.outputTokens || 0) : 0;
  const format = kind === "time" ? formatDuration : (value) => formatTokens(value);
  const rows = messageRows(tasks, measure);
  const max = Math.max(1, ...rows.map((row) => row.total));
  if (!rows.some((row) => row.total)) return `<p class="ins-muted">${kind === "time" ? "尚無執行時間資料。" : "尚無 token 資料；新的訊息會開始記錄。"}</p>`;
  return `<div class="ins-timeline">${rows.map(({ task, segments, total }) => `<div class="ins-tl-row"><div class="ins-tl-head"><span class="ins-tl-title" title="${escapeHtml(task.title || task.task || "")}">${escapeHtml(task.title || task.task || "訊息")}</span><span class="ins-tl-total">${total ? escapeHtml(format(total)) : "—"}</span></div><div class="ins-tl-track"><div class="ins-tl-bar" style="width:${(total / max) * 100}%">${segments.map(({ stage, value }) => `<span class="${stage.status === "running" ? "running" : stage.status === "failed" ? "failed" : ""}" style="flex-grow:${value};background:${AGENT_COLORS[stage.agent] || AGENT_COLORS.codex}" ${tipAttr([format(value), `${stageLabel(stage.name)} · ${STATUS_LABELS[stage.status] || ""}`, kind === "tokens" && stage.usage ? `輸入 ${formatTokens(stage.usage.inputTokens)} · 輸出 ${formatTokens(stage.usage.outputTokens)}` : ""])} tabindex="0"></span>`).join("")}</div></div></div>`).join("")}</div>`;
}
function conversationTabHtml() {
  const room = conversation();
  if (!room) return '<div class="ins-empty">選擇或開始一段對話後，<br>這裡會顯示執行過程與用量。</div>';
  const tasks = (state.snapshot.tasks || []).filter((task) => (task.conversationId || task.id) === room.id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const active = tasks.find((task) => ACTIVE_STATUSES.has(task.status) || task.status === "paused");
  const stages = tasks.flatMap((task) => task.stages || []);
  const totalMs = tasks.reduce((sum, task) => sum + (task.startedAt ? Math.max(0, elapsed(task.startedAt, task.finishedAt || null)) : 0), 0);
  const totals = { codex: sumStages(stages, "codex"), claude: sumStages(stages, "claude") };
  const agentTotal = (agent) => totals[agent].inputTokens + totals[agent].outputTokens;
  const allTokens = agentTotal("codex") + agentTotal("claude");
  const effort = effortOf(room.effort);
  const settings = `<div class="ins-chips"><span>${escapeHtml(WORKFLOW_LABELS[room.workflow] || "協作")}</span>${(room.workflow || "coordinated") === "coordinated" ? `<span>${AGENT_NAMES[coordinatorOf(room.coordinator)]} 統籌</span>` : ""}${workflowAgents(room.workflow || "coordinated").map((agent) => `<span>${AGENT_NAMES[agent]} ${escapeHtml(EFFORT_LABELS[effort[agent]])}</span>`).join("")}<span>${tasks.length} 則訊息</span></div>`;
  const agentLegend = legend(["codex", "claude"].map((agent) => ({ color: AGENT_COLORS[agent], label: AGENT_NAMES[agent] })));
  const recent = tasks.slice(-8);
  const live = active ? zone("live", "clock", "執行狀態", active.status === "paused" ? "額度用盡，已暫停；等你接續" : active.progress || "執行中", stageProgress(active), active.status === "paused" ? "已暫停" : active.startedAt ? `<span data-since="${escapeHtml(active.startedAt)}">${formatDuration(elapsed(active.startedAt))}</span>` : "排隊中") : "";
  const max = Math.max(1, agentTotal("codex"), agentTotal("claude"));
  const agentRows = ["codex", "claude"].map((agent) => meterRow({ agent, name: AGENT_NAMES[agent], value: formatTokens(agentTotal(agent)), percent: (agentTotal(agent) / max) * 100, color: AGENT_COLORS[agent],
    meta: `<span>輸入 ${formatTokens(totals[agent].inputTokens)} · 輸出 <strong>${formatTokens(totals[agent].outputTokens)}</strong>${agent === "claude" && totals.claude.hasCost ? ` · 約 ${money(totals.claude.costUsd)}` : ""}</span>`,
    tip: [`${formatTokens(agentTotal(agent))} tokens`, `${AGENT_NAMES[agent]} · ${totals[agent].runs} 次執行`] })).join("");
  const tokens = zone("tokens", "chat", "Token 消耗", "這段對話用了多少 tokens", agentRows + (recent.length ? `<h4 class="ins-subhead">每則訊息</h4>${agentLegend}${timelineChart(recent, "tokens")}` : ""), `${escapeHtml(formatTokens(allTokens))}<small> tokens</small>`);
  const time = zone("time", "clock", "耗時", "每則訊息花了多久", recent.length ? agentLegend + timelineChart(recent, "time") : '<p class="ins-muted">尚無執行紀錄。</p>', escapeHtml(formatDuration(totalMs)));
  return settings + live + tokens + time;
}
function systemTabHtml() {
  const agents = ["codex", "claude"].map((key) => {
    const agent = state.snapshot.agents?.[key] || {}; const status = agentStatus(agent); const app = state.snapshot.apps?.[key] || {};
    return `<div class="ins-agent-row"><span class="ins-agent"><i style="background:${AGENT_COLORS[key]}"></i>${AGENT_NAMES[key]}</span>${statusBadge(status.text, status.type)}</div><p class="ins-tokens">${agent.version ? `<code>${escapeHtml(agent.version)}</code> · ` : ""}App ${app.running ? "執行中" : app.installed ? "未執行" : "未偵測到"}</p>${agent.commandPath ? `<p class="ins-tokens" style="overflow-wrap:anywhere">CLI：<code>${escapeHtml(agent.commandPath)}</code></p>` : ""}${agent.error ? `<p class="inline-error">${escapeHtml(agent.error)}</p>` : ""}`;
  }).join("");
  const processes = Array.isArray(state.snapshot.processes) ? state.snapshot.processes : [];
  const bridge = bridgeInfo();
  return card("CLI 與 App", "terminal", agents)
    + card("執行中的程序", "clock", processes.length ? `<ul class="ins-list">${processes.map((entry) => `<li><span class="ins-agent"><i style="background:${AGENT_COLORS[entry.agent] || AGENT_COLORS.codex}"></i>${AGENT_NAMES[entry.agent] || "CLI"}</span><code>PID ${escapeHtml(entry.pid)}</code></li>`).join("")}</ul>` : '<p class="ins-muted">目前沒有執行中的 CLI 程序。</p>')
    + card("本機橋接", "link", `<div class="ins-agent-row"><span>${escapeHtml(bridge.label)}</span><span class="status-dot ${bridge.type === "ready" ? "" : bridge.type}"></span></div><p class="ins-tokens"><code>${escapeHtml(bridge.description)}</code></p>`)
    + card("目前專案", "folder", `<p class="ins-path"><code>${escapeHtml(state.options.workspace || "尚未選擇")}</code></p>`);
}
function renderInspector() {
  const panel = $("#inspector"); const open = state.inspector.open;
  panel.hidden = !open; document.body.classList.toggle("inspector-open", open);
  const toggle = $("#toggle-inspector"); toggle.setAttribute("aria-expanded", String(open)); toggle.classList.toggle("active", open);
  if (!open) return;
  $$("[data-inspector-tab]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.inspectorTab === state.inspector.tab)));
  try {
    const html = state.inspector.tab === "conversation" ? conversationTabHtml() : state.inspector.tab === "system" ? systemTabHtml() : usageTabHtml();
    if (html !== state.inspectorHtml) { state.inspectorHtml = html; $("#inspector-body").innerHTML = html; hideTip(); }
  } catch (error) {
    console.error("觀察面板資料暫時無法顯示：", errorMessage(error));
    state.inspectorHtml = "";
    $("#inspector-body").innerHTML = '<p class="ins-error">觀察資料暫時無法顯示，請稍後重新整理。</p>';
  }
}
function setInspector(changes) { state.inspector = { ...state.inspector, ...changes }; saveInspector(); renderInspector(); }
// Chart tooltip: the value leads, the label follows. Text is inserted with textContent.
function showTip(target, x, y) {
  const tip = $("#ins-tooltip"); const lines = (target.dataset.tip || "").split("\n").filter(Boolean);
  if (!lines.length) return hideTip();
  tip.replaceChildren(...lines.map((line, index) => { const element = document.createElement(index ? "span" : "strong"); element.textContent = line; return element; }));
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - box.width - 8, x - box.width / 2))}px`;
  tip.style.top = `${y - box.height - 12 < 8 ? y + 18 : y - box.height - 12}px`;
}
function hideTip() { const tip = $("#ins-tooltip"); if (tip) tip.hidden = true; }
$("#inspector-body").addEventListener("pointermove", (event) => { const target = event.target.closest("[data-tip]"); if (target) showTip(target, event.clientX, event.clientY); else hideTip(); });
$("#inspector-body").addEventListener("pointerleave", hideTip);
$("#inspector-body").addEventListener("scroll", hideTip, { passive: true });
$("#inspector-body").addEventListener("focusin", (event) => { const target = event.target.closest("[data-tip]"); if (!target) return; const rect = target.getBoundingClientRect(); showTip(target, rect.left + rect.width / 2, rect.top); });
$("#inspector-body").addEventListener("focusout", hideTip);
setInterval(() => {
  if (!state.inspector.open) return;
  $$("#inspector-body [data-since]").forEach((element) => { element.textContent = formatDuration(elapsed(element.dataset.since)); });
}, 1000);
function render() { renderChat(); renderHistory(); renderBridge(); renderApps(); renderComposer(); renderInspector(); }
function resetToBlankDraft() {
  state.selectedConversationId = null; state.options = { workspace: state.snapshot.settings?.workspace || "", workflow: "coordinated", effort: effortOf(), coordinator: coordinatorOf(state.options.coordinator) }; state.optionDirty = false; state.error = null; state.forceScroll = true;
  state.drafts.set("new", ""); state.imageDrafts.delete("new"); state.imageErrors.delete("new"); state.imageGenerations.set("new", (state.imageGenerations.get("new") || 0) + 1); loadDraft();
}
function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const previousRooms = state.snapshot.conversations || [];
  state.snapshot = { ...state.snapshot, ...snapshot }; state.loaded = true; state.apiError = null;
  const remainingIds = new Set((state.snapshot.conversations || []).map((room) => room.id));
  previousRooms.forEach((room) => { if (!remainingIds.has(room.id)) { state.deletedRooms.add(room.id); state.drafts.delete(room.id); state.imageDrafts.delete(room.id); state.imageErrors.delete(room.id); } });
  const room = conversation();
  if (state.selectedConversationId && !room) resetToBlankDraft();
  if (!state.optionDirty) { state.options = { workspace: room?.workspace || state.snapshot.settings?.workspace || "", workflow: room?.workflow || "coordinated", effort: room ? effortOf(room.effort) : state.options.effort, coordinator: room ? coordinatorOf(room.coordinator) : coordinatorOf(state.options.coordinator) }; }
  syncOptionControls();
  if (!state.settingsWorkspaceDirty) $("#settings-workspace").value = state.snapshot.settings?.workspace || "";
  $("#close-launched-apps").checked = Boolean(state.snapshot.settings?.closeLaunchedApps);
  if (state.snapshot.shuttingDown) showShutdown(); render();
}
async function invoke(method, ...args) { if (!window.bridge || typeof window.bridge[method] !== "function") throw new Error("無法連接桌面管理服務，請重新開啟工作台。"); return window.bridge[method](...args); }
async function action(key, operation, successMessage) {
  if (state.busy.has(key)) return null; state.busy.add(key); render();
  try { const result = await operation(); if (result?.snapshot) applySnapshot(result.snapshot); if (successMessage) showToast(successMessage); return result; }
  catch (error) { console.error(`操作失敗（${key}）：`, errorMessage(error)); showToast(errorMessage(error), true); return null; }
  finally { state.busy.delete(key); render(); }
}
function showShutdown() { state.snapshot.shuttingDown = true; $("#shutdown-overlay").hidden = false; $$("button,input,textarea").forEach((element) => { element.disabled = true; }); }
async function newConversation() {
  if (state.busy.has("new-room") || state.busy.has("send-message") || state.uploadingImages.has(currentDraftKey()) || !state.loaded || state.snapshot.shuttingDown) return;
  saveDraft();
  const result = await action("new-room", async () => {
    const effort = effortOf(state.options.effort); const coordinator = coordinatorOf(state.options.coordinator);
    const created = await invoke("createConversation", { workspace: state.snapshot.settings?.workspace || "", workflow: "coordinated", effort, coordinator });
    const room = created?.conversation || created; if (!room?.id) throw new Error("無法建立新對話，請稍後重試。");
    state.selectedConversationId = room.id; state.options = { workspace: room.workspace || "", workflow: room.workflow || "coordinated", effort: effortOf(room.effort ?? effort), coordinator: coordinatorOf(room.coordinator ?? coordinator) }; state.optionDirty = false; state.error = null; state.forceScroll = true;
    state.drafts.set(room.id, ""); loadDraft(); applySnapshot(await invoke("getSnapshot")); return room;
  });
  if (result) { $("#chat-options").open = false; setView("workspace"); $("#task-description").focus(); }
}
async function sendMessage() {
  const message = $("#task-description").value.trim();
  const originalDraftKey = currentDraftKey(); const images = [...draftImages(originalDraftKey)];
  if ((!message && !images.length) || state.uploadingImages.has(originalDraftKey) || state.busy.has("send-message") || activeTaskId() || state.snapshot.shuttingDown) return;
  if (message.length > 8000) { state.error = "每則訊息最多 8,000 個字元。"; renderComposer(); return; }
  let sendingRoomId = state.selectedConversationId;
  state.busy.add("send-message"); state.error = null; state.forceScroll = true; renderComposer();
  try {
    const workspace = state.options.workspace.trim();
    const options = { ...(workspace ? { workspace } : {}), workflow: state.options.workflow, effort: effortOf(state.options.effort), coordinator: coordinatorOf(state.options.coordinator) };
    if (!sendingRoomId) { const created = await invoke("createConversation", options); const room = created?.conversation || created; if (!room?.id) throw new Error("無法建立對話，請稍後重試。"); sendingRoomId = room.id; if (state.selectedConversationId === null) state.selectedConversationId = sendingRoomId; }
    await invoke("sendMessage", { conversationId: sendingRoomId, message, attachmentIds: images.map((image) => image.id), ...options });
    state.drafts.set(sendingRoomId, ""); state.drafts.set(originalDraftKey, "");
    state.imageDrafts.delete(sendingRoomId); state.imageDrafts.delete(originalDraftKey); state.imageErrors.delete(sendingRoomId); state.imageErrors.delete(originalDraftKey);
    if (state.selectedConversationId === sendingRoomId) { $("#task-description").value = ""; $("#chat-options").open = false; state.optionDirty = false; }
    applySnapshot(await invoke("getSnapshot")); resizeComposer();
  } catch (error) { console.error("傳送訊息失敗：", errorMessage(error)); if (state.selectedConversationId === sendingRoomId || sendingRoomId === null) { state.error = errorMessage(error); renderComposer(); } else showToast(errorMessage(error), true); }
  finally { state.busy.delete("send-message"); render(); if (state.selectedConversationId === sendingRoomId) $("#task-description").focus(); }
}
async function chooseWorkspace(settings = false) {
  const key = settings ? "select-settings-workspace" : "select-workspace"; const selected = await action(key, () => invoke("selectWorkspace")); const path = typeof selected === "string" ? selected : selected?.path;
  if (!path) return;
  if (settings) { $("#settings-workspace").value = path; state.settingsWorkspaceDirty = true; }
  else { state.options.workspace = path; state.optionDirty = true; state.error = null; syncOptionControls(); renderComposer(); }
}
function requestDeleteConversation(id) {
  if (state.busy.has("send-message") || state.snapshot.shuttingDown) { showToast("訊息正在送出，請稍後再刪除對話。", true); return; }
  const room = (state.snapshot.conversations || []).find((candidate) => candidate.id === id);
  if (!room) return;
  state.pendingDeleteId = id;
  $("#delete-conversation-description").textContent = `「${room.title || "新對話"}」`;
  $("#delete-conversation-error").hidden = true;
  const dialog = $("#delete-conversation-dialog");
  if (!dialog.open) dialog.showModal();
  $("#cancel-delete-conversation").focus();
}
async function confirmDeleteConversation() {
  const id = state.pendingDeleteId;
  if (!id || state.busy.has(`delete-${id}`)) return;
  state.busy.add(`delete-${id}`);
  $("#confirm-delete-conversation").disabled = true; $("#confirm-delete-conversation").textContent = "正在刪除…"; $("#cancel-delete-conversation").disabled = true;
  try {
    const result = await invoke("deleteConversation", id);
    if (result?.deleted === false) throw new Error("對話未能刪除，請稍後重試。");
    state.deletedRooms.add(id); state.drafts.delete(id); state.imageDrafts.delete(id); state.imageErrors.delete(id);
    if (state.selectedConversationId === id) resetToBlankDraft();
    if (result?.snapshot) applySnapshot(result.snapshot); else if (Array.isArray(result?.conversations)) applySnapshot(result); else applySnapshot(await invoke("getSnapshot"));
    $("#delete-conversation-dialog").close(); state.pendingDeleteId = null;
    if (result?.warning) showToast(String(result.warning), true); else showToast("對話已刪除");
    if (!conversation() && state.view === "workspace") $("#task-description").focus();
  } catch (error) { $("#delete-conversation-error").textContent = errorMessage(error); $("#delete-conversation-error").hidden = false; }
  finally { state.busy.delete(`delete-${id}`); $("#confirm-delete-conversation").disabled = false; $("#confirm-delete-conversation").textContent = "刪除對話"; $("#cancel-delete-conversation").disabled = false; render(); }
}
document.addEventListener("click", async (event) => {
  const deletion = event.target.closest("[data-delete-conversation-id]"); if (deletion) { event.preventDefault(); event.stopPropagation(); requestDeleteConversation(deletion.dataset.deleteConversationId); return; }
  const removeImage = event.target.closest("[data-remove-attachment]"); if (removeImage && !removeImage.disabled) { const key = currentDraftKey(); state.imageDrafts.set(key, draftImages(key).filter((image) => image.id !== removeImage.dataset.removeAttachment)); state.imageErrors.delete(key); renderComposer(); return; }
  const imagePreview = event.target.closest("[data-preview-url]"); if (imagePreview) { $("#image-preview").src = imagePreview.dataset.previewUrl; $("#image-preview").alt = imagePreview.dataset.previewName || "圖片"; $("#image-preview-name").textContent = imagePreview.dataset.previewName || "圖片"; $("#image-preview-dialog").showModal(); return; }
  if (event.target.closest("[data-close-image-preview]")) { $("#image-preview-dialog").close(); return; }
  const view = event.target.closest("[data-view]"); if (view) { event.preventDefault(); setView(view.dataset.view, true); return; }
  if (event.target.closest("#new-conversation,[data-new-conversation]")) { await newConversation(); return; }
  const room = event.target.closest("[data-conversation-id]"); if (room) { selectConversation(room.dataset.conversationId); return; }
  const coordinator = event.target.closest("[data-coordinator]"); if (coordinator && !coordinator.disabled) { state.options.coordinator = coordinatorOf(coordinator.dataset.coordinator); state.optionDirty = true; state.error = null; syncOptionControls(); renderComposer(); return; }
  const workflow = event.target.closest("[data-workflow]"); if (workflow && !workflow.disabled) { state.options.workflow = workflow.dataset.workflow; state.optionDirty = true; state.error = null; syncOptionControls(); renderComposer(); return; }
  const resumeButton = event.target.closest("[data-resume-task]"); if (resumeButton && !resumeButton.disabled) { const id = resumeButton.dataset.resumeTask; await action(`resume-${id}`, async () => { const result = await invoke("resumeTask", id); applySnapshot(await invoke("getSnapshot")); return result; }, "已接續，正在從中斷處繼續"); return; }
  const cancel = event.target.closest("[data-cancel-task]"); if (cancel && !cancel.disabled) { const id = cancel.dataset.cancelTask; await action(`cancel-${id}`, async () => { const result = await invoke("cancelTask", id); applySnapshot(await invoke("getSnapshot")); return result; }); return; }
  const copy = event.target.closest("[data-copy-message]"); if (copy) { const message = conversation()?.messages?.find((candidate) => candidate.id === copy.dataset.copyMessage); try { if (!navigator.clipboard?.writeText) throw new Error("請選取文字並使用 Ctrl + C 複製。"); await navigator.clipboard.writeText(message?.content || ""); showToast("回覆已複製"); } catch (error) { showToast(errorMessage(error), true); } return; }
  const bridge = event.target.closest("[data-bridge-action]"); if (bridge && !bridge.disabled) { const start = bridge.dataset.bridgeAction === "start"; await action("bridge", async () => { const result = await invoke(start ? "startBridge" : "stopBridge"); applySnapshot(await invoke("getSnapshot")); return result; }, start ? "MCP 橋接已啟動" : "MCP 橋接已停止"); return; }
  const launch = event.target.closest("[data-launch-app]"); if (launch && !launch.disabled) { const key = launch.dataset.launchApp; await action(`app-${key}`, async () => { const result = await invoke("launchApp", key); applySnapshot(await invoke("getSnapshot")); return result; }, `${key === "codex" ? "Codex" : "Claude Code"} 已開啟`); return; }
  const close = event.target.closest("[data-close-app]"); if (close && !close.disabled) { const key = close.dataset.closeApp; await action(`app-${key}`, async () => { const result = await invoke("closeApp", key); applySnapshot(await invoke("getSnapshot")); return result; }, `${key === "codex" ? "Codex" : "Claude Code"} 已關閉`); return; }
  if (event.target.closest("#toggle-inspector")) { setInspector({ open: !state.inspector.open }); return; }
  if (event.target.closest("[data-close-inspector]")) { setInspector({ open: false }); $("#toggle-inspector").focus(); return; }
  const inspectorTab = event.target.closest("[data-inspector-tab]"); if (inspectorTab) { setInspector({ tab: inspectorTab.dataset.inspectorTab }); return; }
  if (!event.target.closest("#chat-options")) $("#chat-options").open = false;
});
$("#task-form").addEventListener("submit", (event) => { event.preventDefault(); if (!$("#submit-task").disabled) sendMessage(); });
$("#attach-images").addEventListener("click", () => { if (!$("#attach-images").disabled) $("#image-file-input").click(); });
$("#image-file-input").addEventListener("change", (event) => { const files = [...(event.target.files || [])]; event.target.value = ""; importImageFiles(files); });
$("#task-description").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain");
  if (text) { const textarea = event.currentTarget; textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, "end"); textarea.dispatchEvent(new Event("input", { bubbles: true })); }
  importImageFiles(files);
});
const chatView = $("#view-workspace");
const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
chatView.addEventListener("dragenter", (event) => { if (!carriesFiles(event) || state.view !== "workspace") return; event.preventDefault(); state.dragDepth++; $("#image-drop-overlay").hidden = false; });
chatView.addEventListener("dragover", (event) => { if (carriesFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } });
chatView.addEventListener("dragleave", (event) => { if (!carriesFiles(event)) return; state.dragDepth = Math.max(0, state.dragDepth - 1); if (!state.dragDepth) $("#image-drop-overlay").hidden = true; });
chatView.addEventListener("drop", (event) => { if (!carriesFiles(event)) return; event.preventDefault(); state.dragDepth = 0; $("#image-drop-overlay").hidden = true; if (state.view === "workspace") importImageFiles(event.dataTransfer.files); });
document.addEventListener("dragover", (event) => { if (carriesFiles(event)) event.preventDefault(); });
document.addEventListener("drop", (event) => { if (carriesFiles(event)) event.preventDefault(); });
$("#confirm-delete-conversation").addEventListener("click", confirmDeleteConversation);
$("#cancel-delete-conversation").addEventListener("click", () => { if (!state.busy.has(`delete-${state.pendingDeleteId}`)) { $("#delete-conversation-dialog").close(); state.pendingDeleteId = null; } });
$("#delete-conversation-dialog").addEventListener("cancel", (event) => { if (state.busy.has(`delete-${state.pendingDeleteId}`)) event.preventDefault(); else state.pendingDeleteId = null; });
$("#image-preview-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
$("#task-description").addEventListener("input", () => { saveDraft(); state.error = null; resizeComposer(); renderComposer(); });
$("#task-description").addEventListener("compositionstart", () => { state.composing = true; });
$("#task-description").addEventListener("compositionend", () => { state.composing = false; });
$("#task-description").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !state.composing && event.keyCode !== 229) { event.preventDefault(); if (!$("#submit-task").disabled && !activeTaskId()) sendMessage(); } });
$("#task-workspace").addEventListener("input", (event) => { state.options.workspace = event.target.value; state.optionDirty = true; state.error = null; renderComposer(); });
$$("[data-effort-agent]").forEach((slider) => slider.addEventListener("input", () => {
  const agent = slider.dataset.effortAgent; const level = EFFORT_LEVELS[agent][Number(slider.value)];
  if (!level || slider.disabled) return;
  state.options.effort = { ...state.options.effort, [agent]: level }; state.optionDirty = true; syncOptionControls(); renderComposer();
}));
$("#select-workspace").addEventListener("click", () => chooseWorkspace(false));
$("#select-settings-workspace").addEventListener("click", () => chooseWorkspace(true));
$("#history-search").addEventListener("input", renderHistory);
$("#settings-workspace").addEventListener("input", () => { state.settingsWorkspaceDirty = true; });
$("#settings-form").addEventListener("submit", async (event) => { event.preventDefault(); const result = await action("save-settings", () => invoke("updateSettings", { workspace: $("#settings-workspace").value.trim() }), "預設專案已儲存"); if (result !== null) { state.settingsWorkspaceDirty = false; if (!conversation()) state.optionDirty = false; try { applySnapshot(await invoke("getSnapshot")); } catch (error) { showToast(errorMessage(error), true); } } });
$("#close-launched-apps").addEventListener("change", async (event) => { const checked = event.target.checked; const result = await action("close-app-settings", () => invoke("updateSettings", { closeLaunchedApps: checked }), checked ? "關閉視窗時，會一併關閉工作台啟動的 App" : "關閉視窗時，保留工作台啟動的 App"); if (result === null) $("#close-launched-apps").checked = Boolean(state.snapshot.settings?.closeLaunchedApps); else { try { applySnapshot(await invoke("getSnapshot")); } catch (error) { showToast(errorMessage(error), true); } } });
$("#refresh-status").addEventListener("click", () => action("refresh", async () => { const snapshot = await invoke("refreshStatus"); if (snapshot?.agents) applySnapshot(snapshot); else applySnapshot(await invoke("getSnapshot")); }, "App 與 CLI 狀態已更新"));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("#chat-options").open = false;
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") { event.preventDefault(); setInspector({ open: !state.inspector.open }); }
  const tabs = $$("[data-inspector-tab]"); const index = tabs.indexOf(document.activeElement);
  if (index >= 0 && ["ArrowLeft", "ArrowRight"].includes(event.key)) { const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]; setInspector({ tab: next.dataset.inspectorTab }); next.focus(); }
});
window.addEventListener("resize", resizeComposer);
async function initialize() {
  state.inspector = loadInspector();
  render(); syncOptionControls(); resizeComposer();
  try { if (typeof window.bridge?.onUpdate === "function") window.bridge.onUpdate(applySnapshot); if (typeof window.bridge?.onShutdown === "function") window.bridge.onShutdown(showShutdown); applySnapshot(await invoke("getSnapshot")); }
  catch (error) { state.apiError = errorMessage(error); state.loaded = true; render(); }
}
initialize();
