param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile,
    [Parameter(Mandatory = $true)]
    [ValidateSet("deep", "wide")]
    [string]$Task,
    [string]$GroundTruthFile = "",
    [string]$OutputFile = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$BenchmarkRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OfficialRoot = Join-Path $BenchmarkRoot ".cache\AutoResearchBench"
$Python = Join-Path $BenchmarkRoot ".cache\venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python) -or -not (Test-Path -LiteralPath $OfficialRoot)) {
    throw "Run scripts/bootstrap.ps1 first."
}

$ResolvedInput = (Resolve-Path $InputFile).Path
if ($Task -eq "deep") {
    $Script = Join-Path $OfficialRoot "evaluate\evaluate_deep_search.py"
    $Arguments = @($Script, "--input-file", $ResolvedInput)
} else {
    $Script = Join-Path $OfficialRoot "evaluate\evaluate_wide_search.py"
    $Arguments = @($Script, "--input-file", $ResolvedInput)
    if ($GroundTruthFile) {
        $Arguments += @("--gt-file", (Resolve-Path $GroundTruthFile).Path)
    }
}
if ($OutputFile) {
    $Arguments += @("--output-file", $OutputFile)
}

& $Python @Arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

