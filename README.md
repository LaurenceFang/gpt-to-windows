# GPT-to-Windows

Self-hosted MCP gateway connecting GPT-based agents to controlled local Windows capabilities.

This project is intended for a personally controlled Windows computer. It exposes local tools through an authenticated MCP endpoint and is **not** a sandbox or a general-purpose public service.

## What it provides

- Filesystem inspection and file operations
- Managed shell commands and background processes
- Local process status, output, input, and termination
- HTTP requests and file downloads
- GPU, memory, disk, port, and media inspection
- ComfyUI workflow and job operations
- Optional DashScope/Qwen visual analysis
- OAuth authorization code flow with PKCE

## Architecture

```text
GPT-based agent
      |
      | MCP over HTTPS
      v
Cloudflare Tunnel (optional)
      |
      v
MCP Relay (Express + MCP SDK)
      |
      +--> OAuth/PKCE + SQLite token metadata
      +--> Windows filesystem and processes
      +--> Local HTTP services and media tools
```

## Security model

- The relay binds to `127.0.0.1` by default; public access requires an independently configured tunnel or reverse proxy.
- MCP requests require a bearer token issued through the relay's OAuth authorization flow.
- Authorization is explicit: the user approves the ChatGPT client on the relay authorization page.
- OAuth tokens are stored as hashes in a local SQLite database. The database is runtime state and must not be committed.
- Request lifecycle and managed process events are logged locally.
- The relay intentionally operates with the current Windows user's permissions. It does not provide a filesystem sandbox, command sandbox, or per-tool OS account isolation.
- Only run it on a machine and network boundary you control. Review every tool call before using it with sensitive data.

## Local setup

Install dependencies and build:

```powershell
npm ci
npm run typecheck
npm run build
```

For local-only secrets, create an ignored `.env.local` file:

```text
DASHSCOPE_API_KEY=replace-with-your-local-key
```

The included Windows launcher reads `DASHSCOPE_API_KEY` from the process environment first, then from `.env.local`.

Set `RELAY_PUBLIC_BASE_URL` to the externally reachable HTTPS base URL when using a tunnel. The local server listens on `127.0.0.1:8787` by default.

## Runtime files

The following are local runtime data and are intentionally excluded from Git:

- `state/` — SQLite state and managed-process records
- `logs/` — supervisor and process logs
- `.env.local` — local secrets
- `dist/` — generated JavaScript
- `node_modules/` — installed dependencies
- `backup_pre_p0/` — local historical backup

## Project status

This is a personal infrastructure project and an experimental computer-use bridge. The current implementation prioritizes explicit user authorization and practical local integration over sandboxing or multi-tenant isolation.
