param(
  [ValidateSet("content", "full", "hub", "shop", "status", "stop")]
  [string]$Profile = "content"
)

$ErrorActionPreference = "Stop"

$rootDir = $PSScriptRoot
$scriptsDir = Join-Path $rootDir "scripts"
$stateDir = Join-Path $rootDir ".local-stack"
$extendedStateFile = Join-Path $stateDir "extended-state.json"
$shopRoot = Join-Path (Join-Path "F:\Python_code" ("Flask" + [char]0x9879 + [char]0x76EE)) "flask_shop"
$shopPort = 5000
$hubPort = 8120
$hubToken = "hub-local-token"
$hubTenant = "demo"
$shopToken = "dev-integration-token-2026"

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Get-EnvValue([string]$Name) {
  foreach ($scope in @("Process", "User", "Machine")) {
    $value = [Environment]::GetEnvironmentVariable($Name, $scope)
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      return $value
    }
  }
  return $null
}

function Test-HttpOk([string]$Url, [int]$TimeoutSec = 5) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Wait-HttpOk([string]$Url, [int]$TimeoutSec = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    if (Test-HttpOk -Url $Url -TimeoutSec 5) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Test-PortListening([int]$Port) {
  return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
}

function Wait-PortFree([int]$Port, [int]$TimeoutSec = 10) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  do {
    if (-not (Test-PortListening -Port $Port)) {
      return $true
    }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $deadline)
  return $false
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

function Get-PidFromFile([string]$Path) {
  if (-not (Test-Path $Path)) {
    return $null
  }
  $value = Get-Content $Path -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($value -match "^\d+$") {
    return [int]$value
  }
  return $null
}

function Write-ShopRunScript([hashtable]$Environment) {
  $runScriptPath = Join-Path $stateDir "flask-shop-run.ps1"
  $lines = @(
    '$ErrorActionPreference = "Stop"'
  )

  foreach ($key in $Environment.Keys) {
    $value = [string]$Environment[$key]
    $lines += ("`$env:{0} = '{1}'" -f $key, $value.Replace("'", "''"))
  }

  $lines += "& '.venv\Scripts\python.exe' '-u' 'run_dev_api.py'"
  Set-Content -Path $runScriptPath -Encoding UTF8 -Value ($lines -join "`r`n")
  return $runScriptPath
}

function Save-ExtendedState {
  $hubPid = Get-PidFromFile (Join-Path $stateDir "data-hub.pid")
  $shopPid = Get-PidFromFile (Join-Path $stateDir "flask-shop.pid")
  $state = [ordered]@{
    updatedAt = (Get-Date).ToString("o")
    hub = [ordered]@{
      url = "http://127.0.0.1:$hubPort"
      pid = $hubPid
      health = "http://127.0.0.1:$hubPort/health"
    }
    shop = [ordered]@{
      url = "http://127.0.0.1:$shopPort"
      pid = $shopPid
      health = "http://127.0.0.1:$shopPort/health/"
    }
  }
  $state | ConvertTo-Json -Depth 6 | Set-Content -Path $extendedStateFile -Encoding UTF8
}

function Start-Hub {
  if (Test-HttpOk "http://127.0.0.1:$hubPort/health") {
    Write-Host "data-hub is already running: http://127.0.0.1:$hubPort"
    return
  }

  if (Test-PortListening -Port $hubPort) {
    throw "Port $hubPort is occupied by another process; data-hub was not started."
  }

  $token = Get-EnvValue "DATA_HUB_TOKEN"
  if ([string]::IsNullOrWhiteSpace($token)) {
    $token = $hubToken
  }
  & (Join-Path $scriptsDir "start-data-hub.ps1") -Port $hubPort -Token $token
  if (-not (Wait-HttpOk "http://127.0.0.1:$hubPort/health" 20)) {
    throw "data-hub failed to start. Check .local-stack\data-hub.err.log"
  }
}

function Start-Shop {
  $pidFile = Join-Path $stateDir "flask-shop.pid"
  $pidValue = Get-PidFromFile $pidFile
  if ($pidValue) {
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($process -and (Test-HttpOk "http://127.0.0.1:$shopPort/health/")) {
      Write-Host "Flask shop is already running: http://127.0.0.1:$shopPort"
      return
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }

  if (Test-PortListening -Port $shopPort) {
    throw "Port $shopPort is occupied by another process; Flask shop was not started."
  }

  $pythonPath = Join-Path $shopRoot ".venv\Scripts\python.exe"
  if (-not (Test-Path $pythonPath)) {
    throw "Shop Python interpreter not found: $pythonPath"
  }
  if (-not (Test-Path (Join-Path $shopRoot "run_dev_api.py"))) {
    throw "Shop development entrypoint not found: $(Join-Path $shopRoot 'run_dev_api.py')"
  }

  $resolvedHubToken = Get-EnvValue "DATA_HUB_TOKEN"
  if ([string]::IsNullOrWhiteSpace($resolvedHubToken)) {
    $resolvedHubToken = $hubToken
  }
  $resolvedShopToken = Get-EnvValue "COMMERCE_IMPORT_TOKEN"
  if ([string]::IsNullOrWhiteSpace($resolvedShopToken)) {
    $resolvedShopToken = $shopToken
  }
  $shopEnv = @{
    FLASK_CONFIG = "develop"
    FLASK_ENV = "develop"
    FLASK_HOST = "127.0.0.1"
    FLASK_PORT = "$shopPort"
    PYTHONUNBUFFERED = "1"
    INTEGRATION_TOKENS = "demo:$resolvedShopToken"
    DATA_HUB_URL = "http://127.0.0.1:$hubPort"
    DATA_HUB_TOKEN = $resolvedHubToken
    DATA_HUB_TENANT_SLUG = $hubTenant
  }

  $runScriptPath = Write-ShopRunScript -Environment $shopEnv
  if ([string]::IsNullOrWhiteSpace($runScriptPath)) {
    throw "Failed to build the run script path for the Flask shop."
  }
  # Same as start-local-stack.ps1: quote the spaced script path inside the argument
  # line, and keep this file ASCII-only because it has no BOM.
  $argumentLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $runScriptPath
  $proc = Start-Process powershell.exe `
    -ArgumentList $argumentLine `
    -WorkingDirectory $shopRoot `
    -RedirectStandardOutput (Join-Path $stateDir "flask-shop.out.log") `
    -RedirectStandardError (Join-Path $stateDir "flask-shop.err.log") `
    -PassThru `
    -WindowStyle Hidden

  Set-Content -Path $pidFile -Value $proc.Id
  if (-not (Wait-HttpOk "http://127.0.0.1:$shopPort/health/" 30)) {
    Stop-ProcessTree -ProcessId $proc.Id
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    throw "Flask shop failed to start. Check .local-stack\flask-shop.err.log and .local-stack\flask-shop.out.log"
  }
  Write-Host "Flask shop started: http://127.0.0.1:$shopPort"
}

function Stop-Shop {
  $pidFile = Join-Path $stateDir "flask-shop.pid"
  $pidValue = Get-PidFromFile $pidFile
  if ($pidValue) {
    Stop-ProcessTree -ProcessId $pidValue
  }

  if (-not (Wait-PortFree -Port $shopPort 10)) {
    $shopRootLower = $shopRoot.ToLowerInvariant()
    $candidates = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $command = ([string]$_.CommandLine).ToLowerInvariant()
      $command.Contains($shopRootLower) -and $command.Contains("run_dev_api.py")
    }
    foreach ($candidate in @($candidates)) {
      Stop-ProcessTree -ProcessId ([int]$candidate.ProcessId)
    }
  }

  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $stateDir "flask-shop-run.ps1") -Force -ErrorAction SilentlyContinue
  if (Test-PortListening -Port $shopPort) {
    Write-Warning "Flask shop port $shopPort is still occupied; unknown processes were not force-killed."
  } else {
    Write-Host "Flask shop stopped."
  }
}

