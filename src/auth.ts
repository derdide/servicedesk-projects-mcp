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
    if (!cfg.refreshToken) throw new Error("Missing required configuration: ZOHO_REFRESH_TOKEN");
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
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    const res = await fetch(`${this.cfg.zohoAccountsUrl}/oauth/v2/token`, {
      method: "POST",
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
