$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  if (-not (Test-Path -LiteralPath '.env')) { throw 'Missing AI/local/.env. Configure LOCAL_AGENT_TOKEN first.' }
  node --import tsx --env-file=.env server.mts
} finally { Pop-Location }
