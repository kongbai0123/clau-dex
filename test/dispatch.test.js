import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { classifyFailure, describeCoordination, lenientPlan, nextResumeAt, normalizeCoordinator, parseReview, pickAgent, validatePlan } from "../src/dispatch.js";
import { diffTrees, snapshotTree } from "../src/checkpoints.js";
import { createAgentRuntime } from "../src/agent-runtime.js";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "bridge-dispatch-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-runtime-agent.js");
const hour = 3_600_000;
const quota = (used, resetIn = hour) => ({ primary: { usedPercent: used, windowMinutes: 300, resetsAt: new Date(Date.now() + resetIn).toISOString() } });
let sequence = 0;

function gitRepo() {
  const directory = path.join(ROOT, `repo-${sequence++}`);
  mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: directory });
  writeFileSync(path.join(directory, "app.txt"), "v1\n");
  return directory;
}
function runtimeFor({ codex = "success", claude = "success", quotas = {} } = {}) {
  const captureFile = path.join(ROOT, `capture-${sequence++}.jsonl`);
  const command = (agent, scenario) => ({ command: process.execPath, args: [FIXTURE, agent, scenario, captureFile] });
  const runtime = createAgentRuntime({ codexCommand: command("codex", codex), claudeCommand: command("claude", claude),
    runtimeDirectory: path.join(ROOT, "runtime"), getQuotas: () => quotas, retryDelayMs: 0 });
  const captures = () => existsSync(captureFile) ? readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { runtime, captures };
}

test("roles come from the coordinator choice, not from remaining quota; quota only hands a role over when it runs out", () => {
  // Codex has only 3% left but is still usable, so it still coordinates.
  assert.equal(pickAgent({ preferred: "codex", quotas: { codex: quota(97), claude: quota(20) } }).agent, "codex");
  assert.equal(pickAgent({ preferred: "claude", quotas: { codex: quota(10), claude: quota(85) } }).agent, "claude");
  assert.equal(pickAgent({ preferred: "codex", quotas: { codex: quota(100), claude: quota(30) } }).agent, "claude");
  assert.equal(pickAgent({ preferred: "codex", exhausted: { codex: { until: null } } }).agent, "claude");
  assert.equal(pickAgent({ preferred: "codex", quotas: { codex: quota(100), claude: quota(100) } }).agent, null);
  // A lapsed window counts as fresh; unknown quota is usable; unknown preferences fall back to the default coordinator.
  assert.equal(pickAgent({ preferred: "codex", quotas: { codex: quota(100, -1000) } }).agent, "codex");
  assert.equal(pickAgent({}).agent, "codex");
  // A forced single agent never spills over.
  assert.equal(pickAgent({ preferred: "codex", forced: "claude", quotas: { claude: quota(100) } }).agent, null);
  assert.equal(describeCoordination("claude"), "Claude 統籌與審查 · 依任務指派執行");
  assert.equal(describeCoordination("codex", { codex: { available: false }, claude: { available: true } }), "Codex 額度已用盡，改由 Claude 統籌");
  assert.equal(normalizeCoordinator("unknown"), "codex");
});

test("plans carry checkable acceptance criteria and a per-step agent; reviews are read leniently", () => {
  const plan = validatePlan({ summary: "s", kind: "change", acceptance: " one ", steps: [{ title: "a", instruction: "b" }, { title: "c", instruction: "d", agent: "codex" }] }, { coordinator: "codex" });
  assert.deepEqual(plan.acceptance, ["one"], "a saved single acceptance string becomes one criterion");
  assert.deepEqual(plan.steps.map((step) => step.agent), ["claude", "codex"], "unassigned steps go to the non-coordinator");
  assert.equal(lenientPlan("not json", "do it", { coordinator: "claude" }).steps[0].agent, "codex");
  assert.deepEqual(parseReview("plain words"), { verdict: "pass", criteria: [], issues: [], reply: "plain words", fallback: true });
  assert.equal(parseReview("{broken").reply, "", "unreadable JSON is not shown as a reply");
  assert.equal(parseReview(JSON.stringify({ verdict: "revise", criteria: [], issues: [], reply: "" })).verdict, "pass", "revise without issues cannot loop");
  const review = parseReview(`前言 ${JSON.stringify({ verdict: "revise", criteria: [{ criterion: "c", met: false, note: "n" }], issues: [{ step: 9, problem: "p", fix: "f" }], reply: "" })}`, 2);
  assert.equal(review.verdict, "revise");
  assert.equal(review.issues[0].step, 0, "an out-of-range step becomes a whole-result issue");
});

