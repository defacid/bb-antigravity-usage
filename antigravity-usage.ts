import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderUsageResult } from "@get-bb/plugin-sdk/provider-bridge";

const DEFAULT_QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const FALLBACK_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const REFRESH_URL = "https://oauth2.googleapis.com/token";
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
// Google requires a client secret to exchange a refresh token. Never embed one
// from the Antigravity client in a distributable plugin.
const USER_AGENT = "Antigravity/1.2.11";

// Windows Credential Manager key used by the agy CLI to store its OAuth token.
const WINDOWS_KEYRING_TARGET = "gemini:antigravity";

interface StoredToken {
  token?: { access_token?: string; refresh_token?: string; expiry?: string };
  id_token?: string;
}

/**
 * On Windows, agy stores its OAuth token in the Windows Credential Manager
 * (keyring) rather than a plain JSON file. The credential blob contains the
 * same JSON structure as the Unix token file: { token: { access_token, ... } }.
 * This function attempts to read it via the native Win32 CredReadW API, which
 * is available in Node via a small inline ffi call using node:ffi or a
 * PowerShell subprocess (for portability without native addons).
 */
async function readStoredTokenFromWindowsKeyring(): Promise<StoredToken | null> {
  if (process.platform !== "win32") return null;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    // PowerShell inline: read the credential blob from Credential Manager and
    // print it as UTF-8 JSON to stdout.
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
  remainingFraction?: number;
  resetTime?: string;
}

interface QuotaGroup {
  displayName?: string;
  buckets?: QuotaBucket[];
}

export interface QuotaSummary { groups?: QuotaGroup[] }

function error(message: string): ProviderUsageResult {
  return { supported: true, usage: { status: "error", message, accountEmail: null, planLabel: null } };
}

function accountEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : null;
  } catch {
    return null;
  }
}

export function normalizeAntigravityUsage(summary: QuotaSummary, email: string | null): ProviderUsageResult {
  const windows = (summary.groups ?? []).flatMap((group) => {
    const name = group.displayName ?? "";
    const label = /gemini/iu.test(name)
      ? "Weekly limit (Gemini)"
      : /claude|gpt/iu.test(name)
        ? "Weekly limit (Claude & GPT)"
        : name ? `Weekly limit (${name})` : "Weekly limit";
    return (group.buckets ?? []).map((bucket) => {
      const remaining = Number.isFinite(bucket.remainingFraction) ? bucket.remainingFraction! : 1;
      return {
        label,
        usedPercent: Math.max(0, Math.min(100, Math.round((1 - remaining) * 100))),
        resetsAt: typeof bucket.resetTime === "string" ? bucket.resetTime : null,
      };
    });
  });
  if (windows.length === 0) return error("Antigravity returned no quota windows.");
  return { supported: true, usage: { status: "ok", accountEmail: email, planLabel: "Antigravity", windows } };
}

async function requestQuota(
  accessToken: string,
  fetcher: typeof fetch,
  quotaUrl?: string,
): Promise<Response> {
  const url = quotaUrl ?? process.env.ANTIGRAVITY_QUOTA_URL ?? DEFAULT_QUOTA_URL;
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ project: "aicode-consumers" }),
    });
    if (res.ok || res.status === 401 || res.status === 403 || url !== DEFAULT_QUOTA_URL) {
      return res;
    }
  } catch (cause) {
    if (url !== DEFAULT_QUOTA_URL) throw cause;
  }

  return fetcher(FALLBACK_QUOTA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ project: "aicode-consumers" }),
  });
}

async function refreshedAccessToken(refreshToken: string, fetcher: typeof fetch): Promise<string | null> {
  const clientSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
  if (!clientSecret) return null;
  const response = await fetcher(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) return null;
  const body = await response.json() as { access_token?: unknown };
  return typeof body.access_token === "string" ? body.access_token : null;
}

