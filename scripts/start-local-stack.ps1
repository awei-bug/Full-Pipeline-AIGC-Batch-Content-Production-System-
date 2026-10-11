$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $rootDir ".local-stack"
$stateFile = Join-Path $stateDir "state.json"

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
. (Join-Path $PSScriptRoot "local-stack-common.ps1")

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

function Set-SecretEnvironment {
  param(
    [hashtable]$Environment,
    [string[]]$Names
  )

  foreach ($name in $Names) {
    $value = Get-EnvValue $name
    if (-not [string]::IsNullOrWhiteSpace($value)) {
      $Environment[$name] = $value
    }
  }
}

function New-RunScript(
  [string]$name,
  [string]$workingDir,
  [string]$filePath,
  [string[]]$arguments,
  [hashtable]$environment,
  [string[]]$secretEnvNames
) {
  $runScriptPath = Join-Path $stateDir ("{0}-run.ps1" -f $name)
  $scriptLines = @(
    '$ErrorActionPreference = "Stop"',
    'function Get-EnvValue([string]$name) {',
    '  foreach ($scope in @("Process", "User", "Machine")) {',
    '    $value = [Environment]::GetEnvironmentVariable($name, $scope)',
    '    if (-not [string]::IsNullOrWhiteSpace($value)) {',
    '      return $value',
    '    }',
    '  }',
    '  return $null',
    '}',
    ("Set-Location '{0}'" -f $workingDir.Replace("'", "''"))
  )

  foreach ($key in $environment.Keys) {
    $value = [string]$environment[$key]
    $scriptLines += ("`$env:{0} = '{1}'" -f $key, $value.Replace("'", "''"))
  }

  foreach ($secretName in $secretEnvNames) {
    $escapedSecretName = $secretName.Replace("'", "''")
    $scriptLines += ("`$resolvedValue = Get-EnvValue '{0}'" -f $escapedSecretName)
    $scriptLines += "if (-not [string]::IsNullOrWhiteSpace(`$resolvedValue)) {"
    $scriptLines += ("  `$env:{0} = `$resolvedValue" -f $secretName)
    $scriptLines += "}"
  }

  $joinedArguments = @($arguments | ForEach-Object { "'{0}'" -f $_.Replace("'", "''") }) -join ", "
  $scriptLines += ("& '{0}' @({1})" -f $filePath.Replace("'", "''"), $joinedArguments)

  Set-Content -Path $runScriptPath -Encoding UTF8 -Value ($scriptLines -join "`r`n")
  return $runScriptPath
}

