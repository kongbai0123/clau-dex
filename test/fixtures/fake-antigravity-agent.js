import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

// A deterministic implementation of the public agy headless stream contract.
// This fixture never loads a provider SDK, credentials, network, or real model.
const [scenario, captureFile, ...args] = process.argv.slice(2);
const capture = (record) => appendFileSync(captureFile, `${JSON.stringify({ agent: "antigravity", scenario, args, pid: process.pid, ...record })}\n`);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (scenario === "descendant") {
  setInterval(() => {}, 1000);
} else if (args.includes("--version")) {
  capture({ kind: "probe" });
  console.log("agy version 1.4.9");
} else if (args.includes("--help")) {
  capture({ kind: "probe" });
  console.log("Usage: agy [flags]\n--input-format text|stream-json\n--output-format text|json|stream-json\n--print-timeout duration\n--model model-name\n--disable-slash-commands");
  if (scenario !== "unsupported-mode") console.log("--mode accept-edits");
  if (scenario !== "unsupported-help") console.log("--sandbox");
} else {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const lines = input.trim().split(/\r?\n/).filter(Boolean);
  let envelope;
  try { envelope = JSON.parse(lines[0]); } catch { /* captured below to explain protocol failures */ }
  capture({ kind: "task", cwd: process.cwd(), input, envelope, lineCount: lines.length });
  if (lines.length !== 1 || envelope?.event !== "user" || typeof envelope.message?.content !== "string") {
    console.error("Fixture expects exactly one user event with text content.");
    process.exitCode = 4;
  } else {
    emit({ event: "init", conversation_id: "fixture-conversation", init: { cwd: process.cwd(), tools: [], permission_mode: "request-review" } });
    emit({ event: "step_update", step_update: { conversation_id: "fixture-conversation", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Intermediate text is not the final result." } });
    if (scenario === "hold" || scenario === "flood") {
      const child = spawn(process.execPath, [process.argv[1], "descendant", captureFile], { stdio: "ignore", windowsHide: true });
      writeFileSync(`${captureFile}.child`, String(child.pid));
      if (scenario === "flood") process.stdout.write("x".repeat(2_100_000));
      setInterval(() => {}, 1000);
    } else if (scenario === "missing-result") {
      emit({ event: "step_update", step_update: { state: "DONE", step_type: "agent_response", text_delta: "A completed step is not a completed run." } });
    } else if (scenario === "malformed") {
      process.stdout.write('{"event":"result","result":');
    } else {
      const result = {
        conversation_id: "fixture-conversation", status: scenario === "error" ? "ERROR" : scenario === "waiting" ? "WAITING" : "SUCCESS",
        response: scenario === "empty" ? " \n" : "Antigravity 已完成驗證 ✓",
        duration_seconds: 0.01, num_turns: 1,
        usage: { input_tokens: 121, cache_read_tokens: 47, output_tokens: 23, thinking_tokens: 5, total_tokens: 144 },
      };
      if (scenario === "error") result.error = "Fixture rejected this request.";
      if (scenario === "no-newline") process.stdout.write(JSON.stringify({ event: "result", result }));
      else if (scenario === "split-utf8") {
        const bytes = Buffer.from(`${JSON.stringify({ event: "result", result })}\n`, "utf8");
        const split = bytes.indexOf(Buffer.from("已")) + 1;
        process.stdout.write(bytes.subarray(0, split));
        await new Promise((resolve) => setTimeout(resolve, 15));
        process.stdout.write(bytes.subarray(split));
      } else emit({ event: "result", result });
      if (scenario === "duplicate-result") emit({ event: "result", result: { ...result, response: "Conflicting final answer." } });
      if (scenario === "nonzero") { console.error("Fixture exited after a purported success."); process.exitCode = 7; }
    }
  }
}
