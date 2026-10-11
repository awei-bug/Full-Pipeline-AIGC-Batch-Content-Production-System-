# Start the product knowledge data hub.
param(
    [int]$Port = 8120,
    [string]$Token = "",
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $rootDir "apps\data-hub"
$stateDir = Join-Path $rootDir ".local-stack"
$pidFile = Join-Path $stateDir "data-hub.pid"

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

if (Test-Path $pidFile) {
    $old = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
        Write-Host "data-hub is already running (pid=$old) http://127.0.0.1:$Port"
        exit 0
    }
}

if (-not $Python) {
    $candidates = @(
        (Get-Command py -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
        (Get-Command python -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
        "$env:USERPROFILE\.workbuddy\binaries\python\versions\3.13.12\python.exe"
    )
    $Python = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $Python) {
    Write-Error "Python was not found. Use -Python to specify its path."
}

if (-not $Token) {
    $Token = $env:DATA_HUB_TOKEN
}
if (-not $Token) {
    $Token = "hub-local-token"
    Write-Host "DATA_HUB_TOKEN is not set. Using local default token: $Token"
}

$env:HUB_HOST = "127.0.0.1"
$env:HUB_PORT = "$Port"
$env:HUB_TOKENS = "demo:$Token"
$env:DATA_HUB_TOKEN = $Token
$env:DATA_HUB_TENANT_SLUG = "demo"

$logOut = Join-Path $stateDir "data-hub.out.log"
$logErr = Join-Path $stateDir "data-hub.err.log"

# Keep this file ASCII-only (no BOM). Start-Process adds no quotes and this repo root
# contains a space, so the app.py path must be quoted explicitly.
$hubEntry = '"{0}"' -f (Join-Path $appDir "app.py")
$proc = Start-Process -FilePath $Python -ArgumentList $hubEntry `
    -WorkingDirectory $appDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $logOut -RedirectStandardError $logErr

Set-Content -Path $pidFile -Value $proc.Id

Start-Sleep -Seconds 2
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
    Write-Host "data-hub started pid=$($proc.Id) http://127.0.0.1:$Port"
    Write-Host ("health: " + ($health | ConvertTo-Json -Compress))
    Write-Host "tenant=demo token=$Token"
    Write-Host "log: $logOut"
} catch {
    Write-Warning "data-hub started but health check failed. Check $logErr"
}
