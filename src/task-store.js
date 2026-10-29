import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { normalizeEffort } from "./effort.js";
import { AGENTS, COORDINATORS, coordinatorFor, normalizeCoordinator, normalizeParticipants, validateParticipants } from "./dispatch.js";
import { PROVIDER_IDS } from "./providers.js";
import { normalizeAttachmentMetadata } from "./chat-attachments.js";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const OWNER_INVENTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$requested = ConvertFrom-Json -InputObject $env:CODEX_CLAUDE_BRIDGE_OWNER_PIDS
$wanted = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($candidate in $requested) {
  $number = [int]$candidate
  if ($number -gt 0) { [void]$wanted.Add($number) }
}
$owners = @(Get-CimInstance Win32_Process | Where-Object { $wanted.Contains([int]$_.ProcessId) } | ForEach-Object {
  [ordered]@{ pid = [int]$_.ProcessId; createdAt = $_.CreationDate.ToUniversalTime().ToString('o') }
})
ConvertTo-Json -InputObject $owners -Depth 3 -Compress
`;

function fallbackProcessInspection(pids) {
  return new Map(pids.map(pid => {
    let running = true;
    try { process.kill(pid, 0); } catch (error) { running = error.code !== "ESRCH"; }
    return [pid, { running }];
  }));
}

function inspectProcessOwners(pids) {
  const result = fallbackProcessInspection(pids);
  if (!pids.length || process.platform !== "win32") return result;
  try {
    const stdout = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(OWNER_INVENTORY_SCRIPT, "utf16le").toString("base64")], {
      windowsHide: true, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_CLAUDE_BRIDGE_OWNER_PIDS: JSON.stringify(pids) },
    });
    const records = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
    if (Array.isArray(records)) {
      for (const record of records) {
        if (pids.includes(record.pid) && Number.isFinite(Date.parse(record.createdAt))) {
          result.set(record.pid, { running: true, createdAt: record.createdAt });
        }
      }
    }
  } catch { /* Preserve live owners if the OS cannot provide their birth metadata. */ }
  return result;
}

function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** The Agents, coordinator and effort a new conversation starts with: Codex + Claude, led by Codex, auto effort. */
function defaultAgentDefaults() {
  const participants = normalizeParticipants(undefined);
  return { participants, coordinator: coordinatorFor(normalizeCoordinator(undefined), participants), effort: normalizeEffort() };
}
/** Strict form for saving: throws for unknown or unrunnable Agents, coordinators and effort levels. */
export function validateAgentDefaults(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("無效的預設 AI 設定。");
  const participants = value.participants === undefined ? normalizeParticipants(undefined) : validateParticipants(value.participants);
  if (value.coordinator !== undefined && !COORDINATORS.includes(value.coordinator)) throw new Error("無效的統籌方。");
  return { participants, coordinator: coordinatorFor(normalizeCoordinator(value.coordinator), participants), effort: normalizeEffort(value.effort) };
}
/** Lenient form for loading: each malformed field falls back to its default instead of failing startup. */
function storedAgentDefaults(value) {
  const fallback = defaultAgentDefaults();
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  let participants = fallback.participants;
  try { participants = validateParticipants(value.participants); } catch {}
  let effort = fallback.effort;
  try { effort = normalizeEffort(value.effort); } catch {}
  return { participants, coordinator: coordinatorFor(normalizeCoordinator(value.coordinator), participants), effort };
}

export function resolveWorkspaceDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new Error("workspace must be an absolute path to a local directory.");
  }
  const current = realpathSync(directory);
  if (!statSync(current).isDirectory()) throw new Error("專案路徑必須是資料夾。");
  return current;
}
// Kept for existing callers; workspaces now include ordinary local directories.
export const resolveGitWorkspace = resolveWorkspaceDirectory;

export function createTaskStore(dataDirectory, { inspectProcesses = inspectProcessOwners } = {}) {
  const directory = path.resolve(dataDirectory);
  const taskDirectory = path.join(directory, "tasks");
  mkdirSync(taskDirectory, { recursive: true });
  function taskPath(id) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("無效的任務識別碼。");
    const file = path.resolve(taskDirectory, `${id}.json`);
    const relative = path.relative(taskDirectory, file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("無效的任務路徑。");
    if (existsSync(file) && path.dirname(realpathSync(file)) !== realpathSync(taskDirectory)) throw new Error("任務檔案不可連結到外部路徑。");
    return file;
  }
  function get(id) {
    const file = taskPath(id);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  }
  function update(id, changes) {
    const previous = get(id);
    if (!previous) throw new Error("找不到任務。");
    const next = { ...previous, ...changes, id: previous.id, createdAt: previous.createdAt, updatedAt: new Date().toISOString() };
    atomicWrite(taskPath(id), next);
    return next;
  }
  function listAll() {
    return readdirSync(taskDirectory)
      .filter(name => name.endsWith(".json") && ID_PATTERN.test(name.slice(0, -5)))
      .flatMap(name => { try { return [JSON.parse(readFileSync(path.join(taskDirectory, name), "utf8"))]; } catch { return []; } })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  function list() {
    return listAll().slice(0, 300);
  }
  function create(input) {
    const minimumLength = input.source === "chat" ? 1 : 10;
    if (typeof input.task !== "string" || input.task.trim().length < minimumLength || input.task.length > 8000) {
      throw new Error(`請輸入 ${minimumLength} 到 8,000 字的${input.source === "chat" ? "訊息" : "任務內容"}。`);
    }
    if (!["coordinated", ...AGENTS].includes(input.workflow)) throw new Error("無效的協作方式。");
    if (!["review", "implement"].includes(input.mode)) throw new Error("無效的任務模式。");
    if (input.coordinator !== undefined && !COORDINATORS.includes(input.coordinator)) throw new Error("無效的統籌方。");
    // Participants only apply to coordinated work; a single agent's workflow is that agent alone.
    const participants = input.workflow === "coordinated"
      ? (input.participants === undefined ? normalizeParticipants(undefined) : validateParticipants(input.participants)) : [input.workflow];
    if (input.workflow === "coordinated" && participants.length < 2) throw new Error("協作至少需要兩個 AI；只選一個時請直接交給它處理。");
    if (input.conversationId !== undefined && (typeof input.conversationId !== "string" || !ID_PATTERN.test(input.conversationId))) throw new Error("無效的對話識別碼。");
    const attachments = normalizeAttachmentMetadata(input.attachments);
    if (input.userMessage !== undefined && (typeof input.userMessage !== "string" || input.userMessage.length > 8000
      || (!input.userMessage.trim() && !attachments.length))) throw new Error("無效的訊息內容。");
    const rawContext = input.conversationContext ?? [];
    const conversationContext = Array.isArray(rawContext) ? rawContext.map(message => {
      if (!message || !["user", ...PROVIDER_IDS].includes(message.role) || typeof message.content !== "string") return null;
      const images = normalizeAttachmentMetadata(message.attachments);
      if ((images.length && message.role !== "user") || (!message.content.trim() && !images.length)) return null;
      return { role: message.role, content: message.content, ...(images.length ? { attachments: images } : {}) };
    }) : rawContext;
    if (!Array.isArray(conversationContext) || conversationContext.some(message => !message
      || !["user", ...PROVIDER_IDS].includes(message.role) || typeof message.content !== "string")
      || conversationContext.reduce((length, message) => length + message.content.length, 0) > 16000) {
      throw new Error("無效的對話內容；前文最多 16,000 字。");
    }
    normalizeAttachmentMetadata(conversationContext.flatMap(message => message.attachments || []));
    const effort = normalizeEffort(input.effort);
    const workspace = resolveGitWorkspace(input.workspace);
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(), title: String(input.title || input.task.trim().split(/\r?\n/)[0]).slice(0, 100),
      task: input.task.trim(), workspace, workflow: input.workflow, participants, mode: input.mode, effort, coordinator: coordinatorFor(normalizeCoordinator(input.coordinator), participants),
      max_turns: input.max_turns, source: input.source || "desktop", ownerId: input.ownerId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      conversationContext,
      ...(attachments.length ? { attachments } : {}),
      ...(input.userMessage !== undefined ? { userMessage: input.userMessage } : {}),
      ownerPid: process.pid,
      status: "queued", progress: "等待執行", stages: [], output: "", error: "", warnings: [],
      createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    };
    atomicWrite(taskPath(task.id), task);
    return task;
  }
  function recoverInterrupted() {
    // Paused tasks hold a saved checkpoint and wait for the user; they are not interrupted by a restart.
    const unfinished = listAll().filter(task => !TERMINAL.has(task.status) && task.status !== "paused");
    const pids = [...new Set(unfinished.map(task => Number(task.ownerPid)).filter(pid => Number.isInteger(pid) && pid > 0 && pid <= 2147483647))];
    let owners;
    try { owners = inspectProcesses(pids); } catch { owners = fallbackProcessInspection(pids); }
    for (const task of unfinished) {
      const owner = owners instanceof Map ? owners.get(Number(task.ownerPid)) : owners?.[Number(task.ownerPid)];
      const ownerBorn = Date.parse(owner?.createdAt);
      const taskCreated = Date.parse(task.createdAt);
      const recordedBirth = Date.parse(task.ownerCreatedAt);
      const replacedOwner = Number.isFinite(ownerBorn) && ((Number.isFinite(taskCreated) && ownerBorn > taskCreated)
        || (Number.isFinite(recordedBirth) && ownerBorn !== recordedBirth));
      if (owner?.running && !replacedOwner) continue;
      update(task.id, { status: "interrupted", progress: "前次執行中斷", error: "管理器前次未正常結束。請檢查專案現況後再建立新任務。", finishedAt: new Date().toISOString() });
    }
  }
  function loadSettings(defaults = {}) {
    const file = path.join(directory, "settings.json");
    let saved = {};
    try { saved = JSON.parse(readFileSync(file, "utf8")); } catch {}
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
    return {
      workspace: typeof saved.workspace === "string" ? saved.workspace : (defaults.workspace || ""),
      closeLaunchedApps: saved.closeLaunchedApps === true,
      agentDefaults: storedAgentDefaults(saved.agentDefaults),
    };
  }
  function saveSettings(settings) {
    const normalized = {
      workspace: String(settings.workspace || ""), closeLaunchedApps: settings.closeLaunchedApps === true,
      agentDefaults: settings.agentDefaults === undefined ? defaultAgentDefaults() : validateAgentDefaults(settings.agentDefaults),
    };
    atomicWrite(path.join(directory, "settings.json"), normalized);
    return normalized;
  }
  function remove(id) { const file = taskPath(id); if (existsSync(file)) unlinkSync(file); }
  return { create, update, get, list, listAll, remove, recoverInterrupted, loadSettings, saveSettings, directory };
}
