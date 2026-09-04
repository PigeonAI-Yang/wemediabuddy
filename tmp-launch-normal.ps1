Write-Host "=== Launching normal app ==="
$exe = "C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/WeMediaBuddy.exe"
Write-Host "Launching $exe without args"
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "Started PID $($proc.Id) Path $($proc.Path)"

Start-Sleep -Seconds 6

Write-Host "=== Processes after launch ==="
Get-Process WeMediaBuddy -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "PID $($_.Id) Path $($_.Path) Start $($_.StartTime)" }
Get-CimInstance Win32_Process -Filter "Name='WeMediaBuddy.exe'" | ForEach-Object {
  $cmd = $_.CommandLine
  $hasDebug = $cmd -like "*remote-debugging*"
  Write-Host "PID $($_.ProcessId) hasDebug $hasDebug CMD $($cmd.Substring(0, [Math]::Min(300, $cmd.Length)))"
}
