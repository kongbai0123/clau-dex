import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createAgentRuntime } from "../src/agent-runtime.js";
import { createWindowsCredentialProbe, credentialTargetListed } from "../src/credential-status.js";

const root = mkdtempSync(path.join(os.tmpdir(), "bridge-credential-state-"));
after(() => {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  rmSync(root, { recursive: true, force: true });
});
const missing = path.join(root, "not-installed", "agy.exe");
const target = "gemini:antigravity";
const command = (code) => ({ command: process.execPath, args: ["-e", code, "--"] });
const waitFor = async (condition) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for the controlled credential probe.");
};

test("credential names match exact localized target fields only", () => {
  for (const line of [
    "    Target: LegacyGeneric:target=gemini:antigravity",
    "    目標: LegacyGeneric:target=gemini:antigravity\r",
    "    目标： LegacyGeneric:target=gemini:antigravity",
    "Target: gemini:antigravity",
    "TARGET: LegacyGeneric:target=GEMINI:ANTIGRAVITY",
  ]) assert.equal(credentialTargetListed(line, target), true, line);
  for (const line of [
    "Target: LegacyGeneric:target=gemini:antigravity2",
    "Target: LegacyGeneric:target=gemini:antigravity-old",
    "Target: LegacyGeneric:target=other-gemini:antigravity",
    "User: target=gemini:antigravity",
    "User: gemini:antigravity",
    "User: LegacyGeneric:target=gemini:antigravity",
    "Other: LegacyGeneric:target=gemini:antigravity",
    "\ufffd\u00d7\ufffd: LegacyGeneric:target=gemini:antigravity",
    "A diagnostic mentioning target=gemini:antigravity",
    "Target: LegacyGeneric:target=gemini:antigravity\u0000extra",
    "Currently stored credentials:",
  ]) assert.equal(credentialTargetListed(line, target), false, line);
});

test("Windows credential lookup returns unknown on errors and avoids non-Windows calls", async () => {
  let calls = 0;
  const unavailable = createWindowsCredentialProbe({ platform: "linux", execFile() { calls++; } });
  assert.equal(await unavailable(target), null);
  assert.equal(calls, 0);
  const failure = createWindowsCredentialProbe({ platform: "win32", codePage: 65001, execFile(_command, _args, _options, callback) {
    calls++;
    queueMicrotask(() => callback(new Error("unavailable"), "Target: gemini:antigravity"));
  } });
  assert.equal(await failure(target), null);
  assert.equal(calls, 1);
  const empty = createWindowsCredentialProbe({ platform: "win32", codePage: 65001, execFile(_command, _args, _options, callback) {
    queueMicrotask(() => callback(null, "No credentials found."));
  } });
  assert.equal(await empty(target), false);
});

test("credential subprocess receives an exact list request and cancellation signal", async () => {
  const controller = new AbortController();
  let began = false;
  const lookup = createWindowsCredentialProbe({ platform: "win32", codePage: 65001, execFile(name, args, options, callback) {
    began = true;
    assert.equal(name, "cmdkey.exe");
    assert.deepEqual(args, [`/list:${target}`]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.encoding, "buffer");
    assert.equal(options.signal, controller.signal);
    options.signal.addEventListener("abort", () => callback(Object.assign(new Error("cancelled"), { name: "AbortError" }), ""), { once: true });
  } });
  const checking = lookup(target, { signal: controller.signal });
  await waitFor(() => began);
  controller.abort();
  assert.equal(await checking, null);
  let startedAfterAbort = false;
  const alreadyStopped = createWindowsCredentialProbe({ platform: "win32", execFile() { startedAfterAbort = true; } });
  assert.equal(await alreadyStopped(target, { signal: controller.signal }), null);
  assert.equal(startedAfterAbort, false);
});

test("native Big5 target labels without an ASCII namespace are decoded before exact matching", async () => {
  const label = Buffer.from([0xa5, 0xd8, 0xbc, 0xd0]); // CP950: 目標
  for (const [value, expected] of [[target, true], [`${target}2`, false]]) {
    const output = Buffer.concat([Buffer.from("    "), label, Buffer.from(`: ${value}\r\n    User: ${target}\r\n`)]);
    const commands = [];
    const lookup = createWindowsCredentialProbe({ platform: "win32", execFile(name, args, options, callback) {
      commands.push(name);
      assert.equal(options.encoding, "buffer");
      queueMicrotask(() => callback(null, name === "reg.exe" ? Buffer.from("    OEMCP    REG_SZ    950\r\n") : output));
    } });
    assert.equal(await lookup(target), expected);
    assert.deepEqual(commands, ["reg.exe", "cmdkey.exe"]);
  }
});

test("unknown or failed OEM lookup never turns into a false signed-out result", async () => {
  for (const output of [null, Buffer.from("OEMCP REG_SZ not-a-page\r\n"), Buffer.from("unrecognized registry output")]) {
    const commands = [];
    const lookup = createWindowsCredentialProbe({ platform: "win32", execFile(name, _args, _options, callback) {
      commands.push(name);
      queueMicrotask(() => callback(output === null ? new Error("registry unavailable") : null, output));
    } });
    assert.equal(await lookup(target), null);
    assert.deepEqual(commands, ["reg.exe"]);
  }
});

test("decoding failure and unfamiliar target labels preserve unknown", async () => {
  for (const output of [Buffer.from([0xff]), Buffer.from(`Cible: ${target}\r\n`), Buffer.from(`Currently stored credentials for ${target}:\r\n`)]) {
    const lookup = createWindowsCredentialProbe({ platform: "win32", codePage: 65001, execFile(_name, _args, _options, callback) {
      queueMicrotask(() => callback(null, output));
    } });
    assert.equal(await lookup(target), null);
  }
});

