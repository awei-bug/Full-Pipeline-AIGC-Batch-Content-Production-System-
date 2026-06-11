$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $rootDir ".local-stack"
$stateFile = Join-Path $stateDir "state.json"

if (-not (Test-Path $stateFile)) {
  Write-Output "Local stack is not running."
  exit 0
}

$state = Get-Content $stateFile | ConvertFrom-Json

foreach ($processInfo in $state.processes) {
  try {
    Stop-Process -Id $processInfo.pid -Force -ErrorAction Stop
  } catch {
  }
}

Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
Write-Output "Local stack stopped."
