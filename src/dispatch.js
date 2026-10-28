// Outcome-driven coordination: the user is the client. A coordinator (chosen by the user) turns the request into
// checkable acceptance criteria and assigns each step to the agent best suited for it; the work is reviewed against
// those criteria and returned for revision until it passes or the revision rounds run out.
// Quota never decides the roles; it only hands a role to the other agent when one actually runs out.

export const AGENTS = ["codex", "claude"];
export const AGENT_NAMES = { codex: "Codex", claude: "Claude" };
export const DEFAULT_COORDINATOR = "codex";
export const MAX_REVISION_ROUNDS = 2;
const UNKNOWN_REMAINING = 50;
const RECHECK_MS = 30 * 60 * 1000;

export function otherAgent(agent) { return agent === "codex" ? "claude" : "codex"; }
/** Older rooms and tasks have no coordinator; unknown values fall back to the default. */
export function normalizeCoordinator(value) { return AGENTS.includes(value) ? value : DEFAULT_COORDINATOR; }

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    kind: { type: "string", enum: ["answer", "review", "change"] },
    steps: {
      type: "array", minItems: 1, maxItems: 4,
      items: {
        type: "object",
        properties: { title: { type: "string" }, instruction: { type: "string" }, agent: { type: "string", enum: AGENTS } },
        required: ["title", "instruction", "agent"], additionalProperties: false,
      },
    },
    acceptance: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
  },
  required: ["summary", "kind", "steps", "acceptance"],
  additionalProperties: false,
};

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "revise"] },
    criteria: {
      type: "array",
      items: { type: "object", properties: { criterion: { type: "string" }, met: { type: "boolean" }, note: { type: "string" } }, required: ["criterion", "met", "note"], additionalProperties: false },
    },
    issues: {
      type: "array",
      items: { type: "object", properties: { step: { type: "integer" }, problem: { type: "string" }, fix: { type: "string" } }, required: ["step", "problem", "fix"], additionalProperties: false },
    },
    reply: { type: "string" },
  },
  required: ["verdict", "criteria", "issues", "reply"],
  additionalProperties: false,
};

function text(field) { return typeof field === "string" && field.trim() ? field.trim() : ""; }
function jsonObject(output) {
  if (output && typeof output === "object") return output;
  const source = String(output ?? "");
  try { return JSON.parse(source); } catch { /* fall through to an embedded object */ }
  const match = source.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}
/** Saved plans from earlier versions used a single acceptance string. */
export function acceptanceList(value) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return items.map(text).filter(Boolean).slice(0, 8);
}

