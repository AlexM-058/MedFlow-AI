param([switch]$Tunnel)
$ErrorActionPreference = 'Stop'
$ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
if (-not (Test-Path -LiteralPath $ollama)) { throw 'Install Ollama first.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.env'))) { throw 'Missing AI/local/.env.' }

# Settings the extraction service reads from AI/local/.env (model and OCR differ per machine: a PC with a GPU can use
# medgemma1.5:4b and EasyOCR, a laptop without one stays on gemma3:1b and Tesseract). Defaults = the laptop setup.
function Get-LocalSetting([string]$Name, [string]$Default) {
  $line = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.env') | Where-Object { $_ -match "^$Name=\S" } | Select-Object -First 1
  if ($line) { return ($line -replace "^$Name=", '').Trim() }
  return $Default
}
function Is-ServiceReady([string]$Address) {
  try { $null = Invoke-RestMethod -Uri $Address -TimeoutSec 3; return $true } catch { return $false }
}
if (-not (Is-ServiceReady 'http://127.0.0.1:11434/api/tags')) {
  $env:OLLAMA_HOST = '127.0.0.1:11434'
  Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -RedirectStandardOutput (Join-Path $PSScriptRoot 'ollama.log') -RedirectStandardError (Join-Path $PSScriptRoot 'ollama-error.log')
}
if (-not (Is-ServiceReady 'http://127.0.0.1:8092/health')) {
  Start-Process -FilePath (Get-Command node).Source -ArgumentList @('--import', 'tsx', '--env-file=.env', 'server.mts') -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -RedirectStandardOutput (Join-Path $PSScriptRoot 'agent.log') -RedirectStandardError (Join-Path $PSScriptRoot 'agent-error.log')
}
if (-not (Is-ServiceReady 'http://127.0.0.1:8090/health')) {
  # Serviciul de extragere a rețetelor (Python). Modelul gemma3:1b nu vede imagini, deci fără rezerva MedGemma;
  # imaginile se citesc cu Tesseract (dacă lipsește, pozele dau 503 clar, PDF-urile cu text merg oricum).
  $extraction = Join-Path $PSScriptRoot '..\edge\extraction_service'
  $python = Join-Path $extraction '.venv\Scripts\python.exe'
  if (Test-Path -LiteralPath $python) {
    $env:EDGE_LLM_MEDGEMMA = Get-LocalSetting 'EDGE_LLM_MEDGEMMA' 'gemma3:1b'
    $env:OCR_ENGINE = Get-LocalSetting 'OCR_ENGINE' 'tesseract'
    $env:OCR_FALLBACK = Get-LocalSetting 'OCR_FALLBACK' 'off'
    $env:EASYOCR_GPU = Get-LocalSetting 'EASYOCR_GPU' 'true'
    $env:PYTHONUTF8 = '1'
    # Datele de limbă Tesseract (eng, osd, ron) din folderul utilizatorului; instalerul silențios aduce doar eng.
    $tessdata = Join-Path $env:USERPROFILE 'tessdata'
    if (Test-Path -LiteralPath (Join-Path $tessdata 'ron.traineddata')) { $env:TESSDATA_PREFIX = $tessdata }
    Start-Process -FilePath $python -ArgumentList @('-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8090') -WindowStyle Hidden -WorkingDirectory $extraction -RedirectStandardOutput (Join-Path $extraction 'service.log') -RedirectStandardError (Join-Path $extraction 'service-error.log')
  } else {
    Write-Output 'Extraction service not started: create AI/edge/extraction_service/.venv first (see its README).'
  }
}
$aiRoot = Join-Path $PSScriptRoot '..'
$aiEnv = Join-Path $aiRoot '.env'
$hasGeminiKey = (Test-Path -LiteralPath $aiEnv) -and ((Get-Content -LiteralPath $aiEnv) -match '^GEMINI_API_KEY=\S+')
if (-not (Is-ServiceReady 'http://127.0.0.1:8091/health')) {
  # Serviciul AI cloud (curățare date + Gemini), doar pe loopback; din exterior se ajunge numai prin gateway (cu token).
  if ($hasGeminiKey -and (Test-Path -LiteralPath (Join-Path $aiRoot 'node_modules\tsx'))) {
    Start-Process -FilePath (Get-Command node).Source -ArgumentList @('--import', 'tsx', 'cloud/server.ts') -WindowStyle Hidden -WorkingDirectory $aiRoot -RedirectStandardOutput (Join-Path $PSScriptRoot 'cloud.log') -RedirectStandardError (Join-Path $PSScriptRoot 'cloud-error.log')
  } else {
    Write-Output 'AI cloud service not started: add GEMINI_API_KEY to AI/.env and run npm ci in AI/.'
  }
}
if ($Tunnel) {
  $cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
  if (-not (Test-Path -LiteralPath $cloudflared)) { $cloudflared = (Get-Command cloudflared).Source }
  if (Get-Process cloudflared -ErrorAction SilentlyContinue) { throw 'A tunnel is already running. Reuse its URL; do not start a second one.' }
  Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:8092', '--no-autoupdate') -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -RedirectStandardOutput (Join-Path $PSScriptRoot 'tunnel.log') -RedirectStandardError (Join-Path $PSScriptRoot 'tunnel-error.log')
  Write-Output 'Tunnel started. Read its HTTPS URL from AI/local/tunnel-error.log and update Render LOCAL_AGENT_URL.'
}
Write-Output 'Local stack requested. Check http://127.0.0.1:8092/health. The PC must stay awake.'
