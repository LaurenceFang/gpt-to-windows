import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { basename, extname, join, dirname, resolve } from "node:path";
import { createConnection } from "node:net";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);

// ---------- 通用 ----------
export type ToolResult = { content: { type: "text"; text: string }[] };

export function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export function sanitize(value: unknown): unknown {
  // 递归替换疑似密钥字段，避免 key 泄漏进日志/响应
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/key|token|secret|password|authorization|bearer/i.test(k)) out[k] = "***";
      else out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

// ---------- HTTP ----------
export async function httpRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  formData?: FormData;
}): Promise<{ status: number; ok: boolean; headers: Record<string, string>; body: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60000);
  try {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: BodyInit | undefined;
    if (opts.formData) {
      body = opts.formData; // fetch 自动带 multipart boundary
    } else if (opts.body !== undefined) {
      if (typeof opts.body === "string") {
        body = opts.body;
        headers["content-type"] ??= "text/plain";
      } else {
        body = JSON.stringify(opts.body);
        headers["content-type"] ??= "application/json";
      }
    }
    const res = await fetch(opts.url, { method: opts.method, headers, body, signal: ctl.signal, redirect: "follow" });
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });
    const resBody = await res.text();
    return { status: res.status, ok: res.ok, headers: resHeaders, body: resBody };
  } finally {
    clearTimeout(t);
  }
}

// ---------- 端口 ----------
export function checkPort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const sock = createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; sock.destroy(); resolvePromise(ok); } };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