/** Returns true if the stored token's expiry is in the past or within 60 s. */
function isTokenExpired(stored: StoredToken): boolean {
  const expiry = stored.token?.expiry;
  if (!expiry) return false;
  try {
    // expiry format: "2026-10-03T21:16:36.740624162-04:00" — strip sub-second
    // precision beyond what Date.parse handles, then parse.
    const normalized = expiry.replace(/(\.\d{3})\d+/, "$1");
    const expiryMs = Date.parse(normalized);
    if (!Number.isFinite(expiryMs)) return false;
    return expiryMs - Date.now() < 60_000; // treat as expired if < 60 s away
  } catch {
    return false;
  }
}

/**
 * Invoke the lightweight `agy models` command with a short timeout so the
 * Antigravity CLI can refresh its OAuth token transparently. Empty print-mode
 * prompts exit before acquiring a token in agy 1.3.3 and later; listing models
 * authenticates without starting an inference turn. We intentionally ignore
 * stdout/stderr — the side-effect we care about is the updated token file.
 */
async function refreshViaAgyCli(agyCli?: string): Promise<void> {
  if (!agyCli) return;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync(agyCli, ["models"], {
      timeout: 10_000,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch {
    // Ignore errors — we'll re-read the token file anyway and detect failure
    // downstream via the HTTP response status.
  }
}

export async function readAntigravityUsage(options: {
  tokenPath?: string;
  fetcher?: typeof fetch;
  agyCli?: string;
  quotaUrl?: string;
} = {}): Promise<ProviderUsageResult> {
  const tokenPath = options.tokenPath
    ?? process.env.ANTIGRAVITY_TOKEN_PATH
    ?? join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const fetcher = options.fetcher ?? fetch;

  async function readToken(): Promise<StoredToken | null> {
    try {
      return JSON.parse(await readFile(tokenPath, "utf8")) as StoredToken;
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      if (code === "ENOENT") {
        // On Windows, agy stores its token in the Windows Credential Manager
        // (keyring) rather than a file. Fall back to reading from there.
        return readStoredTokenFromWindowsKeyring();
      }
      throw cause;
    }
  }

  let stored: StoredToken | null;
  try {
    stored = await readToken();
  } catch {
    return error("Could not read the Antigravity authentication token.");
  }

  if (!stored) return { supported: true, usage: { status: "unauthenticated" } };

  let accessToken = stored.token?.access_token;
  if (!accessToken) return { supported: true, usage: { status: "unauthenticated" } };

  // Proactively refresh via the agy CLI if the token is expired or near expiry,
  // before making the quota request.
  if (isTokenExpired(stored)) {
    await refreshViaAgyCli(options.agyCli);
    try {
      const refreshed = await readToken();
      if (refreshed?.token?.access_token) {
        stored = refreshed;
        accessToken = refreshed.token.access_token;
      }
    } catch { /* ignore, proceed with existing token */ }
  }

  try {
    let response = await requestQuota(accessToken, fetcher, options.quotaUrl);

    if (response.status === 401) {
      // Token was rejected. Try CLIENT_SECRET refresh first (if available), then
      // fall back to re-invoking the agy CLI.
      let refreshedToken: string | null = null;
      if (stored.token?.refresh_token) {
        refreshedToken = await refreshedAccessToken(stored.token.refresh_token, fetcher);
      }
      if (!refreshedToken) {
        // agy CLI refresh (no client secret needed)
        await refreshViaAgyCli(options.agyCli);
        try {
          const reread = await readToken();
          refreshedToken = reread?.token?.access_token ?? null;
        } catch { /* ignore */ }
      }
      if (!refreshedToken) return { supported: true, usage: { status: "expired" } };
      response = await requestQuota(refreshedToken, fetcher, options.quotaUrl);
    }

    if (response.status === 401 || response.status === 403) {
      return { supported: true, usage: { status: "expired" } };
    }
    if (!response.ok) return error(`Antigravity quota request failed (HTTP ${response.status}).`);
    return normalizeAntigravityUsage(await response.json() as QuotaSummary, accountEmail(stored.id_token));
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause));
  }
}
