$ErrorActionPreference = "Stop"

$rootDir = Split-Path -Parent $PSScriptRoot

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command
  )

  Write-Host ""
  Write-Host "==> $Name"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed: $Name"
  }
}

Invoke-Step "python orchestrator tests" {
  Push-Location (Join-Path $rootDir "apps/ai-orchestrator")
  try {
    py -m unittest discover -s tests
  } finally {
    Pop-Location
  }
}

Invoke-Step "node service and ui tests" {
  Push-Location $rootDir
  try {
    node --test `
      apps/api-server/src/services/import-batch-service.test.js `
      apps/api-server/src/services/products-service.test.js `
      apps/api-server/src/services/content-job-service.test.js `
      apps/api-server/src/services/batch-item-event-service.test.js `
      apps/api-server/src/services/content-export-service.test.js `
      apps/api-server/src/services/creation-request-service.test.js `
      apps/api-server/src/services/task-event-service.test.js `
      apps/api-server/src/routes/batch-item-events.test.js `
      apps/studio-web/src/batch-api.test.js `
      apps/studio-web/src/batch-view-model.test.js `
      apps/studio-web/src/capabilities.test.js `
      scripts/local-stack-common.test.js `
      scripts/modelscope-video-probe.test.js
  } finally {
    Pop-Location
  }
}

Invoke-Step "studio web build" {
  Push-Location $rootDir
  try {
    npm --workspace apps/studio-web run build
  } finally {
    Pop-Location
  }
}

Invoke-Step "git ignore guard" {
  Push-Location $rootDir
  try {
    if (Test-Path ".git") {
      $ignoredPaths = @(
        "data/platform-db.json",
        "storage/generated/wf_b80bb3bc8b6a.png"
      )

      foreach ($path in $ignoredPaths) {
        git check-ignore -q $path
        if ($LASTEXITCODE -ne 0) {
          throw "Path is not ignored: $path"
        }
      }
    }
  } finally {
    Pop-Location
  }
}

Write-Host ""
Write-Host "MVP check passed."
