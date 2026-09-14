import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import * as z from "zod/v4";
import { RelayOAuthProvider } from "./oauth.js";
import {
  httpRequest, checkPort, gpuStatus, memoryStatus, diskStatus, vlmAnalyze,
  comfyStatus, comfyStart, comfyUploadImage, comfyValidateWorkflow, comfyQueueWorkflow,
  comfyJobStatus, comfyHistory, comfyCancel, videoMetadata, extractVideoFrames,
} from "./helpers.js";

const execFileAsync = promisify(execFile);
const host = process.env.RELAY_HOST ?? "127.0.0.1";
const port = Number(process.env.RELAY_PORT ?? "8787");
const baseUrl = new URL(process.env.RELAY_PUBLIC_BASE_URL ?? "https://relay.ades.top");
const mcpUrl = new URL("/mcp", baseUrl);
const stateDir = process.env.RELAY_STATE_DIR ?? join(process.cwd(), "state");
const logDir = join(stateDir, "process-logs");
mkdirSync(logDir, { recursive: true });
const db = new Database(join(stateDir, "relay.sqlite"));
db.exec("create table if not exists processes (id text primary key, pid integer not null, command text not null, cwd text not null, log text not null, started integer not null, status text not null)");
const oauth = new RelayOAuthProvider(db, baseUrl, mcpUrl);
const resourceUrl = resourceUrlFromServerUrl(mcpUrl);
const transports = new Map<string, StreamableHTTPServerTransport>();
const live = new Map<string, ChildProcess>();
const absolute = (path: string) => resolve(path);
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const ensureParentDirectory = (path: string) => { const parent = dirname(path); if (!existsSync(parent)) mkdirSync(parent, { recursive: true }); };
type ProcessRecord = { id: string; pid: number; command: string; cwd: string; log: string; started: number; status: string };

function shell(command: string, cwd: string, shellType: "powershell" | "cmd" | "bash"): ChildProcess {
  const executable = shellType === "cmd" ? (process.env.ComSpec ?? "cmd.exe") : shellType === "bash" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "powershell.exe";
  const args = shellType === "cmd" ? ["/d", "/s", "/c", command] : shellType === "bash" ? ["-lc", command] : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command];
  return spawn(executable, args, { cwd: absolute(cwd), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}
async function run(command: string, cwd: string, shellType: "powershell" | "cmd" | "bash", timeoutMs: number) {
  const child = shell(command, cwd, shellType); let stdout = ""; let stderr = ""; let timedOut = false;
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => { child.once("error", reject); child.once("close", (exitCode, signal) => resolveResult({ exitCode, signal })); setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs).unref(); });
  return { ...result, stdout, stderr, timedOut };
}

