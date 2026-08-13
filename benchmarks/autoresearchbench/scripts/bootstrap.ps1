param(
    [string]$Ref = "main",
    [switch]$SkipData
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$BenchmarkRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$CacheRoot = Join-Path $BenchmarkRoot ".cache"
$OfficialRoot = Join-Path $CacheRoot "AutoResearchBench"
$VenvRoot = Join-Path $CacheRoot "venv"
$Python = Join-Path $VenvRoot "Scripts\python.exe"

New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
if (-not (Test-Path -LiteralPath $OfficialRoot)) {
    git clone --depth 1 --branch $Ref https://github.com/CherYou/AutoResearchBench.git $OfficialRoot
}

if (-not (Test-Path -LiteralPath $Python)) {
    py -3 -m venv $VenvRoot
}

& $Python -m pip install --upgrade pip
& $Python -m pip install -r (Join-Path $OfficialRoot "requirements.txt")

if (-not $SkipData) {
    $InputRoot = Join-Path $OfficialRoot "input_data"
    $Bundle = Join-Path $InputRoot "AutoResearchBench.jsonl.obf.json"
    $Plaintext = Join-Path $InputRoot "AutoResearchBench.jsonl"
    New-Item -ItemType Directory -Force -Path $InputRoot | Out-Null
    if (-not (Test-Path -LiteralPath $Bundle)) {
        Invoke-WebRequest `
            -Uri "https://huggingface.co/datasets/Lk123/AutoResearchBench/resolve/main/AutoResearchBench.jsonl.obf.json" `
            -OutFile $Bundle
    }
    if (-not (Test-Path -LiteralPath $Plaintext)) {
        & $Python (Join-Path $OfficialRoot "decrypt_benchmark.py") `
            --input-file $Bundle `
            --output-file $Plaintext
    }
}

$Commit = git -C $OfficialRoot rev-parse HEAD
Write-Host "Official AutoResearchBench ready at $OfficialRoot"
Write-Host "Pinned checkout commit: $Commit"
Write-Host "Python: $Python"