test("only real quota exhaustion hands off; auth and transient errors do not", () => {
  assert.equal(classifyFailure(new Error("You've hit your usage limit. Try again at 6pm.")), "quota");
  assert.equal(classifyFailure(new Error("Claude AI usage limit reached|1791800000")), "quota");
  assert.equal(classifyFailure(new Error("429 Too Many Requests")), "transient");
  assert.equal(classifyFailure(new Error("Not logged in. Please run login first.")), "auth");
  assert.equal(classifyFailure(new Error("TypeError: something broke")), "other");
  const abort = new Error("stop"); abort.name = "AbortError";
  assert.equal(classifyFailure(abort), "cancelled");
  const soon = new Date(Date.now() + hour).toISOString();
  assert.equal(nextResumeAt({ codex: { until: soon }, claude: { until: new Date(Date.now() + 5 * hour).toISOString() } }), new Date(Date.parse(soon) + 60_000).toISOString());
  assert.ok(Date.parse(nextResumeAt({ codex: { until: null } })) > Date.now());
});

test("Claude planning output is parsed leniently and falls back to one step", () => {
  const plan = lenientPlan("好的：\n```json\n{\"summary\":\"s\",\"kind\":\"change\",\"steps\":[{\"title\":\"a\",\"instruction\":\"b\"}],\"acceptance\":[\"c\"]}\n```", "req");
  assert.equal(plan.steps[0].instruction, "b");
  assert.deepEqual(lenientPlan("not json", "do it").steps, [{ title: "處理需求", instruction: "do it", agent: "claude" }]);
});

test("checkpoints capture tracked and untracked files without touching the repository, even without commits", async () => {
  const repo = gitRepo();
  const before = await snapshotTree(repo);
  assert.match(before, /^[0-9a-f]{40,64}$/);
  writeFileSync(path.join(repo, "app.txt"), "v2\n");
  writeFileSync(path.join(repo, "new.txt"), "added\n");
  const after = await snapshotTree(repo);
  const diff = await diffTrees(repo, before, after);
  assert.match(diff, /app\.txt/);
  assert.match(diff, /new\.txt/);
  assert.match(diff, /\+v2/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).includes("?? new.txt"), true, "the real index is untouched");
  assert.equal(await snapshotTree(path.join(ROOT)), null, "outside Git there is no checkpoint, and no error");
});

test("Codex at 3% still coordinates: Codex plans and reviews, the assigned Claude executes", async () => {
  const { runtime, captures } = runtimeFor({ quotas: { codex: quota(97), claude: quota(20) } });
  try {
    const result = await runtime.run({ workspace: gitRepo(), task: "Review this.", mode: "review", workflow: "coordinated" });
    assert.deepEqual(result.stages.map((stage) => [stage.agent, stage.role]), [["codex", "planner"], ["claude", "executor"], ["codex", "reviewer"]]);
    assert.match(result.stages[0].note, /Codex 統籌與審查/);
    assert.deepEqual(captures().map((call) => call.agent), ["codex", "claude", "codex"]);
    assert.equal(result.output, "Codex 審查完成，交付結果。");
    assert.deepEqual(result.dispatch.reviews.map((review) => review.verdict), ["pass"]);
  } finally { await runtime.close(); }
});

test("a Claude coordinator plans and reviews while the step it assigned runs on Codex", async () => {
  const { runtime } = runtimeFor({ quotas: { codex: quota(10), claude: quota(85) } });
  try {
    const result = await runtime.run({ workspace: gitRepo(), task: "Review this.", mode: "review", workflow: "coordinated", coordinator: "claude" });
    assert.deepEqual(result.stages.map((stage) => [stage.agent, stage.role]), [["claude", "planner"], ["codex", "executor"], ["claude", "reviewer"]]);
    assert.equal(result.dispatch.plan.summary, "Claude 規劃");
    assert.equal(result.dispatch.coordinator, "claude");
    assert.equal(result.output, "Claude 審查完成，交付結果。");
  } finally { await runtime.close(); }
});

