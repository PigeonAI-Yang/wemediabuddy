import os
import subprocess
import time
from pathlib import Path

ps = r"""
$ErrorActionPreference='SilentlyContinue'
Write-Host 'BEFORE:'
Get-Process XQNetwork,XQNetworkCore,XQNetworkHelperService -ErrorAction SilentlyContinue |
  Select-Object Id,ProcessName,CPU,@{N='WS_MB';E={[math]::Round($_.WS/1MB,1)}} |
  Format-Table -AutoSize | Out-String | Write-Host

Stop-Process -Name XQNetwork,XQNetworkCore -Force -ErrorAction SilentlyContinue
try { Stop-Service XQNetworkHelperService -Force -ErrorAction SilentlyContinue } catch {}
# also kill helper process if service stop didn't
Stop-Process -Name XQNetworkHelperService -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host 'AFTER:'
$left = Get-Process XQNetwork,XQNetworkCore,XQNetworkHelperService -ErrorAction SilentlyContinue
if ($left) {
  $left | Select-Object Id,ProcessName | Format-Table -AutoSize | Out-String | Write-Host
  Write-Host 'STILL_RUNNING'
} else {
  Write-Host 'XQ_STOPPED'
}

Write-Host 'PORTS:'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 7890,17890,17891 } |
  Select-Object LocalAddress,LocalPort,OwningProcess,
    @{N='Proc';E={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}} |
  Format-Table -AutoSize | Out-String | Write-Host

Write-Host 'CPU sample 3s top:'
$cpuCount = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$a=@{}; Get-Process | ForEach-Object { $a[$_.Id]=$_.CPU }
Start-Sleep -Seconds 3
Get-Process | ForEach-Object {
  if ($a.ContainsKey($_.Id)) {
    $d = $_.CPU - $a[$_.Id]
    if ($d -gt 0.05) {
      [pscustomobject]@{Id=$_.Id; Name=$_.ProcessName; CPU3s=[math]::Round($d,3); Pct=[math]::Round(($d/3/$cpuCount)*100,2); WS=[math]::Round($_.WS/1MB,1)}
    }
  }
} | Sort-Object CPU3s -Descending | Select-Object -First 12 | Format-Table -AutoSize | Out-String | Write-Host
"""
tmp = Path(os.environ["TEMP"]) / "stop-xqn.ps1"
tmp.write_text(ps, encoding="utf-8")
subprocess.check_call(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(tmp)])