function Get-ContentState {
  $stateFile = Join-Path $stateDir "state.json"
  if (Test-Path $stateFile) {
    return Get-Content $stateFile -Raw | ConvertFrom-Json
  }
  return $null
}

function Test-ContentStack([object]$State) {
  if ($null -eq $State -or $null -eq $State.urls) {
    return $false
  }
  return (
    (Test-HttpOk "$([string]$State.urls.api)/api/health") -and
    (Test-HttpOk "$([string]$State.urls.orchestrator)/health") -and
    (Test-HttpOk ([string]$State.urls.studio))
  )
}

function Test-ContentIntegrations {
  try {
    $state = Get-ContentState
    if ($null -eq $state -or [string]::IsNullOrWhiteSpace([string]$state.urls.api)) {
      return $false
    }
    $payload = Invoke-RestMethod -Uri "$([string]$state.urls.api)/api/health" -TimeoutSec 5
    return [bool]$payload.data.dataHubConfigured -and [bool]$payload.data.commercePushConfigured
  } catch {
    return $false
  }
}

function Start-Content([bool]$RequireIntegrations) {
  $state = Get-ContentState
  if (Test-ContentStack -State $state) {
    if (-not $RequireIntegrations -or (Test-ContentIntegrations)) {
      Write-Host "content services are already running."
      Write-Host "Studio: $([string]$state.urls.studio)"
      return
    }
    Write-Host "content services are missing full integration config; restarting to apply it..."
    & (Join-Path $scriptsDir "stop-local-stack.ps1")
  } elseif ($null -ne $state) {
    & (Join-Path $scriptsDir "stop-local-stack.ps1")
  }

  & (Join-Path $scriptsDir "start-local-stack.ps1")
}

