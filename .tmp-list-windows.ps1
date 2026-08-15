$ErrorActionPreference = 'SilentlyContinue'
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  [PSCustomObject]@{
    Id = $_.Id
    Name = $_.ProcessName
    Title = $_.MainWindowTitle
    Path = $_.Path
  }
} | ConvertTo-Json -Compress
