# Deploy on Azure Container Apps

A single small container, reachable over HTTPS on your own domain. Commands below use the Azure CLI; adjust names and region. They are a starting point, not a tested script — review them with whoever operates your Azure tenant.

## 1. Build the image

```bash
RG=rg-servicedesk-mcp
LOC=switzerlandnorth
ACR=<yourregistry>            # globally unique, lowercase
APP=servicedesk-mcp
ENV=cae-servicedesk-mcp
VER=0.5.3

az group create -n $RG -l $LOC
az acr create -n $ACR -g $RG --sku Basic
az acr build -r $ACR -t servicedesk-projects-mcp:$VER .     # multi-stage build from source; .dockerignore keeps .env out of the upload
```

## 2. Create the app

```bash
az containerapp env create -n $ENV -g $RG -l $LOC

az containerapp create -n $APP -g $RG --environment $ENV \
  --image $ACR.azurecr.io/servicedesk-projects-mcp:$VER \
  --registry-server $ACR.azurecr.io --registry-identity system \
  --ingress external --target-port 8080 \
  --min-replicas 1 --max-replicas 1 \
  --cpu 0.25 --memory 0.5Gi \
  --env-vars \
    MCP_TRANSPORT=http PORT=8080 \
    PUBLIC_BASE_URL=https://mcp.example.com \
    SDP_BASE_URL=https://sdpondemand.manageengine.eu SDP_PORTAL=itdesk \
    ZOHO_ACCOUNTS_URL=https://accounts.zoho.eu \
    ZOHO_CLIENT_ID=<client id of the shared Zoho client> \
    TRUST_PROXY_HOPS=1 \
    SDP_TIMEZONE=Europe/Zurich \
    ALLOWED_EMAIL_DOMAINS=example.com \
    SDP_WRITE_PROJECT_IDS='*'
```

- **One replica.** The token-check cache and the rate limit live in memory. For several replicas, put a gateway (e.g. Azure API Management) in front and move rate limiting there.
- `ZOHO_CLIENT_ID` is not a secret; the client **secret** is not given to the server at all.
- `TRUST_PROXY_HOPS=1`: Container Apps ingress is one proxy hop, so the per-IP limit uses the real client address.
- **No secrets** are needed by the server in this mode. If you later add any, use Container Apps secrets backed by Key Vault, not plain environment variables.
- `SDP_WRITE_PROJECT_IDS='*'` leaves write control to ServiceDesk permissions: anything a user may change in ServiceDesk, the AI may change on their behalf. A list of project ids restricts writes further, at the cost of maintaining it. See the README's *Security model*.
- `SDP_TIMEZONE` applies to all users. If people in other time zones use the server, tell them deadlines are in that zone.
- Optional: `SDP_STREAM_FIELD=udf_char1`, `SDP_TASK_TEMPLATES='{"<project id>":"<template>"}'`.

## 3. Custom domain (required for Entra-based clients, recommended anyway)

`PUBLIC_BASE_URL` must be the address users' clients reach, exactly, on HTTPS.

```bash
az containerapp hostname add  -n $APP -g $RG --hostname mcp.example.com
# create the CNAME and TXT records the command prints, then:
az containerapp hostname bind -n $APP -g $RG --hostname mcp.example.com --environment $ENV --validation-method CNAME
```

## 4. Check

```bash
curl -s https://mcp.example.com/healthz                                     # ok
curl -s https://mcp.example.com/.well-known/oauth-protected-resource/mcp    # JSON, resource = https://mcp.example.com/mcp
curl -si -X POST https://mcp.example.com/mcp | head -5                      # 401 + WWW-Authenticate
```

## 5. Hardening checklist

| Item | How |
|---|---|
| Only your users | `ALLOWED_EMAIL_DOMAINS` and/or `ALLOWED_USERS`; ServiceDesk SSO puts sign-in behind your identity provider |
| Least privilege | Zoho scopes without `DELETE`; no delete tool; `SDP_WRITE_PROJECT_IDS` as a brake |
| Network | Ingress IP restrictions (`az containerapp ingress access-restriction set`). Claude calls from `160.79.104.0/21` ([Anthropic IP ranges](https://platform.claude.com/docs/en/api/ip-addresses)). Microsoft 365 Copilot and Copilot Studio call from Microsoft-managed addresses: determine and test those before enabling an allow-list, or the Copilot side stops working |
| Abuse | Per-user rate limit, per-IP limit for anonymous traffic (Claude and Copilot users share a few provider addresses), POST-only `/mcp`, `503` instead of lock-out when Zoho is down, no JSON-RPC batches, 256 KB on `/mcp`, 16 KB on OAuth bodies, cached rejection of bad tokens, inbound and outbound timeouts |
| OAuth facade | Only `ZOHO_CLIENT_ID` is accepted on `/oauth/authorize` and `/oauth/token`, repeated parameters are refused and only a fixed set is forwarded to Zoho, so your domain cannot front other Zoho apps' consent screens. The facade does not decide who gets in: the allow-list on `/mcp` does |
| Audit | Container logs → Log Analytics. Every write is one `[audit]` JSON line with the user's e-mail |
| Supply chain | The image is built from source in a multi-stage build; Dependabot and the CI workflow (`npm audit`, tests, dist-matches-source check) are in `.github/`; scan the image (e.g. Defender for Containers); pin the image tag, and optionally the base image digest |
| Revocation | Per user: Zoho *Connected apps*. Everyone: delete the Zoho client, or stop the container app |

## 6. Update

```bash
az acr build -r $ACR -t servicedesk-projects-mcp:<new version> .
az containerapp update -n $APP -g $RG --image $ACR.azurecr.io/servicedesk-projects-mcp:<new version>
```
