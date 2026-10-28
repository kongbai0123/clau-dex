import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

const APP_IDS = ["codex", "claude"];
const APP_NAMES = { codex: "Codex", claude: "Claude" };
const INVENTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$apps = @(Get-StartApps | Where-Object {
  $_.AppID -match '^OpenAI\.Codex_[A-Za-z0-9]+![A-Za-z0-9._-]+$' -or
  $_.AppID -match '^Claude_[A-Za-z0-9]+!Claude$'
} | Select-Object Name, AppID)
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe' OR Name = 'Codex.exe' OR Name = 'Claude.exe'" | ForEach-Object {
  [ordered]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    name = [string]$_.Name
    path = [string]$_.ExecutablePath
    created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }
  }
})
[ordered]@{ apps = $apps; processes = $processes } | ConvertTo-Json -Depth 5 -Compress
`;

// The target comes from a verified discovery snapshot, never from renderer input.
// Recheck its executable and creation time immediately before closing its PID.
const CLOSE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$expected = $env:CODEX_CLAUDE_BRIDGE_OWNED_APP | ConvertFrom-Json
if (@('codex', 'claude') -notcontains $expected.app) { throw 'Unknown managed app.' }
if ([int]$expected.pid -le 0) { throw 'Invalid managed process.' }
function Get-VerifiedProcess {
  $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$expected.pid)
  if (-not $candidate) { return $null }
  $created = $candidate.CreationDate.ToUniversalTime().ToString('o')
  if ([string]$candidate.ExecutablePath -ine [string]$expected.path -or
      [string]$candidate.Name -ine [string]$expected.name -or
      $created -cne [string]$expected.created) {
    throw 'The managed process identity changed; it was not closed.'
  }
  return $candidate
}
if (-not (Get-VerifiedProcess)) { '{"status":"gone"}'; exit 0 }
$native = Get-Process -Id ([int]$expected.pid) -ErrorAction Stop
$graceful = $native.CloseMainWindow()
if ($graceful) {
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    Start-Sleep -Milliseconds 200
    if (-not (Get-VerifiedProcess)) { '{"status":"closed"}'; exit 0 }
  }
}
if (Get-VerifiedProcess) { Stop-Process -Id ([int]$expected.pid) -ErrorAction Stop }
'{"status":"closed"}'
`;

function knownAppId(id, value) {
  if (typeof value !== "string") return false;
  return id === "codex"
    ? /^OpenAI\.Codex_[A-Za-z0-9]+![A-Za-z0-9._-]+$/i.test(value)
    : /^Claude_[A-Za-z0-9]+!Claude$/i.test(value);
}

function knownDesktopPath(id, value) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value)) return false;
  const normalized = path.win32.normalize(value);
  if (id === "codex") {
    return /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$/i.test(normalized)
      || /\\(?:OpenAI\\Codex|Programs\\Codex)\\(?:app-[\d.]+\\)?Codex\.exe$/i.test(normalized);
  }
  return /\\WindowsApps\\Claude_[^\\]+\\app\\Claude\.exe$/i.test(normalized)
    || /\\AnthropicClaude\\app-[\d.]+\\Claude\.exe$/i.test(normalized)
    || /\\Programs\\Claude\\Claude\.exe$/i.test(normalized);
}

function validProcess(id, item) {
  return Number.isInteger(item?.pid) && item.pid > 0
    && knownDesktopPath(id, item.path)
    && path.win32.basename(item.path).toLowerCase() === String(item.name).toLowerCase()
    && typeof item.created === "string" && Number.isFinite(Date.parse(item.created));
}

function sameProcess(left, right) {
  return left.pid === right.pid && left.created === right.created
    && left.path.toLowerCase() === right.path.toLowerCase()
    && left.name.toLowerCase() === right.name.toLowerCase();
}

function errorMessage(error) {
  const detail = String(error?.stderr || error?.message || error).trim();
  return detail || "Unable to manage the desktop application.";
}

