import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
const roots = ["src", "ui", "scripts"];
function files(directory) { return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.(js|cjs|mjs)$/.test(entry.name) ? [path.join(directory, entry.name)] : []); }
for (const file of roots.flatMap(files)) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status || 1); }
}
console.log("All application JavaScript syntax checks passed.");
