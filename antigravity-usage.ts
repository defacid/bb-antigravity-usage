import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";

const DEFAULT_QUOTA_SUMMARY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const FALLBACK_QUOTA_SUMMARY_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const DEFAULT_QUOTA_DETAILED_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const FALLBACK_QUOTA_DETAILED_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

const REFRESH_URL = "https://oauth2.googleapis.com/token";
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const USER_AGENT = "Antigravity/1.2.11";

// Windows Credential Manager key used by agy CLI to store its OAuth token.
const WINDOWS_KEYRING_TARGET = "gemini:antigravity";

export interface StoredToken {
  token?: { access_token?: string; refresh_token?: string; expiry?: string };
  id_token?: string;
  id_token_email?: string;
  auth_method?: string;
}

/**
 * On macOS, agy uses go-keyring which stores the OAuth token in macOS Keychain
 * with service "gemini" and account "antigravity", prefixed with "go-keyring-base64:".
 */
async function readStoredTokenFromMacKeychain(): Promise<StoredToken | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("security", [
      "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w",
    ], { timeout: 5_000, encoding: "utf8" });
    let text = stdout.trim();
    if (!text) return null;
    if (text.startsWith("go-keyring-base64:")) {
      text = Buffer.from(text.slice("go-keyring-base64:".length), "base64").toString("utf8");
    }
    const parsed = JSON.parse(text) as any;
    return {
      token: parsed.token,
      id_token: parsed.id_token,
      id_token_email: parsed.id_token_email,
      auth_method: parsed.auth_method,
    };
  } catch {
    return null;
  }
}

/**
 * On Windows, agy stores its OAuth token in Windows Credential Manager.
 */
async function readStoredTokenFromWindowsKeyring(): Promise<StoredToken | null> {
  if (process.platform !== "win32") return null;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const script = `
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;using System.Text;
public static class CredReader {
  [DllImport("Advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern bool CredReadW(string t,uint type,uint flags,out IntPtr p);
  [DllImport("Advapi32.dll")] static extern void CredFree(IntPtr p);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
  struct CRED{public uint F,T;public string TN,C;public ulong LW;public uint BS;public IntPtr B;public uint P,AC;public IntPtr A;public string TA,U;}
  public static string Read(string target){
    IntPtr p;if(!CredReadW(target,1,0,out p))return null;
    try{var c=Marshal.PtrToStructure<CRED>(p);if(c.BS==0)return "";var b=new byte[c.BS];Marshal.Copy(c.B,b,0,(int)c.BS);return Encoding.UTF8.GetString(b);}
    finally{CredFree(p);}
  }
}
"@ -ErrorAction Stop
$v=[CredReader]::Read("${WINDOWS_KEYRING_TARGET}");if($v){Write-Output $v}else{exit 1}
`.trim();
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", script,
    ], { timeout: 8_000, encoding: "utf8", windowsHide: true });
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as StoredToken;
  } catch {
    return null;
  }
}

interface QuotaBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
}

interface QuotaGroup {
  displayName?: string;
  buckets?: QuotaBucket[];
}

export interface QuotaSummary { groups?: QuotaGroup[] }

export interface QuotaDetailedBucket {
  modelId?: string;
  tokenType?: string;
  remainingFraction?: number;
  resetTime?: string;
}

export interface QuotaDetailed { buckets?: QuotaDetailedBucket[] }

export interface NormalizedWindow {
  id: string;
  kind: "five-hour" | "daily" | "weekly" | "custom";
  label: string;
  model: string | null;
  usedPercent: number;
  resetsAt: string | null;
  cost?: { usedUsdCents: number; limitUsdCents: number } | null;
}

export interface AntigravityUsageState {
  status: "ok" | "not_installed" | "unauthenticated" | "expired" | "error";
  accountEmail: string | null;
  planLabel: string | null;
  windows: NormalizedWindow[];
  message?: string;
}

function error(message: string): ProviderUsageResult {
  return { supported: true, usage: { status: "error", message, accountEmail: null, planLabel: null } };
}

