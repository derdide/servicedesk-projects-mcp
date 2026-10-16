# Deploy on Azure Container Apps

A single small container, reachable over HTTPS on your own domain. Commands below use the Azure CLI; adjust names and region. They are a starting point, not a tested script — review them with whoever operates your Azure tenant.

## 1. Build the image

```bash
RG=rg-servicedesk-mcp
LOC=switzerlandnorth
ACR=<yourregistry>            # globally unique, lowercase
APP=servicedesk-mcp
ENV=cae-servicedesk-mcp
VER=0.5.0

az group create -n $RG -l $LOC
az acr create -n $ACR -g $RG --sku Basic
az acr build -r $ACR -t servicedesk-projects-mcp:$VER .     # uses the Dockerfile in the repository root
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
    SDP_TIMEZONE=Europe/Zurich \
    ALLOWED_EMAIL_DOMAINS=example.com \
    SDP_WRITE_PROJECT_IDS='*'
```

- **One replica.** The token-check cache and the rate limit live in memory. For several replicas, put a gateway (e.g. Azure API Management) in front and move rate limiting there.
- **No secrets** are needed by the server in this mode. If you later add any, use Container Apps secrets backed by Key Vault, not plain environment variables.
- `SDP_WRITE_PROJECT_IDS='*'` leaves write control to ServiceDesk permissions. Use a list of project ids to restrict writes further.
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
| Abuse | Per-user rate limit (`RATE_LIMIT_PER_MINUTE`), 16 KB limit on OAuth bodies, request timeouts |
| Audit | Container logs → Log Analytics. Every write is one `[audit]` JSON line with the user's e-mail |
| Supply chain | Rebuild on dependency updates; scan the image (e.g. Defender for Containers); pin the image tag |
| Revocation | Per user: Zoho *Connected apps*. Everyone: delete the Zoho client, or stop the container app |

## 6. Update

```bash
az acr build -r $ACR -t servicedesk-projects-mcp:<new version> .
az containerapp update -n $APP -g $RG --image $ACR.azurecr.io/servicedesk-projects-mcp:<new version>
```
