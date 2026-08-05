# Installs the repo-local git hooks directory (scripts/git-hooks) via core.hooksPath.
# Idempotent: running repeatedly yields the same result.
$ErrorActionPreference = 'Stop'

$hooksPath = 'scripts/git-hooks'

& git config core.hooksPath $hooksPath
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: 'git config core.hooksPath $hooksPath' failed (exit $LASTEXITCODE)"
    exit 1
}

$readBack = (& git config core.hooksPath)
if ($readBack -eq $hooksPath) {
    Write-Host "OK: core.hooksPath = $readBack"
    exit 0
}

Write-Host "ERROR: read-back mismatch; got '$readBack'"
exit 1
