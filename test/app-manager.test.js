import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAppManager } from "../src/app-manager.js";

const CODEX_PATH = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`;
const CLAUDE_PATH = String.raw`C:\Program Files\WindowsApps\Claude_2.31226.1.0_x64__pzs8sxrjxfjjc\app\claude.exe`;
const CREATED = "2026-10-12T01:00:00.0000000Z";
const installedApps = [
  { Name: "ChatGPT", AppID: "OpenAI.Codex_2p2nqsd0c76g0!App" },
  { Name: "Claude", AppID: "Claude_pzs8sxrjxfjjc!Claude" },
];

function nativeProcess(pid, app, parentPid = 900) {
  return { pid, parentPid, name: app === "codex" ? "ChatGPT.exe" : "claude.exe",
    path: app === "codex" ? CODEX_PATH : CLAUDE_PATH, created: CREATED };
}

function mockManager({ apps = installedApps, processes = [], onSpawn } = {}) {
  const state = { apps, processes, commands: [], launches: [], closed: [] };
  const manager = createAppManager({
    platform: "win32",
    execFile(command, args, options, callback) {
      state.commands.push({ command, args, options });
      const closeTarget = options.env.CODEX_CLAUDE_BRIDGE_OWNED_APP;
      if (closeTarget) {
        const expected = JSON.parse(closeTarget);
        state.closed.push(expected);
        state.processes = state.processes.filter((item) => item.pid !== expected.pid && item.parentPid !== expected.pid);
        queueMicrotask(() => callback(null, '{"status":"closed"}', ""));
      } else {
        const response = JSON.stringify({ apps: state.apps, processes: state.processes });
        queueMicrotask(() => callback(null, response, ""));
      }
    },
    spawn(command, args, options) {
      state.launches.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = 100;
      child.unref = () => {};
      onSpawn?.(state, child);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  return { manager, state };
}

test("native inventory recognizes packaged Codex desktop and excludes its CLI children", async () => {
  const { manager, state } = mockManager({ processes: [nativeProcess(10, "codex"), {
    pid: 11, parentPid: 10, name: "codex.exe",
    path: String.raw`C:\Users\user\AppData\Local\OpenAI\Codex\bin\abc\codex.exe`, created: CREATED,
  }] });
  const result = await manager.list();
  assert.equal(result.codex.installed, true);
  assert.equal(result.codex.appId, installedApps[0].AppID);
  assert.deepEqual(result.codex.pids, [10]);
  assert.equal(result.codex.managed, false);
  assert.equal(result.claude.running, false);
  await manager.launch("codex");
  assert.equal(state.launches.length, 0, "already open desktop apps must not become owned");
  await assert.rejects(manager.close("codex"), /opened outside this manager/);
  assert.equal(state.closed.length, 0);
});

test("launch tracks the newly created root and closes only that verified owned root", async () => {
  const { manager, state } = mockManager({ onSpawn(snapshot) {
    snapshot.processes = [nativeProcess(20, "claude"), nativeProcess(21, "claude", 20), nativeProcess(10, "codex")];
  } });
  const launched = await manager.launch("claude");
  assert.equal(launched.running, true);
  assert.equal(launched.managed, true);
  assert.deepEqual(launched.pids, [20, 21]);
  assert.equal(state.launches[0].command, "explorer.exe");
  assert.deepEqual(state.launches[0].args, ["shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude"]);
  assert.equal(state.launches[0].options.windowsHide, true);
  const result = await manager.closeOwned();
  assert.equal(result.claude.running, false);
  assert.equal(result.codex.running, true);
  assert.equal(state.closed.length, 1);
  assert.equal(state.closed[0].pid, 20);
  assert.equal(state.closed[0].path, CLAUDE_PATH);
  assert.equal(state.closed[0].created, CREATED);
  const stopCommand = state.commands.find((command) => command.options.env.CODEX_CLAUDE_BRIDGE_OWNED_APP);
  const stopScript = Buffer.from(stopCommand.args.at(-1), "base64").toString("utf16le");
  assert.match(stopScript, /ExecutablePath -ine/);
  assert.match(stopScript, /\$created -cne/);
  assert.doesNotMatch(stopScript, /taskkill|Stop-Process -Name/i);
});

test("PID reuse or executable changes revoke ownership without closing the replacement", async () => {
  const { manager, state } = mockManager({ onSpawn(snapshot) {
    snapshot.processes = [nativeProcess(20, "claude")];
  } });
  await manager.launch("claude");
  state.processes = [{ ...nativeProcess(20, "claude"), path: String.raw`C:\Other\claude.exe` }];
  const result = await manager.close("claude");
  assert.equal(result.managed, false);
  assert.equal(state.closed.length, 0);
  assert.equal(state.processes.length, 1);

  state.processes = [nativeProcess(20, "claude")];
  await assert.rejects(manager.close("claude"), /opened outside this manager/);
  assert.equal(state.closed.length, 0);
});

test("a previously observed desktop executable can launch when no StartApps registration exists", async () => {
  const { manager, state } = mockManager({ apps: [], processes: [nativeProcess(10, "codex")], onSpawn(snapshot, child) {
    snapshot.processes = [nativeProcess(child.pid, "codex")];
  } });
  await manager.list();
  state.processes = [];
  const result = await manager.launch("codex");
  assert.equal(result.managed, true);
  assert.equal(state.launches[0].command, CODEX_PATH);
  assert.deepEqual(state.launches[0].args, []);
  assert.equal(state.launches[0].options.windowsHide, false);
});

test("unrelated registrations and unknown app IDs cannot become a launcher", async () => {
  const { manager, state } = mockManager({ apps: [{ Name: "Codex", AppID: "cmd.exe /c arbitrary-command" }] });
  const result = await manager.list();
  assert.equal(result.codex.installed, false);
  await assert.rejects(manager.launch("codex"), /could not be found/);
  await assert.rejects(manager.launch("codex; Stop-Process"), /Unknown app/);
  assert.equal(state.launches.length, 0);
});

test("non-Windows platforms return an actionable state without running OS commands", async () => {
  let queried = false;
  const manager = createAppManager({ platform: "linux", execFile() { queried = true; } });
  const result = await manager.list();
  assert.match(result.codex.error, /supported on Windows/);
  assert.equal(result.codex.running, false);
  assert.equal(queried, false);
});

test("dispose cancels a pending refresh, kills only its live helper, and rejects queued launches", async () => {
  const helpers = [];
  let queries = 0;
  const manager = createAppManager({
    platform: "win32",
    execFile() {
      queries++;
      const helper = new EventEmitter();
      helper.exitCode = null;
      helper.killCount = 0;
      helper.kill = () => { helper.killCount++; };
      helpers.push(helper);
      return helper;
    },
    spawn() { assert.fail("a disposed queued launch must not start a desktop app"); },
  });
  const firstRefresh = manager.list();
  const exitedRefresh = manager.list();
  helpers[1].exitCode = 0;
  helpers[1].emit("exit", 0);
  const queuedLaunch = assert.rejects(manager.launch("claude"), /App manager is closed/);
  manager.dispose();
  manager.dispose();
  const [firstResult, exitedResult] = await Promise.all([firstRefresh, exitedRefresh]);
  await queuedLaunch;
  assert.match(firstResult.claude.error, /App manager is closed/);
  assert.match(exitedResult.codex.error, /App manager is closed/);
  assert.equal(helpers[0].killCount, 1);
  assert.equal(helpers[1].killCount, 0);
  await manager.list();
  await assert.rejects(manager.launch("codex"), /App manager is closed/);
  assert.equal(queries, 2, "dispose must prevent every new inventory query");
});

test("dispose cancels a pending GUI launcher without killing Explorer or native apps", async () => {
  let launcher;
  let launched;
  const launcherReady = new Promise((resolve) => { launched = resolve; });
  const manager = createAppManager({
    platform: "win32",
    execFile(command, args, options, callback) {
      queueMicrotask(() => callback(null, JSON.stringify({ apps: installedApps, processes: [] }), ""));
    },
    spawn() {
      launcher = new EventEmitter();
      launcher.pid = 100;
      launcher.killCount = 0;
      launcher.kill = () => { launcher.killCount++; };
      launcher.unref = () => {};
      launched();
      return launcher;
    },
  });
  const pendingLaunch = assert.rejects(manager.launch("claude"), /App manager is closed/);
  await launcherReady;
  manager.dispose();
  await pendingLaunch;
  assert.equal(launcher.killCount, 0);
  launcher.emit("error", new Error("Late spawn failure"));
});
