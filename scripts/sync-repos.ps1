[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string[]]$RepoPaths = @(),

    [switch]$AllKnown,
    [switch]$Check,
    [switch]$DryRun,
    [string]$InitPrefix = ""
)

$ErrorActionPreference = "Stop"
$NodeArgs = @((Join-Path $PSScriptRoot "sync.mjs"))
if ($AllKnown) { $NodeArgs += "--all-known" }
if ($Check)    { $NodeArgs += "--check" }
if ($DryRun)   { $NodeArgs += "--dry-run" }
if ($InitPrefix) { $NodeArgs += @("--init-prefix", $InitPrefix) }
foreach ($p in $RepoPaths) { $NodeArgs += $p }

& node @NodeArgs
exit $LASTEXITCODE
