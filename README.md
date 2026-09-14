# Connection Relay MCP — Local Windows Computer Bridge

Full-authority local MCP server for ChatGPT, published through Cloudflare Tunnel.

This project is intended for a personally controlled Windows computer. It can
read and write local files, run commands, make HTTP requests, and manage local
processes. Do not expose it as an untrusted public service.

Set `RELAY_PUBLIC_BASE_URL=https://relay.ades.top` before starting. The server listens on `127.0.0.1:8787` by default.

For local-only secrets, create an ignored `.env.local` file:

```text
DASHSCOPE_API_KEY=replace-with-your-local-key
```

Never commit `.env.local`, `state/`, `logs/`, or local backups.
