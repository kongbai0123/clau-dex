import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Workspace checkpoints as Git tree objects built in a temporary index. Nothing touches the
// user's branch, index, stash or working tree, and it works in repositories without commits.

function git(cwd, args, { env, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, ...env }, maxBuffer, windowsHide: true, timeout: 60_000 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

/** Returns a tree hash of the current tracked and untracked (non-ignored) files, or null when Git is unavailable. */
export async function snapshotTree(workspace) {
  let directory;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), "bridge-checkpoint-"));
    const indexFile = path.join(directory, "index");
    // Seed from the real index so unchanged files are not re-hashed.
    try { await copyFile(path.resolve(workspace, (await git(workspace, ["rev-parse", "--git-path", "index"])).trim()), indexFile); } catch { /* fresh index */ }
    const env = { GIT_INDEX_FILE: indexFile };
    await git(workspace, ["add", "-A", "--", ":/"], { env });
    return (await git(workspace, ["write-tree"], { env })).trim() || null;
  } catch { return null; }
  finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

/** A bounded summary and patch of what changed between two checkpoints. */
export async function diffTrees(workspace, from, to, maxChars = 12_000) {
  if (!from || !to || from === to) return "";
  try {
    const stat = await git(workspace, ["diff-tree", "-r", "--stat", from, to]);
    const patch = await git(workspace, ["diff-tree", "-r", "-p", from, to]);
    const text = `${stat.trim()}\n\n${patch}`;
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（差異過長，已截斷；請直接檢查工作區）` : text;
  } catch { return ""; }
}
