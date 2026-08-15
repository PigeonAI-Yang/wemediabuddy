$ErrorActionPreference = 'SilentlyContinue'

$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(msedge|msedgewebview2)\.exe$'
}

Write-Host ("TOTAL edge-family processes: {0}" -f $procs.Count)
Write-Host ("  msedge.exe: {0}" -f ($procs | Where-Object Name -eq 'msedge.exe').Count)
Write-Host ("  msedgewebview2.exe: {0}" -f ($procs | Where-Object Name -eq 'msedgewebview2.exe').Count)

function Get-Type($cmd) {
  if (-not $cmd) { return 'unknown' }
  if ($cmd -match '--type=([^\s]+)') { return $Matches[1] }
  if ($cmd -match 'msedge\.exe"?\s*$' -or $cmd -match 'msedge\.exe"$') { return 'browser-main' }
  if ($cmd -notmatch '--type=') { return 'browser-main-or-app' }
  return 'other'
}

function Get-Subtype($cmd) {
  if ($cmd -match '--utility-sub-type=([^\s]+)') { return $Matches[1] }
  if ($cmd -match '--extension-process') { return 'extension' }
  if ($cmd -match '--lang=') { return '' }
  return ''
}

function ShortCmd($cmd) {
  if (-not $cmd) { return '' }
  if ($cmd.Length -gt 220) { return $cmd.Substring(0,220) + '...' }
  return $cmd
}

Write-Host "`n=== BY PROCESS TYPE ==="
$procs |
  Select-Object ProcessId, Name,
    @{N='WS_MB';E={[math]::Round($_.WorkingSetSize/1MB,1)}},
    @{N='Type';E={Get-Type $_.CommandLine}},
    @{N='Sub';E={Get-Subtype $_.CommandLine}},
    ParentProcessId,
    @{N='Cmd';E={ShortCmd $_.CommandLine}} |
  Sort-Object Name, Type, WS_MB -Descending |
  Format-Table -AutoSize -Wrap

Write-Host "`n=== TYPE SUMMARY ==="
$procs |
  ForEach-Object {
    [pscustomobject]@{
      Name = $_.Name
      Type = (Get-Type $_.CommandLine)
      Sub  = (Get-Subtype $_.CommandLine)
      WS   = [math]::Round($_.WorkingSetSize/1MB,1)
    }
  } |
  Group-Object Name, Type, Sub |
  Select-Object @{N='Count';E={$_.Count}},
    @{N='Name';E={$_.Group[0].Name}},
    @{N='Type';E={$_.Group[0].Type}},
    @{N='Sub';E={$_.Group[0].Sub}},
    @{N='WS_MB';E={[math]::Round(($_.Group | Measure-Object WS -Sum).Sum,1)}} |
  Sort-Object WS_MB -Descending |
  Format-Table -AutoSize

Write-Host "`n=== EDGE WINDOWS / APP MODE HINTS ==="
$procs | ForEach-Object {
  $cmd = $_.CommandLine
  if ($cmd -match ' --app=| --edge-webview-id=| --extension-process|WebView|Widgets|SearchHost|GameAssist|Copilot|PWA|--profile-directory=') {
    [pscustomobject]@{
      Pid = $_.ProcessId
      WS_MB = [math]::Round($_.WorkingSetSize/1MB,1)
      Hint = if ($cmd -match '--app="?([^"\s]+)') { "app=$($Matches[1])" }
             elseif ($cmd -match '--profile-directory=([^\s]+)') { "profile=$($Matches[1])" }
             elseif ($cmd -match '--extension-process') { 'extension-process' }
             elseif ($cmd -match 'WebView') { 'webview' }
             else { 'special' }
      Cmd = ShortCmd $cmd
    }
  }
} | Sort-Object WS_MB -Descending | Format-Table -AutoSize -Wrap

Write-Host "`n=== OTHER APPS USING EDGE WEBVIEW2 ==="
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'msedgewebview2.exe' } |
  Select-Object ProcessId,
    @{N='WS_MB';E={[math]::Round($_.WorkingSetSize/1MB,1)}},
    ParentProcessId,
    @{N='ParentName';E={
      $p = Get-CimInstance Win32_Process -Filter ("ProcessId=$($_.ParentProcessId)")
      if ($p) { $p.Name } else { '?' }
    }},
    @{N='Cmd';E={ShortCmd $_.CommandLine}} |
  Sort-Object WS_MB -Descending |
  Format-Table -AutoSize -Wrap

Write-Host "`n=== EDGE MAIN PROCESS TREE ROOTS ==="
$mains = $procs | Where-Object { (Get-Type $_.CommandLine) -match 'browser-main' }
$mains | Select-Object ProcessId,
  @{N='WS_MB';E={[math]::Round($_.WorkingSetSize/1MB,1)}},
  @{N='Cmd';E={ShortCmd $_.CommandLine}} |
  Format-Table -AutoSize -Wrap
