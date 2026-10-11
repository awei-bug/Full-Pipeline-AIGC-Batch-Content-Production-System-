# Launches the local stack (if needed), opens the studio in an app-mode window,
# keeps a tray icon alive while the app runs, and shuts everything down as soon as
# the window is closed. One desktop icon, tray presence, close-to-quit.
#
# Usage:  launch-app.ps1 [-NoTray] [-Force] [-MaxWatchSeconds <seconds>]
#
# ASCII-only on purpose: this file has no BOM and PowerShell 5.1 decodes non-ASCII
# bytes as ANSI, which would break parsing. Chinese UI strings are built from code
# points in New-Text calls below.
param(
  [switch]$NoTray,
  [switch]$Force,
  [int]$MaxWatchSeconds = 0
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".local-stack"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$logPath = Join-Path $stateDir "desktop-launch.log"
$profileDir = Join-Path $stateDir "app-window-profile"
$pidFile = Join-Path $stateDir "app-shell.pid"
$iconPath = Join-Path $root "apps\studio-web\public\app-icon.ico"

$script:MaxWatchSeconds = $MaxWatchSeconds
$script:seenWindow = $false
$script:missCount = 0
$script:watchStart = Get-Date
$script:shouldExit = $false
$script:exitReason = ""
$script:tray = $null
$script:ownsPidFile = $false

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

function New-Text([int[]]$codes) {
  return -join ($codes | ForEach-Object { [char]$_ })
}

# UI strings, kept as code points so this file stays pure ASCII.
$script:L_APP = New-Text @(0x5185, 0x5BB9, 0x521B, 0x4F5C, 0x5E73, 0x53F0)
$script:L_OPEN = New-Text @(0x6253, 0x5F00, 0x4E3B, 0x7A97, 0x53E3)
$script:L_QUIT = New-Text @(0x9000, 0x51FA, 0x5E94, 0x7528)
$script:L_RUNNING = New-Text @(0x8FD0, 0x884C, 0x4E2D)
$script:L_CLOSING = New-Text @(0x6B63, 0x5728, 0x5173, 0x95ED)

function Get-StudioUrl {
  $stateFile = Join-Path $stateDir "state.json"
  if (-not (Test-Path $stateFile)) { return "" }
  try {
    return [string](Get-Content $stateFile -Raw | ConvertFrom-Json).urls.studio
  } catch {
    return ""
  }
}

function Test-Url([string]$url) {
  if ([string]::IsNullOrWhiteSpace($url)) { return $false }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 4
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Find-Browser {
  $candidates = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return ""
}

function Show-Dialog([string]$detail, [string]$title) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($detail, $title) | Out-Null
  } catch {
    # If the dialog cannot be shown, the transcript still has the detail.
  }
}

function Open-AppWindow([string]$url) {
  $browser = Find-Browser
  if ($browser) {
    $appUrl = "--app={0}" -f $url
    # --disable-background-mode keeps Chrome from lingering in the background after
    # the window is closed, so closing the window really means the app is gone.
    $argLine = '{0} --user-data-dir="{1}" --no-first-run --no-default-browser-check --disable-background-mode' -f $appUrl, $profileDir
    Start-Process -FilePath $browser -ArgumentList $argLine | Out-Null
    return $true
  }
  Say "no chromium browser found, falling back to default browser"
  Start-Process $url | Out-Null
  return $false
}

function Get-AppWindowCount {
  # Number of browser processes that belong to our dedicated app profile.
  $browserNames = @("chrome.exe", "msedge.exe", "brave.exe")
  try {
    $items = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe' or Name='brave.exe'" -ErrorAction Stop | Where-Object {
      $_.Name -and
      ($browserNames -contains $_.Name.ToLower()) -and
      $_.CommandLine -and
      ($_.CommandLine.IndexOf($profileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
    return $items.Count
  } catch {
    return -1
  }
}

function Close-AppWindowProcesses {
  $browserNames = @("chrome.exe", "msedge.exe", "brave.exe")
  $windows = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -and
    ($browserNames -contains $_.Name.ToLower()) -and
    $_.CommandLine -and
    ($_.CommandLine.IndexOf($profileDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
  })
  foreach ($proc in $windows) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Say ("closed app window pid=" + $proc.ProcessId)
    } catch {
      Say ("could not close pid=" + $proc.ProcessId + ": " + $_.Exception.Message)
    }
  }
  if ($windows.Count -gt 0) { Start-Sleep -Milliseconds 600 }
  return $windows.Count
}

