$ErrorActionPreference = 'Continue'
$port = 27391
$pids = @()
$net = netstat -ano | Select-String ":$port\s"
foreach ($line in $net) {
  if ($line -match '\s(\d+)\s*$') { $pids += [int]$Matches[1] }
}
$pids = $pids | Where-Object { $_ -gt 0 } | Select-Object -Unique
Write-Host "Port $port pids: $($pids -join ',')"

function Get-Tree([int]$processId) {
  $all = @($processId)
  $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $processId }
  foreach ($c in $children) { $all += Get-Tree $c.ProcessId }
  return $all
}

$kill = @()
foreach ($procId in $pids) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $procId"
    if ($p) {
      Write-Host "ROOT $procId $($p.Name) :: $($p.CommandLine)"
      $kill += Get-Tree $procId
      $cur = $p
      for ($i=0; $i -lt 8; $i++) {
        if (-not $cur.ParentProcessId) { break }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($cur.ParentProcessId)"
        if (-not $parent) { break }
        $cmd = [string]$parent.CommandLine
        if ($cmd -match 'WeMediaBuddy|electron-forge|electron\.exe|vite') {
          Write-Host "PARENT $($parent.ProcessId) $($parent.Name)"
          $kill += Get-Tree $parent.ProcessId
          $cur = $parent
        } else { break }
      }
    }
  } catch {}
}

$extra = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and ($_.CommandLine -match 'WeMediaBuddy') -and ($_.CommandLine -match 'electron|forge|vite')
}
foreach ($e in $extra) {
  Write-Host "MATCH $($e.ProcessId) $($e.Name)"
  $kill += $e.ProcessId
}

$kill = $kill | Select-Object -Unique | Sort-Object -Descending
Write-Host "Killing: $($kill -join ',')"
foreach ($procId in $kill) {
  try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
}

Start-Sleep -Seconds 2
$left = netstat -ano | Select-String ":$port\s+.*LISTENING"
if ($left) { Write-Host "PORT STILL BUSY: $left"; exit 2 }
Write-Host "Port free"

$logOut = 'j:\PigeonYang\WeMediaBuddy\.wmb-dev.out.log'
$logErr = 'j:\PigeonYang\WeMediaBuddy\.wmb-dev.err.log'
if (Test-Path $logOut) { Clear-Content $logOut -ErrorAction SilentlyContinue }
if (Test-Path $logErr) { Clear-Content $logErr -ErrorAction SilentlyContinue }

$cwd = 'j:\PigeonYang\WeMediaBuddy'
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm start > .wmb-dev.out.log 2> .wmb-dev.err.log' -WorkingDirectory $cwd -WindowStyle Hidden -PassThru
Write-Host "Started launcher pid=$($proc.Id)"

$ok = $false
for ($i=0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 2
  $listen = netstat -ano | Select-String ":$port\s+.*LISTENING"
  if ($listen) { Write-Host "READY: $listen"; $ok = $true; break }
}
if (-not $ok) {
  Write-Host 'NOT READY'
  if (Test-Path $logErr) { Get-Content $logErr -Tail 40 }
  if (Test-Path $logOut) { Get-Content $logOut -Tail 40 }
  exit 1
}
Write-Host 'WMB restarted'
exit 0
