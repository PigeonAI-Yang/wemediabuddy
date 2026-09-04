Write-Host "Trying temp diagnostic while normal running"
$exe = "C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe"
$proc = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=9333" -PassThru
Write-Host "Started diag PID $($proc.Id)"
Start-Sleep -Seconds 5
Get-CimInstance Win32_Process -Filter "Name='WeMediaBuddy.exe'" | ForEach-Object { Write-Host "PID $($_.ProcessId) CMD $($_.CommandLine.Substring(0, [Math]::Min(350,$_.CommandLine.Length)))" }
Write-Host "Check port 9333"
try { Invoke-WebRequest -Uri "http://127.0.0.1:9333/json" -TimeoutSec 3 | Select-Object -ExpandProperty Content | Write-Host } catch { Write-Host "failed to fetch json: $_" }
