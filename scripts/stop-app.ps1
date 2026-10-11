# Stops the local stack and closes the app-mode window opened by launch-app.ps1.
# ASCII-only, same reason as launch-app.ps1.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".local-stack"
$profileDir = Join-Path $stateDir "app-window-profile"
$logPath = Join-Path $stateDir "desktop-launch.log"

$transcribing = $false
try {
  Start-Transcript -Path $logPath -Append | Out-Null
  $transcribing = $true
} catch {
  $transcribing = $false
}

function Say([string]$message) {
  Write-Host ("[{0}] {1}" -f (Get-Date).ToString("HH:mm:ss"), $message)
}

try {
  Say "desktop launcher stop requested"

  # End the tray shell first: it watches for the window to disappear and would
  # otherwise run its own shutdown at the same time as this script.
  $pidFile = Join-Path $stateDir "app-shell.pid"
  if (Test-Path $pidFile) {
    $lines = @()
    try { $lines = @(Get-Content -LiteralPath $pidFile -ErrorAction Stop) } catch { $lines = @() }
    $ownerPid = 0
    $parsed = $false
    if ($lines.Count -ge 1) {
      $parsed = [int]::TryParse(($lines[0].Trim()), [ref]$ownerPid)
    }
    if ($parsed -and $ownerPid -gt 0 -and $ownerPid -ne $PID) {
      $owner = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $ownerPid) -ErrorAction SilentlyContinue
      $isShell = $false
      if ($owner -and $owner.Name -and ($owner.Name -match "(?i)^(powershell|pwsh)")) {
        # Prefer the recorded start time (pid reuse guard); fall back to the command line.
        $stampOk = $false
        if ($lines.Count -ge 2) {
          $recorded = [datetime]::MinValue
          $okParse = [datetime]::TryParseExact(
            $lines[1].Trim(), "yyyyMMddHHmmss",
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::None,
            [ref]$recorded)
          if ($okParse -and $owner.CreationDate -and ([math]::Abs(($owner.CreationDate - $recorded).TotalSeconds) -le 5)) {
            $stampOk = $true
          }
        }
        $cmdOk = ($owner.CommandLine -and ($owner.CommandLine.IndexOf("launch-app.ps1", [System.StringComparison]::OrdinalIgnoreCase) -ge 0))
        if ($stampOk -or $cmdOk) { $isShell = $true }
      }
      if ($isShell) {
        try {
          Stop-Process -Id $ownerPid -Force -ErrorAction Stop
          Say ("tray shell stopped pid=" + $ownerPid)
        } catch {
          Say ("could not stop tray shell pid=" + $ownerPid + ": " + $_.Exception.Message)
        }
      } else {
        Say ("stale shell pid file ignored (pid=" + $ownerPid + ")")
      }
    }
    # .NET delete keeps working even when some tool wraps Remove-Item.
    try { [System.IO.File]::Delete($pidFile) } catch { }
  }

  # Close the app-mode window. Match strictly: browser processes only, and only when
  # the FULL profile path appears in their command line. Matching on a bare folder
  # name would also hit any shell or editor that merely mentions it.
  $browserNames = @("chrome.exe", "msedge.exe", "brave.exe")
  $windows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -and
    ($browserNames -contains $_.Name.ToLower()) -and
    $_.CommandLine -and
    ($_.CommandLine.IndexOf($profileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
  })
  if ($windows.Count -gt 0) {
    foreach ($proc in $windows) {
      try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        Say ("closed app window pid=" + $proc.ProcessId + " (" + $proc.Name + ")")
      } catch {
        Say ("could not close pid=" + $proc.ProcessId + ": " + $_.Exception.Message)
      }
    }
    Start-Sleep -Milliseconds 800
  } else {
    Say "no app window process found"
  }

  # Stop the services.
  $stopScript = Join-Path $PSScriptRoot "stop-local-stack.ps1"
  if (Test-Path $stopScript) {
    try {
      & $stopScript
      Say "services stopped"
    } catch {
      Say ("stop-local-stack reported: " + $_.Exception.Message)
    }
  } else {
    Say "stop-local-stack.ps1 not found, skipped"
  }
} catch {
  Say ("ERROR " + $_.Exception.Message)
} finally {
  if ($transcribing) { try { Stop-Transcript | Out-Null } catch { } }
}