function resolveAccountEmail(stored: StoredToken | null): string | null {
  if (!stored) return null;
  if (stored.id_token_email && typeof stored.id_token_email === "string") {
    return stored.id_token_email;
  }
  if (!stored.id_token) return null;
  try {
    const payload = stored.id_token.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

export function normalizeAntigravityUsage(
  summary: QuotaSummary | null,
  detailed: QuotaDetailed | null,
  email: string | null
): ProviderUsageResult & { usage: AntigravityUsageState } {
  const windows: NormalizedWindow[] = [];

  function setWindow(window: NormalizedWindow) {
    const existingIndex = windows.findIndex((w) => w.id === window.id);
    if (existingIndex >= 0) {
      windows[existingIndex] = window;
    } else {
      windows.push(window);
    }
  }

  // 1. Check detailed buckets for Gemini models
  if (detailed?.buckets && detailed.buckets.length > 0) {
    const geminiBucket =
      detailed.buckets.find((b) => b.modelId === "gemini-3.8-flash-tiered") ||
      detailed.buckets.find((b) => b.modelId?.startsWith("gemini-3")) ||
      detailed.buckets.find((b) => b.modelId?.startsWith("gemini-"));

    if (geminiBucket) {
      const remaining = Number.isFinite(geminiBucket.remainingFraction) ? geminiBucket.remainingFraction! : 1;
      setWindow({
        id: "gemini-5h",
        kind: "five-hour",
        label: "Gemini (5-hour window)",
        model: "Gemini",
        usedPercent: Math.max(0, Math.min(100, Math.round((1 - remaining) * 100))),
        resetsAt: typeof geminiBucket.resetTime === "string" ? geminiBucket.resetTime : null,
      });
    }
  }

  // 2. Process summary groups (e.g. Gemini Models, Claude and GPT models)
  for (const group of summary?.groups ?? []) {
    const groupName = group.displayName ?? "";
    const isClaudeGpt = /claude|gpt/iu.test(groupName);
    const isGemini = /gemini/iu.test(groupName);

    for (const bucket of group.buckets ?? []) {
      const remaining = Number.isFinite(bucket.remainingFraction) ? bucket.remainingFraction! : 1;
      const bucketId = bucket.bucketId ?? "";
      const is5h = bucket.window === "5h" || bucketId.includes("5h");
      const isWeekly = bucket.window === "weekly" || bucketId.includes("weekly");

      let label = bucket.displayName ?? groupName;
      let kind: "five-hour" | "weekly" | "custom" = "custom";
      let model: string | null = null;

      if (isClaudeGpt) {
        model = "Claude & GPT";
        if (is5h) {
          label = "Claude & GPT (5-hour window)";
          kind = "five-hour";
        } else if (isWeekly) {
          label = "Claude & GPT (Weekly window)";
          kind = "weekly";
        }
      } else if (isGemini || bucketId.includes("gemini")) {
        model = "Gemini";
        if (is5h) {
          label = "Gemini (5-hour window)";
          kind = "five-hour";
        } else if (isWeekly) {
          label = "Gemini (Weekly window)";
          kind = "weekly";
        }
      }

      setWindow({
        id: bucket.bucketId ?? `window-${windows.length}`,
        kind,
        label,
        model,
        usedPercent: Math.max(0, Math.min(100, Math.round((1 - remaining) * 100))),
        resetsAt: typeof bucket.resetTime === "string" ? bucket.resetTime : null,
      });
    }
  }

  // Consistent ordering: Gemini weekly -> 5h -> Claude/GPT weekly -> 5h
  const sortOrder: Record<string, number> = {
    "gemini-weekly": 1,
    "gemini-5h": 2,
    "3p-weekly": 3,
    "3p-5h": 4,
  };
  windows.sort((a, b) => (sortOrder[a.id] ?? 99) - (sortOrder[b.id] ?? 99));

  if (windows.length === 0) {
    return {
      supported: true,
      usage: {
        status: "error",
        message: "Antigravity returned no quota windows.",
        accountEmail: email,
        planLabel: "Antigravity",
        windows: [],
      },
    };
  }

  return {
    supported: true,
    usage: {
      status: "ok",
      accountEmail: email,
      planLabel: "Antigravity",
      windows,
    },
  };
}

interface HubInfo {
  pid?: number;
  httpPort?: number;
  csrfToken?: string;
}

async function findActiveHub(): Promise<HubInfo | null> {
  const { readdir, readFile } = await import("node:fs/promises");
  const candidateDirs = [
    join(homedir(), ".gemini", "antigravity", "daemon"),
    join(homedir(), ".gemini", "antigravity-cli", "daemon"),
    join(homedir(), ".gemini", "daemon"),
  ];

  for (const dir of candidateDirs) {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.startsWith("hub_") || !file.endsWith(".json")) continue;
        const filePath = join(dir, file);
        const content = await readFile(filePath, "utf8");
        const info = JSON.parse(content) as HubInfo;
        if (info.httpPort && info.csrfToken) {
          if (typeof info.pid === "number") {
            try {
              process.kill(info.pid, 0);
            } catch {
              continue;
            }
          }
          return info;
        }
      }
    } catch {
      // directory does not exist or is unreadable
    }
  }
  return null;
}

