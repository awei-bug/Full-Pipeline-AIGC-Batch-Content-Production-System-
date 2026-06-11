$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $rootDir ".local-stack"
$stateFile = Join-Path $stateDir "state.json"

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Get-EnvValue([string]$name) {
  foreach ($scope in @("Process", "User", "Machine")) {
    $value = [Environment]::GetEnvironmentVariable($name, $scope)
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return $value
    }
  }
  return $null
}

function Get-FreePort([int]$preferred) {
  $port = $preferred
  while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    $port += 1
  }
  return $port
}

function Start-StackProcess(
  [string]$name,
  [string]$workingDir,
  [string[]]$commandLines,
  [string]$stdoutLog,
  [string]$stderrLog
) {
  $scriptPath = Join-Path $stateDir "$name-run.ps1"
  $content = @(
    '$ErrorActionPreference = "Stop"'
    ('Set-Location "{0}"' -f $workingDir.Replace('"', '""'))
  ) + $commandLines
  Set-Content -Path $scriptPath -Value $content -Encoding UTF8

  return Start-Process powershell `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath) `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru `
    -WindowStyle Hidden
}

function Wait-HttpOk([string]$url, [int]$timeoutSec = 30) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return $true
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)

  return $false
}

if (Test-Path $stateFile) {
  $state = Get-Content $stateFile | ConvertFrom-Json
  $running = @()
  foreach ($processInfo in $state.processes) {
    try {
      $process = Get-Process -Id $processInfo.pid -ErrorAction Stop
      if ($process) {
        $running += $processInfo.name
      }
    } catch {
    }
  }

  if ($running.Count -gt 0) {
    throw "Local stack is already running: $($running -join ', '). Run npm run stack:stop first."
  }
}

$modelscopeToken = Get-EnvValue "MODELSCOPE_API_TOKEN"
if (-not $modelscopeToken) {
  throw "MODELSCOPE_API_TOKEN was not found in Process/User/Machine environment."
}

$apiPort = Get-FreePort 3100
$orchestratorPort = Get-FreePort 8110
$studioPort = Get-FreePort 5173

$apiBaseUrl = "http://127.0.0.1:$apiPort"
$orchestratorBaseUrl = "http://127.0.0.1:$orchestratorPort"
$assetsDir = Join-Path $rootDir "storage/generated"

$apiProc = Start-StackProcess `
  -name "api-server" `
  -workingDir (Join-Path $rootDir "apps/api-server") `
  -commandLines @(
    ('$env:API_PORT = "{0}"' -f $apiPort),
    '$env:API_HOST = "127.0.0.1"',
    ('$env:AI_ORCHESTRATOR_BASE_URL = "{0}"' -f $orchestratorBaseUrl),
    ('$env:AI_ORCHESTRATOR_ASSETS_DIR = "{0}"' -f $assetsDir.Replace('"', '""')),
    'npm run start'
  ) `
  -stdoutLog (Join-Path $stateDir "api-server.out.log") `
  -stderrLog (Join-Path $stateDir "api-server.err.log")

$orchestratorProc = Start-StackProcess `
  -name "ai-orchestrator" `
  -workingDir (Join-Path $rootDir "apps/ai-orchestrator") `
  -commandLines @(
    ('$env:MODELSCOPE_API_TOKEN = "{0}"' -f $modelscopeToken.Replace('"', '""')),
    ('$env:API_SERVER_BASE_URL = "{0}"' -f $apiBaseUrl),
    ('$env:AI_ORCHESTRATOR_ASSETS_DIR = "{0}"' -f $assetsDir.Replace('"', '""')),
    '$env:PYTHONUTF8 = "1"',
    ('py -m uvicorn app.main:app --host 127.0.0.1 --port {0}' -f $orchestratorPort)
  ) `
  -stdoutLog (Join-Path $stateDir "ai-orchestrator.out.log") `
  -stderrLog (Join-Path $stateDir "ai-orchestrator.err.log")

$studioProc = Start-StackProcess `
  -name "studio-web" `
  -workingDir (Join-Path $rootDir "apps/studio-web") `
  -commandLines @(
    ('$env:VITE_API_BASE_URL = "{0}"' -f $apiBaseUrl),
    ('npm run dev -- --host 127.0.0.1 --port {0} --strictPort' -f $studioPort)
  ) `
  -stdoutLog (Join-Path $stateDir "studio-web.out.log") `
  -stderrLog (Join-Path $stateDir "studio-web.err.log")

if (-not (Wait-HttpOk "$orchestratorBaseUrl/health" 30)) {
  throw "ai-orchestrator failed to start. Check .local-stack\\ai-orchestrator.err.log"
}

if (-not (Wait-HttpOk "$apiBaseUrl/api/health" 30)) {
  throw "api-server failed to start. Check .local-stack\\api-server.err.log"
}

if (-not (Wait-HttpOk "http://127.0.0.1:$studioPort" 30)) {
  throw "studio-web failed to start. Check .local-stack\\studio-web.err.log"
}

$state = [ordered]@{
  startedAt = (Get-Date).ToString("o")
  urls = [ordered]@{
    api = $apiBaseUrl
    orchestrator = $orchestratorBaseUrl
    studio = "http://127.0.0.1:$studioPort"
  }
  processes = @(
    [ordered]@{ name = "api-server"; pid = $apiProc.Id }
    [ordered]@{ name = "ai-orchestrator"; pid = $orchestratorProc.Id }
    [ordered]@{ name = "studio-web"; pid = $studioProc.Id }
  )
  logs = [ordered]@{
    apiOut = ".local-stack/api-server.out.log"
    apiErr = ".local-stack/api-server.err.log"
    orchestratorOut = ".local-stack/ai-orchestrator.out.log"
    orchestratorErr = ".local-stack/ai-orchestrator.err.log"
    studioOut = ".local-stack/studio-web.out.log"
    studioErr = ".local-stack/studio-web.err.log"
  }
}

$state | ConvertTo-Json -Depth 6 | Set-Content -Path $stateFile -Encoding UTF8
$state | ConvertTo-Json -Depth 6
