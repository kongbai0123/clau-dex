import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CLAUDE_QUOTA_FRESH_MS, createClaudeQuotaCache, normalizeClaudeQuota } from "../src/claude-quota-cache.js";
import { createDesktopServices } from "../src/desktop/services.js";

const root = mkdtempSync(path.join(os.tmpdir(), "bridge-claude-quota-"));
const workspace = path.join(root, "repository");
mkdirSync(path.join(workspace, ".git"), { recursive: true });
after(() => {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe test cleanup path");
  rmSync(root, { recursive: true, force: true });
});
const INITIAL_TIME = Date.parse("2026-10-12T02:00:00.000Z");
const iso = value => new Date(value).toISOString();
const quota = (observed = INITIAL_TIME) => ({ observedAt: iso(observed),
  primary: { usedPercent: 0, resetsAt: iso(observed + 5 * 60 * 60 * 1000) },
  secondary: { usedPercent: 10, resetsAt: iso(observed + 7 * 24 * 60 * 60 * 1000) } });

function deferred() {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(name, { query, probe, close, querySupported = true } = {}) {
  const calls = { quota: [], probes: 0, usage: 0, closed: 0, disposed: 0 };
  const runtime = {
    activeProcesses: () => [],
    async probe() {
      calls.probes++;
      return probe || { codex: { available: true, authenticated: true }, claude: { available: true, authenticated: true } };
    },
    queryClaudeQuota(request, options) {
      calls.quota.push({ ...request, signal: options.signal });
      return query ? query(request, options) : Promise.resolve(quota(Date.now()));
    },
    async close() { calls.closed++; await close?.(); },
  };
  if (!querySupported) delete runtime.queryClaudeQuota;
  const usage = { checkedAt: null, claude: { found: false }, codex: { found: false } };
  const services = createDesktopServices({ projectRoot: workspace, dataDirectory: path.join(root, name), runtime, port: 0,
    appManager: { list: async () => ({}), dispose() { calls.disposed++; } },
    usageMonitor: { get: () => usage, async refresh() { calls.usage++; return usage; } } });
  return { services, calls };
}

test("normalization accepts zero and partial windows while rejecting invalid percentages and reset dates", () => {
  const normalized = normalizeClaudeQuota(quota());
  assert.deepEqual(normalized, { observedAt: iso(INITIAL_TIME), source: "claude-cli",
    primary: { usedPercent: 0, windowMinutes: 300, resetsAt: iso(INITIAL_TIME + 5 * 60 * 60 * 1000) },
    secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: iso(INITIAL_TIME + 7 * 24 * 60 * 60 * 1000) } });
  assert.equal(normalizeClaudeQuota({ ...quota(), secondary: undefined }).secondary, null);
  assert.equal(normalizeClaudeQuota({ ...quota(), primary: undefined }).primary, null);
  for (const usedPercent of [-1, 101, Infinity, NaN, "0", null]) {
    assert.equal(normalizeClaudeQuota({ ...quota(), primary: { ...quota().primary, usedPercent }, secondary: null }), null);
  }
  assert.equal(normalizeClaudeQuota({ ...quota(), primary: { usedPercent: 10, resetsAt: "not a date" }, secondary: null }), null);
  assert.equal(normalizeClaudeQuota({ ...quota(), observedAt: "not a date" }), null);
  assert.equal(normalizeClaudeQuota(null), null);
});

test("persistence stores only quota whitelist fields and reopens a valid zero-percent window", () => {
  const data = path.join(root, "whitelist");
  let changes = 0;
  const cache = createClaudeQuotaCache(data, { now: () => INITIAL_TIME, onChange() { changes++; } });
  const injected = { ...quota(), secret: "INJECTED_SECRET", accessToken: "INJECTED_TOKEN", accountId: "INJECTED_ACCOUNT",
    transcript: "INJECTED_TRANSCRIPT", source: "untrusted",
    primary: { ...quota().primary, windowMinutes: 1, credential: "INJECTED_WINDOW_SECRET" } };
  assert.equal(cache.update(injected), true);
  const persisted = JSON.parse(readFileSync(cache.file, "utf8"));
  assert.deepEqual(Object.keys(persisted).sort(), ["observedAt", "primary", "secondary", "source"]);
  assert.deepEqual(Object.keys(persisted.primary).sort(), ["resetsAt", "usedPercent", "windowMinutes"]);
  assert.doesNotMatch(readFileSync(cache.file, "utf8"), /INJECTED_|accessToken|credential|accountId|transcript/);
  assert.equal(changes, 1);
  const reopened = createClaudeQuotaCache(data, { now: () => INITIAL_TIME });
  assert.equal(reopened.fresh(), true);
  assert.equal(reopened.snapshot().quota.primary.usedPercent, 0);
  assert.equal(reopened.snapshot().quota.stale, false);
});

