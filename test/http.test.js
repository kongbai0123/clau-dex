import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTaskStore } from "../src/task-store.js";
import { createTaskManager } from "../src/task-manager.js";
import { createHttpBridge } from "../src/http-bridge.js";
import { createDesktopServices } from "../src/desktop/services.js";

const root = mkdtempSync(path.join(os.tmpdir(), "bridge-http-"));
const workspace = path.join(root, "repository");
mkdirSync(path.join(workspace, ".git"), { recursive: true });
after(() => {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe test cleanup path");
  rmSync(root, { recursive: true, force: true });
});
const agent = { available: true, authenticated: true, version: "test" };
function runtime() { return { probe: async () => ({ codex: agent, claude: agent }), run: async () => ({ output: "BRIDGE_READY", stages: [], warnings: [] }), close: async () => {}, activeProcesses: () => [] }; }
function fixture(name, fake = runtime()) {
  const store = createTaskStore(path.join(root, name));
  const manager = createTaskManager({ store, runtime: fake });
  const bridge = createHttpBridge({ runtime: fake, taskManager: manager, port: 0 });
  return { store, manager, bridge };
}

test("local HTTP MCP lists tools and records a real protocol delegation", async () => {
  const { store, manager, bridge } = fixture("protocol");
  const status = await bridge.start();
  const client = new Client({ name: "http-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(status.url)));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ["check_bridge", "delegate_to_claude"]);
    const result = await client.callTool({ name: "delegate_to_claude", arguments: { workspace, task: "Connectivity check: return BRIDGE_READY.", mode: "review" } });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /BRIDGE_READY/);
    assert.equal(store.list()[0].source, "mcp");
    assert.equal(store.list()[0].status, "completed");
  } finally { await client.close(); await bridge.stop(); await manager.shutdown(); }
  await assert.rejects(fetch(status.url.replace("/mcp", "/health")));
});

test("HTTP bridge rejects remote browser origins and excessive input", async () => {
  const { manager, bridge } = fixture("request-limits");
  const { url } = await bridge.start();
  try {
    const foreign = await fetch(url, { method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(foreign.status, 403);
    const huge = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(70000) });
    assert.equal(huge.status, 413);
  } finally { await bridge.stop(); await manager.shutdown(); }
});

test("concurrent start calls share one listener and stop wins over pending startup", async () => {
  const { manager, bridge } = fixture("start-stop");
  const a = bridge.start(); const b = bridge.start();
  const stop = bridge.stop();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.url, second.url);
  await stop;
  assert.equal(bridge.getStatus().state, "stopped");
  await assert.rejects(fetch(first.url.replace("/mcp", "/health")));
  await manager.shutdown();
});

test("stopping HTTP cancels and awaits its running MCP task", async () => {
  let announce; const began = new Promise(resolve => { announce = resolve; });
  const fake = runtime();
  fake.run = async (_task, { signal }) => { announce(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); };
  const { store, manager, bridge } = fixture("stop-task", fake);
  const { url } = await bridge.start();
  const client = new Client({ name: "cancel-http-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = client.callTool({ name: "delegate_to_claude", arguments: { workspace, task: "Wait until the manager cancels this task.", mode: "review" } }).catch(error => error);
  await began;
  await bridge.stop();
  assert.equal(store.list()[0].status, "cancelled");
  await call; await client.close(); await manager.shutdown();
});

test("desktop shutdown stops its listener and applies native app shutdown preference", async () => {
  for (const closeLaunchedApps of [false, true]) {
    let closed = 0; let disposed = 0;
    const apps = { list: async () => ({}), closeOwned: async () => { closed++; return {}; }, dispose: async () => { disposed++; } };
    const services = createDesktopServices({ projectRoot: workspace, dataDirectory: path.join(root, `desktop-${closeLaunchedApps}`), runtime: runtime(), appManager: apps, port: 0 });
    const started = await services.start();
    services.updateSettings({ closeLaunchedApps });
    await services.shutdown(); await services.shutdown();
    assert.equal(closed, closeLaunchedApps ? 1 : 0);
    assert.equal(disposed, 1);
    assert.equal(services.snapshot().bridge.state, "stopped");
    await assert.rejects(fetch(started.bridge.url.replace("/mcp", "/health")));
  }
});
