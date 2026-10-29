import { PROVIDER_IDS, PROVIDERS } from "./providers.js";

// Reasoning effort per agent, from each provider's registry entry. "auto" passes no flag, so each CLI keeps
// its own default. Codex: -c model_reasoning_effort=<level>; Claude Code and agy: --effort <level>.
export const EFFORT_LEVELS = Object.freeze(Object.fromEntries(PROVIDER_IDS.filter((id) => PROVIDERS[id].effort)
  .map((id) => [id, Object.freeze([...PROVIDERS[id].effort])])));

export const DEFAULT_EFFORT = Object.freeze(Object.fromEntries(Object.keys(EFFORT_LEVELS).map((id) => [id, "auto"])));

/** Returns an effort object with every provider that has levels, or throws for unknown values. */
export function normalizeEffort(value) {
  if (value === undefined || value === null) return { ...DEFAULT_EFFORT };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("無效的思考強度設定。");
  const result = { ...DEFAULT_EFFORT };
  for (const agent of Object.keys(EFFORT_LEVELS)) {
    if (value[agent] === undefined) continue;
    if (!EFFORT_LEVELS[agent].includes(value[agent])) throw new Error(`無效的 ${PROVIDERS[agent].name} 思考強度。`);
    result[agent] = value[agent];
  }
  return result;
}