// ---------- 硬件 ----------
export async function gpuStatus(): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu",
      "--format=csv,noheader,nounits",
    ], { windowsHide: true, timeout: 15000 });
    const line = stdout.trim().split(/\r?\n/)[0];
    if (!line) return { error: "no gpu line" };
    const [name, memTotal, memUsed, util, temp] = line.split(",").map((s) => s.trim());
    return { name, vram_total_mib: Number(memTotal), vram_used_mib: Number(memUsed), vram_free_mib: Number(memTotal) - Number(memUsed), utilization_pct: Number(util), temperature_c: Number(temp) };
  } catch (e) {
    return { error: `nvidia-smi failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function memoryStatus(): unknown {
  return { total_bytes: os.totalmem(), free_bytes: os.freemem(), used_bytes: os.totalmem() - os.freemem() };
}

export async function diskStatus(path?: string): Promise<unknown> {
  const target = resolve(path ?? process.cwd());
  const drive = /^[a-zA-Z]/.test(target) ? target.slice(0, 2) : "C:";
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Get-PSDrive -Name ${drive.slice(0, 1)} | Select-Object Used,Free | ConvertTo-Json -Compress`],
      { windowsHide: true, timeout: 15000 }
    );
    const j = JSON.parse(stdout.trim());
    const used = Number(j?.Used ?? 0), free = Number(j?.Free ?? 0);
    return { path: target, drive, free_bytes: free, used_bytes: used, total_bytes: used + free };
  } catch (e) {
    return { error: `disk query failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------- 图片 -> Data URL ----------
const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif",
};
export function fileToDataUrl(path: string): { dataUrl: string; mime: string; bytes: number } | { error: string } {
  const abs = resolve(path);
  if (!existsSync(abs)) return { error: `file not found: ${path}` };
  const mime = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  const buf = readFileSync(abs);
  return { dataUrl: `data:${mime};base64,${buf.toString("base64")}`, mime, bytes: buf.length };
}

// 缩图（尽力而为，失败则原图）
export function downscaleImageIfNeeded(path: string, maxSide = 2048): string {
  try {
    const abs = resolve(path);
    const meta = statSync(abs);
    if (meta.size < 200 * 1024) return abs; // 小图不折腾
    const bin = ffmpegBin();
    if (!bin) return abs;
    const isVideo = /\.(mp4|mov|webm|mkv)$/i.test(abs);
    const out = join(dirname(abs), `.qa_${basename(abs, extname(abs))}.jpg`);
    const args = ["-y", "-i", abs];
    if (!isVideo) {
      args.push("-vf", `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`, "-q:v", "3");
    } else {
      args.push("-vf", `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`);
    }
    args.push(out);
    return execFileSyncSafe(bin, args) ? out : abs;
  } catch {
    return path;
  }
}

function execFileSyncSafe(cmd: string, args: string[]): boolean {
  try {
    const r = spawnSync(cmd, args, { timeout: 30000, windowsHide: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ---------- DashScope (qwen3.8-flash) ----------
export async function vlmAnalyze(opts: {
  paths: string[];
  instruction: string;
  schema?: Record<string, unknown>;
  labels?: string[];
  apiKey: string;
  baseUrl?: string;
  model?: string;
}): Promise<unknown> {
  const base = (opts.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const model = opts.model ?? "qwen3.8-flash";
  const content: unknown[] = [];
  opts.paths.forEach((p, i) => {
    const label = opts.labels?.[i] ? `(${opts.labels[i]}) ` : "";
    const converted = fileToDataUrl(p);
    if ("error" in converted) throw new Error(`${label}${converted.error}`);
    const down = downscaleImageIfNeeded(p);
    const final = down === resolve(p) ? converted : fileToDataUrl(down);
    if ("error" in final) throw new Error(`${label}${final.error}`);
    content.push({ type: "image_url", image_url: { url: final.dataUrl } });
  });
  content.push({ type: "text", text: opts.instruction });

  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content }],
    temperature: 0.1,
  };
  if (opts.schema) payload.response_format = { type: "json_object" };
  // qwen3.x 关闭思考
  payload.chat_template_kwargs = { enable_thinking: false };

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await httpRequest({
      method: "POST",
      url: `${base}/chat/completions`,
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: payload,
      timeoutMs: 120000,
    });
    let parsed: unknown;
    try { parsed = JSON.parse(res.body); } catch { lastErr = `bad json from api: ${res.body.slice(0, 300)}`; continue; }
    const msg = (parsed as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content;
    if (!msg) { lastErr = `no content: ${res.status} ${res.body.slice(0, 300)}`; continue; }
    if (!opts.schema) return { raw: msg };
    try {
      const obj = JSON.parse(extractJson(msg));
      const check = validateSchema(obj, opts.schema);
      if (check.ok) return obj;
      lastErr = `schema validation failed: ${check.errors.join("; ")}`;
    } catch (e) {
      lastErr = `schema parse failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { error: "vlm_analyze failed after retries", detail: String(lastErr) };
}

function extractJson(s: string): string {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}

function validateSchema(obj: unknown, schema: Record<string, unknown>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const req = (schema.required as string[]) ?? [];
  if (req.length && (!obj || typeof obj !== "object")) { errors.push("response is not object"); return { ok: false, errors }; }
  for (const k of req) if (!(k in (obj as Record<string, unknown>))) errors.push(`missing required: ${k}`);
  return { ok: errors.length === 0, errors };
}

// ---------- ComfyUI 客户端 ----------
const COMFY_BASE = process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188";

export async function comfyStatus(): Promise<unknown> {
  try {
    const r = await httpRequest({ method: "GET", url: `${COMFY_BASE}/system_stats`, timeoutMs: 5000 });
    if (r.ok) return { running: true, system_stats: safeJson(r.body) };
    return { running: false, http_status: r.status, detail: r.body.slice(0, 300) };
  } catch (e) {
    return { running: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function comfyStart(opts: { script?: string; port?: number; timeoutMs?: number }): Promise<unknown> {
  const port = opts.port ?? 8188;
  const base = COMFY_BASE;
  const up = await checkPort("127.0.0.1", port, 2000);
  if (up) return { already_running: true };
  const script = opts.script ?? process.env.COMFYUI_START_SCRIPT ?? "E:\\OpenSource Models\\scripts\\start-comfyui.ps1";
  if (!existsSync(script)) return { error: `startup script not found: ${script}` };
  // 以后台方式启动脚本
  spawnBackground(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]);
  const deadline = Date.now() + (opts.timeoutMs ?? 120000);
  while (Date.now() < deadline) {
    if (await checkPort("127.0.0.1", port, 2000)) {
      try {
        const r = await httpRequest({ method: "GET", url: `${base}/system_stats`, timeoutMs: 4000 });
        if (r.ok) return { started: true, port, system_stats: safeJson(r.body) };
      } catch { /* not ready yet */ }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { error: "comfyui start timeout", port };
}

function spawnBackground(cmdArgs: string[]): void {
  const child = spawn(cmdArgs[0], cmdArgs.slice(1), { windowsHide: true, stdio: "ignore", detached: false });
  child.unref?.();
}

export async function comfyUploadImage(path: string): Promise<unknown> {
  const abs = resolve(path);
  if (!existsSync(abs)) return { error: `file not found: ${path}` };
  const buf = readFileSync(abs);
  const mime = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  const fd = new FormData();
  fd.append("image", new Blob([buf], { type: mime }), basename(abs));
  const r = await httpRequest({ method: "POST", url: `${COMFY_BASE}/upload/image`, formData: fd, timeoutMs: 60000 });
  if (!r.ok) return { error: `upload failed: ${r.status} ${r.body.slice(0, 300)}` };
  return safeJson(r.body);
}

function isApiWorkflow(w: unknown): boolean {
  if (!w || typeof w !== "object" || Array.isArray(w)) return false;
  const o = w as Record<string, unknown>;
  if (Array.isArray(o.nodes)) return false; // UI 格式特征
  const keys = Object.keys(o);
  if (keys.length === 0) return false;
  return keys.every((k) => o[k] && typeof o[k] === "object" && typeof (o[k] as Record<string, unknown>).class_type === "string");
}

function isUiWorkflow(w: unknown): boolean {
  if (!w || typeof w !== "object") return false;
  const o = w as Record<string, unknown>;
  return Array.isArray(o.nodes);
}

export function comfyValidateWorkflow(workflowPath?: string, workflowJson?: unknown): unknown {
  let w: unknown = workflowJson;
  if (workflowPath) {
    const p = resolve(workflowPath);
    if (!existsSync(p)) return { valid: false, error: `file not found: ${workflowPath}` };
    try { w = JSON.parse(readFileSync(p, "utf8")); } catch (e) { return { valid: false, error: `workflow file is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  if (!w || typeof w !== "object") return { valid: false, error: "workflow is not an object" };
  if (isUiWorkflow(w)) return { valid: false, format: "ui", error: "Detected UI-format workflow. POST /prompt requires API format. Use the UI's \"Export (API)\" or start from an official api_*.json template." };
  if (isApiWorkflow(w)) return { valid: true, format: "api", missing_nodes: [], errors: [] };
  return { valid: false, format: "unknown", error: "unrecognized workflow structure (API format requires a top-level map of { node_id: { class_type, inputs } })" };
}

export async function comfyQueueWorkflow(opts: { workflowPath?: string; workflowJson?: unknown; overrides?: Record<string, Record<string, unknown>> }): Promise<unknown> {
  const v = comfyValidateWorkflow(opts.workflowPath, opts.workflowJson) as { valid: boolean };
  if (!v.valid) return v;
  let w = opts.workflowJson ? JSON.parse(JSON.stringify(opts.workflowJson)) : JSON.parse(readFileSync(resolve(opts.workflowPath!), "utf8")) as Record<string, Record<string, unknown>>;
  if (opts.overrides) {
    for (const [nodeId, fields] of Object.entries(opts.overrides)) {
      if (w[nodeId]) {
        w[nodeId].inputs = { ...(w[nodeId].inputs as Record<string, unknown>), ...fields };
      }
    }
  }
  const r = await httpRequest({ method: "POST", url: `${COMFY_BASE}/prompt`, body: { prompt: w, client_id: "relay" }, timeoutMs: 30000 });
  if (!r.ok) return { error: `queue failed: ${r.status} ${r.body.slice(0, 500)}` };
  const j = safeJson(r.body) as Record<string, unknown>;
  return { prompt_id: j.prompt_id, ...(j as object) };
}

export async function comfyJobStatus(promptId: string): Promise<unknown> {
  // 优先新 API
  try {
    const r = await httpRequest({ method: "GET", url: `${COMFY_BASE}/api/jobs/${encodeURIComponent(promptId)}`, timeoutMs: 8000 });
    if (r.ok) {
      const j = safeJson(r.body) as Record<string, unknown>;
      return { prompt_id: promptId, state: j.status ?? j.state ?? "unknown", queue_position: null, progress: null, error: null, raw: j };
    }
  } catch { /* fallback */ }
  // fallback: /queue + /history
  try {
    const [q, h] = await Promise.all([
      httpRequest({ method: "GET", url: `${COMFY_BASE}/queue`, timeoutMs: 8000 }),
      httpRequest({ method: "GET", url: `${COMFY_BASE}/history/${encodeURIComponent(promptId)}`, timeoutMs: 8000 }),
    ]);
    const qj = safeJson(q.body) as Record<string, unknown>;
    const running = (qj.running as { prompt_id?: string }[] ?? []).find((x) => x.prompt_id === promptId);
    const pending = (qj.queue_pending as { prompt_id?: string }[] ?? []).find((x) => x.prompt_id === promptId);
    let state = "unknown";
    if (h.ok && h.body !== "{}" && h.body.trim() !== "") state = "completed";
    else if (running) state = "in_progress";
    else if (pending) state = "queued";
    const position = pending ? (qj.queue_pending as { prompt_id?: string }[]).findIndex((x) => x.prompt_id === promptId) + 1 : null;
    return { prompt_id: promptId, state, queue_position: position, progress: null, error: null };
  } catch (e) {
    return { prompt_id: promptId, state: "error", queue_position: null, progress: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function comfyHistory(promptId: string): Promise<unknown> {
  const r = await httpRequest({ method: "GET", url: `${COMFY_BASE}/history/${encodeURIComponent(promptId)}`, timeoutMs: 10000 });
  if (!r.ok) return { error: `history failed: ${r.status} ${r.body.slice(0, 300)}` };
  const j = safeJson(r.body) as Record<string, unknown>;
  const rec = (j[promptId] ?? {}) as Record<string, unknown>;
  const outputsRaw = (rec.outputs ?? {}) as Record<string, { images?: { filename?: string; subfolder?: string; type?: string }[]; gifs?: { filename?: string; subfolder?: string; type?: string }[] }>;
  const outputs: unknown[] = [];
  const outDir = process.env.COMFYUI_OUTPUT_DIR ?? "E:\\OpenSource Models\\outputs";
  for (const [nodeId, o] of Object.entries(outputsRaw)) {
    for (const img of o.images ?? []) {
      const folder = img.subfolder ? join(img.subfolder, img.filename ?? "") : img.filename ?? "";
      outputs.push({ node_id: nodeId, type: "image", filename: img.filename, subfolder: img.subfolder, absolute_path: join(outDir, folder) });
    }
    for (const g of o.gifs ?? []) {
      const folder = g.subfolder ? join(g.subfolder, g.filename ?? "") : g.filename ?? "";
      outputs.push({ node_id: nodeId, type: "gif", filename: g.filename, subfolder: g.subfolder, absolute_path: join(outDir, folder) });
    }
  }
  const status = (rec.status ?? {}) as Record<string, unknown>;
  return { prompt_id: promptId, status: status.status_str ?? (outputs.length ? "completed" : rec.status ? "completed" : "unknown"), outputs };
}

export async function comfyCancel(promptId: string): Promise<unknown> {
  try {
    const r = await httpRequest({ method: "POST", url: `${COMFY_BASE}/api/jobs/${encodeURIComponent(promptId)}/cancel`, timeoutMs: 8000 });
    if (r.ok) return { cancelled: true, method: "jobs-api" };
  } catch { /* fallback */ }
  const q = await httpRequest({ method: "GET", url: `${COMFY_BASE}/queue`, timeoutMs: 8000 });
  const qj = safeJson(q.body) as Record<string, unknown>;
  const pending = (qj.queue_pending as { prompt_id?: string }[] ?? []);
  const idx = pending.findIndex((x) => x.prompt_id === promptId);
  if (idx >= 0) {
    await httpRequest({ method: "POST", url: `${COMFY_BASE}/queue`, body: { delete: [idx] }, timeoutMs: 8000 });
    return { cancelled: true, method: "queue-delete" };
  }
  await httpRequest({ method: "POST", url: `${COMFY_BASE}/interrupt`, timeoutMs: 8000 });
  return { cancelled: true, method: "interrupt" };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return { _raw: s.slice(0, 500) }; }
}

// ---------- 媒体 (ffmpeg 探测) ----------
function resolveFfmpeg(): string | null {
  const envBin = process.env.FFMPEG_BIN;
  if (envBin && existsSync(envBin)) return envBin;
  const candidates = [
    "C:\\Users\\Laurence\\AppData\\Roaming\\bilibili\\ffmpeg\\ffmpeg.exe",
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "D:\\ffmpeg\\bin\\ffmpeg.exe",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function ffmpegBin(): string | null {
  const fixed = resolveFfmpeg();
  if (fixed) return fixed;
  return execFileSafeWhich("ffmpeg");
}

function execFileSafeWhich(cmd: string): string | null {
  try {
    const r = spawnSync("where", [cmd], { timeout: 5000, windowsHide: true });
    if (r.status === 0 && r.stdout) return r.stdout.toString().trim().split(/\r?\n/)[0];
  } catch { /* ignore */ }
  return null;
}

export async function videoMetadata(path: string): Promise<unknown> {
  const abs = resolve(path);
  if (!existsSync(abs)) return { error: `file not found: ${path}` };
  const bin = ffmpegBin();
  if (!bin) return { error: "ffmpeg not found; set FFMPEG_BIN env var" };
  try {
    // ffprobe 优先
    const probe = bin.replace(/ffmpeg\.exe$/i, "ffprobe.exe");
    if (existsSync(probe)) {
      const { stdout } = await execFileAsync(probe, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", abs], { windowsHide: true, timeout: 20000 });
      const j = JSON.parse(stdout) as Record<string, unknown>;
      const stream = (j.streams as Record<string, unknown>[] ?? []).find((s) => s.codec_type === "video");
      const audio = (j.streams as Record<string, unknown>[] ?? []).find((s) => s.codec_type === "audio");
      return {
        duration: Number((stream as Record<string, unknown>)?.duration ?? (j.format as Record<string, unknown>)?.duration ?? null),
        width: Number((stream as Record<string, unknown>)?.width ?? null),
        height: Number((stream as Record<string, unknown>)?.height ?? null),
        fps: parseFps((stream as Record<string, unknown>)?.avg_frame_rate as string | undefined),
        video_codec: (stream as Record<string, unknown>)?.codec_name ?? null,
        audio_codec: audio ? (audio as Record<string, unknown>).codec_name : null,
        size_bytes: Number((j.format as Record<string, unknown>)?.size ?? null),
      };
    }
    // 兜底：ffmpeg -i 解析 stderr
    const { stderr } = await execFileAsync(bin, ["-i", abs], { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
    const duration = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
    const video = /Video:\s*([^,]+),\s*([^,]*),?\s*(\d+)x(\d+)/.exec(stderr);
    return {
      duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
      width: video ? Number(video[3]) : null,
      height: video ? Number(video[4]) : null,
      fps: null,
      video_codec: video ? video[1].trim() : null,
      audio_codec: /Audio:\s*([^,]+)/.exec(stderr)?.[1]?.trim() ?? null,
      size_bytes: statSync(abs).size,
    };
  } catch (e) {
    return { error: `video metadata failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function parseFps(rate?: string): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  return n && d ? Math.round((n / d) * 100) / 100 : null;
}

export async function extractVideoFrames(path: string, timestamps?: number[], sampleCount?: number, outDir?: string): Promise<unknown> {
  const abs = resolve(path);
  if (!existsSync(abs)) return { error: `file not found: ${path}` };
  const bin = ffmpegBin();
  if (!bin) return { error: "ffmpeg not found; set FFMPEG_BIN env var" };
  const stamps = timestamps?.length ? timestamps : undefined;
  let times: number[] = stamps ?? [];
  if (!times.length && sampleCount) {
    const meta = await videoMetadata(abs) as { duration?: number };
    if (meta && "error" in meta) return meta;
    const dur = (meta as { duration?: number }).duration as number;
    if (!dur || !isFinite(dur)) return { error: "cannot determine duration" };
    for (let i = 0; i < sampleCount; i++) times.push(Math.round((dur * i) / (sampleCount - 1 || 1) * 100) / 100);
  }
  const dir = outDir ? resolve(outDir) : join(dirname(abs), "qa_frames");
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const out = join(dir, `frame_${String(i).padStart(3, "0")}_t${String(times[i]).replace(".", "_")}.jpg`);
    try {
      await execFileAsync(bin, ["-y", "-ss", String(times[i]), "-i", abs, "-frames:v", "1", "-q:v", "3", out], { windowsHide: true, timeout: 30000 });
      files.push(out);
    } catch (e) {
      return { error: `frame ${i} failed: ${e instanceof Error ? e.message : String(e)}`, extracted: files };
    }
  }
  return { frames: files, count: files.length, directory: dir };
}
