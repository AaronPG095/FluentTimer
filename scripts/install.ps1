# AI-Dev-Workflow Installer. Delegate the managed bundle to the pinned sync engine.
param(
  [string]$Prefix = "PROJ",
  [string]$Upstream = "AaronPG095/AI-Dev-Workflow",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
if ($Upstream -notmatch '^[\w.-]+/[\w.-]+$') { throw "Upstream must be owner/repository" }
$release = $Branch
if ($release -notmatch '^[0-9a-f]{40}$') {
  $ref = [uri]::EscapeDataString($Branch)
  $release = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Upstream/commits/$ref" -UseBasicParsing -TimeoutSec 30).sha
  if ($release -notmatch '^[0-9a-f]{40}$') { throw "Invalid upstream SHA" }
}

$bootstrap = Join-Path ([IO.Path]::GetTempPath()) ("adw-sync-" + [guid]::NewGuid().ToString("N") + ".mjs")
try {
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$Upstream/$release/scripts/sync.mjs" -UseBasicParsing -TimeoutSec 30 -OutFile $bootstrap
  & node $bootstrap --remote --upstream $Upstream --branch $release --init-prefix $Prefix
  if ($LASTEXITCODE -ne 0) { throw "Workflow install failed with exit code $LASTEXITCODE" }
} finally {
  if (Test-Path -LiteralPath $bootstrap) { Remove-Item -LiteralPath $bootstrap }
}

if ((Get-Command git -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath ".git")) {
  $hookPath = & git rev-parse --git-path hooks/pre-push
  if ($LASTEXITCODE -ne 0) { throw "Unable to locate the Git pre-push hook" }
  if (-not (Test-Path -LiteralPath $hookPath)) {
    & node scripts/ticket.mjs hook install
    if ($LASTEXITCODE -ne 0) { throw "Unable to install the Git pre-push hook" }
  }
}
Write-Host "AI-Dev-Workflow successfully installed."
