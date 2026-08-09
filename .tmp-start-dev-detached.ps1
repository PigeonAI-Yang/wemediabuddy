$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$outLog = Join-Path $root '.wmb-dev.out.log'
$errLog = Join-Path $root '.wmb-dev.err.log'
'' | Set-Content -Path $outLog -Encoding utf8
'' | Set-Content -Path $errLog -Encoding utf8

# Ensure port free
$portBusy = netstat -ano | Select-String ':27391\s' | Select-Object -First 1
if ($portBusy) {
  Write-Output 'PORT_BUSY'
  Write-Output $portBusy.Line
  exit 2
}

$npmCmd = (Get-Command npm.cmd -ErrorAction Stop).Source
$proc = Start-Process -FilePath $npmCmd `
  -ArgumentList @('start') `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru

Write-Output ("STARTED pid=" + $proc.Id)
Write-Output ("cwd=" + $root)
Write-Output ("out=" + $outLog)
Write-Output ("err=" + $errLog)

# Wait up to ~90s for renderer identity
$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if ($proc.HasExited) {
    Write-Output ("EXITED code=" + $proc.ExitCode)
    if (Test-Path $errLog) { Get-Content $errLog -Tail 40 | ForEach-Object { Write-Output $_ } }
    if (Test-Path $outLog) { Get-Content $outLog -Tail 40 | ForEach-Object { Write-Output $_ } }
    exit 1
  }
  try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:27391/' -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -eq 200 -and $resp.Content -match '<title>WeMediaBuddy</title>' -and $resp.Content -match 'id=["'']root["'']') {
      $ready = $true
      break
    }
  } catch {
    # still booting
  }
}

if (-not $ready) {
  Write-Output 'TIMEOUT waiting for http://127.0.0.1:27391/'
  if (Test-Path $errLog) { Get-Content $errLog -Tail 60 | ForEach-Object { Write-Output $_ } }
  if (Test-Path $outLog) { Get-Content $outLog -Tail 60 | ForEach-Object { Write-Output $_ } }
  exit 1
}

Write-Output 'READY http://127.0.0.1:27391/'
Write-Output 'Detached from this shell; process keeps running after script ends.'
exit 0
