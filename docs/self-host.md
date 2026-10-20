# Self-host with Docker Compose (e.g. a homelab test)

Runs the multi-user (HTTP) mode on any Docker host. Typical use: prove the full chain — AI client → this server → Zoho sign-in → ServiceDesk — before deploying to the cloud.

Files: [`deploy/compose/`](../deploy/compose/) — `docker-compose.yml`, `Caddyfile`, `.env.example`.

## What you need

- **A public HTTPS host name** (e.g. `mcp.example.com`). Claude and Microsoft Copilot call the server **from their own clouds**, not from your PC: `localhost` or a LAN address does not work.
- One of:
  - **Your own reverse proxy** (no profile): any proxy that terminates HTTPS for the name and forwards to the server's port on the Docker host.
  - **Caddy profile:** ports 80 and 443 forwarded to the Docker host, and a DNS `A`/`AAAA` record for the name. Caddy gets a Let's Encrypt certificate automatically.
  - **Your own reverse proxy:** set `MCP_BIND` (the Docker host's LAN address) and `MCP_HOST_PORT` in `.env`, and allow that port on the Docker host's firewall from the proxy's address only. Caddy example, on the proxy machine:

```
mcp.example.com {
	@app path /mcp /mcp/ /healthz /oauth/* /.well-known/*
	handle @app {
		reverse_proxy 192.168.1.20:18080 {
			flush_interval -1
		}
	}
	handle {
		respond 404
	}
}
```

Keep the `Host` header as received (Caddy does by default). `TRUST_PROXY_HOPS=1` for one proxy; `2` if another proxy that adds `X-Forwarded-For` sits in front of it (e.g. Cloudflare with the orange cloud on).

**Tunnel profile:** a Cloudflare account with the domain, and a Cloudflare Tunnel. No inbound ports.
- The Zoho client from [zoho-client.md](zoho-client.md). Its redirect URIs point at the AI clients (`claude.ai`, `teams.microsoft.com`, …), not at this server, so **nothing changes in Zoho** for a self-hosted test.

## Run

```bash
cd deploy/compose
cp .env.example .env        # fill in MCP_DOMAIN, SDP_*, ZOHO_*, ALLOWED_USERS
docker compose up -d --build                    # behind your own reverse proxy
# or: docker compose --profile caddy up -d --build
# or: docker compose --profile tunnel up -d --build
docker compose logs -f mcp  # "listening on :8080 — public URL https://<MCP_DOMAIN>/mcp"
```

The image is built from source with the repository's `Dockerfile`. The server container has no published port; only the proxy reaches it.

**Your own reverse proxy:** set `MCP_BIND` (the Docker host's LAN address) and `MCP_HOST_PORT` in `.env`, and allow that port on the Docker host's firewall from the proxy's address only. Caddy example, on the proxy machine:

```
mcp.example.com {
	@app path /mcp /mcp/ /healthz /oauth/* /.well-known/*
	handle @app {
		reverse_proxy 192.168.1.20:18080 {
			flush_interval -1
		}
	}
	handle {
		respond 404
	}
}
```

Keep the `Host` header as received (Caddy does by default). `TRUST_PROXY_HOPS=1` for one proxy; `2` if another proxy that adds `X-Forwarded-For` sits in front of it (e.g. Cloudflare with the orange cloud on).

**Tunnel profile:** in the Cloudflare dashboard (Zero Trust → Networks → Tunnels), create a tunnel, copy its token into `CLOUDFLARE_TUNNEL_TOKEN`, and add a *public hostname* `MCP_DOMAIN` → service `http://mcp:8080`.

### Already running a reverse proxy?

Skip both profiles and start only the server: `docker compose up -d --build` (no `--profile`). Then make it reachable from your proxy, and keep `TRUST_PROXY_HOPS=1`:

- **Proxy in Docker:** put `mcp` on the proxy's network. In `docker-compose.yml`, add under `mcp:` `networks: [default, proxy]`, and at the end `networks: { proxy: { external: true, name: <your proxy's network> } }`. The upstream is `mcp:8080`.
- **Proxy on the host:** publish the port to loopback only, under `mcp:` `ports: ["127.0.0.1:8080:8080"]`. The upstream is `127.0.0.1:8080`.

Caddy site block (other proxies: keep the `Host` header, don't buffer responses, forward only these paths):

```
mcp.example.com {
	@app path /mcp /mcp/ /healthz /oauth/* /.well-known/*
	handle @app {
		reverse_proxy mcp:8080 {
			flush_interval -1
		}
	}
	handle {
		respond 404
	}
}
```

## Check

```bash
curl -s https://mcp.example.com/healthz                                    # ok
curl -s https://mcp.example.com/.well-known/oauth-protected-resource/mcp   # JSON, resource = https://mcp.example.com/mcp
curl -si -X POST https://mcp.example.com/mcp | head -5                     # 401 + WWW-Authenticate
curl -si https://mcp.example.com/mcp | head -1                             # 405 (GET not allowed)
```

Then connect a client as in [clients.md](clients.md), with `https://mcp.example.com` as the base URL. Signing in once and asking for your project list proves the chain; one harmless update (a comment on a test task) proves writes and the audit line:

```bash
docker compose logs mcp | grep '\[audit\]'
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `403 invalid_host` on `/mcp` | The proxy changed the `Host` header. Caddy keeps it by default. For the tunnel, set *HTTP Host Header* = `MCP_DOMAIN` in the public hostname's settings |
| `403 forbidden … is not allowed` | Your Zoho e-mail is not in `ALLOWED_USERS` / `ALLOWED_EMAIL_DOMAINS` (compare in lower case) |
| Client loops on sign-in, or "invalid_client" | Client configured with Zoho's URLs instead of this server's, or a different Zoho client ID than `ZOHO_CLIENT_ID` |
| `503 temporarily_unavailable` | Zoho could not be reached for the token check; retry. Persisting: outbound HTTPS from the host is blocked |
| Client cannot connect at all, `curl` from outside works | Cloudflare *Bot Fight Mode*, WAF or "Under attack" mode challenging the AI providers' servers. Exempt the host name |
| Certificate errors (Caddy) | Port 80 not reachable from the internet (needed for the Let's Encrypt challenge), or DNS not pointing at the host yet |

## Notes

- A self-hosted test carries real ServiceDesk data and real user tokens through the host. Treat it like production: up-to-date host, only `ALLOWED_USERS` you know, and stop it when the test is done (`docker compose --profile caddy down`).
- After the test, users revoke the sign-in under Zoho *My account → Connected apps*, and the connector is removed from the AI client.
- One replica only, as in every deployment of this server (in-memory token cache and rate limits).
- Update: `git pull`, then `docker compose --profile caddy up -d --build`.
