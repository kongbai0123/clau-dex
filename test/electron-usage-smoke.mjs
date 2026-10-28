import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopApp } from "../src/desktop/desktop-app.js";

// Run with Electron, not Node. Every provider/native operation below is injected.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(projectRoot, ".bridge", "usage-smoke");
const dataDirectory = path.join(artifacts, `run-${Date.now()}`);
mkdirSync(dataDirectory, { recursive: true });
const emptyCounts = () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, messages: 0 });
const hours = () => Array.from({ length: 24 }, (_, index) => ({ inputTokens: index === 9 ? 24000 : 0, outputTokens: index === 9 ? 9000 : 0, messages: index === 9 ? 12 : 0 }));
const codex = {
  found: true, quota: { observedAt: new Date().toISOString(), primary: { usedPercent: 24, windowMinutes: 300, resetsAt: new Date(Date.now() + 3 * 3600000).toISOString() },
    secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: new Date(Date.now() + 5 * 86400000).toISOString() } },
  today: { inputTokens: 18000, cachedInputTokens: 12000, outputTokens: 6000, sessions: 4 },
};
const claudeQuota = ({ stale = false, expired = false, secondary = true } = {}) => ({
  source: "claude-cli", stale, observedAt: new Date(Date.now() - (stale ? 2 * 3600000 : 0)).toISOString(),
  primary: { usedPercent: 37, windowMinutes: 300, resetsAt: new Date(Date.now() + (expired ? -3600000 : 2 * 3600000)).toISOString() },
  secondary: secondary ? { usedPercent: 16, windowMinutes: 10080, resetsAt: new Date(Date.now() + (expired ? -3600000 : 4 * 86400000)).toISOString() } : null,
});
const retainedQuota = claudeQuota();
retainedQuota.secondary.observedAt = new Date(Date.now() - 3 * 3600000).toISOString();
const fixtures = [
  { name: "known", claude: { found: true, today: { inputTokens: 24000, cachedInputTokens: 18000, outputTokens: 9000, messages: 12 },
    recent5h: { inputTokens: 9000, cachedInputTokens: 6500, outputTokens: 4000, messages: 5 }, hourly: hours(), models: { "claude-sonnet": 5000, "claude-opus": 4000 },
    quota: claudeQuota(), quotaStatus: { state: "ready", message: "Claude CLI 額度已更新。" } } },
  { name: "zero", claude: { found: true, today: emptyCounts(), recent5h: emptyCounts(), hourly: Array.from({ length: 24 }, emptyCounts), models: {},
    quotaStatus: { state: "no-data", message: "Claude 尚未回傳額度資料。" } } },
  { name: "partial", claude: { found: true, today: { inputTokens: 84, cachedInputTokens: 12, outputTokens: 42, messages: 2 }, quota: claudeQuota({ secondary: false }) } },
  { name: "retained", claude: { quota: retainedQuota, quotaStatus: { state: "ready", message: "5 小時額度已更新；週額度保留上次紀錄。" } } },
  { name: "absent", claude: null },
  { name: "stale", claude: { quota: claudeQuota({ stale: true }), quotaStatus: { state: "error", message: "暫時無法更新，保留上次紀錄。" } } },
  { name: "expired", claude: { quota: claudeQuota({ stale: true, expired: true }), quotaStatus: { state: "error", message: "等待更新。" } } },
  { name: "unknown", claude: { quota: { observedAt: new Date().toISOString(), primary: { usedPercent: null, windowMinutes: 300 } } } },
  { name: "loading", claude: { quotaStatus: { state: "loading", message: "正在讀取 Claude CLI 額度…" } } },
  { name: "unsupported", claude: { quotaStatus: { state: "unsupported", message: "目前 CLI 尚未提供額度資料。" } } },
  { name: "error", claude: { quotaStatus: { state: "error", message: "額度讀取失敗，請稍後重試。" } } },
];
let fixtureIndex = 0;
const checkedAt = index => new Date(1800000000000 + index * 1000).toISOString();
const usageState = () => ({ checkedAt: checkedAt(fixtureIndex), codex, claude: fixtures[fixtureIndex].claude });
const usageMonitor = { get: () => structuredClone(usageState()), refresh: async () => structuredClone(usageState()) };
let runtimeClosed = false;
let runtimeTasks = 0;
let appOperations = 0;
let appDisposals = 0;
const runtime = {
  probe: async () => ({ codex: { available: true, authenticated: true, version: "codex test", error: null },
    claude: { available: true, authenticated: true, version: "claude test", error: null } }),
  run: async () => { runtimeTasks++; throw new Error("The usage smoke must not invoke a provider task."); },
  activeProcesses: () => [], close: async () => { runtimeClosed = true; },
};
const info = { installed: true, running: false, managed: false, pids: [] };
const appManager = {
  list: async () => ({ codex: { ...info }, claude: { ...info } }),
  launch: async () => { appOperations++; throw new Error("Native launch is forbidden in this injected smoke."); },
  close: async () => { appOperations++; throw new Error("Native close is forbidden in this injected smoke."); },
  closeOwned: async () => { appOperations++; return { codex: { ...info }, claude: { ...info } }; },
  dispose: async () => { appDisposals++; },
};
const report = { passed: false, checks: [], fixtures: [], rendererErrors: [], dataDirectory, screenshot: path.join(artifacts, "usage.png") };
let instance;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const saveReport = () => writeFileSync(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2), "utf8");

