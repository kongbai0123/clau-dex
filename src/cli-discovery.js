import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENTS = new Set(["codex", "claude"]);

function environmentValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key && typeof env[key] === "string" ? env[key] : "";
}

function directories(env, options) {
  const homeDirectory = options.homeDirectory ?? (environmentValue(env, "USERPROFILE") || os.homedir());
  return {
    homeDirectory,
    appData: options.appData ?? (environmentValue(env, "APPDATA") || path.join(homeDirectory, "AppData", "Roaming")),
    localAppData: options.localAppData ?? (environmentValue(env, "LOCALAPPDATA") || path.join(homeDirectory, "AppData", "Local")),
    programFiles: options.programFiles ?? (environmentValue(env, "ProgramFiles") || "C:\\Program Files"),
    systemRoot: options.systemRoot ?? (environmentValue(env, "SystemRoot") || environmentValue(env, "WINDIR") || "C:\\Windows"),
  };
}

function expandEnvironment(value, env) {
  return value.replace(/%([^%]+)%/g, (original, name) => environmentValue(env, name) || original);
}

function pathEntries(env) {
  return Object.entries(env).filter(([key]) => key.toLowerCase() === "path")
    .flatMap(([, value]) => typeof value === "string" ? value.split(";") : [])
    .map((value) => expandEnvironment(value.trim().replace(/^"(.*)"$/, "$1"), env)).filter(Boolean);
}

/** Give CLI children a usable PATH without changing Windows or the parent process. */
export function buildCliEnvironment(env = process.env, options = {}) {
  const result = { ...env };
  if ((options.platform ?? process.platform) !== "win32") return result;
  const roots = directories(env, options);
  const originalKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "Path";
  const entries = [...pathEntries(env), path.join(roots.programFiles, "nodejs"),
    path.join(roots.appData, "npm"), path.join(roots.homeDirectory, ".local", "bin"),
    path.join(roots.systemRoot, "System32"), roots.systemRoot];
  const seen = new Set();
  const unique = entries.filter((entry) => {
    const key = path.normalize(entry).replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  for (const key of Object.keys(result)) if (key.toLowerCase() === "path") delete result[key];
  result[originalKey] = unique.join(";");
  if (!environmentValue(result, "SystemRoot")) result.SystemRoot = roots.systemRoot;
  return result;
}

function isFile(file) {
  try { return statSync(file).isFile(); } catch { return false; }
}

function findOnPath(agent, env) {
  for (const directory of pathEntries(env)) {
    // PowerShell scripts cannot be spawned directly by Node/Electron.
    for (const extension of [".exe", ".cmd"]) {
      const candidate = path.resolve(directory, `${agent}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function bundledCodex(localAppData) {
  const directory = path.join(localAppData, "OpenAI", "Codex", "bin");
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(directory, entry.name, "codex.exe");
    try {
      const info = statSync(candidate);
      if (info.isFile()) candidates.push({ candidate, modified: info.mtimeMs });
    } catch { /* Updates can remove a version directory while it is inspected. */ }
  }
  candidates.sort((left, right) => right.modified - left.modified || left.candidate.localeCompare(right.candidate));
  return candidates[0]?.candidate || null;
}

function compareVersions(left, right) {
  const parts = value => value.split(/[.-]/).map(part => Number.parseInt(part, 10)).map(part => Number.isNaN(part) ? -1 : part);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

/** Claude desktop keeps a verified Claude Code CLI under claude-code/<version>/<build>/claude.exe. */
function bundledClaude(appData) {
  const directory = path.join(appData, "Claude", "claude-code");
  const subdirectories = parent => {
    try { return readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
    catch { return []; }
  };
  const candidates = [];
  for (const version of subdirectories(directory)) {
    for (const build of subdirectories(path.join(directory, version))) {
      const folder = path.join(directory, version, build);
      const candidate = path.join(folder, "claude.exe");
      // A missing marker means the desktop App has not finished downloading or verifying this build.
      if (!isFile(candidate) || !isFile(path.join(folder, ".verified"))) continue;
      try { candidates.push({ candidate, version, modified: statSync(candidate).mtimeMs }); }
      catch { /* Updates can remove a version directory while it is inspected. */ }
    }
  }
  candidates.sort((left, right) => compareVersions(right.version, left.version)
    || right.modified - left.modified || left.candidate.localeCompare(right.candidate));
  return candidates[0]?.candidate || null;
}

/** Resolve only known local CLI locations; explicit command overrides are handled by the caller. */
export function resolveCliCommand(agent, options = {}) {
  if (!AGENTS.has(agent)) throw new Error("Unknown CLI agent.");
  const fallback = { command: agent, args: [] };
  if ((options.platform ?? process.platform) !== "win32") return fallback;
  const env = options.env ?? process.env;
  const roots = directories(env, options);
  const command = findOnPath(agent, buildCliEnvironment(env, options))
    || (agent === "codex" ? bundledCodex(roots.localAppData) : bundledClaude(roots.appData));
  return command ? { command, args: [] } : fallback;
}
