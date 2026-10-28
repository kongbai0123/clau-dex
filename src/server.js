import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentRuntime } from "./agent-runtime.js";
import { createTaskStore } from "./task-store.js";
import { createTaskManager } from "./task-manager.js";
import { createMcpBridge } from "./mcp-bridge.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = process.env.AGENT_HUB_DATA_DIRECTORY || path.join(projectRoot, ".bridge");
const runtime = createAgentRuntime({ runtimeDirectory: path.join(dataDirectory, "runtime") });
const store = createTaskStore(dataDirectory);
const taskManager = createTaskManager({ store, runtime });
const server = createMcpBridge({ runtime, taskManager, workspaceHint: process.env.AGENT_HUB_WORKSPACE || projectRoot });
const transport = new StdioServerTransport();
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await taskManager.shutdown();
  await server.close();
}
process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
process.stdin.once("end", () => shutdown().catch(() => {}));
process.stdout.on("error", error => { if (error.code === "EPIPE") shutdown().catch(() => {}); });
await server.connect(transport);
