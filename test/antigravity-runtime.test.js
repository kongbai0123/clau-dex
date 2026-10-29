import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createAgentRuntime } from "../src/agent-runtime.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(directory, "fixtures", "fake-antigravity-agent.js");
const codexFixture = path.join(directory, "fixtures", "fake-runtime-agent.js");
const root = mkdtempSync(path.join(os.tmpdir(), "bridge-antigravity-runtime-"));
const workspace = path.join(root, "workspace");
mkdirSync(workspace);
writeFileSync(path.join(workspace, "example.txt"), "Controlled test workspace.\n");
after(() => {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  rmSync(root, { recursive: true, force: true });
});

function createRuntime(scenario = "success", overrides = {}) {
  const captureFile = path.join(root, `${randomUUID()}.jsonl`);
  const missing = path.join(root, "not-installed", "must-not-dispatch-another-provider.exe");
  const runtime = createAgentRuntime({
    codexCommand: missing, claudeCommand: missing,
    antigravityCommand: { command: process.execPath, args: [fixture, scenario, captureFile] },
    credentialExists: async () => true, runtimeDirectory: path.join(root, "runtime"), retryDelayMs: 0, ...overrides,
  });
  const captures = () => existsSync(captureFile) ? readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const tasks = () => captures().filter(record => record.kind === "task");
  return { runtime, captureFile, captures, tasks };
}
const assignment = (extra = {}) => ({ workspace, task: "請執行這個受控測試。", mode: "implement", workflow: "antigravity", ...extra });
async function waitFor(condition, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail("Timed out waiting for the controlled Antigravity fixture.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

test("Antigravity probe verifies the headless contract without upgrading a credential marker to authentication", async () => {
  const { runtime, captures, tasks } = createRuntime();
  try {
    const status = await runtime.probeAgent("antigravity");
    assert.equal(status.available, true);
    assert.match(status.version, /1\.4\.9/);
    assert.equal(status.authenticated, null);
    assert.equal(status.credentialPresent, true);
    assert.equal(status.authSource, "credential-entry");
    assert.ok(captures().some(record => record.args.includes("--help")), "Availability must check supported headless flags.");
    assert.equal(tasks().length, 0);
    assert.deepEqual(runtime.activeProcesses(), []);
  } finally { await runtime.close(); }
});

for (const scenario of ["unsupported-help", "unsupported-mode"]) test(`a CLI with ${scenario} is not reported as a usable Antigravity task runner`, async () => {
  const { runtime, tasks } = createRuntime(scenario);
  try {
    const status = await runtime.probeAgent("antigravity");
    assert.equal(status.available, false);
    assert.equal(status.authenticated, null);
    assert.equal(status.credentialPresent, true);
    assert.match(status.error, /sandbox|headless|support|旗標/i);
    assert.equal(tasks().length, 0);
  } finally { await runtime.close(); }
});

test("single-agent Antigravity tasks retain attributed history, sandbox flags, final reply and usage", async () => {
  const { runtime, tasks } = createRuntime();
  const latest = '本輪請保持中文 "quotes" & | < > %PATH%\r\nLATEST_AG_REQUEST_END';
  const history = [{ role: "user", content: "先前使用者的需求。" }, { role: "antigravity", content: "先前的 Antigravity 回覆。" }];
  try {
    const result = await runtime.run(assignment({ task: latest, conversationContext: history }));
    assert.equal(result.output, "Antigravity 已完成驗證 ✓");
    assert.equal(result.stages.length, 1, "Antigravity alone must not dispatch to unavailable Codex or Claude.");
    const stage = result.stages[0];
    assert.equal(stage.agent, "antigravity");
    assert.equal(stage.role, "executor");
    assert.equal(stage.status, "completed");
    assert.match(stage.name, /Antigravity/);
    assert.equal(stage.usage.inputTokens, 121);
    assert.equal(stage.usage.cachedInputTokens, 47);
    assert.equal(stage.usage.outputTokens, 23);
    assert.equal(stage.usage.turns, 1);
    assert.equal(result.dispatch.steps[0].agent, "antigravity");
    assert.equal(result.dispatch.phase, "done");
    assert.equal(tasks().length, 1);
    const request = tasks()[0];
    assert.equal(request.lineCount, 1);
    assert.equal(request.envelope.event, "user");
    assert.equal(typeof request.envelope.message.content, "string");
    assert.equal(request.cwd, workspace);
    const prompt = request.envelope.message.content;
    assert.ok(prompt.includes(latest));
    assert.ok(prompt.includes(history[0].content));
    assert.ok(prompt.includes(history[1].content));
    const attributed = prompt.match(/<conversation-context>\n\n([\s\S]*?)\n\n<\/conversation-context>/);
    assert.ok(attributed, "Conversation history must remain attributed, distinct from the current assignment.");
    assert.deepEqual(JSON.parse(attributed[1]), history);
    assert.match(prompt, /Traditional Chinese/);
    assert.equal(request.args[request.args.indexOf("--input-format") + 1], "stream-json");
    assert.equal(request.args[request.args.indexOf("--output-format") + 1], "stream-json");
    assert.ok(request.args.includes("--print-timeout"));
    assert.ok(request.args.includes("--sandbox"));
    assert.equal(request.args[request.args.indexOf("--mode") + 1], "accept-edits");
    assert.ok(request.args.includes("--disable-slash-commands"));
    assert.ok(!request.args.some(arg => /dangerously|no-sandbox|disable-gpu-sandbox|in-process-gpu/.test(arg)));
    assert.ok(!request.args.some(arg => arg.includes("LATEST_AG_REQUEST_END")), "Task text belongs on stdin, not command arguments.");
    assert.deepEqual(runtime.activeProcesses(), []);
  } finally { await runtime.close(); }
});

for (const scenario of ["no-newline", "split-utf8"]) test(`Antigravity preserves a terminal result with ${scenario}`, async () => {
  const { runtime } = createRuntime(scenario);
  try { assert.equal((await runtime.run(assignment())).output, "Antigravity 已完成驗證 ✓"); }
  finally { await runtime.close(); }
});

for (const scenario of ["error", "empty", "nonzero", "missing-result", "malformed", "waiting", "duplicate-result"]) test(`Antigravity ${scenario} cannot be accepted as a successful task`, async () => {
  const { runtime, tasks } = createRuntime(scenario);
  try {
    await assert.rejects(runtime.run(assignment()), error => {
      assert.ok(error.stages.some(stage => stage.agent === "antigravity" && stage.status === "failed"));
      assert.ok(error.message.trim());
      if (scenario === "nonzero") assert.equal(error.exitCode, 7);
      return true;
    });
    assert.equal(tasks().length, 1);
    assert.deepEqual(runtime.activeProcesses(), []);
  } finally { await runtime.close(); }
});

for (const action of ["abort", "close", "timeout"]) test(`Antigravity ${action} cleans up its owned CLI and descendant`, async () => {
  const { runtime, tasks, captureFile } = createRuntime("hold", { timeoutMs: action === "timeout" ? 1500 : 10_000 });
  const controller = new AbortController();
  let failure;
  const running = runtime.run(assignment(), { signal: controller.signal }).catch(error => { failure = error; });
  try {
    await waitFor(() => existsSync(`${captureFile}.child`));
    const parentPid = tasks()[0].pid;
    const childPid = Number(readFileSync(`${captureFile}.child`, "utf8"));
    assert.ok(isAlive(parentPid)); assert.ok(isAlive(childPid));
    assert.ok(runtime.activeProcesses().some(entry => entry.pid === parentPid && entry.agent === "antigravity"));
    if (action === "abort") controller.abort();
    if (action === "close") await runtime.close();
    await running;
    assert.ok(failure, "The cancelled or timed-out task must reject.");
    if (action === "timeout") { assert.match(failure.message, /within 1500 ms/); assert.equal(failure.stages[0].status, "failed"); }
    else { assert.equal(failure.name, "AbortError"); assert.equal(failure.stages[0].status, "cancelled"); }
    await waitFor(() => !isAlive(parentPid) && !isAlive(childPid));
    assert.deepEqual(runtime.activeProcesses(), []);
  } finally { await runtime.close(); await running; }
});

test("Antigravity output overflow terminates the owned process tree", async () => {
  const { runtime, tasks, captureFile } = createRuntime("flood");
  try {
    await assert.rejects(runtime.run(assignment()), /output exceeded/);
    assert.equal(tasks().length, 1);
    const childPid = Number(readFileSync(`${captureFile}.child`, "utf8"));
    await waitFor(() => !isAlive(tasks()[0].pid) && !isAlive(childPid));
    assert.deepEqual(runtime.activeProcesses(), []);
  } finally { await runtime.close(); }
});

test("Antigravity cannot claim enforced read-only review mode", async () => {
  const { runtime, tasks } = createRuntime();
  try {
    await assert.rejects(runtime.run(assignment({ mode: "review" })), /Antigravity.*(?:review|read.only|唯讀)|(?:review|read.only|唯讀).*Antigravity/i);
    assert.equal(tasks().length, 0);
  } finally { await runtime.close(); }
});

for (const workflow of ["antigravity", "coordinated"]) for (const historical of [false, true]) test(`${workflow} with Antigravity rejects ${historical ? "historical" : "current"} images before any provider runs`, async () => {
  const { runtime, tasks } = createRuntime();
  const imagePath = path.join(root, `${randomUUID()}.png`);
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  writeFileSync(imagePath, bytes);
  const image = { id: randomUUID(), path: imagePath, name: "fixture.png", mimeType: "image/png", size: bytes.length };
  try {
    await assert.rejects(runtime.run(assignment({ workflow, ...(workflow === "coordinated" ? { participants: ["codex", "antigravity"] } : {}),
      ...(historical ? { conversationContext: [{ role: "user", content: "先前圖片", attachments: [image] }] } : { attachments: [image] }) })),
    /Antigravity.*(?:image|圖片)|(?:image|圖片).*Antigravity/i);
    assert.equal(tasks().length, 0);
    assert.deepEqual(runtime.activeProcesses(), []);
  } finally { await runtime.close(); }
});

test("saved coordinated execution routes the assigned step to Antigravity and review to Codex", async () => {
  const codexCapture = path.join(root, `${randomUUID()}-codex.jsonl`);
  const { runtime, tasks } = createRuntime("success", { codexCommand: { command: process.execPath, args: [codexFixture, "codex", "success", codexCapture] } });
  const step = { title: "Antigravity worker", instruction: "回答目前指派的受控步驟。", agent: "antigravity", status: "pending" };
  const dispatch = { version: 2, phase: "execute", forced: null, coordinator: "codex", participants: ["codex", "antigravity"],
    plan: { summary: "Bounded Antigravity execution", kind: "answer", acceptance: ["Assigned worker replies."], steps: [step] },
    steps: [step], exhausted: {}, handoffs: [], reviews: [], revisions: [], round: 0 };
  try {
    const result = await runtime.run(assignment({ workflow: "coordinated", participants: ["codex", "antigravity"], dispatch }));
    assert.deepEqual(result.stages.map(({ agent, role }) => [agent, role]), [["antigravity", "executor"], ["codex", "reviewer"]]);
    assert.equal(tasks().length, 1);
    assert.ok(tasks()[0].envelope.message.content.includes(step.instruction));
    const codex = readFileSync(codexCapture, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(codex.length, 1);
    assert.match(codex[0].input, /Antigravity 已完成驗證/);
    assert.equal(codex[0].args[codex[0].args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(result.dispatch.phase, "done");
  } finally { await runtime.close(); }
});