test("five-minute age and expired reset windows mark cache stale without inventing current data", () => {
  let now = INITIAL_TIME;
  const cache = createClaudeQuotaCache(path.join(root, "stale"), { now: () => now });
  cache.update(quota());
  now += CLAUDE_QUOTA_FRESH_MS - 1;
  assert.equal(cache.fresh(), true);
  now++;
  assert.equal(cache.fresh(), false);
  assert.equal(cache.snapshot().quota.stale, true);
  assert.equal(cache.snapshot().quota.primary.usedPercent, 0);
  assert.match(cache.snapshot().quotaStatus.message, /上次額度/);

  now = INITIAL_TIME;
  const expired = createClaudeQuotaCache(path.join(root, "expired"), { now: () => now });
  expired.update({ ...quota(), primary: { usedPercent: 30, resetsAt: iso(INITIAL_TIME + 1000) } });
  now += 1000;
  assert.equal(expired.fresh(), false);
  assert.equal(expired.snapshot().quota.stale, true);
});

test("older or far-future observations cannot overwrite a saved snapshot and corrupt files are safe", () => {
  const cache = createClaudeQuotaCache(path.join(root, "observation-order"), { now: () => INITIAL_TIME });
  cache.update(quota());
  const before = readFileSync(cache.file, "utf8");
  assert.equal(cache.update(quota(INITIAL_TIME - 1)), false);
  assert.equal(cache.update(quota(INITIAL_TIME + 60_001)), false);
  assert.equal(readFileSync(cache.file, "utf8"), before);
  const corruptDirectory = path.join(root, "corrupt");
  mkdirSync(corruptDirectory);
  writeFileSync(path.join(corruptDirectory, "claude-quota.json"), "{broken quota json");
  const corrupt = createClaudeQuotaCache(corruptDirectory, { now: () => INITIAL_TIME });
  assert.equal(corrupt.snapshot().quota, null);
  assert.equal(corrupt.snapshot().quotaStatus.state, "no-data");
  assert.equal(corrupt.fresh(), false);
  const futureDirectory = path.join(root, "future-on-disk");
  mkdirSync(futureDirectory);
  writeFileSync(path.join(futureDirectory, "claude-quota.json"), JSON.stringify(quota(INITIAL_TIME + 1000)));
  assert.equal(createClaudeQuotaCache(futureDirectory, { now: () => INITIAL_TIME }).fresh(), false);
});

test("partial updates preserve an unexpired missing window with its original age across reopening", () => {
  let now = INITIAL_TIME;
  const data = path.join(root, "partial-retention");
  const cache = createClaudeQuotaCache(data, { now: () => now });
  cache.update({ ...quota(), secondary: { ...quota().secondary, secret: "INJECTED_PREVIOUS_SECRET" } });
  now += 2 * 60 * 1000;
  assert.equal(cache.update({ observedAt: iso(now), primary: { usedPercent: 5, resetsAt: iso(now + 5 * 60 * 60 * 1000),
    credential: "INJECTED_NEW_SECRET" }, secondary: null, accessToken: "INJECTED_TOKEN" }), true);
  const snapshot = cache.snapshot().quota;
  assert.equal(snapshot.primary.usedPercent, 5);
  assert.equal(snapshot.secondary.usedPercent, 10);
  assert.equal(snapshot.secondary.observedAt, iso(INITIAL_TIME));
  assert.equal(snapshot.observedAt, iso(now));
  assert.equal(cache.fresh(), true);
  const persisted = readFileSync(cache.file, "utf8");
  assert.doesNotMatch(persisted, /INJECTED_|secret|credential|accessToken/);
  assert.deepEqual(Object.keys(JSON.parse(persisted).secondary).sort(), ["observedAt", "resetsAt", "usedPercent", "windowMinutes"]);
  const reopened = createClaudeQuotaCache(data, { now: () => now });
  assert.equal(reopened.snapshot().quota.secondary.observedAt, iso(INITIAL_TIME));
  assert.equal(reopened.snapshot().quota.secondary.usedPercent, 10);
  assert.equal(reopened.fresh(), true);
  assert.equal(reopened.update({ ...quota(now - 1), primary: { usedPercent: 99, resetsAt: iso(now + 5 * 60 * 60 * 1000) } }), false);
  assert.equal(readFileSync(reopened.file, "utf8"), persisted, "an older query cannot replace the newer snapshot or its retained window");
  now = INITIAL_TIME + CLAUDE_QUOTA_FRESH_MS;
  assert.equal(reopened.fresh(), false, "the retained window's original age controls freshness");
  assert.equal(reopened.snapshot().quota.stale, true);
  reopened.update({ observedAt: iso(now), primary: { usedPercent: 6, resetsAt: iso(now + 5 * 60 * 60 * 1000) } });
  assert.equal(reopened.snapshot().quota.secondary.observedAt, iso(INITIAL_TIME));
  assert.equal(reopened.fresh(), false, "later partial events must not renew an absent window's timestamp");
});

