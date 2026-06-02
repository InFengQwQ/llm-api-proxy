<#
.SYNOPSIS
  Build & deploy the LLM API Proxy (Docker).
.PARAMETER NoBuild
  Skip image build, reuse existing image.
.PARAMETER NoDown
  Skip stopping existing container.
.PARAMETER NoHealth
  Skip startup health check.
#>
param(
  [switch] $NoBuild,
  [switch] $NoDown,
  [switch] $NoHealth
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ---- 1. Read port from config.yaml ----
$port = (Select-String 'port:\s*(\d+)' config.yaml).Matches.Groups[1].Value
if (-not $port) { throw 'port not found in config.yaml' }
$env:PORT = $port  # docker compose reads this directly

# ---- 2. Stop old container ----
if (-not $NoDown) {
  $ErrorActionPreference = 'Continue'
  docker compose down --remove-orphans 2>$null
  $ErrorActionPreference = 'Stop'
}

# ---- 3. Build (optional) and start ----
if (-not $NoBuild) {
  docker compose build --no-cache
  if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
}
docker compose up -d

# ---- 4. Health check (optional) ----
if (-not $NoHealth) {
  for ($i = 0; $i -lt 15; $i++) {
    try { Invoke-WebRequest "http://127.0.0.1:$port/health" -TimeoutSec 2 -UseBasicParsing | Out-Null; break } catch { Start-Sleep 2 }
  }
}

Write-Host "Ready. http://127.0.0.1:$port"
