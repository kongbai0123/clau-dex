import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createAppManager } from "../src/app-manager.js";

const CODEX_PATH = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe`;
const CLAUDE_PATH = String.raw`C:\Program Files\WindowsApps\Claude_2.31226.1.0_x64__pzs8sxrjxfjjc\app\claude.exe`;
const ANTIGRAVITY_PATH = String.raw`C:\Users\user\AppData\Local\Programs\Antigravity\Antigravity.exe`;
const CREATED = "2026-10-12T01:00:00.0000000Z";
const installedApps = [
  { Name: "ChatGPT", AppID: "OpenAI.Codex_2p2nqsd0c76g0!App" },
  { Name: "Claude", AppID: "Claude_pzs8sxrjxfjjc!Claude" },
];

function nativeProcess(pid, app, parentPid = 900) {
  return { pid, parentPid, name: app === "codex" ? "ChatGPT.exe" : app === "antigravity" ? "Antigravity.exe" : "claude.exe",
    path: app === "codex" ? CODEX_PATH : app === "antigravity" ? ANTIGRAVITY_PATH : CLAUDE_PATH, created: CREATED };
}

function mockManager({ apps = installedApps, processes = [], onSpawn, onInventory, startupSettleMs = 0 } = {}) {
  const state = { apps, processes, commands: [], launches: [], closed: [], inventories: 0 };
  const manager = createAppManager({
    platform: "win32",
    startupSettleMs,
    execFile(command, args, options, callback) {
      state.commands.push({ command, args, options });
      const closeTarget = options.env.CODEX_CLAUDE_BRIDGE_OWNED_APP;
      if (closeTarget) {
        const expected = JSON.parse(closeTarget);
        state.closed.push(expected);
        state.processes = state.processes.filter((item) => item.pid !== expected.pid && item.parentPid !== expected.pid);
        queueMicrotask(() => callback(null, '{"status":"closed"}', ""));
      } else {
        onInventory?.(state, ++state.inventories);
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

test("an app that quits right after starting is reported instead of treated as launched", async () => {
  let launchedAt = 0;
  const { manager } = mockManager({
    onSpawn(snapshot) { snapshot.processes = [nativeProcess(20, "claude")]; launchedAt = snapshot.inventories; },
    // It is visible on the first check after launch and gone by the settle check.
    onInventory(snapshot, count) { if (launchedAt && count > launchedAt + 1) snapshot.processes = []; },
  });
  const result = await manager.launch("claude");
  assert.equal(result.running, false);
  assert.equal(result.managed, false);
  assert.match(result.error, /quit right away/);
});

test("a surviving renderer cannot stand in for a root that exited during startup", async () => {
  let launchedAt = 0;
  const { manager } = mockManager({
    onSpawn(snapshot) {
      snapshot.processes = [nativeProcess(20, "claude"), { ...nativeProcess(21, "claude", 20), type: "renderer" }];
      launchedAt = snapshot.inventories;
    },
    onInventory(snapshot, count) { if (launchedAt && count > launchedAt + 1) snapshot.processes = snapshot.processes.filter((item) => item.pid !== 20); },
  });
  const result = await manager.launch("claude");
  assert.equal(result.running, false);
  assert.equal(result.managed, false);
  assert.deepEqual(result.rootProcesses, []);
  assert.match(result.error, /quit right away/);
  await manager.dispose();
});

test("root PID reuse during startup cannot become a managed launch", async () => {
  let launchedAt = 0;
  const { manager, state } = mockManager({
    onSpawn(snapshot) { snapshot.processes = [nativeProcess(20, "claude")]; launchedAt = snapshot.inventories; },
    onInventory(snapshot, count) {
      if (launchedAt && count > launchedAt + 1) snapshot.processes = [{ ...nativeProcess(20, "claude"), created: "2026-10-12T01:00:01.0000000Z" }];
    },
  });
  const result = await manager.launch("claude");
  assert.equal(result.running, false);
  assert.equal(result.managed, false);
  assert.match(result.error, /identity changed/);
  await manager.closeOwned();
  assert.equal(state.closed.length, 0);
  await manager.dispose();
});

test("inventory reports orphan GPU and renderer processes without claiming the App is running", async () => {
  const { manager } = mockManager({ processes: [
    { ...nativeProcess(21, "claude", 20), type: "renderer" },
    { ...nativeProcess(22, "claude", 20), type: "gpu-process" },
  ] });
  const result = await manager.list();
  assert.equal(result.claude.running, false);
  assert.deepEqual(result.claude.pids, [21, 22]);
  assert.deepEqual(result.claude.rootProcesses, []);
  await manager.dispose();
});

test("dispose cancels the startup settle delay before ownership can be assigned", async () => {
  let appeared;
  const visible = new Promise((resolve) => { appeared = resolve; });
  const { manager, state } = mockManager({
    startupSettleMs: 10_000,
    onSpawn(snapshot) { snapshot.processes = [nativeProcess(20, "claude")]; },
    onInventory(snapshot) { if (snapshot.processes.length) setTimeout(appeared, 5); },
  });
  const pending = assert.rejects(manager.launch("claude"), /App manager is closed/);
  await visible;
  const start = Date.now();
  await manager.dispose();
  await pending;
  assert.ok(Date.now() - start < 1000, "shutdown should not wait for the ten-second test settle timer");
  assert.equal(state.closed.length, 0, "dispose does not terminate unowned native apps");
});

test("orphan Node sidecars do not prevent relaunch or become owned GUI roots", async () => {
  const sidecars = [41, 42, 43].map((pid) => ({ ...nativeProcess(pid, "antigravity", 40), nodeHost: true }));
  let launchedAt = 0;
  const { manager, state } = mockManager({
    apps: [{ Name: "Antigravity", AppID: "Google.Antigravity" }],
    processes: sidecars,
    onSpawn(snapshot) {
      // The new launch initially exposes only another Node host, not its GUI.
      snapshot.processes.push({ ...nativeProcess(50, "antigravity", 40), nodeHost: true });
      launchedAt = snapshot.inventories;
    },
    onInventory(snapshot, count) {
      if (launchedAt && count >= launchedAt + 2 && !snapshot.processes.some((item) => item.pid === 60)) {
        snapshot.processes.push({ ...nativeProcess(60, "antigravity"), nodeHost: false });
      }
    },
  });
  const before = (await manager.list()).antigravity;
  assert.equal(before.running, false);
  assert.equal(before.managed, false);
  assert.deepEqual(before.rootProcesses, []);
  assert.deepEqual(before.pids, [41, 42, 43]);
  const launched = await manager.launch("antigravity");
  assert.equal(state.launches.length, 1, "a sidecar cannot short-circuit GUI launch");
  assert.equal(launched.running, true);
  assert.equal(launched.managed, true);
  assert.deepEqual(launched.rootProcesses, [{ pid: 60, created: CREATED }]);
  // Prevent the fixture from synthesizing another GUI during the close check.
  launchedAt = 0;
  const closed = await manager.closeOwned();
  assert.equal(closed.antigravity.running, false);
  assert.equal(closed.antigravity.managed, false);
  assert.deepEqual(state.closed.map((item) => item.pid), [60]);
  assert.deepEqual(closed.antigravity.pids, [41, 42, 43, 50], "sidecars remain observable but are not closed");
  await manager.dispose();
});

test("a Node-host role discovered during the settle check cannot acquire ownership", async () => {
  let launchedAt = 0;
  const { manager, state } = mockManager({
    onSpawn(snapshot) { snapshot.processes = [nativeProcess(20, "claude")]; launchedAt = snapshot.inventories; },
    onInventory(snapshot, count) {
      if (launchedAt && count > launchedAt + 1) snapshot.processes = [{ ...nativeProcess(20, "claude"), nodeHost: true }];
    },
  });
  const result = await manager.launch("claude");
  assert.equal(result.running, false);
  assert.equal(result.managed, false);
  assert.deepEqual(result.rootProcesses, []);
  await manager.closeOwned();
  assert.equal(state.closed.length, 0);
  await manager.dispose();
});

test("positive Node-host metadata revokes prior ownership instead of closing the sidecar", async () => {
  const { manager, state } = mockManager({ onSpawn(snapshot) { snapshot.processes = [nativeProcess(20, "claude")]; } });
  assert.equal((await manager.launch("claude")).managed, true);
  state.processes[0].nodeHost = true;
  const observed = (await manager.list()).claude;
  assert.equal(observed.running, false);
  assert.equal(observed.managed, false);
  await manager.closeOwned();
  assert.equal(state.closed.length, 0);
  await manager.dispose();
});

test("Windows inventory distinguishes Node startup flags from GUI JavaScript filenames", { skip: process.platform !== "win32" }, async () => {
  const { manager, state } = mockManager();
  await manager.list();
  const inventory = Buffer.from(state.commands[0].args.at(-1), "base64").toString("utf16le");
  const start = inventory.indexOf("function Test-BridgeNodeHost");
  const end = inventory.indexOf("$processes = @(", start);
  assert.ok(start >= 0 && end > start);
  const classifier = inventory.slice(start, end);
  const cases = [
    [String.raw`"C:\App Folder\Antigravity.exe" --import=file:///C:/app/sidecar_sdk/register_loader.js dist/server.cjs`, true],
    [String.raw`"C:\App Folder\Antigravity.exe" --import="file:///C:/App Folder/sidecar_sdk/register_loader.js" ../launch.mjs compose-preview`, true],
    [String.raw`"C:\App Folder\Antigravity.exe" --require preload.cjs`, true],
    [String.raw`"C:\App Folder\Antigravity.exe" --require=preload.cjs`, true],
    [String.raw`"C:\App Folder\Antigravity.exe" --eval "console.log('fixture')"`, true],
    [String.raw`"C:\App Folder\Antigravity.exe" --input-type=module`, true],
    [String.raw`"C:\App Folder\Antigravity.exe" --ms-enable-electron-run-as-node helper.mjs`, true],
    [String.raw`"C:\App Folder\Antigravity.exe" -r preload.cjs`, true],
    [String.raw`"C:\App Folder\Antigravity.exe" -e "console.log('fixture')"`, true],
    [String.raw`"C:\App Folder\Antigravity.exe" --open-file foo.js`, false],
    [String.raw`"C:\App Folder\Antigravity.exe" --open-file "C:\folder --require=not-a-flag.js"`, false],
    [String.raw`"C:\App Folder\Antigravity.exe" foo.mjs`, false],
    [String.raw`"C:\App Folder\Antigravity.exe" --imported=not-a-node-option`, false],
    [String.raw`"C:\App Folder\Antigravity.exe" -- --eval`, false],
    [String.raw`"C:\App Folder\Antigravity.exe"`, false],
    ["", false],
  ];
  const script = "$ProgressPreference = 'SilentlyContinue'\n" + classifier + String.raw`
$cases = $env:BRIDGE_NODE_ROLE_CASES | ConvertFrom-Json
@($cases | ForEach-Object { Test-BridgeNodeHost ([string]$_) }) | ConvertTo-Json -Compress
`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, BRIDGE_NODE_ROLE_CASES: JSON.stringify(cases.map(([command]) => command)) },
    windowsHide: true, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.deepEqual(JSON.parse(output.replace(/^\uFEFF/, "").trim()), cases.map(([, expected]) => expected));
  assert.match(inventory, /nodeHost = Test-BridgeNodeHost/);
  await manager.dispose();
});

test("an app sidecar re-run through helper processes is not a second root or proof the app is open", async () => {
  // GUI 20 -> helper 500 -> cmd 501 -> the same executable in Node mode, with no telltale command-line flag.
  const gui = { ...nativeProcess(20, "claude", 900), ancestors: [900] };
  const sidecar = { ...nativeProcess(30, "claude", 501), ancestors: [501, 500, 20, 900] };
  const { manager, state } = mockManager({ processes: [gui, sidecar] });
  const open = await manager.list();
  assert.equal(open.claude.running, true);
  assert.deepEqual(open.claude.rootProcesses.map((item) => item.pid), [20]);
  // The main window closed; the orphaned sidecar keeps only ancestors that are not the app.
  state.processes = [{ ...sidecar, ancestors: [501, 500] }];
  const orphan = await manager.list();
  assert.deepEqual(orphan.claude.rootProcesses.map((item) => item.pid), [30], "an orphan is reported, not hidden");
  state.processes = [];
  assert.equal((await manager.list()).claude.running, false);
});
