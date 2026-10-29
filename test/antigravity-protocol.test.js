import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAntigravityResult } from "../src/antigravity-protocol.js";

const final = (overrides = {}) => ({ event: "result", result: {
  conversation_id: "66666666-7777-4888-8999-000000000000", status: "SUCCESS", response: "真實回覆\n第二行", ...overrides,
} });
const stream = (...events) => events.map(event => JSON.stringify(event)).join("\n");
const failure = (stdout, options) => {
  let caught;
  try { parseAntigravityResult(stdout, options); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error, "The malformed or unsuccessful stream must fail.");
  for (const key of ["output", "usage", "stderr", "exitCode"]) assert.ok(Object.hasOwn(caught, key));
  return caught;
};

test("official init and step updates yield only the single successful final response", () => {
  const stdout = `\r\n${stream({ event: "init", conversation_id: "init-only" },
    { event: "step_update", response: "partial output must not become the final reply" },
    final({ usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 } }))}\n\n`;
  assert.deepEqual(parseAntigravityResult(stdout, { exitCode: 0, stderr: "diagnostic only" }), {
    output: "真實回覆\n第二行", conversationId: "66666666-7777-4888-8999-000000000000",
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, costUsd: null, turns: 1, models: [] },
  });
});

test("ERROR and WAITING results fail and retain final text, usage, diagnostics and process status", () => {
  for (const status of ["ERROR", "WAITING", "CANCELLED", undefined]) {
    const error = failure(stream(final({ status, response: "partial reply", error: { message: "Sign in required." },
      usage: { output_tokens: 4 } })), { exitCode: 0, stderr: "native diagnostic" });
    assert.match(error.message, /not SUCCESS/);
    assert.match(error.message, /Sign in required/);
    assert.equal(error.output, "partial reply");
    assert.equal(error.usage.outputTokens, 4);
    assert.equal(error.stderr, "native diagnostic");
    assert.equal(error.exitCode, 0);
  }
});

test("a successful final event cannot hide a nonzero or missing process exit", () => {
  for (const exitCode of [1, -1, null, "0"]) {
    const error = failure(stream(final()), { exitCode, stderr: "CLI failed after its final event" });
    assert.match(error.message, /CLI exited/);
    assert.equal(error.exitCode, exitCode);
    assert.equal(error.output, "真實回覆\n第二行");
  }
});

test("empty, partial and absent final streams never masquerade as replies", () => {
  for (const stdout of ["", "\r\n \n", stream({ event: "init" }), stream({ event: "step_update", response: "partial" })]) {
    const error = failure(stdout);
    assert.match(error.message, /exactly one final result/);
    assert.equal(error.output, "");
    assert.equal(error.usage, null);
  }
});

test("duplicate result events fail even when both claim success", () => {
  const error = failure(stream(final(), final({ response: "another final" })));
  assert.match(error.message, /received 2/);
});

test("the final result must terminate the stream apart from blank lines", () => {
  const error = failure(stream(final(), { event: "step_update", response: "late partial" }));
  assert.match(error.message, /after the final result/);
});

test("malformed nonempty NDJSON and non-event JSON are rejected rather than copied into replies", () => {
  for (const malformed of ["native diagnostic", "{not JSON}", "null", "[]", "42", '{"response":"fake reply"}']) {
    const error = failure(`${malformed}\n${stream(final())}`);
    assert.match(error.message, /Invalid stream-json/);
    assert.notEqual(error.output, malformed);
  }
  assert.match(failure(undefined).message, /must be text/);
});

test("unknown events and explicit errors cannot be hidden behind a success result", () => {
  assert.match(failure(stream({ event: "error", message: "quota exceeded" }, final())).message, /quota exceeded/);
  assert.match(failure(stream({ event: "unexpected" }, final())).message, /Unknown stream-json event/);
});

test("final result and response text must have the documented shapes", () => {
  for (const result of [undefined, null, [], "SUCCESS"]) {
    assert.match(failure(stream({ event: "result", result })).message, /malformed/);
  }
  for (const response of [undefined, null, {}, [], "", " \r\n"]) {
    assert.match(failure(stream(final({ response }))).message, /no response text/);
  }
});

for (const response of ["", "The file was written."]) test(`final permission denial rejects SUCCESS with ${response ? "nonempty" : "empty"} response`, () => {
  const error = failure(stream(final({ response, usage: { output_tokens: 3 },
    denied_actions: [{ action: "write_file", display_name: "WriteFile" }] })), { exitCode: 0, stderr: "headless tool auto-denied" });
  assert.match(error.message, /permission denial/);
  assert.match(error.message, /write_file \(WriteFile\)/);
  assert.match(error.message, /not completed/);
  assert.equal(error.output, response);
  assert.equal(error.usage.outputTokens, 3);
  assert.equal(error.stderr, "headless tool auto-denied");
  assert.equal(error.exitCode, 0);
});

test("malformed denied actions never turn an unverifiable permission outcome into success", () => {
  for (const denied_actions of [null, {}, "write_file", 1, [null], [[]], ["write_file"], [{}],
    [{ action: 1 }], [{ action: " " }], [{ action: "write_file", display_name: 5 }],
    [{ action: "write_file" }, {}]]) {
    const error = failure(stream(final({ denied_actions })));
    assert.match(error.message, /Malformed denied_actions/);
    assert.match(error.message, /permission status cannot be verified/);
  }
});

test("absent or empty denied actions allow a successful final even after a recovered tool error", () => {
  for (const denied_actions of [undefined, []]) {
    const stdout = stream({ event: "step_update", status: "ERROR", message: "Earlier tool failed; retry later succeeded." },
      final({ denied_actions }));
    assert.equal(parseAntigravityResult(stdout).output, "真實回覆\n第二行");
  }
});

test("missing or entirely invalid usage remains unknown instead of inventing zero tokens", () => {
  for (const usage of [undefined, null, {}, [], { input_tokens: -1, output_tokens: "5", cache_read_tokens: null },
    { input_tokens: Infinity, output_tokens: 1.5, cache_read_tokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(parseAntigravityResult(stream(final({ usage }))).usage, null);
  }
});

test("partial usage preserves unknown fields while reported zero remains a real measurement", () => {
  assert.deepEqual(parseAntigravityResult(stream(final({ usage: { input_tokens: 0, output_tokens: 5, cache_read_tokens: -2 } }))).usage, {
    inputTokens: 0, outputTokens: 5, cachedInputTokens: null, costUsd: null, turns: 1, models: [],
  });
  assert.deepEqual(parseAntigravityResult(stream(final({ usage: { cache_read_tokens: 2 } }))).usage, {
    inputTokens: null, outputTokens: null, cachedInputTokens: 2, costUsd: null, turns: 1, models: [],
  });
});

test("conversation identifiers stay optional and are not inferred from init or response text", () => {
  for (const conversation_id of [undefined, null, "", " ", 42]) {
    assert.equal(parseAntigravityResult(stream({ event: "init", conversation_id: "not-a-final-id" }, final({ conversation_id }))).conversationId, null);
  }
});
