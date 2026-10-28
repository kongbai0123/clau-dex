# Codex coordination instructions

Codex is the lead agent for this project. For non-trivial coding requests, keep ownership of the plan and final integration, and use the `delegate_to_claude` MCP tool for one bounded implementation subtask or a read-only review when Claude Code is available.

Bridge is a shared conversation space. Its installation repository is not a boundary for the user's tasks: honor explicit target folders outside the installation folder, and use the file or shell tools needed for the requested work. A selected folder supplies the current working directory; it does not limit authorized operations to that directory. Ordinary chat does not require a Git repository. Respect explicit user instructions such as answering only or not editing.

When already running as an agent assigned by Bridge, its coordinator has handled delegation. Complete the supplied assignment and return the result; do not recursively call the same Bridge or launch duplicate coordinator services.

Before the first delegation, call `check_bridge`. Pass the active local Git repository's absolute path in `workspace`; the bridge resolves it to that repository's root. Do not delegate overlapping edits. After an implementation handoff, inspect the changed files and run the relevant verification from Codex. Use `mode: "review"` when Claude should only inspect and report findings.

If the bridge reports that Claude Code is unavailable, continue the task in Codex and tell the user how to install or configure Claude Code.

The desktop manager owns the loopback HTTP MCP service and all task processes. Keep shutdown deterministic: closing the window must cancel queued work, abort running tasks, close the listener, and terminate owned process trees. Native App closure is limited to manager-owned Apps and follows the persisted setting. Preserve the stdio entry for compatibility, but setup registers the desktop HTTP endpoint.