/** Manage only native desktop app instances launched by this manager. */
export function createAppManager({
  platform = process.platform,
  execFile = nodeExecFile,
  spawn = nodeSpawn,
} = {}) {
  const owned = new Map(APP_IDS.map((id) => [id, new Map()]));
  const launchers = new Map();
  const helperChildren = new Set();
  const pendingCancellations = new Set();
  let operation = Promise.resolve();
  let disposed = false;

  function requireActive() {
    if (disposed) throw new Error("App manager is closed.");
  }

  function requireId(id) {
    if (!APP_IDS.includes(id)) throw new Error("Unknown app. Choose codex or claude.");
  }

  function execute(script, extraEnv = {}) {
    return new Promise((resolve, reject) => {
      requireActive();
      let child;
      let settled = false;
      const cancel = () => {
        if (settled) return;
        settled = true;
        pendingCancellations.delete(cancel);
        reject(new Error("App manager is closed."));
      };
      pendingCancellations.add(cancel);
      try {
        child = execFile("powershell.exe", [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
        ], {
          windowsHide: true,
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, ...extraEnv },
        }, (error, stdout, stderr) => {
          helperChildren.delete(child);
          if (settled) return;
          settled = true;
          pendingCancellations.delete(cancel);
          if (error) {
            error.stderr = stderr;
            reject(error);
          } else {
            try { resolve(JSON.parse(String(stdout).replace(/^\uFEFF/, "").trim())); }
            catch { reject(new Error("Windows returned an invalid app inventory response.")); }
          }
        });
        if (child && !settled) {
          helperChildren.add(child);
          child.once?.("exit", () => helperChildren.delete(child));
        }
      } catch (error) {
        settled = true;
        pendingCancellations.delete(cancel);
        reject(error);
      }
    });
  }

  async function inventory() {
    requireActive();
    if (platform !== "win32") throw new Error("Native app management is supported on Windows.");
    const response = await execute(INVENTORY_SCRIPT);
    return {
      apps: Array.isArray(response.apps) ? response.apps : [],
      processes: Array.isArray(response.processes) ? response.processes : [],
    };
  }

  function appInfo(id, snapshot, error = null) {
    const processes = snapshot.processes.filter((item) => validProcess(id, item));
    const currentOwned = owned.get(id);
    for (const [pid, expected] of currentOwned) {
      if (!processes.some((item) => sameProcess(expected, item))) currentOwned.delete(pid);
    }
    const registration = snapshot.apps.find((item) => knownAppId(id, item.AppID));
    const appPath = processes[0]?.path;
    if (registration || appPath) {
      launchers.set(id, {
        ...(launchers.get(id) || {}),
        ...(registration ? { appId: registration.AppID } : {}),
        ...(appPath ? { path: appPath } : {}),
      });
    }
    const launcher = launchers.get(id) || {};
    return {
      installed: Boolean(launcher.appId || launcher.path),
      running: processes.length > 0,
      managed: currentOwned.size > 0,
      pids: processes.map((item) => item.pid),
      ...launcher,
      error,
    };
  }

  function snapshotInfo(snapshot) {
    return Object.fromEntries(APP_IDS.map((id) => [id, appInfo(id, snapshot)]));
  }

  function serialize(action) {
    if (disposed) return Promise.reject(new Error("App manager is closed."));
    const result = operation.then(() => {
      requireActive();
      return action();
    });
    operation = result.catch(() => {});
    return result;
  }

  async function startDesktop(info) {
    requireActive();
    const packaged = Boolean(info.appId);
    const child = spawn(packaged ? "explorer.exe" : info.path,
      packaged ? [`shell:AppsFolder\\${info.appId}`] : [], {
        detached: true,
        stdio: "ignore",
        // Explorer is only the launcher. Direct GUI executables need a visible window.
        windowsHide: packaged,
      });
    child.unref();
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        pendingCancellations.delete(cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish(new Error("App manager is closed."));
      pendingCancellations.add(cancel);
      // Keep the error listener until the launcher emits, including after cancel,
      // so an asynchronous spawn failure cannot become an unhandled event.
      child.once("error", finish);
      child.once("spawn", () => finish());
    });
    return packaged ? null : child.pid;
  }

  async function launch(id) {
    requireId(id);
    return serialize(async () => {
      const before = await inventory();
      const info = appInfo(id, before);
      if (info.running) return info;
      if (!info.installed) throw new Error(`${APP_NAMES[id]} desktop app is not installed or could not be found.`);
      const directPid = await startDesktop(info);
      const startedAt = Date.now();
      let latest = before;
      do {
        latest = await inventory();
        const candidates = latest.processes.filter((item) => validProcess(id, item));
        if (candidates.length) {
          const candidatePids = new Set(candidates.map((item) => item.pid));
          const roots = candidates.filter((item) => !candidatePids.has(item.parentPid)
            && (directPid === null || item.pid === directPid));
          for (const item of roots) owned.get(id).set(item.pid, { ...item });
          return appInfo(id, latest, roots.length ? null : "The app opened, but its process ownership could not be confirmed.");
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() - startedAt < 6000);
      return appInfo(id, latest, "Launch was requested, but no matching desktop app process was detected.");
    });
  }

  async function closeApp(id, refuseExternal) {
    const before = await inventory();
    const info = appInfo(id, before);
    const roots = [...owned.get(id).values()];
    if (!roots.length && info.running && refuseExternal) {
      throw new Error(`${APP_NAMES[id]} was opened outside this manager. Only apps launched here can be closed here.`);
    }
    const errors = [];
    for (const expected of roots) {
      try {
        await execute(CLOSE_SCRIPT, {
          CODEX_CLAUDE_BRIDGE_OWNED_APP: JSON.stringify({ ...expected, app: id }),
        });
      } catch (error) { errors.push(errorMessage(error)); }
    }
    return appInfo(id, await inventory(), errors.length ? errors.join("\n") : null);
  }

  return {
    async list() {
      try { return snapshotInfo(await inventory()); }
      catch (error) {
        return Object.fromEntries(APP_IDS.map((id) => [id, {
          installed: false, running: false, managed: false, pids: [], error: errorMessage(error),
        }]));
      }
    },
    launch,
    close(id) {
      requireId(id);
      return serialize(() => closeApp(id, true));
    },
    closeOwned() {
      return serialize(async () => {
        const result = {};
        for (const id of APP_IDS) {
          try { result[id] = await closeApp(id, false); }
          catch (error) { result[id] = { error: errorMessage(error) }; }
        }
        return result;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // These handles belong only to PowerShell helpers created by execute().
      // Native app and Explorer launcher handles are never retained here.
      for (const child of helperChildren) {
        if (child.exitCode == null && child.signalCode == null && !child.killed) {
          try { child.kill(); } catch { /* It may have exited between snapshots. */ }
        }
      }
      helperChildren.clear();
      for (const cancel of [...pendingCancellations]) cancel();
    },
  };
}
