$w = New-Object -ComObject WScript.Shell
$ok = $false
foreach ($title in @('WeMediaBuddy', 'WeMedia Buddy', 'Electron')) {
  if ($w.AppActivate($title)) {
    $ok = $true
    break
  }
}
Start-Sleep -Milliseconds 400
if (-not $ok) {
  Write-Output 'notfound'
  exit 1
}
# Ctrl+0 resets page zoom in Chromium/Electron
$w.SendKeys('^0')
Write-Output 'sent-ctrl-0'