test("a failed review returns the work to its executor with the issues, then the next review delivers", async () => {
  const { runtime, captures } = runtimeFor({ codex: "revise-once" });
  try {
    const result = await runtime.run({ workspace: gitRepo(), task: "Implement it.", mode: "implement", workflow: "coordinated" });
    assert.deepEqual(result.stages.map((stage) => [stage.agent, stage.role]),
      [["codex", "planner"], ["claude", "executor"], ["codex", "reviewer"], ["claude", "reviser"], ["codex", "reviewer"]]);
    assert.match(result.stages[2].output, /審查未通過，退回修正（第 1\/2 輪）[\s\S]*Missing detail 1/);
    const calls = captures();
    assert.match(calls[3].input, /returned the work for revision \(round 1 of at most 2\)/);
    assert.match(calls[3].input, /Missing detail 1/);
    assert.match(calls[4].input, /Earlier review rounds:[\s\S]*Missing detail 1/);
    assert.match(calls[4].input, /<claude-revision round="1">/);
    assert.equal(result.output, "Codex 審查完成，交付結果。");
    assert.deepEqual(result.dispatch.reviews.map((review) => review.verdict), ["revise", "pass"]);
    assert.equal(result.dispatch.phase, "done");
  } finally { await runtime.close(); }
});

test("an executor running out during a revision hands the fixes to the other agent with its partial work", async () => {
  const { runtime, captures } = runtimeFor({ codex: "revise-once", claude: "limit-on-2" });
  try {
    const result = await runtime.run({ workspace: gitRepo(), task: "Implement it.", mode: "implement", workflow: "coordinated" });
    assert.deepEqual(result.stages.map((stage) => [stage.agent, stage.role, stage.status]), [["codex", "planner", "completed"], ["claude", "executor", "completed"],
      ["codex", "reviewer", "completed"], ["claude", "reviser", "handoff"], ["codex", "reviser", "completed"], ["codex", "reviewer", "completed"]]);
    assert.match(result.stages[4].note, /Claude 額度用盡，由 Codex 接手第 1 輪修正/);
    assert.match(captures()[4].input, /HANDOFF: the previous executor \(Claude\)/);
    assert.match(captures()[4].input, /Missing detail 1/);
    assert.equal(result.dispatch.phase, "done");
  } finally { await runtime.close(); }
});

test("revision rounds are capped; the last review delivers honestly instead of looping", async () => {
  const { runtime, captures } = runtimeFor({ codex: "revise-always" });
  try {
    const result = await runtime.run({ workspace: gitRepo(), task: "Implement it.", mode: "implement", workflow: "coordinated" });
    assert.deepEqual(result.stages.map((stage) => stage.role), ["planner", "executor", "reviewer", "reviser", "reviewer", "reviser", "reviewer"]);
    assert.match(captures().at(-1).input, /No revision rounds remain/);
    assert.equal(result.output, "Codex 審查完成，交付結果。");
    assert.equal(result.dispatch.round, 2);
  } finally { await runtime.close(); }
});

test("a run saved by the quota-ranked version resumes from its verify phase as a review", async () => {
  const { runtime, captures } = runtimeFor();
  try {
    const result = await runtime.run({ id: "legacy", workspace: gitRepo(), task: "Review.", mode: "review", workflow: "coordinated", stages: [],
      dispatch: { version: 1, phase: "verify", forced: null, plan: { summary: "s", kind: "review", acceptance: "Done.", steps: [{ title: "t", instruction: "i" }] },
        steps: [{ title: "t", instruction: "i", status: "done", agent: "claude", output: "old report" }], executor: "claude", exhausted: {}, handoffs: [] } });
    assert.deepEqual(captures().map((call) => call.agent), ["codex"]);
    assert.match(captures()[0].input, /1\. Done\./);
    assert.match(captures()[0].input, /old report/);
    assert.equal(result.dispatch.phase, "done");
  } finally { await runtime.close(); }
});

