---
name: codex-claude-bridge
description: Coordinate coding work between Codex and Claude Code through the local bridge. Use for non-trivial implementation or review tasks and explicit requests to split work; skip informational questions and trivial edits.
---

# Codex Claude Bridge

Codex leads the task. Claude Code is a delegated implementer or read-only reviewer. The bridge is a local MCP server; it does not read conversation history or intercept prompts.

For an applicable coding request:

1. Call `check_bridge` before the first delegation in the conversation. The desktop manager must be running; its local MCP service stops when its window closes. If the bridge is offline, continue in Codex and tell the user to start the manager from this checkout. If Claude Code is unavailable, explain the CLI prerequisite.
2. Keep the user request and acceptance criteria as the source of truth. Split out a bounded task with clear files or outcomes; do not delegate overlapping edits.
3. Pass the current working folder in `workspace`. The path must be an absolute local directory; a Git repository is optional. This folder supplies the working directory, not a boundary that blocks other user-requested paths. Bridge's installation folder is independent of the user's task destination.
4. Use `mode: "review"` for findings only. Use `mode: "implement"` when Claude should carry out a task; file and shell tools are available for authorized work. Respect explicit user requests not to edit.
5. Inspect delegated edits or findings, run the relevant verification from Codex, and report how Claude's work was integrated.

Keep trivial changes in Codex when delegation would add more coordination than value. Run delegations sequentially when they share a repository so both agents do not edit the same files at once.

When already running as a Bridge-assigned agent, the coordinator has handled delegation. Complete the assigned work and return the result instead of recursively invoking this same Bridge.
