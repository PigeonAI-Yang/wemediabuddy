Get-Process WeMediaBuddy -ErrorAction SilentlyContinue | ForEach-Object {
  $r = $_.CloseMainWindow()
  Write-Host "CloseMainWindow $($_.Id) $r"
}
Start-Sleep -Seconds 3
$still = Get-Process WeMediaBuddy -ErrorAction SilentlyContinue
if ($still) {
  Write-Host "Still running, waiting 2 more seconds"
  Start-Sleep -Seconds 3
  $still = Get-Process WeMediaBuddy -ErrorAction SilentlyContinue
  if ($still) {
    Write-Host "Forcing kill"
    $still | Stop-Process -Force
  }
}
Start-Sleep -Seconds 2
Get-Process WeMediaBuddy -ErrorAction SilentlyContinue | Format-Table Id,Path -AutoSize
if (-not (Get-Process WeMediaBuddy -ErrorAction SilentlyContinue)) { Write-Host "All stopped gracefully" }
