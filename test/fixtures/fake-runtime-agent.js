import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const [agent, scenario, captureFile, ...args] = process.argv.slice(2);
const AGENT_NAMES = { codex: "Codex", claude: "Claude" };
if (scenario === "descendant") {
  writeFileSync(captureFile, String(process.pid));
  setInterval(() => {}, 1000);
} else if (args.includes("--version")) {
  if (scenario === "hold-probe") {
    appendFileSync(captureFile, `${JSON.stringify({ agent, args, pid: process.pid })}\n`);
    setInterval(() => {}, 1000);
  } else console.log(`${agent}-cli 1.2.3`);
} else if (args.includes("status") && (args.includes("auth") || args.includes("login"))) {
  if (scenario === "unauthenticated") {
    console.log(JSON.stringify({ loggedIn: false, email: "private@example.com", token: "sk-sensitive-test-token" }));
    process.exitCode = 1;
  } else {
    console.log(agent === "claude" ? JSON.stringify({ loggedIn: true, email: "private@example.com", accessToken: "sk-sensitive-test-token" })
      : "Logged in using ChatGPT private@example.com sk-sensitive-test-token");
  }
} else if (scenario === "exit-immediately") {
  console.error("Login required before this operation.");
  process.exit(2);
} else {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let images = [];
  let inputEnvelope = null;
  if (agent === "claude" && args[args.indexOf("--input-format") + 1] === "stream-json") {
    const envelope = JSON.parse(input.trim());
    const content = envelope.message?.content;
    if (!Array.isArray(content)) throw new Error("Fake Claude requires multimodal content blocks.");
    input = content.filter(block => block.type === "text").map(block => block.text).join("\n\n");
    images = content.filter(block => block.type === "image").map(block => {
      const bytes = Buffer.from(block.source.data, "base64");
      return { mimeType: block.source.media_type, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    inputEnvelope = { type: envelope.type, role: envelope.message.role, parent_tool_use_id: envelope.parent_tool_use_id };
  }
  appendFileSync(captureFile, `${JSON.stringify({ agent, args, input, images, inputEnvelope, pid: process.pid })}\n`);
  // Quota scenarios: "limit" always fails with a usage-limit message, "limit-on-N" fails from the Nth call,
  // "auth-error" fails with a login problem, "write-limit" edits a file and then hits the limit.
  const callFile = `${captureFile}.${agent}.calls`;
  const call = (existsSync(callFile) ? Number(readFileSync(callFile, "utf8")) : 0) + 1;
  writeFileSync(callFile, String(call));
  const limitAt = scenario === "limit" || scenario === "write-limit" ? 1 : /^limit-on-(\d+)$/.test(scenario) ? Number(scenario.slice(9)) : Infinity;
  if (scenario === "write-limit") writeFileSync(path.join(process.cwd(), "partial.txt"), "half done\n");
  if (call >= limitAt || scenario === "auth-error") {
    const message = scenario === "auth-error" ? "Not logged in. Please run login first." : agent === "claude" ? "Claude AI usage limit reached. Your limit resets at 6pm." : "You've hit your usage limit. Try again later.";
    if (agent === "claude") console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: message }));
    else console.log(JSON.stringify({ type: "turn.failed", error: { message } }));
    process.exit(1);
  }
  if (agent === "claude" && input.includes("You are the coordinator")) {
    console.log(JSON.stringify({ result: JSON.stringify({ summary: "Claude 規劃", kind: "review", steps: [{ title: "Inspect", instruction: "Inspect as planned by Claude.", agent: "codex" }], acceptance: ["Done."] }), is_error: false }));
    process.exit(0);
  }
  // Reviews: "revise-once" returns the work once before passing; "revise-always" never passes.
  if (input.includes("You are the reviewer")) {
    const reviewFile = `${captureFile}.${agent}.reviews`;
    const review = (existsSync(reviewFile) ? Number(readFileSync(reviewFile, "utf8")) : 0) + 1;
    writeFileSync(reviewFile, String(review));
    const revise = scenario === "revise-always" || (scenario === "revise-once" && review === 1);
    const verdict = JSON.stringify({ verdict: revise ? "revise" : "pass", criteria: [{ criterion: "Findings are reported.", met: !revise, note: "checked" }],
      issues: revise ? [{ step: 1, problem: `Missing detail ${review}`, fix: "Add the detail." }] : [],
      reply: revise && !input.includes("No revision rounds remain") ? "" : `${AGENT_NAMES[agent]} 審查完成，交付結果。` });
    if (agent === "claude") console.log(JSON.stringify({ result: verdict, is_error: false, usage: { input_tokens: 5, output_tokens: 7 } }));
    else {
      writeFileSync(args[args.indexOf("--output-last-message") + 1], verdict, "utf8");
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } }));
    }
    process.exit(0);
  }
  if (scenario === "hold") {
    spawn(process.execPath, [process.argv[1], agent, "descendant", `${captureFile}.child`], {
      stdio: "ignore", windowsHide: true,
    });
    setInterval(() => {}, 1000);
  } else if (scenario === "flood") {
    process.stdout.write("x".repeat(2_100_000));
    setInterval(() => {}, 1000);
  } else if (scenario === "json-error") {
    console.log(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "Maximum turns reached." }));
  } else if (scenario === "exit-error") {
    console.error("CLI task failed intentionally.");
    process.exitCode = 3;
  } else if (agent === "claude" && scenario.startsWith("stream-")) {
    console.log(JSON.stringify({ type: "system", subtype: "init" }));
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Worker reply" }] } }));
    const query = args[args.indexOf("--tools") + 1] === "";
    if (scenario !== "stream-no-quota" && scenario !== "stream-secret-error") {
      console.log(JSON.stringify({ type: "rate_limit_event", session_id: "private-session", rate_limit_info: {
        status: "allowed", rateLimitType: "five_hour", identity: "private@example.com", accessToken: "sk-sensitive-test-token",
        unifiedWindows: {
          five_hour: { utilization: scenario === "stream-invalid-quota" ? 1.5 : scenario === "stream-race" ? (query ? 0.1 : 0.75) : 0.25, resetsAt: Math.floor(Date.now() / 1000) + 18000 },
          seven_day: scenario === "stream-split-quota" ? undefined : { utilization: 0.4, resetsAt: scenario === "stream-invalid-quota" || scenario === "stream-partial-quota" ? "invalid" : Math.floor(Date.now() / 1000) + 604800 },
        },
      } }));
    }
    if (scenario === "stream-split-quota") {
      await new Promise(resolve => setTimeout(resolve, 60));
      console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
        seven_day: { utilization: 0.4, resetsAt: Math.floor(Date.now() / 1000) + 604800 },
      } } }));
    }
    if (scenario === "stream-race" && query) {
      while (!existsSync(`${captureFile}.release`)) await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (scenario !== "stream-missing-result") {
      const failed = scenario === "stream-error-quota" || scenario === "stream-secret-error";
      console.log(JSON.stringify({ type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed,
        result: failed ? "Quota operation failed for private@example.com sk-sensitive-test-token" : JSON.stringify({ input, args }),
        usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 42 },
        total_cost_usd: 0.0123, num_turns: 1, modelUsage: { "claude-test-model": {} } }));
      if (failed) process.exitCode = 3;
    }
  } else if (agent === "claude" && scenario === "plain") {
    console.log("Plain response diagnostics preserved.");
  } else if (agent === "claude") {
    console.log(JSON.stringify({ result: scenario === "chat" ? "我已複核這個設計，建議保留乾淨的三方聊天室。" : JSON.stringify({ input, args }), is_error: false,
      usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 42 }, total_cost_usd: 0.0123, num_turns: 3,
      modelUsage: { "claude-test-model": {} } }));
  } else if (scenario === "event-error") {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "Quota exceeded." } }));
  } else {
    const outputFile = args[args.indexOf("--output-last-message") + 1];
    const isPlan = args.includes("--output-schema");
    const output = isPlan ? JSON.stringify(scenario === "bad-plan" ? { summary: "Missing tasks" } : scenario === "chat" ? {
      summary: "我會先整理需求，再請 Claude 複核。", kind: "review",
      steps: [{ title: "複核", instruction: "複核聊天室設計。", agent: "claude" }], acceptance: ["回覆使用者。"],
    } : {
      summary: "Plan one bounded Claude task and integrate it.", kind: "review",
      steps: [{ title: "Review", instruction: "Review the assigned file for a concrete bug.", agent: scenario === "self-assign" ? "codex" : "claude" }], acceptance: ["Findings are reported."],
    }) : scenario === "chat" ? "聊天室會保留我們三方的對話。你可以接著說明想做的事。" : JSON.stringify({ input, args, message: "Codex integration complete" });
    writeFileSync(outputFile, output, "utf8");
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: output } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 120 } }));
  }
}
