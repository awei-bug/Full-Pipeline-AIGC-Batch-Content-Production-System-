$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $rootDir ".local-stack"
$stateFile = Join-Path $stateDir "state.json"
. (Join-Path $PSScriptRoot "local-stack-common.ps1")

if (-not (Test-Path $stateFile)) {
  $orphanProcesses = Get-OrphanLocalStackProcesses -RootDir $rootDir
  foreach ($process in $orphanProcesses) {
    Stop-ProcessIfRunning -ProcessId ([int]$process.ProcessId)
  }
  Write-Output "Local stack is not running."
  exit 0
}

$state = Get-LocalStackState -StateFile $stateFile

if ($null -eq $state) {
  Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
  $orphanProcesses = Get-OrphanLocalStackProcesses -RootDir $rootDir
  foreach ($process in $orphanProcesses) {
    Stop-ProcessIfRunning -ProcessId ([int]$process.ProcessId)
  }
  Write-Output "Local stack stopped."
  exit 0
}

$stopped = Stop-LocalStackProcesses -State $state -TimeoutSec 20
if (-not $stopped) {
  throw "Local stack ports were not released in time. Check .local-stack logs and running processes."
}

$orphanProcesses = Get-OrphanLocalStackProcesses -RootDir $rootDir
foreach ($process in $orphanProcesses) {
  Stop-ProcessIfRunning -ProcessId ([int]$process.ProcessId)
}

Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $stateDir -Filter "*-run.ps1" -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue
Write-Output "Local stack stopped."
