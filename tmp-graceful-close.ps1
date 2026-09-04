Get-Process WeMediaBuddy -ErrorAction SilentlyContinue | ForEach-Object {
  $r = $_.CloseMainWindow()
  Write-Host "CloseMainWindow $($_.Id) $r"
}
Start-Sleep -Seconds 4
Get-Process WeMediaBuddy -ErrorAction SilentlyContinue | Format-Table Id,Path,StartTime -AutoSize
