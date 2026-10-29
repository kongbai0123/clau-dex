import assert from "node:assert/strict";
import test from "node:test";
import { deriveAgentReadiness } from "../src/agent-readiness.js";

const CLI = { id: "claude", tasks: true, signInWith: "cli" };
const APP = { id: "antigravity", tasks: true, signInWith: "app" };
const READY_CLI = { available: true, authenticated: true };

test("unloaded or API error is unknown and blocks sending regardless of agent data", () => {
  for (const context of [{ loaded: false }, { loaded: true, apiError: "boom" }]) {
    const state = deriveAgentReadiness(CLI, READY_CLI, context);
    assert.equal(state.code, "unknown");
    assert.equal(state.type, "muted");
    assert.equal(state.canSend, false);
    assert.equal(state.action, "none");
    assert.equal(state.credentialText, "登入待確認");
  }
  assert.equal(deriveAgentReadiness(APP, { available: true, credentialPresent: true }, { loaded: false }).credentialText, "憑證狀態待確認");
});

test("API error text is never echoed into the reason", () => {
  const state = deriveAgentReadiness(CLI, { ...READY_CLI, error: "secret token sk-123" }, { apiError: "<script>leak</script>" });
  assert.ok(!state.reason.includes("leak"));
  const unavailable = deriveAgentReadiness(CLI, { available: false, error: "C:\\Users\\x\\secret path" });
  assert.equal(unavailable.code, "unavailable");
  assert.ok(!unavailable.reason.includes("secret"));
});

test("precedence: stopping beats unsupported, unsupported beats unavailable and pending login", () => {
  assert.equal(deriveAgentReadiness({ ...CLI, tasks: false }, READY_CLI, { shuttingDown: true }).code, "stopping");
  const unsupported = deriveAgentReadiness({ ...CLI, tasks: false }, { available: false, login: { state: "pending" } });
  assert.equal(unsupported.code, "unsupported");
  assert.equal(unsupported.canSend, false);
  assert.equal(deriveAgentReadiness({ ...CLI, tasks: false }, READY_CLI).canSend, false);
});

test("checking only applies while the CLI is not yet available", () => {
  const checking = deriveAgentReadiness(CLI, { available: false, error: "正在檢查連線" });
  assert.equal(checking.code, "checking");
  assert.equal(checking.type, "warning");
  assert.equal(checking.canSend, false);
  assert.equal(deriveAgentReadiness(CLI, { available: true, authenticated: true, error: "正在檢查連線" }).code, "ready");
});

test("unavailable CLI offers diagnosis and outranks a pending login", () => {
  const state = deriveAgentReadiness(CLI, { available: false, login: { state: "pending" }, authenticated: true });
  assert.deepEqual([state.code, state.text, state.type, state.canSend, state.action], ["unavailable", "CLI 不可用", "muted", false, "diagnose"]);
  assert.equal(deriveAgentReadiness(CLI, {}).code, "unavailable");
});

test("pending login blocks sending and outranks needs-login", () => {
  const cli = deriveAgentReadiness(CLI, { available: true, authenticated: false, login: { state: "pending" } });
  assert.deepEqual([cli.code, cli.canSend, cli.action, cli.text], ["signing-in", false, "none", "等待瀏覽器授權…"]);
  const app = deriveAgentReadiness(APP, { available: true, login: { state: "pending" } });
  assert.deepEqual([app.code, app.text], ["signing-in", "等待在 App 內登入…"]);
});

test("CLI login states map to needs-login, signed-in ready, and unconfirmed ready", () => {
  const needs = deriveAgentReadiness(CLI, { available: true, authenticated: false });
  assert.deepEqual([needs.code, needs.text, needs.type, needs.canSend, needs.action, needs.credentialText],
    ["needs-login", "需要登入", "warning", false, "login", "需要登入"]);
  const signedIn = deriveAgentReadiness(CLI, READY_CLI);
  assert.deepEqual([signedIn.code, signedIn.text, signedIn.type, signedIn.canSend, signedIn.action, signedIn.credentialText],
    ["ready", "CLI 已登入", "ready", true, "chat", "CLI 已登入"]);
  const unknown = deriveAgentReadiness(CLI, { available: true });
  assert.deepEqual([unknown.code, unknown.text, unknown.canSend, unknown.credentialText], ["ready", "CLI 可用", true, "登入待確認"]);
});

test("app sign-in credential marker is observation only and never claims a verified login", () => {
  const expected = { true: "偵測到憑證（有效性未驗證）", false: "未偵測到登入憑證，請先在 App 登入", null: "憑證狀態待確認" };
  for (const credentialPresent of [true, false, null]) {
    const state = deriveAgentReadiness(APP, { available: true, credentialPresent });
    assert.equal(state.code, "ready");
    assert.equal(state.text, "CLI 可用");
    assert.equal(state.canSend, true);
    assert.equal(state.action, "chat");
    assert.equal(state.credentialText, expected[credentialPresent]);
  }
  // A stray authenticated flag must not turn app sign-in into "CLI 已登入" or block it.
  assert.equal(deriveAgentReadiness(APP, { available: true, authenticated: true, credentialPresent: true }).text, "CLI 可用");
  assert.equal(deriveAgentReadiness(APP, { available: true, authenticated: false }).code, "ready");
  assert.equal(deriveAgentReadiness(APP, { available: true }).credentialText, "憑證狀態待確認");
});

test("result ignores desktop App liveness and past task success", () => {
  const base = deriveAgentReadiness(CLI, { available: false });
  const noisy = deriveAgentReadiness(CLI, { available: false, app: { running: true }, lastSuccessAt: Date.now() }, { loaded: true, appRunning: true });
  assert.deepEqual(noisy, base);
});

test("metadata is read independently of provider id and tolerates missing inputs", () => {
  assert.equal(deriveAgentReadiness({ id: "antigravity", signInWith: "cli" }, { available: true, authenticated: false }).code, "needs-login");
  assert.equal(deriveAgentReadiness({ id: "claude", signInWith: "app" }, { available: true, authenticated: false }).code, "ready");
  assert.equal(deriveAgentReadiness().code, "unavailable");
  assert.equal(deriveAgentReadiness(null, null, null).code, "unavailable");
  assert.equal(deriveAgentReadiness(CLI, READY_CLI, { shuttingDown: true }).code, "stopping");
});

test("inputs are not mutated and every result has the full shape", () => {
  const provider = Object.freeze({ ...APP });
  const agent = Object.freeze({ available: true, credentialPresent: false, login: Object.freeze({ state: "idle" }) });
  const context = Object.freeze({ loaded: true, apiError: null, shuttingDown: false });
  const state = deriveAgentReadiness(provider, agent, context);
  assert.deepEqual(Object.keys(state).sort(), ["action", "canSend", "code", "credentialText", "reason", "text", "type"]);
  for (const value of [state.text, state.reason, state.credentialText]) assert.ok(typeof value === "string" && value.length > 0);
  assert.ok(["ready", "warning", "muted"].includes(state.type));
  assert.ok(["chat", "login", "diagnose", "none"].includes(state.action));
});
