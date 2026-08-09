$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match 'electron|WeMedia' -or (
    $_.CommandLine -and (
      $_.CommandLine -match 'WeMediaBuddy|electron-forge|electron\\\\dist'
    )
  )
}
$procs | ForEach-Object {
  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    Pid = $_.ProcessId
    Parent = $_.ParentProcessId
    Name = $_.Name
    Title = $(if ($p) { $p.MainWindowTitle } else { '' })
    Handle = $(if ($p) { [int64]$p.MainWindowHandle } else { 0 })
    Cmd = $(if ($_.CommandLine) {
      if ($_.CommandLine.Length -gt 240) { $_.CommandLine.Substring(0, 240) } else { $_.CommandLine }
    } else { '' })
  }
} | ConvertTo-Json -Compress
