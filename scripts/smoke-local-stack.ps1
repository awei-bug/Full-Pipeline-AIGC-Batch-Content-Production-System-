param(
  [ValidateSet("text_to_image", "text_to_video")]
  [string]$RequestType = "text_to_image"
)

$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $rootDir ".local-stack"
$stateFile = Join-Path $stateDir "state.json"

if (-not (Test-Path $stateFile)) {
  throw "Local stack is not running. Run npm run stack:start first."
}

$state = Get-Content $stateFile | ConvertFrom-Json
$apiBaseUrl = $state.urls.api

$requestConfig = if ($RequestType -eq "text_to_video") {
  @{
    prompt = "Create a short cinematic night city shot with smooth motion and a clear focal subject."
    styleCode = "cinematic"
    aspectRatio = "16:9"
    timeoutMinutes = 30
  }
} else {
  @{
    prompt = "Create a cinematic poster with dramatic lighting and a clear subject."
    styleCode = "cinematic"
    aspectRatio = "9:16"
    timeoutMinutes = 5
  }
}

function Invoke-Json([string]$method, [string]$url, $body = $null) {
  $params = @{
    Method = $method
    Uri = $url
    ContentType = "application/json"
  }
  if ($null -ne $body) {
    $params.Body = ($body | ConvertTo-Json -Depth 8 -Compress)
  }
  return Invoke-RestMethod @params
}

$projectName = "SmokeProject-" + (Get-Date -Format "yyyyMMddHHmmss")
$project = Invoke-Json "Post" "$apiBaseUrl/api/projects" @{
  name = $projectName
  description = "Local smoke run"
}

$creation = Invoke-Json "Post" "$apiBaseUrl/api/creation-requests" @{
  projectId = $project.data.id
  prompt = $requestConfig.prompt
  requestType = $RequestType
  styleCode = $requestConfig.styleCode
  aspectRatio = $requestConfig.aspectRatio
}

$taskId = $creation.data.taskId
$deadline = (Get-Date).AddMinutes($requestConfig.timeoutMinutes)
$task = $null

do {
  Start-Sleep -Seconds 5
  $task = Invoke-Json "Get" "$apiBaseUrl/api/tasks/$taskId"
  if ($task.data.status -in @("success", "failed")) {
    break
  }
} while ((Get-Date) -lt $deadline)

if (-not $task) {
  throw "Task status could not be fetched."
}

if ($task.data.status -ne "success") {
  throw "Task did not finish successfully. Status: $($task.data.status). Error: $($task.data.errorMessage)"
}

$works = Invoke-Json "Get" "$apiBaseUrl/api/works?projectId=$($project.data.id)"
$matchedWork = $works.data.items | Where-Object {
  $_.latestVersion.generationTaskId -eq $taskId
} | Select-Object -First 1

if (-not $matchedWork) {
  throw "Task succeeded but matching work was not found."
}

[ordered]@{
  requestType = $RequestType
  projectId = $project.data.id
  taskId = $taskId
  taskStatus = $task.data.status
  workId = $matchedWork.id
  assetCount = @($matchedWork.assets).Count
  firstAssetPublicUrl = if (@($matchedWork.assets).Count -gt 0) { $matchedWork.assets[0].metadata.publicUrl } else { $null }
} | ConvertTo-Json -Depth 6