function registerTools(server: McpServer): void {
  server.registerTool("list_directory", { description: "Use this when you need to list any absolute directory on this computer.", inputSchema: { path: z.string(), recursive: z.boolean().optional() }, annotations: { readOnlyHint: true } }, async ({ path, recursive }) => { const walk = (directory: string): unknown[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => { const fullPath = join(directory, entry.name); const item = { path: fullPath, type: entry.isDirectory() ? "directory" : "file" }; return recursive && entry.isDirectory() ? [item, ...walk(fullPath)] : [item]; }); return text(walk(absolute(path))); });
  server.registerTool("read_file", { description: "Use this when you need to read any absolute text or binary file.", inputSchema: { path: z.string(), encoding: z.enum(["utf8", "base64"]).optional() }, annotations: { readOnlyHint: true } }, async ({ path, encoding }) => text(readFileSync(absolute(path)).toString(encoding ?? "utf8")));
  server.registerTool("file_metadata", { description: "Use this when you need metadata for any absolute file or directory.", inputSchema: { path: z.string() }, annotations: { readOnlyHint: true } }, async ({ path }) => { const fullPath = absolute(path); const info = statSync(fullPath); return text({ path: fullPath, size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory(), mtime: info.mtime.toISOString() }); });
  server.registerTool("write_file", { description: "Use this when you need to write or append arbitrary content to any absolute file.", inputSchema: { path: z.string(), content: z.string(), append: z.boolean().optional(), encoding: z.enum(["utf8", "base64"]).optional() }, annotations: { destructiveHint: false, openWorldHint: false } }, async ({ path, content, append, encoding }) => { const fullPath = absolute(path); ensureParentDirectory(fullPath); const data = Buffer.from(content, encoding === "base64" ? "base64" : "utf8"); append ? appendFileSync(fullPath, data) : writeFileSync(fullPath, data); return text({ path: fullPath, written: data.length }); });
  server.registerTool("file_operation", { description: "Use this when you need to copy, move, rename, delete, or create directories at any absolute path.", inputSchema: { operation: z.enum(["move", "copy", "rename", "delete", "mkdir"]), source: z.string(), destination: z.string().optional() }, annotations: { destructiveHint: true } }, async ({ operation, source, destination }) => { const sourcePath = absolute(source); if (operation === "delete") { rmSync(sourcePath, { recursive: true, force: true }); return text({ operation, source: sourcePath }); } if (operation === "mkdir") { mkdirSync(sourcePath, { recursive: true }); return text({ operation, path: sourcePath }); } if (!destination) throw new Error("destination is required for " + operation); const target = absolute(destination); ensureParentDirectory(target); operation === "move" || operation === "rename" ? renameSync(sourcePath, target) : cpSync(sourcePath, target, { recursive: true, force: true }); return text({ operation, source: sourcePath, destination: target }); });
  server.registerTool("search_files", { description: "Use this when you need full-text search below any absolute path.", inputSchema: { query: z.string(), path: z.string() }, annotations: { readOnlyHint: true } }, async ({ query, path }) => { try { const { stdout, stderr } = await execFileAsync("rg", ["--line-number", "--hidden", "--glob", "!node_modules", query, absolute(path)], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 }); return text(stdout || stderr); } catch (error: unknown) { const result = error as { stdout?: string; stderr?: string }; return text(result.stdout || result.stderr || ""); } });
  server.registerTool("run_command", { description: "Use this when you need unrestricted PowerShell, cmd, or Git Bash commands in any absolute working directory; background starts a persistent process.", inputSchema: { command: z.string(), cwd: z.string().default("C:\\"), shell: z.enum(["powershell", "cmd", "bash"]).default("powershell"), background: z.boolean().default(false), timeout_ms: z.number().int().positive().default(120000) }, annotations: { destructiveHint: true, openWorldHint: true } }, async ({ command, cwd, shell: shellType, background, timeout_ms }) => { if (!background) { const r = await run(command, cwd, shellType, timeout_ms); return text({ exit_code: r.exitCode, stdout: r.stdout, stderr: r.stderr, pid: null, timed_out: r.timedOut ?? false }); } const id = randomUUID(); const log = join(logDir, `${id}.log`); const child = shell(command, cwd, shellType); const output = (data: Buffer) => appendFileSync(log, data); child.stdout?.on("data", output); child.stderr?.on("data", output); live.set(id, child); const record: ProcessRecord = { id, pid: child.pid ?? -1, command, cwd: absolute(cwd), log, started: Date.now(), status: "running" }; db.prepare("insert into processes values (@id,@pid,@command,@cwd,@log,@started,@status)").run(record); child.on("close", () => { live.delete(id); db.prepare("update processes set status = 'exited' where id = ?").run(id); }); return text({ ...record, exit_code: null, stdout: "", stderr: "", timed_out: false }); });
  server.registerTool("list_processes", { description: "Use this when you need to list background commands started by this MCP server.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => text(db.prepare("select * from processes order by started desc").all()));
  server.registerTool("process_output", { description: "Use this when you need logs from a managed background process.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } }, async ({ id }) => { const row = db.prepare("select * from processes where id = ?").get(id) as ProcessRecord | undefined; if (!row) throw new Error("Unknown process"); return text(existsSync(row.log) ? readFileSync(row.log, "utf8") : ""); });
  server.registerTool("process_input", { description: "Use this when you need to send stdin to a managed background process.", inputSchema: { id: z.string(), input: z.string() }, annotations: { destructiveHint: true } }, async ({ id, input }) => { const child = live.get(id); if (!child?.stdin) throw new Error("Process is not running in this service instance"); child.stdin.write(input); return text({ id, sent: input.length }); });
  server.registerTool("stop_process", { description: "Use this when you need to terminate a managed background process.", inputSchema: { id: z.string() }, annotations: { destructiveHint: true } }, async ({ id }) => { const child = live.get(id); if (child) child.kill(); else { const row = db.prepare("select pid from processes where id = ?").get(id) as { pid: number } | undefined; if (row) process.kill(row.pid); } db.prepare("update processes set status = 'stopped' where id = ?").run(id); return text({ id, stopped: true }); });
  server.registerTool("download_url", { description: "Use this when you need to download any URL to an absolute path on this computer.", inputSchema: { url: z.string().url(), destination: z.string() }, annotations: { destructiveHint: true, openWorldHint: true } }, async ({ url, destination }) => { const response = await fetch(url); if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`); const target = absolute(destination); ensureParentDirectory(target); const bytes = Buffer.from(await response.arrayBuffer()); writeFileSync(target, bytes); return text({ url, destination: target, bytes: bytes.length }); });
  server.registerTool("system_info", { description: "Use this when you need non-secret environment, disk, or process information from this Windows computer.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
    const safeEnv = ["RELAY_PUBLIC_BASE_URL", "RELAY_HOST", "RELAY_PORT", "VLM_MODEL", "COMFYUI_BASE_URL", "COMFYUI_OUTPUT_DIR", "FFMPEG_BIN"];
    const env = Object.fromEntries(safeEnv.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
    return text({ platform: process.platform, arch: process.arch, cwd: process.cwd(), pid: process.pid, env, DASHSCOPE_API_KEY_CONFIGURED: Boolean(process.env.DASHSCOPE_API_KEY) });
  });

  // ---------- P0-A 文件补齐 ----------
  server.registerTool("exists", { description: "Check whether a file or directory exists at an absolute path.", inputSchema: { path: z.string() }, annotations: { readOnlyHint: true } }, async ({ path }) => text({ path: absolute(path), exists: existsSync(absolute(path)) }));

  // ---------- P0-C 系统 ----------
  server.registerTool("gpu_status", { description: "Use this when you need NVIDIA GPU utilization, VRAM, and temperature.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => text(await gpuStatus()));
  server.registerTool("memory_status", { description: "Use this when you need RAM usage.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => text(memoryStatus()));
  server.registerTool("disk_status", { description: "Use this when you need free/used disk space for a path or drive.", inputSchema: { path: z.string().optional() }, annotations: { readOnlyHint: true } }, async ({ path }) => text(await diskStatus(path)));
  server.registerTool("check_port", { description: "Check whether a TCP port is open/accepting connections on a host.", inputSchema: { host: z.string().default("127.0.0.1"), port: z.number().int().positive() }, annotations: { readOnlyHint: true } }, async ({ host, port }) => text({ host, port, open: await checkPort(host, port) }));

  // ---------- P0-D 网络 ----------
  server.registerTool("http_request", { description: "Make an arbitrary HTTP request (GET/POST/PUT/DELETE/HEAD) and return status + response body.", inputSchema: { method: z.enum(["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"]).default("GET"), url: z.string(), headers: z.record(z.string(), z.string()).optional(), body: z.unknown().optional(), timeout_ms: z.number().int().positive().optional() }, annotations: { openWorldHint: true } }, async ({ method, url, headers, body, timeout_ms }) => { const r = await httpRequest({ method, url, headers, body, timeoutMs: timeout_ms }); return text({ status: r.status, ok: r.ok, body: r.body.slice(0, 50000), truncated: r.body.length > 50000 }); });

  // ---------- P0-E ComfyUI ----------
  server.registerTool("comfyui_status", { description: "Check whether ComfyUI is running and its system stats.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => text(await comfyStatus()));
  server.registerTool("comfyui_start", { description: "Start ComfyUI (default: E:/OpenSource Models/scripts/start-comfyui.ps1) and wait for it to be ready on port 8188.", inputSchema: { script: z.string().optional(), port: z.number().int().optional(), timeout_ms: z.number().int().positive().optional() }, annotations: { destructiveHint: true } }, async ({ script, port, timeout_ms }) => text(await comfyStart({ script, port, timeoutMs: timeout_ms })));
  server.registerTool("comfyui_upload_image", { description: "Upload an image file into ComfyUI input so it can be referenced in a workflow.", inputSchema: { path: z.string() }, annotations: { destructiveHint: false, openWorldHint: false } }, async ({ path }) => text(await comfyUploadImage(path)));
  server.registerTool("comfyui_validate_workflow", { description: "Validate that a workflow is in ComfyUI API prompt format (not UI format).", inputSchema: { workflow_path: z.string().optional(), workflow_json: z.unknown().optional() }, annotations: { readOnlyHint: true } }, async ({ workflow_path, workflow_json }) => text(comfyValidateWorkflow(workflow_path, workflow_json)));
  server.registerTool("comfyui_queue_workflow", { description: "Queue a workflow (API prompt format) to ComfyUI. Returns prompt_id.", inputSchema: { workflow_path: z.string().optional(), workflow_json: z.unknown().optional(), overrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }, annotations: { destructiveHint: false, openWorldHint: false } }, async ({ workflow_path, workflow_json, overrides }) => text(await comfyQueueWorkflow({ workflowPath: workflow_path, workflowJson: workflow_json, overrides })));
  server.registerTool("comfyui_job_status", { description: "Get job status for a prompt_id (queued/in_progress/completed/failed).", inputSchema: { prompt_id: z.string() }, annotations: { readOnlyHint: true } }, async ({ prompt_id }) => text(await comfyJobStatus(prompt_id)));
  server.registerTool("comfyui_history", { description: "Get build history/output file paths for a prompt_id.", inputSchema: { prompt_id: z.string() }, annotations: { readOnlyHint: true } }, async ({ prompt_id }) => text(await comfyHistory(prompt_id)));
  server.registerTool("comfyui_cancel", { description: "Cancel a queued/running ComfyUI job (or interrupt current).", inputSchema: { prompt_id: z.string() }, annotations: { destructiveHint: true } }, async ({ prompt_id }) => text(await comfyCancel(prompt_id)));

  // ---------- P0-F 视觉验收 (qwen3.8-flash) ----------
  server.registerTool("vlm_analyze", { description: "Analyze one or more images with Qwen (qwen3.8-flash) for visual QA — identity/outfit/artifact checking. Reads local files automatically (no base64 needed).", inputSchema: { paths: z.array(z.string()).min(1), instruction: z.string(), schema: z.record(z.string(), z.unknown()).optional(), labels: z.array(z.string()).optional() }, annotations: { readOnlyHint: true } }, async ({ paths, instruction, schema, labels }) => {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) return text({ error: "DASHSCOPE_API_KEY not configured on the relay" });
    const r = await vlmAnalyze({ paths, instruction, schema, labels, apiKey, baseUrl: process.env.DASHSCOPE_BASE_URL, model: process.env.VLM_MODEL || "qwen3.8-flash" });
    return text(r);
  });

  // ---------- P0-G 视频 ----------
  server.registerTool("video_metadata", { description: "Get duration/fps/resolution/codecs of a video file.", inputSchema: { path: z.string() }, annotations: { readOnlyHint: true } }, async ({ path }) => text(await videoMetadata(path)));
  server.registerTool("extract_video_frames", { description: "Extract frames from a video at timestamps or a sample count, for QA.", inputSchema: { path: z.string(), timestamps: z.array(z.number()).optional(), sample_count: z.number().int().positive().optional(), out_dir: z.string().optional() }, annotations: { destructiveHint: false, openWorldHint: false } }, async ({ path, timestamps, sample_count, out_dir }) => text(await extractVideoFrames(path, timestamps, sample_count, out_dir)));
}
function createMcp(): McpServer { const server = new McpServer({ name: "连接--串联", version: "1.0.0" }, { instructions: "This server operates the connected Windows computer with the current user's full permissions. All paths may be absolute on any drive." }); registerTools(server); return server; }

const app = express(); app.disable("x-powered-by"); app.set("trust proxy", 1); app.use(express.json({ limit: "50mb" })); app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => { const started = Date.now(); res.on("finish", () => console.log(JSON.stringify({ event: "http", method: req.method, path: req.originalUrl.split("?")[0], status: res.statusCode, duration_ms: Date.now() - started }))); next(); });
app.get("/healthz", (_req, res) => res.json({ ok: true, name: "连接--串联" }));
const metadata = { issuer: baseUrl.href, authorization_endpoint: new URL("/authorize", baseUrl).href, token_endpoint: new URL("/token", baseUrl).href, registration_endpoint: new URL("/register", baseUrl).href, revocation_endpoint: new URL("/revoke", baseUrl).href, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "none"], scopes_supported: ["relay", "offline_access"], authorization_response_iss_parameter_supported: true };
app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(metadata)); app.get("/.well-known/openid-configuration", (_req, res) => res.json({ ...metadata, subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["none"], jwks_uri: new URL("/jwks", baseUrl).href })); app.get("/jwks", (_req, res) => res.json({ keys: [] }));
app.use("/authorize", (_req: Request, res: Response, next: NextFunction) => { const redirect = res.redirect.bind(res); res.redirect = ((statusOrUrl: number | string, url?: string) => { const status = typeof statusOrUrl === "number" ? statusOrUrl : 302; const location = typeof statusOrUrl === "string" ? statusOrUrl : url!; try { const target = new URL(location); target.searchParams.set("iss", baseUrl.href); return redirect(status, target.href); } catch { return redirect(status, location); } }) as typeof res.redirect; next(); });
app.use(mcpAuthRouter({ provider: oauth, issuerUrl: baseUrl, baseUrl, resourceServerUrl: resourceUrl, scopesSupported: ["relay", "offline_access"], resourceName: "连接--串联" }));
const bearer = requireBearerAuth({ verifier: oauth, requiredScopes: ["relay"], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl) });
app.all("/mcp", bearer, async (req, res) => { if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceUrl })) return res.status(401).json({ error: "invalid_token" }); const sessionId = req.header("mcp-session-id"); let transport = sessionId ? transports.get(sessionId) : undefined; if (!transport && req.method === "POST" && isInitializeRequest(req.body)) { transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { transports.set(id, transport!); } }); transport.onclose = () => { if (transport?.sessionId) transports.delete(transport.sessionId); }; await createMcp().connect(transport); } if (!transport) return res.status(400).json({ error: "invalid_session" }); await transport.handleRequest(req, res, req.body); });
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { console.error(JSON.stringify({ event: "server_error", message: error instanceof Error ? error.message : String(error) })); if (!res.headersSent) res.status(500).json({ error: "internal_error" }); });
app.listen(port, host, () => console.log(`连接--串联 listening on ${host}:${port}; public ${baseUrl.href}`));
