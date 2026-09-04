Write-Host "checking processes"
Get-Process WeMediaBuddy -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "PID $($_.Id) $($_.Path) HasMainWindow $($_.MainWindowHandle)" }
Write-Host "CIM"
Get-CimInstance Win32_Process -Filter "Name='WeMediaBuddy.exe'" | ForEach-Object { Write-Host "PID $($_.ProcessId) CMD $($_.CommandLine.Substring(0, [Math]::Min(200,$_.CommandLine.Length)))"}