function Get-ShellRecord {
  # The pid file holds two lines: the shell pid and its start time (yyyyMMddHHmmss).
  if (-not (Test-Path $pidFile)) { return $null }
  $lines = @()
  try { $lines = @(Get-Content -LiteralPath $pidFile -ErrorAction Stop) } catch { return $null }
  if ($lines.Count -lt 2) { return $null }
  $ownerPid = 0
  if (-not [int]::TryParse(($lines[0].Trim()), [ref]$ownerPid)) { return $null }
  if ($ownerPid -le 0) { return $null }
  return [pscustomobject]@{ Pid = $ownerPid; Stamp = $lines[1].Trim() }
}

function Test-ShellAlive {
  # Is another launcher shell still owning the app? The pid alone is not enough
  # (Windows reuses pids), so the recorded start time has to match as well.
  $rec = Get-ShellRecord
  if ($null -eq $rec) { return $false }
  if ($rec.Pid -eq $PID) { return $false }
  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $rec.Pid) -ErrorAction SilentlyContinue
  if (-not $proc -or -not $proc.Name) { return $false }
  if ($proc.Name -notmatch "(?i)^(powershell|pwsh)") { return $false }
  $recorded = [datetime]::MinValue
  $parsed = [datetime]::TryParseExact(
    $rec.Stamp, "yyyyMMddHHmmss",
    [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::None,
    [ref]$recorded)
  if (-not $parsed) { return $false }
  $created = $proc.CreationDate
  if ($null -eq $created) { return $false }
  if ([math]::Abs(($created - $recorded).TotalSeconds) -gt 5) { return $false }
  return $true
}

function Test-WatchStep {
  # Returns $true when the app window is gone and the shell must shut down.
  $count = Get-AppWindowCount
  if ($count -lt 0) { return $false }   # query failed: never shut down on a bad read
  if ($count -gt 0) {
    if (-not $script:seenWindow) { Say "app window detected" }
    $script:seenWindow = $true
    $script:missCount = 0
    return $false
  }
  if ($script:seenWindow) {
    $script:missCount++
    if ($script:missCount -ge 2) {
      $script:exitReason = "app window closed"
      return $true
    }
    return $false
  }
  # The window has not shown up yet: give the browser time to start.
  if (((Get-Date) - $script:watchStart).TotalSeconds -gt 25) {
    $script:exitReason = "app window never appeared"
    return $true
  }
  return $false
}

function Invoke-Shutdown {
  Say ("shutting down: " + $script:exitReason)
  Close-AppWindowProcesses | Out-Null
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
  if ($script:ownsPidFile) {
    try { [System.IO.File]::Delete($pidFile) } catch { }
  }
}

function Invoke-HeadlessWatch {
  while (-not $script:shouldExit) {
    Start-Sleep -Seconds 2
    if (Test-WatchStep) {
      $script:shouldExit = $true
    } elseif ($script:MaxWatchSeconds -gt 0 -and ((Get-Date) - $script:watchStart).TotalSeconds -gt $script:MaxWatchSeconds) {
      $script:exitReason = "watch timeout (test mode)"
      $script:shouldExit = $true
    }
  }
}

function Start-TrayWatch {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $iconObj = $null
  if (Test-Path $iconPath) {
    try {
      $bytes = [System.IO.File]::ReadAllBytes($iconPath)
      # Prefer the dedicated 16x16 frame (the native tray size); if that fails,
      # fall back to whichever frame the default constructor picks.
      try {
        $smallStream = New-Object System.IO.MemoryStream
        $smallStream.Write($bytes, 0, $bytes.Length)
        $smallStream.Position = 0
        $iconObj = New-Object System.Drawing.Icon -ArgumentList @($smallStream, (New-Object System.Drawing.Size 16, 16))
      } catch {
        $bigStream = New-Object System.IO.MemoryStream
        $bigStream.Write($bytes, 0, $bytes.Length)
        $bigStream.Position = 0
        $iconObj = New-Object System.Drawing.Icon -ArgumentList $bigStream
      }
    } catch {
      Say ("tray icon load failed: " + $_.Exception.Message)
    }
  }
  if (-not $iconObj) { $iconObj = [System.Drawing.SystemIcons]::Application }

  $notify = New-Object System.Windows.Forms.NotifyIcon
  $notify.Icon = $iconObj
  $notify.Text = ($script:L_APP + " - " + $script:L_RUNNING)
  $notify.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = $menu.Items.Add($script:L_OPEN)
  $quitItem = $menu.Items.Add($script:L_QUIT)
  $notify.ContextMenuStrip = $menu
  $script:tray = $notify

  $openItem.add_Click({
    try {
      $u = Get-StudioUrl
      if (Test-Url $u) { Open-AppWindow $u | Out-Null }
    } catch {
      Say ("open from tray failed: " + $_.Exception.Message)
    }
  })

  $quitItem.add_Click({
    $script:exitReason = "quit from tray menu"
    $script:shouldExit = $true
    try { $script:tray.Text = ($script:L_APP + " - " + $script:L_CLOSING) } catch { }
    [System.Windows.Forms.Application]::ExitThread()
  })

  $notify.add_MouseDoubleClick({
    try {
      $u = Get-StudioUrl
      if (Test-Url $u) { Open-AppWindow $u | Out-Null }
    } catch {
      Say ("open from tray failed: " + $_.Exception.Message)
    }
  })

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 2000
  $timer.add_Tick({
    if ($script:shouldExit) { return }
    if (Test-WatchStep) {
      $script:shouldExit = $true
      try { $script:tray.Text = ($script:L_APP + " - " + $script:L_CLOSING) } catch { }
      [System.Windows.Forms.Application]::ExitThread()
      return
    }
    if ($script:MaxWatchSeconds -gt 0 -and ((Get-Date) - $script:watchStart).TotalSeconds -gt $script:MaxWatchSeconds) {
      $script:exitReason = "watch timeout (test mode)"
      $script:shouldExit = $true
      [System.Windows.Forms.Application]::ExitThread()
    }
  })
  $timer.Start()

  Say "tray icon active; closing the window shuts everything down"
  [System.Windows.Forms.Application]::Run()

  $timer.Stop()
  $timer.Dispose()
  $notify.Visible = $false
  $notify.Dispose()
  Say "tray icon removed"
}