function Start-StackProcess(
  [string]$name,
  [string]$workingDir,
  [string]$filePath,
  [string[]]$arguments,
  [hashtable]$environment,
  [string[]]$secretEnvNames,
  [string]$stdoutLog,
  [string]$stderrLog
) {
  $runScriptPath = New-RunScript `
    -name $name `
    -workingDir $workingDir `
    -filePath $filePath `
    -arguments $arguments `
    -environment $environment `
    -secretEnvNames $secretEnvNames

  if ([string]::IsNullOrWhiteSpace($runScriptPath)) {
    throw "Failed to build the run script path for $name."
  }

  # Keep this file ASCII-only: it has no BOM and PowerShell 5.1 decodes non-ASCII
  # bytes as ANSI. Start-Process joins -ArgumentList with spaces and adds no quotes,
  # and this repo root path contains a space, so the script path must be quoted here
  # or it gets truncated before the ".ps1" extension and the child exits immediately.
  $argumentLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $runScriptPath
  return Start-Process powershell.exe `
    -ArgumentList $argumentLine `
    -WorkingDirectory $workingDir `
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

function Remove-LegacyRunScripts() {
  Get-ChildItem -Path $stateDir -Filter "*-run.ps1" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

if (Test-Path $stateFile) {
  $state = Get-LocalStackState -StateFile $stateFile
  if ($null -ne $state) {
    $runtime = Get-LocalStackRuntimeState -State $state
    if ($runtime.runningProcesses.Count -gt 0 -or $runtime.occupiedPorts.Count -gt 0) {
      $runningNames = @($runtime.runningProcesses | ForEach-Object { $_.name })
      $runningPorts = @($runtime.occupiedPorts | ForEach-Object { "$_" })
      $details = @($runningNames + $runningPorts) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
      throw "Local stack is already running: $($details -join ', '). Run npm run stack:stop first."
    }

    Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
  }
}

$agnesToken = Get-EnvValue "AGNES_API_KEY"
$modelscopeToken = Get-EnvValue "MODELSCOPE_API_TOKEN"
$openaiToken = Get-EnvValue "OPENAI_API_KEY"

$textProvider = if ($agnesToken) { "agnes" } else { "modelscope" }
$imageProvider = if ($agnesToken) { "agnes" } else { "modelscope" }
$videoProvider = if ($agnesToken) { "agnes" } elseif ($openaiToken) { "openai" } else { "modelscope" }
$videoEnabled = if ($agnesToken -or $openaiToken) { "true" } else { "false" }

if (-not $agnesToken -and -not $modelscopeToken) {
  throw "Neither AGNES_API_KEY nor MODELSCOPE_API_TOKEN was found in Process/User/Machine environment."
}

$apiPort = Get-FreePort 3100
$orchestratorPort = Get-FreePort 8110
$studioPort = Get-FreePort 5201

$apiBaseUrl = "http://127.0.0.1:$apiPort"
$orchestratorBaseUrl = "http://127.0.0.1:$orchestratorPort"
$assetsDir = Join-Path $rootDir "storage/generated"

$internalCallbackToken = Get-EnvValue "INTERNAL_CALLBACK_TOKEN"
if ([string]::IsNullOrWhiteSpace($internalCallbackToken)) {
  $internalCallbackToken = "local-dev-internal-token"
}

$apiEnv = @{
  API_PORT = "$apiPort"
  API_HOST = "127.0.0.1"
  AI_ORCHESTRATOR_BASE_URL = $orchestratorBaseUrl
  AI_ORCHESTRATOR_ASSETS_DIR = $assetsDir
  INTERNAL_CALLBACK_TOKEN = $internalCallbackToken
}
$forwardedIntegrationEnvNames = @(
  "DATA_HUB_URL",
  "DATA_HUB_TENANT_SLUG",
  "DATA_HUB_TIMEOUT_MS",
  "COMMERCE_IMPORT_URL",
  "COMMERCE_TENANT_SLUG",
  "COMMERCE_IMPORT_TIMEOUT_MS"
)
foreach ($integrationKey in $forwardedIntegrationEnvNames) {
  $integrationValue = Get-EnvValue $integrationKey
  if (-not [string]::IsNullOrWhiteSpace($integrationValue)) {
    $apiEnv[$integrationKey] = $integrationValue
  }
}
$forwardedDbEnvNames = @("PGHOST", "PGPORT", "PGUSER", "PGDATABASE", "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_USER", "POSTGRES_DB")
foreach ($dbKey in $forwardedDbEnvNames) {
  $dbValue = Get-EnvValue $dbKey
  if (-not [string]::IsNullOrWhiteSpace($dbValue)) {
    $apiEnv[$dbKey] = $dbValue
  }
}

$orchestratorEnv = @{
  API_SERVER_BASE_URL = $apiBaseUrl
  AI_ORCHESTRATOR_ASSETS_DIR = $assetsDir
  AI_TEXT_PROVIDER = $textProvider
  AI_IMAGE_PROVIDER = $imageProvider
  AI_VIDEO_PROVIDER = $videoProvider
  INTERNAL_CALLBACK_TOKEN = $internalCallbackToken
  PYTHONUTF8 = "1"
}

$secretEnvNames = @(
  "AGNES_API_KEY",
  "MODELSCOPE_API_TOKEN",
  "OPENAI_API_KEY",
  "DATABASE_URL",
  "PGPASSWORD",
  "POSTGRES_PASSWORD",
  "INTERNAL_CALLBACK_TOKEN",
  "DATA_HUB_TOKEN",
  "COMMERCE_IMPORT_TOKEN"
)

$studioEnv = @{
  VITE_API_BASE_URL = $apiBaseUrl
  VITE_ENABLE_VIDEO_GENERATION = $videoEnabled
}

$apiProc = Start-StackProcess `
  -name "api-server" `
  -workingDir (Join-Path $rootDir "apps/api-server") `
  -filePath "node" `
  -arguments @("src/server.js") `
  -environment $apiEnv `
  -secretEnvNames $secretEnvNames `
  -stdoutLog (Join-Path $stateDir "api-server.out.log") `
  -stderrLog (Join-Path $stateDir "api-server.err.log")

$orchestratorProc = Start-StackProcess `
  -name "ai-orchestrator" `
  -workingDir (Join-Path $rootDir "apps/ai-orchestrator") `
  -filePath "py" `
  -arguments @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$orchestratorPort") `
  -environment $orchestratorEnv `
  -secretEnvNames $secretEnvNames `
  -stdoutLog (Join-Path $stateDir "ai-orchestrator.out.log") `
  -stderrLog (Join-Path $stateDir "ai-orchestrator.err.log")

$studioEnv = @{
  VITE_API_BASE_URL = $apiBaseUrl
  VITE_ENABLE_VIDEO_GENERATION = $videoEnabled
}

$studioProc = Start-StackProcess `
  -name "studio-web" `
  -workingDir (Join-Path $rootDir "apps/studio-web") `
  -filePath "npm.cmd" `
  -arguments @("run", "dev", "--", "--host", "127.0.0.1", "--port", "$studioPort", "--strictPort") `
  -environment $studioEnv `
  -secretEnvNames $secretEnvNames `
  -stdoutLog (Join-Path $stateDir "studio-web.out.log") `
  -stderrLog (Join-Path $stateDir "studio-web.err.log")

if (-not (Wait-HttpOk "$orchestratorBaseUrl/health" 30)) {
  throw "ai-orchestrator failed to start. Check .local-stack\ai-orchestrator.err.log"
}

if (-not (Wait-HttpOk "$apiBaseUrl/api/health" 30)) {
  throw "api-server failed to start. Check .local-stack\api-server.err.log"
}

if (-not (Wait-HttpOk "http://127.0.0.1:$studioPort" 30)) {
  throw "studio-web failed to start. Check .local-stack\studio-web.err.log"
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
