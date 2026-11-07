<#
.SYNOPSIS
  One-line AI-Dev-Workflow installer and bootstrapper for any machine.
.DESCRIPTION
  Downloads the canonical, token-lean AI-Dev-Workflow engine files from GitHub
  into the current repository, sets up starter configuration, and installs git safety hooks.
.EXAMPLE
  irm https://raw.githubusercontent.com/AaronPG095/AI-Dev-Workflow/main/scripts/install.ps1 | iex
  # or with parameters:
  & .\scripts\install.ps1 -Prefix MYP
#>
param(
  [string]$Prefix = "PROJ",
  [string]$Upstream = "AaronPG095/AI-Dev-Workflow",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "   AI-Dev-Workflow Installer (Multi-Machine)     " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "Target directory: $(Get-Location)"
Write-Host "Project prefix:   $Prefix"
Write-Host "Upstream source:  $Upstream ($Branch)"
Write-Host ""

$baseUrl = "https://raw.githubusercontent.com/$Upstream/$Branch"

$files = @(
  "scripts/ticket.mjs",
  "scripts/ticket.test.mjs",
  "scripts/sync.mjs",
  "docs/plans/_template.plan.md",
  ".agents/skills/dev-workflow/SKILL.md",
  ".agents/skills/quick-review/SKILL.md",
  ".claude/skills/dev-workflow/SKILL.md",
  ".claude/skills/quick-review/SKILL.md",
  ".github/workflows/plan-check.yml",
  ".github/workflows/ticket-done.yml",
  ".github/workflows/workflow-sync.yml",
  ".github/pull_request_template.md"
)

foreach ($file in $files) {
  $dest = Join-Path (Get-Location) $file
  $parent = Split-Path $dest -Parent
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $url = "$baseUrl/$file"
  Write-Host "  -> Fetching $file..." -ForegroundColor Gray
  try {
    $content = (Invoke-RestMethod -Uri $url -Method Get -UseBasicParsing)
    if ($file -like "*dev-workflow*") {
      $content = $content.Replace("ADW-Plan-", "$Prefix-Plan-")
    }
    Set-Content -Path $dest -Value $content -NoNewline
  } catch {
    Write-Warning "Could not fetch $file: $_"
  }
}

$cfgPath = Join-Path (Get-Location) "scripts/ticket.config.json"
if (-not (Test-Path $cfgPath)) {
  $starterConfig = @"
{
  "prefix": "$Prefix",
  "tracker": "local",
  "timeZone": "Europe/Berlin",
  "plansDir": "docs/plans",
  "protectedBranches": ["main"],
  "captureSources": ["Claude", "Codex", "Gemini", "ChatGPT", "Notion AI", "Other"],
  "verifyCommand": "npm test",
  "requireReview": false,
  "noPlan": {
    "maxChangedLines": 40,
    "noNewFilesUnder": ["src"]
  }
}
"@
  Set-Content -Path $cfgPath -Value $starterConfig
  Write-Host "  -> Created scripts/ticket.config.json (Prefix: $Prefix)" -ForegroundColor Green
}

if (Test-Path ".git") {
  Write-Host "  -> Installing pre-push guardrail hook..." -ForegroundColor Gray
  try {
    node scripts/ticket.mjs hook install
  } catch {
    Write-Warning "Could not run hook installer: $_"
  }
}

Write-Host ""
Write-Host "AI-Dev-Workflow successfully installed!" -ForegroundColor Green
Write-Host "Start by creating a plan: node scripts/ticket.mjs new <Topic> [--branch]" -ForegroundColor Cyan
