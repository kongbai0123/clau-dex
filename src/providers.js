// The AI providers Bridge knows about. Each one is driven only through its official CLI, which owns sign-in
// and credentials; Bridge never reads or stores them.
//   coordinate: can plan and review coordinated work.
//   tasks:      can receive chat tasks. A provider is listed before its task runner is verified so the App
//               manager can already show it and guide sign-in.
//   login:      arguments that start the CLI's own interactive sign-in in a visible console.
//   status:     arguments that report sign-in state; null when the CLI has no status command.
//   credentialTarget: Windows Credential Manager target the CLI writes after sign-in, checked by name only.
//   signInWith: "app" when the desktop app owns sign-in, so Bridge opens the app instead of a CLI console.
//   effort:     reasoning levels the CLI accepts ("auto" passes no flag); null when it has none.
//   quota:      where plan quota is read from, shown under the quota meters; null when it cannot be queried.
//   theme:      chart color with light/base/dark shades, plus ink/text/soft/line tints for avatars, chips and
//               messages (null tints keep the default theme).
// Every UI surface — participant chips, effort sliders, usage and quota rows, Agent management — is drawn
// from this list, so adding or removing an entry here is all a provider change needs on the UI side.
export const PROVIDERS = Object.freeze({
  codex: Object.freeze({ id: "codex", name: "Codex", appName: "Codex", cli: "codex", coordinate: true, tasks: true, images: true,
    login: ["login"], status: ["login", "status"],
    effort: ["auto", "low", "medium", "high", "xhigh", "max", "ultra"], quota: "資料來自最近一次工作階段",
    theme: { color: "#3f7cb4", shades: ["#a7c3df", "#3f7cb4", "#1f4c78"] } }),
  claude: Object.freeze({ id: "claude", name: "Claude", appName: "Claude Code", cli: "claude", coordinate: true, tasks: true, images: true,
    login: ["auth", "login"], status: ["auth", "status", "--json"],
    effort: ["auto", "low", "medium", "high", "xhigh", "max"], quota: "資料由 Claude CLI 取得",
    theme: { color: "#d0824f", shades: ["#edc3a6", "#d0824f", "#8f4d26"], ink: "#aa765e", text: "#8a6d55", soft: "#fcf3ec", line: "#e6c9b3" } }),
  antigravity: Object.freeze({ id: "antigravity", name: "Antigravity", appName: "Antigravity", cli: "agy", coordinate: false, tasks: true, images: false,
    // agy has no documented login or status command: an interactive session starts Google sign-in.
    // The desktop app runs the same Google sign-in and writes the same credential, so it works without agy.
    login: [], status: null, credentialTarget: "gemini:antigravity", signInWith: "app",
    effort: ["auto", "low", "medium", "high", "xhigh", "max"], quota: null,
    theme: { color: "#2f9488", shades: ["#a3d4cd", "#2f9488", "#1b5b53"], ink: "#2f7a70", text: "#2f6f66", soft: "#ebf6f4", line: "#a9d6cf" } }),
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));
export const COORDINATORS = Object.freeze(PROVIDER_IDS.filter((id) => PROVIDERS[id].coordinate));
export const TASK_AGENTS = Object.freeze(PROVIDER_IDS.filter((id) => PROVIDERS[id].tasks));

export function providerName(id) { return PROVIDERS[id]?.name ?? String(id); }

/** What the renderer needs to draw agents, in display order. */
export function providerSummaries() {
  return PROVIDER_IDS.map((id) => {
    const { name, appName, cli, coordinate, tasks, images, signInWith = "cli", effort = null, quota = null, theme } = PROVIDERS[id];
    return { id, name, appName, cli, coordinate, tasks, images, signInWith, effort, quota, theme };
  });
}
