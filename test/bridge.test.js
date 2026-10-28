import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const TEMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "codex-claude-bridge-test-"));
const WORKSPACE = path.join(TEMP_ROOT, "repository");
const NO_GIT_WORKSPACE = path.join(TEMP_ROOT, "no-git");
mkdirSync(path.join(WORKSPACE, ".git"), { recursive: true });
mkdirSync(NO_GIT_WORKSPACE);
const SERVER_PATH = path.resolve(TEST_DIRECTORY, "..", "src", "server.js");
const FAKE_CLAUDE_COMMAND = path.join(TEST_DIRECTORY, "fixtures", "fake-claude.cmd");

after(() => {
  const tempRoot = path.resolve(os.tmpdir());
  const target = path.resolve(TEMP_ROOT);
  const relative = path.relative(tempRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove a test directory outside the temp folder: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
});

test("server exposes the coordinator tools over MCP stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      AGENT_HUB_DATA_DIRECTORY: path.join(TEMP_ROOT, 'data'),
      AGENT_HUB_WORKSPACE: WORKSPACE,
      AGENT_HUB_CLAUDE_COMMAND: "codex-claude-bridge-test-missing-cli",
    },
  });
  const client = new Client({ name: "bridge-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, ["check_bridge", "delegate_to_claude"]);
  } finally {
    await client.close();
  }
});

test("status reports a missing Claude Code CLI without crashing the server", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      AGENT_HUB_DATA_DIRECTORY: path.join(TEMP_ROOT, 'data'),
      AGENT_HUB_WORKSPACE: WORKSPACE,
      AGENT_HUB_CLAUDE_COMMAND: "codex-claude-bridge-test-missing-cli",
    },
  });
  const client = new Client({ name: "bridge-status-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "check_bridge",
      arguments: {},
    });
    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

    assert.ok(text.includes(WORKSPACE));
    assert.match(text, /Claude Code CLI: unavailable/);
    assert.equal(response.isError, true);
  } finally {
    await client.close();
  }
});

test("server accepts a plain directory as its default workspace", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      AGENT_HUB_DATA_DIRECTORY: path.join(TEMP_ROOT, 'data'),
      AGENT_HUB_WORKSPACE: NO_GIT_WORKSPACE,
      AGENT_HUB_CLAUDE_COMMAND: "codex-claude-bridge-test-missing-cli",
    },
  });
  const client = new Client({ name: "bridge-no-default-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "check_bridge",
      arguments: {},
    });
    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

    assert.ok(text.includes(`Default workspace: ${NO_GIT_WORKSPACE}`));
    assert.equal(response.isError, true);

    const delegation = await client.callTool({
      name: "delegate_to_claude",
      arguments: {
        task: "Review this repository and return one concise finding.",
        mode: "review",
      },
    });
    const delegationText = delegation.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    assert.equal(delegation.isError, true);
    assert.doesNotMatch(delegationText, /No default workspace is configured/);
    assert.match(delegationText, /not found|ENOENT|missing-cli|failed/i);
  } finally {
    await client.close();
  }
});

test("delegation rejects a relative workspace path", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: {
      ...process.env,
      AGENT_HUB_DATA_DIRECTORY: path.join(TEMP_ROOT, 'data'),
      AGENT_HUB_WORKSPACE: WORKSPACE,
      AGENT_HUB_CLAUDE_COMMAND: "codex-claude-bridge-test-missing-cli",
    },
  });
  const client = new Client({ name: "bridge-workspace-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "delegate_to_claude",
      arguments: {
        task: "Review the current changes for one bug.",
        workspace: "relative-project",
        mode: "review",
      },
    });
    const text = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

    assert.equal(response.isError, true);
    assert.match(text, /workspace must be an absolute path/);
  } finally {
    await client.close();
  }
});

for (const mode of ["review", "implement"]) test(
  `${mode} delegation delivers a full multiline task through the Windows CLI`,
  { skip: process.platform !== "win32" },
  async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      env: {
        ...process.env,
      AGENT_HUB_DATA_DIRECTORY: path.join(TEMP_ROOT, 'data'),
        AGENT_HUB_WORKSPACE: WORKSPACE,
        AGENT_HUB_CLAUDE_COMMAND: FAKE_CLAUDE_COMMAND,
      },
    });
    const client = new Client({ name: "bridge-delegation-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const task = '請保留完整指令："quotes" & | < > %PATH% ^ \\path\r\n第二行\n'
        .padEnd(7900, "x") + "\nASSIGNMENT_END";
      const response = await client.callTool({
        name: "delegate_to_claude",
        arguments: {
          task,
          mode,
          max_turns: 1,
        },
      });
      const text = response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");

      assert.equal(response.isError, undefined);
      assert.match(text, /Claude Code completed/);
      assert.match(text, /fake delegated result/);
      const captured = JSON.parse(text.slice(text.indexOf("{")));
      assert.ok(captured.input.includes(`<assignment>\n\n${task}\n\n</assignment>`));
      assert.ok(captured.input.endsWith("</assignment>"));
      assert.equal(captured.args[0], "-p");
      assert.equal(captured.args[captured.args.indexOf("--input-format") + 1], "stream-json");
      assert.equal(captured.args[captured.args.indexOf("--output-format") + 1], "stream-json");
      assert.ok(captured.args.includes("--verbose"));
      assert.equal(captured.args[captured.args.indexOf("--max-turns") + 1], "1");
      assert.equal(captured.args[captured.args.indexOf("--permission-mode") + 1], mode === "review" ? "plan" : "bypassPermissions");
      if (mode === "review") assert.equal(captured.args[captured.args.indexOf("--tools") + 1], "Read,Glob,Grep");
      else { assert.ok(!captured.args.includes("--tools")); assert.ok(!captured.args.includes("--allowedTools")); }
      assert.ok(!captured.args.some(arg => arg.includes("ASSIGNMENT_END")));
      assert.ok(captured.args.includes("--disallowedTools"));
      assert.ok(captured.args.includes(mode === "review" ? "mcp__*" : "mcp__codex-claude-bridge__*"));
      if (mode === "review") {
        for (const tool of ["Edit", "Write", "NotebookEdit", "Bash"]) {
          assert.ok(captured.args.slice(captured.args.indexOf("--disallowedTools") + 1).includes(tool));
        }
      }
    } finally {
      await client.close();
    }
  },
);
