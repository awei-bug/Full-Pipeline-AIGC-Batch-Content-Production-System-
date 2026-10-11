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
  # .NET delete keeps working even when a tool wraps Remove-Item (some sandboxes do).
  try { [System.IO.File]::Delete($stateFile) } catch { }
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

# .NET deletes keep working even when a tool wraps Remove-Item (some sandboxes do).
try { [System.IO.File]::Delete($stateFile) } catch { }
Get-ChildItem -Path $stateDir -Filter "*-run.ps1" -ErrorAction SilentlyContinue |
  ForEach-Object { try { [System.IO.File]::Delete($_.FullName) } catch { } }
Write-Output "Local stack stopped."
