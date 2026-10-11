# Stop the product knowledge data hub.
$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $rootDir ".local-stack\data-hub.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "data-hub pid file not found; it may not be running."
    exit 0
}

$pidValue = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($pidValue) {
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($proc) {
        Stop-Process -Id $pidValue -Force
        Write-Host "data-hub stopped (pid=$pidValue)"
    } else {
        Write-Host "Process $pidValue does not exist; removing stale pid file."
    }
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
