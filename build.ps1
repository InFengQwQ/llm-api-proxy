Set-Location $PSScriptRoot

$config = Get-Content "$PSScriptRoot\config.yaml" -Raw
$port = if ($config -match 'port:\s*(\d+)') { $matches[1] } else { throw "Cannot parse port from config.yaml" }

# kill any host process squatting on the target port
$pidOnPort = (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
if ($pidOnPort) {
    foreach ($id in $pidOnPort) {
        $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($proc -and $proc.Name -ne 'Idle') {
            Write-Host "Killing $($proc.Name) (PID $id) on port $port..."
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        }
    }
}

"PORT=$port" | Set-Content "$PSScriptRoot\.env"

docker compose down --remove-orphans 2>$null
docker compose build --no-cache
docker compose up -d

Write-Host "Done. http://127.0.0.1:$port"
docker compose logs -f
