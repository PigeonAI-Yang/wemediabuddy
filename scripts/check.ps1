param([switch]$Full)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$requiredFiles = @(
    'AGENTS.md',
    'PRD.md',
    'SPEC.md',
    'PLAN.md',
    'TASKS.md',
    'TECHNICAL_DESIGN.md',
    'docs/ai-harness.md',
    'docs/architecture.md',
    'docs/development-workflow.md',
    'docs/verification.md',
    'docs/pi-operation-skill-maintenance.md',
    '.ai/evals/README.md'
)

Write-Host '> checking required harness files'
foreach ($relativePath in $requiredFiles) {
    $fullPath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Missing required file: $relativePath"
    }
}

Write-Host '> checking Pi operation Skill policy indexes'
$operatorSkillPolicy = 'docs/pi-operation-skill-maintenance.md'
foreach ($relativePath in @('AGENTS.md', 'docs/ai-harness.md', 'docs/development-workflow.md', 'docs/verification.md')) {
    $text = Get-Content -Raw -LiteralPath (Join-Path $projectRoot $relativePath)
    if ($text -notmatch [regex]::Escape($operatorSkillPolicy)) {
        throw "Missing Pi operation Skill policy index in: $relativePath"
    }
}

Write-Host '> checking renderer port anchor'
foreach ($relativePath in @('AGENTS.md', 'docs/development-workflow.md', 'docs/verification.md', 'vite.renderer.config.ts')) {
    $text = Get-Content -Raw -LiteralPath (Join-Path $projectRoot $relativePath)
    if ($text -notmatch '27391') {
        throw "Missing renderer port anchor 27391 in: $relativePath"
    }
}

Write-Host '> checking unresolved placeholders'
$placeholderPattern = '\b(T' + 'BD|T' + 'ODO)\b'
$projectFiles = git -C $projectRoot ls-files --cached --others --exclude-standard
if ($LASTEXITCODE -ne 0) { throw 'Unable to enumerate project files.' }
$placeholderExtensions = @('.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.html', '.ps1', '.yml', '.yaml')
$placeholderMatches = foreach ($relativePath in $projectFiles) {
    if ($relativePath -in @('TASKS.md', 'TASKS.archive.md') -or $relativePath -match '^(?:node_modules|out|\.git|\.ai|resources|data|tests)/') { continue }
    if ([IO.Path]::GetExtension($relativePath) -notin $placeholderExtensions) { continue }
    $fullPath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
    Select-String -LiteralPath $fullPath -Pattern $placeholderPattern -CaseSensitive
}
if ($placeholderMatches) {
    $placeholderMatches | ForEach-Object { Write-Host $_.Path ':' $_.LineNumber $_.Line }
    throw 'Unresolved placeholders found.'
}

Write-Host '> checking 500-line source limit'
$sourceExtensions = @('.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.scss', '.html', '.ps1')
$sourceFiles = $projectFiles
$legacySourceLineCaps = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'scripts/line-caps.json') | ConvertFrom-Json
$oversizedSources = foreach ($relativePath in $sourceFiles) {
    if ($relativePath -match '^(?:node_modules|out|\.git|\.ai|resources)/') { continue }
    if ([IO.Path]::GetExtension($relativePath) -notin $sourceExtensions) { continue }
    $fullPath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
    $lineCount = (Get-Content -LiteralPath $fullPath).Count
    $normalizedPath = $relativePath.Replace('\', '/')
    $legacyCap = $legacySourceLineCaps."$normalizedPath"
    if ($null -ne $legacyCap) {
        if ($lineCount -gt $legacyCap) {
            "$relativePath ($lineCount lines, cap $legacyCap)"
        }
        elseif ($lineCount -lt $legacyCap) {
            throw "Source file $relativePath has $lineCount lines, below its legacy cap $legacyCap; tighten scripts/line-caps.json to $lineCount (ratchet only moves down)."
        }
    }
    elseif ($lineCount -gt 500) {
        "$relativePath ($lineCount lines)"
    }
}
if ($oversizedSources) {
    $oversizedSources | ForEach-Object { Write-Host $_ }
    throw 'Source files exceed the 500-line project limit.'
}
node (Join-Path $projectRoot 'scripts/verify-prototype-split.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Prototype split verification failed.' }

Write-Host '> checking task ledger'
node (Join-Path $projectRoot 'scripts/check-ledger.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Task ledger check failed.' }

$packageJson = Join-Path $projectRoot 'package.json'
if ($Full -and (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
    Write-Host '> running full package verification'
    $package = Get-Content -Raw -LiteralPath $packageJson | ConvertFrom-Json
    foreach ($scriptName in @('typecheck', 'test', 'build')) {
        if (-not $package.scripts.$scriptName) {
            throw "package.json is missing required script: $scriptName"
        }
    }
    Push-Location $projectRoot
    try {
        npm run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'Package typecheck failed.' }
        npm test
        if ($LASTEXITCODE -ne 0) { throw 'Package tests failed.' }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Package build failed.' }
    }
    finally {
        Pop-Location
    }
}
elseif (-not $Full) {
    Write-Host '> lightweight check complete; package checks skipped by design'
}
else {
    Write-Host '> application scaffold not present'
}

Write-Host 'WMB harness checks passed.'