async function until(predicate, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await pause(60);
  }
}

async function runSmoke() {
  try {
    instance = await createDesktopApp({ dataDirectory, runtime, appManager, usageMonitor, port: 0,
      onShutdownComplete(snapshot) {
        report.bridgeStopped = snapshot.bridge.state === "stopped";
        report.runtimeClosed = runtimeClosed;
        report.ownedProcesses = snapshot.processes;
        report.providerTasks = runtimeTasks;
        report.nativeOperations = appOperations;
        report.appDisposals = appDisposals;
        report.passed = report.preClosePassed === true && report.bridgeStopped && runtimeClosed
          && snapshot.processes.length === 0 && runtimeTasks === 0 && appOperations === 0 && appDisposals === 1 && report.rendererErrors.length === 0;
        saveReport();
        console.log(JSON.stringify({ passed: report.passed, report: path.join(artifacts, "report.json"), screenshot: report.screenshot }));
      },
    });
    assert.ok(instance, "The isolated smoke window must be created.");
    const { window, services } = instance;
    // The production cache owns quota metadata. Mock its read boundary, rather
    // than allowing the local log monitor to bypass that authoritative source.
    services.quotaCache.snapshot = () => structuredClone({
      quota: fixtures[fixtureIndex].claude?.quota || null,
      quotaStatus: fixtures[fixtureIndex].claude?.quotaStatus || { state: "no-data", message: "尚未取得 Claude 方案額度。" },
    });
    window.webContents.setBackgroundThrottling(false);
    window.show(); window.focus();
    window.webContents.on("console-message", (event, legacyLevel, legacyMessage) => {
      if ((event?.level ?? legacyLevel) === "error" || (event?.level ?? legacyLevel) === 3) report.rendererErrors.push(String(event?.message ?? legacyMessage));
    });
    window.webContents.on("render-process-gone", (_event, details) => report.rendererErrors.push(`Renderer exited: ${JSON.stringify(details)}`));
    const js = code => window.webContents.executeJavaScript(code);
    await until(() => js("Boolean(window.bridge) && Boolean(document.querySelector('#task-description'))"), "The real renderer did not connect.");
    await js(`window.__usageSmokeErrors = []; window.__usageSmokeLastUpdate = null; window.__usageSmokeUpdates = 0;
      window.addEventListener('error', event => window.__usageSmokeErrors.push(String(event.error?.stack || event.message)));
      window.addEventListener('unhandledrejection', event => window.__usageSmokeErrors.push(String(event.reason?.stack || event.reason)));
      window.bridge.onUpdate(snapshot => { window.__usageSmokeUpdates++; window.__usageSmokeLastUpdate = snapshot.usage?.checkedAt; });
      if (document.querySelector('#inspector').hidden) document.querySelector('#toggle-inspector').click();
      document.querySelector('[data-inspector-tab="usage"]').click();`);
    await until(() => js("!document.querySelector('#inspector').hidden && document.querySelector('[data-inspector-tab=usage]').getAttribute('aria-selected') === 'true'"), "Usage inspector did not open.");
    assert.equal((await fetch(services.snapshot().bridge.url.replace(/\/mcp$/, "/health")).then(response => response.json())).ready, true);
    report.checks.push("Actual Electron usage inspector opens and local bridge responds on an isolated port");

    for (let index = 0; index < fixtures.length; index++) {
      fixtureIndex = index;
      const fixture = fixtures[fixtureIndex];
      const previousUpdates = await js("window.__usageSmokeUpdates");
      await js("document.querySelector('#refresh-status').click()");
      await until(() => js(`window.__usageSmokeUpdates > ${previousUpdates} && window.__usageSmokeLastUpdate === ${JSON.stringify(checkedAt(fixtureIndex))}`), `${fixture.name}: status refresh did not send its usage snapshot event.`);
      await until(() => js("Boolean(document.querySelector('[data-zone=tokens] [data-usage-agent=claude]'))"), `${fixture.name}: Claude token row did not render.`);
      const rendered = await js(`(() => {
        const body = document.querySelector('#inspector-body');
        const zone = name => document.querySelector('[data-zone=' + name + ']');
        const row = (name, agent) => zone(name)?.querySelector('[data-usage-agent=' + agent + ']');
        return { html: body.innerHTML, zones: Array.from(body.querySelectorAll('[data-zone]')).map(element => element.dataset.zone),
          circles: body.querySelectorAll('svg circle').length,
          claudeQuota: Array.from(zone('quota').querySelectorAll('[data-usage-agent=claude]')).map(element => element.textContent).join(' '),
          claudeQuotaRows: Array.from(zone('quota').querySelectorAll('[data-usage-agent=claude]')).map(element => ({ text: element.textContent, empty: element.querySelector('.ins-meter-track')?.classList.contains('empty'), observedAt: element.querySelector('.ins-meter-meta [title]')?.getAttribute('title') || null })),
          codexQuota: Array.from(zone('quota').querySelectorAll('[data-usage-agent=codex]')).map(element => element.textContent),
          claudeTokens: row('tokens', 'claude')?.textContent || '', tokenLegend: zone('tokens').querySelector('.ins-legend')?.textContent || '',
          errors: [...window.__usageSmokeErrors] };
      })()`);
      assert.deepEqual(rendered.errors, [], `${fixture.name}: optional usage data must not throw in the renderer.`);
      assert.doesNotMatch(rendered.html, /NaN|undefined|Infinity/, `${fixture.name}: chart contains malformed numeric values.`);
      // Quota, token use and runs are separate zones, drawn with horizontal bars only.
      assert.deepEqual(rendered.zones, ["quota", "tokens", "runs"], `${fixture.name}: usage zones must stay separate and ordered.`);
      assert.equal(rendered.circles, 0, `${fixture.name}: usage must not use ring charts.`);
      assert.doesNotMatch(rendered.claudeTokens, /(?:剩餘|已使用|remaining)\s*\d+(?:\.\d+)?\s*%/i, "Token totals must remain separate from subscription quota percentages.");
      if (["known", "partial", "stale", "retained"].includes(fixture.name)) {
        assert.match(rendered.claudeQuotaRows[0]?.text || "", /Claude\s*·\s*5\s*小時/);
        assert.match(rendered.claudeQuotaRows[0]?.text || "", /剩餘\s*63%/, "37 percent used means 63 percent remaining.");
        assert.equal(rendered.claudeQuotaRows[0].empty, false);
        if (fixture.name === "partial") assert.equal(rendered.claudeQuotaRows.length, 1, "A single reported window must not invent a weekly quota.");
        else {
          assert.equal(rendered.claudeQuotaRows.length, 2);
          assert.match(rendered.claudeQuotaRows[1]?.text || "", /已使用\s*16%/, "The weekly Claude window shows the actual used percentage.");
        }
      } else if (["expired", "unknown"].includes(fixture.name)) {
        assert.ok(rendered.claudeQuotaRows.every(row => row.empty), "Unknown or expired values must have an empty meter.");
        assert.match(rendered.claudeQuota, /待更新/);
        assert.doesNotMatch(rendered.claudeQuota, /\d+(?:\.\d+)?\s*%/, "An expired window must not fabricate reset or remaining percentages.");
      } else {
        const labels = { zero: /尚無紀錄/, absent: /尚無紀錄/, loading: /讀取中/, unsupported: /暫不支援/, error: /讀取失敗/ };
        assert.match(rendered.claudeQuota, labels[fixture.name]);
        assert.doesNotMatch(rendered.claudeQuota, /\d+(?:\.\d+)?\s*%/, "Missing quota must be explained without invented percentages.");
        if (fixture.claude?.quotaStatus?.message) assert.ok(rendered.claudeQuota.includes(fixture.claude.quotaStatus.message), "The backend quota status explanation must be shown.");
      }
      if (["stale", "expired"].includes(fixture.name)) {
        assert.ok(rendered.claudeQuotaRows.every(row => row.text.includes("快取紀錄")), "Cached quota must identify the observation as cached.");
        assert.ok(rendered.html.includes(fixture.claude.quota.observedAt), "Cached quota must retain its exact observation timestamp.");
      }
      if (fixture.name === "retained") {
        assert.doesNotMatch(rendered.claudeQuotaRows[0].text, /快取紀錄|上次剩餘/, "The fresh short window must not be mislabeled as cached.");
        assert.equal(rendered.claudeQuotaRows[0].observedAt, null);
        assert.match(rendered.claudeQuotaRows[1].text, /上次已使用\s*16%.*快取紀錄/, "Only the retained weekly bucket is cached.");
        assert.equal(rendered.claudeQuotaRows[1].observedAt, fixture.claude.quota.secondary.observedAt, "The retained window must show its own older observation time.");
        assert.notEqual(rendered.claudeQuotaRows[1].observedAt, fixture.claude.quota.observedAt);
      }
      assert.match(rendered.codexQuota[0] || "", /剩餘\s*76%/, "The short Codex window shows what remains.");
      assert.match(rendered.codexQuota[1] || "", /已使用\s*40%/, "The weekly Codex window shows what has been used.");
      if (fixture.name === "known") {
        assert.match(rendered.claudeTokens, /33(?:\.0)?K/, "Claude token total is input plus output.");
        assert.match(rendered.claudeTokens, /輸出\s*9(?:\.0)?K/);
        assert.match(rendered.claudeTokens, /最近\s*5\s*小時輸出\s*4(?:\.0)?K/);
        assert.match(rendered.tokenLegend, /App／CLI/);
        assert.match(rendered.tokenLegend, /工作台/);
      } else if (fixture.name === "partial") {
        assert.match(rendered.claudeTokens, /126/);
        assert.match(rendered.claudeTokens, /42/);
      } else if (fixture.name === "absent") {
        assert.match(rendered.claudeTokens, /尚無紀錄/);
      }

      await js("document.querySelector('#task-description').focus(); document.querySelector('#task-description').select()");
      await window.webContents.insertText(`用量 ${fixture.name} 不應阻止傳送`);
      await until(() => js("!document.querySelector('#task-description').disabled && !document.querySelector('#submit-task').disabled && !document.querySelector('#submit-task').hidden"), `${fixture.name}: actual text input did not enable the Send button.`);
      const inputText = await js("document.querySelector('#task-description').value");
      assert.equal(inputText, `用量 ${fixture.name} 不應阻止傳送`);
      report.fixtures.push({ name: fixture.name, sendEnabled: true, claudeQuota: rendered.claudeQuota, codexQuota: rendered.codexQuota, claudeTokens: rendered.claudeTokens });
      if (fixture.name === "known") {
        await js("document.querySelector('[data-zone=quota]').scrollIntoView({block:'start'})");
        // Wait for the compositor, including the inspector entry animation, to paint.
        // An occluded test window can otherwise return its initial transparent frame.
        await pause(600);
        let screenshot;
        await until(async () => {
          screenshot = await window.webContents.capturePage();
          const { width, height } = screenshot.getSize();
          const pixels = screenshot.toBitmap();
          let darkPixels = 0;
          for (let y = 100; y < height - 40; y++) for (let x = width - 300; x < width - 10; x++) {
            const offset = (y * width + x) * 4;
            if (pixels[offset] < 220 && pixels[offset + 1] < 220 && pixels[offset + 2] < 220) darkPixels++;
          }
          report.chartDarkPixels = darkPixels;
          return darkPixels > 500;
        }, "The actual Claude chart surface remained transparent or unpainted.");
        writeFileSync(report.screenshot, screenshot.toPNG());
      }
    }
    report.rendererErrors.push(...await js("window.__usageSmokeErrors"));
    assert.deepEqual(report.rendererErrors, []);
    assert.equal(runtimeTasks, 0);
    assert.equal(services.snapshot().tasks.length, 0);
    report.checks.push("Quota, token and run zones stay separate; actual Claude 5h and weekly quota use the shared horizontal bars");
    report.checks.push("37 percent used renders 63 percent remaining; weekly16, partial, cached, retained, expired and unknown values remain honest");
    report.checks.push("A fresh short bucket and retained weekly bucket have separate cache labels and observation timestamps");
    report.checks.push("Known, zero, partial, retained, absent, stale, expired, loading, unsupported and error snapshots preserve real text input and enabled Send");
    report.checks.push("No renderer errors, provider task calls or native app operations");
    report.preClosePassed = true;
    window.close();
  } catch (error) {
    report.error = error.stack || error.message;
    saveReport();
    process.exitCode = 1;
    if (instance) await instance.shutdown();
    else { await runtime.close(); process.exit(1); }
  }
}

// Electron startup can deadlock behind top-level await; launch the async factory normally.
runSmoke().catch(error => { report.error = error.stack || error.message; saveReport(); console.error(error); process.exit(1); });
