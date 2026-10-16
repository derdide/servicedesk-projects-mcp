import type { Config } from "./config.js";

/**
 * Where access tokens come from. Kept behind an interface so the hosted
 * (multi-user) version can swap in a per-user provider without touching the
 * tools: each request then carries the identity of the human using it.
 */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Force refresh on next call (e.g. after a 401). */
  invalidate(): void;
}

/**
 * Local single-user mode: a Zoho "Self Client" refresh token belonging to the
 * user running the server. Changes in ServiceDesk are attributed to that user.
 */
export class RefreshTokenProvider implements TokenProvider {
  private token?: string;
  private expiresAt = 0;
  private inflight?: Promise<string>;

  constructor(private cfg: Config) {
    if (!cfg.refreshToken || !cfg.clientId || !cfg.clientSecret) throw new Error("Missing required configuration: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN");
  }

  invalidate(): void {
    this.token = undefined;
    this.expiresAt = 0;
  }

  async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => (this.inflight = undefined));
    }
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.cfg.refreshToken!,
      client_id: this.cfg.clientId!,
      client_secret: this.cfg.clientSecret!,
    });
    const res = await fetch(`${this.cfg.zohoAccountsUrl}/oauth/v2/token`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json.access_token !== "string") {
      throw new Error(
        `Zoho token refresh failed (HTTP ${res.status}): ${JSON.stringify(json)}. ` +
          `Check ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN and ZOHO_ACCOUNTS_URL (EU = https://accounts.zoho.eu).`,
      );
    }
    this.token = json.access_token;
    const ttl = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.expiresAt = Date.now() + ttl * 1000;
    return this.token;
  }
}

/**
 * Multi-user (HTTP) mode: the MCP client (Claude, Copilot, ...) signs the user in with Zoho
 * and sends the user's access token on every request. The server stores nothing; it only
 * forwards the token. Refreshing is the client's job, so invalidate() is a no-op.
 */
export class BearerTokenProvider implements TokenProvider {
  constructor(private token: string) {}
  async getAccessToken(): Promise<string> {
    return this.token;
  }
  invalidate(): void {}
}

export interface UserIdentity {
  email: string;
  name?: string;
}

/** Resolve a Zoho access token to the signed-in user (Zoho accounts "user info" endpoint). */
export async function fetchZohoIdentity(cfg: Config, token: string): Promise<UserIdentity | null> {
  const res = await fetch(`${cfg.zohoAccountsUrl}/oauth/user/info`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const email = typeof j.Email === "string" ? j.Email : typeof j.email === "string" ? j.email : undefined;
  if (!email) return null;
  const name = typeof j.Display_Name === "string" ? j.Display_Name : undefined;
  return { email: email.toLowerCase(), name };
}