function Show-Status {
  $contentState = Get-ContentState
  Write-Host "=== local services ==="
  if ($null -ne $contentState) {
    $api = [string]$contentState.urls.api
    $apiHealth = "$api/api/health"
    $orchestrator = "$([string]$contentState.urls.orchestrator)/health"
    $studio = [string]$contentState.urls.studio
    Write-Host ("content api          {0}  {1}" -f ($(if (Test-HttpOk $apiHealth) { "UP" } else { "DOWN" }), $api))
    Write-Host ("content orchestrator  {0}  {1}" -f ($(if (Test-HttpOk $orchestrator) { "UP" } else { "DOWN" }), $orchestrator))
    Write-Host ("content studio        {0}  {1}" -f ($(if (Test-HttpOk $studio) { "UP" } else { "DOWN" }), $studio))
  } else {
    Write-Host "content services      STOPPED"
  }

  $hubUrl = "http://127.0.0.1:$hubPort"
  $hubPid = Get-PidFromFile (Join-Path $stateDir "data-hub.pid")
  Write-Host ("data-hub             {0}  {1} pid={2}" -f ($(if (Test-HttpOk "$hubUrl/health") { "UP" } else { "DOWN" }), $hubUrl, $hubPid))

  $shopUrl = "http://127.0.0.1:$shopPort"
  $shopPid = Get-PidFromFile (Join-Path $stateDir "flask-shop.pid")
  Write-Host ("Flask shop           {0}  {1} pid={2}" -f ($(if (Test-HttpOk "$shopUrl/health/") { "UP" } else { "DOWN" }), $shopUrl, $shopPid))
}

if ($Profile -eq "stop") {
  & (Join-Path $scriptsDir "stop-local-stack.ps1")
  & (Join-Path $scriptsDir "stop-data-hub.ps1")
  Stop-Shop
  Remove-Item $extendedStateFile -Force -ErrorAction SilentlyContinue
  exit 0
}

if ($Profile -eq "status") {
  Show-Status
  exit 0
}

if ($Profile -eq "hub") {
  Start-Hub
  Save-ExtendedState
  exit 0
}

if ($Profile -eq "shop") {
  Start-Shop
  Save-ExtendedState
  exit 0
}

if ($Profile -eq "full") {
  $env:DATA_HUB_URL = "http://127.0.0.1:$hubPort"
  $env:DATA_HUB_TOKEN = if ((Get-EnvValue "DATA_HUB_TOKEN")) { Get-EnvValue "DATA_HUB_TOKEN" } else { $hubToken }
  $env:DATA_HUB_TENANT_SLUG = $hubTenant
  $env:COMMERCE_IMPORT_URL = "http://127.0.0.1:$shopPort/products/import-pack/integration/"
  $env:COMMERCE_IMPORT_TOKEN = if ((Get-EnvValue "COMMERCE_IMPORT_TOKEN")) { Get-EnvValue "COMMERCE_IMPORT_TOKEN" } else { $shopToken }
  $env:COMMERCE_TENANT_SLUG = $hubTenant
  Start-Hub
  Start-Shop
  Start-Content -RequireIntegrations $true
  Save-ExtendedState
  Write-Host "full profile started."
  exit 0
}

Start-Content -RequireIntegrations $false
Save-ExtendedState
Write-Host "content profile started."