try {
  Say ("desktop launcher started (pid=" + $PID + ")")

  # A second double-click must not start a second stack: wait for the running shell
  # to become ready, then just bring its window back.
  if (-not $Force -and (Test-ShellAlive)) {
    $deadline = (Get-Date).AddSeconds(90)
    $focused = $false
    while ((Get-Date) -lt $deadline) {
      $u = Get-StudioUrl
      if ((Test-Url $u) -and (Test-ShellAlive)) {
        Say "another shell instance owns the app, focusing its window"
        Open-AppWindow $u | Out-Null
        $focused = $true
        break
      }
      if (-not (Test-ShellAlive)) { break }   # it exited meanwhile: fall through to a cold start
      Start-Sleep -Milliseconds 1000
    }
    if ($focused) { exit 0 }
    if (Test-ShellAlive) { throw "Another launcher instance is still busy. Try again in a moment." }
  }

  # Record this shell early so a second double-click is detected even while the
  # services are still starting up.
  $stamp = (Get-Date).ToString("yyyyMMddHHmmss")
  Set-Content -LiteralPath $pidFile -Value @($PID, $stamp) -Encoding ASCII
  $script:ownsPidFile = $true
  Say ("shell pid recorded: " + $PID)

  $url = Get-StudioUrl
  if (Test-Url $url) {
    Say "services already running at $url"
  } else {
    Say "services not ready, starting content profile"
    $dev = Join-Path $root "dev.ps1"
    if (-not (Test-Path $dev)) { throw "dev.ps1 not found at $dev" }
    # Invoked as a script so no command-line quoting is involved.
    & $dev content
    $url = Get-StudioUrl
    Say "state.json url after start: $url"
  }

  if ([string]::IsNullOrWhiteSpace($url)) {
    throw "No studio url recorded in .local-stack/state.json. Check .local-stack/*.err.log"
  }

  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    if (Test-Url $url) { break }
    Start-Sleep -Milliseconds 600
  }
  if (-not (Test-Url $url)) { throw "Studio not reachable: $url" }
  Say "studio ready at $url"

  $script:watchStart = Get-Date
  Say "opening app window"
  Open-AppWindow $url | Out-Null

  if ($NoTray) {
    Say "tray disabled, watching window in headless mode"
    Invoke-HeadlessWatch
  } else {
    try {
      Start-TrayWatch
      if (-not $script:shouldExit) {
        $script:exitReason = "tray session ended"
        $script:shouldExit = $true
      }
    } catch {
      Say ("tray unavailable (" + $_.Exception.Message + "), falling back to headless watch")
      Invoke-HeadlessWatch
    }
  }

  if ($script:exitReason -eq "app window never appeared") {
    Show-Dialog ("The app window did not open.`r`n`r`nLog: " + $logPath) $script:L_APP
  }

  Invoke-Shutdown
} catch {
  Say ("ERROR " + $_.Exception.Message)
  if ($script:ownsPidFile) {
    try { [System.IO.File]::Delete($pidFile) } catch { }
  }
  Show-Dialog ("Could not start the app.`r`n`r`nLog: " + $logPath + "`r`n`r`n" + $_.Exception.Message) $script:L_APP
} finally {
  if ($transcribing) { try { Stop-Transcript | Out-Null } catch { } }
}
