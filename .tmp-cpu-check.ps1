$ErrorActionPreference = 'SilentlyContinue'

Write-Host '=== CPU ==='
Get-CimInstance Win32_Processor |
  Select-Object Name, LoadPercentage, NumberOfCores, NumberOfLogicalProcessors |
  Format-List

Write-Host '=== MEM ==='
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
  TotalGB = [math]::Round($os.TotalVisibleMemorySize/1MB,1)
  FreeGB  = [math]::Round($os.FreePhysicalMemory/1MB,1)
  UsedPct = [math]::Round((1 - $os.FreePhysicalMemory/$os.TotalVisibleMemorySize)*100,1)
} | Format-List

Write-Host '=== CPU SAMPLE 3s ==='
1..3 | ForEach-Object {
  $avg = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
  Write-Host ("t{0}: {1}%" -f $_, [int]$avg)
  Start-Sleep -Seconds 1
}

Write-Host '=== TOP CPU (lifetime seconds) ==='
Get-Process |
  Sort-Object CPU -Descending |
  Select-Object -First 25 Id, ProcessName, CPU,
    @{N='WS_MB';E={[math]::Round($_.WS/1MB,1)}},
    @{N='PM_MB';E={[math]::Round($_.PM/1MB,1)}} |
  Format-Table -AutoSize

Write-Host '=== TOP WS ==='
Get-Process |
  Sort-Object WS -Descending |
  Select-Object -First 15 Id, ProcessName,
    @{N='WS_MB';E={[math]::Round($_.WS/1MB,1)}}, CPU |
  Format-Table -AutoSize

Write-Host '=== DISK _Total ==='
Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk |
  Where-Object { $_.Name -eq '_Total' } |
  Select-Object Name, PercentDiskTime, AvgDiskQueueLength, DiskReadsPerSec, DiskWritesPerSec |
  Format-List

Write-Host '=== HIGH CPU COUNTER NOW ==='
Get-Counter '\Process(*)\% Processor Time' |
  Select-Object -ExpandProperty CounterSamples |
  Where-Object { $_.CookedValue -gt 5 -and $_.InstanceName -notmatch '^(_total|idle)$' } |
  Sort-Object CookedValue -Descending |
  Select-Object -First 30 @{N='Proc';E={$_.InstanceName}}, @{N='CPU';E={[math]::Round($_.CookedValue,1)}} |
  Format-Table -AutoSize

Write-Host '=== CHROME/EDGE/NODE/ELECTRON/CODE COUNTS ==='
Get-Process |
  Where-Object { $_.ProcessName -match 'chrome|msedge|node|electron|Code|Cursor|omp|claude|python|pwsh|powershell' } |
  Group-Object ProcessName |
  Select-Object Count, Name,
    @{N='WS_MB';E={[math]::Round(($_.Group | Measure-Object WS -Sum).Sum/1MB,1)}},
    @{N='CPU';E={[math]::Round(($_.Group | Measure-Object CPU -Sum).Sum,1)}} |
  Sort-Object WS_MB -Descending |
  Format-Table -AutoSize
