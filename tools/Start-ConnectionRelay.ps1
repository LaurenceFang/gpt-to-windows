$ErrorActionPreference = "Continue"
$node = "D:\node.exe"
$project = Split-Path $PSScriptRoot -Parent
$server = Join-Path $project "dist\server.js"
$log = Join-Path $project "logs\supervisor.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
$env:RELAY_PUBLIC_BASE_URL = "https://relay.ades.top"
# --- P0 扩展配置 ---
# Keep the local API key outside Git. Set DASHSCOPE_API_KEY in the environment
# or place DASHSCOPE_API_KEY=... in the ignored .env.local file.
$envFile = Join-Path $project ".env.local"
if (-not $env:DASHSCOPE_API_KEY -and (Test-Path -LiteralPath $envFile)) {
  $keyLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*DASHSCOPE_API_KEY\s*=' } | Select-Object -First 1
  if ($keyLine) { $env:DASHSCOPE_API_KEY = (($keyLine -split '=', 2)[1]).Trim().Trim('"').Trim("'") }
}
$env:DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:VLM_MODEL = "qwen3.8-flash"
$env:COMFYUI_BASE_URL = "http://127.0.0.1:8188"
$env:COMFYUI_OUTPUT_DIR = "E:\OpenSource Models\outputs"
$env:COMFYUI_START_SCRIPT = "E:\OpenSource Models\scripts\start-comfyui.ps1"
$env:FFMPEG_BIN = "C:\Users\Laurence\AppData\Roaming\bilibili\ffmpeg\ffmpeg.exe"
Set-Location $project
while ($true) { & $node $server *>> $log; Start-Sleep -Seconds 5 }