test("partial updates discard expired prior windows and normalize optional observation timestamps safely", () => {
  let now = INITIAL_TIME;
  const data = path.join(root, "partial-expired");
  const cache = createClaudeQuotaCache(data, { now: () => now });
  cache.update({ ...quota(), secondary: { usedPercent: 30, resetsAt: iso(INITIAL_TIME + 1000) } });
  now += 1000;
  cache.update({ observedAt: iso(now), primary: { usedPercent: 4, resetsAt: iso(now + 5 * 60 * 60 * 1000) } });
  assert.equal(cache.snapshot().quota.secondary, null);
  assert.equal(cache.fresh(), true);
  assert.equal(createClaudeQuotaCache(data, { now: () => now }).snapshot().quota.secondary, null);
  const timed = normalizeClaudeQuota({ ...quota(),
    primary: { ...quota().primary, observedAt: iso(INITIAL_TIME - 1000), secret: "INJECTED_SECRET" },
    secondary: { ...quota().secondary, observedAt: iso(INITIAL_TIME + 1000) } });
  assert.equal(timed.primary.observedAt, iso(INITIAL_TIME - 1000));
  assert.equal(Object.hasOwn(timed.secondary, "observedAt"), false, "a window cannot claim an observation newer than its parent event");
  assert.equal(Object.hasOwn(timed.primary, "secret"), false);
});

test("authenticated startup warms quota once and concurrent requests share its in-flight query", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: INITIAL_TIME });
  const result = deferred();
  const { services, calls } = fixture("coalesced", { query: () => result.promise });
  t.after(async () => { result.resolve(quota()); await services.shutdown(); });
  await services.start();
  assert.equal(calls.quota.length, 1);
  assert.equal(calls.quota[0].workspace, workspace);
  assert.equal(calls.quota[0].signal.aborted, false);
  const first = services.refreshClaudeQuota();
  const second = services.refreshClaudeQuota({ force: true });
  assert.equal(first, second);
  assert.equal(calls.quota.length, 1);
  result.resolve(quota());
  await first;
  assert.equal(services.snapshot().usage.claude.quota.primary.usedPercent, 0);
  assert.equal(services.snapshot().usage.claude.quotaStatus.state, "ready");
});

test("fresh cache skips warmup; manual refresh overrides freshness but respects the 60-second throttle", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: INITIAL_TIME });
  const { services, calls } = fixture("manual-throttle");
  t.after(() => services.shutdown());
  services.quotaCache.update(quota());
  await services.start();
  assert.equal(calls.quota.length, 0);
  await services.refreshClaudeQuota({ force: true });
  assert.equal(calls.quota.length, 1);
  t.mock.timers.tick(59_999);
  await services.refreshClaudeQuota({ force: true });
  assert.equal(calls.quota.length, 1);
  t.mock.timers.tick(1);
  await services.refreshClaudeQuota({ force: true });
  assert.equal(calls.quota.length, 2);
  t.mock.timers.tick(60_000);
  await services.refreshClaudeQuota();
  assert.equal(calls.quota.length, 2, "a fresh cache should suppress non-forced queries");
  await services.refreshStatus();
  await services.refreshClaudeQuota({ force: true });
  assert.equal(calls.quota.length, 3, "manual status refresh should refresh quota after throttle permits it");
});

