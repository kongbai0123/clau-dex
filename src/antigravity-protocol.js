const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function resultUsage(value) {
  if (!record(value)) return null;
  const inputTokens = tokenCount(value.input_tokens);
  const outputTokens = tokenCount(value.output_tokens);
  const cachedInputTokens = tokenCount(value.cache_read_tokens);
  if ([inputTokens, outputTokens, cachedInputTokens].every(value => value === null)) return null;
  return { inputTokens, outputTokens, cachedInputTokens, costUsd: null, turns: 1, models: [] };
}

function diagnostic(result) {
  if (!record(result)) return "";
  if (typeof result.error === "string") return result.error;
  if (typeof result.error?.message === "string") return result.error.message;
  if (typeof result.message === "string") return result.message;
  return "";
}

/** Parse the official stream-json wire format without inferring success from logs or partial steps. */
export function parseAntigravityResult(stdout, { exitCode = 0, stderr = "" } = {}) {
  const finals = [];
  let protocolError = "";
  if (typeof stdout !== "string") protocolError = "The stream-json output must be text.";
  else for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { protocolError ||= `Invalid stream-json on line ${index + 1}.`; continue; }
    if (!record(event) || typeof event.event !== "string") {
      protocolError ||= `Invalid stream-json event on line ${index + 1}.`;
      continue;
    }
    if (event.event !== "result" && finals.length) protocolError ||= "Received an event after the final result.";
    if (event.event === "result") finals.push(event.result);
    else if (event.event === "error") protocolError ||= `The CLI emitted an error event${diagnostic(event) ? `: ${diagnostic(event)}` : "."}`;
    else if (!["init", "step_update"].includes(event.event)) protocolError ||= `Unknown stream-json event '${event.event}'.`;
  }
  const result = finals.find(record);
  const output = typeof result?.response === "string" ? result.response : "";
  const usage = resultUsage(result?.usage);
  const fail = reason => {
    const detail = diagnostic(result);
    const error = new Error(`Antigravity task failed: ${reason}${detail ? ` ${detail}` : ""}`.slice(0, 8_000));
    error.output = output;
    error.usage = usage;
    error.stderr = String(stderr ?? "");
    error.exitCode = exitCode;
    throw error;
  };
  if (exitCode !== 0) fail(`CLI exited with ${String(exitCode)}.`);
  if (finals.length > 1) fail(`Expected exactly one final result; received ${finals.length}.`);
  if (protocolError) fail(protocolError);
  if (finals.length !== 1) fail(`Expected exactly one final result; received ${finals.length}.`);
  if (!record(finals[0])) fail("The final result is malformed.");
  if (result.denied_actions !== undefined) {
    if (!Array.isArray(result.denied_actions) || result.denied_actions.some(action => !record(action)
      || typeof action.action !== "string" || !action.action.trim()
      || (action.display_name !== undefined && typeof action.display_name !== "string"))) {
      fail("Malformed denied_actions: tool permission status cannot be verified.");
    }
    if (result.denied_actions.length) {
      const names = result.denied_actions.map(action => {
        const name = action.action.trim();
        const display = action.display_name?.trim();
        return display && display !== name ? `${name} (${display})` : name;
      });
      fail(`Tool permission denial: ${[...new Set(names)].join(", ")}. The denied actions were not completed.`);
    }
  }
  if (result.status !== "SUCCESS") fail(`Final status is ${typeof result.status === "string" ? result.status : "unknown"}, not SUCCESS.`);
  if (!output.trim()) fail("The final result contains no response text.");
  const conversationId = typeof result.conversation_id === "string" && result.conversation_id.trim()
    ? result.conversation_id.trim() : null;
  return { output, usage, conversationId };
}