/** Strict validation for schema-backed (Codex) planning output; steps without a valid agent go to the non-coordinator. */
export function validatePlan(output, { coordinator = DEFAULT_COORDINATOR } = {}) {
  let value;
  try { value = typeof output === "string" ? JSON.parse(output) : output; } catch { throw new Error("Planner returned an invalid planning response: expected JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !text(value.summary) || !["answer", "review", "change"].includes(value.kind)
    || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 4
    || !(typeof value.acceptance === "string" || Array.isArray(value.acceptance))
    || value.steps.some((step) => !step || !text(step.title) || !text(step.instruction))) {
    throw new Error("Planner returned an invalid planning response: summary, kind, 1–4 steps and acceptance are required.");
  }
  const fallbackAgent = otherAgent(normalizeCoordinator(coordinator));
  return { summary: value.summary.trim(), kind: value.kind, acceptance: acceptanceList(value.acceptance),
    steps: value.steps.map((step) => ({ title: step.title.trim().slice(0, 120), instruction: step.instruction.trim().slice(0, 4000),
      agent: AGENTS.includes(step.agent) ? step.agent : fallbackAgent })) };
}

/** Lenient parsing for free-text (Claude) planning: extract the JSON object, else one step covering the request. */
export function lenientPlan(output, request, { coordinator = DEFAULT_COORDINATOR } = {}) {
  const value = jsonObject(output);
  if (value) { try { return validatePlan(value, { coordinator }); } catch { /* fall through */ } }
  return { summary: "我會直接處理這則訊息。", kind: "change", acceptance: [], fallback: true,
    steps: [{ title: "處理需求", instruction: request, agent: otherAgent(normalizeCoordinator(coordinator)) }] };
}

/**
 * Review output from either agent. A review that cannot be read is treated as a pass whose reply is the raw text,
 * so an unreadable verdict never loops; "revise" without concrete issues is also a pass.
 */
export function parseReview(output, stepCount = 1) {
  const value = jsonObject(output);
  if (!value || !["pass", "revise"].includes(value.verdict)) {
    const raw = String(output ?? "").trim();
    return { verdict: "pass", criteria: [], issues: [], reply: /^\s*[[{]/.test(raw) ? "" : raw, fallback: true };
  }
  const criteria = (Array.isArray(value.criteria) ? value.criteria : []).filter((item) => item && text(item.criterion))
    .map((item) => ({ criterion: text(item.criterion).slice(0, 300), met: item.met === true, note: text(item.note).slice(0, 600) }));
  const issues = (Array.isArray(value.issues) ? value.issues : []).filter((item) => item && text(item.problem))
    .map((item) => {
      const step = Number.isInteger(item.step) && item.step >= 1 && item.step <= stepCount ? item.step : 0;
      return { step, problem: text(item.problem).slice(0, 1000), fix: text(item.fix).slice(0, 1000) };
    }).slice(0, 12);
  const verdict = value.verdict === "revise" && issues.length ? "revise" : "pass";
  return { verdict, criteria, issues, reply: text(value.reply) };
}

function window(quota, key) { const value = quota?.[key]; return value && Number.isFinite(value.usedPercent) ? value : null; }

/**
 * Availability of one agent now. `exhausted` is the run's own record of a limit hit; a quota snapshot at 100%
 * with a future reset also counts. Unknown quota is treated as usable (remaining assumed 50%).
 */
export function agentState(agent, { quotas = {}, exhausted = {}, now = Date.now() } = {}) {
  const hit = exhausted[agent];
  const hitUntil = hit?.until ? Date.parse(hit.until) : NaN;
  if (hit && (!Number.isFinite(hitUntil) || hitUntil > now)) return { available: false, remaining: 0, until: Number.isFinite(hitUntil) ? hit.until : null, reason: "limit" };
  const quota = quotas[agent];
  for (const key of ["primary", "secondary"]) {
    const value = window(quota, key);
    const reset = value?.resetsAt ? Date.parse(value.resetsAt) : NaN;
    if (value && value.usedPercent >= 100 && (!Number.isFinite(reset) || reset > now)) return { available: false, remaining: 0, until: Number.isFinite(reset) ? value.resetsAt : null, reason: "quota" };
  }
  const primary = window(quota, "primary");
  const reset = primary?.resetsAt ? Date.parse(primary.resetsAt) : NaN;
  const lapsed = Number.isFinite(reset) && reset <= now;
  return { available: true, remaining: primary && !lapsed ? Math.max(0, 100 - primary.usedPercent) : lapsed ? 100 : UNKNOWN_REMAINING, known: Boolean(primary), until: null };
}

/**
 * The agent that takes a role now: the preferred agent while it is available, otherwise the other one.
 * A forced workflow keeps its agent and never spills over. `agent` is null when nobody can take the role.
 */
export function pickAgent({ preferred, forced = null, ...context } = {}) {
  const states = Object.fromEntries(AGENTS.map((agent) => [agent, agentState(agent, context)]));
  const candidates = forced ? [forced] : [AGENTS.includes(preferred) ? preferred : DEFAULT_COORDINATOR, otherAgent(AGENTS.includes(preferred) ? preferred : DEFAULT_COORDINATOR)];
  return { states, agent: candidates.find((agent) => states[agent].available) ?? null };
}

/** One line for the composer and stage notes, e.g. "Codex 統籌與審查 · 依任務指派執行". */
export function describeCoordination(coordinator, states = {}) {
  const lead = normalizeCoordinator(coordinator);
  const other = otherAgent(lead);
  const available = (agent) => states[agent]?.available !== false;
  if (!available(lead) && !available(other)) return "兩邊額度都已用盡";
  if (!available(lead)) return `${AGENT_NAMES[lead]} 額度已用盡，改由 ${AGENT_NAMES[other]} 統籌`;
  if (!available(other)) return `${AGENT_NAMES[other]} 額度已用盡，由 ${AGENT_NAMES[lead]} 統籌並執行`;
  return `${AGENT_NAMES[lead]} 統籌與審查 · 依任務指派執行`;
}

const QUOTA_PATTERNS = /usage limit|limit (?:has been )?reached|hit your (?:usage )?limit|quota (?:exceeded|exhausted)|insufficient_quota|out of (?:usage|credits)|(?:5|five)[- ]hour limit|weekly limit|額度已(?:用完|用盡)|rate_limit_exceeded/i;
const TRANSIENT_PATTERNS = /\b429\b|too many requests|rate limit|overloaded|\b529\b|temporarily unavailable|ECONNRESET|ETIMEDOUT|network/i;
const AUTH_PATTERNS = /not logged in|log ?in required|login required|unauthori[sz]ed|authentication|invalid api key|sign in/i;

/** Classifies a stage failure so only real quota exhaustion triggers a handoff. */
export function classifyFailure(error) {
  if (!error || error.name === "AbortError") return "cancelled";
  const text = `${error.message || ""}\n${error.output || ""}\n${error.stderr || ""}`;
  if (AUTH_PATTERNS.test(text)) return "auth";
  if (QUOTA_PATTERNS.test(text) || error.quotaRejected === true) return "quota";
  if (TRANSIENT_PATTERNS.test(text)) return "transient";
  return "other";
}

/** Earliest moment worth re-checking: the soonest known reset, else a fixed re-check interval. */
export function nextResumeAt(states, now = Date.now()) {
  const resets = Object.values(states || {}).map((state) => Date.parse(state?.until)).filter((value) => Number.isFinite(value) && value > now);
  return new Date(resets.length ? Math.min(...resets) + 60_000 : now + RECHECK_MS).toISOString();
}

export class QuotaPausedError extends Error {
  constructor(message, { dispatch, resumeAt, stages } = {}) {
    super(message);
    this.name = "QuotaPausedError";
    this.code = "QUOTA_PAUSED";
    this.dispatch = dispatch;
    this.resumeAt = resumeAt;
    this.stages = stages;
  }
}
