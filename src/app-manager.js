import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { PROVIDER_IDS, PROVIDERS } from "./providers.js";

const APP_IDS = PROVIDER_IDS;
const APP_NAMES = Object.fromEntries(APP_IDS.map((id) => [id, PROVIDERS[id].appName]));
// A short process-survival check; it does not prove that the app's UI is ready.
const STARTUP_SETTLE_MS = 3000;
const INVENTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$apps = @(Get-StartApps | Where-Object {
  $_.AppID -match '^OpenAI\.Codex_[A-Za-z0-9]+![A-Za-z0-9._-]+$' -or
  $_.AppID -match '^Claude_[A-Za-z0-9]+!Claude$' -or
  $_.AppID -match '^(?:Google\.Antigravity|com\.google\.antigravity)$'
} | Select-Object Name, AppID)
# Unpackaged apps launch through a Start menu shortcut; skip ones whose target was moved or removed.
$menus = @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$shell = $null; $wsh = $null
# Rank: 2 = working shortcut or packaged, 1 = no shortcut found, 0 = broken shortcut (dropped).
$index = 0
$apps = @($apps | ForEach-Object {
  $index++; $rank = 2
  if ($_.AppID -notmatch '!') {
    if (-not $shell) { $shell = New-Object -ComObject Shell.Application; $wsh = New-Object -ComObject WScript.Shell }
    $id = $_.AppID
    $links = @(Get-ChildItem -LiteralPath $menus -Recurse -Filter ($_.Name + '.lnk') -ErrorAction SilentlyContinue | Where-Object {
      [string]$shell.Namespace($_.DirectoryName).ParseName($_.Name).ExtendedProperty('System.AppUserModel.ID') -ieq $id
    })
    if (-not $links.Count) { $rank = 1 }
    elseif (-not @($links | Where-Object { $target = $wsh.CreateShortcut($_.FullName).TargetPath; -not $target -or (Test-Path -LiteralPath $target) }).Count) { $rank = 0 }
  }
  if ($rank) { [pscustomobject]@{ Name = $_.Name; AppID = $_.AppID; Rank = $rank; Index = $index } }
} | Sort-Object @{ Expression = 'Rank'; Descending = $true }, Index | Select-Object Name, AppID)
function Test-BridgeNodeHost([string]$commandLine) {
  # Keep command-line values local. Only the role bit goes back to the manager.
  # A .js filename alone is not evidence: GUI apps can open JavaScript files.
  $commandTokens = @([regex]::Matches($commandLine, '(?:[^\s"]+|"[^"]*")+') | ForEach-Object { $_.Value.Trim('"') })
  foreach ($commandToken in ($commandTokens | Select-Object -Skip 1)) {
    if ($commandToken -eq '--') { break }
    if ($commandToken -match '^(?:--(?:import|require|eval|input-type)(?:=|$)|-(?:r|e)(?:=|$)|--ms-enable-electron-run-as-node(?:=|$))') { return $true }
  }
  return $false
}
# Sidecars can re-run the app executable through helpers (app -> language server -> cmd -> app).
# Only PIDs travel back; a parent created after its child is a reused PID and ends the walk.
$tree = @{}
Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate | ForEach-Object { $tree[[int]$_.ProcessId] = $_ }
function Get-BridgeAncestors($process) {
  $chain = New-Object System.Collections.Generic.List[int]
  $current = $process
  for ($depth = 0; $depth -lt 12; $depth++) {
    $parent = $tree[[int]$current.ParentProcessId]
    if (-not $parent -or $chain.Contains([int]$parent.ProcessId) -or [int]$parent.ProcessId -eq [int]$process.ProcessId) { break }
    if ($parent.CreationDate -and $current.CreationDate -and $parent.CreationDate -gt $current.CreationDate) { break }
    $chain.Add([int]$parent.ProcessId); $current = $parent
  }
  return ,$chain.ToArray()
}
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe' OR Name = 'Codex.exe' OR Name = 'Claude.exe' OR Name = 'Antigravity.exe'" | ForEach-Object {
  [ordered]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    ancestors = Get-BridgeAncestors $_
    name = [string]$_.Name
    path = [string]$_.ExecutablePath
    type = [regex]::Match([string]$_.CommandLine, '(?:^|\s)"?--type=([^\s"]+)').Groups[1].Value
    nodeHost = Test-BridgeNodeHost ([string]$_.CommandLine)
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
if (@('codex', 'claude', 'antigravity') -notcontains $expected.app) { throw 'Unknown managed app.' }
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

