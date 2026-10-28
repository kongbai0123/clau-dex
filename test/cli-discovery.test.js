import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { buildCliEnvironment, resolveCliCommand } from "../src/cli-discovery.js";

const root = mkdtempSync(path.join(os.tmpdir(), "bridge-cli-discovery-"));
let sequence = 0;
after(() => {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const directory = path.join(root, `case ${sequence++}`);
  const env = { USERPROFILE: path.join(directory, "User Home"), APPDATA: path.join(directory, "Roaming Data"),
    LOCALAPPDATA: path.join(directory, "Local Data"), ProgramFiles: path.join(directory, "Program Files"),
    SystemRoot: path.join(directory, "Windows") };
  return { directory, env, options: { env, platform: "win32" } };
}

function file(...parts) {
  const filename = path.join(...parts);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, "fixture only; not executed");
  return filename;
}

test("Windows CLI discovery finds bundled Codex and npm Claude when PATH is absent", () => {
  const { env, options } = fixture();
  const codex = file(env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "current", "codex.exe");
  const claude = file(env.APPDATA, "npm", "claude.cmd");
  assert.deepEqual(resolveCliCommand("codex", options), { command: codex, args: [] });
  assert.deepEqual(resolveCliCommand("claude", options), { command: claude, args: [] });
});

test("stale PATH entries do not prevent finding installed CLIs in known locations", () => {
  const { directory, env, options } = fixture();
  env.Path = path.join(directory, "removed installation");
  const codex = file(env.APPDATA, "npm", "codex.cmd");
  const claude = file(env.USERPROFILE, ".local", "bin", "claude.exe");
  assert.equal(resolveCliCommand("codex", options).command, codex);
  assert.equal(resolveCliCommand("claude", options).command, claude);
});

test("existing caller PATH entries take priority and PowerShell-only shims are ignored", () => {
  const { directory, env, options } = fixture();
  const first = path.join(directory, "first bin");
  const second = path.join(directory, "second bin");
  env.Path = `"${first}";${second}`;
  file(first, "claude.ps1");
  const selected = file(second, "claude.cmd");
  file(env.APPDATA, "npm", "claude.cmd");
  assert.equal(resolveCliCommand("claude", options).command, selected);
});

test("Codex chooses the newest actual executable rather than the newest directory", () => {
  const { env, options } = fixture();
  const versions = path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  const old = file(versions, "older", "codex.exe");
  const latest = file(versions, "newer", "codex.exe");
  file(versions, "other-tool-only", "rg.exe");
  mkdirSync(path.join(versions, "empty-update"), { recursive: true });
  mkdirSync(path.join(versions, "directory-named-exe", "codex.exe"), { recursive: true });
  utimesSync(old, new Date("2026-01-01"), new Date("2026-01-01"));
  utimesSync(latest, new Date("2026-02-01"), new Date("2026-02-01"));
  assert.equal(resolveCliCommand("codex", options).command, latest);
});

function bundledClaude(env, version, build, { verified = true } = {}) {
  const folder = path.join(env.APPDATA, "Claude", "claude-code", version, build);
  if (verified) file(folder, ".verified");
  return file(folder, "claude.exe");
}

test("Claude falls back to the desktop App's verified CLI when PATH and npm are absent", () => {
  const { env, options } = fixture();
  const claude = bundledClaude(env, "2.1.295", "d2e29494ec83");
  assert.deepEqual(resolveCliCommand("claude", options), { command: claude, args: [] });
});

test("bundled Claude chooses the highest verified version and skips incomplete builds", () => {
  const { env, options } = fixture();
  const versions = path.join(env.APPDATA, "Claude", "claude-code");
  bundledClaude(env, "2.1.9", "old");
  const latest = bundledClaude(env, "2.1.10", "current");
  bundledClaude(env, "2.1.11", "downloading", { verified: false });
  file(versions, "2.1.12", "no-binary", ".verified");
  mkdirSync(path.join(versions, "2.1.13", "directory-named-exe", "claude.exe"), { recursive: true });
  file(versions, "2.1.13", "directory-named-exe", ".verified");
  assert.equal(resolveCliCommand("claude", options).command, latest);
});

test("installed Claude CLIs take priority over the desktop App's bundled copy", () => {
  const { env, options } = fixture();
  bundledClaude(env, "9.9.9", "bundled");
  const npm = file(env.APPDATA, "npm", "claude.cmd");
  assert.equal(resolveCliCommand("claude", options).command, npm);
});

test("Windows environment combines PATH key casing, deduplicates entries, and preserves caller order", () => {
  const { directory, env } = fixture();
  const first = path.join(directory, "First Bin");
  const second = path.join(directory, "Second Bin");
  const source = { ...env, Path: `${first};${second}`, PATH: `${first.toUpperCase()};${first}\\;`, arbitrary: "kept" };
  const original = { ...source };
  const result = buildCliEnvironment(source, { platform: "win32" });
  assert.deepEqual(source, original);
  assert.deepEqual(Object.keys(result).filter(key => key.toLowerCase() === "path"), ["Path"]);
  assert.deepEqual(result.Path.split(";"), [first, second, path.join(env.ProgramFiles, "nodejs"),
    path.join(env.APPDATA, "npm"), path.join(env.USERPROFILE, ".local", "bin"),
    path.join(env.SystemRoot, "System32"), env.SystemRoot]);
  assert.equal(result.arbitrary, "kept");
});

test("Windows PATH expansion and direct executable paths retain spaces without shell quoting", () => {
  const { directory, env, options } = fixture();
  env.CUSTOM_BIN = path.join(directory, "Custom Bin");
  env.PATH = '"%CUSTOM_BIN%"';
  const codex = file(env.CUSTOM_BIN, "codex.exe");
  assert.equal(resolveCliCommand("codex", options).command, codex);
  assert.equal(buildCliEnvironment(env, { platform: "win32" }).PATH.split(";")[0], env.CUSTOM_BIN);
});

test("missing installations preserve the bare command fallback", () => {
  const { options } = fixture();
  for (const agent of ["codex", "claude"]) assert.deepEqual(resolveCliCommand(agent, options), { command: agent, args: [] });
});

test("empty Windows PATH gains node, npm and lifecycle helper directories", () => {
  const { env } = fixture();
  const result = buildCliEnvironment({ ...env, PATH: "" }, { platform: "win32" });
  assert.deepEqual(result.PATH.split(";"), [path.join(env.ProgramFiles, "nodejs"), path.join(env.APPDATA, "npm"),
    path.join(env.USERPROFILE, ".local", "bin"), path.join(env.SystemRoot, "System32"), env.SystemRoot]);
  assert.equal(result.SystemRoot, env.SystemRoot);
});

test("non-Windows callers preserve their commands and environment without Windows discovery", () => {
  const env = { PATH: "/usr/local/bin:/usr/bin", tokenLikeSetting: "opaque" };
  assert.deepEqual(buildCliEnvironment(env, { platform: "linux" }), env);
  assert.notEqual(buildCliEnvironment(env, { platform: "linux" }), env);
  for (const agent of ["codex", "claude"]) assert.deepEqual(resolveCliCommand(agent, { env, platform: "linux" }), { command: agent, args: [] });
});
