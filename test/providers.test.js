import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createAppManager } from "../src/app-manager.js";
import { resolveCliCommand } from "../src/cli-discovery.js";
import { createConversationStore } from "../src/conversation-store.js";
import { createDesktopServices } from "../src/desktop/services.js";
import { describeCoordination, lenientPlan, normalizeParticipants, pickAgent, planSchema, validateParticipants, validatePlan, workflowFor } from "../src/dispatch.js";
import { COORDINATORS, PROVIDER_IDS, TASK_AGENTS } from "../src/providers.js";

const root = mkdtempSync(path.join(os.tmpdir(), "bridge-providers-"));
const workspace = path.join(root, "workspace");
mkdirSync(workspace);
after(() => {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  rmSync(root, { recursive: true, force: true });
});
const quota = (usedPercent) => ({ primary: { usedPercent, resetsAt: new Date(Date.now() + 3_600_000).toISOString() } });

test("the registry lists Antigravity for management only until its task runner is verified", () => {
  assert.deepEqual(PROVIDER_IDS, ["codex", "claude", "antigravity"]);
  assert.deepEqual(COORDINATORS, ["codex", "claude"]);
  assert.deepEqual(TASK_AGENTS, ["codex", "claude"]);
});

test("participants come from an explicit list, else from the legacy workflow", () => {
  assert.deepEqual(normalizeParticipants(["claude", "codex", "claude"]), ["codex", "claude"]);
  assert.deepEqual(normalizeParticipants(undefined, "claude"), ["claude"]);
  assert.deepEqual(normalizeParticipants(undefined, "coordinated"), ["codex", "claude"]);
  assert.deepEqual(normalizeParticipants(["antigravity"], "codex"), ["codex"]);
  assert.deepEqual(validateParticipants(["claude"]), ["claude"]);
  for (const invalid of [[], ["antigravity"], ["codex", "codex"], ["unknown"], "codex"]) assert.throws(() => validateParticipants(invalid), /請至少選擇/);
  assert.equal(workflowFor(["claude"]), "claude");
  assert.equal(workflowFor(["codex", "claude"]), "coordinated");
});

test("handoff and planning stay within the chosen participants", () => {
  // Only coordinators plan and review; executors fall back only to other participants.
  assert.equal(pickAgent({ preferred: "codex", participants: ["claude"], role: "coordinate" }).agent, "claude");
  assert.equal(pickAgent({ preferred: "codex", participants: ["codex"], quotas: { codex: quota(100) } }).agent, null);
  assert.equal(pickAgent({ preferred: "codex", participants: ["codex", "claude"], quotas: { codex: quota(100) } }).agent, "claude");
  assert.deepEqual(Object.keys(pickAgent({ participants: ["claude"] }).states), ["claude"]);
  assert.deepEqual(planSchema(["claude"]).properties.steps.items.properties.agent.enum, ["claude"]);
  const plan = validatePlan({ summary: "s", kind: "change", acceptance: ["a"], steps: [{ title: "t", instruction: "i", agent: "codex" }] },
    { coordinator: "claude", participants: ["claude"] });
  assert.equal(plan.steps[0].agent, "claude");
  assert.equal(lenientPlan("not json", "req", { coordinator: "codex", participants: ["codex"] }).steps[0].agent, "codex");
  assert.equal(describeCoordination("codex", {}, ["codex"]), "Codex 統籌與審查 · 依任務指派執行");
  assert.equal(describeCoordination("codex", { codex: { available: false }, claude: { available: false } }), "所有 AI 額度都已用盡");
});

test("rooms store participants and older rooms derive them from their workflow", () => {
  const directory = path.join(root, "rooms");
  const store = createConversationStore(directory);
  const single = store.create({ workspace, participants: ["claude"], coordinator: "codex" });
  assert.equal(single.workflow, "claude");
  assert.deepEqual(single.participants, ["claude"]);
  assert.equal(single.coordinator, "claude");
  const legacy = store.create({ workspace, workflow: "codex" });
  assert.deepEqual(legacy.participants, ["codex"]);
  assert.throws(() => store.create({ workspace, participants: [] }), /請至少選擇/);
  const prepared = store.prepareMessage({ conversationId: single.id, message: "hi", participants: ["codex", "claude"], coordinator: "claude" });
  assert.equal(prepared.taskInput.workflow, "coordinated");
  assert.deepEqual(prepared.taskInput.participants, ["codex", "claude"]);
  assert.equal(prepared.taskInput.coordinator, "claude");
});

