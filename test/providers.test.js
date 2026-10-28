import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createAgentRuntime } from "../src/agent-runtime.js";
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

function loginFixture(name, { authenticateAfter = Infinity, credentialBefore = false, available = true, target = "claude", appManager } = {}) {
  let probes = 0; let exit;
  const calls = [];
  const status = (id) => ({ available: id === target ? available : true,
    authenticated: id === "antigravity" ? null : id === target ? probes >= authenticateAfter : true,
    ...(id === "antigravity" ? { credentialPresent: probes >= authenticateAfter ? true : credentialBefore, authSource: "credential-entry" } : {}), version: "1.0", error: null });
  const runtime = {
    activeProcesses: () => [], async close() {}, async run() { throw new Error("no runs"); },
    async probe() { return Object.fromEntries(PROVIDER_IDS.map((id) => [id, status(id)])); },
    async probeAgent(id) { probes++; return status(id); },
    async login(id) { calls.push(id); return { pid: 1, exited: new Promise((resolve) => { exit = resolve; }) }; },
  };
  const services = createDesktopServices({ projectRoot: workspace, dataDirectory: path.join(root, name), runtime, port: 0,
    appManager: appManager || { list: async () => ({}), dispose() {} }, usageMonitor: { get: () => ({}), refresh: async () => ({}) },
    loginPollMs: 5, loginTimeoutMs: 200 });
  return { services, calls, exit: (code) => exit?.(code), setCredentialPresence: (value) => { credentialBefore = value; } };
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

test("Antigravity reports a credential marker without asserting authenticated even without agy", async () => {
  const missing = path.join(root, "no-agy", "agy.exe");
  const checked = [];
  const runtime = createAgentRuntime({ antigravityCommand: { command: missing, args: [] }, runtimeDirectory: path.join(root, "agy-runtime"),
    credentialExists: async (target) => { checked.push(target); return true; } });
  try {
    const status = await runtime.probeAgent("antigravity");
    assert.equal(status.available, false);
    assert.equal(status.authenticated, null);
    assert.equal(status.credentialPresent, true);
    assert.deepEqual(checked, ["gemini:antigravity"]);
  } finally { await runtime.close(); }
});

test("Antigravity sign-in opens the desktop app and waits for its credential", async () => {
  const launched = [];
  let running = true;
  const appManager = { list: async () => ({ antigravity: { installed: true, running } }), dispose() {}, async launch(id) { launched.push(id); return { installed: true, running, error: running ? null : "The app started but quit right away." }; } };
  const ok = loginFixture("login-app", { target: "antigravity", available: false, authenticateAfter: 2, appManager });
  await ok.services.refreshStatus({ refreshQuota: false });
  const started = await ok.services.loginAgent("antigravity");
  assert.deepEqual(launched, ["antigravity"]);
  assert.deepEqual(ok.calls, [], "no CLI console is opened");
  assert.match(started.login.message, /App 內完成 Google 登入/);
  await waitFor(() => ok.services.snapshot().agents.antigravity.credentialPresent === true && !ok.services.snapshot().agents.antigravity.login);
  assert.equal(ok.services.snapshot().agents.antigravity.authenticated, null);
  await ok.services.shutdown();
  running = false;
  const quits = loginFixture("login-app-quits", { target: "antigravity", available: false, appManager });
  await quits.services.refreshStatus({ refreshQuota: false });
  await assert.rejects(quits.services.loginAgent("antigravity"), /無法開啟 Antigravity.*quit right away/);
  assert.equal(quits.services.snapshot().agents.antigravity.login, undefined);
  await quits.services.shutdown();
});

test("App sign-in monitors an app that exits after initial startup instead of waiting for timeout", async () => {
  let running = true;
  const appManager = { list: async () => ({ antigravity: { installed: true, running } }), dispose() {},
    async launch() { return { installed: true, running: true }; } };
  const { services } = loginFixture("login-app-late-exit", { target: "antigravity", available: false, appManager });
  await services.refreshStatus({ refreshQuota: false });
  await services.loginAgent("antigravity");
  running = false;
  await waitFor(() => services.snapshot().agents.antigravity.login?.state === "failed");
  assert.match(services.snapshot().agents.antigravity.login.message, /Antigravity 已結束/);
  assert.doesNotMatch(services.snapshot().agents.antigravity.login.message, /逾時/);
  await services.shutdown();
});

test("App re-login remains available with an existing marker and never asserts fresh authentication", async () => {
  const launched = [];
  const appManager = { list: async () => ({ antigravity: { running: true } }), dispose() {},
    async launch(id) { launched.push(id); return { installed: true, running: true }; } };
  const { services, calls } = loginFixture("login-existing-marker", { target: "antigravity", available: true, credentialBefore: true, appManager });
  await services.refreshStatus({ refreshQuota: false });
  const result = await services.loginAgent("antigravity");
  assert.equal(result.login.state, "opened");
  assert.match(result.login.message, /不代表登入仍有效/);
  assert.equal(services.snapshot().agents.antigravity.authenticated, null);
  assert.deepEqual(calls, [], "App-owned sign-in does not start agy even when it is installed");
  await services.loginAgent("antigravity");
  assert.equal(launched.length, 2, "existing markers must not hide or lock re-login");
  await services.shutdown();
});

test("refresh clears a stale App login failure when a credential arrives later without claiming authentication", async () => {
  let running = true;
  const appManager = { list: async () => ({ antigravity: { installed: true, running } }), dispose() {},
    async launch() { return { installed: true, running: true }; } };
  const fixture = loginFixture("login-app-late-marker", { target: "antigravity", available: false, appManager });
  try {
    await fixture.services.refreshStatus({ refreshQuota: false });
    await fixture.services.loginAgent("antigravity");
    running = false;
    await waitFor(() => fixture.services.snapshot().agents.antigravity.login?.state === "failed");
    fixture.setCredentialPresence(true);
    await fixture.services.refreshStatus({ refreshQuota: false });
    const status = fixture.services.snapshot().agents.antigravity;
    assert.equal(status.login, undefined);
    assert.equal(status.credentialPresent, true);
    assert.equal(status.authenticated, null);
  } finally { await fixture.services.shutdown(); }
});

test("unknown App credentials remain unknown until a marker is detected", async () => {
  const appManager = { list: async () => ({ antigravity: { running: true } }), dispose() {},
    async launch() { return { installed: true, running: true }; } };
  const { services } = loginFixture("login-unknown-marker", { target: "antigravity", credentialBefore: null, authenticateAfter: 3, appManager });
  await services.refreshStatus({ refreshQuota: false });
  assert.equal(services.snapshot().agents.antigravity.credentialPresent, null);
  await services.loginAgent("antigravity");
  assert.equal(services.snapshot().agents.antigravity.credentialPresent, null);
  await waitFor(() => services.snapshot().agents.antigravity.credentialPresent === true);
  assert.equal(services.snapshot().agents.antigravity.authenticated, null);
  await services.shutdown();
});

test("concurrent App login reserves its pending state before awaiting launch", async () => {
  let release; let launches = 0;
  const appManager = { list: async () => ({}), dispose() {}, async launch() {
    launches++;
    return new Promise((resolve) => { release = resolve; });
  } };
  const { services } = loginFixture("login-concurrent-app", { target: "antigravity", available: false, appManager });
  await services.refreshStatus({ refreshQuota: false });
  const first = services.loginAgent("antigravity");
  await assert.rejects(services.loginAgent("antigravity"), /已經開啟/);
  assert.equal(launches, 1);
  release({ installed: true, running: false, error: "fixture startup failure" });
  await assert.rejects(first, /fixture startup failure/);
  assert.equal(services.snapshot().agents.antigravity.login, undefined);
  await services.shutdown();
});

test("shutdown during App launch cannot restore pending login or app state", async () => {
  let release;
  const appManager = { list: async () => ({}), dispose() {}, async launch() {
    return new Promise((resolve) => { release = resolve; });
  } };
  const { services } = loginFixture("login-shutdown-app", { target: "antigravity", available: false, appManager });
  await services.refreshStatus({ refreshQuota: false });
  const opening = assert.rejects(services.loginAgent("antigravity"), /正在關閉/);
  await services.shutdown();
  release({ installed: true, running: true });
  await opening;
  assert.equal(services.snapshot().agents.antigravity.login, undefined);
  assert.equal(services.snapshot().apps.antigravity, undefined);
});

test("App sign-in rejects a reused root PID even if another process remains running", async () => {
  const original = { pid: 40, created: "2026-10-28T01:00:00.000Z" };
  let roots = [original];
  const appManager = { list: async () => ({ antigravity: { running: true, rootProcesses: roots } }), dispose() {},
    async launch() { return { installed: true, running: true, rootProcesses: [original] }; } };
  const { services } = loginFixture("login-root-reused", { target: "antigravity", available: false, appManager });
  await services.refreshStatus({ refreshQuota: false });
  await services.loginAgent("antigravity");
  roots = [{ ...original, created: "2026-10-28T01:00:01.000Z" }];
  await waitFor(() => services.snapshot().agents.antigravity.login?.state === "failed");
  assert.match(services.snapshot().agents.antigravity.login.message, /已結束/);
  await services.shutdown();
});

test("failed App inventory is reported as unknown instead of asserting that the App exited", async () => {
  const appManager = { list: async () => ({ antigravity: { running: false, error: "fixture inventory unavailable" } }), dispose() {},
    async launch() { return { installed: true, running: true }; } };
  const { services } = loginFixture("login-inventory-unknown", { target: "antigravity", credentialBefore: null, appManager });
  await services.refreshStatus({ refreshQuota: false });
  await services.loginAgent("antigravity");
  await waitFor(() => services.snapshot().agents.antigravity.login?.state === "failed");
  assert.match(services.snapshot().agents.antigravity.login.message, /無法確認.*程序/);
  assert.doesNotMatch(services.snapshot().agents.antigravity.login.message, /已結束|逾時/);
  assert.equal(services.snapshot().agents.antigravity.credentialPresent, null);
  await services.shutdown();
});
