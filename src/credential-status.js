import { execFile as nodeExecFile } from "node:child_process";

/** Match only a complete target field, never a user field or a longer target name. */
export function credentialTargetListed(output, target) {
  const expected = String(target).toLowerCase();
  return String(output).split(/\r?\n/).some((line) => {
    const field = line.trim().match(/^([^:：]+)\s*[:：]\s*(.*?)\s*$/i);
    if (!field) return false;
    const label = field[1].trim();
    if (!/^(?:Target|目標|目标)$/i.test(label)) return false;
    const value = field[2].replace(/^LegacyGeneric:target=/i, "");
    return value.toLowerCase() === expected;
  });
}

const OEM_CODE_PAGE_KEY = String.raw`HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage`;
const CODE_PAGE_LABELS = new Map([
  [65001, "utf-8"], [1200, "utf-16le"], [1201, "utf-16be"],
  [932, "shift_jis"], [936, "gbk"], [949, "euc-kr"], [950, "big5"],
  [866, "ibm866"], [874, "windows-874"],
  ...Array.from({ length: 9 }, (_, index) => [1250 + index, `windows-${1250 + index}`]),
]);

function listingStatus(output, target) {
  if (credentialTargetListed(output, target)) return true;
  // An unfamiliar language, malformed field, or truncated listing is unknown,
  // rather than evidence that no credential is stored.
  if (/^\s*(?:Target|目標|目标)\s*[:：]\s*\S.*$/im.test(output)) return false;
  if (/^\s*\*\s*(?:NONE|無|没有|沒有)\s*\*\s*$/im.test(output)
      || /^\s*No credentials found\.?\s*$/im.test(output)) return false;
  return null;
}

/** Inspect Credential Manager's item names only. No secret values are requested. */
export function createWindowsCredentialProbe({ platform = process.platform, execFile = nodeExecFile, timeoutMs = 15_000, codePage } = {}) {
  function capture(command, args, signal, input) {
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve(null); return; }
      try {
        const child = execFile(command, args, {
          windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: "buffer", signal,
        }, (error, stdout) => resolve(error || signal?.aborted ? null : Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || "", "utf8")));
        if (input !== undefined && child?.stdin) {
          // A cancelled decoder may close stdin before all text is delivered.
          child.stdin.on("error", () => {});
          child.stdin.end(input, "ascii");
        }
      } catch { resolve(null); }
    });
  }

  async function systemCodePage(signal) {
    if (codePage !== undefined) return codePage;
    const output = await capture("reg.exe", ["query", OEM_CODE_PAGE_KEY, "/v", "OEMCP"], signal);
    if (!output) return null;
    const match = output.toString("ascii").match(/^\s*OEMCP\s+REG_SZ\s+(\d+)\s*$/im);
    return match ? Number(match[1]) : null;
  }

  async function decode(output, page, signal) {
    const label = CODE_PAGE_LABELS.get(page);
    if (label) {
      try { return new TextDecoder(label, { fatal: true }).decode(output); }
      catch { return null; }
    }
    // WHATWG TextDecoder does not include common OEM pages such as CP437.
    // Let Windows decode those pages locally. This helper only converts bytes
    // already listed by cmdkey; it never queries Credential Manager or secrets.
    const script = `$ErrorActionPreference='Stop'; try {
      $raw=[Convert]::FromBase64String([Console]::In.ReadToEnd());
      $encoding=[System.Text.Encoding]::GetEncoding(${page}, [System.Text.EncoderFallback]::ExceptionFallback, [System.Text.DecoderFallback]::ExceptionFallback);
      $text=$encoding.GetString($raw);
      $bytes=[System.Text.UTF8Encoding]::new($false).GetBytes($text);
      $stream=[Console]::OpenStandardOutput(); $stream.Write($bytes,0,$bytes.Length);
    } catch { exit 1 }`;
    const converted = await capture("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], signal, output.toString("base64"));
    if (!converted) return null;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(converted); }
    catch { return null; }
  }

  return async function credentialExists(target, { signal } = {}) {
    if (platform !== "win32" || signal?.aborted) return null;
    const page = await systemCodePage(signal);
    if (!Number.isInteger(page) || page <= 0 || page > 65535 || signal?.aborted) return null;
    const output = await capture("cmdkey.exe", [`/list:${target}`], signal);
    if (!output || signal?.aborted) return null;
    const text = await decode(output, page, signal);
    return text === null || signal?.aborted ? null : listingStatus(text, target);
  };
}
