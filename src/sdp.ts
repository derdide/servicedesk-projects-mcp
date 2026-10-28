import { appendFileSync } from "node:fs";
import type { Config } from "./config.js";
import type { TokenProvider } from "./auth.js";

export class SdpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

type Json = Record<string, any>;

/** Thin client for the ServiceDesk Plus Cloud v3 API. */
export class SdpClient {
  private apiBase: string;

  constructor(
    private cfg: Config,
    private tokens: TokenProvider,
    private user?: string, // e-mail of the signed-in user (HTTP mode), for the audit trail
    private onTokenRejected?: () => void, // HTTP mode: forget the cached token check
  ) {
    this.apiBase = `${cfg.sdpBaseUrl}/app/${encodeURIComponent(cfg.portal)}/api/v3`;
  }

  async get(path: string, inputData?: Json): Promise<Json> {
    const qs = inputData ? `?input_data=${encodeURIComponent(JSON.stringify(inputData))}` : "";
    return this.call("GET", path + qs);
  }

  async post(path: string, inputData: Json): Promise<Json> {
    return this.call("POST", path, inputData);
  }

  async put(path: string, inputData: Json): Promise<Json> {
    return this.call("PUT", path, inputData);
  }

  /** DELETE with plain form fields (ServiceDesk takes `ids=...` on its relationship endpoints). */
  async delete(path: string, form: Record<string, string>): Promise<Json> {
    return this.call("DELETE", path, undefined, false, form);
  }

  /** Fetch every page of a list endpoint (up to `max` records). */
  async listAll(path: string, rootKey: string, max = 500, extra: Json = {}): Promise<Json[]> {
    const out: Json[] = [];
    let start = 1;
    const rows = 100;
    while (out.length < max) {
      const res = await this.get(path, {
        list_info: { row_count: rows, start_index: start, get_total_count: true, ...extra },
      });
      const items = (res[rootKey] as Json[] | undefined) ?? [];
      out.push(...items);
      const info = res.list_info as Json | undefined;
      if (!info?.has_more_rows || items.length === 0) break;
      start += rows;
    }
    return out.slice(0, max);
  }

  private async call(method: string, path: string, inputData?: Json, retried = false, form?: Record<string, string>): Promise<Json> {
    // Defence in depth: only plain API paths, never traversal, encoded dots or extra query strings.
    const [pathname, query] = path.split("?", 2);
    if (!/^\/[A-Za-z0-9_/]+$/.test(pathname) || pathname.includes("//") || (query !== undefined && !query.startsWith("input_data="))) {
      throw new SdpError(`Refused unsafe ServiceDesk path`, 400, { path: pathname.slice(0, 80) });
    }
    const token = await this.tokens.getAccessToken();
    const body = inputData ? new URLSearchParams({ input_data: JSON.stringify(inputData) }) : form ? new URLSearchParams(form) : undefined;
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/vnd.manageengine.sdp.v3+json",
        Authorization: `Zoho-oauthtoken ${token}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(body ? { body } : {}),
    };
    const res = await fetch(this.apiBase + path, { ...init, signal: AbortSignal.timeout(this.cfg.sdpTimeoutMs) });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = { raw: text.slice(0, 2000) };
    }
    if (res.status === 401) {
      if (this.onTokenRejected) {
        // HTTP mode: the token belongs to the client, which must refresh it. Forget our cached check so the
        // next request is re-validated and answered with HTTP 401 if the token is no longer valid.
        this.onTokenRejected();
        throw new SdpError("ServiceDesk rejected your access token (expired or revoked). Please retry; if it persists, reconnect / sign in again.", 401, json);
      }
      if (!retried) {
        this.tokens.invalidate();
        return this.call(method, path, inputData, true, form);
      }
    }
    if (!res.ok) {
      throw new SdpError(`ServiceDesk ${method} ${path} failed (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 1500)}`, res.status, json);
    }
    return json;
  }

  audit(entry: Json): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...(this.user ? { user: this.user } : {}), ...entry });
    process.stderr.write(`[audit] ${line}\n`);
    if (this.cfg.auditLogPath) {
      try {
        appendFileSync(this.cfg.auditLogPath, line + "\n", "utf8");
      } catch (e) {
        process.stderr.write(`[audit] could not write audit log: ${(e as Error).message}\n`);
      }
    }
  }
}
