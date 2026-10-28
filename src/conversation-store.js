import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveGitWorkspace } from "./task-store.js";
import { normalizeEffort } from "./effort.js";
import { AGENTS, normalizeCoordinator } from "./dispatch.js";
import { attachmentPreview, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_TOTAL_BYTES, normalizeAttachmentMetadata } from "./chat-attachments.js";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const STATUSES = new Set(["completed", "running", "queued", "failed", "cancelled", "interrupted", "paused", "handoff"]);
const WORKFLOWS = ["coordinated", "codex", "claude"];
const MODES = ["review", "implement"];
const MAX_CONTEXT_CHARACTERS = 16000;

function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function validatePreferences({ workspace, workflow, mode, effort, coordinator }) {
  if (workspace !== undefined && typeof workspace !== "string") throw new Error("無效的專案路徑。");
  if (workflow !== undefined && !WORKFLOWS.includes(workflow)) throw new Error("無效的協作方式。");
  if (mode !== undefined && !MODES.includes(mode)) throw new Error("無效的任務模式。");
  if (effort !== undefined) normalizeEffort(effort);
  if (coordinator !== undefined && !AGENTS.includes(coordinator)) throw new Error("無效的統籌方。");
}

// Older rooms and tasks predate effort settings; unknown stored values fall back to CLI defaults.
function storedEffort(value) { try { return normalizeEffort(value); } catch { return normalizeEffort(); } }
function taskRoomId(task) { return task.conversationId || task.id; }
function chronological(tasks) {
  return [...tasks].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))
    || String(left.id).localeCompare(String(right.id)));
}
function activeAgent(task) {
  const stages = Array.isArray(task.stages) ? task.stages : [];
  const currentStage = stages.findLast(stage => stage.status === "running") || stages.at(-1);
  return ["codex", "claude"].includes(currentStage?.agent) ? currentStage.agent : task.workflow === "claude" ? "claude" : "codex";
}
function failureReason(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let text = value.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (/^[\[{]/.test(text)) {
    try {
      const structured = JSON.parse(text);
      text = typeof structured.message === "string" ? structured.message
        : typeof structured.error?.message === "string" ? structured.error.message : "";
    } catch { return ""; }
  }
  text = text.split(/\r?\n/).find(line => line.trim() && !/^\s*(?:at\s|stderr\b|warnings?\b|[\[{])/i.test(line)) || "";
  // Runtime errors can prefix a structured CLI diagnostic. Keep the useful
  // human prefix rather than exposing the diagnostic object's fields.
  text = text.replace(/\s*(?:\{|\[(?=\s*["'{]))[\s\S]*$/, "").trim();
  text = text.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[已隱藏電子郵件]")
    .replace(/\b(?:sk|sess|token)-[a-z0-9_-]{8,}\b/gi, "[已隱藏憑證]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [已隱藏憑證]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization)"?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[已隱藏憑證]");
  return text.slice(0, 500);
}
function placeholder(status, role, error) {
  if (status === "queued") return "等待回覆…";
  if (status === "running") return `${role === "claude" ? "Claude" : "Codex"} 正在處理訊息…`;
  if (status === "failed") {
    const reason = failureReason(error);
    return `此次回覆未能完成。${reason ? `\n原因：${reason}` : "可以調整訊息後再試一次。"}`;
  }
  if (status === "cancelled") return "此次執行已停止。已產生的內容與修改會保留。";
  if (status === "interrupted") return "上次執行中斷。請檢查專案現況後再傳送訊息。";
  if (status === "handoff") return `${role === "claude" ? "Claude" : "Codex"} 額度用盡，已把這部分交給另一方接手。`;
  if (status === "paused") return "兩邊額度都已用盡，已保存進度並暫停。額度恢復後，按「接續完成」或在這裡傳送訊息，就會從中斷處繼續。";
  return "此次執行已結束。";
}
function planText(output) {
  try {
    const plan = JSON.parse(String(output).match(/\{[\s\S]*\}/)?.[0] ?? output);
    if (plan && typeof plan === "object" && Array.isArray(plan.steps)) {
      const steps = plan.steps.filter(step => step && typeof step.title === "string").map((step, index) => `${index + 1}. ${step.title.trim()}`);
      return [typeof plan.summary === "string" ? plan.summary.trim() : "", steps.length > 1 ? `步驟：\n${steps.join("\n")}` : ""].filter(Boolean).join("\n\n");
    }
    if (plan && typeof plan === "object" && ["summary", "claudeTask", "codexTask"].some(key => typeof plan[key] === "string")) {
      return [typeof plan.summary === "string" ? plan.summary.trim() : "",
        typeof plan.claudeTask === "string" && plan.claudeTask.trim() ? `Claude 接手：\n${plan.claudeTask.trim()}` : "",
        typeof plan.codexTask === "string" && plan.codexTask.trim() ? `Codex 統籌：\n${plan.codexTask.trim()}` : ""].filter(Boolean).join("\n\n");
    }
    return "";
  } catch {
    // An invalid structured planning response belongs in execution diagnostics,
    // rather than raw JSON in the conversation.
    return /^\s*[\[{]/.test(output) ? "" : output;
  }
}

function taskMessages(task) {
  const taskStatus = STATUSES.has(task.status) ? task.status : "interrupted";
  const attachments = normalizeAttachmentMetadata(task.attachments).map(attachmentPreview);
  const messages = [{ id: `${task.id}:user`, role: "user", content: typeof task.userMessage === "string" ? task.userMessage : String(task.task || ""), status: "completed",
    ...(attachments.length ? { attachments } : {}),
    createdAt: task.createdAt, taskId: task.id, substantive: true }];
  const stages = Array.isArray(task.stages) ? task.stages : [];
  for (const [index, stage] of stages.entries()) {
    const role = ["codex", "claude"].includes(stage.agent) ? stage.agent : activeAgent(task);
    const reportedStatus = STATUSES.has(stage.status) ? stage.status : taskStatus;
    const status = TERMINAL.has(taskStatus) && ["running", "queued"].includes(reportedStatus) ? taskStatus : reportedStatus;
    let content = typeof stage.output === "string" ? stage.output.trim() : "";
    if (/planning/i.test(stage.name || "") && content) content = planText(content);
    messages.push({ id: `${task.id}:stage:${index}`, role, content: content || placeholder(status, role, stage.error || task.error), status,
      ...(typeof stage.note === "string" && stage.note.trim() ? { note: stage.note.trim().slice(0, 300) } : {}),
      createdAt: stage.startedAt || task.startedAt || task.createdAt, taskId: task.id, substantive: Boolean(content) && status !== "handoff" });
  }
  // Words the user added when resuming a paused task appear where they were said.
  for (const [index, note] of (Array.isArray(task.resumeNotes) ? task.resumeNotes : []).entries()) {
    if (typeof note?.text !== "string" || !note.text.trim()) continue;
    messages.push({ id: `${task.id}:resume:${index}`, role: "user", content: note.text, status: "completed", createdAt: note.at || task.updatedAt, taskId: task.id, substantive: true });
  }
  const finalOutput = typeof task.output === "string" ? task.output.trim() : "";
  // Whoever finished the last stage (usually the reviewer delivering the result) gives the final reply.
  const lastCompleted = stages.findLast(stage => stage.status === "completed" && ["codex", "claude"].includes(stage.agent));
  const finalRole = lastCompleted?.agent || (task.workflow === "claude" ? "claude" : "codex");
  const lastAssistant = messages.findLast(message => message.role !== "user") || null;
  if (finalOutput && !(lastAssistant?.role === finalRole && lastAssistant.content.trim() === finalOutput)) {
    messages.push({ id: `${task.id}:reply`, role: finalRole, content: finalOutput, status: taskStatus,
      createdAt: task.finishedAt || task.updatedAt || task.createdAt, taskId: task.id, substantive: true });
  } else if ((!stages.length && !finalOutput) || (TERMINAL.has(taskStatus) && taskStatus !== "completed"
    && !messages.some(message => message.role !== "user" && message.status === taskStatus))) {
    const role = activeAgent(task);
    messages.push({ id: `${task.id}:reply`, role, content: placeholder(taskStatus, role, task.error), status: taskStatus,
      createdAt: task.finishedAt || task.startedAt || task.createdAt, taskId: task.id, substantive: false });
  }
  if (taskStatus === "paused") {
    const role = activeAgent(task);
    messages.push({ id: `${task.id}:paused`, role, content: placeholder("paused", role), status: "paused", createdAt: task.pausedAt || task.updatedAt || task.createdAt, taskId: task.id, substantive: false });
  }
  const [first, ...rest] = messages;
  return [first, ...rest.map((message, order) => ({ message, order })).sort((a, b) => String(a.message.createdAt).localeCompare(String(b.message.createdAt)) || a.order - b.order).map(item => item.message)];
}

function contextFromTasks(tasks) {
  const messages = chronological(tasks).filter(task => TERMINAL.has(task.status))
    .flatMap(task => taskMessages(task).filter(message => message.substantive));
  const context = [];
  let remaining = MAX_CONTEXT_CHARACTERS;
  let imagesLeft = MAX_CHAT_IMAGES; let bytesLeft = MAX_CHAT_IMAGE_TOTAL_BYTES; const seenImages = new Set();
  for (let index = messages.length - 1; index >= 0 && (remaining > 0 || imagesLeft > 0); index--) {
    const content = remaining ? messages[index].content.slice(-remaining) : "";
    const attachments = [];
    for (const image of (messages[index].attachments || []).toReversed()) {
      if (imagesLeft && image.size <= bytesLeft && !seenImages.has(image.id)) { attachments.unshift(image); seenImages.add(image.id); imagesLeft--; bytesLeft -= image.size; }
    }
    if (!content && !attachments.length) continue;
    context.unshift({ role: messages[index].role, content, ...(attachments.length ? { attachments: normalizeAttachmentMetadata(attachments) } : {}) });
    remaining -= content.length;
  }
  return context;
}

/** Room metadata is persisted; chat messages are projected from durable task history. */
export function createConversationStore(dataDirectory) {
  const directory = path.join(path.resolve(dataDirectory), "conversations");
  mkdirSync(directory, { recursive: true });
  function roomPath(id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("無效的對話識別碼。");
    const file = path.resolve(directory, `${id}.json`);
    const relative = path.relative(directory, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("無效的對話路徑。");
    if (existsSync(file) && path.dirname(realpathSync(file)) !== realpathSync(directory)) throw new Error("對話檔案不可連結到外部路徑。");
    return file;
  }
  function savedRoom(id) {
    const file = roomPath(id);
    if (!existsSync(file)) return null;
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && value.id === id ? value : null;
  }
  function roomTasks(id, tasks) { return chronological(tasks.filter(task => taskRoomId(task) === id)); }
  function metadata(id, tasks) {
    const saved = savedRoom(id);
    if (saved) return saved;
    const first = roomTasks(id, tasks)[0];
    if (!first) return null;
    return { id, title: String(first.title || first.task || "歷史對話").slice(0, 100), workspace: first.workspace || "",
      workflow: WORKFLOWS.includes(first.workflow) ? first.workflow : "coordinated", mode: MODES.includes(first.mode) ? first.mode : "review",
      effort: storedEffort(first.effort), coordinator: normalizeCoordinator(first.coordinator), createdAt: first.createdAt, updatedAt: first.updatedAt || first.createdAt };
  }
  function project(room, tasks) {
    const related = roomTasks(room.id, tasks);
    const active = related.find(task => !TERMINAL.has(task.status));
    const updatedAt = [room.updatedAt, ...related.map(task => task.updatedAt || task.createdAt)].filter(Boolean).sort().at(-1) || room.createdAt;
    return { ...room, updatedAt, messages: related.flatMap(task => taskMessages(task).map(({ substantive, ...message }) => message)),
      activeTaskId: active?.id || null, taskCount: related.length };
  }
  function get(id, tasks = []) {
    const room = metadata(id, tasks);
    return room ? project(room, tasks) : null;
  }
  function list(tasks = []) {
    const ids = new Set(readdirSync(directory).filter(name => name.endsWith(".json") && ID_PATTERN.test(name.slice(0, -5))).map(name => name.slice(0, -5)));
    for (const task of tasks) if (ID_PATTERN.test(taskRoomId(task))) ids.add(taskRoomId(task));
    return [...ids].flatMap(id => { try { const room = get(id, tasks); return room ? [room] : []; } catch { return []; } })
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.id.localeCompare(right.id));
  }
  function create(input = {}) {
    validatePreferences(input);
    const now = new Date().toISOString();
    const room = { id: randomUUID(), title: "新的對話", workspace: input.workspace || "", workflow: input.workflow || "coordinated",
      mode: input.mode || "implement", effort: normalizeEffort(input.effort), coordinator: normalizeCoordinator(input.coordinator), createdAt: now, updatedAt: now };
    atomicWrite(roomPath(room.id), room);
    return project(room, []);
  }
  function prepareMessage(input, tasks = []) {
    validatePreferences(input);
    const attachments = normalizeAttachmentMetadata(input.attachments);
    if (typeof input.message !== "string" || (!input.message.trim() && !attachments.length) || input.message.length > 8000) throw new Error("請輸入訊息或加入圖片，文字最多 8,000 字。");
    const room = metadata(input.conversationId, tasks);
    if (!room) throw new Error("找不到對話，請先建立新的對話。");
    const related = roomTasks(room.id, tasks);
    if (related.some(task => !TERMINAL.has(task.status))) throw new Error("這個對話仍在處理上一則訊息，請等待回覆或停止執行。");
    const workspace = resolveGitWorkspace(input.workspace ?? room.workspace);
    const workflow = input.workflow ?? room.workflow;
    // Normal chat lets the agent choose whether to answer, inspect or edit.
    // A historical review turn does not constrain a new message's permissions.
    const mode = input.mode ?? "implement";
    const effort = normalizeEffort(input.effort ?? storedEffort(room.effort));
    const coordinator = normalizeCoordinator(input.coordinator ?? room.coordinator);
    const message = input.message.trim();
    return { room: { ...room, workspace, workflow, mode, effort, coordinator }, taskInput: { task: message || "請查看附上的圖片。", userMessage: message,
      attachments, workspace, workflow, mode, effort, coordinator, source: "chat",
      conversationId: room.id, conversationContext: contextFromTasks(related) } };
  }
  function recordSubmission(room, task) {
    const relatedTitle = room.title === "新的對話" ? String(task.task).split(/\r?\n/)[0].slice(0, 100) : room.title;
    const next = { id: room.id, title: relatedTitle, workspace: task.workspace, workflow: task.workflow, mode: task.mode,
      effort: storedEffort(task.effort), coordinator: normalizeCoordinator(task.coordinator), createdAt: room.createdAt, updatedAt: task.createdAt };
    atomicWrite(roomPath(room.id), next);
    return next;
  }
  function remove(id) { const file = roomPath(id); if (existsSync(file)) unlinkSync(file); }
  return { create, get, list, prepareMessage, recordSubmission, remove, directory };
}
