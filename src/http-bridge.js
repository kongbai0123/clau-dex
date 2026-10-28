import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpBridge } from "./mcp-bridge.js";

export function createHttpBridge({ runtime, taskManager, workspaceHint, host = "127.0.0.1", port = 47931, onChange = () => {} }) {
  let listener = null;
  let stopping = null;
  let starting = null;
  const connections = new Set();
  const tasks = new Set();
  let status = { state: "stopped", pid: null, tools: ["check_bridge", "delegate_to_claude"], url: `http://${host}:${port}/mcp`, error: "" };
  const publish = changes => { status = { ...status, ...changes }; onChange(); };
  async function startListener() {
    if (stopping) await stopping;
    if (listener) return status;
    publish({ state: "starting", error: "" });
    const server = http.createServer(async (req, res) => {
      const origin = `http://${host}:${server.address()?.port}`;
      if (req.headers.host !== `${host}:${server.address()?.port}` || (req.headers.origin && req.headers.origin !== origin)) {
        res.writeHead(403); res.end("Forbidden origin"); return;
      }
      if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ ready: status.state === "running" })); return;
      }
      if (req.url !== "/mcp") { res.writeHead(404); res.end(); return; }
      if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
      if (status.state !== "running" || taskManager.shuttingDown) { res.writeHead(503); res.end("Manager is shutting down"); return; }
      let connection;
      try {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 65536) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
        if (status.state !== "running" || taskManager.shuttingDown) { res.writeHead(503); res.end("Manager is shutting down"); return; }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        const mcp = createMcpBridge({ runtime, taskManager, workspaceHint, onTask: id => {
          tasks.add(id);
          if (status.state !== "running") taskManager.cancel(id).catch(() => {});
        }, onTaskFinished: id => tasks.delete(id) });
        connection = { transport, mcp };
        connections.add(connection);
        res.on("close", () => { connections.delete(connection); mcp.close().catch(() => {}); });
        await mcp.connect(transport);
        if (status.state !== "running" || taskManager.shuttingDown) {
          await mcp.close(); connections.delete(connection);
          if (!res.destroyed && !res.writableEnded) { res.writeHead(503); res.end("Manager is shutting down"); }
          return;
        }
        await transport.handleRequest(req, res, body);
      } catch (error) {
        if (connection) { connections.delete(connection); await connection.mcp.close().catch(() => {}); }
        if (!res.destroyed && !res.headersSent) res.writeHead(400, { "Content-Type": "application/json" });
        if (!res.destroyed && !res.writableEnded) res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Invalid local bridge request" }, id: null }));
      }
    });
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
      listener = server;
      const actualPort = server.address().port;
      publish({ state: "running", pid: process.pid, url: `http://${host}:${actualPort}/mcp`, error: "" });
      return status;
    } catch (error) {
      server.close(); publish({ state: "error", pid: null, error: error.code === "EADDRINUSE" ? `本機連接埠 ${port} 已被占用，請先關閉另一個管理器。` : error.message }); throw error;
    }
  }
  function start() {
    if (starting) return starting;
    starting = startListener().finally(() => { starting = null; });
    return starting;
  }
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (starting) await starting.catch(() => {});
      const server = listener; listener = null;
      publish({ state: "stopped", pid: null });
      const listenerClosed = server ? new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) : Promise.resolve();
      await Promise.allSettled([...connections].map(connection => connection.mcp.close()));
      while (tasks.size) {
        const pending = [...tasks];
        await Promise.allSettled(pending.map(id => taskManager.cancel(id)));
        for (const id of pending) tasks.delete(id);
      }
      connections.clear();
      await listenerClosed;
      return status;
    })();
    try { await stopping; } finally { stopping = null; }
    return status;
  }
  return { start, stop, getStatus: () => ({ ...status }) };
}