test("unsupported OEM conversion returns unknown without weakening exact field matching", async () => {
  const commands = [];
  const lookup = createWindowsCredentialProbe({ platform: "win32", codePage: 55555, execFile(name, _args, _options, callback) {
    commands.push(name);
    queueMicrotask(() => callback(name === "powershell.exe" ? new Error("unsupported code page") : null, Buffer.from(`Target: ${target}\r\n`)));
  } });
  assert.equal(await lookup(target), null);
  assert.deepEqual(commands, ["cmdkey.exe", "powershell.exe"]);
});

test("legacy OEM decoder helper receives only captured bytes and the original cancellation signal", async () => {
  const controller = new AbortController();
  const output = Buffer.from(`Target: ${target}\r\n`);
  let input = "";
  const lookup = createWindowsCredentialProbe({ platform: "win32", codePage: 437, execFile(name, args, options, callback) {
    assert.equal(options.signal, controller.signal);
    if (name === "cmdkey.exe") { queueMicrotask(() => callback(null, output)); return; }
    assert.equal(name, "powershell.exe");
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    assert.match(script, /GetEncoding\(437/);
    assert.doesNotMatch(script, /cmdkey|CredRead|CredEnumerate/);
    return { stdin: { on() {}, end(value, encoding) {
      input = value; assert.equal(encoding, "ascii");
      queueMicrotask(() => callback(null, output));
    } } };
  } });
  assert.equal(await lookup(target, { signal: controller.signal }), true);
  assert.equal(Buffer.from(input, "base64").equals(output), true);
});

test("aborting OEM registry discovery does not start cmdkey afterward", async () => {
  const controller = new AbortController();
  const commands = [];
  const lookup = createWindowsCredentialProbe({ platform: "win32", execFile(name, _args, options, callback) {
    commands.push(name);
    options.signal.addEventListener("abort", () => callback(new Error("cancelled"), Buffer.alloc(0)), { once: true });
  } });
  const checking = lookup(target, { signal: controller.signal });
  controller.abort();
  assert.equal(await checking, null);
  assert.deepEqual(commands, ["reg.exe"]);
});

for (const present of [true, false, null]) test(`missing agy keeps credential presence ${present} separate from verified sign-in`, async () => {
  const checked = [];
  const runtime = createAgentRuntime({ antigravityCommand: missing, runtimeDirectory: path.join(root, randomUUID()),
    credentialExists: async (name, options) => { checked.push(name); assert.ok(options.signal); return present; } });
  try {
    const status = await runtime.probeAgent("antigravity");
    assert.equal(status.available, false);
    assert.equal(status.authenticated, null);
    assert.equal(status.credentialPresent, present);
    assert.equal(status.authSource, "credential-entry");
    assert.deepEqual(checked, [target]);
    assert.match(status.error, /not installed|PATH/);
  } finally { await runtime.close(); }
});

test("a broken agy version command still checks the independent credential marker", async () => {
  let checks = 0;
  const runtime = createAgentRuntime({ antigravityCommand: command("process.exit(7)"),
    credentialExists: async () => { checks++; return true; } });
  try {
    const status = await runtime.probeAgent("antigravity");
    assert.equal(status.available, false);
    assert.equal(status.credentialPresent, true);
    assert.equal(status.authenticated, null);
    assert.equal(status.error, "CLI version check failed.");
    assert.equal(checks, 1);
  } finally { await runtime.close(); }
});

test("a working agy and credential entry still do not prove a valid account session", async () => {
  const runtime = createAgentRuntime({ antigravityCommand: command("console.log('agy 1.2.3')"), credentialExists: async () => true });
  try {
    const status = await runtime.probeAgent("antigravity");
    assert.equal(status.available, true);
    assert.equal(status.version, "antigravity 1.2.3");
    assert.equal(status.credentialPresent, true);
    assert.equal(status.authenticated, null);
    assert.equal(status.error, null);
  } finally { await runtime.close(); }
});

test("a credential lookup exception stays unknown instead of claiming signed out", async () => {
  const runtime = createAgentRuntime({ antigravityCommand: missing, credentialExists: async () => { throw new Error("credentials unavailable"); } });
  try {
    const status = await runtime.probeAgent("antigravity");
    assert.equal(status.credentialPresent, null);
    assert.equal(status.authenticated, null);
  } finally { await runtime.close(); }
});

test("aborting a CLI probe never performs a later credential fallback", async () => {
  const controller = new AbortController();
  let checks = 0;
  const runtime = createAgentRuntime({ antigravityCommand: command("setInterval(()=>{},1000)"),
    credentialExists: async () => { checks++; return true; } });
  const checking = runtime.probeAgent("antigravity", controller.signal);
  try {
    await waitFor(() => runtime.activeProcesses().length === 1);
    controller.abort();
    const status = await checking;
    assert.equal(status.error, "Status check cancelled.");
    assert.equal(status.credentialPresent, null);
    assert.equal(status.authenticated, null);
    assert.equal(checks, 0);
    assert.deepEqual(runtime.activeProcesses(), []);
  } finally { await runtime.close(); }
});

test("runtime close cancels an active credential check and awaits its cleanup", async () => {
  let started = false;
  let cleaned = false;
  const runtime = createAgentRuntime({ antigravityCommand: missing, credentialExists: (_name, { signal }) => new Promise((resolve) => {
    started = true;
    signal.addEventListener("abort", () => setTimeout(() => { cleaned = true; resolve(null); }, 20), { once: true });
  }) });
  const checking = runtime.probeAgent("antigravity");
  await waitFor(() => started);
  await runtime.close();
  assert.equal(cleaned, true);
  const status = await checking;
  assert.equal(status.error, "Status check cancelled.");
  assert.equal(status.credentialPresent, null);
});
