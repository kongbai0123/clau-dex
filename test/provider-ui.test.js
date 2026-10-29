import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EFFORT_LEVELS, normalizeEffort } from "../src/effort.js";
import { PROVIDER_IDS, PROVIDERS, providerSummaries } from "../src/providers.js";

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
const read = (file) => readFileSync(path.join(ui, file), "utf8");
const hex = /^#[0-9a-f]{6}$/i;

test("every provider carries what the UI needs to draw it", () => {
  for (const summary of providerSummaries()) {
    assert.match(summary.theme.color, hex, `${summary.id} chart color`);
    assert.equal(summary.theme.shades.length, 3, `${summary.id} light/base/dark shades`);
    for (const tint of ["ink", "text", "soft", "line"]) if (summary.theme[tint] !== undefined) assert.match(summary.theme[tint], hex, `${summary.id} ${tint}`);
    assert.ok(summary.effort === null || summary.effort[0] === "auto", `${summary.id} effort starts at the CLI default`);
    assert.ok(summary.quota === null || typeof summary.quota === "string", `${summary.id} quota source`);
  }
});

test("effort levels and defaults come from the provider registry", () => {
  const withEffort = PROVIDER_IDS.filter((id) => PROVIDERS[id].effort);
  assert.deepEqual(Object.keys(EFFORT_LEVELS), withEffort);
  for (const id of withEffort) assert.deepEqual(EFFORT_LEVELS[id], PROVIDERS[id].effort);
  assert.deepEqual(normalizeEffort(), Object.fromEntries(withEffort.map((id) => [id, "auto"])));
});

test("the renderer draws providers from the registry instead of naming them", () => {
  // A provider added to or removed from src/providers.js must show up everywhere without UI edits, so the
  // renderer may not special-case providers beyond the coordinators' defaults and Claude's quota refresh.
  const app = read("app.js"), html = read("index.html"), css = read("styles.css");
  assert.doesNotMatch(app, /antigravity/i);
  assert.doesNotMatch(css, /codex|claude|antigravity/i);
  assert.doesNotMatch(html.replace(/<symbol id="i-[a-z]+"/g, ""), /data-effort-row|antigravity/i);
  for (const id of PROVIDER_IDS) assert.match(html, new RegExp(`<symbol id="i-${id}"`), `${id} icon (missing icons fall back to a neutral mark)`);
});
