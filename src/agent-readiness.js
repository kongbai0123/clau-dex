// Derives one participant's readiness for the Agent management UI from provider metadata and the
// latest status probe. Pure: no I/O, no mutation, and no dependency on desktop App liveness or past
// task results. "ready" means the local CLI can be invoked, not that the cloud account will accept work.
// Reasons are static text so arbitrary probe errors never reach the UI through this helper.

const APP_CREDENTIAL_TEXT = Object.freeze({
  true: "偵測到憑證（有效性未驗證）",
  false: "未偵測到登入憑證，請先在 App 登入",
  unknown: "憑證狀態待確認"
});
const CLI_CREDENTIAL_TEXT = Object.freeze({ true: "CLI 已登入", false: "需要登入", unknown: "登入待確認" });

function credentialText(viaApp, value) {
  const table = viaApp ? APP_CREDENTIAL_TEXT : CLI_CREDENTIAL_TEXT;
  return value === true ? table.true : value === false ? table.false : table.unknown;
}

function result(code, text, type, canSend, reason, credential, action) {
  return { code, text, type, canSend, reason, credentialText: credential, action };
}

export function deriveAgentReadiness(provider = {}, agent = {}, context = {}) {
  const meta = provider || {};
  const status = agent || {};
  const { loaded = true, apiError = null, shuttingDown = false } = context || {};
  const viaApp = meta.signInWith === "app";
  const observed = viaApp ? status.credentialPresent : status.authenticated;

  if (!loaded || apiError) {
    return result("unknown", "狀態待確認", "muted", false, "尚未取得最新狀態，暫時無法確認是否可傳送。", credentialText(viaApp, null), "none");
  }
  const credential = credentialText(viaApp, observed);
  if (shuttingDown) {
    return result("stopping", "正在關閉", "muted", false, "Bridge 正在關閉，暫停傳送新訊息。", credential, "none");
  }
  if (meta.tasks === false) {
    return result("unsupported", "不支援對話", "muted", false, "此參與者不支援接收對話任務。", credential, "none");
  }
  const available = status.available === true;
  if (status.error === "正在檢查連線" && !available) {
    return result("checking", "正在檢查連線", "warning", false, "正在檢查 CLI 連線，完成後即可確認狀態。", credential, "none");
  }
  if (!available) {
    return result("unavailable", "CLI 不可用", "muted", false, "找不到可用的 CLI，請執行診斷確認安裝與路徑。", credential, "diagnose");
  }
  if (status.login?.state === "pending") {
    return result("signing-in", viaApp ? "等待在 App 內登入…" : "等待瀏覽器授權…", "warning", false,
      viaApp ? "請在 App 內完成登入。" : "請在瀏覽器完成授權。", credential, "none");
  }
  if (!viaApp && status.authenticated === false) {
    return result("needs-login", "需要登入", "warning", false, "CLI 尚未登入，請先登入後再傳送。", credential, "login");
  }
  const signedIn = !viaApp && status.authenticated === true;
  return result("ready", signedIn ? "CLI 已登入" : "CLI 可用", "ready", true,
    signedIn ? "CLI 可在本機執行且已登入；雲端服務仍可能拒絕請求。" : "CLI 可在本機執行；登入有效性需實際傳送後才能確認。",
    credential, "chat");
}
