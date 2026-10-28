// Reasoning effort per agent. "auto" passes no flag, so each CLI keeps its own default.
export const EFFORT_LEVELS = Object.freeze({
  // Codex: -c model_reasoning_effort=<level>. Max/Ultra depend on the selected model.
  codex: Object.freeze(["auto", "low", "medium", "high", "xhigh", "max", "ultra"]),
  // Claude Code: --effort <level>.
  claude: Object.freeze(["auto", "low", "medium", "high", "xhigh", "max"]),
});

export const DEFAULT_EFFORT = Object.freeze({ codex: "auto", claude: "auto" });

/** Returns a complete { codex, claude } effort object, or throws for unknown values. */
export function normalizeEffort(value) {
  if (value === undefined || value === null) return { ...DEFAULT_EFFORT };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("無效的思考強度設定。");
  const result = { ...DEFAULT_EFFORT };
  for (const agent of Object.keys(EFFORT_LEVELS)) {
    if (value[agent] === undefined) continue;
    if (!EFFORT_LEVELS[agent].includes(value[agent])) throw new Error(`無效的 ${agent === "codex" ? "Codex" : "Claude"} 思考強度。`);
    result[agent] = value[agent];
  }
  return result;
}
