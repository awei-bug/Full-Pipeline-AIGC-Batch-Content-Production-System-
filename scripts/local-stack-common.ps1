$ErrorActionPreference = "Stop"

function Get-LocalStackState([string]$StateFile) {
  if (-not (Test-Path $StateFile)) {
    return $null
  }

  return Get-Content $StateFile -Raw | ConvertFrom-Json
}

function Get-LocalStackPorts([object]$State) {
  $ports = @()

  if ($null -eq $State -or $null -eq $State.urls) {
    return @()
  }

  foreach ($property in $State.urls.PSObject.Properties) {
    $value = [string]$property.Value
    if ([string]::IsNullOrWhiteSpace($value)) {
      continue
    }

    try {
      $uri = [Uri]$value
      if ($uri.Port -gt 0) {
        $ports += $uri.Port
      }
    } catch {
    }
  }

  return @($ports | Sort-Object -Unique)
}

function Get-LocalStackRuntimeState([object]$State) {
  $runningProcesses = @()

  foreach ($processInfo in @($State.processes)) {
    if ($null -eq $processInfo -or -not $processInfo.pid) {
      continue
    }

    # SilentlyContinue keeps dead pids from writing errors into the transcript.
    $live = Get-Process -Id ([int]$processInfo.pid) -ErrorAction SilentlyContinue
    if ($null -ne $live) {
      $runningProcesses += [pscustomobject]@{
        name = [string]$processInfo.name
        pid = [int]$processInfo.pid
      }
    }
  }

  $occupiedPorts = @()
  $portOwnerPids = @()

  foreach ($port in Get-LocalStackPorts -State $State) {
    $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($connections.Count -eq 0) {
      continue
    }

    $occupiedPorts += $port
    $portOwnerPids += @($connections | ForEach-Object { [int]$_.OwningProcess })
  }

  return [pscustomobject]@{
    runningProcesses = @($runningProcesses)
    occupiedPorts = @($occupiedPorts | Sort-Object -Unique)
    portOwnerPids = @($portOwnerPids | Sort-Object -Unique)
  }
}

function Stop-ProcessTree([int]$ProcessId) {
  if ($ProcessId -le 0) {
    return
  }

  Start-Process taskkill.exe `
    -ArgumentList @("/PID", "$ProcessId", "/T", "/F") `
    -WindowStyle Hidden `
    -Wait | Out-Null
}

function Stop-ProcessIfRunning([int]$ProcessId) {
  if ($ProcessId -le 0) {
    return
  }

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
  } catch {
  }
}

function Select-OrphanLocalStackProcesses(
  [object[]]$Processes,
  [string]$RootDir,
  [int[]]$LocalPorts = @()
) {
  $normalizedRoot = $RootDir.ToLowerInvariant()
  $matches = @()
  $processPortMap = @{}

  foreach ($port in @($LocalPorts | Sort-Object -Unique)) {
    $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    foreach ($connection in $connections) {
      $processPortMap[[int]$connection.OwningProcess] = $true
    }
  }

  foreach ($process in @($Processes)) {
    if ($null -eq $process) {
      continue
    }

    $commandLine = [string]$process.CommandLine
    $processName = [string]$process.Name
    if ([string]::IsNullOrWhiteSpace($commandLine)) {
      continue
    }

    $normalizedCommand = $commandLine.ToLowerInvariant()
    $processId = [int]$process.ProcessId
    $isKnownPortOwner = $processPortMap.ContainsKey($processId)
    $isRepoScoped = $normalizedCommand.Contains($normalizedRoot)

    $isApiServer = $processName -eq "node.exe" -and $normalizedCommand.Contains("src/server.js")
    $isStudio = $processName -eq "node.exe" -and $normalizedCommand.Contains("vite")
    $isOrchestrator = $processName -eq "python.exe" -and $normalizedCommand.Contains("uvicorn") -and $normalizedCommand.Contains("app.main:app")

    if (-not $isRepoScoped -and -not $isKnownPortOwner) {
      continue
    }

    if ($isApiServer -or $isStudio -or $isOrchestrator) {
      $matches += [pscustomobject]@{
        ProcessId = $processId
        Name = $processName
        CommandLine = $commandLine
      }
    }
  }

  return @($matches | Sort-Object ProcessId -Unique)
}

function Get-OrphanLocalStackProcesses([string]$RootDir) {
  $candidateProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
  $ports = @(
    3100..3120
    5173..5195
    8110..8135
  )
  return Select-OrphanLocalStackProcesses -Processes $candidateProcesses -RootDir $RootDir -LocalPorts $ports
}

function Stop-LocalStackProcesses(
  [object]$State,
  [int]$TimeoutSec = 20
) {
  foreach ($processInfo in @($State.processes)) {
    if ($null -eq $processInfo -or -not $processInfo.pid) {
      continue
    }

    try {
      Stop-ProcessTree -ProcessId ([int]$processInfo.pid)
    } catch {
    }
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSec)

  do {
    $runtime = Get-LocalStackRuntimeState -State $State
    if ($runtime.occupiedPorts.Count -eq 0) {
      return $true
    }

    foreach ($portOwnerPid in @($runtime.portOwnerPids | Sort-Object -Unique)) {
      Stop-ProcessIfRunning -ProcessId ([int]$portOwnerPid)
    }

    foreach ($processId in @($runtime.runningProcesses | ForEach-Object { [int]$_.pid } | Sort-Object -Unique)) {
      try {
        Stop-ProcessTree -ProcessId ([int]$processId)
      } catch {
      }
    }

    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $deadline)

  return $false
}
