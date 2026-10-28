import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const CLAUDE_QUOTA_FRESH_MS = 5 * 60 * 1000;

function windowData(value, minutes) {
  if (!value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) return null;
  const reset = Date.parse(value.resetsAt);
  if (!Number.isFinite(reset)) return null;
  const observed = Date.parse(value.observedAt);
  return { usedPercent: value.usedPercent, windowMinutes: minutes, resetsAt: new Date(reset).toISOString(),
    ...(Number.isFinite(observed) ? { observedAt: new Date(observed).toISOString() } : {}) };
}

export function normalizeClaudeQuota(value) {
  if (!value || typeof value !== "object") return null;
  const observed = Date.parse(value.observedAt);
  if (!Number.isFinite(observed)) return null;
  const primary = windowData(value.primary, 300);
  const secondary = windowData(value.secondary, 10080);
  for (const window of [primary, secondary]) {
    if (window?.observedAt && Date.parse(window.observedAt) > observed) delete window.observedAt;
  }
  if (!primary && !secondary) return null;
  return { primary, secondary, observedAt: new Date(observed).toISOString(), source: "claude-cli" };
}

/** Stores only quota percentages and timestamps, never credentials or CLI transcripts. */
export function createClaudeQuotaCache(dataDirectory, { now = Date.now, onChange = () => {} } = {}) {
  const directory = path.resolve(dataDirectory);
  const file = path.join(directory, "claude-quota.json");
  let quota = null;
  let status = { state: "no-data", message: "尚未取得 Claude 方案額度。" };
  try {
    quota = normalizeClaudeQuota(JSON.parse(readFileSync(file, "utf8")));
    if (quota) status = { state: "ready", message: "已讀取上次額度，正在確認更新時間。" };
  } catch { /* Missing or corrupt quota cache does not prevent chatting. */ }

  function fresh() {
    if (!quota) return false;
    const age = now() - Date.parse(quota.observedAt);
    return age >= 0 && age < CLAUDE_QUOTA_FRESH_MS
      && [quota.primary, quota.secondary].filter(Boolean).every(window => Date.parse(window.resetsAt) > now()
        && now() - Date.parse(window.observedAt || quota.observedAt) >= 0
        && now() - Date.parse(window.observedAt || quota.observedAt) < CLAUDE_QUOTA_FRESH_MS);
  }
  function snapshot() {
    const stale = !fresh();
    return { quota: quota ? { ...quota, stale } : null,
      quotaStatus: { ...status, ...(quota && stale && status.state === "ready" ? { message: "顯示上次額度；等待最新資料。" } : {}) } };
  }
  function update(value) {
    const next = normalizeClaudeQuota(value);
    if (!next) return false;
    if (Date.parse(next.observedAt) > now() + 60_000) return false;
    if (quota && Date.parse(next.observedAt) < Date.parse(quota.observedAt)) return false;
    for (const key of ["primary", "secondary"]) {
      const previous = quota?.[key];
      if (!next[key] && previous && Date.parse(previous.resetsAt) > now()) {
        // Preserve the age of a known window absent from a partial CLI event.
        next[key] = { ...previous, observedAt: previous.observedAt || quota.observedAt };
      }
    }
    mkdirSync(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8"); renameSync(temporary, file); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
    quota = next; status = { state: "ready", message: "Claude 額度已更新。" }; onChange(); return true;
  }
  function setStatus(state, message) { status = { state, message: String(message).slice(0, 500) }; onChange(); }
  return { snapshot, fresh, update, setStatus, file };
}
