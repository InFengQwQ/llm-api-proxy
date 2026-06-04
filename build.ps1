$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 提示：首次使用需准备 config.yaml
if (-not (Test-Path config.yaml)) {
    Write-Host "Missing config.yaml — copy config.example.yaml and fill in your API keys:"
    Write-Host "  cp config.example.yaml config.yaml"
    exit 1
}

# 安装依赖（幂等，已装则无操作）
npm install

# 读取端口，启动容器
$env:PORT = (Select-String 'port:\s*(\d+)' config.yaml).Matches.Groups[1].Value
npm run up