async function fetchSummaryFromHub(hub: HubInfo, fetcher: typeof fetch): Promise<QuotaSummary | null> {
  try {
    const res = await fetcher(
      `http://127.0.0.1:${hub.httpPort}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Codeium-Csrf-Token": hub.csrfToken!,
        },
        body: JSON.stringify({ force_refresh: true }),
        signal: AbortSignal.timeout(4_000),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return (data?.response ?? data) as QuotaSummary;
  } catch {
    return null;
  }
}

async function requestEndpoint(
  url: string,
  accessToken: string,
  fetcher: typeof fetch,
  body: object = { project: "aicode-consumers" }
): Promise<Response> {
  return fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

async function fetchQuotaData(
  accessToken: string,
  fetcher: typeof fetch,
  summaryUrlOverride?: string
): Promise<{ summary: QuotaSummary | null; detailed: QuotaDetailed | null; errorStatus?: number }> {
  // 1. Try local language server hub if available (provides both Gemini weekly + 5h and Claude/GPT)
  if (!summaryUrlOverride && !process.env.ANTIGRAVITY_QUOTA_URL) {
    const hub = await findActiveHub();
    if (hub) {
      const hubSummary = await fetchSummaryFromHub(hub, fetcher);
      if (hubSummary && Array.isArray(hubSummary.groups) && hubSummary.groups.length > 0) {
        return { summary: hubSummary, detailed: null };
      }
    }
  }

  const summaryUrl = summaryUrlOverride ?? process.env.ANTIGRAVITY_QUOTA_URL ?? DEFAULT_QUOTA_SUMMARY_URL;

  let summaryRes = await requestEndpoint(summaryUrl, accessToken, fetcher).catch(() => null);
  if (!summaryRes || (!summaryRes.ok && summaryRes.status !== 401 && summaryRes.status !== 403)) {
    summaryRes = await requestEndpoint(FALLBACK_QUOTA_SUMMARY_URL, accessToken, fetcher).catch(() => null);
  }

  if (summaryRes?.status === 401 || summaryRes?.status === 403) {
    return { summary: null, detailed: null, errorStatus: summaryRes.status };
  }

  let detailedRes = await requestEndpoint(DEFAULT_QUOTA_DETAILED_URL, accessToken, fetcher).catch(() => null);
  if (!detailedRes || (!detailedRes.ok && detailedRes.status !== 401 && detailedRes.status !== 403)) {
    detailedRes = await requestEndpoint(FALLBACK_QUOTA_DETAILED_URL, accessToken, fetcher).catch(() => null);
  }

  const summary = summaryRes && summaryRes.ok ? ((await summaryRes.json().catch(() => null)) as QuotaSummary) : null;
  const detailed = detailedRes && detailedRes.ok ? ((await detailedRes.json().catch(() => null)) as QuotaDetailed) : null;

  return { summary, detailed };
}

async function refreshedAccessToken(refreshToken: string, fetcher: typeof fetch): Promise<string | null> {
  const clientSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
  if (!clientSecret) return null;
  try {
    const response = await fetcher(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { access_token?: unknown };
    return typeof body.access_token === "string" ? body.access_token : null;
  } catch {
    return null;
  }
}

function isTokenExpired(stored: StoredToken): boolean {
  const expiry = stored.token?.expiry;
  if (!expiry) return false;
  try {
    const normalized = expiry.replace(/(\.\d{3})\d+/, "$1");
    const expiryMs = Date.parse(normalized);
    if (!Number.isFinite(expiryMs)) return false;
    return expiryMs - Date.now() < 60_000;
  } catch {
    return false;
  }
}

async function resolveAgyBinary(preferredCli?: string): Promise<string | null> {
  const candidates = [
    preferredCli,
    "agy",
    "/Applications/Gemini.app/Contents/Helpers/agy",
    join(homedir(), ".gemini", "antigravity", "bin", "agy"),
    join(homedir(), ".gemini", "antigravity-cli", "bin", "agy"),
  ].filter((c): c is string => Boolean(c));

  const { access, constants } = await import("node:fs/promises");
  for (const candidate of candidates) {
    if (candidate === "agy") {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        await promisify(execFile)("which", ["agy"]);
        return "agy";
      } catch {
        continue;
      }
    }
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue search
    }
  }
  return null;
}

async function refreshViaAgyCli(preferredCli?: string): Promise<void> {
  const bin = await resolveAgyBinary(preferredCli);
  if (!bin) return;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync(bin, ["models"], {
      timeout: 10_000,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch {
    // Ignore errors
  }
}

export async function readAntigravityUsage(options: {
  tokenPath?: string;
  fetcher?: typeof fetch;
  agyCli?: string;
  quotaUrl?: string;
} = {}): Promise<ProviderUsageResult & { usage: AntigravityUsageState }> {
  const tokenPath =
    options.tokenPath ??
    process.env.ANTIGRAVITY_TOKEN_PATH ??
    join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const fetcher = options.fetcher ?? fetch;

  async function readToken(): Promise<StoredToken | null> {
    try {
      return (JSON.parse(await readFile(tokenPath, "utf8"))) as StoredToken;
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      if (code === "ENOENT") {
        if (process.platform === "darwin") {
          const fromMac = await readStoredTokenFromMacKeychain();
          if (fromMac) return fromMac;
        }
        if (process.platform === "win32") {
          return readStoredTokenFromWindowsKeyring();
        }
        return null;
      }
      throw cause;
    }
  }

  let stored: StoredToken | null;
  try {
    stored = await readToken();
  } catch {
    return error("Could not read Antigravity authentication token.") as any;
  }

  if (!stored) {
    return {
      supported: true,
      usage: { status: "unauthenticated", accountEmail: null, planLabel: null, windows: [] },
    };
  }

  let accessToken = stored.token?.access_token;
  if (!accessToken) {
    return {
      supported: true,
      usage: { status: "unauthenticated", accountEmail: null, planLabel: null, windows: [] },
    };
  }

  if (isTokenExpired(stored)) {
    await refreshViaAgyCli(options.agyCli);
    try {
      const refreshed = await readToken();
      if (refreshed?.token?.access_token) {
        stored = refreshed;
        accessToken = refreshed.token.access_token;
      }
    } catch {
      // Proceed with existing token
    }
  }

  try {
    let { summary, detailed, errorStatus } = await fetchQuotaData(accessToken, fetcher, options.quotaUrl);

    if (errorStatus === 401) {
      let refreshedToken: string | null = null;
      if (stored.token?.refresh_token) {
        refreshedToken = await refreshedAccessToken(stored.token.refresh_token, fetcher);
      }
      if (!refreshedToken) {
        await refreshViaAgyCli(options.agyCli);
        try {
          const reread = await readToken();
          refreshedToken = reread?.token?.access_token ?? null;
          if (reread) stored = reread;
        } catch {
          // Ignore
        }
      }
      if (!refreshedToken) {
        return {
          supported: true,
          usage: { status: "expired", accountEmail: null, planLabel: null, windows: [] },
        };
      }
      accessToken = refreshedToken;
      const retryResult = await fetchQuotaData(accessToken, fetcher, options.quotaUrl);
      summary = retryResult.summary;
      detailed = retryResult.detailed;
      errorStatus = retryResult.errorStatus;
    }

    if (errorStatus === 401 || errorStatus === 403) {
      return {
        supported: true,
        usage: { status: "expired", accountEmail: null, planLabel: null, windows: [] },
      };
    }

    if (!summary && !detailed) {
      return error("Antigravity quota request failed.") as any;
    }

    return normalizeAntigravityUsage(summary, detailed, resolveAccountEmail(stored));
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause)) as any;
  }
}
