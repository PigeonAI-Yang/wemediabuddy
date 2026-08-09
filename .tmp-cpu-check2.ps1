$ErrorActionPreference = 'SilentlyContinue'

function Show-ProcDetail($namePattern) {
  Write-Host ("=== DETAIL: {0} ===" -f $namePattern)
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -match $namePattern } |
    Select-Object ProcessId, Name,
      @{N='WS_MB';E={[math]::Round($_.WorkingSetSize/1MB,1)}},
      @{N='Parent';E={$_.ParentProcessId}},
      @{N='Cmd';E={ if ($_.CommandLine) { if ($_.CommandLine.Length -gt 180) { $_.CommandLine.Substring(0,180) + '...' } else { $_.CommandLine } } else { '' } }} |
    Sort-Object WS_MB -Descending |
    Select-Object -First 40 |
    Format-Table -AutoSize -Wrap
}

Show-ProcDetail '^(XQNetwork|xqnetwork)'
Show-ProcDetail '^(electron|Electron)'
Show-ProcDetail '^(omp|node|node\.exe)'
Show-ProcDetail '^(explorer|Everything|Sogou|lghub|verge|mihomo|pylive|content-media|LiveHost|QQ|QQMusic|Inphic|wpscloud|SGTool)'

Write-Host '=== STARTUP / AUTORUN (HKCU+HKLM Run) ==='
$paths = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    Write-Host ("-- {0} --" -f $p)
    Get-ItemProperty $p |
      Select-Object * -ExcludeProperty PS* |
      Format-List
  }
}

Write-Host '=== EXPLORER MODULES (top unusual) ==='
$exp = Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exp) {
  $exp.Modules |
    Where-Object {
      $_.FileName -and
      $_.FileName -notmatch '\\Windows\\' -and
      $_.FileName -notmatch '\\WinSxS\\'
    } |
    Select-Object -ExpandProperty FileName -Unique |
    Sort-Object |
    Select-Object -First 80
}

Write-Host '=== GPU ENGINES rough (dwm/explorer/electron) ==='
Get-Process dwm, explorer, electron, XQNetwork, omp, msedge -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName,
    @{N='WS_MB';E={[math]::Round($_.WS/1MB,1)}},
    @{N='Handles';E={$_.Handles}},
    @{N='Threads';E={$_.Threads.Count}} |
  Sort-Object WS_MB -Descending |
  Format-Table -AutoSize

Write-Host '=== HANDLE/THREAD HOGS ==='
Get-Process |
  Sort-Object Handles -Descending |
  Select-Object -First 15 Id, ProcessName, Handles,
    @{N='Threads';E={$_.Threads.Count}},
    @{N='WS_MB';E={[math]::Round($_.WS/1MB,1)}} |
  Format-Table -AutoSize
