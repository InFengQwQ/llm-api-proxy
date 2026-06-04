$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:PORT = (Select-String 'port:\s*(\d+)' config.yaml).Matches.Groups[1].Value
npm run up