// Antigravity's agent app, not the separate Antigravity IDE.
const APP_ID_PATTERNS = {
  codex: /^OpenAI\.Codex_[A-Za-z0-9]+![A-Za-z0-9._-]+$/i,
  claude: /^Claude_[A-Za-z0-9]+!Claude$/i,
  antigravity: /^(?:Google\.Antigravity|com\.google\.antigravity)$/i,
};

function knownAppId(id, value) {
  return typeof value === "string" && Boolean(APP_ID_PATTERNS[id]?.test(value));
}

function knownDesktopPath(id, value) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value)) return false;
  const normalized = path.win32.normalize(value);
  if (id === "codex") {
    return /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$/i.test(normalized)
      || /\\(?:OpenAI\\Codex|Programs\\Codex)\\(?:app-[\d.]+\\)?Codex\.exe$/i.test(normalized);
  }
  if (id === "antigravity") return /\\Programs\\Antigravity\\Antigravity\.exe$/i.test(normalized);
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

// Older controlled snapshots omit nodeHost; preserve that compatibility while
// excluding positively identified Node hosts and Chromium child processes.
function guiProcess(item) { return !item.type && item.nodeHost !== true; }

// A root has no GUI process of the same app anywhere above it. Older snapshots only carry parentPid.
function rootProcess(item, guiPids) {
  const ancestors = Array.isArray(item.ancestors) ? item.ancestors : [item.parentPid];
  return !ancestors.some((pid) => guiPids.has(pid));
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
  startupSettleMs = STARTUP_SETTLE_MS,
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
    if (!APP_IDS.includes(id)) throw new Error(`Unknown app. Choose ${APP_IDS.join(", ")}.`);
  }

  function pause(milliseconds) {
    return new Promise((resolve, reject) => {
      requireActive();
      const timer = setTimeout(() => { pendingCancellations.delete(cancel); resolve(); }, milliseconds);
      const cancel = () => {
        clearTimeout(timer); pendingCancellations.delete(cancel);
        reject(new Error("App manager is closed."));
      };
      pendingCancellations.add(cancel);
    });
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
    const guiProcesses = processes.filter(guiProcess);
    const pids = new Set(guiProcesses.map((item) => item.pid));
    const roots = guiProcesses.filter((item) => rootProcess(item, pids));
    const currentOwned = owned.get(id);
    for (const [pid, expected] of currentOwned) {
      if (!processes.some((item) => guiProcess(item) && sameProcess(expected, item))) currentOwned.delete(pid);
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
      running: roots.length > 0,
      managed: currentOwned.size > 0,
      pids: processes.map((item) => item.pid),
      rootProcesses: roots.map(({ pid, created }) => ({ pid, created })),
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
        requireActive();
        const candidates = latest.processes.filter((item) => validProcess(id, item));
        const guiCandidates = candidates.filter(guiProcess);
        const candidatePids = new Set(guiCandidates.map((item) => item.pid));
        const roots = guiCandidates.filter((item) => rootProcess(item, candidatePids)
          && (directPid === null || item.pid === directPid));
        if (roots.length) {
          await pause(startupSettleMs);
          latest = await inventory();
          requireActive();
          const survived = roots.filter((root) => latest.processes.some((item) => validProcess(id, item) && guiProcess(item) && sameProcess(root, item)));
          if (!survived.length) return { ...appInfo(id, latest, "The app started but quit right away, or its process identity changed. Check the app's own logs."), running: false };
          for (const item of survived) owned.get(id).set(item.pid, { ...item });
          return appInfo(id, latest);
        }
        await pause(250);
      } while (Date.now() - startedAt < 6000);
      return appInfo(id, latest, "Launch was requested, but the app was not seen running. It may have quit right away on startup; check the app's own logs.");
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
