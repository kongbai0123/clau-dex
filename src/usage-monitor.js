import { open, readdir, stat } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

// Read-only views of the usage logs that Codex and Claude Code already keep on this computer.
// Nothing here reads credentials or contacts a provider.
const TAIL_BYTES = 512 * 1024;
const MAX_FILES = 300;
// Bounded work per refresh; later refreshes continue where earlier ones stopped.
const MAX_READ_PER_REFRESH = 8 * 1024 * 1024;
const MAX_INITIAL_BYTES_PER_FILE = 4 * 1024 * 1024;
const FIVE_HOURS = 5 * 60 * 60 * 1000;

const count = (value) => Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
const emptyTotals = () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
function startOfToday(now) { const date = new Date(now); date.setHours(0, 0, 0, 0); return date.getTime(); }
function parseLines(text) {
  return text.split(/\r?\n/).flatMap((line) => { if (!line.trim()) return []; try { return [JSON.parse(line)]; } catch { return []; } });
}
async function readRange(file, start, end) {
  const handle = await open(file, "r");
  try {
    const length = Math.max(0, end - start);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}
async function entries(directory) { try { return await readdir(directory, { withFileTypes: true }); } catch { return []; } }

/** Recursively lists .jsonl files modified at or after `since`, newest first. */
async function recentJsonl(root, since, { depth = 4, match = () => true } = {}) {
  const found = [];
  async function walk(directory, level) {
    await yieldToEventLoop();
    for (const entry of await entries(directory)) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && level < depth) await walk(full, level + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && match(entry.name)) {
        try { const info = await stat(full); if (info.mtimeMs >= since) found.push({ file: full, size: info.size, mtimeMs: info.mtimeMs }); } catch { /* removed meanwhile */ }
      }
    }
  }
  await walk(root, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
}

function windowInfo(value, observedMs) {
  if (!value || typeof value !== "object" || !Number.isFinite(value.used_percent)) return null;
  let resetsAt = null;
  if (Number.isFinite(value.resets_at)) resetsAt = new Date(value.resets_at * (value.resets_at < 1e12 ? 1000 : 1)).toISOString();
  else if (Number.isFinite(value.resets_in_seconds) && Number.isFinite(observedMs)) resetsAt = new Date(observedMs + value.resets_in_seconds * 1000).toISOString();
  return { usedPercent: Math.max(0, Math.min(100, value.used_percent)), windowMinutes: Number.isFinite(value.window_minutes) ? value.window_minutes : null, resetsAt };
}

/** Latest Codex plan quota (5-hour / weekly) and today's token totals from ~/.codex/sessions rollouts. */
const codexCache = new Map();
// Codex also logs other limit pools (e.g. limit_id "premium") whose windows can be null.
// Only events with a usable window count, and the main "codex" pool wins over others.
const usableLimits = (limits) => Boolean(limits && [limits.primary, limits.secondary].some((window) => Number.isFinite(window?.used_percent)));
const mainPool = (limits) => limits.limit_id === undefined || limits.limit_id === null || limits.limit_id === "codex";
export async function readCodexUsage({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), now = Date.now() } = {}) {
  const sessions = path.join(codexHome, "sessions");
  const today = startOfToday(now);
  const files = await recentJsonl(sessions, now - 8 * 24 * 60 * 60 * 1000, { match: (name) => name.startsWith("rollout-") });
  let quota = null;
  const totals = { ...emptyTotals(), sessions: 0 };
  for (const { file, size, mtimeMs } of files) {
    if (quota && mtimeMs < today) break;
    const cacheKey = `${file}:${size}:${mtimeMs}`;
    let counts = codexCache.get(cacheKey);
    if (!counts) {
      let events;
      try { events = parseLines(await readRange(file, Math.max(0, size - TAIL_BYTES), size)); } catch { continue; }
      // Keep only the two token_count events this view needs.
      const all = events.filter((event) => event?.type === "event_msg" && event.payload?.type === "token_count");
      const usable = all.filter((event) => usableLimits(event.payload.rate_limits));
      counts = [usable.findLast((event) => mainPool(event.payload.rate_limits)) || usable.at(-1), all.findLast((event) => event.payload.info?.total_token_usage)].filter(Boolean);
      for (const key of codexCache.keys()) if (key.startsWith(`${file}:`)) codexCache.delete(key);
      if (codexCache.size > 500) codexCache.clear();
      codexCache.set(cacheKey, counts);
      await yieldToEventLoop();
    }
    const withLimits = counts.find((event) => usableLimits(event.payload.rate_limits));
    if (withLimits) {
      const observedMs = Date.parse(withLimits.timestamp) || mtimeMs;
      const isMain = mainPool(withLimits.payload.rate_limits);
      if (!quota || (isMain && !quota.mainPool) || (isMain === quota.mainPool && observedMs > Date.parse(quota.observedAt))) {
        const limits = withLimits.payload.rate_limits;
        quota = { observedAt: new Date(observedMs).toISOString(), primary: windowInfo(limits.primary, observedMs),
          secondary: windowInfo(limits.secondary, observedMs), planType: typeof limits.plan_type === "string" ? limits.plan_type : null, mainPool: isMain };
      }
    }
    const latest = counts.findLast((event) => event.payload.info?.total_token_usage);
    if (mtimeMs >= today && latest) {
      const usage = latest.payload.info.total_token_usage;
      totals.inputTokens += count(usage.input_tokens); totals.cachedInputTokens += count(usage.cached_input_tokens);
      totals.outputTokens += count(usage.output_tokens); totals.sessions++;
    }
  }
  return { found: files.length > 0, quota, today: totals };
}

