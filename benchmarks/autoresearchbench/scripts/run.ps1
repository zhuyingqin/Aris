param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile,
    [int]$Limit = 1,
    [int]$Passes = 1,
    [int]$MaxToolCalls = 10,
    [ValidateSet("literature", "web", "hybrid")]
    [string]$ToolProfile = "hybrid",
    [ValidateSet("auto", "deep", "wide")]
    [string]$Task = "auto",
    [string]$OutputFile = "",
    [switch]$Reviewer,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$BenchmarkRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Manifest = Join-Path $BenchmarkRoot "Cargo.toml"
$Arguments = @(
    "run", "--release", "--manifest-path", $Manifest, "--",
    "--input", (Resolve-Path $InputFile).Path,
    "--limit", $Limit,
    "--passes", $Passes,
    "--max-tool-calls", $MaxToolCalls,
    "--tool-profile", $ToolProfile
)
if ($OutputFile) {
    $Arguments += @("--output", $OutputFile)
}
if ($Reviewer) {
    $Arguments += "--reviewer"
}
if ($Task -ne "auto") {
    $Arguments += @("--only-task-type", $Task)
}
if ($DryRun) {
    $Arguments += "--dry-run"
}

& cargo @Arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
