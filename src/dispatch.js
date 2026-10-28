// Outcome-driven coordination: the user is the client. A coordinator (chosen by the user) turns the request into
// checkable acceptance criteria and assigns each step to the agent best suited for it; the work is reviewed against
// those criteria and returned for revision until it passes or the revision rounds run out.
// Quota never decides the roles; it only hands a role to the other agent when one actually runs out.

import { COORDINATORS, PROVIDERS, TASK_AGENTS, providerName } from "./providers.js";

/** Agents that can take chat tasks; COORDINATORS can also plan and review. */
export const AGENTS = TASK_AGENTS;
export { COORDINATORS };
export const AGENT_NAMES = Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, providerName(id)]));
export const DEFAULT_COORDINATOR = "codex";
export const MAX_REVISION_ROUNDS = 2;
const UNKNOWN_REMAINING = 50;
const RECHECK_MS = 30 * 60 * 1000;

export function otherAgent(agent) { return agent === "codex" ? "claude" : "codex"; }
/** Older rooms and tasks have no coordinator; unknown values fall back to the default. */
export function normalizeCoordinator(value) { return COORDINATORS.includes(value) ? value : DEFAULT_COORDINATOR; }

/**
 * The agents taking part in a conversation, in registry order. Older rooms and tasks only stored a workflow:
 * "coordinated" meant both coordinators, and a single agent's workflow meant that agent alone.
 */
export function normalizeParticipants(value, workflow = "coordinated") {
  if (Array.isArray(value)) {
    const chosen = AGENTS.filter((agent) => value.includes(agent));
    if (chosen.length) return chosen;
  }
  return AGENTS.includes(workflow) ? [workflow] : [...COORDINATORS];
}
/** Throws for a participant list the user cannot run: unknown agents, none, or a team without a coordinator. */
export function validateParticipants(value) {
  if (!Array.isArray(value) || !value.length || value.some((agent) => !AGENTS.includes(agent)) || new Set(value).size !== value.length) {
    throw new Error("請至少選擇一個可用的 AI。");
  }
  if (value.length > 1 && !value.some((agent) => COORDINATORS.includes(agent))) throw new Error("多個 AI 協作時，至少要選擇 Codex 或 Claude 擔任統籌。");
  return normalizeParticipants(value);
}
/** One agent alone is its own workflow; two or more are coordinated. */
export function workflowFor(participants) { return participants.length === 1 ? participants[0] : "coordinated"; }
/** The coordinator must be a participant that can coordinate; otherwise the first such participant leads. */
export function coordinatorFor(coordinator, participants) {
  const candidates = participants.filter((agent) => COORDINATORS.includes(agent));
  return candidates.includes(coordinator) ? coordinator : candidates[0] ?? normalizeCoordinator(coordinator);
}

/** The planning schema whose step agents are limited to this conversation's participants. */
export function planSchema(participants = COORDINATORS) {
  const schema = structuredClone(PLAN_SCHEMA);
  schema.properties.steps.items.properties.agent.enum = normalizeParticipants(participants);
  return schema;
}

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    kind: { type: "string", enum: ["answer", "review", "change"] },
    steps: {
      type: "array", minItems: 1, maxItems: 4,
      items: {
        type: "object",
        properties: { title: { type: "string" }, instruction: { type: "string" }, agent: { type: "string", enum: [...COORDINATORS] } },
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

/** Who executes a step the plan did not assign to a participant: another participant, else the coordinator itself. */
export function fallbackExecutor(coordinator, participants = COORDINATORS) {
  const lead = normalizeCoordinator(coordinator);
  return participants.find((agent) => agent !== lead) ?? lead;
}

/** Strict validation for schema-backed (Codex) planning output; steps without a participating agent go to a fallback executor. */
export function validatePlan(output, { coordinator = DEFAULT_COORDINATOR, participants = COORDINATORS } = {}) {
  let value;
  try { value = typeof output === "string" ? JSON.parse(output) : output; } catch { throw new Error("Planner returned an invalid planning response: expected JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !text(value.summary) || !["answer", "review", "change"].includes(value.kind)
    || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 4
    || !(typeof value.acceptance === "string" || Array.isArray(value.acceptance))
    || value.steps.some((step) => !step || !text(step.title) || !text(step.instruction))) {
    throw new Error("Planner returned an invalid planning response: summary, kind, 1–4 steps and acceptance are required.");
  }
  const fallbackAgent = fallbackExecutor(coordinator, participants);
  return { summary: value.summary.trim(), kind: value.kind, acceptance: acceptanceList(value.acceptance),
    steps: value.steps.map((step) => ({ title: step.title.trim().slice(0, 120), instruction: step.instruction.trim().slice(0, 4000),
      agent: participants.includes(step.agent) ? step.agent : fallbackAgent })) };
}

/** Lenient parsing for free-text (Claude) planning: extract the JSON object, else one step covering the request. */
export function lenientPlan(output, request, { coordinator = DEFAULT_COORDINATOR, participants = COORDINATORS } = {}) {
  const value = jsonObject(output);
  if (value) { try { return validatePlan(value, { coordinator, participants }); } catch { /* fall through */ } }
  return { summary: "我會直接處理這則訊息。", kind: "change", acceptance: [], fallback: true,
    steps: [{ title: "處理需求", instruction: request, agent: fallbackExecutor(coordinator, participants) }] };
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
 * The agent that takes a role now: the preferred agent while it is available, otherwise the next participant that
 * can take the role (only coordinators plan and review). A forced workflow keeps its agent and never spills over.
 * `agent` is null when nobody can take the role.
 */
export function pickAgent({ preferred, forced = null, participants = COORDINATORS, role = "execute", ...context } = {}) {
  const team = forced ? [forced] : participants;
  const states = Object.fromEntries(team.map((agent) => [agent, agentState(agent, context)]));
  const pool = forced ? [forced] : team.filter((agent) => role !== "coordinate" || COORDINATORS.includes(agent));
  const first = pool.includes(preferred) ? preferred : pool.includes(DEFAULT_COORDINATOR) ? DEFAULT_COORDINATOR : pool[0];
  const candidates = first ? [first, ...pool.filter((agent) => agent !== first)] : [];
  return { states, agent: candidates.find((agent) => states[agent].available) ?? null };
}

/** One line for the composer and stage notes, e.g. "Codex 統籌與審查 · 依任務指派執行". */
export function describeCoordination(coordinator, states = {}, participants = COORDINATORS) {
  const lead = normalizeCoordinator(coordinator);
  const available = (agent) => states[agent]?.available !== false;
  const others = participants.filter((agent) => agent !== lead);
  const usable = others.filter(available);
  const names = (agents) => agents.map((agent) => AGENT_NAMES[agent]).join("、");
  if (!available(lead) && !usable.length) return others.length ? "所有 AI 額度都已用盡" : `${AGENT_NAMES[lead]} 額度已用盡`;
  if (!available(lead)) {
    const next = usable.find((agent) => COORDINATORS.includes(agent));
    return next ? `${AGENT_NAMES[lead]} 額度已用盡，改由 ${AGENT_NAMES[next]} 統籌` : `${AGENT_NAMES[lead]} 額度已用盡，等待恢復後統籌`;
  }
  if (others.length && !usable.length) return `${names(others)} 額度已用盡，由 ${AGENT_NAMES[lead]} 統籌並執行`;
  return `${AGENT_NAMES[lead]} 統籌與審查 · 依任務指派${others.length > 1 ? ` ${names(usable)} ` : ""}執行`;
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
