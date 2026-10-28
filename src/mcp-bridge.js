import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveWorkspaceDirectory } from "./task-store.js";
import { EFFORT_LEVELS } from "./effort.js";

function textResult(text, isError = false) {
  const clipped = text.length > 60000 ? `${text.slice(0, 60000)}\n[Output truncated.]` : text;
  return { content: [{ type: "text", text: clipped }], ...(isError ? { isError: true } : {}) };
}

export function createMcpBridge({ runtime, taskManager, workspaceHint, onTask = () => {}, onTaskFinished = () => {} }) {
  let defaultWorkspace = null;
  try { if (workspaceHint) defaultWorkspace = resolveWorkspaceDirectory(workspaceHint); } catch {}
  const server = new McpServer({ name: "codex-claude-bridge", version: "0.2.0" }, {
    instructions: "Codex coordinates; delegate a task or read-only review to Claude. Pass the current absolute working folder in workspace; Git is optional and user-requested target paths can be outside that folder. The desktop manager displays task progress and owns service lifetime.",
  });
  server.registerTool("check_bridge", { title: "Check Codex–Claude bridge", description: "Check Claude Code availability and authentication in the local manager.", inputSchema: {} }, async (_input, extra) => {
    try {
      const { claude } = await runtime.probe({ signal: extra.signal });
      return textResult([
        defaultWorkspace ? `Default workspace: ${defaultWorkspace}` : "Default workspace: not configured; pass workspace when delegating.",
        `Claude Code CLI: ${claude.available ? "available" : "unavailable"}`,
        `Claude Code version: ${claude.version || "unknown"}`,
        `Claude authentication: ${claude.authenticated ? "signed in" : "not signed in"}`,
        ...(claude.error ? [claude.error] : []),
      ].join("\n"), !claude.available);
    } catch (error) { return textResult(`Claude Code CLI: unavailable\n${error.message}`, true); }
  });
  server.registerTool("delegate_to_claude", {
    title: "Delegate a task to Claude Code",
    description: "Run a scoped Claude implementation or read-only review. The desktop manager records progress and results; Codex handles integration.",
    inputSchema: {
      task: z.string().min(10).max(8000),
      workspace: z.string().min(1).max(2000).optional().describe("Absolute path to a local working directory. A Git repository is optional; honor user-requested target paths."),
      mode: z.enum(["implement", "review"]).default("implement"),
      max_turns: z.number().int().min(1).max(12).optional(),
      effort: z.enum(EFFORT_LEVELS.claude).optional().describe("Claude Code reasoning effort. Omit or use auto for the CLI default; use higher levels only for hard tasks."),
    },
  }, async ({ task, workspace, mode, max_turns, effort }, extra) => {
    let job;
    const cancel = () => { if (job) taskManager.cancel(job.id).catch(() => {}); };
    try {
      if (!workspace && !defaultWorkspace) throw new Error("No default workspace is configured. Pass workspace as an absolute path to a local directory.");
      job = taskManager.submit({ task, workspace: workspace || defaultWorkspace, mode, workflow: "claude", max_turns, effort: effort ? { claude: effort } : undefined, source: "mcp" });
      onTask(job.id);
      extra.signal?.addEventListener("abort", cancel, { once: true });
      if (extra.signal?.aborted) cancel();
      const result = await taskManager.wait(job.id);
      const succeeded = result.status === "completed";
      return textResult([
        `Claude Code ${succeeded ? "completed" : result.status}.`, `Mode: ${mode}`, `Workspace: ${result.workspace}`, "",
        result.output || result.error || "Claude Code returned no text.",
        ...(result.warnings?.length ? ["", "Claude Code warnings:", ...result.warnings] : []),
      ].join("\n"), !succeeded);
    } catch (error) { return textResult(`Could not delegate to Claude Code.\n${error.message}`, true); }
    finally { extra.signal?.removeEventListener("abort", cancel); if (job) onTaskFinished(job.id); }
  });
  return server;
}