test("executor running out mid-step hands off with its partial changes; the other agent finishes and self-reviews", async () => {
  const repo = gitRepo();
  const { runtime, captures } = runtimeFor({ claude: "write-limit" });
  const events = [];
  try {
    const result = await runtime.run({ workspace: repo, task: "Implement it.", mode: "implement", workflow: "coordinated" }, { onProgress: (event) => events.push(event) });
    assert.deepEqual(result.stages.map((stage) => [stage.agent, stage.status]), [["codex", "completed"], ["claude", "handoff"], ["codex", "completed"], ["codex", "completed"]]);
    assert.match(result.stages[2].note, /Claude 額度用盡，由 Codex 接手執行/);
    assert.match(result.stages[3].note, /自我審查/);
    const handoffCall = captures()[2];
    assert.equal(handoffCall.agent, "codex");
    assert.match(handoffCall.input, /HANDOFF: the previous executor \(Claude\) stopped/);
    assert.match(handoffCall.input, /partial\.txt/, "the receiver sees the partial work");
    assert.match(captures()[3].input, /review your own work critically/);
    assert.ok(events.some((event) => event.type === "dispatch" && event.dispatch.handoffs.length === 1));
    assert.equal(result.dispatch.phase, "done");
  } finally { await runtime.close(); }
});

test("when both run out the run pauses with its checkpoint, and a resume continues without redoing finished work", async () => {
  const repo = gitRepo();
  const first = runtimeFor({ codex: "limit-on-2", claude: "limit" });
  let paused;
  try {
    await assert.rejects(first.runtime.run({ id: "pause", workspace: repo, task: "Implement it.", mode: "implement", workflow: "coordinated" }), (error) => {
      paused = error;
      return error.code === "QUOTA_PAUSED" && /額度已用盡/.test(error.message) && /usage limit/.test(error.message);
    });
    assert.equal(paused.dispatch.phase, "execute");
    assert.equal(paused.dispatch.steps[0].status, "pending");
    assert.deepEqual(Object.keys(paused.dispatch.exhausted).sort(), ["claude", "codex"]);
    assert.ok(Date.parse(paused.resumeAt) > Date.now());
  } finally { await first.runtime.close(); }

  const second = runtimeFor();
  try {
    const result = await second.runtime.run({ id: "pause", workspace: repo, task: "Implement it.", mode: "implement", workflow: "coordinated",
      dispatch: paused.dispatch, stages: paused.stages, resumeNotes: [{ at: new Date().toISOString(), text: "請繼續完成" }] });
    const calls = second.captures();
    assert.ok(!calls.some((call) => call.input.includes("You are the coordinator")), "planning is not repeated");
    assert.match(calls[0].input, /HANDOFF/);
    assert.match(calls[0].input, /請繼續完成/, "the user's resume words reach the agent");
    assert.equal(result.dispatch.phase, "done");
    assert.ok(result.stages.length > paused.stages.length, "earlier stages are kept");
  } finally { await second.runtime.close(); }
});

test("auth failures fail normally instead of handing off", async () => {
  const { runtime, captures } = runtimeFor({ claude: "auth-error" });
  try {
    await assert.rejects(runtime.run({ workspace: gitRepo(), task: "Review.", mode: "review", workflow: "coordinated" }), /Not logged in/);
    assert.deepEqual(captures().map((call) => call.agent), ["codex", "claude"]);
  } finally { await runtime.close(); }
});

test("a forced single agent pauses instead of spilling over to the other", async () => {
  const { runtime, captures } = runtimeFor({ claude: "limit" });
  try {
    await assert.rejects(runtime.run({ workspace: gitRepo(), task: "Review.", mode: "review", workflow: "claude" }), (error) => error.code === "QUOTA_PAUSED" && /^Claude 額度已用盡/.test(error.message));
    assert.ok(captures().every((call) => call.agent === "claude"));
  } finally { await runtime.close(); }
});
