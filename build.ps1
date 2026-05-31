<#.SYNOPSIS
  Build & deploy the LLM API Proxy via Docker Compose.
.DESCRIPTION
  1. Parse port from config.yaml (server section only).
  2. Kill any process occupying the target port.
  3. Rebuild the image and start the container.
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ----- Parse port from config.yaml (only under "server:" section) -----
$config = Get-Content "$PSScriptRoot\config.yaml" -Raw

# (?s) = single-line: . matches \n; .*? = non-greedy between server: and port:
if ($config -notmatch '(?s)server:.*?port:\s*(\d+)') {
  throw 'Cannot parse server.port from config.yaml'
}
$port = $matches[1]
Write-Host "Target port: $port"

# ----- Kill any process occupying the target port -----
$pidOnPort = (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue).OwningProcess |
  Select-Object -Unique

foreach ($id in $pidOnPort) {
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc -and $proc.Name -ne 'Idle') {
    Write-Host "Killing $($proc.Name) (PID $id) on port $port..."
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
}

# ----- Docker Compose -----
"PORT=$port" | Set-Content "$PSScriptRoot\.env"

Write-Host 'Stopping old containers...'
docker compose down --remove-orphans 2>$null

Write-Host 'Building image...'
docker compose build --no-cache
if ($LASTEXITCODE -ne 0) { throw 'docker compose build failed' }

Write-Host 'Starting container...'
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed' }

Write-Host "Done. http://127.0.0.1:$port"
docker compose logs -f
