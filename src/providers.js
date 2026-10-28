// The AI providers Bridge knows about. Each one is driven only through its official CLI, which owns sign-in
// and credentials; Bridge never reads or stores them.
//   coordinate: can plan and review coordinated work.
//   tasks:      can receive chat tasks. A provider is listed before its task runner is verified so the App
//               manager can already show it and guide sign-in.
//   login:      arguments that start the CLI's own interactive sign-in in a visible console.
//   status:     arguments that report sign-in state; null when the CLI has no status command.
//   credentialTarget: Windows Credential Manager target the CLI writes after sign-in, checked by name only.
//   signInWith: "app" when the desktop app owns sign-in, so Bridge opens the app instead of a CLI console.
export const PROVIDERS = Object.freeze({
  codex: Object.freeze({ id: "codex", name: "Codex", appName: "Codex", cli: "codex", coordinate: true, tasks: true,
    login: ["login"], status: ["login", "status"] }),
  claude: Object.freeze({ id: "claude", name: "Claude", appName: "Claude Code", cli: "claude", coordinate: true, tasks: true,
    login: ["auth", "login"], status: ["auth", "status", "--json"] }),
  antigravity: Object.freeze({ id: "antigravity", name: "Antigravity", appName: "Antigravity", cli: "agy", coordinate: false, tasks: false,
    // agy has no documented login or status command: an interactive session starts Google sign-in.
    // The desktop app runs the same Google sign-in and writes the same credential, so it works without agy.
    login: [], status: null, credentialTarget: "gemini:antigravity", signInWith: "app" }),
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));
export const COORDINATORS = Object.freeze(PROVIDER_IDS.filter((id) => PROVIDERS[id].coordinate));
export const TASK_AGENTS = Object.freeze(PROVIDER_IDS.filter((id) => PROVIDERS[id].tasks));

export function providerName(id) { return PROVIDERS[id]?.name ?? String(id); }

/** What the renderer needs to draw agents, in display order. */
export function providerSummaries() {
  return PROVIDER_IDS.map((id) => {
    const { name, appName, cli, coordinate, tasks, signInWith = "cli" } = PROVIDERS[id];
    return { id, name, appName, cli, coordinate, tasks, signInWith };
  });
}
