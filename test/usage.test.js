import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { readCodexUsage, createClaudeUsageReader } from "../src/usage-monitor.js";
import { claudeUsage, codexUsage } from "../src/agent-runtime.js";

const root = mkdtempSync(path.join(os.tmpdir(), "bridge-usage-"));
after(() => rmSync(root, { recursive: true, force: true }));
const line = (value) => `${JSON.stringify(value)}\n`;

test("Codex quota comes from the newest rollout token_count event", async () => {
  const home = path.join(root, "codex");
  const now = Date.now();
  const day = new Date(now);
  const directory = path.join(home, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
  mkdirSync(directory, { recursive: true });
  const observed = new Date(now - 60_000).toISOString();
  writeFileSync(path.join(directory, "rollout-a.jsonl"), [
    line({ timestamp: observed, type: "session_meta", payload: {} }),
    "not json\n",
    line({ timestamp: observed, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 2000, output_tokens: 300 } },
      rate_limits: { primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 86400 } } } }),
  ].join(""));
  // A later event for another limit pool with empty windows must not hide the real quota.
  writeFileSync(path.join(directory, "rollout-b.jsonl"), [
    line({ timestamp: new Date(now - 30_000).toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 99, window_minutes: 300, resets_at: Math.floor(now / 1000) + 600 }, secondary: { used_percent: 16, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 86400 } } } }),
    line({ timestamp: new Date(now - 20_000).toISOString(), type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "premium", primary: null, secondary: null } } }),
  ].join(""));
  writeFileSync(path.join(directory, "other.jsonl"), line({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 99 } } } }));
  const result = await readCodexUsage({ codexHome: home, now });
  assert.equal(result.quota.primary.usedPercent, 99);
  assert.equal(result.quota.secondary.usedPercent, 16);
  assert.equal(result.quota.mainPool, true);
  assert.deepEqual(result.today, { inputTokens: 5000, cachedInputTokens: 2000, outputTokens: 300, sessions: 1 });
  // resets_in_seconds (older format) is converted relative to the event time.
  const older = await readCodexUsage({ codexHome: home, now });
  assert.ok(older.quota.primary.resetsAt);
  rmSync(path.join(directory, "rollout-b.jsonl"));
  const single = await readCodexUsage({ codexHome: home, now });
  assert.equal(single.quota.primary.usedPercent, 42.5);
  assert.equal(single.quota.primary.resetsAt, new Date(Date.parse(observed) + 3_600_000).toISOString());
  assert.equal(Date.parse(single.quota.secondary.resetsAt), (Math.floor(now / 1000) + 86400) * 1000);
  assert.deepEqual(await readCodexUsage({ codexHome: path.join(root, "missing"), now }), { found: false, quota: null, today: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, sessions: 0 } });
});

test("Claude transcripts are read incrementally, deduplicated and bucketed by time", async () => {
  const home = path.join(root, "claude");
  const project = path.join(home, "projects", "C--repo");
  mkdirSync(project, { recursive: true });
  const file = path.join(project, "session.jsonl");
  const now = Date.now();
  const assistant = (id, minutesAgo, output) => line({ type: "assistant", timestamp: new Date(now - minutesAgo * 60_000).toISOString(), requestId: `req-${id}`,
    message: { id: `msg-${id}`, model: "claude-test", usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: output } } });
  writeFileSync(file, assistant("a", 1, 50) + assistant("a", 1, 50) + line({ type: "user", timestamp: new Date(now).toISOString() }));
  const read = createClaudeUsageReader({ claudeHome: home });
  let result = await read({ now });
  assert.equal(result.recent5h.messages, 1);
  assert.equal(result.recent5h.outputTokens, 50);
  assert.equal(result.recent5h.inputTokens, 110);
  assert.equal(result.recent5h.cachedInputTokens, 100);
  appendFileSync(file, assistant("b", 2, 7));
  result = await read({ now });
  assert.equal(result.recent5h.messages, 2);
  assert.equal(result.recent5h.outputTokens, 57);
  assert.equal(result.hourly.length, 24);
  assert.equal(result.hourly.reduce((sum, hour) => sum + hour.outputTokens, 0), result.today.outputTokens);
});

test("CLI usage parsers normalize Claude results and sum Codex turns", () => {
  assert.deepEqual(claudeUsage({ usage: { input_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2, output_tokens: 9 }, total_cost_usd: 0.5, num_turns: 2, modelUsage: { m: {} } }),
    { inputTokens: 12, cachedInputTokens: 7, outputTokens: 9, costUsd: 0.5, turns: 2, models: ["m"] });
  assert.equal(claudeUsage({ result: "x" }), null);
  assert.deepEqual(codexUsage([{ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }, { type: "turn.completed", usage: { input_tokens: 5, output_tokens: -1 } }]),
    { inputTokens: 15, cachedInputTokens: 4, outputTokens: 2, costUsd: null, turns: 2, models: [] });
  assert.equal(codexUsage([{ type: "turn.completed" }]), null);
});