test("Antigravity's CLI is found as agy on PATH and has no bundled fallback", () => {
  const directory = path.join(root, "agy");
  const bin = path.join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "agy.exe"), "fixture only; not executed");
  const env = { PATH: bin, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory, SystemRoot: directory };
  assert.deepEqual(resolveCliCommand("antigravity", { env, platform: "win32" }), { command: path.join(bin, "agy.exe"), args: [] });
  assert.deepEqual(resolveCliCommand("antigravity", { env: { ...env, PATH: "" }, platform: "win32" }), { command: "agy", args: [] });
});

test("App inventory recognizes the Antigravity agent app but not the IDE", async () => {
  const created = "2026-10-12T01:00:00.0000000Z";
  const appPath = String.raw`C:\Users\user\AppData\Local\Programs\antigravity\Antigravity.exe`;
  const manager = createAppManager({
    platform: "win32",
    execFile(command, args, options, callback) {
      queueMicrotask(() => callback(null, JSON.stringify({
        apps: [{ Name: "Antigravity", AppID: "Google.Antigravity" }, { Name: "Antigravity IDE", AppID: "Google.AntigravityIDE" }],
        processes: [{ pid: 40, parentPid: 1, name: "Antigravity.exe", path: appPath, created },
          { pid: 41, parentPid: 1, name: "Antigravity IDE.exe", path: String.raw`C:\Users\user\AppData\Local\Programs\Antigravity IDE\_\Antigravity IDE.exe`, created }],
      }), ""));
    },
    spawn() { const child = new EventEmitter(); child.unref = () => {}; return child; },
  });
  const result = await manager.list();
  assert.equal(result.antigravity.appId, "Google.Antigravity");
  assert.deepEqual(result.antigravity.pids, [40]);
  assert.equal(result.antigravity.path, appPath);
  manager.dispose();
});

function loginFixture(name, { authenticateAfter = Infinity, available = true } = {}) {
  let probes = 0; let exit;
  const calls = [];
  const status = (id) => ({ available, authenticated: id === "claude" ? probes >= authenticateAfter : true, version: "1.0", error: null });
  const runtime = {
    activeProcesses: () => [], async close() {}, async run() { throw new Error("no runs"); },
    async probe() { return Object.fromEntries(PROVIDER_IDS.map((id) => [id, status(id)])); },
    async probeAgent(id) { probes++; return status(id); },
    async login(id) { calls.push(id); return { pid: 1, exited: new Promise((resolve) => { exit = resolve; }) }; },
  };
  const services = createDesktopServices({ projectRoot: workspace, dataDirectory: path.join(root, name), runtime, port: 0,
    appManager: { list: async () => ({}), dispose() {} }, usageMonitor: { get: () => ({}), refresh: async () => ({}) },
    loginPollMs: 5, loginTimeoutMs: 200 });
  return { services, calls, exit: (code) => exit?.(code) };
}
const waitFor = async (predicate) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(predicate()); };

test("guided sign-in waits for the CLI to report signed in and refuses a second window", async () => {
  const { services, calls } = loginFixture("login-ok", { authenticateAfter: 3 });
  await services.refreshStatus({ refreshQuota: false });
  await services.loginAgent("claude");
  assert.deepEqual(calls, ["claude"]);
  assert.equal(services.snapshot().agents.claude.login.state, "pending");
  await assert.rejects(services.loginAgent("claude"), /已經開啟/);
  await waitFor(() => services.snapshot().agents.claude.authenticated && !services.snapshot().agents.claude.login);
  await assert.rejects(services.loginAgent("unknown"), /無效的 AI/);
  await services.shutdown();
});

test("guided sign-in reports a closed console or timeout without signing in", async () => {
  const closed = loginFixture("login-closed");
  await closed.services.refreshStatus({ refreshQuota: false });
  await closed.services.loginAgent("claude");
  closed.exit(0);
  await waitFor(() => closed.services.snapshot().agents.claude.login?.state === "failed");
  assert.match(closed.services.snapshot().agents.claude.login.message, /視窗已關閉/);
  await closed.services.shutdown();
  const timedOut = loginFixture("login-timeout");
  await timedOut.services.refreshStatus({ refreshQuota: false });
  await timedOut.services.loginAgent("claude");
  await waitFor(() => timedOut.services.snapshot().agents.claude.login?.state === "failed");
  assert.match(timedOut.services.snapshot().agents.claude.login.message, /逾時/);
  await timedOut.services.shutdown();
  const missing = loginFixture("login-missing", { available: false });
  await missing.services.refreshStatus({ refreshQuota: false });
  await assert.rejects(missing.services.loginAgent("claude"), /尚未安裝/);
  await missing.services.shutdown();
});
