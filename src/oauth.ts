import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { AccessDeniedError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 5 * 60;
const SCOPES = ["relay", "offline_access"];
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const randomToken = () => randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

function isChatGptRedirect(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "chatgpt.com"; } catch { return false; }
}
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }

type TokenRow = { token_hash: string; client_id: string; scopes_json: string; expires_at: number; resource: string };
type CodeRow = { code_hash: string; client_id: string; redirect_uri: string; code_challenge: string; scopes_json: string; resource: string; expires_at: number };

export class RelayOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly resource: URL;
  constructor(private readonly db: Database.Database, private readonly issuer: URL, mcpUrl: URL) {
    this.resource = resourceUrlFromServerUrl(mcpUrl);
    this.clientsStore = { getClient: (clientId) => this.getClient(clientId), registerClient: (client) => this.registerClient(client) };
    this.db.exec(`
      create table if not exists oauth_clients (client_id text primary key, client_json text not null, issued_at integer not null);
      create table if not exists oauth_access_tokens (token_hash text primary key, client_id text not null, scopes_json text not null, expires_at integer not null, resource text not null);
      create table if not exists oauth_refresh_tokens (token_hash text primary key, client_id text not null, scopes_json text not null, expires_at integer not null, resource text not null);
      create table if not exists oauth_authorization_codes (code_hash text primary key, client_id text not null, redirect_uri text not null, code_challenge text not null, scopes_json text not null, resource text not null, expires_at integer not null);
    `);
    for (const table of ["oauth_access_tokens", "oauth_refresh_tokens", "oauth_authorization_codes"]) this.db.prepare(`delete from ${table} where expires_at < ?`).run(now());
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!params.resource || !checkResourceAllowed({ requestedResource: params.resource, configuredResource: this.resource })) throw new InvalidRequestError("Invalid or missing OAuth resource");
    if ((params.scopes ?? []).some((scope) => !SCOPES.includes(scope))) throw new InvalidRequestError("Requested scope is not supported");
    const fields = this.fields(client, params);
    if (res.req.method !== "POST") { res.status(200).type("html").send(this.authorizationPage(client, params, fields)); return; }
    if (String(res.req.body?.approve ?? "") !== "yes") { this.redirect(res, params.redirectUri, { error: "access_denied", error_description: "Authorization was not approved", state: params.state }); return; }
    const code = `relay-code-${randomUUID()}`;
    this.db.prepare("insert into oauth_authorization_codes values (@code_hash,@client_id,@redirect_uri,@code_challenge,@scopes_json,@resource,@expires_at)").run({ code_hash: hash(code), client_id: client.client_id, redirect_uri: params.redirectUri, code_challenge: params.codeChallenge, scopes_json: JSON.stringify(params.scopes?.length ? params.scopes : SCOPES), resource: params.resource.href, expires_at: now() + CODE_TTL_SECONDS });
    this.redirect(res, params.redirectUri, { code, state: params.state });
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> { return this.code(client, authorizationCode).code_challenge; }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const record = this.code(client, authorizationCode);
    if (redirectUri && redirectUri !== record.redirect_uri) throw new InvalidGrantError("redirect_uri does not match authorization request");
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resource })) throw new InvalidGrantError("Invalid resource");
    this.db.prepare("delete from oauth_authorization_codes where code_hash = ?").run(hash(authorizationCode));
    return this.issue(client.client_id, JSON.parse(record.scopes_json) as string[], record.resource);
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, requestedScopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const record = this.db.prepare("select * from oauth_refresh_tokens where token_hash = ? and expires_at >= ?").get(hash(refreshToken), now()) as TokenRow | undefined;
    if (!record || record.client_id !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resource })) throw new InvalidGrantError("Invalid resource");
    const savedScopes = JSON.parse(record.scopes_json) as string[]; const scopes = requestedScopes ?? savedScopes;
    if (scopes.some((scope) => !savedScopes.includes(scope))) throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    return this.issue(client.client_id, scopes, resource?.href ?? record.resource, hash(refreshToken));
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.db.prepare("select * from oauth_access_tokens where token_hash = ? and expires_at >= ?").get(hash(token), now()) as TokenRow | undefined;
    if (!record) throw new InvalidTokenError("Invalid or expired access token");
    return { token, clientId: record.client_id, scopes: JSON.parse(record.scopes_json) as string[], expiresAt: record.expires_at, resource: new URL(record.resource) };
  }
  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> { const tokenHash = hash(request.token); this.db.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash); this.db.prepare("delete from oauth_refresh_tokens where token_hash = ?").run(tokenHash); }
  private getClient(clientId: string): OAuthClientInformationFull | undefined { const row = this.db.prepare("select client_json from oauth_clients where client_id = ?").get(clientId) as { client_json: string } | undefined; return row ? JSON.parse(row.client_json) as OAuthClientInformationFull : undefined; }
  private registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => isChatGptRedirect(String(uri)))) throw new InvalidRequestError("Only ChatGPT callback URLs are accepted");
    const { client_secret: _clientSecret, client_secret_expires_at: _clientSecretExpiry, ...publicMetadata } = client;
    const registered: OAuthClientInformationFull = { ...publicMetadata, client_id: `relay-${randomUUID()}`, client_id_issued_at: now(), token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
    this.db.prepare("insert into oauth_clients values (?,?,?)").run(registered.client_id, JSON.stringify(registered), now()); return registered;
  }
  private code(client: OAuthClientInformationFull, authorizationCode: string): CodeRow { const record = this.db.prepare("select * from oauth_authorization_codes where code_hash = ? and expires_at >= ?").get(hash(authorizationCode), now()) as CodeRow | undefined; if (!record || record.client_id !== client.client_id) throw new InvalidGrantError("Invalid authorization code"); return record; }
  private issue(clientId: string, scopes: string[], resource: string, consumedRefreshHash?: string): OAuthTokens {
    const accessToken = randomToken(), refreshToken = randomToken(), issuedAt = now();
    this.db.transaction(() => { if (consumedRefreshHash && this.db.prepare("delete from oauth_refresh_tokens where token_hash = ?").run(consumedRefreshHash).changes !== 1) throw new InvalidGrantError("Invalid refresh token"); this.db.prepare("insert into oauth_access_tokens values (?,?,?,?,?)").run(hash(accessToken), clientId, JSON.stringify(scopes), issuedAt + ACCESS_TTL_SECONDS, resource); this.db.prepare("insert into oauth_refresh_tokens values (?,?,?,?,?)").run(hash(refreshToken), clientId, JSON.stringify(scopes), issuedAt + REFRESH_TTL_SECONDS, resource); })();
    return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refreshToken, scope: scopes.join(" ") };
  }
  private fields(client: OAuthClientInformationFull, params: AuthorizationParams): Record<string, string> { return { response_type: "code", client_id: client.client_id, redirect_uri: params.redirectUri, code_challenge: params.codeChallenge, code_challenge_method: "S256", scope: (params.scopes ?? SCOPES).join(" "), state: params.state ?? "", resource: params.resource?.href ?? "" }; }
  private authorizationPage(client: OAuthClientInformationFull, params: AuthorizationParams, fields: Record<string, string>): string {
    const hidden = Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("");
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接--串联授权</title><style>body{font-family:system-ui;margin:0;background:#111827;color:#e5e7eb}main{max-width:560px;margin:10vh auto;padding:32px;background:#1f2937;border-radius:16px}dl{background:#111827;padding:16px;border-radius:10px;word-break:break-word}dt{color:#9ca3af;font-size:12px}dd{margin:4px 0 16px}button{width:100%;padding:13px;border:0;border-radius:10px;background:#38bdf8;font-weight:700;font-size:16px}.muted{color:#cbd5e1}</style><main><h1>连接--串联</h1><p class="muted">确认后，ChatGPT 可用当前 Windows 用户权限操作此电脑。</p><dl><dt>客户端</dt><dd>${escapeHtml(client.client_name ?? client.client_id)}</dd><dt>资源</dt><dd>${escapeHtml(params.resource?.href ?? "")}</dd><dt>权限</dt><dd>${escapeHtml((params.scopes ?? SCOPES).join(" "))}</dd></dl><form method="post">${hidden}<button name="approve" value="yes">授权连接</button></form></main></html>`;
  }
  private redirect(res: Response, redirectUri: string, values: Record<string, string | undefined>): void { const target = new URL(redirectUri); for (const [key, value] of Object.entries(values)) if (value !== undefined) target.searchParams.set(key, value); target.searchParams.set("iss", this.issuer.href); res.redirect(302, target.href); }
}
