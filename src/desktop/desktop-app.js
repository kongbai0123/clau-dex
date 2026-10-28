import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopServices } from "./services.js";
import { resolveWorkspaceDirectory } from "../task-store.js";
const { app, BrowserWindow, dialog, ipcMain, Menu, protocol } = createRequire(import.meta.url)("electron");

protocol.registerSchemesAsPrivileged([{ scheme: "bridge-image", privileges: { standard: true, secure: true } }]);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function createDesktopApp(options = {}) {
  const dataDirectory = options.dataDirectory || path.join(projectRoot, ".bridge");
  mkdirSync(path.join(dataDirectory, "desktop-profile"), { recursive: true });
  mkdirSync(path.join(dataDirectory, "logs"), { recursive: true });
  // Local diagnostics: failed IPC calls and renderer errors, so send failures can be traced afterwards.
  const logFile = path.join(dataDirectory, "logs", "desktop.log");
  const log = (kind, detail) => { try { appendFileSync(logFile, `${new Date().toISOString()} [${kind}] ${String(detail).replace(/\s+/g, " ").slice(0, 2000)}\n`, "utf8"); } catch { /* logging must never break the app */ } };
  log("start", `pid ${process.pid}`);
  app.setPath("userData", path.join(dataDirectory, "desktop-profile"));
  app.setName("Codex Claude 協作管理器");
  if (!app.requestSingleInstanceLock()) { app.quit(); return null; }
  await app.whenReady();
  let window = null; let cleanupComplete = false; let closing = null; let updateTimer;
  const notify = () => {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => { if (window && !window.isDestroyed()) window.webContents.send("bridge:update", services.snapshot()); }, 60);
  };
  const services = createDesktopServices({ projectRoot, dataDirectory, port: options.port ?? 47931, runtime: options.runtime, appManager: options.appManager, usageMonitor: options.usageMonitor, onChange: notify });
  // Image URLs refer only to validated manager-owned uploads, never renderer file paths.
  protocol.handle("bridge-image", request => {
    try {
      const imageUrl = new URL(request.url);
      if (request.method !== "GET" || !["", "/"].includes(imageUrl.pathname) || imageUrl.search || imageUrl.hash || imageUrl.username || imageUrl.password || imageUrl.port) return new Response(null, { status: 400 });
      const attachment = services.attachmentStore.resolve(imageUrl.hostname);
      return new Response(readFileSync(attachment.path), { headers: { "Content-Type": attachment.mimeType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    } catch { return new Response(null, { status: 404 }); }
  });
  async function shutdown() {
    if (closing) return closing;
    closing = (async () => {
      if (window && !window.isDestroyed()) window.webContents.send("bridge:shutdown", true);
      try { await services.shutdown(); }
      finally {
        clearTimeout(updateTimer);
        protocol.unhandle("bridge-image");
        cleanupComplete = true;
        try { options.onShutdownComplete?.(services.snapshot()); } catch (error) { console.error("Shutdown observer failed:", error.message); }
        if (window && !window.isDestroyed()) window.destroy();
        app.quit();
      }
    })();
    return closing;
  }
  window = new BrowserWindow({
    width: 1180, height: 820, minWidth: 860, minHeight: 640, show: false,
    title: "Codex × Claude｜聊天室", backgroundColor: "#fafafa", autoHideMenuBar: true,
    webPreferences: { preload: path.join(projectRoot, "src", "desktop", "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const allowed = new Set(["getSnapshot", "refreshStatus", "createTask", "createConversation", "sendMessage", "resumeTask", "importImages", "deleteConversation", "cancelTask", "startBridge", "stopBridge", "loginAgent", "launchApp", "closeApp", "updateSettings"]);
  for (const name of allowed) ipcMain.handle(`bridge:${name}`, (event, ...args) => {
    if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) throw new Error("Invalid application context");
    const method = name === "getSnapshot" ? services.snapshot : services[name];
    try {
      const result = method(...args);
      if (result && typeof result.then === "function") return result.catch((error) => { log(`ipc:${name}`, error?.stack || error); throw error; });
      return result;
    } catch (error) { log(`ipc:${name}`, error?.stack || error); throw error; }
  });
  ipcMain.handle("bridge:selectWorkspace", async event => {
    if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) throw new Error("Invalid application context");
    const result = await dialog.showOpenDialog(window, { title: "選擇工作資料夾", properties: ["openDirectory"], defaultPath: services.snapshot().settings.workspace || path.dirname(projectRoot) });
    if (result.canceled) return null;
    const selected = resolveWorkspaceDirectory(result.filePaths[0]);
    services.updateSettings({ workspace: selected });
    return selected;
  });
  window.webContents.on("console-message", (event, legacyLevel, legacyMessage, legacyLine, legacySource) => {
    const level = event?.level ?? legacyLevel; const message = event?.message ?? legacyMessage;
    if (level === "error" || level === 3) log("renderer", `${message} (${event?.sourceId ?? legacySource ?? ""}:${event?.lineNumber ?? legacyLine ?? ""})`);
  });
  window.webContents.on("render-process-gone", (_event, details) => log("renderer-gone", JSON.stringify(details)));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.on("close", event => { if (!cleanupComplete) { event.preventDefault(); shutdown().catch(error => { dialog.showErrorBox("停止服務失敗", error.message); }); } });
  app.on("before-quit", event => { if (!cleanupComplete) { event.preventDefault(); shutdown().catch(() => {}); } });
  app.on("second-instance", () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "檔案", submenu: [{ label: "關閉管理器與服務", click: () => window.close() }] },
    { label: "編輯", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "檢視", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }] },
  ]));
  try {
    await window.loadFile(path.join(projectRoot, "ui", "index.html"));
    if (closing) { await closing; return null; }
    window.show();
    const initialSnapshot = await services.start();
    log("cli-status", JSON.stringify(initialSnapshot.agents));
    notify();
  } catch (error) {
    dialog.showErrorBox("管理器啟動失敗", error.message);
    await shutdown(); throw error;
  }
  return { window, services, shutdown };
}
