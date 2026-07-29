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
    '.ai/evals/README.md'
)

Write-Host '> checking required harness files'
foreach ($relativePath in $requiredFiles) {
    $fullPath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Missing required file: $relativePath"
    }
}

Write-Host '> checking unresolved placeholders'
$placeholderPattern = '\b(T' + 'BD|T' + 'ODO)\b'
$placeholderMatches = Get-ChildItem -LiteralPath $projectRoot -File -Recurse |
    Where-Object { $_.FullName -notmatch '[\\/](?:\.git|node_modules|out|\.vite)[\\/]' } |
    Where-Object { $_.Extension -in @('.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.html', '.ps1', '.yml', '.yaml') } |
    Select-String -Pattern $placeholderPattern -CaseSensitive
if ($placeholderMatches) {
    $placeholderMatches | ForEach-Object { Write-Host $_.Path ':' $_.LineNumber $_.Line }
    throw 'Unresolved placeholders found.'
}

Write-Host '> checking 500-line source limit'
$sourceExtensions = @('.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.scss', '.html', '.ps1')
$sourceFiles = git -C $projectRoot ls-files --cached --others --exclude-standard
if ($LASTEXITCODE -ne 0) { throw 'Unable to enumerate project source files.' }
$oversizedSources = foreach ($relativePath in $sourceFiles) {
    if ($relativePath -match '^(?:node_modules|out|\.git|\.ai|resources)/') { continue }
    if ([IO.Path]::GetExtension($relativePath) -notin $sourceExtensions) { continue }
    $fullPath = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
    $lineCount = (Get-Content -LiteralPath $fullPath).Count
    if ($lineCount -gt 500) { "$relativePath ($lineCount lines)" }
}
if ($oversizedSources) {
    $oversizedSources | ForEach-Object { Write-Host $_ }
    throw 'Source files exceed the 500-line project limit.'
}
node (Join-Path $projectRoot 'scripts/verify-prototype-split.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Prototype split verification failed.' }

Write-Host '> checking task traceability'
$prdText = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'PRD.md')
$specText = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'SPEC.md')
$planText = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'PLAN.md')
$tasksText = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'TASKS.md')
$capabilityIds = [regex]::Matches($specText, '\bCAP-\d{3}\b') |
    ForEach-Object { $_.Value } |
    Sort-Object -Unique
foreach ($capabilityId in $capabilityIds) {
    if ($planText -notmatch [regex]::Escape($capabilityId)) {
        throw "Capability has no plan mapping: $capabilityId"
    }
    if ($tasksText -notmatch [regex]::Escape($capabilityId)) {
        throw "Capability has no task mapping: $capabilityId"
    }
}

$requirementIds = [regex]::Matches($specText, '\b(?:REQ|AC)-\d{3}\b') |
    ForEach-Object { $_.Value } |
    Sort-Object -Unique
foreach ($requirementId in $requirementIds) {
    if ($prdText -notmatch [regex]::Escape($requirementId)) {
        throw "SPEC references unknown PRD requirement: $requirementId"
    }
}

$taskRows = Get-Content -LiteralPath (Join-Path $projectRoot 'TASKS.md') |
    Where-Object { $_ -match '^\|\s*WMB-\d{4}\s*\|' }
$taskIds = $taskRows |
    ForEach-Object { ([regex]::Match($_, 'WMB-\d{4}')).Value }
$doingCount = 0
foreach ($taskRow in $taskRows) {
    $cells = $taskRow.Trim('|').Split('|') | ForEach-Object { $_.Trim() }
    if ($cells.Count -ne 8) {
        throw "Invalid task row: $taskRow"
    }
    $status = $cells[3]
    if ($status -notin @('todo', 'doing', 'blocked', 'done')) {
        throw "Invalid task status '$status' in $($cells[0])"
    }
    if ($status -eq 'doing') {
        $doingCount++
    }
    if ($status -eq 'done' -and (
        [string]::IsNullOrWhiteSpace($cells[5]) -or
        [string]::IsNullOrWhiteSpace($cells[6])
    )) {
        throw "Done task lacks deliverable or evidence: $($cells[0])"
    }
    $dependencies = [regex]::Matches($cells[4], 'WMB-\d{4}') |
        ForEach-Object { $_.Value }
    foreach ($dependency in $dependencies) {
        if ($dependency -notin $taskIds) {
            throw "Unknown dependency $dependency in $($cells[0])"
        }
    }
}
if ($doingCount -gt 1) {
    throw 'More than one task is doing.'
}

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
