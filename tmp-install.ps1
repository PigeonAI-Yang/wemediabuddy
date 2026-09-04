Write-Host "=== Before installer ==="
Write-Host "Installer file:"
Get-Item "J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy Setup.exe" | Format-List Name,Length,LastWriteTime
Write-Host "Installer hash:"
Get-FileHash "J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy Setup.exe" -Algorithm SHA256 | Format-List
Write-Host "Installed asar before:"
Get-Item "C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar" | Format-List Length,LastWriteTime
Get-FileHash "C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar" -Algorithm SHA256 | Format-List
Write-Host "Data root:"
Get-Content "C:/Users/yangda01/AppData/Roaming/WeMediaBuddy/data-root.json"
Write-Host "DB size before:"
Get-Item "J:/PigeonYang/WeMediaBuddyData/wmb.db" | Format-List Length,LastWriteTime

Write-Host "=== Running installer --silent ==="
$proc = Start-Process -FilePath "J:/wmb-out/make/squirrel.windows/x64/WeMediaBuddy Setup.exe" -ArgumentList "--silent" -PassThru -Wait
Write-Host "Installer exit code: $($proc.ExitCode) HasExited $($proc.HasExited) Id $($proc.Id)"

Start-Sleep -Seconds 5

Write-Host "=== After installer ==="
Get-Item "C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar" | Format-List Length,LastWriteTime
Get-FileHash "C:/Users/yangda01/AppData/Local/WeMediaBuddy/app-0.3.0/resources/app.asar" -Algorithm SHA256 | Format-List
Write-Host "DB after:"
Get-Item "J:/PigeonYang/WeMediaBuddyData/wmb.db" | Format-List Length,LastWriteTime

# Check for Update.exe log
Write-Host "=== Checking Squirrel log ==="
if (Test-Path "C:/Users/yangda01/AppData/Local/WeMediaBuddy/SquirrelSetup.log") { Get-Content "C:/Users/yangda01/AppData/Local/WeMediaBuddy/SquirrelSetup.log" -Tail 20 }