/** Incrementally parses Claude Code transcripts (~/.claude/projects) for today's and the last 5 hours' tokens. */
export function createClaudeUsageReader({ claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude") } = {}) {
  const cache = new Map();
  return async function readClaudeUsage({ now = Date.now() } = {}) {
    const since = Math.min(startOfToday(now), now - FIVE_HOURS);
    const files = await recentJsonl(path.join(claudeHome, "projects"), since, { depth: 5 });
    let budget = MAX_READ_PER_REFRESH;
    const seen = new Set();
    const today = { ...emptyTotals(), messages: 0 };
    const recent = { ...emptyTotals(), messages: 0 };
    const models = {};
    const hourly = Array.from({ length: 24 }, () => ({ inputTokens: 0, outputTokens: 0, messages: 0 }));
    for (const { file, size } of files) {
      let entry = cache.get(file);
      if (!entry || size < entry.offset) entry = { offset: Math.max(0, size - MAX_INITIAL_BYTES_PER_FILE), records: [], partial: "" };
      if (size > entry.offset && budget > 0) {
        const end = Math.min(size, entry.offset + budget);
        try {
          const text = entry.partial + await readRange(file, entry.offset, end);
          budget -= end - entry.offset;
          await yieldToEventLoop();
          const lastBreak = text.lastIndexOf("\n");
          entry.partial = lastBreak < 0 ? text : text.slice(lastBreak + 1);
          entry.offset = end;
          for (const record of parseLines(lastBreak < 0 ? "" : text.slice(0, lastBreak))) {
            const usage = record?.message?.usage;
            const at = Date.parse(record?.timestamp);
            if (record?.type !== "assistant" || !usage || !Number.isFinite(at)) continue;
            entry.records.push({ at, key: `${record.message.id || ""}:${record.requestId || ""}`, model: typeof record.message.model === "string" ? record.message.model : "",
              inputTokens: count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens),
              cachedInputTokens: count(usage.cache_read_input_tokens), outputTokens: count(usage.output_tokens) });
          }
        } catch { /* unreadable file; keep earlier records */ }
      }
      entry.records = entry.records.filter((record) => record.at >= since);
      cache.set(file, entry);
      for (const record of entry.records) {
        if (record.key !== ":" && seen.has(record.key)) continue;
        seen.add(record.key);
        for (const [bucket, include] of [[today, record.at >= startOfToday(now)], [recent, record.at >= now - FIVE_HOURS]]) {
          if (!include) continue;
          bucket.inputTokens += record.inputTokens; bucket.cachedInputTokens += record.cachedInputTokens; bucket.outputTokens += record.outputTokens; bucket.messages++;
        }
        if (record.at >= startOfToday(now)) {
          const hour = hourly[new Date(record.at).getHours()];
          hour.inputTokens += record.inputTokens; hour.outputTokens += record.outputTokens; hour.messages++;
          if (record.model && !record.model.startsWith("<")) models[record.model] = (models[record.model] || 0) + record.outputTokens;
        }
      }
    }
    for (const file of cache.keys()) if (!files.some((item) => item.file === file)) cache.delete(file);
    return { found: files.length > 0, today, recent5h: recent, models, hourly };
  };
}

export function createUsageMonitor(options = {}) {
  const readClaude = createClaudeUsageReader(options);
  let current = { checkedAt: null, codex: null, claude: null };
  async function refresh() {
    const [codex, claude] = await Promise.allSettled([readCodexUsage(options), readClaude()]);
    current = {
      checkedAt: new Date().toISOString(),
      codex: codex.status === "fulfilled" ? codex.value : { error: "無法讀取 Codex 本機紀錄。" },
      claude: claude.status === "fulfilled" ? claude.value : { error: "無法讀取 Claude Code 本機紀錄。" },
    };
    return current;
  }
  return { refresh, get: () => current };
}