test("automatic 20-second status refreshes never send additional quota-only model requests", async t => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: INITIAL_TIME });
  const { services, calls } = fixture("periodic-status");
  t.after(() => services.shutdown());
  await services.start();
  await services.refreshClaudeQuota();
  assert.equal(calls.quota.length, 1);
  const initialProbes = calls.probes;
  for (let index = 0; index < 18; index++) {
    t.mock.timers.tick(20_000);
    await services.refreshStatus({ refreshQuota: false });
  }
  assert.ok(calls.probes > initialProbes);
  assert.equal(calls.quota.length, 1);
  assert.equal(services.snapshot().usage.claude.quota.stale, true);
});

test("unavailable, logged-out or unsupported runtimes never query quota", async t => {
  const scenarios = [
    { name: "unavailable", probe: { claude: { available: false, authenticated: true } } },
    { name: "logged-out", probe: { claude: { available: true, authenticated: false } } },
    { name: "unsupported", querySupported: false },
  ];
  for (const scenario of scenarios) {
    const { services, calls } = fixture(scenario.name, scenario);
    t.after(() => services.shutdown());
    await services.refreshStatus({ refreshQuota: false });
    await services.refreshClaudeQuota({ force: true });
    assert.equal(calls.quota.length, 0);
    assert.equal(services.snapshot().usage.claude.quota, null);
  }
});

test("query errors preserve previous quota, redact credential-looking text and do not rewrite the cache", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: INITIAL_TIME });
  const { services, calls } = fixture("query-error", { query: async () => { throw new Error("Quota temporarily unavailable sk-abcdefghijk"); } });
  t.after(() => services.shutdown());
  services.quotaCache.update(quota());
  const before = readFileSync(services.quotaCache.file, "utf8");
  await services.refreshStatus({ refreshQuota: false });
  await services.refreshClaudeQuota({ force: true });
  assert.equal(calls.quota.length, 1);
  const snapshot = services.snapshot().usage.claude;
  assert.equal(snapshot.quota.primary.usedPercent, 0);
  assert.equal(snapshot.quotaStatus.state, "error");
  assert.match(snapshot.quotaStatus.message, /temporarily unavailable/);
  assert.doesNotMatch(snapshot.quotaStatus.message, /sk-abcdefghijk/);
  assert.equal(readFileSync(services.quotaCache.file, "utf8"), before);
});

test("a null query result reports unavailable data and preserves an existing snapshot", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: INITIAL_TIME });
  const { services } = fixture("query-null", { query: async () => null });
  t.after(() => services.shutdown());
  services.quotaCache.update(quota());
  await services.refreshStatus({ refreshQuota: false });
  await services.refreshClaudeQuota({ force: true });
  assert.equal(services.snapshot().usage.claude.quota.primary.usedPercent, 0);
  assert.equal(services.snapshot().usage.claude.quotaStatus.state, "no-data");
});

test("shutdown aborts quota query, awaits its cleanup and runtime close, and prevents later queries", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: INITIAL_TIME });
  const queryDone = deferred();
  const runtimeClosed = deferred();
  let aborted = false;
  const { services, calls } = fixture("shutdown-query", {
    query(request, { signal }) { signal.addEventListener("abort", () => { aborted = true; }, { once: true }); return queryDone.promise; },
    close: () => runtimeClosed.promise,
  });
  t.after(async () => { queryDone.resolve(null); runtimeClosed.resolve(); await services.shutdown(); });
  await services.refreshStatus({ refreshQuota: false });
  const inFlight = services.refreshClaudeQuota({ force: true });
  const shutdown = services.shutdown();
  let shutdownFinished = false;
  shutdown.then(() => { shutdownFinished = true; });
  assert.equal(aborted, true);
  assert.equal(calls.closed, 1);
  await Promise.resolve();
  assert.equal(shutdownFinished, false);
  queryDone.resolve(quota());
  await inFlight;
  assert.equal(shutdownFinished, false, "runtime close must finish before desktop shutdown resolves");
  assert.equal(services.quotaCache.snapshot().quota, null, "late query data must not update a shutting-down cache");
  runtimeClosed.resolve();
  await shutdown;
  assert.equal(calls.disposed, 1);
  await services.refreshClaudeQuota({ force: true });
  assert.equal(calls.quota.length, 1);
});
